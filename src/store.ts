import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { types as utilTypes } from "node:util";
import type {
  CanonicalWorkerState,
  DelegationGrantV1,
  Effort,
  Harness,
  LegacyWorkerState,
  ManagerOwnerBinding,
  ManagerOwnerKind,
  RuntimeCleanupClaim,
  WorkerMigrationAudit,
  WorkerMigrationOutcomeAudit,
  WorkerGenerationLedgerEntry,
  WorkerRecord,
  WorkerRecordV2,
  WorkerRecordV3,
  WorkerRecordV4,
  WorkerHierarchy,
  WorkerState,
  WorkerStateFile,
  WorkerStateFileV2,
  WorkerStateFileV3,
  WorkerStateFileV4,
} from "./types.ts";
import { acquireKernelFileLock } from "./file-lock.ts";
import { isSafeModelPattern } from "./routing.ts";

const CURRENT_VERSION = 4 as const;
const DEFAULT_LEGACY_STOPPING_SETTLE_MS = 120_000;
const LOCK_STALE_MS = 120_000;
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const LOCK_RETRY_MIN_MS = 20;
const LOCK_RETRY_JITTER_MS = 20;
const LOCK_LIVE_BACKOFF_MAX_MS = 500;
const LOCK_RELEASE_TOMBSTONE_MAX_AGE_MS = 120_000;
const LOCK_RELEASE_TOMBSTONE_MARKER = ".released.";

const LEGACY_STATES = new Set<LegacyWorkerState>([
  "provisioning", "running", "idle", "needs_attention", "completed", "failed", "stopping", "stopped", "lost",
]);
const CANONICAL_STATES = new Set<CanonicalWorkerState>([
  "provisioning", "registering", "ready", "working", "waiting", "paused", "stalled", "blocked", "failed", "lost", "unreachable", "stopped",
]);
const HARNESSES = new Set<Harness>(["pi", "codex", "claude", "opencode"]);
const MANAGER_CONTEXTS = new Set<ManagerOwnerKind>(["pi", "opencode", "headless_cli"]);

const LEGACY_WORKER_KEYS = new Set([
  "id", "runId", "harness", "backend", "role", "task", "cwd", "profile", "permissionProfile", "model", "effort", "instructions",
  "state", "owned", "managerSessionId", "intercomTarget", "unit", "mainPid", "externalSessionId", "healthPath", "runtimeStatePath",
  "createdAt", "updatedAt", "leaseExpiresAt", "lastWorkerActivityAt", "lastAuthenticatedIntercomActivityAt", "idleDeadlineAt", "checkpointRequestedAt", "checkpointLastAttemptAt",
  "checkpointAttemptCount", "checkpointDeadlineAt", "stopRequestedAt", "stoppedAt", "stopReason", "dirtyAtStop", "dirtyStatusAtStop", "dirtyCheckErrorAtStop",
  "lastError", "backendDetails",
]);
const V2_STORED_WORKER_KEYS = new Set([
  "id", "workerIncarnationId", "workerGeneration", "bossRunId", "harness", "backend", "role", "task", "cwd", "profile",
  "permissionProfile", "model", "effort", "instructions", "state", "stateReason", "terminalOutcome", "owned", "managerOwner",
  "migrationAudit", "intercomTarget", "unit", "mainPid", "externalSessionId", "healthPath", "runtimeStatePath", "createdAt", "updatedAt",
  "leaseExpiresAt", "lastWorkerActivityAt", "idleDeadlineAt", "checkpointRequestedAt", "checkpointLastAttemptAt", "checkpointAttemptCount",
  "checkpointDeadlineAt", "stopRequestedAt", "stoppedAt", "stopReason", "dirtyAtStop", "dirtyStatusAtStop", "dirtyCheckErrorAtStop", "lastError", "backendDetails",
]);
const V2_API_WORKER_KEYS = new Set([...V2_STORED_WORKER_KEYS, "runId", "managerSessionId"]);
// Compatibility-only input for the briefly shipped writer that emitted the
// authenticated timestamp under a v2 header. It is never canonicalized.
const V2_COMPAT_STORED_WORKER_KEYS = new Set([...V2_STORED_WORKER_KEYS, "lastAuthenticatedIntercomActivityAt"]);
const V2_COMPAT_API_WORKER_KEYS = new Set([...V2_API_WORKER_KEYS, "lastAuthenticatedIntercomActivityAt"]);
const V3_STORED_WORKER_KEYS = new Set([...V2_STORED_WORKER_KEYS, "lastAuthenticatedIntercomActivityAt"]);
const V3_API_WORKER_KEYS = new Set([...V3_STORED_WORKER_KEYS, "runId", "managerSessionId"]);
const V4_STORED_WORKER_KEYS = new Set([...V3_STORED_WORKER_KEYS, "hierarchy", "delegationGrant"]);
const V4_API_WORKER_KEYS = new Set([...V4_STORED_WORKER_KEYS, "runId", "managerSessionId"]);
const STRING_WORKER_KEYS = [
  "profile", "permissionProfile", "model", "instructions", "intercomTarget", "unit", "externalSessionId", "healthPath", "runtimeStatePath",
  "stopReason", "dirtyStatusAtStop", "dirtyCheckErrorAtStop", "lastError", "stateReason",
] as const;
const NUMBER_WORKER_KEYS = [
  "mainPid", "lastWorkerActivityAt", "lastAuthenticatedIntercomActivityAt", "idleDeadlineAt", "checkpointRequestedAt", "checkpointLastAttemptAt", "checkpointAttemptCount",
  "checkpointDeadlineAt", "stopRequestedAt", "stoppedAt",
] as const;

export type WorkerStoreFaultPoint =
  | "after_temp_write"
  | "after_file_fsync"
  | "after_rename"
  | "after_directory_fsync";

export interface WorkerStoreFaultContext {
  statePath: string;
  tempPath: string;
}

export type WorkerStoreMetricOperation = "lock_wait" | "lock_live_backoff" | "lock_reclaim_guard" | "lock_release" | "tombstone_gc" | "read" | "mutation" | "commit";

export interface WorkerStoreMetric {
  operation: WorkerStoreMetricOperation;
  durationMs: number;
  outcome: "ok" | "noop" | "error";
  bytes?: number;
}

export interface WorkerStoreLockDiagnostics {
  present: boolean;
  ownerPid?: number;
  ownerAlive?: boolean;
  ageMs?: number;
}

export interface WorkerStoreOptions {
  supportedFeatures?: readonly string[];
  legacyStoppingSettleMs?: number;
  legacyManagerContext?: ManagerOwnerKind;
  resolveLegacyManagerOwner?: (worker: Readonly<WorkerRecord>) => ManagerOwnerBinding;
  now?: () => number;
  faultInjector?: (point: WorkerStoreFaultPoint, context: WorkerStoreFaultContext) => void | Promise<void>;
  lockTimeoutMs?: number;
  /** Optional content-free timing observations. Callback failures are ignored. */
  instrumentation?: (metric: Readonly<WorkerStoreMetric>) => void;
}

export interface WorkerStoreCommit<T> {
  value: T;
  generation: number;
  state: WorkerStateFileV4;
}

export interface WorkerStoreQuarantine {
  version: 1;
  kind: "corrupt" | "ambiguous_commit";
  statePath: string;
  detectedAt: number;
  reason: string;
  quarantinePath?: string;
  expectedDigest?: string;
  previousDigest?: string;
}

export interface WorkerStoreRecoverySnapshot {
  version: 1;
  statePath: string;
  capturedAt: number;
  stateDigest: string;
  state: WorkerStateFileV4;
}

export class WorkerStoreError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.code = code;
    this.name = new.target.name;
  }
}

export class WorkerStoreValidationError extends WorkerStoreError {
  constructor(message: string) {
    super(message, "WORKER_STORE_INVALID");
  }
}

export class WorkerStoreCorruptError extends WorkerStoreError {
  readonly quarantinePath?: string;

  constructor(message: string, quarantinePath?: string) {
    super(message, "WORKER_STORE_CORRUPT");
    this.quarantinePath = quarantinePath;
  }
}

export class WorkerStorePoisonedError extends WorkerStoreError {
  readonly quarantine?: WorkerStoreQuarantine;

  constructor(message: string, quarantine?: WorkerStoreQuarantine) {
    super(message, "WORKER_STORE_POISONED");
    this.quarantine = quarantine;
  }
}

export class WorkerStoreUnsupportedVersionError extends WorkerStoreError {
  readonly foundVersion: number;

  constructor(foundVersion: number) {
    super(`Worker state schema ${foundVersion} is newer than supported schema ${CURRENT_VERSION}; refusing downgrade`, "WORKER_STORE_NEWER_SCHEMA");
    this.foundVersion = foundVersion;
  }
}

export class WorkerStoreUnsupportedFeatureError extends WorkerStoreError {
  readonly features: string[];

  constructor(features: string[]) {
    super(`Worker state uses unsupported active features: ${features.join(", ")}`, "WORKER_STORE_UNSUPPORTED_FEATURE");
    this.features = features;
  }
}

export class WorkerStoreConflictError extends WorkerStoreError {
  readonly expectedGeneration: number;
  readonly actualGeneration: number;

  constructor(expectedGeneration: number, actualGeneration: number) {
    super(`Worker state generation changed (expected ${expectedGeneration}, found ${actualGeneration})`, "WORKER_STORE_CAS_CONFLICT");
    this.expectedGeneration = expectedGeneration;
    this.actualGeneration = actualGeneration;
  }
}

export class WorkerStoreMigrationPendingError extends WorkerStoreError {
  constructor(workerId: string) {
    super(`Worker ${workerId} is read-only while legacy stopping reconciliation is pending`, "WORKER_STORE_MIGRATION_PENDING");
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function assertPlainObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) {
    throw new WorkerStoreValidationError(`${path} must be a non-proxy plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new WorkerStoreValidationError(`${path} must not have an inherited/custom prototype`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw new WorkerStoreValidationError(`${path} must not contain symbol keys`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new WorkerStoreValidationError(`${path}.${key} must be enumerable own data`);
    }
  }
  return value as Record<string, unknown>;
}

function assertExactObject(value: unknown, allowed: ReadonlySet<string>, required: readonly string[], path: string): Record<string, unknown> {
  const object = assertPlainObject(value, path);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) throw new WorkerStoreValidationError(`${path} contains unknown field ${JSON.stringify(key)}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(object, key)) throw new WorkerStoreValidationError(`${path} is missing required own field ${JSON.stringify(key)}`);
  }
  return object;
}

function assertDenseArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value) || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new WorkerStoreValidationError(`${path} must be a non-proxy plain array`);
  }
  const ownKeys = Reflect.ownKeys(value);
  for (const key of ownKeys) {
    if (typeof key !== "string") throw new WorkerStoreValidationError(`${path} contains a non-index own property`);
    if (key === "length") continue;
    if (!/^(0|[1-9]\d*)$/.test(key)) throw new WorkerStoreValidationError(`${path} contains a non-index own property`);
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || index >= 0xffff_ffff || index >= value.length) {
      throw new WorkerStoreValidationError(`${path} contains an out-of-range array index`);
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new WorkerStoreValidationError(`${path} must not be sparse or contain accessors`);
    }
  }
  return value;
}

function requiredString(object: Record<string, unknown>, key: string, path: string): string {
  const value = object[key];
  if (typeof value !== "string" || value.length === 0) throw new WorkerStoreValidationError(`${path}.${key} must be a non-empty string`);
  return value;
}

function optionalString(object: Record<string, unknown>, key: string, path: string): string | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new WorkerStoreValidationError(`${path}.${key} must be a non-empty string when present`);
  return value;
}

function requiredBoolean(object: Record<string, unknown>, key: string, path: string): boolean {
  const value = object[key];
  if (typeof value !== "boolean") throw new WorkerStoreValidationError(`${path}.${key} must be boolean`);
  return value;
}

function optionalBoolean(object: Record<string, unknown>, key: string, path: string): boolean | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new WorkerStoreValidationError(`${path}.${key} must be boolean when present`);
  return value;
}

function requiredNumber(object: Record<string, unknown>, key: string, path: string, integer = false, minimum = 0): number {
  const value = object[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || (integer && !Number.isSafeInteger(value))) {
    throw new WorkerStoreValidationError(`${path}.${key} must be a finite${integer ? " safe integer" : " number"} >= ${minimum}`);
  }
  return value;
}

function optionalNumber(object: Record<string, unknown>, key: string, path: string, integer = false, minimum = 0): number | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  return requiredNumber(object, key, path, integer, minimum);
}

function cloneJsonData(value: unknown, path: string, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object") throw new WorkerStoreValidationError(`${path} is not JSON data`);
  if (seen.has(value)) throw new WorkerStoreValidationError(`${path} contains a cycle`);
  seen.add(value);
  try {
    if (Array.isArray(value)) return assertDenseArray(value, path).map((entry, index) => cloneJsonData(entry, `${path}[${index}]`, seen));
    const input = assertPlainObject(value, path);
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(input)) output[key] = cloneJsonData(entry, `${path}.${key}`, seen);
    return output;
  } finally {
    seen.delete(value);
  }
}

function parseManagerOwner(value: unknown, path: string): ManagerOwnerBinding {
  const object = assertExactObject(value, new Set(["context", "principalId", "sessionId", "bindingEpoch"]), ["context", "principalId", "sessionId", "bindingEpoch"], path);
  const context = object.context;
  if (typeof context !== "string" || !MANAGER_CONTEXTS.has(context as ManagerOwnerKind)) {
    throw new WorkerStoreValidationError(`${path}.context must be exactly pi, opencode, or headless_cli`);
  }
  return {
    context: context as ManagerOwnerKind,
    principalId: requiredString(object, "principalId", path),
    sessionId: requiredString(object, "sessionId", path),
    bindingEpoch: requiredNumber(object, "bindingEpoch", path, true),
  } as ManagerOwnerBinding;
}

function parseMigrationOutcome(value: unknown, path: string): WorkerMigrationOutcomeAudit {
  const allowed = new Set(["stoppedAt", "stopReason", "dirtyAtStop", "dirtyStatusAtStop", "dirtyCheckErrorAtStop", "lastError", "terminalOutcome"]);
  const object = assertExactObject(value, allowed, [], path);
  const terminalOutcome = optionalString(object, "terminalOutcome", path);
  if (terminalOutcome !== undefined && terminalOutcome !== "completed") throw new WorkerStoreValidationError(`${path}.terminalOutcome is invalid`);
  return compactObject({
    stoppedAt: optionalNumber(object, "stoppedAt", path),
    stopReason: optionalString(object, "stopReason", path),
    dirtyAtStop: optionalBoolean(object, "dirtyAtStop", path),
    dirtyStatusAtStop: optionalString(object, "dirtyStatusAtStop", path),
    dirtyCheckErrorAtStop: optionalString(object, "dirtyCheckErrorAtStop", path),
    lastError: optionalString(object, "lastError", path),
    terminalOutcome,
  }) as WorkerMigrationOutcomeAudit;
}

function parseMigrationAudit(value: unknown, path: string): WorkerMigrationAudit {
  const allowed = new Set([
    "sourceVersion", "migratedAt", "originalState", "originalRunId", "mappedState", "originalOutcome",
    "managerOwnerInferredFromLegacySession", "requiresReadinessReconciliation", "legacyIdleHint", "dispatchDenied", "reconcileBy", "resolvedAt", "resolution",
  ]);
  const object = assertExactObject(value, allowed, [
    "sourceVersion", "migratedAt", "originalState", "originalRunId", "mappedState", "originalOutcome", "managerOwnerInferredFromLegacySession",
  ], path);
  if (object.sourceVersion !== 1) throw new WorkerStoreValidationError(`${path}.sourceVersion must be 1`);
  if (object.managerOwnerInferredFromLegacySession !== true) throw new WorkerStoreValidationError(`${path}.managerOwnerInferredFromLegacySession must be true`);
  const originalState = object.originalState;
  if (typeof originalState !== "string" || !LEGACY_STATES.has(originalState as LegacyWorkerState)) throw new WorkerStoreValidationError(`${path}.originalState is invalid`);
  const mappedState = object.mappedState;
  if (typeof mappedState !== "string" || (mappedState !== "migration_pending" && !CANONICAL_STATES.has(mappedState as CanonicalWorkerState))) {
    throw new WorkerStoreValidationError(`${path}.mappedState is invalid`);
  }
  const resolution = optionalString(object, "resolution", path);
  if (resolution !== undefined && !["stopped", "failed", "lost", "unreachable"].includes(resolution)) {
    throw new WorkerStoreValidationError(`${path}.resolution is invalid`);
  }
  const audit = compactObject({
    sourceVersion: 1,
    migratedAt: requiredNumber(object, "migratedAt", path),
    originalState: originalState as LegacyWorkerState,
    originalRunId: requiredString(object, "originalRunId", path),
    mappedState: mappedState as WorkerMigrationAudit["mappedState"],
    originalOutcome: parseMigrationOutcome(object.originalOutcome, `${path}.originalOutcome`),
    managerOwnerInferredFromLegacySession: true,
    requiresReadinessReconciliation: object.requiresReadinessReconciliation === true ? true : optionalTrue(object, "requiresReadinessReconciliation", path),
    legacyIdleHint: object.legacyIdleHint === true ? true : optionalTrue(object, "legacyIdleHint", path),
    dispatchDenied: object.dispatchDenied === true ? true : optionalTrue(object, "dispatchDenied", path),
    reconcileBy: optionalNumber(object, "reconcileBy", path),
    resolvedAt: optionalNumber(object, "resolvedAt", path),
    resolution: resolution as WorkerMigrationAudit["resolution"],
  }) as WorkerMigrationAudit;
  const expectedMappedState: Record<LegacyWorkerState, WorkerMigrationAudit["mappedState"]> = {
    provisioning: "provisioning",
    running: "registering",
    idle: "registering",
    needs_attention: "blocked",
    completed: "stopped",
    failed: "failed",
    stopping: "migration_pending",
    stopped: "stopped",
    lost: "lost",
  };
  if (audit.mappedState !== expectedMappedState[audit.originalState]) throw new WorkerStoreValidationError(`${path}.mappedState contradicts originalState`);
  if ((audit.originalState === "running" || audit.originalState === "idle") !== (audit.requiresReadinessReconciliation === true)) {
    throw new WorkerStoreValidationError(`${path}.requiresReadinessReconciliation contradicts originalState`);
  }
  if ((audit.originalState === "idle") !== (audit.legacyIdleHint === true)) throw new WorkerStoreValidationError(`${path}.legacyIdleHint contradicts originalState`);
  if (audit.originalState === "stopping") {
    if (audit.dispatchDenied !== true || audit.reconcileBy === undefined) throw new WorkerStoreValidationError(`${path} legacy stopping audit lacks its read-only bound`);
    if ((audit.resolution === undefined) !== (audit.resolvedAt === undefined)) throw new WorkerStoreValidationError(`${path} stopping resolution and resolvedAt must appear together`);
  } else if (audit.dispatchDenied !== undefined || audit.reconcileBy !== undefined || audit.resolution !== undefined || audit.resolvedAt !== undefined) {
    throw new WorkerStoreValidationError(`${path} contains stopping-only migration metadata for ${audit.originalState}`);
  }
  if ((audit.originalState === "completed") !== (audit.originalOutcome.terminalOutcome === "completed")) {
    throw new WorkerStoreValidationError(`${path}.originalOutcome.terminalOutcome contradicts originalState`);
  }
  return audit;
}

function optionalTrue(object: Record<string, unknown>, key: string, path: string): true | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (value !== true) throw new WorkerStoreValidationError(`${path}.${key} must be true when present`);
  return true;
}

function compactObject<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

const GRANT_ARRAY_LIMIT = 128;
const GRANT_BUDGET_LIMIT = 10_000;
const GRANT_DEPTH_LIMIT = 32;
const EFFORTS = new Set<Effort>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function parseCanonicalStringArray(value: unknown, path: string, validate?: (entry: string) => boolean): string[] {
  const entries = assertDenseArray(value, path).map((entry, index) => {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 512 || /[\u0000-\u001f\u007f]/.test(entry)) {
      throw new WorkerStoreValidationError(`${path}[${index}] must be a bounded non-empty string without control characters`);
    }
    if (validate && !validate(entry)) throw new WorkerStoreValidationError(`${path}[${index}] is invalid`);
    return entry;
  });
  if (entries.length === 0 || entries.length > GRANT_ARRAY_LIMIT) throw new WorkerStoreValidationError(`${path} must contain 1-${GRANT_ARRAY_LIMIT} entries`);
  if (new Set(entries).size !== entries.length) throw new WorkerStoreValidationError(`${path} contains duplicates`);
  const sorted = [...entries].sort();
  if (entries.some((entry, index) => entry !== sorted[index])) throw new WorkerStoreValidationError(`${path} must be sorted`);
  return entries;
}

export function parseDelegationGrant(value: unknown, path: string): DelegationGrantV1 {
  const allowed = new Set(["version", "grantId", "issuedByWorkerIncarnationId", "issuedAt", "roles", "harnesses", "permissionProfiles", "profiles", "cwdRoots", "modelPatterns", "efforts", "maxLiveDirectChildren", "maxLiveDescendants", "maxDepth", "canSubdelegate", "expiresAt"]);
  const object = assertExactObject(value, allowed, ["version", "grantId", "issuedAt", "roles", "harnesses", "permissionProfiles", "profiles", "cwdRoots", "modelPatterns", "efforts", "maxLiveDirectChildren", "maxLiveDescendants", "maxDepth", "canSubdelegate"], path);
  if (object.version !== 1) throw new WorkerStoreValidationError(`${path}.version must be 1`);
  const cwdRoots = assertDenseArray(object.cwdRoots, `${path}.cwdRoots`).map((entry, index) => {
    const rootPath = `${path}.cwdRoots[${index}]`;
    const root = assertExactObject(entry, new Set(["path", "gitCommonDir", "gitWorktreeRoot"]), ["path"], rootPath);
    const parsed = compactObject({ path: requiredString(root, "path", rootPath), gitCommonDir: optionalString(root, "gitCommonDir", rootPath), gitWorktreeRoot: optionalString(root, "gitWorktreeRoot", rootPath) });
    if (!String(parsed.path).startsWith("/")) throw new WorkerStoreValidationError(`${rootPath}.path must be absolute`);
    if ((parsed.gitCommonDir === undefined) !== (parsed.gitWorktreeRoot === undefined)) throw new WorkerStoreValidationError(`${rootPath} Git identity fields must appear together`);
    return parsed as DelegationGrantV1["cwdRoots"][number];
  });
  if (cwdRoots.length === 0 || cwdRoots.length > GRANT_ARRAY_LIMIT) throw new WorkerStoreValidationError(`${path}.cwdRoots must contain 1-${GRANT_ARRAY_LIMIT} entries`);
  const harnesses = parseCanonicalStringArray(object.harnesses, `${path}.harnesses`, (entry) => entry === "pi" || entry === "codex") as Harness[];
  const efforts = parseCanonicalStringArray(object.efforts, `${path}.efforts`, (entry) => EFFORTS.has(entry as Effort)) as Effort[];
  const direct = requiredNumber(object, "maxLiveDirectChildren", path, true, 1);
  const descendants = requiredNumber(object, "maxLiveDescendants", path, true, 1);
  const depth = requiredNumber(object, "maxDepth", path, true, 1);
  if (direct > descendants || descendants > GRANT_BUDGET_LIMIT || depth > GRANT_DEPTH_LIMIT) throw new WorkerStoreValidationError(`${path} delegation budgets are inconsistent or exceed implementation limits`);
  return {
    version: 1,
    grantId: requiredString(object, "grantId", path),
    ...(optionalString(object, "issuedByWorkerIncarnationId", path) ? { issuedByWorkerIncarnationId: optionalString(object, "issuedByWorkerIncarnationId", path) } : {}),
    issuedAt: requiredNumber(object, "issuedAt", path),
    roles: parseCanonicalStringArray(object.roles, `${path}.roles`),
    harnesses,
    permissionProfiles: parseCanonicalStringArray(object.permissionProfiles, `${path}.permissionProfiles`),
    profiles: parseCanonicalStringArray(object.profiles, `${path}.profiles`),
    cwdRoots,
    modelPatterns: parseCanonicalStringArray(object.modelPatterns, `${path}.modelPatterns`, isSafeModelPattern),
    efforts,
    maxLiveDirectChildren: direct,
    maxLiveDescendants: descendants,
    maxDepth: depth,
    canSubdelegate: requiredBoolean(object, "canSubdelegate", path),
    ...(optionalNumber(object, "expiresAt", path) !== undefined ? { expiresAt: optionalNumber(object, "expiresAt", path) } : {}),
  };
}

function parseHierarchy(value: unknown, path: string): WorkerHierarchy {
  const object = assertExactObject(value, new Set(["rootWorkerIncarnationId", "parentWorkerIncarnationId", "depth", "grantId"]), ["rootWorkerIncarnationId", "depth"], path);
  const depth = requiredNumber(object, "depth", path, true);
  const parentWorkerIncarnationId = optionalString(object, "parentWorkerIncarnationId", path);
  const grantId = optionalString(object, "grantId", path);
  if ((depth === 0) !== (parentWorkerIncarnationId === undefined)) throw new WorkerStoreValidationError(`${path} parent presence must agree with depth`);
  if ((depth === 0) !== (grantId === undefined)) throw new WorkerStoreValidationError(`${path} grantId presence must agree with depth`);
  return compactObject({ rootWorkerIncarnationId: requiredString(object, "rootWorkerIncarnationId", path), parentWorkerIncarnationId, depth, grantId }) as WorkerHierarchy;
}

function parseWorkerCommon(object: Record<string, unknown>, path: string): Omit<WorkerRecord, "runId" | "state" | "managerSessionId"> {
  const harness = requiredString(object, "harness", path);
  if (!HARNESSES.has(harness as Harness)) throw new WorkerStoreValidationError(`${path}.harness is invalid`);
  const backend = object.backend === undefined ? "systemd" : requiredString(object, "backend", path);
  if (backend !== "systemd") throw new WorkerStoreValidationError(`${path}.backend must be systemd`);
  const effort = optionalString(object, "effort", path);
  if (effort !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(effort)) {
    throw new WorkerStoreValidationError(`${path}.effort is invalid`);
  }
  const output: Record<string, unknown> = {
    id: requiredString(object, "id", path),
    harness,
    backend,
    role: requiredString(object, "role", path),
    task: requiredString(object, "task", path),
    cwd: requiredString(object, "cwd", path),
    owned: requiredBoolean(object, "owned", path),
    createdAt: requiredNumber(object, "createdAt", path),
    updatedAt: requiredNumber(object, "updatedAt", path),
    leaseExpiresAt: requiredNumber(object, "leaseExpiresAt", path),
    effort,
    dirtyAtStop: optionalBoolean(object, "dirtyAtStop", path),
  };
  for (const key of STRING_WORKER_KEYS) output[key] = optionalString(object, key, path);
  for (const key of NUMBER_WORKER_KEYS) output[key] = optionalNumber(object, key, path, key === "mainPid" || key === "checkpointAttemptCount", key === "mainPid" ? 1 : 0);
  if (object.backendDetails !== undefined) output.backendDetails = cloneJsonData(object.backendDetails, `${path}.backendDetails`);
  return compactObject(output) as Omit<WorkerRecord, "runId" | "state" | "managerSessionId">;
}

function parseLegacyWorker(value: unknown, path: string): WorkerRecord {
  const required = ["id", "runId", "harness", "role", "task", "cwd", "state", "owned", "managerSessionId", "createdAt", "updatedAt", "leaseExpiresAt"];
  const object = assertExactObject(value, LEGACY_WORKER_KEYS, required, path);
  const state = requiredString(object, "state", path);
  if (!LEGACY_STATES.has(state as LegacyWorkerState)) throw new WorkerStoreValidationError(`${path}.state is not a legacy WorkerState`);
  return {
    ...parseWorkerCommon(object, path),
    runId: requiredString(object, "runId", path),
    state: state as LegacyWorkerState,
    managerSessionId: requiredString(object, "managerSessionId", path),
  } as WorkerRecord;
}

function parseVersionedWorker(value: unknown, path: string, allowAliases: boolean, expectedVersion: 2 | 3 | 4): WorkerRecordV2 | WorkerRecordV3 | WorkerRecordV4 {
  const allowed = expectedVersion === 2
    ? (allowAliases ? V2_COMPAT_API_WORKER_KEYS : V2_COMPAT_STORED_WORKER_KEYS)
    : expectedVersion === 3
      ? (allowAliases ? V3_API_WORKER_KEYS : V3_STORED_WORKER_KEYS)
      : (allowAliases ? V4_API_WORKER_KEYS : V4_STORED_WORKER_KEYS);
  const required = [
    "id", "workerIncarnationId", "workerGeneration", "harness", "backend", "role", "task", "cwd", "state", "owned", "managerOwner",
    "createdAt", "updatedAt", "leaseExpiresAt",
  ];
  const object = assertExactObject(value, allowed, required, path);
  const workerIncarnationId = requiredString(object, "workerIncarnationId", path);
  const runId = object.runId === undefined ? workerIncarnationId : requiredString(object, "runId", path);
  if (runId !== workerIncarnationId) throw new WorkerStoreValidationError(`${path}.runId must be a lossless alias of workerIncarnationId`);
  const managerOwner = parseManagerOwner(object.managerOwner, `${path}.managerOwner`);
  const managerSessionId = object.managerSessionId === undefined ? managerOwner.sessionId : requiredString(object, "managerSessionId", path);
  if (managerSessionId !== managerOwner.sessionId) throw new WorkerStoreValidationError(`${path}.managerSessionId must alias managerOwner.sessionId`);
  const state = requiredString(object, "state", path) as WorkerState;
  if (state !== "migration_pending" && !CANONICAL_STATES.has(state as CanonicalWorkerState)) {
    throw new WorkerStoreValidationError(`${path}.state is not canonical`);
  }
  const migrationAudit = object.migrationAudit === undefined ? undefined : parseMigrationAudit(object.migrationAudit, `${path}.migrationAudit`);
  if (migrationAudit && migrationAudit.originalRunId !== workerIncarnationId) {
    throw new WorkerStoreValidationError(`${path}.migrationAudit.originalRunId must match workerIncarnationId`);
  }
  if (state === "migration_pending") {
    if (migrationAudit?.originalState !== "stopping" || migrationAudit.dispatchDenied !== true || migrationAudit.reconcileBy === undefined) {
      throw new WorkerStoreValidationError(`${path} migration_pending requires an audited legacy stopping bound and dispatch denial`);
    }
  }
  const stateReason = optionalString(object, "stateReason", path);
  if ((state === "blocked" || state === "unreachable") && stateReason === undefined) {
    throw new WorkerStoreValidationError(`${path}.${state} requires stateReason`);
  }
  const terminalOutcome = optionalString(object, "terminalOutcome", path);
  if (terminalOutcome !== undefined && terminalOutcome !== "completed") throw new WorkerStoreValidationError(`${path}.terminalOutcome is invalid`);
  const hierarchy = expectedVersion === 4 ? parseHierarchy(object.hierarchy, `${path}.hierarchy`) : undefined;
  const delegationGrant = expectedVersion === 4 && object.delegationGrant !== undefined
    ? parseDelegationGrant(object.delegationGrant, `${path}.delegationGrant`)
    : undefined;
  const record: WorkerRecordV4 = {
    ...parseWorkerCommon(object, path),
    runId,
    workerIncarnationId,
    workerGeneration: requiredNumber(object, "workerGeneration", path, true, 1),
    ...(optionalString(object, "bossRunId", path) ? { bossRunId: optionalString(object, "bossRunId", path) } : {}),
    state: state as CanonicalWorkerState | "migration_pending",
    ...(stateReason ? { stateReason } : {}),
    ...(terminalOutcome ? { terminalOutcome: "completed" } : {}),
    managerSessionId,
    managerOwner,
    ...(migrationAudit ? { migrationAudit } : {}),
    hierarchy: hierarchy as WorkerHierarchy,
    ...(delegationGrant ? { delegationGrant } : {}),
  };
  if (expectedVersion === 4) return record;
  const { hierarchy: _hierarchy, delegationGrant: _delegationGrant, ...preV4Record } = record;
  if (expectedVersion === 3) return preV4Record as WorkerRecordV3;
  const { lastAuthenticatedIntercomActivityAt: _untrustedCompatibilityClaim, ...legacyRecord } = preV4Record;
  return legacyRecord as WorkerRecordV2;
}

function parseClaim(value: unknown, path: string): RuntimeCleanupClaim {
  const allowed = new Set(["token", "workerId", "runId", "terminalAt", "unit", "action", "claimedAt", "ownerPid", "phase", "pathIndexes"]);
  const object = assertExactObject(value, allowed, ["token", "workerId", "action", "claimedAt", "ownerPid", "phase", "pathIndexes"], path);
  const action = requiredString(object, "action", path);
  if (!new Set(["cache", "full", "orphan"]).has(action)) throw new WorkerStoreValidationError(`${path}.action is invalid`);
  const phase = requiredString(object, "phase", path);
  if (!new Set(["claimed", "moving", "moved", "deleting"]).has(phase)) throw new WorkerStoreValidationError(`${path}.phase is invalid`);
  const pathIndexes = assertDenseArray(object.pathIndexes, `${path}.pathIndexes`).map((entry, index) => {
    if (!Number.isSafeInteger(entry) || (entry as number) < 0) throw new WorkerStoreValidationError(`${path}.pathIndexes[${index}] is invalid`);
    return entry as number;
  });
  return compactObject({
    token: requiredString(object, "token", path),
    workerId: requiredString(object, "workerId", path),
    runId: optionalString(object, "runId", path),
    terminalAt: optionalNumber(object, "terminalAt", path),
    unit: optionalString(object, "unit", path),
    action,
    claimedAt: requiredNumber(object, "claimedAt", path),
    ownerPid: requiredNumber(object, "ownerPid", path, true),
    phase,
    pathIndexes,
  }) as RuntimeCleanupClaim;
}

function assertUniqueWorkers(workers: WorkerRecord[]): void {
  const ids = new Set<string>();
  for (const worker of workers) {
    if (ids.has(worker.id)) throw new WorkerStoreValidationError(`workers contains duplicate id ${JSON.stringify(worker.id)}`);
    ids.add(worker.id);
  }
}

function assertValidHierarchy(workers: WorkerRecordV4[]): void {
  const byIncarnation = new Map<string, WorkerRecordV4>();
  for (const worker of workers) {
    if (byIncarnation.has(worker.workerIncarnationId)) throw new WorkerStoreValidationError(`workers contains duplicate incarnation ${JSON.stringify(worker.workerIncarnationId)}`);
    byIncarnation.set(worker.workerIncarnationId, worker);
  }
  for (const worker of workers) {
    const hierarchy = worker.hierarchy;
    if (hierarchy.depth === 0) {
      if (hierarchy.rootWorkerIncarnationId !== worker.workerIncarnationId) throw new WorkerStoreValidationError(`worker ${worker.id} root hierarchy must name its own incarnation`);
      if (worker.delegationGrant?.issuedByWorkerIncarnationId !== undefined) throw new WorkerStoreValidationError(`worker ${worker.id} root grant must be Controller-issued`);
      continue;
    }
    const parent = byIncarnation.get(hierarchy.parentWorkerIncarnationId!);
    if (!parent) throw new WorkerStoreValidationError(`worker ${worker.id} hierarchy parent is missing`);
    if (parent.hierarchy.depth + 1 !== hierarchy.depth || parent.hierarchy.rootWorkerIncarnationId !== hierarchy.rootWorkerIncarnationId) {
      throw new WorkerStoreValidationError(`worker ${worker.id} hierarchy depth/root does not agree with its parent`);
    }
    if (hierarchy.grantId !== parent.delegationGrant?.grantId) throw new WorkerStoreValidationError(`worker ${worker.id} was not authorized by its parent's current grant`);
    if (worker.delegationGrant && worker.delegationGrant.issuedByWorkerIncarnationId !== parent.workerIncarnationId) {
      throw new WorkerStoreValidationError(`worker ${worker.id} delegation grant issuer does not match its parent`);
    }
    const seen = new Set<string>([worker.workerIncarnationId]);
    let cursor: WorkerRecordV4 | undefined = parent;
    while (cursor) {
      if (seen.has(cursor.workerIncarnationId)) throw new WorkerStoreValidationError(`worker ${worker.id} hierarchy contains a cycle`);
      seen.add(cursor.workerIncarnationId);
      cursor = cursor.hierarchy.parentWorkerIncarnationId ? byIncarnation.get(cursor.hierarchy.parentWorkerIncarnationId) : undefined;
    }
  }
}

function parseLegacyFile(value: unknown): { version: 1; workers: WorkerRecord[]; runtimeCleanupClaims?: RuntimeCleanupClaim[] } {
  const object = assertExactObject(value, new Set(["version", "workers", "runtimeCleanupClaims"]), ["version", "workers"], "worker state");
  if (object.version !== 1) throw new WorkerStoreValidationError("worker state version is not 1");
  const workers = assertDenseArray(object.workers, "worker state.workers").map((worker, index) => parseLegacyWorker(worker, `worker state.workers[${index}]`));
  assertUniqueWorkers(workers);
  const claims = object.runtimeCleanupClaims === undefined
    ? undefined
    : assertDenseArray(object.runtimeCleanupClaims, "worker state.runtimeCleanupClaims").map((claim, index) => parseClaim(claim, `worker state.runtimeCleanupClaims[${index}]`));
  return { version: 1, workers, ...(claims ? { runtimeCleanupClaims: claims } : {}) };
}

function parseWorkerGenerations(value: unknown, required: boolean): WorkerGenerationLedgerEntry[] {
  if (value === undefined) {
    if (required) throw new WorkerStoreValidationError("worker state.workerGenerations is required");
    return [];
  }
  const entries = assertDenseArray(value, "worker state.workerGenerations").map((entry, index) => {
    const path = `worker state.workerGenerations[${index}]`;
    const object = assertExactObject(entry, new Set(["workerId", "generation"]), ["workerId", "generation"], path);
    return { workerId: requiredString(object, "workerId", path), generation: requiredNumber(object, "generation", path, true, 1) };
  });
  const sorted = [...entries].sort((left, right) => left.workerId.localeCompare(right.workerId));
  if (new Set(entries.map((entry) => entry.workerId)).size !== entries.length) throw new WorkerStoreValidationError("worker state.workerGenerations contains duplicate worker ids");
  if (entries.some((entry, index) => entry.workerId !== sorted[index].workerId)) throw new WorkerStoreValidationError("worker state.workerGenerations must be sorted by worker id");
  return entries;
}

function parseFeatureList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const features = assertDenseArray(value, "worker state.activeFeatures").map((feature, index) => {
    if (typeof feature !== "string" || feature.length === 0) throw new WorkerStoreValidationError(`worker state.activeFeatures[${index}] is invalid`);
    return feature;
  });
  if (new Set(features).size !== features.length) throw new WorkerStoreValidationError("worker state.activeFeatures contains duplicates");
  return features;
}

function parseVersionedFile(value: unknown, allowAliases: boolean, expectedVersion: 2): WorkerStateFileV2;
function parseVersionedFile(value: unknown, allowAliases: boolean, expectedVersion: 3): WorkerStateFileV3;
function parseVersionedFile(value: unknown, allowAliases: boolean, expectedVersion: 4): WorkerStateFileV4;
function parseVersionedFile(value: unknown, allowAliases: boolean, expectedVersion: 2 | 3 | 4): WorkerStateFileV2 | WorkerStateFileV3 | WorkerStateFileV4 {
  const object = assertExactObject(value, new Set(["version", "generation", "workers", "workerGenerations", "runtimeCleanupClaims", "activeFeatures"]), ["version", "generation", "workers", ...(allowAliases ? [] : ["workerGenerations"])], "worker state");
  if (object.version !== expectedVersion) throw new WorkerStoreValidationError(`worker state version is not ${expectedVersion}`);
  const workers = assertDenseArray(object.workers, "worker state.workers").map((worker, index) => parseVersionedWorker(worker, `worker state.workers[${index}]`, allowAliases, expectedVersion));
  assertUniqueWorkers(workers);
  const claims = object.runtimeCleanupClaims === undefined
    ? undefined
    : assertDenseArray(object.runtimeCleanupClaims, "worker state.runtimeCleanupClaims").map((claim, index) => parseClaim(claim, `worker state.runtimeCleanupClaims[${index}]`));
  const activeFeatures = parseFeatureList(object.activeFeatures);
  const workerGenerations = parseWorkerGenerations(object.workerGenerations, !allowAliases);
  for (const worker of workers) {
    const recorded = workerGenerations.find((entry) => entry.workerId === worker.id)?.generation;
    if (recorded !== undefined && recorded < worker.workerGeneration) throw new WorkerStoreValidationError(`worker state.workerGenerations is behind worker ${worker.id}`);
  }
  if (expectedVersion === 4) assertValidHierarchy(workers as WorkerRecordV4[]);
  return {
    version: expectedVersion,
    generation: requiredNumber(object, "generation", "worker state", true),
    workers,
    workerGenerations: workerGenerations.length > 0 || !allowAliases
      ? workerGenerations
      : workers.map((worker) => ({ workerId: worker.id, generation: worker.workerGeneration })).sort((left, right) => left.workerId.localeCompare(right.workerId)),
    ...(claims ? { runtimeCleanupClaims: claims } : {}),
    ...(activeFeatures ? { activeFeatures } : {}),
  } as WorkerStateFileV2 | WorkerStateFileV3 | WorkerStateFileV4;
}

function parseV2File(value: unknown, allowAliases: boolean): WorkerStateFileV2 {
  return parseVersionedFile(value, allowAliases, 2);
}

function parseV3File(value: unknown, allowAliases: boolean): WorkerStateFileV3 {
  return parseVersionedFile(value, allowAliases, 3);
}

function parseV4File(value: unknown, allowAliases: boolean): WorkerStateFileV4 {
  return parseVersionedFile(value, allowAliases, 4);
}

function migrationOutcome(worker: WorkerRecord): WorkerMigrationOutcomeAudit {
  return compactObject({
    stoppedAt: worker.stoppedAt,
    stopReason: worker.stopReason,
    dirtyAtStop: worker.dirtyAtStop,
    dirtyStatusAtStop: worker.dirtyStatusAtStop,
    dirtyCheckErrorAtStop: worker.dirtyCheckErrorAtStop,
    lastError: worker.lastError,
    terminalOutcome: worker.state === "completed" ? "completed" : undefined,
  }) as WorkerMigrationOutcomeAudit;
}

function inferManagerOwner(worker: WorkerRecord, options: Required<Pick<WorkerStoreOptions, "legacyManagerContext">> & WorkerStoreOptions): ManagerOwnerBinding {
  if (options.resolveLegacyManagerOwner) return parseManagerOwner(options.resolveLegacyManagerOwner(Object.freeze(structuredClone(worker))), "resolved legacy manager owner");
  return {
    context: options.legacyManagerContext,
    principalId: worker.managerSessionId,
    sessionId: worker.managerSessionId,
    bindingEpoch: 0,
  } as ManagerOwnerBinding;
}

function migrateLegacyWorker(worker: WorkerRecord, migratedAt: number, options: Required<Pick<WorkerStoreOptions, "legacyManagerContext" | "legacyStoppingSettleMs">> & WorkerStoreOptions): WorkerRecordV3 {
  let state: WorkerState;
  let stateReason: string | undefined;
  let terminalOutcome: "completed" | undefined;
  const flags: Partial<WorkerMigrationAudit> = {};
  switch (worker.state as LegacyWorkerState) {
    case "provisioning": state = "provisioning"; break;
    case "running":
      state = "registering";
      flags.requiresReadinessReconciliation = true;
      break;
    case "idle":
      state = "registering";
      flags.requiresReadinessReconciliation = true;
      flags.legacyIdleHint = true;
      break;
    case "needs_attention":
      state = "blocked";
      stateReason = "legacy_needs_attention";
      break;
    case "completed":
      state = "stopped";
      terminalOutcome = "completed";
      break;
    case "failed": state = "failed"; break;
    case "stopped": state = "stopped"; break;
    case "lost": state = "lost"; break;
    case "stopping":
      state = "migration_pending";
      stateReason = "legacy_stopping_reconciliation_pending";
      flags.dispatchDenied = true;
      flags.reconcileBy = migratedAt + options.legacyStoppingSettleMs;
      break;
    default:
      throw new WorkerStoreValidationError(`Unhandled legacy worker state ${String(worker.state)}`);
  }
  const managerOwner = inferManagerOwner(worker, options);
  const audit: WorkerMigrationAudit = {
    sourceVersion: 1,
    migratedAt,
    originalState: worker.state as LegacyWorkerState,
    originalRunId: worker.runId,
    mappedState: state as WorkerMigrationAudit["mappedState"],
    originalOutcome: migrationOutcome(worker),
    managerOwnerInferredFromLegacySession: true,
    ...flags,
  };
  const { lastAuthenticatedIntercomActivityAt: _untrustedCompatibilityClaim, ...canonicalLegacyWorker } = worker;
  return {
    ...canonicalLegacyWorker,
    workerIncarnationId: worker.runId,
    workerGeneration: 1,
    state,
    ...(stateReason ? { stateReason } : {}),
    ...(terminalOutcome ? { terminalOutcome } : {}),
    managerOwner,
    migrationAudit: audit,
  } as WorkerRecordV3;
}

function migrateLegacyFile(
  legacy: ReturnType<typeof parseLegacyFile>,
  migratedAt: number,
  options: Required<Pick<WorkerStoreOptions, "legacyManagerContext" | "legacyStoppingSettleMs">> & WorkerStoreOptions,
): WorkerStateFileV3 {
  return {
    version: 3,
    generation: 1,
    workers: legacy.workers.map((worker) => migrateLegacyWorker(worker, migratedAt, options)),
    workerGenerations: legacy.workers.map((worker) => ({ workerId: worker.id, generation: 1 })).sort((left, right) => left.workerId.localeCompare(right.workerId)),
    ...(legacy.runtimeCleanupClaims ? { runtimeCleanupClaims: legacy.runtimeCleanupClaims } : {}),
  };
}

function migrateV2File(legacy: WorkerStateFileV2): WorkerStateFileV3 {
  return {
    ...legacy,
    version: 3,
    workers: legacy.workers.map((worker) => ({ ...worker })),
  };
}

function migrateV3File(legacy: WorkerStateFileV3): WorkerStateFileV4 {
  return {
    ...legacy,
    version: 4,
    workers: legacy.workers.map((worker) => ({
      ...worker,
      hierarchy: { rootWorkerIncarnationId: worker.workerIncarnationId, depth: 0 },
    })),
  };
}

function storedWorker(worker: WorkerRecord): Record<string, unknown> {
  const { runId: _runId, managerSessionId: _managerSessionId, ...stored } = worker;
  return compactObject(stored as Record<string, unknown>) as Record<string, unknown>;
}

function storedState(state: WorkerStateFileV4): Record<string, unknown> {
  return compactObject({
    version: 4,
    generation: state.generation,
    workers: state.workers.map(storedWorker),
    workerGenerations: state.workerGenerations,
    runtimeCleanupClaims: state.runtimeCleanupClaims,
    activeFeatures: state.activeFeatures,
  }) as Record<string, unknown>;
}

function serializedState(state: WorkerStateFileV4): string {
  return `${JSON.stringify(storedState(state), null, 2)}\n`;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

function cloneState(state: WorkerStateFileV4): WorkerStateFileV4 {
  return structuredClone(state);
}

function workerIdentity(worker: WorkerRecord): string {
  return worker.workerIncarnationId ?? worker.runId;
}

/** Failed, lost, and stopped are terminal for one worker generation. */
export function isTerminalWorkerGeneration(state: WorkerState): boolean {
  return state === "failed" || state === "lost" || state === "stopped";
}

/** Dispatch is denied for terminal, paused, and legacy migration-pending records. */
export function isWorkerDispatchAllowed(worker: WorkerRecord): boolean {
  return worker.state !== "migration_pending" && worker.state !== "paused" && !isTerminalWorkerGeneration(worker.state);
}

interface LoadedState {
  state: WorkerStateFileV4;
  raw?: string;
  sourceVersion: 0 | 1 | 2 | 3 | 4;
}

interface HeldWriteContext {
  loaded: LoadedState;
  allowPendingResolution: boolean;
}

export class WorkerStore {
  private queue: Promise<unknown> = Promise.resolve();
  private poisoned?: WorkerStoreQuarantine;
  private readonly options: Required<Pick<WorkerStoreOptions, "legacyStoppingSettleMs" | "legacyManagerContext" | "now" | "lockTimeoutMs">> & WorkerStoreOptions;
  private readonly supportedFeatures: Set<string>;
  readonly path: string;

  constructor(path: string, options: WorkerStoreOptions = {}) {
    this.path = path;
    this.options = {
      ...options,
      legacyStoppingSettleMs: options.legacyStoppingSettleMs ?? DEFAULT_LEGACY_STOPPING_SETTLE_MS,
      legacyManagerContext: options.legacyManagerContext ?? "pi",
      now: options.now ?? Date.now,
      lockTimeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    };
    if (!Number.isSafeInteger(this.options.legacyStoppingSettleMs) || this.options.legacyStoppingSettleMs < 0) {
      throw new TypeError("legacyStoppingSettleMs must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(this.options.lockTimeoutMs) || this.options.lockTimeoutMs < 1) {
      throw new TypeError("lockTimeoutMs must be a positive safe integer");
    }
    if (!MANAGER_CONTEXTS.has(this.options.legacyManagerContext)) throw new TypeError("legacyManagerContext must be pi, opencode, or headless_cli");
    for (const feature of options.supportedFeatures ?? []) {
      if (typeof feature !== "string" || feature.length === 0) throw new TypeError("supportedFeatures must contain only non-empty strings");
    }
    this.supportedFeatures = new Set(options.supportedFeatures ?? []);
  }

  private poisonPath(): string {
    return `${this.path}.poison.json`;
  }

  private recoveryPath(): string {
    return `${this.path}.recovery.json`;
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const operation = this.queue.catch(() => undefined).then(fn);
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private metric(operation: WorkerStoreMetricOperation, startedAt: bigint | undefined, outcome: WorkerStoreMetric["outcome"], bytes?: number): void {
    if (startedAt === undefined || !this.options.instrumentation) return;
    try {
      this.options.instrumentation({
        operation,
        durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
        outcome,
        ...(bytes === undefined ? {} : { bytes }),
      });
    } catch {
      // Observability must never affect store correctness or availability.
    }
  }

  private async measured<T>(operation: WorkerStoreMetricOperation, fn: () => Promise<T>): Promise<T> {
    const startedAt = this.options.instrumentation ? process.hrtime.bigint() : undefined;
    try {
      const result = await fn();
      this.metric(operation, startedAt, "ok");
      return result;
    } catch (error) {
      this.metric(operation, startedAt, "error");
      throw error;
    }
  }

  private async syncDirectory(path = this.path): Promise<void> {
    const handle = await open(dirname(path), "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async writeSmallDurable(path: string, text: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temp, "wx", 0o600);
      await handle.writeFile(text, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temp, path);
      await this.syncDirectory(path);
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temp, { force: true }).catch(() => undefined);
    }
  }

  private parsePoisonMarker(value: unknown): WorkerStoreQuarantine {
    const path = "worker store poison marker";
    const object = assertExactObject(value, new Set([
      "version", "kind", "statePath", "detectedAt", "reason", "quarantinePath", "expectedDigest", "previousDigest",
    ]), ["version", "kind", "statePath", "detectedAt", "reason"], path);
    const version = requiredNumber(object, "version", path, true, 1);
    if (version !== 1) throw new WorkerStoreValidationError(`${path}.version must equal 1`);
    const kind = requiredString(object, "kind", path);
    if (kind !== "corrupt" && kind !== "ambiguous_commit") throw new WorkerStoreValidationError(`${path}.kind is invalid`);
    const statePath = requiredString(object, "statePath", path);
    if (statePath !== this.path) throw new WorkerStoreValidationError(`${path}.statePath does not match this store`);
    const quarantinePath = optionalString(object, "quarantinePath", path);
    const expectedDigest = optionalString(object, "expectedDigest", path);
    const previousDigest = optionalString(object, "previousDigest", path);
    return {
      version: 1,
      kind,
      statePath,
      detectedAt: requiredNumber(object, "detectedAt", path, true, 0),
      reason: requiredString(object, "reason", path),
      ...(quarantinePath !== undefined ? { quarantinePath } : {}),
      ...(expectedDigest !== undefined ? { expectedDigest } : {}),
      ...(previousDigest !== undefined ? { previousDigest } : {}),
    };
  }

  private async readPoisonMarker(): Promise<WorkerStoreQuarantine | undefined> {
    if (this.poisoned) return this.poisoned;
    let raw: string;
    try {
      raw = await readFile(this.poisonPath(), "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw error;
    }
    try {
      this.poisoned = this.parsePoisonMarker(JSON.parse(raw));
    } catch {
      this.poisoned = {
        version: 1,
        kind: "corrupt",
        statePath: this.path,
        detectedAt: this.options.now(),
        reason: "poison marker is corrupt",
      };
    }
    return this.poisoned;
  }

  private async assertNotPoisonedLocked(): Promise<void> {
    const marker = await this.readPoisonMarker();
    if (marker) throw new WorkerStorePoisonedError(`Worker state ${this.path} is quarantined: ${marker.reason}`, marker);
  }

  private async recordPoisonLocked(marker: WorkerStoreQuarantine): Promise<void> {
    this.poisoned = marker;
    try {
      await this.writeSmallDurable(this.poisonPath(), `${JSON.stringify(marker, null, 2)}\n`);
    } catch (error) {
      throw new WorkerStorePoisonedError(`Worker state ${this.path} is poisoned and its marker could not be made durable: ${errorText(error)}`, marker);
    }
  }

  private async quarantineCorruptLocked(reason: string): Promise<never> {
    const quarantinePath = `${this.path}.quarantine.${this.options.now()}.${process.pid}.${randomUUID()}`;
    const marker: WorkerStoreQuarantine = {
      version: 1,
      kind: "corrupt",
      statePath: this.path,
      detectedAt: this.options.now(),
      reason,
      quarantinePath,
    };
    // Make the fail-closed marker durable before moving the only state copy.
    await this.recordPoisonLocked(marker);
    try {
      await rename(this.path, quarantinePath);
      await this.syncDirectory();
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        marker.reason = `${reason}; quarantine rename failed: ${errorText(error)}`;
        throw new WorkerStoreCorruptError(marker.reason, quarantinePath);
      }
    }
    throw new WorkerStoreCorruptError(`Could not parse worker state ${this.path}: ${reason}; preserved at ${quarantinePath}`, quarantinePath);
  }

  private assertSupportedFeatures(state: WorkerStateFileV2 | WorkerStateFileV3 | WorkerStateFileV4): void {
    const unsupported = (state.activeFeatures ?? []).filter((feature) => !this.supportedFeatures.has(feature));
    if (unsupported.length > 0) throw new WorkerStoreUnsupportedFeatureError(unsupported);
  }

  private parseRaw(raw: string): { state: WorkerStateFileV4; sourceVersion: 1 | 2 | 3 | 4 } {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new WorkerStoreValidationError(`invalid JSON: ${errorText(error)}`);
    }
    const header = assertPlainObject(value, "worker state");
    const version = header.version;
    // Gate on the top-level version and declared feature set before exact or
    // nested parsing. Future feature-owned fields must not look like corruption
    // to an older reader that already knows it cannot interpret the feature.
    if (typeof version === "number" && Number.isSafeInteger(version) && version > CURRENT_VERSION) {
      throw new WorkerStoreUnsupportedVersionError(version);
    }
    const declaredFeatures = parseFeatureList(header.activeFeatures);
    const unsupportedFeatures = (declaredFeatures ?? []).filter((feature) => !this.supportedFeatures.has(feature));
    if (unsupportedFeatures.length > 0) throw new WorkerStoreUnsupportedFeatureError(unsupportedFeatures);
    if (version === 1) return { state: migrateV3File(migrateLegacyFile(parseLegacyFile(value), this.options.now(), this.options)), sourceVersion: 1 };
    if (version === 2) {
      const state = parseV2File(value, false);
      this.assertSupportedFeatures(state);
      return { state: migrateV3File(migrateV2File(state)), sourceVersion: 2 };
    }
    if (version === 3) {
      const state = parseV3File(value, false);
      this.assertSupportedFeatures(state);
      return { state: migrateV3File(state), sourceVersion: 3 };
    }
    if (version === 4) {
      const state = parseV4File(value, false);
      this.assertSupportedFeatures(state);
      return { state, sourceVersion: 4 };
    }
    throw new WorkerStoreValidationError(`unsupported or corrupt worker state version ${String(version)}`);
  }

  /**
   * Read only a healthy canonical v4 snapshot without touching the writer lock.
   * This is an atomic-file snapshot, not a writer-linearizable or crash-durable
   * observation: it may see the state immediately before an in-flight commit or
   * after rename but before the writer's directory fsync completes. Callers that
   * mutate still revalidate under the writer lock. Any absence, legacy schema,
   * or parse ambiguity is deliberately retried under the lock, where migration
   * and quarantine ordering remains authoritative.
   */
  private async loadCanonicalV4LockFree(): Promise<WorkerStateFileV4 | undefined> {
    const poisonBefore = await this.readPoisonMarker();
    if (poisonBefore) {
      throw new WorkerStorePoisonedError(`Worker state ${this.path} is quarantined: ${poisonBefore.reason}`, poisonBefore);
    }
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw new WorkerStoreError(`Could not read worker state ${this.path}: ${errorText(error)}`, "WORKER_STORE_READ_FAILED");
    }
    let parsed: { state: WorkerStateFileV4; sourceVersion: 1 | 2 | 3 | 4 };
    try {
      parsed = this.parseRaw(raw);
    } catch (error) {
      if (error instanceof WorkerStoreUnsupportedVersionError || error instanceof WorkerStoreUnsupportedFeatureError) throw error;
      return undefined;
    }
    if (parsed.sourceVersion !== 4) return undefined;
    const poisonAfter = await this.readPoisonMarker();
    if (poisonAfter) {
      throw new WorkerStorePoisonedError(`Worker state ${this.path} is quarantined: ${poisonAfter.reason}`, poisonAfter);
    }
    return parsed.state;
  }

  private async loadLocked(): Promise<LoadedState> {
    await this.assertNotPoisonedLocked();
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { state: { version: 4, generation: 0, workers: [], workerGenerations: [] }, sourceVersion: 0 };
      throw new WorkerStoreError(`Could not read worker state ${this.path}: ${errorText(error)}`, "WORKER_STORE_READ_FAILED");
    }
    try {
      const parsed = this.parseRaw(raw);
      return { ...parsed, raw };
    } catch (error) {
      if (error instanceof WorkerStoreUnsupportedVersionError || error instanceof WorkerStoreUnsupportedFeatureError) throw error;
      return await this.quarantineCorruptLocked(errorText(error));
    }
  }

  private async acquireLockMutationGuard(lockPath: string, timeoutMs?: number): Promise<() => Promise<void>> {
    try {
      return await acquireKernelFileLock(`${lockPath}.reclaim`, timeoutMs);
    } catch (error) {
      throw new WorkerStoreError(`Could not acquire worker state lock mutation guard ${lockPath}.reclaim: ${errorText(error)}`, "WORKER_STORE_LOCK_TIMEOUT");
    }
  }

  private async writeLockOwner(ownerPath: string, token: string): Promise<void> {
    // Owner metadata is advisory for stale-lock diagnostics and recovery, not
    // committed state. A fresh owner-less directory fails closed until stale;
    // after a crash, missing or partial metadata can therefore delay recovery
    // until LOCK_STALE_MS rather than permitting immediate dead-PID detection.
    const ownerHandle = await open(ownerPath, "wx", 0o600);
    try {
      await ownerHandle.writeFile(`${JSON.stringify({ pid: process.pid, token, createdAt: this.options.now() })}\n`, "utf8");
    } finally {
      await ownerHandle.close();
    }
  }

  private async confirmLockOwner(ownerPath: string, token: string): Promise<void> {
    try {
      const owner = JSON.parse(await readFile(ownerPath, "utf8")) as { token?: unknown };
      if (owner.token !== token) throw new Error("token mismatch");
    } catch (error) {
      throw new WorkerStoreError(`Could not confirm worker state lock owner ${ownerPath}: ${errorText(error)}`, "WORKER_STORE_LOCK_FAILED");
    }
  }

  private lockReleaseTombstonePath(lockPath: string, token: string): string {
    return `${lockPath}${LOCK_RELEASE_TOMBSTONE_MARKER}${token}.${randomUUID()}`;
  }

  private async releaseOwnedLock(lockPath: string, token: string): Promise<void> {
    await this.measured("lock_release", async () => {
      const ownerPath = `${lockPath}/owner.json`;
      await this.confirmLockOwner(ownerPath, token);
      const tombstonePath = this.lockReleaseTombstonePath(lockPath, token);
      await rename(lockPath, tombstonePath);
      try {
        await this.confirmLockOwner(`${tombstonePath}/owner.json`, token);
      } catch (error) {
        // A replacement between confirmation and rename is not ours. Restore it
        // rather than deleting it; a concurrently acquired new owner wins and
        // leaves the displaced directory for age-gated collection.
        await rename(tombstonePath, lockPath).catch(() => undefined);
        throw error;
      }
      await this.syncDirectory(lockPath);
      await rm(tombstonePath, { recursive: true, force: true });
      await this.syncDirectory(tombstonePath);
    });
  }

  private async cleanupFailedLockClaim(lockPath: string, ownerPath: string, token: string, _guardHeld = false): Promise<void> {
    try {
      const owner = JSON.parse(await readFile(ownerPath, "utf8")) as { token?: unknown };
      if (owner.token !== token) return;
      await this.releaseOwnedLock(lockPath, token);
    } catch (error) {
      // An owner-less directory from our failed metadata creation can be
      // removed only if it is still empty. A replacement owner makes rmdir
      // fail with ENOTEMPTY, preserving the replacement without a guard wait.
      if (errorCode(error) !== "ENOENT") return;
      try {
        await rmdir(lockPath);
        await this.syncDirectory(lockPath);
      } catch (removeError) {
        if (errorCode(removeError) !== "ENOENT" && errorCode(removeError) !== "ENOTEMPTY" && errorCode(removeError) !== "EEXIST") throw removeError;
      }
    }
  }

  private async collectAgedLockReleaseTombstones(lockPath: string): Promise<void> {
    const startedAt = this.options.instrumentation ? process.hrtime.bigint() : undefined;
    let collected = false;
    const parent = dirname(lockPath);
    const prefix = `${basename(lockPath)}${LOCK_RELEASE_TOMBSTONE_MARKER}`;
    let entries: string[];
    try {
      entries = (await readdir(parent)).filter((entry) => entry.startsWith(prefix));
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(parent, entry);
      try {
        const info = await lstat(path);
        if (!info.isDirectory() || info.isSymbolicLink()) continue;
        const ageMs = Math.max(0, this.options.now() - info.mtimeMs);
        if (ageMs <= LOCK_RELEASE_TOMBSTONE_MAX_AGE_MS) continue;
        await rm(path, { recursive: true, force: true });
        await this.syncDirectory(path);
        collected = true;
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    }
    if (collected) this.metric("tombstone_gc", startedAt, "ok");
  }

  private async inspectLiveLockOwner(lockPath: string, ownerPath: string): Promise<{ live: boolean; ownerPid?: number; ownerAlive?: boolean; lockAgeMs?: number }> {
    try {
      const lockStat = await stat(lockPath);
      const lockAgeMs = Math.max(0, this.options.now() - lockStat.mtimeMs);
      let ownerPid: number | undefined;
      try {
        const owner = JSON.parse(await readFile(ownerPath, "utf8")) as { pid?: unknown; token?: unknown };
        if (Number.isSafeInteger(owner.pid) && (owner.pid as number) > 0 && typeof owner.token === "string" && owner.token.length > 0) {
          ownerPid = owner.pid as number;
        }
      } catch {
        // Guarded inspection remains authoritative for missing/partial owners.
      }
      const ownerAlive = ownerPid === undefined ? undefined : isProcessAlive(ownerPid);
      // A verified live PID is authoritative regardless of directory age. Lock
      // age is only a fail-closed fallback when owner metadata is absent or
      // malformed; it must never send a live owner into reclaim-guard churn.
      return { live: ownerAlive === true, ownerPid, ownerAlive, lockAgeMs };
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { live: false };
      throw error;
    }
  }

  async inspectLock(): Promise<WorkerStoreLockDiagnostics> {
    const lock = await this.inspectLiveLockOwner(`${this.path}.lock`, `${this.path}.lock/owner.json`);
    return {
      present: lock.lockAgeMs !== undefined,
      ...(lock.ownerPid !== undefined ? { ownerPid: lock.ownerPid } : {}),
      ...(lock.ownerAlive !== undefined ? { ownerAlive: lock.ownerAlive } : {}),
      ...(lock.lockAgeMs !== undefined ? { ageMs: Math.round(lock.lockAgeMs) } : {}),
    };
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const lockPath = `${this.path}.lock`;
    const ownerPath = `${lockPath}/owner.json`;
    const token = randomUUID();
    const startedAt = Date.now();
    await this.collectAgedLockReleaseTombstones(lockPath);
    let lastOwnerPid: number | undefined;
    let lastOwnerAlive: boolean | undefined;
    let lastLockAgeMs: number | undefined;
    let liveBackoffMs = LOCK_RETRY_MIN_MS;
    while (Date.now() - startedAt < this.options.lockTimeoutMs) {
      const remainingMs = this.options.lockTimeoutMs - (Date.now() - startedAt);
      if (remainingMs <= 0) break;
      let acquired = false;
      try {
        await mkdir(lockPath, { recursive: false, mode: 0o700 });
        try {
          await this.writeLockOwner(ownerPath, token);
          await this.confirmLockOwner(ownerPath, token);
          acquired = true;
        } catch (error) {
          await this.cleanupFailedLockClaim(lockPath, ownerPath, token);
          throw error;
        }
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
      if (!acquired) {
        const precheck = await this.inspectLiveLockOwner(lockPath, ownerPath);
        lastOwnerPid = precheck.ownerPid;
        lastOwnerAlive = precheck.ownerAlive;
        lastLockAgeMs = precheck.lockAgeMs;
        if (precheck.live) {
          this.metric("lock_live_backoff", this.options.instrumentation ? process.hrtime.bigint() : undefined, "ok");
          const retryBudgetMs = this.options.lockTimeoutMs - (Date.now() - startedAt);
          if (retryBudgetMs <= 0) break;
          const retryMs = liveBackoffMs + Math.floor(Math.random() * (LOCK_RETRY_JITTER_MS + 1));
          await delay(Math.min(retryMs, retryBudgetMs));
          liveBackoffMs = Math.min(LOCK_LIVE_BACKOFF_MAX_MS, liveBackoffMs * 2);
          continue;
        }
        liveBackoffMs = LOCK_RETRY_MIN_MS;
        let releaseGuard: () => Promise<void>;
        const guardStartedAt = this.options.instrumentation ? process.hrtime.bigint() : undefined;
        try {
          releaseGuard = await this.acquireLockMutationGuard(lockPath, remainingMs);
          this.metric("lock_reclaim_guard", guardStartedAt, "ok");
        } catch (error) {
          this.metric("lock_reclaim_guard", guardStartedAt, "error");
          if (Date.now() - startedAt >= this.options.lockTimeoutMs) break;
          throw error;
        }
        try {
          // The owner may have released between our failed mkdir and acquiring
          // the guard. Retry under the guard before inspecting/reclaiming.
          try {
            await mkdir(lockPath, { recursive: false, mode: 0o700 });
            try {
              await this.writeLockOwner(ownerPath, token);
              await this.confirmLockOwner(ownerPath, token);
              acquired = true;
            } catch (error) {
              await this.cleanupFailedLockClaim(lockPath, ownerPath, token, true);
              throw error;
            }
          } catch (error) {
            if (errorCode(error) !== "EEXIST") throw error;
          }
          if (!acquired) {
            try {
              const lockStat = await stat(lockPath);
              let ownerPid: number | undefined;
              try {
                const owner = JSON.parse(await readFile(ownerPath, "utf8")) as { pid?: unknown };
                if (Number.isSafeInteger(owner.pid) && (owner.pid as number) > 0) ownerPid = owner.pid as number;
              } catch {
                // Owner creation can race this guarded inspection; age is the
                // fail-closed fallback for a malformed or crash-left owner.
              }
              lastOwnerPid = ownerPid;
              lastOwnerAlive = ownerPid === undefined ? undefined : isProcessAlive(ownerPid);
              lastLockAgeMs = Math.max(0, this.options.now() - lockStat.mtimeMs);
              const stale = ownerPid !== undefined
                ? !lastOwnerAlive
                : lastLockAgeMs > LOCK_STALE_MS;
              if (stale) {
                await rm(lockPath, { recursive: true, force: true });
                await this.syncDirectory(lockPath);
              }
            } catch (error) {
              if (errorCode(error) !== "ENOENT") throw error;
            }
          }
        } finally {
          await releaseGuard();
        }
      }
      if (acquired) {
        return async () => {
          // Atomic rename removes the owned path immediately without waiting on
          // the shared reclaim guard. Unique tombstones are crash-recoverable
          // and invisible to mixed-version lock contenders.
          await this.releaseOwnedLock(lockPath, token);
        };
      }
      const retryBudgetMs = this.options.lockTimeoutMs - (Date.now() - startedAt);
      if (retryBudgetMs <= 0) break;
      const retryMs = LOCK_RETRY_MIN_MS + Math.floor(Math.random() * (LOCK_RETRY_JITTER_MS + 1));
      await delay(Math.min(retryMs, retryBudgetMs));
    }
    const diagnostics = [
      `timeoutMs=${this.options.lockTimeoutMs}`,
      lastOwnerPid === undefined ? "ownerPid=unknown" : `ownerPid=${lastOwnerPid}`,
      lastOwnerAlive === undefined ? "ownerAlive=unknown" : `ownerAlive=${String(lastOwnerAlive)}`,
      lastLockAgeMs === undefined ? "lockAgeMs=unknown" : `lockAgeMs=${Math.round(lastLockAgeMs)}`,
    ].join(", ");
    throw new WorkerStoreError(`Timed out waiting for worker state lock ${lockPath} (${diagnostics})`, "WORKER_STORE_LOCK_TIMEOUT");
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const startedAt = this.options.instrumentation ? process.hrtime.bigint() : undefined;
    let release: (() => Promise<void>) | undefined;
    try {
      release = await this.acquireLock();
      this.metric("lock_wait", startedAt, "ok");
    } catch (error) {
      this.metric("lock_wait", startedAt, "error");
      throw error;
    }
    try {
      return await fn();
    } finally {
      await release();
    }
  }

  private normalizeApiWorker(value: unknown, path: string, previous: WorkerRecord | undefined, previousGeneration = 0, sourceVersion: 2 | 3 | 4 = 4): WorkerRecordV4 {
    const allowed = sourceVersion === 2 ? V2_API_WORKER_KEYS : sourceVersion === 3 ? V3_API_WORKER_KEYS : V4_API_WORKER_KEYS;
    const object = assertExactObject(value, allowed, ["id", "harness", "role", "task", "cwd", "state", "owned", "createdAt", "updatedAt", "leaseExpiresAt"], path);
    const id = requiredString(object, "id", path);
    const runAlias = optionalString(object, "runId", path);
    let incarnation = optionalString(object, "workerIncarnationId", path) ?? runAlias;
    if (!incarnation) throw new WorkerStoreValidationError(`${path} requires workerIncarnationId or deprecated runId`);
    if (runAlias && runAlias !== incarnation) {
      if (previous && workerIdentity(previous) === incarnation) incarnation = runAlias; // Deprecated alias was intentionally changed.
      else if (!previous || workerIdentity(previous) !== runAlias) throw new WorkerStoreValidationError(`${path}.runId conflicts with workerIncarnationId`);
      // Otherwise the canonical incarnation changed and the hydrated alias is merely stale.
    }
    let managerOwner = object.managerOwner === undefined ? undefined : parseManagerOwner(object.managerOwner, `${path}.managerOwner`);
    const managerAlias = optionalString(object, "managerSessionId", path);
    if (!managerOwner) {
      if (!managerAlias) throw new WorkerStoreValidationError(`${path} requires managerOwner or deprecated managerSessionId`);
      managerOwner = {
        context: previous?.managerOwner?.context ?? this.options.legacyManagerContext,
        principalId: managerAlias,
        sessionId: managerAlias,
        bindingEpoch: previous?.managerOwner && previous.managerOwner.sessionId !== managerAlias ? previous.managerOwner.bindingEpoch + 1 : (previous?.managerOwner?.bindingEpoch ?? 0),
      } as ManagerOwnerBinding;
    } else if (managerAlias && managerAlias !== managerOwner.sessionId) {
      if (previous?.managerOwner?.sessionId === managerOwner.sessionId) {
        managerOwner = { context: managerOwner.context, principalId: managerAlias, sessionId: managerAlias, bindingEpoch: managerOwner.bindingEpoch + 1 } as ManagerOwnerBinding;
      } else if (previous?.managerOwner?.sessionId === managerAlias) {
        // The canonical binding changed and the hydrated deprecated alias is stale.
      } else {
        throw new WorkerStoreValidationError(`${path}.managerSessionId conflicts with managerOwner.sessionId`);
      }
    }
    if (previous?.managerOwner && object.managerOwner !== undefined) {
      const sameBinding = previous.managerOwner.context === managerOwner.context
        && previous.managerOwner.principalId === managerOwner.principalId
        && previous.managerOwner.sessionId === managerOwner.sessionId;
      const expectedEpoch = sameBinding ? previous.managerOwner.bindingEpoch : previous.managerOwner.bindingEpoch + 1;
      if (managerOwner.bindingEpoch !== expectedEpoch) {
        throw new WorkerStoreValidationError(`${path}.managerOwner.bindingEpoch must be ${expectedEpoch} for this binding transition`);
      }
    }
    const previousIncarnation = previous && workerIdentity(previous);
    const expectedWorkerGeneration = previous
      ? previousIncarnation === incarnation ? previous.workerGeneration! : previous.workerGeneration! + 1
      : previousGeneration + 1;
    const suppliedWorkerGeneration = optionalNumber(object, "workerGeneration", path, true, 1);
    if (suppliedWorkerGeneration !== undefined && suppliedWorkerGeneration !== expectedWorkerGeneration) {
      const hydratedPreviousGeneration = previous
        ? previousIncarnation !== incarnation && suppliedWorkerGeneration === previous.workerGeneration
        : previousGeneration > 0 && suppliedWorkerGeneration === previousGeneration;
      if (!hydratedPreviousGeneration) throw new WorkerStoreConflictError(expectedWorkerGeneration, suppliedWorkerGeneration);
    }
    if (previous && isTerminalWorkerGeneration(previous.state) && previousIncarnation === incarnation && !isTerminalWorkerGeneration(object.state as WorkerState)) {
      throw new WorkerStoreValidationError(`${path} cannot restart terminal generation ${previous.workerGeneration}; use a new worker incarnation`);
    }
    let candidate: Record<string, unknown> = {
      ...object,
      runId: incarnation,
      workerIncarnationId: incarnation,
      workerGeneration: expectedWorkerGeneration,
      managerSessionId: managerOwner.sessionId,
      managerOwner,
      backend: object.backend ?? "systemd",
      hierarchy: object.hierarchy ?? (previous && workerIdentity(previous) === incarnation ? previous.hierarchy : undefined) ?? { rootWorkerIncarnationId: incarnation, depth: 0 },
    };
    const state = object.state;
    if (typeof state !== "string") throw new WorkerStoreValidationError(`${path}.state must be a string`);
    if (state !== "migration_pending" && !CANONICAL_STATES.has(state as CanonicalWorkerState)) {
      if (!LEGACY_STATES.has(state as LegacyWorkerState)) throw new WorkerStoreValidationError(`${path}.state is invalid`);
      const legacyInput: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(candidate)) {
        if (LEGACY_WORKER_KEYS.has(key)) legacyInput[key] = entry;
      }
      legacyInput.runId = incarnation;
      legacyInput.managerSessionId = managerOwner.sessionId;
      const legacy = parseLegacyWorker(compactObject(legacyInput), path);
      const migrated = migrateLegacyWorker(legacy, this.options.now(), this.options);
      candidate = { ...migrated, workerGeneration: expectedWorkerGeneration, managerOwner, managerSessionId: managerOwner.sessionId };
    }
    return parseVersionedWorker(compactObject(candidate), path, true, 4) as WorkerRecordV4;
  }

  private normalizeInput(state: WorkerStateFile, previous: WorkerStateFileV4): WorkerStateFileV4 {
    const header = assertPlainObject(state, "worker state");
    if (header.version === 1) {
      const migrated = migrateLegacyFile(parseLegacyFile(state), this.options.now(), this.options);
      const previousById = new Map(previous.workers.map((worker) => [worker.id, worker]));
      const generations = new Map(previous.workerGenerations.map((entry) => [entry.workerId, entry.generation]));
      for (const worker of migrated.workers) {
        const old = previousById.get(worker.id);
        worker.workerGeneration = old
          ? workerIdentity(old) === workerIdentity(worker) ? old.workerGeneration : old.workerGeneration! + 1
          : (generations.get(worker.id) ?? 0) + 1;
        generations.set(worker.id, Math.max(generations.get(worker.id) ?? 0, worker.workerGeneration));
      }
      migrated.workerGenerations = [...generations].map(([workerId, generation]) => ({ workerId, generation })).sort((left, right) => left.workerId.localeCompare(right.workerId));
      if (previous.activeFeatures) migrated.activeFeatures = structuredClone(previous.activeFeatures);
      return migrateV3File(migrated);
    }
    const object = assertExactObject(state, new Set(["version", "generation", "workers", "workerGenerations", "runtimeCleanupClaims", "activeFeatures"]), ["version", "generation", "workers"], "worker state");
    if (object.version !== 2 && object.version !== 3 && object.version !== 4) throw new WorkerStoreValidationError(`worker state version must be 1, 2, 3, or 4`);
    const sourceVersion = object.version;
    const generation = requiredNumber(object, "generation", "worker state", true);
    const previousById = new Map(previous.workers.map((worker) => [worker.id, worker]));
    const previousGenerationById = new Map(previous.workerGenerations.map((entry) => [entry.workerId, entry.generation]));
    const suppliedGenerations = parseWorkerGenerations(object.workerGenerations, false);
    if (object.workerGenerations !== undefined && JSON.stringify(suppliedGenerations) !== JSON.stringify(previous.workerGenerations)) {
      throw new WorkerStoreValidationError("worker state.workerGenerations is store-managed and must match the current ledger");
    }
    const workers = assertDenseArray(object.workers, "worker state.workers").map((worker, index) => {
      const raw = assertPlainObject(worker, `worker state.workers[${index}]`);
      const id = requiredString(raw, "id", `worker state.workers[${index}]`);
      return this.normalizeApiWorker(worker, `worker state.workers[${index}]`, previousById.get(id), previousGenerationById.get(id) ?? 0, sourceVersion);
    });
    assertUniqueWorkers(workers);
    assertValidHierarchy(workers);
    const claims = object.runtimeCleanupClaims === undefined
      ? undefined
      : assertDenseArray(object.runtimeCleanupClaims, "worker state.runtimeCleanupClaims").map((claim, index) => parseClaim(claim, `worker state.runtimeCleanupClaims[${index}]`));
    const activeFeatures = parseFeatureList(object.activeFeatures);
    const nextGenerationById = new Map(previous.workerGenerations.map((entry) => [entry.workerId, entry.generation]));
    for (const worker of workers) nextGenerationById.set(worker.id, Math.max(nextGenerationById.get(worker.id) ?? 0, worker.workerGeneration));
    const normalized: WorkerStateFileV4 = {
      version: 4,
      generation,
      workers,
      workerGenerations: [...nextGenerationById].map(([workerId, workerGeneration]) => ({ workerId, generation: workerGeneration })).sort((left, right) => left.workerId.localeCompare(right.workerId)),
      ...(claims ? { runtimeCleanupClaims: claims } : {}),
      ...(activeFeatures ? { activeFeatures } : {}),
    };
    this.assertSupportedFeatures(normalized);
    return normalized;
  }

  private assertPendingRecordsPreserved(previous: WorkerStateFileV4, next: WorkerStateFileV4, allowResolution: boolean): void {
    for (const worker of previous.workers) {
      if (worker.state !== "migration_pending") continue;
      const updated = next.workers.find((candidate) => candidate.id === worker.id);
      if (!updated) throw new WorkerStoreMigrationPendingError(worker.id);
      if (allowResolution) {
        const allowedState = updated.state === "stopped" || updated.state === "failed" || updated.state === "lost" || updated.state === "unreachable";
        if (!allowedState || workerIdentity(updated) !== workerIdentity(worker) || updated.workerGeneration !== worker.workerGeneration) {
          throw new WorkerStoreMigrationPendingError(worker.id);
        }
        continue;
      }
      if (JSON.stringify(storedWorker(updated)) !== JSON.stringify(storedWorker(worker))) throw new WorkerStoreMigrationPendingError(worker.id);
    }
  }

  private async callFault(point: WorkerStoreFaultPoint, tempPath: string): Promise<void> {
    await this.options.faultInjector?.(point, { statePath: this.path, tempPath });
  }

  private async durableCommit(text: string, previousRaw?: string, preserveRecoverySnapshot = false): Promise<void> {
    const startedAt = this.options.instrumentation ? process.hrtime.bigint() : undefined;
    try {
      if (previousRaw !== undefined && !preserveRecoverySnapshot) await this.writeRecoverySnapshot(previousRaw);
      await this.durableCommitUnmeasured(text, previousRaw);
      this.metric("commit", startedAt, "ok", Buffer.byteLength(text));
    } catch (error) {
      this.metric("commit", startedAt, "error", Buffer.byteLength(text));
      throw error;
    }
  }

  private async durableCommitUnmeasured(text: string, previousRaw?: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tempPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let renameAttempted = false;
    try {
      handle = await open(tempPath, "wx", 0o600);
      await handle.writeFile(text, "utf8");
      await this.callFault("after_temp_write", tempPath);
      await handle.sync();
      await this.callFault("after_file_fsync", tempPath);
      await handle.close();
      handle = undefined;
      renameAttempted = true;
      await rename(tempPath, this.path);
      await this.callFault("after_rename", tempPath);
      await this.syncDirectory();
      await this.callFault("after_directory_fsync", tempPath);
      return;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      handle = undefined;
      if (!renameAttempted) throw error;
      let observed: string | undefined;
      try {
        observed = await readFile(this.path, "utf8");
      } catch (readError) {
        if (errorCode(readError) !== "ENOENT") observed = undefined;
      }
      if (observed === text) {
        try {
          await this.syncDirectory();
          return;
        } catch {
          // Persist an ambiguous marker below.
        }
      }
      if (previousRaw !== undefined && observed === previousRaw) throw error;
      const marker: WorkerStoreQuarantine = {
        version: 1,
        kind: "ambiguous_commit",
        statePath: this.path,
        detectedAt: this.options.now(),
        reason: `ambiguous commit after rename: ${errorText(error)}`,
        expectedDigest: digest(text),
        ...(previousRaw === undefined ? {} : { previousDigest: digest(previousRaw) }),
      };
      await this.recordPoisonLocked(marker);
      throw new WorkerStorePoisonedError(`Worker state commit is ambiguous and has been poisoned: ${errorText(error)}`, marker);
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(tempPath, { force: true }).catch(() => undefined);
    }
  }

  private async writeRecoverySnapshot(previousRaw: string): Promise<void> {
    const parsed = this.parseRaw(previousRaw);
    if (parsed.sourceVersion !== 4) return;
    const state = cloneState(parsed.state);
    const stateText = serializedState(state);
    const snapshot: WorkerStoreRecoverySnapshot = {
      version: 1,
      statePath: this.path,
      capturedAt: this.options.now(),
      stateDigest: digest(stateText),
      state: JSON.parse(stateText) as WorkerStateFileV4,
    };
    await this.writeSmallDurable(this.recoveryPath(), `${JSON.stringify(snapshot, null, 2)}\n`);
  }

  async readRecoverySnapshot(): Promise<WorkerStoreRecoverySnapshot | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.recoveryPath(), "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      throw new WorkerStoreError(`Could not read worker recovery snapshot ${this.recoveryPath()}: ${errorText(error)}`, "WORKER_STORE_RECOVERY_READ_FAILED");
    }
    try {
      const value = assertExactObject(JSON.parse(raw), new Set(["version", "statePath", "capturedAt", "stateDigest", "state"]), ["version", "statePath", "capturedAt", "stateDigest", "state"], "worker recovery snapshot");
      if (requiredNumber(value, "version", "worker recovery snapshot", true, 1) !== 1) throw new WorkerStoreValidationError("worker recovery snapshot.version must equal 1");
      if (requiredString(value, "statePath", "worker recovery snapshot") !== this.path) throw new WorkerStoreValidationError("worker recovery snapshot.statePath does not match this store");
      const state = parseV4File(value.state, false);
      this.assertSupportedFeatures(state);
      const stateDigest = requiredString(value, "stateDigest", "worker recovery snapshot");
      if (digest(serializedState(state)) !== stateDigest) throw new WorkerStoreValidationError("worker recovery snapshot digest does not match its state");
      return {
        version: 1,
        statePath: this.path,
        capturedAt: requiredNumber(value, "capturedAt", "worker recovery snapshot", true, 0),
        stateDigest,
        state: cloneState(state),
      };
    } catch (error) {
      throw new WorkerStoreError(`Worker recovery snapshot ${this.recoveryPath()} is invalid: ${errorText(error)}`, "WORKER_STORE_RECOVERY_INVALID");
    }
  }

  private publish(target: WorkerStateFile, committed: WorkerStateFileV4): void {
    try {
      for (const key of Object.keys(target)) delete (target as unknown as Record<string, unknown>)[key];
      Object.assign(target, cloneState(committed));
    } catch {
      // A caller may submit frozen plain data. Durability is authoritative; an
      // inability to refresh that caller-owned object must not turn a committed
      // write into a reported failure.
    }
  }

  private async writeLocked(state: WorkerStateFile, context: HeldWriteContext): Promise<void> {
    const previous = context.loaded.state;
    if ((state.version === 2 || state.version === 3 || state.version === 4) && state.generation !== previous.generation) {
      throw new WorkerStoreConflictError(state.generation ?? -1, previous.generation);
    }
    const normalized = this.normalizeInput(state, previous);
    normalized.generation = previous.generation + 1;
    this.assertPendingRecordsPreserved(previous, normalized, context.allowPendingResolution);
    const text = serializedState(normalized);
    await this.durableCommit(text, context.loaded.raw);
    const committed = cloneState(normalized);
    context.loaded = { state: committed, raw: text, sourceVersion: 4 };
    this.publish(state, committed);
  }

  async read(): Promise<WorkerStateFileV4> {
    return this.enqueue(() => this.measured("read", async () => {
      const fast = await this.loadCanonicalV4LockFree();
      if (fast) return cloneState(fast);
      return this.withLock(async () => cloneState((await this.loadLocked()).state));
    }));
  }

  /**
   * Restore the independently validated predecessor only while the canonical
   * registry is still the exact empty generation that was assessed. The
   * snapshot is re-read under the writer lock and selected by digest so a
   * concurrent overwrite, mutation, or snapshot rotation fails closed.
   */
  async restoreEmptyFromRecovery(
    expectedGeneration: number,
    expectedSnapshotDigest: string,
    transform?: (state: WorkerStateFileV4) => void,
  ): Promise<WorkerStateFileV4> {
    return this.enqueue(() => this.withLock(async () => {
      const loaded = await this.loadLocked();
      if (loaded.state.generation !== expectedGeneration) {
        throw new WorkerStoreConflictError(expectedGeneration, loaded.state.generation);
      }
      if (loaded.state.workers.length !== 0) {
        throw new WorkerStoreError("Worker registry recovery requires the canonical registry to remain empty", "WORKER_STORE_RECOVERY_CONFLICT");
      }
      const snapshot = await this.readRecoverySnapshot();
      if (!snapshot || snapshot.stateDigest !== expectedSnapshotDigest) {
        throw new WorkerStoreError("Worker recovery snapshot changed before restore", "WORKER_STORE_RECOVERY_CONFLICT");
      }
      if (snapshot.state.workers.length === 0) {
        throw new WorkerStoreError("Worker recovery snapshot contains no worker records", "WORKER_STORE_RECOVERY_INVALID");
      }
      const restored = cloneState(snapshot.state);
      restored.generation = loaded.state.generation + 1;
      transform?.(restored);
      // Validate the transformed state before it becomes canonical. Recovery
      // callers may refresh deadlines, but cannot bypass the normal schema.
      // Validate against the independently trusted predecessor's store-managed
      // identity ledger. The canonical file may be ENOENT (generation zero),
      // in which case the empty loader has no ledger to compare against.
      const normalized = this.normalizeInput(restored, snapshot.state);
      normalized.generation = restored.generation;
      const text = serializedState(normalized);
      // The recovery snapshot is the independently validated populated copy.
      // Do not rotate the empty canonical predecessor over it while restoring:
      // a failure before or after rename must leave a populated recovery source.
      await this.durableCommit(text, loaded.raw, true);
      return cloneState(normalized);
    }));
  }

  /** Persist a validated v3 commit. Version-1/2 inputs take the explicit migration path first. */
  async write(state: WorkerStateFile): Promise<void> {
    await this.enqueue(() => this.withLock(async () => {
      const loaded = await this.loadLocked();
      await this.writeLocked(state, { loaded, allowPendingResolution: false });
    }));
  }

  /** Durably migrates a v1/v2 file without applying an unrelated user mutation. */
  async migrate(): Promise<WorkerStateFileV4> {
    return this.enqueue(() => this.withLock(async () => {
      const loaded = await this.loadLocked();
      if (loaded.sourceVersion === 3) return cloneState(loaded.state);
      const text = serializedState(loaded.state);
      await this.durableCommit(text, loaded.raw);
      return cloneState(loaded.state);
    }));
  }

  async mutate<T>(fn: (state: WorkerStateFile) => T | Promise<T>): Promise<T> {
    const commit = await this.mutateWithGeneration(undefined, async (state) => ({ value: await fn(state), changed: true }));
    return commit.value;
  }

  async mutateConditionally<T>(
    fn: (state: WorkerStateFile) => { value: T; changed: boolean } | Promise<{ value: T; changed: boolean }>,
  ): Promise<T> {
    const commit = await this.mutateConditionallyWithSnapshot(fn);
    return commit.value;
  }

  /** Conditional mutation with the defensive snapshot linearized at its commit/no-op. */
  async mutateConditionallyWithSnapshot<T>(
    fn: (state: WorkerStateFileV4) => { value: T; changed: boolean } | Promise<{ value: T; changed: boolean }>,
  ): Promise<WorkerStoreCommit<T>> {
    return this.mutateWithGeneration(undefined, fn);
  }

  /** Lock-backed optimistic mutation. A supplied generation is checked before the callback runs. */
  async mutateWithGeneration<T>(
    expectedGeneration: number | undefined,
    fn: (state: WorkerStateFileV4) => { value: T; changed: boolean } | Promise<{ value: T; changed: boolean }>,
  ): Promise<WorkerStoreCommit<T>> {
    return this.enqueue(() => {
      const startedAt = this.options.instrumentation ? process.hrtime.bigint() : undefined;
      return this.withLock(async () => {
        const loaded = await this.loadLocked();
        if (expectedGeneration !== undefined && loaded.state.generation !== expectedGeneration) {
          throw new WorkerStoreConflictError(expectedGeneration, loaded.state.generation);
        }
        const state = cloneState(loaded.state);
        const context: HeldWriteContext = { loaded, allowPendingResolution: false };
        const result = await fn(state);
        if (result.changed) await this.writeLocked(state, context);
        this.metric("mutation", startedAt, result.changed ? "ok" : "noop");
        return { value: result.value, generation: context.loaded.state.generation, state: cloneState(context.loaded.state) };
      }).catch((error) => {
        this.metric("mutation", startedAt, "error");
        throw error;
      });
    });
  }

  async compareAndSwap<T>(
    expectedGeneration: number,
    fn: (state: WorkerStateFileV4) => T | Promise<T>,
  ): Promise<WorkerStoreCommit<T>> {
    return this.mutateWithGeneration(expectedGeneration, async (state) => ({ value: await fn(state), changed: true }));
  }

  async transaction<T>(
    fn: (state: WorkerStateFile, persist: () => Promise<void>) => T | Promise<T>,
  ): Promise<T> {
    return this.enqueue(() => this.withLock(async () => {
      const loaded = await this.loadLocked();
      const state = cloneState(loaded.state);
      const context: HeldWriteContext = { loaded, allowPendingResolution: false };
      let persisting = false;
      const persist = async (): Promise<void> => {
        if (persisting) throw new WorkerStoreError("Concurrent transaction persist is not allowed", "WORKER_STORE_TRANSACTION_REENTRANCY");
        persisting = true;
        try {
          await this.writeLocked(state, context);
        } finally {
          persisting = false;
        }
      };
      return fn(state, persist);
    }));
  }

  /** Resolve the one non-canonical legacy stopping record from direct systemd observation. */
  async reconcileLegacyStopping(
    workerId: string,
    resolution: "stopped" | "failed" | "lost" | "unreachable",
    options: { expectedGeneration?: number; observedAt?: number; reason?: string } = {},
  ): Promise<WorkerStateFileV4> {
    return this.enqueue(() => this.withLock(async () => {
      const loaded = await this.loadLocked();
      if (options.expectedGeneration !== undefined && loaded.state.generation !== options.expectedGeneration) {
        throw new WorkerStoreConflictError(options.expectedGeneration, loaded.state.generation);
      }
      const state = cloneState(loaded.state);
      const worker = state.workers.find((candidate) => candidate.id === workerId);
      if (!worker || worker.state !== "migration_pending" || worker.migrationAudit?.originalState !== "stopping") {
        throw new WorkerStoreValidationError(`Worker ${workerId} is not pending legacy stopping reconciliation`);
      }
      const observedAt = options.observedAt ?? this.options.now();
      if (resolution === "unreachable" && observedAt < worker.migrationAudit.reconcileBy!) {
        throw new WorkerStoreValidationError(`Worker ${workerId} cannot become unreachable before legacy stopping bound ${worker.migrationAudit.reconcileBy}`);
      }
      worker.state = resolution;
      worker.stateReason = resolution === "unreachable" ? "legacy_stopping_unresolved" : (options.reason ?? `legacy_stopping_reconciled_${resolution}`);
      worker.updatedAt = Math.max(worker.updatedAt, observedAt);
      worker.migrationAudit = { ...worker.migrationAudit, resolvedAt: observedAt, resolution };
      const context: HeldWriteContext = { loaded, allowPendingResolution: true };
      await this.writeLocked(state, context);
      return cloneState(context.loaded.state);
    }));
  }

  /** Reconcile an ambiguous post-rename fault when the expected bytes are now present. */
  async reconcilePoisonedCommit(): Promise<WorkerStateFileV4> {
    return this.enqueue(() => this.withLock(async () => {
      const marker = await this.readPoisonMarker();
      if (!marker || marker.kind !== "ambiguous_commit" || !marker.expectedDigest) {
        throw new WorkerStorePoisonedError(`Worker state ${this.path} has no reconcilable ambiguous commit`, marker);
      }
      const raw = await readFile(this.path, "utf8");
      if (digest(raw) !== marker.expectedDigest) throw new WorkerStorePoisonedError(`Worker state ${this.path} does not match the ambiguous expected commit`, marker);
      const parsed = this.parseRaw(raw);
      await this.syncDirectory();
      await rm(this.poisonPath());
      await this.syncDirectory();
      this.poisoned = undefined;
      return cloneState(parsed.state);
    }));
  }

  /** Replace a quarantined store only with an explicitly supplied, fully validated snapshot. */
  async recoverFromQuarantine(replacement: WorkerStateFileV4, quarantinePath?: string): Promise<WorkerStateFileV4> {
    return this.enqueue(() => this.withLock(async () => {
      const marker = await this.readPoisonMarker();
      if (!marker || marker.kind !== "corrupt") throw new WorkerStorePoisonedError(`Worker state ${this.path} is not in corrupt quarantine`, marker);
      if (quarantinePath !== undefined && marker.quarantinePath !== quarantinePath) {
        throw new WorkerStoreValidationError(`Quarantine path does not match the durable poison marker`);
      }
      const empty: WorkerStateFileV4 = { version: 4, generation: 0, workers: [], workerGenerations: [] };
      const normalized = this.normalizeInput(replacement, empty);
      const text = serializedState(normalized);
      await this.durableCommit(text);
      await rm(this.poisonPath());
      await this.syncDirectory();
      this.poisoned = undefined;
      return cloneState(normalized);
    }));
  }

  async quarantineStatus(): Promise<WorkerStoreQuarantine | undefined> {
    return structuredClone(await this.readPoisonMarker());
  }

  async upsert(worker: WorkerRecord): Promise<void> {
    await this.mutate((state) => {
      const index = state.workers.findIndex((candidate) => candidate.id === worker.id);
      if (index >= 0) state.workers[index] = worker;
      else state.workers.push(worker);
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.mutateConditionally((state) => {
      const before = state.workers.length;
      state.workers = state.workers.filter((worker) => worker.id !== id);
      const removed = state.workers.length !== before;
      return { value: removed, changed: removed };
    });
  }
}

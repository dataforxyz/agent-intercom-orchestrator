import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  BOSS_CONTROLLER_STORE_VERSION,
  BossSchemaVersionError,
  BossUnsupportedFeatureError,
  BossValidationError,
  bossEntityId,
  canonicalBossJson,
  detachedBossSnapshot,
  parseBossControllerState,
  type BossControllerStateV1,
  type BossEntityByKind,
  type BossEntityKind,
} from "./boss-types.ts";
import { acquireKernelFileLock } from "./file-lock.ts";

export const BOSS_STORE_MIGRATIONS: readonly BossStoreMigration[] = Object.freeze([]);

export interface BossStoreMigration {
  readonly fromVersion: string;
  readonly toVersion: string;
  migrate(source: unknown): unknown;
}

export const BOSS_STORE_FAULT_POINTS = [
  "before_temp_write",
  "after_temp_write",
  "after_temp_fsync",
  "before_rename",
  "after_rename",
  "after_directory_fsync",
] as const;
export type BossStoreFaultPoint = (typeof BOSS_STORE_FAULT_POINTS)[number];

export interface BossStoreFaultContext {
  readonly path: string;
  readonly tempPath: string;
  readonly previousRevision: number | null;
  readonly attemptedRevision: number;
}

export interface BossStoreOptions {
  faultInjector?: (point: BossStoreFaultPoint, context: BossStoreFaultContext) => void | Promise<void>;
  now?: () => string;
  lockTimeoutMs?: number;
  lockPollMs?: number;
  staleLockMs?: number;
}

export class BossStoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BossStoreError";
  }
}

export class BossStoreNotFoundError extends BossStoreError {
  constructor(path: string) {
    super(`Boss Controller store does not exist: ${path}`);
    this.name = "BossStoreNotFoundError";
  }
}

export class BossStoreAlreadyExistsError extends BossStoreError {
  constructor(path: string) {
    super(`Boss Controller store already exists: ${path}`);
    this.name = "BossStoreAlreadyExistsError";
  }
}

export class BossStoreConflictError extends BossStoreError {
  readonly expectedRevision: number;
  readonly actualRevision: number;
  constructor(expectedRevision: number, actualRevision: number) {
    super(`Boss Controller store CAS conflict: expected revision ${expectedRevision}, found ${actualRevision}`);
    this.name = "BossStoreConflictError";
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class BossStoreUnsupportedError extends BossStoreError {
  readonly validationError: BossSchemaVersionError | BossUnsupportedFeatureError;
  constructor(path: string, error: BossSchemaVersionError | BossUnsupportedFeatureError) {
    super(`Refusing to mutate unsupported Boss Controller state ${path}: ${error.message}`, { cause: error });
    this.name = "BossStoreUnsupportedError";
    this.validationError = error;
  }
}

export class BossStoreCorruptError extends BossStoreError {
  readonly quarantinePath: string;
  constructor(path: string, quarantinePath: string, cause: unknown) {
    super(`Boss Controller state is corrupt and has been quarantined read-only: ${path} -> ${quarantinePath}`, {
      cause: cause instanceof Error ? cause : undefined,
    });
    this.name = "BossStoreCorruptError";
    this.quarantinePath = quarantinePath;
  }
}

export class BossStorePoisonedError extends BossStoreError {
  readonly poisonPath: string;
  constructor(path: string, poisonPath: string, detail: string, cause?: unknown) {
    super(`Boss Controller store is poisoned and read-only: ${path} (${detail}); marker=${poisonPath}`, {
      cause: cause instanceof Error ? cause : undefined,
    });
    this.name = "BossStorePoisonedError";
    this.poisonPath = poisonPath;
  }
}

export class BossStoreCommitError extends BossStoreError {
  readonly faultPoint?: BossStoreFaultPoint;
  constructor(path: string, message: string, cause: unknown, faultPoint?: BossStoreFaultPoint) {
    super(`Boss Controller store commit did not take effect at ${path}: ${message}`, {
      cause: cause instanceof Error ? cause : undefined,
    });
    this.name = "BossStoreCommitError";
    this.faultPoint = faultPoint;
  }
}

type LoadedState = { state: BossControllerStateV1; bytes: Buffer };

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function validateClockTimestamp(value: string): string {
  const millis = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || Number.isNaN(millis) || new Date(millis).toISOString() !== value) {
    throw new BossStoreError(`BossStore now() returned a non-canonical timestamp: ${String(value)}`);
  }
  return value;
}

function validateEntityId(value: string): string {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/.test(value)) {
    throw new BossStoreError("query id must be a bounded ASCII identifier");
  }
  return value;
}

function immutableAuditPrefix(previous: BossControllerStateV1, next: BossControllerStateV1): void {
  if (next.audit.length <= previous.audit.length) {
    throw new BossValidationError("$.audit", "each committed revision must append at least one audit entry");
  }
  for (let index = 0; index < previous.audit.length; index += 1) {
    if (canonicalBossJson(previous.audit[index]) !== canonicalBossJson(next.audit[index])) {
      throw new BossValidationError(`$.audit[${index}]`, "audit history is append-only and immutable");
    }
  }
}

function entityMap<T>(items: readonly T[], idOf: (item: T) => string): Map<string, T> {
  return new Map(items.map((item) => [idOf(item), item]));
}

function assertFieldsImmutable(previous: Record<string, unknown>, next: Record<string, unknown>, fields: readonly string[], path: string): void {
  for (const field of fields) {
    if (canonicalBossJson(previous[field]) !== canonicalBossJson(next[field])) throw new BossValidationError(`${path}.${field}`, "is immutable after insertion");
  }
}

function validateProtectedEntityTransitions(previous: BossControllerStateV1, next: BossControllerStateV1): void {
  const nextGoals = entityMap(next.goalRevisions, (item) => item.goalRevisionId);
  for (const old of previous.goalRevisions) {
    const current = nextGoals.get(old.goalRevisionId);
    if (!current) throw new BossValidationError("$.goalRevisions", `cannot remove ${old.goalRevisionId}`);
    assertFieldsImmutable(old as unknown as Record<string, unknown>, current as unknown as Record<string, unknown>, ["version", "goalRevisionId", "bossRunId", "revision", "parentGoalRevisionId", "objective", "acceptanceCriteria", "createdByParticipantId", "createdAt"], `$.goalRevisions[${old.goalRevisionId}]`);
    if (old.state !== "current" && current.state !== old.state) throw new BossValidationError(`$.goalRevisions[${old.goalRevisionId}].state`, "terminal goal revision state is immutable");
  }

  const nextEvidence = entityMap(next.evidenceRefs, (item) => item.evidenceRefId);
  for (const old of previous.evidenceRefs) {
    const current = nextEvidence.get(old.evidenceRefId);
    if (!current || canonicalBossJson(current) !== canonicalBossJson(old)) throw new BossValidationError(`$.evidenceRefs[${old.evidenceRefId}]`, "captured evidence is immutable; create a new content-bound evidence reference");
  }

  const nextProofs = entityMap(next.proofManifests, (item) => item.proofManifestId);
  for (const old of previous.proofManifests) {
    const current = nextProofs.get(old.proofManifestId);
    if (!current) throw new BossValidationError("$.proofManifests", `cannot remove ${old.proofManifestId}`);
    if (old.state !== "draft") {
      assertFieldsImmutable(old as unknown as Record<string, unknown>, current as unknown as Record<string, unknown>, ["version", "proofManifestId", "bossRunId", "goalRevisionId", "producerParticipantId", "proofClass", "evidenceRefIds", "sourceRevision", "baseRevision", "integrationRevision", "profileDigest", "configDigest", "createdAt", "submittedAt"], `$.proofManifests[${old.proofManifestId}]`);
      if (old.state === "invalidated" && canonicalBossJson(current) !== canonicalBossJson(old)) throw new BossValidationError(`$.proofManifests[${old.proofManifestId}]`, "invalidated proof is immutable");
      if (old.state === "submitted" && current.state !== "submitted" && current.state !== "invalidated") throw new BossValidationError(`$.proofManifests[${old.proofManifestId}].state`, "submitted proof may only remain submitted or become invalidated");
    }
  }

  const nextApprovals = entityMap(next.approvals, (item) => item.approvalId);
  for (const old of previous.approvals) {
    const current = nextApprovals.get(old.approvalId);
    if (!current) throw new BossValidationError("$.approvals", `cannot remove ${old.approvalId}`);
    assertFieldsImmutable(old as unknown as Record<string, unknown>, current as unknown as Record<string, unknown>, ["version", "approvalId", "bossRunId", "goalRevisionId", "proofManifestId", "createdAt"], `$.approvals[${old.approvalId}]`);
    if (old.decidedAt !== null) assertFieldsImmutable(old as unknown as Record<string, unknown>, current as unknown as Record<string, unknown>, ["decidedByParticipantId", "decidedAt"], `$.approvals[${old.approvalId}]`);
    if (old.state !== "pending" && current.state === old.state && canonicalBossJson(current) !== canonicalBossJson(old)) throw new BossValidationError(`$.approvals[${old.approvalId}]`, "decided approval is immutable unless explicitly invalidated");
    if (old.state === "invalidated" && canonicalBossJson(current) !== canonicalBossJson(old)) throw new BossValidationError(`$.approvals[${old.approvalId}]`, "invalidated approval is immutable");
    if ((old.state === "approved" || old.state === "rejected") && current.state !== old.state && current.state !== "invalidated") throw new BossValidationError(`$.approvals[${old.approvalId}].state`, "decided approval may only retain its decision or become invalidated");
  }

  const nextAuthority = entityMap(next.authorityTransitions, (item) => item.authorityTransitionId);
  const brokerRank = { unprepared: 0, prepared: 1, committed: 2, aborted: 2 } as const;
  const projectionRank = { intent_recorded: 0, broker_prepared: 1, projected: 2, reconciled: 3, aborted: 3, poisoned: 3 } as const;
  for (const old of previous.authorityTransitions) {
    const current = nextAuthority.get(old.authorityTransitionId);
    if (!current) throw new BossValidationError("$.authorityTransitions", `cannot remove ${old.authorityTransitionId}`);
    assertFieldsImmutable(old as unknown as Record<string, unknown>, current as unknown as Record<string, unknown>, ["version", "authorityTransitionId", "bossRunId", "operation", "targetKind", "targetId", "idempotencyKey", "expectedBrokerRevision", "priorControllerGeneration", "resultingControllerGeneration", "priorBindingEpoch", "resultingBindingEpoch", "createdAt"], `$.authorityTransitions[${old.authorityTransitionId}]`);
    if (["reconciled", "aborted", "poisoned"].includes(old.projectionState)) {
      if (canonicalBossJson(current) !== canonicalBossJson(old)) throw new BossValidationError(`$.authorityTransitions[${old.authorityTransitionId}]`, "terminal authority projection is immutable");
      continue;
    }
    if (brokerRank[current.brokerState] < brokerRank[old.brokerState] || projectionRank[current.projectionState] < projectionRank[old.projectionState]) throw new BossValidationError(`$.authorityTransitions[${old.authorityTransitionId}]`, "authority projection cannot regress");
    if (old.brokerState === "committed" && current.brokerState !== "committed") throw new BossValidationError(`$.authorityTransitions[${old.authorityTransitionId}].brokerState`, "committed broker transition is immutable");
    for (const field of ["brokerRevision", "prepareTokenDigest", "preparedAt", "committedAt", "abortedAt", "abortReason"] as const) {
      if (old[field] !== null && canonicalBossJson(current[field]) !== canonicalBossJson(old[field])) throw new BossValidationError(`$.authorityTransitions[${old.authorityTransitionId}].${field}`, "authority data is immutable once populated");
    }
  }
}

function validateStateTransition(previous: BossControllerStateV1, next: BossControllerStateV1): void {
  if (next.version !== BOSS_CONTROLLER_STORE_VERSION) throw new BossSchemaVersionError("$.version", next.version, BOSS_CONTROLLER_STORE_VERSION);
  if (next.storeId !== previous.storeId) throw new BossValidationError("$.storeId", "is immutable");
  if (next.run.bossRunId !== previous.run.bossRunId) throw new BossValidationError("$.run.bossRunId", "is immutable");
  if (next.run.controllerPrincipalId !== previous.run.controllerPrincipalId) throw new BossValidationError("$.run.controllerPrincipalId", "is immutable; Controller replacement uses a new run authority protocol");
  if (next.createdAt !== previous.createdAt || next.run.createdAt !== previous.run.createdAt) throw new BossValidationError("$.createdAt", "is immutable");
  if (next.revision !== previous.revision + 1) throw new BossValidationError("$.revision", "must advance exactly once per commit");
  if (Date.parse(next.updatedAt) < Date.parse(previous.updatedAt)) throw new BossValidationError("$.updatedAt", "must be monotonic");
  immutableAuditPrefix(previous, next);
  validateProtectedEntityTransitions(previous, next);

  if (next.controllerGeneration < previous.controllerGeneration) throw new BossValidationError("$.controllerGeneration", "must never decrease");
  if (next.controllerGeneration === previous.controllerGeneration) {
    if (next.controllerAuthorityTransitionId !== previous.controllerAuthorityTransitionId) throw new BossValidationError("$.controllerAuthorityTransitionId", "cannot change without a Controller generation increment");
    return;
  }
  if (next.controllerGeneration !== previous.controllerGeneration + 1) throw new BossValidationError("$.controllerGeneration", "must advance exactly once through a takeover");
  if (next.controllerAuthorityTransitionId === previous.controllerAuthorityTransitionId) throw new BossValidationError("$.controllerAuthorityTransitionId", "generation increment requires a new authority transition");
  if (previous.authorityTransitions.some((entry) => entry.authorityTransitionId === next.controllerAuthorityTransitionId)) throw new BossValidationError("$.controllerAuthorityTransitionId", "takeover transition must be newly projected in this commit");
  const takeover = next.authorityTransitions.find((entry) => entry.authorityTransitionId === next.controllerAuthorityTransitionId);
  if (!takeover || takeover.operation !== "controller_takeover" || takeover.priorControllerGeneration !== previous.controllerGeneration || takeover.resultingControllerGeneration !== next.controllerGeneration || takeover.brokerState !== "committed" || takeover.projectionState !== "reconciled") {
    throw new BossValidationError("$.controllerAuthorityTransitionId", "generation may advance only through the matching newly committed and reconciled takeover transition");
  }
}

/**
 * Durable per-run Controller state. This class stores projections only: it has no command,
 * participant-launch, delivery, or `/boss` activation surface.
 */
const BOSS_STORE_INSTANCES = new WeakSet<object>();

/** True only for instances constructed by this exact BossStore module. */
export function isBossStore(value: unknown): value is BossStore {
  return typeof value === "object" && value !== null && BOSS_STORE_INSTANCES.has(value);
}

export class BossStore {
  readonly path: string;
  readonly poisonPath: string;
  readonly lockPath: string;
  private readonly faultInjector?: BossStoreOptions["faultInjector"];
  private readonly now: () => string;
  private readonly lockTimeoutMs: number;
  private readonly lockPollMs: number;
  private readonly staleLockMs: number;
  private queue: Promise<unknown> = Promise.resolve();
  private localPoison: BossStorePoisonedError | undefined;

  constructor(path: string, options: BossStoreOptions = {}) {
    if (typeof path !== "string" || path.length === 0) throw new BossStoreError("BossStore path must be a non-empty string");
    BOSS_STORE_INSTANCES.add(this);
    this.path = path;
    this.poisonPath = `${path}.poison`;
    this.lockPath = `${path}.lock`;
    this.faultInjector = options.faultInjector;
    this.now = options.now ?? (() => new Date().toISOString());
    this.lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
    this.lockPollMs = options.lockPollMs ?? 20;
    this.staleLockMs = options.staleLockMs ?? 120_000;
    if (!Number.isSafeInteger(this.lockTimeoutMs) || this.lockTimeoutMs < 1 || !Number.isSafeInteger(this.lockPollMs) || this.lockPollMs < 1 || !Number.isSafeInteger(this.staleLockMs) || this.staleLockMs < 1) {
      throw new BossStoreError("BossStore lock timing options must be positive safe integers");
    }
  }

  private async ensureDirectory(): Promise<void> {
    const directory = dirname(this.path);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new BossStoreError(`Could not create Boss Controller state directory ${directory}`, { cause: error instanceof Error ? error : undefined });
    }
  }

  private async readPoisonMarker(): Promise<void> {
    if (this.localPoison) throw this.localPoison;
    try {
      const marker = await readFile(this.poisonPath, "utf8");
      throw new BossStorePoisonedError(this.path, this.poisonPath, marker.slice(0, 512));
    } catch (error) {
      if (isMissing(error)) return;
      if (error instanceof BossStorePoisonedError) {
        this.localPoison = error;
        throw error;
      }
      throw new BossStorePoisonedError(this.path, this.poisonPath, "unreadable poison marker", error);
    }
  }

  private async writePoisonMarker(detail: Record<string, unknown>, cause?: unknown): Promise<BossStorePoisonedError> {
    await this.ensureDirectory();
    const marker = `${JSON.stringify({
      version: "orc.boss-store-poison.v1",
      path: this.path,
      poisonedAt: validateClockTimestamp(this.now()),
      ...detail,
    })}\n`;
    let handle;
    try {
      handle = await open(this.poisonPath, "wx", 0o600);
      await handle.writeFile(marker, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await syncDirectory(dirname(this.path));
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        const poisoned = new BossStorePoisonedError(this.path, this.poisonPath, "ambiguous state and poison marker persistence failed", error);
        this.localPoison = poisoned;
        return poisoned;
      }
    }
    const poisoned = new BossStorePoisonedError(this.path, this.poisonPath, String(detail.reason ?? "ambiguous persistence outcome"), cause);
    this.localPoison = poisoned;
    return poisoned;
  }

  private async quarantine(bytes: Buffer, cause: unknown): Promise<never> {
    const quarantineDirectory = join(dirname(this.path), ".quarantine");
    await mkdir(quarantineDirectory, { recursive: true, mode: 0o700 });
    const quarantinePath = join(quarantineDirectory, `${basename(this.path)}.${sha256(bytes)}.corrupt`);
    let handle;
    try {
      handle = await open(quarantinePath, "wx", 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await syncDirectory(quarantineDirectory);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw await this.writePoisonMarker({ reason: "corrupt state could not be quarantined", observedDigest: sha256(bytes) }, error);
      }
    }
    const corrupt = new BossStoreCorruptError(this.path, quarantinePath, cause);
    await this.writePoisonMarker({ reason: corrupt.message, observedDigest: sha256(bytes), quarantinePath }, cause);
    throw corrupt;
  }

  private async load(): Promise<LoadedState> {
    await this.readPoisonMarker();
    let bytes: Buffer;
    try {
      bytes = await readFile(this.path);
    } catch (error) {
      if (isMissing(error)) throw new BossStoreNotFoundError(this.path);
      throw new BossStoreError(`Could not read Boss Controller store ${this.path}`, { cause: error instanceof Error ? error : undefined });
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      return this.quarantine(bytes, error);
    }
    try {
      return { state: parseBossControllerState(decoded), bytes };
    } catch (error) {
      if (error instanceof BossSchemaVersionError || error instanceof BossUnsupportedFeatureError) {
        throw new BossStoreUnsupportedError(this.path, error);
      }
      return this.quarantine(bytes, error);
    }
  }

  async read(): Promise<BossControllerStateV1> {
    const loaded = await this.load();
    return detachedBossSnapshot(loaded.state);
  }

  private async acquireLockMutationGuard(startedAt?: number): Promise<() => Promise<void>> {
    const remainingMs = startedAt === undefined ? undefined : this.lockTimeoutMs - (Date.now() - startedAt);
    if (remainingMs !== undefined && remainingMs <= 0) throw new BossStoreError(`Timed out waiting for Boss Controller lock mutation guard ${this.lockPath}.reclaim`);
    try {
      return await acquireKernelFileLock(`${this.lockPath}.reclaim`, remainingMs);
    } catch (error) {
      throw new BossStoreError(`Could not acquire Boss Controller lock mutation guard ${this.lockPath}.reclaim`, { cause: error instanceof Error ? error : undefined });
    }
  }

  private async acquireLock(): Promise<{ token: string; release: () => Promise<void> }> {
    await this.ensureDirectory();
    const token = randomUUID();
    const startedAt = Date.now();
    while (Date.now() - startedAt < this.lockTimeoutMs) {
      const releaseGuard = await this.acquireLockMutationGuard(startedAt);
      let acquired = false;
      let created = false;
      let handle;
      try {
        try {
          handle = await open(this.lockPath, "wx", 0o600);
          created = true;
          const owner = `${JSON.stringify({ version: "orc.boss-store-lock.v1", pid: process.pid, token, createdAt: validateClockTimestamp(this.now()) })}\n`;
          await handle.writeFile(owner, "utf8");
          await handle.sync();
          await handle.close();
          handle = undefined;
          await syncDirectory(dirname(this.path));
          acquired = true;
        } catch (error) {
          await handle?.close().catch(() => undefined);
          handle = undefined;
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            if (created) await unlink(this.lockPath).catch((cleanupError) => { if (!isMissing(cleanupError)) throw cleanupError; });
            throw new BossStoreError(`Could not acquire Boss Controller store lock ${this.lockPath}`, { cause: error instanceof Error ? error : undefined });
          }
        }
        if (!acquired) {
          try {
            const [ownerText, lockStat] = await Promise.all([readFile(this.lockPath, "utf8"), stat(this.lockPath)]);
            let ownerPid: number | undefined;
            try {
              const owner = JSON.parse(ownerText) as { pid?: unknown };
              if (Number.isSafeInteger(owner.pid) && (owner.pid as number) > 0) ownerPid = owner.pid as number;
            } catch {
              // A lock creator cannot be writing while this mutation guard is held; age remains the fail-closed fallback for a prior crash.
            }
            const stale = Date.now() - lockStat.mtimeMs > this.staleLockMs;
            if ((ownerPid !== undefined && !processAlive(ownerPid)) || (ownerPid === undefined && stale)) {
              await unlink(this.lockPath);
              await syncDirectory(dirname(this.path));
            }
          } catch (error) {
            if (!isMissing(error)) throw error;
          }
        }
      } finally {
        await releaseGuard();
      }
      if (acquired) {
        return {
          token,
          release: async () => {
            // Releasing an owned lock must not time out: abandoning it while this
            // process remains alive would make every future caller treat it as live.
            const releaseMutationGuard = await this.acquireLockMutationGuard();
            try {
              let current: { token?: unknown };
              try {
                current = JSON.parse(await readFile(this.lockPath, "utf8")) as { token?: unknown };
              } catch (error) {
                throw await this.writePoisonMarker({ reason: "owned lock disappeared or became unreadable", lockToken: token }, error);
              }
              if (current.token !== token) throw await this.writePoisonMarker({ reason: "owned lock token changed", lockToken: token });
              await unlink(this.lockPath);
              await syncDirectory(dirname(this.path));
            } finally {
              await releaseMutationGuard();
            }
          },
        };
      }
      await delay(this.lockPollMs);
    }
    throw new BossStoreError(`Timed out waiting for Boss Controller store lock ${this.lockPath}`);
  }

  private async cleanupStaleTemps(): Promise<void> {
    const directory = dirname(this.path);
    const prefix = `.${basename(this.path)}.tmp.`;
    let changed = false;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.startsWith(prefix)) {
        await unlink(join(directory, entry.name));
        changed = true;
      }
    }
    if (changed) await syncDirectory(directory);
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.queue.catch(() => undefined).then(operation);
    this.queue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async underLock<T>(operation: () => Promise<T>): Promise<T> {
    return this.serialized(async () => {
      await this.readPoisonMarker();
      const lock = await this.acquireLock();
      try {
        await this.readPoisonMarker();
        await this.cleanupStaleTemps();
        return await operation();
      } finally {
        await lock.release();
      }
    });
  }

  private async inject(point: BossStoreFaultPoint, context: BossStoreFaultContext): Promise<void> {
    await this.faultInjector?.(point, context);
  }

  private async readBytesIfPresent(): Promise<Buffer | null> {
    try {
      return await readFile(this.path);
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  private async persist(previous: LoadedState | null, next: BossControllerStateV1): Promise<void> {
    const directory = dirname(this.path);
    const tempPath = join(directory, `.${basename(this.path)}.tmp.${process.pid}.${randomUUID()}`);
    const nextBytes = Buffer.from(`${canonicalBossJson(next)}\n`, "utf8");
    const context: BossStoreFaultContext = {
      path: this.path,
      tempPath,
      previousRevision: previous?.state.revision ?? null,
      attemptedRevision: next.revision,
    };
    let handle;
    let lastPoint: BossStoreFaultPoint | undefined;
    try {
      handle = await open(tempPath, "wx", 0o600);
      lastPoint = "before_temp_write";
      await this.inject(lastPoint, context);
      await handle.writeFile(nextBytes);
      lastPoint = "after_temp_write";
      await this.inject(lastPoint, context);
      await handle.sync();
      lastPoint = "after_temp_fsync";
      await this.inject(lastPoint, context);
      await handle.close();
      handle = undefined;
      lastPoint = "before_rename";
      await this.inject(lastPoint, context);
      await rename(tempPath, this.path);
      lastPoint = "after_rename";
      await this.inject(lastPoint, context);
      await syncDirectory(directory);
      lastPoint = "after_directory_fsync";
      await this.inject(lastPoint, context);
      return;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      let observed: Buffer | null;
      try {
        observed = await this.readBytesIfPresent();
      } catch (readError) {
        throw await this.writePoisonMarker({
          reason: "persistence fault could not be reconciled",
          previousDigest: previous ? sha256(previous.bytes) : null,
          attemptedDigest: sha256(nextBytes),
          faultPoint: lastPoint ?? null,
        }, readError);
      }
      if (observed !== null && observed.equals(nextBytes)) {
        await syncDirectory(directory).catch(async (syncError) => {
          throw await this.writePoisonMarker({ reason: "committed state could not be directory-fsynced", attemptedDigest: sha256(nextBytes), faultPoint: lastPoint ?? null }, syncError);
        });
        await unlink(tempPath).catch((unlinkError) => { if (!isMissing(unlinkError)) throw unlinkError; });
        return;
      }
      const unchanged = previous === null ? observed === null : observed !== null && observed.equals(previous.bytes);
      if (unchanged) {
        await unlink(tempPath).catch((unlinkError) => { if (!isMissing(unlinkError)) throw unlinkError; });
        throw new BossStoreCommitError(this.path, "the previous durable revision was preserved", error, lastPoint);
      }
      throw await this.writePoisonMarker({
        reason: "persistence result matches neither the previous nor attempted revision",
        previousDigest: previous ? sha256(previous.bytes) : null,
        attemptedDigest: sha256(nextBytes),
        observedDigest: observed ? sha256(observed) : null,
        faultPoint: lastPoint ?? null,
      }, error);
    }
  }

  async create(initial: BossControllerStateV1): Promise<BossControllerStateV1> {
    const parsed = parseBossControllerState(initial);
    if (parsed.revision !== 1) throw new BossValidationError("$.revision", "new stores start at revision 1");
    if (parsed.audit.length === 0 || parsed.audit[0].action !== "store.created") throw new BossValidationError("$.audit[0].action", "new stores require store.created");
    return this.underLock(async () => {
      try {
        await readFile(this.path);
        throw new BossStoreAlreadyExistsError(this.path);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      await this.persist(null, parsed);
      return detachedBossSnapshot(parsed);
    });
  }

  async compareAndSwap(expectedRevision: number, replacement: BossControllerStateV1): Promise<BossControllerStateV1> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new BossStoreError("expectedRevision must be a positive safe integer");
    const parsed = parseBossControllerState(replacement);
    return this.underLock(async () => {
      const current = await this.load();
      if (current.state.revision !== expectedRevision) throw new BossStoreConflictError(expectedRevision, current.state.revision);
      validateStateTransition(current.state, parsed);
      await this.persist(current, parsed);
      return detachedBossSnapshot(parsed);
    });
  }

  async transaction(
    expectedRevision: number,
    mutate: (draft: BossControllerStateV1) => void | Promise<void>,
  ): Promise<BossControllerStateV1> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new BossStoreError("expectedRevision must be a positive safe integer");
    if (typeof mutate !== "function") throw new BossStoreError("transaction mutate callback is required");
    return this.underLock(async () => {
      const current = await this.load();
      if (current.state.revision !== expectedRevision) throw new BossStoreConflictError(expectedRevision, current.state.revision);
      const draft = detachedBossSnapshot(current.state);
      await mutate(draft);
      draft.revision = current.state.revision + 1;
      draft.updatedAt = validateClockTimestamp(this.now());
      const next = parseBossControllerState(draft);
      validateStateTransition(current.state, next);
      await this.persist(current, next);
      return detachedBossSnapshot(next);
    });
  }

  async query<K extends BossEntityKind>(kind: K, entityId?: string): Promise<Array<BossEntityByKind[K]>> {
    const state = await this.read();
    const values = (kind === "run" ? [state.run] : state[kind]) as Array<BossEntityByKind[K]>;
    const filtered = entityId === undefined ? values : values.filter((value) => bossEntityId(kind, value) === validateEntityId(entityId));
    return detachedBossSnapshot(filtered);
  }
}

Object.freeze(BossStore.prototype);

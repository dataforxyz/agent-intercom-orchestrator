export type Harness = "pi" | "codex" | "claude" | "opencode";
export type WorkerBackend = "systemd";
export type LegacyWorkerState =
  | "provisioning"
  | "running"
  | "idle"
  | "needs_attention"
  | "completed"
  | "failed"
  | "stopping"
  | "stopped"
  | "lost";

/** The participant lifecycle vocabulary persisted by WorkerStore v2 and v3. */
export type CanonicalWorkerState =
  | "provisioning"
  | "registering"
  | "ready"
  | "working"
  | "waiting"
  | "paused"
  | "stalled"
  | "blocked"
  | "failed"
  | "lost"
  | "unreachable"
  | "stopped";

/**
 * `migration_pending` is deliberately not a participant lifecycle state. It is
 * a read-only store record used while a legacy `stopping` process is reconciled.
 * Legacy members remain in this compatibility union until all callers use the
 * canonical lifecycle vocabulary.
 */
export type WorkerState = LegacyWorkerState | CanonicalWorkerState | "migration_pending";

export type ManagerOwnerKind = "pi" | "opencode" | "headless_cli";

interface ManagerOwnerBindingBase {
  principalId: string;
  sessionId: string;
  bindingEpoch: number;
}

export interface PiManagerOwnerBinding extends ManagerOwnerBindingBase {
  context: "pi";
}

export interface OpenCodeManagerOwnerBinding extends ManagerOwnerBindingBase {
  context: "opencode";
}

export interface HeadlessCliManagerOwnerBinding extends ManagerOwnerBindingBase {
  context: "headless_cli";
}

/** Exact owning Manager recipient and authority binding for one worker. */
export type ManagerOwnerBinding =
  | PiManagerOwnerBinding
  | OpenCodeManagerOwnerBinding
  | HeadlessCliManagerOwnerBinding;

export type WorkerTerminalOutcome = "completed";

export interface WorkerMigrationOutcomeAudit {
  stoppedAt?: number;
  stopReason?: string;
  dirtyAtStop?: boolean;
  dirtyStatusAtStop?: string;
  dirtyCheckErrorAtStop?: string;
  lastError?: string;
  terminalOutcome?: WorkerTerminalOutcome;
}

export interface WorkerMigrationAudit {
  sourceVersion: 1;
  migratedAt: number;
  originalState: LegacyWorkerState;
  originalRunId: string;
  mappedState: CanonicalWorkerState | "migration_pending";
  originalOutcome: WorkerMigrationOutcomeAudit;
  managerOwnerInferredFromLegacySession: true;
  requiresReadinessReconciliation?: true;
  legacyIdleHint?: true;
  dispatchDenied?: true;
  reconcileBy?: number;
  resolvedAt?: number;
  resolution?: "stopped" | "failed" | "lost" | "unreachable";
}

export type Effort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type WorkspacePolicy = "host" | "read-only" | "read-write";
export type GitPolicy = "full" | "read-only";

export interface PermissionProfile {
  description?: string;
  workspace: WorkspacePolicy;
  git: GitPolicy;
  hardened?: boolean;
  piTools?: string[];
  inaccessiblePaths?: string[];
  writablePaths?: string[];
  environment?: Record<string, string>;
  systemdProperties?: Record<string, string>;
}

export interface LaunchProfile {
  harness: Harness;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  spawnable?: boolean;
  description?: string;
  mode?: "persistent" | "one-shot";
  maxRuntime?: string;
}

export interface RolePreset {
  harness?: Harness;
  profile?: string;
  permissionProfile?: string;
  model?: string;
  effort?: Effort;
  instructions?: string;
}

export type BossBaselineRole = "manager" | "worker" | "scout" | "adversary";

export interface BossRolePreference {
  model?: string;
  effort?: Effort;
}

export interface BossOnboardingRecord {
  version: "orc.boss-onboarding.v1";
  completedAt: string;
}

export interface BossConfig {
  roles: Partial<Record<BossBaselineRole, BossRolePreference>>;
  handlePrefix: string;
  onboarding?: BossOnboardingRecord;
}

export interface ModelRoutingRule {
  harness: Harness;
  /** Exact model identifiers or prefix patterns ending in one `*`. */
  patterns: string[];
}

export interface ModelRoutingConfig {
  /** Direct harness used when an explicit model does not match any configured rule; null preserves normal role routing. */
  unmatchedHarness: Harness | null;
  /** Ordered rules; the first matching pattern wins. */
  rules: ModelRoutingRule[];
  /** Literal provider prefixes removed before invoking a direct harness CLI. */
  stripPrefixes: Partial<Record<Harness, string[]>>;
}

export interface RoleRequirement {
  requiresSubagents?: boolean;
}

export interface RoutingConfig {
  /** Base automatic-routing order after role and legacy default preferences. */
  preference: Harness[];
  /** Harnesses that may only be selected by an explicit harness/profile/model override. */
  explicitOnly: Harness[];
  /** Per-role automatic-routing preferences. */
  roles: Record<string, Harness[]>;
  /** Ordered spawnable-profile preferences for each harness. */
  profilePreferences: Partial<Record<Harness, string[]>>;
  /** Default capability requirements applied when the caller does not specify them. */
  roleRequirements: Record<string, RoleRequirement>;
  modelRouting: ModelRoutingConfig;
  fallback: {
    /** Keep portable role instructions when automatic routing changes harnesses. */
    preserveRoleInstructions: boolean;
  };
  capabilities: {
    /** Harnesses able to delegate work to nested subagents. */
    requiresSubagents: Harness[];
  };
}

export type SupervisionConfig = Record<string, never>;

export interface OrchestratorConfig {
  defaultHarness: Harness;
  defaultProfiles: Partial<Record<Harness, string>>;
  defaultModels: Partial<Record<Harness, string>>;
  defaultEfforts: Partial<Record<Harness, Effort>>;
  profiles: Record<string, LaunchProfile>;
  permissionProfiles: Record<string, PermissionProfile>;
  roles: Record<string, RolePreset>;
  boss: BossConfig;
  routing: RoutingConfig;
  supervision: SupervisionConfig;
  leaseMinutes: number;
  heartbeatSeconds: number;
  maxRuntime: string;
  stopTimeoutSeconds: number;
  idleTimeoutMinutes: number;
  checkpointWarningMinutes: number;
  checkpointRetryMinutes: number;
  cleanupGraceMinutes: number;
  cleanupTimerMinutes: number;
  cleanupTimerEnabled: boolean;
  cleanupExpiredOnStart: boolean;
  cleanupOnShutdown: boolean;
  recentStoppedWorkerHours: number;
  stoppedWorkerRetentionDays: number;
  dirtyStoppedWorkerRetentionDays: number;
  orphanRuntimeRetentionMinutes: number;
  pruneStoppedWorkersOnCleanup: boolean;
  pruneRuntimeCachesOnStop: boolean;
}

export interface WorkerRecord {
  id: string;
  /** @deprecated Use workerIncarnationId. This remains a lossless API alias during migration. */
  runId: string;
  workerIncarnationId?: string;
  workerGeneration?: number;
  bossRunId?: string;
  harness: Harness;
  backend: WorkerBackend;
  role: string;
  task: string;
  cwd: string;
  profile?: string;
  permissionProfile?: string;
  model?: string;
  effort?: Effort;
  instructions?: string;
  state: WorkerState;
  stateReason?: string;
  terminalOutcome?: WorkerTerminalOutcome;
  owned: boolean;
  /** @deprecated Use managerOwner.sessionId. */
  managerSessionId: string;
  managerOwner?: ManagerOwnerBinding;
  migrationAudit?: WorkerMigrationAudit;
  intercomTarget?: string;
  unit?: string;
  mainPid?: number;
  externalSessionId?: string;
  healthPath?: string;
  runtimeStatePath?: string;
  createdAt: number;
  updatedAt: number;
  leaseExpiresAt: number;
  lastWorkerActivityAt?: number;
  /** Exact inbound worker Intercom activity after sender/owner verification. */
  lastAuthenticatedIntercomActivityAt?: number;
  idleDeadlineAt?: number;
  checkpointRequestedAt?: number;
  checkpointLastAttemptAt?: number;
  checkpointAttemptCount?: number;
  checkpointDeadlineAt?: number;
  /** Durable stop intent fences a queued unit that materializes after stop. */
  stopRequestedAt?: number;
  stoppedAt?: number;
  stopReason?: string;
  dirtyAtStop?: boolean;
  dirtyStatusAtStop?: string;
  dirtyCheckErrorAtStop?: string;
  lastError?: string;
  backendDetails?: unknown;
}

/** Canonical legacy-v2 record. The authenticated activity field did not exist in this schema. */
export interface WorkerRecordV2 extends Omit<WorkerRecord, "lastAuthenticatedIntercomActivityAt"> {
  workerIncarnationId: string;
  workerGeneration: number;
  state: CanonicalWorkerState | "migration_pending";
  managerOwner: ManagerOwnerBinding;
}

/** WorkerStore v3 is the first schema that authenticates the Intercom activity timestamp. */
export interface WorkerRecordV3 extends WorkerRecord {
  workerIncarnationId: string;
  workerGeneration: number;
  state: CanonicalWorkerState | "migration_pending";
  managerOwner: ManagerOwnerBinding;
}

export interface RuntimeCleanupClaim {
  token: string;
  workerId: string;
  runId?: string;
  terminalAt?: number;
  unit?: string;
  action: "cache" | "full" | "orphan";
  claimedAt: number;
  ownerPid: number;
  phase: "claimed" | "moving" | "moved" | "deleting";
  pathIndexes: number[];
}

export interface WorkerGenerationLedgerEntry {
  workerId: string;
  /** Highest generation ever committed for this worker id, including forgotten records. */
  generation: number;
}

export interface WorkerStateFile {
  /** Versions 1 and 2 are accepted only as compatibility inputs and explicit migration sources. */
  version: 1 | 2 | 3;
  /** Monotonic compare-and-swap generation. Required for version 2 and canonical version 3 snapshots. */
  generation?: number;
  workers: WorkerRecord[];
  /** Durable anti-reuse ledger. Version 2 and canonical version 3 snapshots always include it. */
  workerGenerations?: WorkerGenerationLedgerEntry[];
  runtimeCleanupClaims?: RuntimeCleanupClaim[];
  /** Active schema features; an unsupported feature prevents reads and mutations. */
  activeFeatures?: string[];
}

/** Legacy version-2 snapshot accepted only for explicit migration. */
export interface WorkerStateFileV2 extends WorkerStateFile {
  version: 2;
  generation: number;
  workers: WorkerRecordV2[];
  workerGenerations: WorkerGenerationLedgerEntry[];
}

/** Exact canonical snapshot returned by WorkerStore reads. */
export interface WorkerStateFileV3 extends WorkerStateFile {
  version: 3;
  generation: number;
  workers: WorkerRecordV3[];
  workerGenerations: WorkerGenerationLedgerEntry[];
}

export interface LegacyWorkerStateFileV1 extends WorkerStateFile {
  version: 1;
  generation?: never;
  activeFeatures?: never;
}

export interface UnitStatus {
  /** Whether systemd returned an authoritative snapshot. */
  verified?: boolean;
  exists: boolean;
  activeState?: string;
  subState?: string;
  mainPid?: number;
  result?: string;
  execMainStatus?: number;
  /** Non-empty while systemd still has a queued job for the unit. */
  job?: string;
  activeEnterTimestampMonotonic?: number;
  inactiveEnterTimestampMonotonic?: number;
  execMainStartTimestampMonotonic?: number;
  error?: string;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
  killed?: boolean;
}

export interface CommandRunner {
  exec(
    command: string,
    args: string[],
    options?: { signal?: AbortSignal; timeout?: number },
  ): Promise<CommandResult>;
}

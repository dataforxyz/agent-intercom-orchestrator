export type Harness = "pi" | "codex" | "claude" | "opencode";
export type WorkerBackend = "systemd";
export type WorkerState =
  | "provisioning"
  | "running"
  | "idle"
  | "needs_attention"
  | "completed"
  | "failed"
  | "stopping"
  | "stopped"
  | "lost";

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

export interface OrchestratorConfig {
  defaultHarness: Harness;
  defaultProfiles: Partial<Record<Harness, string>>;
  defaultModels: Partial<Record<Harness, string>>;
  defaultEfforts: Partial<Record<Harness, Effort>>;
  profiles: Record<string, LaunchProfile>;
  permissionProfiles: Record<string, PermissionProfile>;
  roles: Record<string, RolePreset>;
  leaseMinutes: number;
  heartbeatSeconds: number;
  maxRuntime: string;
  stopTimeoutSeconds: number;
  idleTimeoutMinutes: number;
  checkpointWarningMinutes: number;
  checkpointRetryMinutes: number;
  cleanupGraceMinutes: number;
  terminalCacheRetentionMinutes: number;
  terminalRuntimeRetentionMinutes: number;
  orphanRuntimeRetentionMinutes: number;
  cleanupTimerMinutes: number;
  cleanupTimerEnabled: boolean;
  cleanupExpiredOnStart: boolean;
  cleanupOnShutdown: boolean;
}

export interface WorkerRecord {
  id: string;
  runId: string;
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
  owned: boolean;
  managerSessionId: string;
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
  idleDeadlineAt?: number;
  checkpointRequestedAt?: number;
  checkpointLastAttemptAt?: number;
  checkpointAttemptCount?: number;
  checkpointDeadlineAt?: number;
  stoppedAt?: number;
  stopReason?: string;
  dirtyAtStop?: boolean;
  dirtyStatusAtStop?: string;
  dirtyCheckErrorAtStop?: string;
  lastError?: string;
  backendDetails?: unknown;
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

export interface WorkerStateFile {
  version: 1;
  workers: WorkerRecord[];
  runtimeCleanupClaims?: RuntimeCleanupClaim[];
}

export interface UnitStatus {
  exists: boolean;
  activeState?: string;
  subState?: string;
  mainPid?: number;
  result?: string;
  execMainStatus?: number;
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

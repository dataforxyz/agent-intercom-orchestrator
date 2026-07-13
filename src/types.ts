export type Harness = "pi" | "codex" | "claude" | "opencode";
export type WorkerBackend = "systemd" | "pi-subagents";
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

export interface LaunchProfile {
  harness: Exclude<Harness, "pi">;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  spawnable?: boolean;
  description?: string;
}

export interface OrchestratorConfig {
  defaultHarness: Harness;
  defaultProfiles: Partial<Record<Exclude<Harness, "pi">, string>>;
  profiles: Record<string, LaunchProfile>;
  leaseMinutes: number;
  heartbeatSeconds: number;
  maxRuntime: string;
  stopTimeoutSeconds: number;
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
  state: WorkerState;
  owned: boolean;
  managerSessionId: string;
  intercomTarget?: string;
  unit?: string;
  mainPid?: number;
  externalRunId?: string;
  createdAt: number;
  updatedAt: number;
  leaseExpiresAt: number;
  lastError?: string;
  backendDetails?: unknown;
}

export interface WorkerStateFile {
  version: 1;
  workers: WorkerRecord[];
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

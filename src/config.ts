import { statSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { DEFAULT_PERMISSION_PROFILES } from "./permissions.ts";
import type { Effort, GitPolicy, Harness, LaunchProfile, OrchestratorConfig, PermissionProfile, RolePreset, WorkspacePolicy } from "./types.ts";

const HARNESSES: Harness[] = ["pi", "codex", "claude", "opencode"];
const EFFORTS: Effort[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function preferredLocalWrapper(name: string): string {
  const path = join(homedir(), ".local", "bin", name);
  try {
    if (statSync(path).isFile()) return path;
  } catch {
    // Fall back to PATH for normal global package installations.
  }
  return name;
}

export const DEFAULT_CONFIG: OrchestratorConfig = {
  defaultHarness: "pi",
  defaultProfiles: {
    pi: "pi-peer",
    codex: "codex-safe",
    claude: "claude-safe",
    opencode: "opencode-peer",
  },
  defaultModels: {},
  defaultEfforts: {},
  profiles: {
    "pi-peer": {
      harness: "pi",
      command: preferredLocalWrapper("pi"),
      args: ["--mode", "rpc", "--exclude-tools", "agent_fleet"],
      mode: "persistent",
      maxRuntime: "12h",
      description: "Independent wakeable Pi coworker with its own session and Intercom identity",
    },
    "codex-safe": {
      harness: "codex",
      command: preferredLocalWrapper("coi"),
      args: ["--no-tui", "--sandbox", "workspace-write", "--ask-for-approval", "on-request"],
      mode: "persistent",
      maxRuntime: "12h",
      description: "Wakeable Codex worker with a workspace-write sandbox",
    },
    "codex-minimal": {
      harness: "codex",
      command: preferredLocalWrapper("coim"),
      args: ["--no-tui"],
      mode: "persistent",
      maxRuntime: "12h",
      description: "Wakeable Codex worker using a locally configured minimal profile",
    },
    "claude-safe": {
      harness: "claude",
      command: preferredLocalWrapper("cci"),
      args: ["--safe"],
      mode: "persistent",
      maxRuntime: "12h",
      description: "Wakeable Claude Code worker with standard permission prompts",
    },
    "claude-minimal": {
      harness: "claude",
      command: preferredLocalWrapper("ccim"),
      args: ["--safe"],
      mode: "persistent",
      maxRuntime: "12h",
      description: "Wakeable minimal Claude Code worker",
    },
    "opencode-peer": {
      harness: "opencode",
      command: preferredLocalWrapper("opencode"),
      args: [],
      mode: "persistent",
      maxRuntime: "12h",
      description: "Wakeable OpenCode server coworker with a persistent session and Intercom identity",
    },
    "opencode-run": {
      harness: "opencode",
      command: preferredLocalWrapper("opencode"),
      args: ["run", "--auto", "--format", "json"],
      mode: "one-shot",
      maxRuntime: "2h",
      description: "One-shot OpenCode worker; the assignment is passed as its initial headless run prompt",
    },
  },
  permissionProfiles: structuredClone(DEFAULT_PERMISSION_PROFILES),
  roles: {
    advisor: {
      harness: "pi",
      profile: "pi-peer",
      permissionProfile: "review-readonly",
      effort: "high",
      instructions: "Act as an independent advisor coworker. Challenge plans, inspect evidence, surface tradeoffs, and do not edit files unless explicitly asked.",
    },
    builder: {
      harness: "codex",
      profile: "codex-safe",
      permissionProfile: "builder-restricted",
      effort: "high",
      instructions: "Implement the assigned scope and report verifiable evidence with completion claims.",
    },
    challenger: {
      harness: "claude",
      profile: "claude-safe",
      permissionProfile: "review-readonly",
      effort: "high",
      instructions: "Challenge completion claims, inspect the actual evidence, and identify missing proof or defects.",
    },
    researcher: {
      harness: "pi",
      profile: "pi-peer",
      permissionProfile: "review-readonly",
      effort: "medium",
      instructions: "Research the assigned question independently, cite concrete evidence, and report uncertainty clearly.",
    },
  },
  leaseMinutes: 30,
  heartbeatSeconds: 60,
  maxRuntime: "2h",
  stopTimeoutSeconds: 5,
  idleTimeoutMinutes: 60,
  checkpointWarningMinutes: 10,
  checkpointRetryMinutes: 5,
  cleanupGraceMinutes: 15,
  cleanupTimerMinutes: 15,
  cleanupTimerEnabled: true,
  cleanupExpiredOnStart: true,
  cleanupOnShutdown: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isHarness(value: unknown): value is Harness {
  return typeof value === "string" && HARNESSES.includes(value as Harness);
}

function isEffort(value: unknown): value is Effort {
  return typeof value === "string" && EFFORTS.includes(value as Effort);
}

function isWorkspacePolicy(value: unknown): value is WorkspacePolicy {
  return value === "host" || value === "read-only" || value === "read-write";
}

function isGitPolicy(value: unknown): value is GitPolicy {
  return value === "full" || value === "read-only";
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function mergeProfile(value: unknown): LaunchProfile | undefined {
  if (!isRecord(value) || !isHarness(value.harness) || typeof value.command !== "string") return undefined;
  const args = Array.isArray(value.args) && value.args.every((item) => typeof item === "string")
    ? value.args as string[]
    : undefined;
  const env = isRecord(value.env)
    ? Object.fromEntries(Object.entries(value.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : undefined;
  const mode = value.mode === "persistent" || value.mode === "one-shot" ? value.mode : undefined;
  return {
    harness: value.harness,
    command: value.command,
    ...(args ? { args } : {}),
    ...(env ? { env } : {}),
    ...(typeof value.spawnable === "boolean" ? { spawnable: value.spawnable } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(mode ? { mode } : {}),
    ...(typeof value.maxRuntime === "string" && value.maxRuntime.trim() ? { maxRuntime: value.maxRuntime.trim() } : {}),
  };
}

function mergePermissionProfile(value: unknown, fallback?: PermissionProfile): PermissionProfile | undefined {
  if (!isRecord(value)) return undefined;
  const workspace = isWorkspacePolicy(value.workspace) ? value.workspace : fallback?.workspace;
  const git = isGitPolicy(value.git) ? value.git : fallback?.git;
  if (!workspace || !git) return undefined;
  const strings = (input: unknown): string[] | undefined => Array.isArray(input) && input.every((item) => typeof item === "string")
    ? input as string[]
    : undefined;
  const record = (input: unknown): Record<string, string> | undefined => isRecord(input)
    ? Object.fromEntries(Object.entries(input).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : undefined;
  return {
    ...(fallback ?? {}),
    workspace,
    git,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(typeof value.hardened === "boolean" ? { hardened: value.hardened } : {}),
    ...(strings(value.piTools) ? { piTools: strings(value.piTools) } : {}),
    ...(strings(value.inaccessiblePaths) ? { inaccessiblePaths: strings(value.inaccessiblePaths) } : {}),
    ...(strings(value.writablePaths) ? { writablePaths: strings(value.writablePaths) } : {}),
    ...(record(value.environment) ? { environment: record(value.environment) } : {}),
    ...(record(value.systemdProperties) ? { systemdProperties: record(value.systemdProperties) } : {}),
  };
}

function mergeRole(value: unknown): RolePreset | undefined {
  if (!isRecord(value)) return undefined;
  return {
    ...(isHarness(value.harness) ? { harness: value.harness } : {}),
    ...(typeof value.profile === "string" ? { profile: value.profile } : {}),
    ...(typeof value.permissionProfile === "string" ? { permissionProfile: value.permissionProfile } : {}),
    ...(typeof value.model === "string" ? { model: value.model } : {}),
    ...(isEffort(value.effort) ? { effort: value.effort } : {}),
    ...(typeof value.instructions === "string" ? { instructions: value.instructions } : {}),
  };
}

function mergeHarnessStrings(
  value: unknown,
  fallback: Partial<Record<Harness, string>>,
): Partial<Record<Harness, string>> {
  const result = { ...fallback };
  if (!isRecord(value)) return result;
  for (const harness of HARNESSES) {
    if (typeof value[harness] === "string" && value[harness].trim()) result[harness] = value[harness].trim();
  }
  return result;
}

function mergeHarnessEfforts(
  value: unknown,
  fallback: Partial<Record<Harness, Effort>>,
): Partial<Record<Harness, Effort>> {
  const result = { ...fallback };
  if (!isRecord(value)) return result;
  for (const harness of HARNESSES) {
    if (isEffort(value[harness])) result[harness] = value[harness];
  }
  return result;
}

export function mergeConfig(value: unknown): OrchestratorConfig {
  if (!isRecord(value)) return structuredClone(DEFAULT_CONFIG);
  const profiles = structuredClone(DEFAULT_CONFIG.profiles);
  if (isRecord(value.profiles)) {
    for (const [name, profileValue] of Object.entries(value.profiles)) {
      const profile = mergeProfile(profileValue);
      if (profile) profiles[name] = profile;
    }
  }
  const permissionProfiles = structuredClone(DEFAULT_CONFIG.permissionProfiles);
  if (isRecord(value.permissionProfiles)) {
    for (const [name, permissionValue] of Object.entries(value.permissionProfiles)) {
      const permission = mergePermissionProfile(permissionValue, permissionProfiles[name]);
      if (permission) permissionProfiles[name] = permission;
    }
  }
  const roles = structuredClone(DEFAULT_CONFIG.roles);
  if (isRecord(value.roles)) {
    for (const [name, roleValue] of Object.entries(value.roles)) {
      const role = mergeRole(roleValue);
      if (role) roles[name] = { ...(roles[name] ?? {}), ...role };
    }
  }
  const idleTimeoutMinutes = positiveNumber(value.idleTimeoutMinutes, DEFAULT_CONFIG.idleTimeoutMinutes);
  const checkpointWarningMinutes = Math.min(
    positiveNumber(value.checkpointWarningMinutes, DEFAULT_CONFIG.checkpointWarningMinutes),
    idleTimeoutMinutes,
  );
  return {
    defaultHarness: isHarness(value.defaultHarness) ? value.defaultHarness : DEFAULT_CONFIG.defaultHarness,
    defaultProfiles: mergeHarnessStrings(value.defaultProfiles, DEFAULT_CONFIG.defaultProfiles),
    defaultModels: mergeHarnessStrings(value.defaultModels, DEFAULT_CONFIG.defaultModels),
    defaultEfforts: mergeHarnessEfforts(value.defaultEfforts, DEFAULT_CONFIG.defaultEfforts),
    profiles,
    permissionProfiles,
    roles,
    leaseMinutes: positiveNumber(value.leaseMinutes, DEFAULT_CONFIG.leaseMinutes),
    heartbeatSeconds: positiveNumber(value.heartbeatSeconds, DEFAULT_CONFIG.heartbeatSeconds),
    maxRuntime: typeof value.maxRuntime === "string" && value.maxRuntime.trim() ? value.maxRuntime : DEFAULT_CONFIG.maxRuntime,
    stopTimeoutSeconds: positiveNumber(value.stopTimeoutSeconds, DEFAULT_CONFIG.stopTimeoutSeconds),
    idleTimeoutMinutes,
    checkpointWarningMinutes,
    checkpointRetryMinutes: positiveNumber(value.checkpointRetryMinutes, DEFAULT_CONFIG.checkpointRetryMinutes),
    cleanupGraceMinutes: positiveNumber(value.cleanupGraceMinutes, DEFAULT_CONFIG.cleanupGraceMinutes),
    cleanupTimerMinutes: positiveNumber(value.cleanupTimerMinutes, DEFAULT_CONFIG.cleanupTimerMinutes),
    cleanupTimerEnabled:
      typeof value.cleanupTimerEnabled === "boolean" ? value.cleanupTimerEnabled : DEFAULT_CONFIG.cleanupTimerEnabled,
    cleanupExpiredOnStart:
      typeof value.cleanupExpiredOnStart === "boolean" ? value.cleanupExpiredOnStart : DEFAULT_CONFIG.cleanupExpiredOnStart,
    cleanupOnShutdown:
      typeof value.cleanupOnShutdown === "boolean" ? value.cleanupOnShutdown : DEFAULT_CONFIG.cleanupOnShutdown,
  };
}

export async function readConfig(path: string): Promise<OrchestratorConfig> {
  try {
    return mergeConfig(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(DEFAULT_CONFIG);
    throw new Error(`Could not read orchestrator config ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function writeConfigValue(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export async function writeConfig(path: string, config: OrchestratorConfig): Promise<void> {
  await writeConfigValue(path, config);
}

export async function writeConfigDefaults(path: string, config: OrchestratorConfig): Promise<void> {
  let existing: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (isRecord(parsed)) existing = parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const defaultProfiles = Object.fromEntries(
    HARNESSES
      .filter((harness) => config.defaultProfiles[harness] !== DEFAULT_CONFIG.defaultProfiles[harness])
      .map((harness) => [harness, config.defaultProfiles[harness]]),
  );
  const permissionProfiles = Object.fromEntries(
    Object.entries(config.permissionProfiles).flatMap(([name, profile]) => {
      const builtIn = DEFAULT_CONFIG.permissionProfiles[name];
      if (!builtIn) return [[name, profile]];
      const delta = Object.fromEntries(
        Object.entries(profile).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(builtIn[key as keyof PermissionProfile])),
      );
      return Object.keys(delta).length ? [[name, delta]] : [];
    }),
  );
  const roles = Object.fromEntries(
    Object.entries(config.roles).flatMap(([name, role]) => {
      const builtIn = DEFAULT_CONFIG.roles[name];
      if (!builtIn) return [[name, role]];
      const delta = Object.fromEntries(
        Object.entries(role).filter(([key, value]) => value !== builtIn[key as keyof RolePreset]),
      );
      return Object.keys(delta).length ? [[name, delta]] : [];
    }),
  );
  await writeConfigValue(path, {
    ...existing,
    defaultHarness: config.defaultHarness,
    defaultProfiles,
    defaultModels: config.defaultModels,
    defaultEfforts: config.defaultEfforts,
    permissionProfiles,
    roles,
    leaseMinutes: config.leaseMinutes,
    heartbeatSeconds: config.heartbeatSeconds,
    maxRuntime: config.maxRuntime,
    stopTimeoutSeconds: config.stopTimeoutSeconds,
    idleTimeoutMinutes: config.idleTimeoutMinutes,
    checkpointWarningMinutes: config.checkpointWarningMinutes,
    checkpointRetryMinutes: config.checkpointRetryMinutes,
    cleanupGraceMinutes: config.cleanupGraceMinutes,
    cleanupTimerMinutes: config.cleanupTimerMinutes,
    cleanupTimerEnabled: config.cleanupTimerEnabled,
    cleanupExpiredOnStart: config.cleanupExpiredOnStart,
    cleanupOnShutdown: config.cleanupOnShutdown,
  });
}

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function resolveProfileCommand(command: string, pathEnv = process.env.PATH ?? ""): string | undefined {
  const expanded = expandHome(command);
  if (isAbsolute(expanded)) return expanded;
  for (const directory of pathEnv.split(":")) {
    if (!directory) continue;
    const candidate = join(directory, expanded);
    try {
      const stat = statSync(candidate);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  return undefined;
}

import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { LaunchProfile, OrchestratorConfig } from "./types.ts";

export const DEFAULT_CONFIG: OrchestratorConfig = {
  defaultHarness: "pi",
  defaultProfiles: {
    codex: "codex-safe",
    claude: "claude-safe",
  },
  profiles: {
    "codex-safe": {
      harness: "codex",
      command: "coi",
      args: ["--no-tui", "--sandbox", "workspace-write", "--ask-for-approval", "on-request"],
      description: "Wakeable Codex worker with a workspace-write sandbox",
    },
    "codex-minimal": {
      harness: "codex",
      command: "coim",
      args: ["--no-tui"],
      description: "Wakeable Codex worker using a locally configured minimal profile",
    },
    "claude-safe": {
      harness: "claude",
      command: "cci",
      args: ["--safe"],
      description: "Wakeable Claude Code worker with standard permission prompts",
    },
    "claude-minimal": {
      harness: "claude",
      command: "ccim",
      args: ["--safe"],
      description: "Wakeable minimal Claude Code worker",
    },
    opencode: {
      harness: "opencode",
      command: "opencode",
      args: [],
      spawnable: false,
      description: "Attach-only in the first draft; persistent headless launch still needs a host-specific runner",
    },
  },
  leaseMinutes: 30,
  heartbeatSeconds: 60,
  maxRuntime: "2h",
  stopTimeoutSeconds: 5,
  cleanupExpiredOnStart: true,
  cleanupOnShutdown: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function mergeProfile(name: string, value: unknown): LaunchProfile | undefined {
  if (!isRecord(value)) return undefined;
  const harness = value.harness;
  const command = value.command;
  if ((harness !== "codex" && harness !== "claude" && harness !== "opencode") || typeof command !== "string") {
    return undefined;
  }
  const args = Array.isArray(value.args) && value.args.every((item) => typeof item === "string")
    ? value.args as string[]
    : undefined;
  const env = isRecord(value.env)
    ? Object.fromEntries(Object.entries(value.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
    : undefined;
  return {
    harness,
    command,
    ...(args ? { args } : {}),
    ...(env ? { env } : {}),
    ...(typeof value.spawnable === "boolean" ? { spawnable: value.spawnable } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
  };
}

export function mergeConfig(value: unknown): OrchestratorConfig {
  if (!isRecord(value)) return structuredClone(DEFAULT_CONFIG);
  const profiles = { ...DEFAULT_CONFIG.profiles };
  if (isRecord(value.profiles)) {
    for (const [name, profileValue] of Object.entries(value.profiles)) {
      const profile = mergeProfile(name, profileValue);
      if (profile) profiles[name] = profile;
    }
  }
  const defaults = isRecord(value.defaultProfiles) ? value.defaultProfiles : {};
  const defaultHarness = value.defaultHarness;
  return {
    defaultHarness:
      defaultHarness === "pi" || defaultHarness === "codex" || defaultHarness === "claude" || defaultHarness === "opencode"
        ? defaultHarness
        : DEFAULT_CONFIG.defaultHarness,
    defaultProfiles: {
      ...DEFAULT_CONFIG.defaultProfiles,
      ...(typeof defaults.codex === "string" ? { codex: defaults.codex } : {}),
      ...(typeof defaults.claude === "string" ? { claude: defaults.claude } : {}),
      ...(typeof defaults.opencode === "string" ? { opencode: defaults.opencode } : {}),
    },
    profiles,
    leaseMinutes: positiveNumber(value.leaseMinutes, DEFAULT_CONFIG.leaseMinutes),
    heartbeatSeconds: positiveNumber(value.heartbeatSeconds, DEFAULT_CONFIG.heartbeatSeconds),
    maxRuntime: typeof value.maxRuntime === "string" && value.maxRuntime.trim() ? value.maxRuntime : DEFAULT_CONFIG.maxRuntime,
    stopTimeoutSeconds: positiveNumber(value.stopTimeoutSeconds, DEFAULT_CONFIG.stopTimeoutSeconds),
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


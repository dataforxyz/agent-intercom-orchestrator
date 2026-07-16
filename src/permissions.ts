import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Harness, PermissionProfile } from "./types.ts";

export const SAFE_PI_READ_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "intercom_team",
  "intercom_send",
  "intercom_ask",
  "intercom_reply",
  "intercom_list",
  "intercom_pending",
  "intercom_status",
];

export const SAFE_PI_BUILD_TOOLS = [
  ...SAFE_PI_READ_TOOLS,
  "bash",
  "edit",
  "write",
];

const SENSITIVE_HOME_PATHS = [
  "~/.ssh",
  "~/.aws",
  "~/.gnupg",
  "~/.kube",
  "~/.docker",
  "~/.azure",
  "~/.config/gcloud",
  "~/.config/gh",
  "~/.netrc",
  "~/.npmrc",
  "~/.pypirc",
];

const SCRUBBED_CREDENTIAL_ENV: Record<string, string> = {
  SSH_AUTH_SOCK: "",
  SSH_ASKPASS: "/bin/false",
  GIT_ASKPASS: "/bin/false",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GH_TOKEN: "",
  GITHUB_TOKEN: "",
  GITLAB_TOKEN: "",
  AWS_ACCESS_KEY_ID: "",
  AWS_SECRET_ACCESS_KEY: "",
  AWS_SESSION_TOKEN: "",
  GOOGLE_APPLICATION_CREDENTIALS: "",
  AZURE_CLIENT_SECRET: "",
};

export const DEFAULT_PERMISSION_PROFILES: Record<string, PermissionProfile> = {
  trusted: {
    description: "Current broad-access behavior; use only when full host authority is intentional",
    workspace: "host",
    git: "full",
  },
  "review-readonly": {
    description: "Read-only host and assigned workspace, except private temp and harness runtime state",
    workspace: "read-only",
    git: "read-only",
    hardened: true,
    piTools: SAFE_PI_READ_TOOLS,
    inaccessiblePaths: SENSITIVE_HOME_PATHS,
    environment: SCRUBBED_CREDENTIAL_ENV,
  },
  "builder-restricted": {
    description: "Only the assigned workspace and harness runtime state are writable; Git metadata and credentials are protected",
    workspace: "read-write",
    git: "read-only",
    hardened: true,
    piTools: SAFE_PI_BUILD_TOOLS,
    inaccessiblePaths: SENSITIVE_HOME_PATHS,
    environment: SCRUBBED_CREDENTIAL_ENV,
  },
};

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

function quoteSystemdPath(path: string): string {
  return JSON.stringify(path);
}

export function harnessWritableStatePaths(harness: Harness): string[] {
  const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? ""}`;
  const registry = `${runtimeDir}/omarchy-session/agents/${harness}`;
  if (harness === "pi") return ["~/.pi/agent/sessions", "~/.pi/agent/intercom/inbox", "~/.pi/agent/intercom/outbox", "~/.cache/pi", registry];
  if (harness === "codex") return ["~/.codex", registry];
  if (harness === "claude") return ["~/.claude", "~/.cache/claude-cli-nodejs", registry];
  return ["~/.local/share/opencode", "~/.local/state/opencode", "~/.cache/opencode", registry];
}

export function buildPermissionUnitProperties(profile: PermissionProfile, cwd: string, gitMetadataPaths: string[] = [], runtimeWritablePaths: string[] = []): string[] {
  const properties: string[] = [];
  if (profile.hardened) {
    properties.push(
      "PrivateUsers=self",
      "PrivateTmp=yes",
      "NoNewPrivileges=yes",
      "PrivateDevices=yes",
      "ProtectSystem=strict",
      "ProtectHome=read-only",
      "ProtectKernelTunables=yes",
      "ProtectKernelModules=yes",
      "ProtectControlGroups=yes",
      "RestrictSUIDSGID=yes",
      "LockPersonality=yes",
      "CapabilityBoundingSet=",
    );
  }
  if (profile.workspace === "read-only") {
    properties.push(`ReadOnlyPaths=${quoteSystemdPath(resolve(cwd))}`);
  } else if (profile.workspace === "read-write") {
    properties.push(`ReadWritePaths=${quoteSystemdPath(resolve(cwd))}`);
  }
  for (const path of [...new Set([...(profile.writablePaths ?? []), ...runtimeWritablePaths])]) {
    properties.push(`ReadWritePaths=${quoteSystemdPath(`-${expandHome(path)}`)}`);
  }
  if (profile.git === "read-only") {
    const metadataPaths = gitMetadataPaths.length ? gitMetadataPaths : [resolve(cwd, ".git")];
    for (const path of [...new Set(metadataPaths.map((item) => resolve(item)))]) {
      properties.push(`ReadOnlyPaths=${quoteSystemdPath(`-${path}`)}`);
    }
  }
  for (const path of profile.inaccessiblePaths ?? []) {
    properties.push(`InaccessiblePaths=${quoteSystemdPath(`-${expandHome(path)}`)}`);
  }
  for (const [name, value] of Object.entries(profile.systemdProperties ?? {})) {
    if (!/^[A-Za-z][A-Za-z0-9]+$/.test(name) || value.includes("\0") || value.includes("\n")) continue;
    properties.push(`${name}=${value}`);
  }
  return properties;
}

export function buildPermissionEnvironment(profileName: string, profile: PermissionProfile): Record<string, string> {
  return {
    AGENT_INTERCOM_PERMISSION_PROFILE: profileName,
    AGENT_INTERCOM_GIT_POLICY: profile.git,
    AGENT_INTERCOM_WORKSPACE_POLICY: profile.workspace,
    ...(profile.environment ?? {}),
  };
}

export function applyPiPermissionArgs(args: string[], profile: PermissionProfile): string[] {
  if (!profile.piTools?.length) return args;
  return [...args, "--tools", [...new Set(profile.piTools)].join(",")];
}

const SAFE_GIT_COMMANDS = new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "ls-files",
  "ls-tree",
  "grep",
  "blame",
  "shortlog",
  "describe",
  "name-rev",
  "cat-file",
  "for-each-ref",
]);

function gitInvocationReason(command: string): string | undefined {
  const invocations = command.matchAll(/(?:^|[\s;&|()])(?:[\w./-]+\/)?git\s+(?:(?:(?:-C|-c|--git-dir|--work-tree)\s+\S+|(?:--git-dir|--work-tree)=\S+|--no-pager)\s+)*([a-z][a-z-]*)([^\n;&|)]*)/gi);
  for (const match of invocations) {
    const subcommand = match[1].toLowerCase();
    const rest = (match[2] ?? "").trim().split(/\s+/).filter(Boolean);
    if (SAFE_GIT_COMMANDS.has(subcommand)) continue;
    if (subcommand === "branch" && (rest.length === 0 || rest.every((arg) => ["-a", "--all", "-r", "--remotes", "-v", "-vv", "--show-current", "--list"].includes(arg)))) continue;
    if (subcommand === "tag" && (rest.length === 0 || rest[0] === "-l" || rest[0] === "--list")) continue;
    if (subcommand === "remote" && (rest.length === 0 || rest[0] === "-v" || rest[0] === "get-url")) continue;
    if (subcommand === "config" && rest.some((arg) => ["--get", "--get-all", "--get-regexp", "--list", "--show-origin", "--show-scope"].includes(arg)) && !rest.some((arg) => ["--add", "--replace-all", "--unset", "--unset-all", "--rename-section", "--remove-section"].includes(arg))) continue;
    if (subcommand === "stash" && (rest[0] === "list" || rest[0] === "show")) continue;
    return `git ${subcommand} is blocked by the read-only Git policy`;
  }
  if (/(?:^|[\s;&|()])gh\s+(?:api\b|pr\s+(?:create|merge|close|reopen)\b|issue\s+(?:create|close|reopen|delete)\b|release\s+(?:create|delete|upload)\b|repo\s+(?:create|delete|fork|rename|archive)\b|workflow\s+run\b)/i.test(command)) {
    return "GitHub write operation is blocked by the read-only Git policy";
  }
  return undefined;
}

export function blockedToolReason(toolName: string, input: unknown, workspace: string, gitPolicy: string): string | undefined {
  if (workspace === "read-only" && (toolName === "write" || toolName === "edit")) {
    return `${toolName} is blocked by the read-only workspace policy`;
  }
  if (gitPolicy !== "read-only" || toolName !== "bash" || !input || typeof input !== "object") return undefined;
  const command = (input as { command?: unknown }).command;
  return typeof command === "string" ? gitInvocationReason(command) : undefined;
}

export function registerWorkerPermissionPolicy(pi: ExtensionAPI): boolean {
  const profileName = process.env.AGENT_INTERCOM_PERMISSION_PROFILE?.trim();
  if (!profileName) return false;
  const workspace = process.env.AGENT_INTERCOM_WORKSPACE_POLICY || "host";
  const gitPolicy = process.env.AGENT_INTERCOM_GIT_POLICY || "full";
  pi.on("tool_call", (event) => {
    const reason = blockedToolReason(event.toolName, event.input, workspace, gitPolicy);
    if (reason) return { block: true, reason: `${reason} (permission profile: ${profileName})` };
  });
  return true;
}

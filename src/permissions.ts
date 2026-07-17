import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PermissionProfile } from "./types.ts";

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
  "~/.config/tea",
  "~/.config/gitea",
  "~/.config/forgejo",
  "~/.tea",
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
  TEA_CONFIG: "",
  TEA_CONFIG_FILE: "",
  TEA_TOKEN: "",
  TEA_LOGIN: "",
  TEA_DEBUG: "",
  TEA_TRACE: "",
  GITEA_TOKEN: "",
  GITEA_URL: "",
  GITEA_SERVER: "",
  GITEA_SERVER_URL: "",
  GITEA_SERVER_TOKEN: "",
  GITEA_SERVER_USER: "",
  GITEA_SERVER_PASSWORD: "",
  GITEA_SERVER_OTP: "",
  GITEA_INSTANCE_URL: "",
  GITEA_INSTANCE_SSH_HOST: "",
  GITEA_INSTANCE_INSECURE: "",
  GITEA_LOGIN_VIA_ENV: "",
  FORGEJO_TOKEN: "",
  FORGEJO_URL: "",
  FORGEJO_SERVER: "",
  FORGEJO_SERVER_URL: "",
  AWS_ACCESS_KEY_ID: "",
  AWS_SECRET_ACCESS_KEY: "",
  AWS_SESSION_TOKEN: "",
  GOOGLE_APPLICATION_CREDENTIALS: "",
  AZURE_CLIENT_SECRET: "",
  DBUS_SESSION_BUS_ADDRESS: "",
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

// PrivateUsers=self preserves the worker uid but maps unrelated host uids/gids,
// including privileged supplementary groups, to nobody. That can accidentally
// make group-owned daemon sockets appear owned by the worker's mapped nobody
// group, so restricted units must hide control endpoints explicitly.
const STATIC_PRIVILEGED_RUNTIME_PATHS = [
  "/run/docker.sock",
  "/var/run/docker.sock",
  "/run/containerd",
  "/var/run/containerd",
  "/run/containerd/containerd.sock",
  "/var/run/containerd/containerd.sock",
  "/run/k3s/containerd",
  "/run/rke2/containerd",
  "/run/k0s/containerd.sock",
  "/var/snap/microk8s/common/run/containerd.sock",
  "/run/cri-dockerd.sock",
  "/var/run/cri-dockerd.sock",
  "/run/podman",
  "/var/run/podman",
  "/run/podman/podman.sock",
  "/var/run/podman/podman.sock",
  "/run/buildkit",
  "/var/run/buildkit",
  "/run/buildkit/buildkitd.sock",
  "/var/run/buildkit/buildkitd.sock",
  "/run/crio",
  "/var/run/crio",
  "/run/crio/crio.sock",
  "/var/run/crio/crio.sock",
  "/run/lxd",
  "/var/run/lxd",
  "/var/lib/lxd/unix.socket",
  "/var/snap/lxd/common/lxd/unix.socket",
  "/var/snap/lxd/common/lxd/unix.socket.user",
  "/run/incus",
  "/var/run/incus",
  "/var/lib/incus/unix.socket",
  "/var/lib/incus/unix.socket.user",
  "/run/lxc",
  "/var/run/lxc",
  "/run/lxcfs.sock",
  "/run/libvirt",
  "/var/run/libvirt",
  "/run/qemu",
  "/run/firecracker",
  "/run/systemd/private",
  "/run/systemd/coredump",
  "/run/systemd/ask-password",
  "/run/systemd/ask-password-block",
  "/run/systemd/io.systemd.AskPassword",
  "/run/systemd/io.systemd.BootControl",
  "/run/systemd/io.systemd.Credentials",
  "/run/systemd/io.systemd.FactoryReset",
  "/run/systemd/io.systemd.Hostname",
  "/run/systemd/io.systemd.Import",
  "/run/systemd/io.systemd.JournalAccess",
  "/run/systemd/io.systemd.Login",
  "/run/systemd/io.systemd.ManagedOOM",
  "/run/systemd/io.systemd.Manager",
  "/run/systemd/io.systemd.MuteConsole",
  "/run/systemd/io.systemd.PCRExtend",
  "/run/systemd/io.systemd.PCRLock",
  "/run/systemd/io.systemd.Repart",
  "/run/systemd/io.systemd.Shutdown",
  "/run/systemd/io.systemd.StorageProvider",
  "/run/systemd/io.systemd.sysext",
  "/run/systemd/machine",
  "/run/systemd/netif/io.systemd.Network",
  "/run/systemd/report",
  "/run/systemd/resolve.hook",
  "/run/systemd/shutdown",
  "/run/udev/control",
  "/run/udev/io.systemd.Udev",
  "/run/polkit",
  "/run/tailscale/tailscaled.sock",
];

export function privilegedRuntimePaths(uid = process.getuid?.()): string[] {
  const workerUid = Number.isInteger(uid) && Number(uid) >= 0 ? Number(uid) : undefined;
  const userRuntimePaths = workerUid === undefined ? [] : [
    `/run/user/${workerUid}/docker.sock`,
    `/run/user/${workerUid}/docker`,
    `/run/user/${workerUid}/podman`,
    `/run/user/${workerUid}/buildkit`,
    `/run/user/${workerUid}/containerd`,
    `/run/user/${workerUid}/containerd-rootless`,
    `/run/user/${workerUid}/lxd`,
    `/run/user/${workerUid}/incus`,
    `/run/user/${workerUid}/libvirt`,
  ];
  return [...STATIC_PRIVILEGED_RUNTIME_PATHS, ...userRuntimePaths];
}

export function buildPermissionUnitProperties(
  profile: PermissionProfile,
  cwd: string,
  gitMetadataPaths: string[] = [],
  runtimeWritablePaths: string[] = [],
  runtimeReadOnlyPaths: string[] = [],
  runtimeInaccessiblePaths: string[] = [],
  runtimeBindPaths: string[] = [],
): string[] {
  const properties: string[] = [];
  if (profile.hardened) {
    properties.push(
      "PrivateUsers=self",
      "PrivatePIDs=yes",
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
  if (profile.hardened) {
    const workerUid = process.getuid?.();
    const runtimeDir = Number.isInteger(workerUid) ? `/run/user/${workerUid}` : process.env.XDG_RUNTIME_DIR;
    const controlPaths = [
      ...(runtimeDir ? [`${runtimeDir}/bus`, `${runtimeDir}/systemd`] : []),
      "/run/dbus/system_bus_socket",
      ...privilegedRuntimePaths(workerUid),
    ];
    for (const path of [...new Set(controlPaths)]) {
      properties.push(`InaccessiblePaths=${quoteSystemdPath(`-${path}`)}`);
    }
  }
  if (profile.workspace === "read-only") {
    properties.push(`ReadOnlyPaths=${quoteSystemdPath(resolve(cwd))}`);
  } else if (profile.workspace === "read-write") {
    properties.push(`ReadWritePaths=${quoteSystemdPath(resolve(cwd))}`);
  }
  for (const path of [...new Set([...(profile.writablePaths ?? []), ...runtimeWritablePaths])]) {
    properties.push(`ReadWritePaths=${quoteSystemdPath(`-${expandHome(path)}`)}`);
  }
  for (const path of [...new Set(runtimeReadOnlyPaths)]) {
    properties.push(`ReadOnlyPaths=${quoteSystemdPath(`-${expandHome(path)}`)}`);
  }
  for (const path of [...new Set(runtimeInaccessiblePaths)]) {
    properties.push(`InaccessiblePaths=${quoteSystemdPath(expandHome(path))}`);
  }
  for (const path of [...new Set(runtimeBindPaths)]) {
    properties.push(`BindPaths=${path}`);
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

const TEA_COMMAND_ALIASES: Record<string, string> = {
  issues: "issues", issue: "issues", i: "issues",
  pulls: "pulls", pull: "pulls", pr: "pulls",
  labels: "labels", label: "labels",
  milestones: "milestones", milestone: "milestones", ms: "milestones",
  releases: "releases", release: "releases", r: "releases",
  times: "times", time: "times", t: "times",
  organizations: "organizations", organization: "organizations", org: "organizations",
  repos: "repos", repo: "repos",
  branches: "branches", branch: "branches", b: "branches",
  actions: "actions", action: "actions",
  wiki: "wiki",
  webhooks: "webhooks", webhook: "webhooks", hooks: "webhooks", hook: "webhooks",
  comments: "comments", comment: "comments", c: "comments",
  notifications: "notifications", notification: "notifications", n: "notifications",
  logins: "logins", login: "logins",
  "ssh-keys": "ssh-keys", "ssh-key": "ssh-keys",
  whoami: "whoami",
  api: "api",
};

const SAFE_TEA_SUBCOMMANDS: Record<string, Set<string>> = {
  issues: new Set(["list", "ls"]),
  pulls: new Set(["list", "ls", "review-comments", "rc"]),
  labels: new Set(["list", "ls"]),
  milestones: new Set(["list", "ls"]),
  releases: new Set(["list", "ls"]),
  times: new Set(["list", "ls"]),
  organizations: new Set(["list", "ls"]),
  repos: new Set(["list", "ls", "search", "s"]),
  branches: new Set(["list", "ls"]),
  wiki: new Set(["list", "ls", "view", "revisions", "history"]),
  webhooks: new Set(["list", "ls"]),
  comments: new Set(["list", "ls"]),
  notifications: new Set(["list", "ls"]),
  logins: new Set(["list", "ls"]),
  "ssh-keys": new Set(["list", "ls"]),
};

const SAFE_TEA_ACTION_SUBCOMMANDS: Record<string, Set<string>> = {
  secrets: new Set(["list", "ls"]), secret: new Set(["list", "ls"]),
  variables: new Set(["list", "ls"]), variable: new Set(["list", "ls"]), vars: new Set(["list", "ls"]), var: new Set(["list", "ls"]),
  runs: new Set(["list", "ls", "view", "show", "get", "logs", "log"]), run: new Set(["list", "ls", "view", "show", "get", "logs", "log"]),
  workflows: new Set(["list", "ls", "view", "show", "get"]), workflow: new Set(["list", "ls", "view", "show", "get"]),
};

function readOnlyTeaApiArgs(args: string[]): boolean {
  let method = "GET";
  let methodSeen = false;
  let endpointCount = 0;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") return false;
    if (["--field", "-f", "--Field", "-F", "--data", "-d", "--header", "-H"].includes(arg)) return false;
    if (/^(?:--field|--Field|--data|--header)=/.test(arg) || /^-(?:f|F|d|H).+/.test(arg)) return false;
    if (arg === "--method" || arg === "-X") {
      if (methodSeen || index + 1 >= args.length) return false;
      methodSeen = true;
      method = args[++index].toUpperCase();
      continue;
    }
    if (arg.startsWith("--method=")) {
      if (methodSeen) return false;
      methodSeen = true;
      method = arg.slice("--method=".length).toUpperCase();
      continue;
    }
    if (/^-X(?:=)?.+/.test(arg)) {
      if (methodSeen) return false;
      methodSeen = true;
      method = arg.slice(2).replace(/^=/, "").toUpperCase();
      continue;
    }
    if (["--output", "-o", "--login", "-l", "--repo", "-r", "--remote", "-R"].includes(arg)) {
      if (index + 1 >= args.length) return false;
      index += 1;
      continue;
    }
    if (/^(?:--output|--login|--repo|--remote)=.+/.test(arg) || /^-(?:o|l|r|R).+/.test(arg)) continue;
    if (arg === "--include" || arg === "-i") continue;
    if (arg.startsWith("-")) return false;
    endpointCount += 1;
  }
  return endpointCount === 1 && (method === "GET" || method === "HEAD");
}

export function isReadOnlyTeaInvocation(args: string[]): boolean {
  if (args.length === 0) return true;
  if (args.some((arg) => arg === "--help" || arg === "-h")) return true;
  if (args.length === 1 && ["--version", "-v"].includes(args[0])) return true;
  if (["help", "h"].includes(args[0])) return true;
  if (args.some((arg) => arg === "--debug" || arg === "--vvv")) return false;
  const teaCommand = TEA_COMMAND_ALIASES[args[0]];
  if (!teaCommand) return false;
  if (teaCommand === "whoami") return args.length === 1;
  if (teaCommand === "api") return readOnlyTeaApiArgs(args.slice(1));
  if (teaCommand === "actions") {
    if (args.length < 3) return false;
    return SAFE_TEA_ACTION_SUBCOMMANDS[args[1]]?.has(args[2]) ?? false;
  }
  if (args.length < 2 || !(SAFE_TEA_SUBCOMMANDS[teaCommand]?.has(args[1]) ?? false)) return false;
  if (teaCommand === "labels" && args.slice(2).some((arg) => arg === "--save" || arg.startsWith("--save=") || arg === "-s" || /^-s.+/.test(arg))) return false;
  return true;
}

function shellWords(input: string): string[] {
  return [...input.matchAll(/"(?:\\.|[^"])*"|'[^']*'|[^\s]+/g)].map((match) => match[0].replace(/^(?:"|')|(?:"|')$/g, ""));
}

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
  const teaInvocations = command.matchAll(/(?:^|[\s;&|()])(?:[\w./-]+\/)?tea(?:\s+([^\n;&|)]*))?/gi);
  for (const match of teaInvocations) {
    if (!isReadOnlyTeaInvocation(shellWords((match[1] ?? "").trim()))) {
      return "Forgejo write operation is blocked by the read-only Git policy";
    }
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

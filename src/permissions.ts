import { statSync } from "node:fs";
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
  "~/.config/google-cloud-sdk",
  "~/.cache/gcloud",
  "~/.gsutil",
  "~/.boto",
  "~/.bigqueryrc",
  "~/.wrangler",
  "~/.config/.wrangler",
  "~/.config/wrangler",
  "~/.cloudflared",
  "~/.config/cloudflared",
  "~/.cf",
  "~/.cf8",
  "~/.config/cf",
  "~/.config/cloudfoundry",
  "~/.ibmcloud",
  "~/.1password",
  "~/.config/1Password",
  "~/.config/Bitwarden",
  "~/.bitwarden-ssh-agent.sock",
  "~/.config/keepassxc",
  "~/.config/glab-cli",
  "~/.config/glab",
  "~/.glab-cli",
  "~/.glab",
  "~/.config/tea",
  "~/.config/gitea",
  "~/.config/forgejo",
  "~/.tea",
  "~/.netrc",
  "~/.npmrc",
  "~/.yarnrc",
  "~/.yarnrc.yml",
  "~/.config/yarn",
  "~/.pnpmrc",
  "~/.config/pnpm",
  "~/.bunfig.toml",
  "~/.config/bun",
  "~/.pypirc",
];

const SCRUBBED_CREDENTIAL_ENV: Record<string, string> = {
  SSH_AUTH_SOCK: "",
  SSH_AGENT_PID: "",
  GPG_AGENT_INFO: "",
  GNUPGHOME: "",
  SSH_ASKPASS: "/bin/false",
  GIT_ASKPASS: "/bin/false",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GH_TOKEN: "",
  GITHUB_TOKEN: "",
  GH_ENTERPRISE_TOKEN: "",
  GITHUB_ENTERPRISE_TOKEN: "",
  GH_HOST: "",
  GH_REPO: "",
  GH_CONFIG_DIR: "",
  GLAB_TOKEN: "",
  GLAB_CONFIG: "",
  GLAB_CONFIG_DIR: "",
  GLAB_CONFIG_FILE: "",
  GLAB_HOST: "",
  GLAB_DEBUG: "",
  GLAB_DEBUG_HTTP: "",
  GLAB_ENABLE_CI_AUTOLOGIN: "",
  GLAB_IS_OAUTH2: "",
  GLAB_NO_PROMPT: "1",
  GLAB_CHECK_UPDATE: "false",
  GLAB_SEND_TELEMETRY: "false",
  GITLAB_TOKEN: "",
  GITLAB_TOKEN_FILE: "",
  GITLAB_ACCESS_TOKEN: "",
  GITLAB_PRIVATE_TOKEN: "",
  GITLAB_OAUTH_TOKEN: "",
  GITLAB_JOB_TOKEN: "",
  GITLAB_CLIENT_SECRET: "",
  GITLAB_CLIENT_ID: "",
  GITLAB_CI: "",
  GITLAB_API_HOST: "",
  GITLAB_API_URL: "",
  GITLAB_GRAPHQL_URL: "",
  GITLAB_HOST: "",
  GITLAB_URL: "",
  GITLAB_URI: "",
  GITLAB_REPO: "",
  GITLAB_HEAD_REPO: "",
  GITLAB_CA_CERT: "",
  GITLAB_TLS_CA_FILE: "",
  GITLAB_CLIENT_CERT: "",
  GITLAB_CLIENT_KEY: "",
  GITLAB_SKIP_TLS_VERIFY: "",
  OAUTH_TOKEN: "",
  PRIVATE_TOKEN: "",
  JOB_TOKEN: "",
  CI_JOB_TOKEN: "",
  CI_JOB_TOKEN_FILE: "",
  CI_BUILD_TOKEN: "",
  CI_JOB_JWT: "",
  CI_JOB_JWT_V2: "",
  CI_PROJECT_PATH: "",
  CI_DEPLOY_PASSWORD: "",
  CI_REGISTRY_PASSWORD: "",
  CI_REPOSITORY_URL: "",
  CI_SERVER_URL: "",
  CI_SERVER_HOST: "",
  CI_SERVER_FQDN: "",
  CI_SERVER_PROTOCOL: "",
  CI_SERVER_TLS_CA_FILE: "",
  CI_SERVER_TLS_CERT_FILE: "",
  CI_SERVER_TLS_KEY_FILE: "",
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
  FORGEJO_SERVER_TOKEN: "",
  FORGEJO_SERVER_USER: "",
  FORGEJO_SERVER_PASSWORD: "",
  FORGEJO_SERVER_OTP: "",
  FORGEJO_LOGIN_VIA_ENV: "",
  AWS_ACCESS_KEY_ID: "",
  AWS_SECRET_ACCESS_KEY: "",
  AWS_SESSION_TOKEN: "",
  GOOGLE_APPLICATION_CREDENTIALS: "",
  GOOGLE_APPLICATION_CREDENTIALS_JSON: "",
  GOOGLE_CREDENTIALS: "",
  GOOGLE_OAUTH_ACCESS_TOKEN: "",
  GOOGLE_GHA_CREDS_PATH: "",
  CLOUDSDK_CONFIG: "",
  CLOUDSDK_AUTH_ACCESS_TOKEN: "",
  CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: "",
  CLOUDSDK_CORE_ACCOUNT: "",
  CLOUDSDK_CORE_PROJECT: "",
  CLOUDSDK_ACTIVE_CONFIG_NAME: "",
  GOOGLE_API_KEY: "",
  GCE_METADATA_HOST: "",
  GCE_METADATA_IP: "",
  CLOUDFLARE_API_TOKEN: "",
  CLOUDFLARE_API_KEY: "",
  CLOUDFLARE_EMAIL: "",
  CF_EMAIL: "",
  CLOUDFLARE_API_USER_SERVICE_KEY: "",
  CLOUDFLARE_ACCESS_CLIENT_ID: "",
  CLOUDFLARE_ACCESS_CLIENT_SECRET: "",
  CLOUDFLARE_ACCOUNT_ID: "",
  CLOUDFLARE_ZONE_ID: "",
  CF_API_TOKEN: "",
  CF_API_KEY: "",
  CF_ACCOUNT_ID: "",
  WRANGLER_CONFIG: "",
  WRANGLER_CONFIG_FILENAME: "",
  CLOUDFLARE_CONFIG_FILENAME: "",
  WRANGLER_HOME: "",
  WRANGLER_CF_AUTHORIZATION_TOKEN: "",
  WRANGLER_R2_SQL_AUTH_TOKEN: "",
  CLOUDFLARE_AUTH_USE_KEYRING: "",
  WRANGLER_AUTH_DOMAIN: "",
  WRANGLER_AUTH_URL: "",
  WRANGLER_TOKEN_URL: "",
  WRANGLER_REVOKE_URL: "",
  CLOUDFLARE_API_BASE_URL: "",
  CLOUDFLARE_BASE_URL: "",
  CLOUDFLARED_TOKEN: "",
  TUNNEL_TOKEN: "",
  TUNNEL_ORIGIN_CERT: "",
  TUNNEL_CRED_FILE: "",
  TUNNEL_CREDENTIALS_FILE: "",
  CF_HOME: "",
  CF_PLUGIN_HOME: "",
  CF_USERNAME: "",
  CF_PASSWORD: "",
  CF_CLIENT_ID: "",
  CF_CLIENT_SECRET: "",
  CF_CLIENT: "",
  CF_DOCKER_PASSWORD: "",
  CF_API: "",
  CF_ORG: "",
  CF_SPACE: "",
  CF_TRACE: "",
  CF_TRACE_FILE: "",
  CF_SKIP_SSL_VALIDATION: "",
  NPM_TOKEN: "",
  NODE_AUTH_TOKEN: "",
  NPM_AUTH_TOKEN: "",
  NPM_CONFIG_USERCONFIG: "/dev/null",
  npm_config_userconfig: "/dev/null",
  NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
  YARN_NPM_AUTH_TOKEN: "",
  YARN_RC_FILENAME: "",
  BUN_AUTH_TOKEN: "",
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

function existingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
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

export function credentialAgentPaths(uid = process.getuid?.()): string[] {
  const workerUid = Number.isInteger(uid) && Number(uid) >= 0 ? Number(uid) : undefined;
  if (workerUid === undefined) return [];
  const runtime = `/run/user/${workerUid}`;
  return [
    `${runtime}/gnupg`,
    `${runtime}/keyring`,
    `${runtime}/p11-kit`,
    `${runtime}/gcr`,
    `${runtime}/ssh-agent`,
    `${runtime}/ssh-agent.socket`,
    `${runtime}/openssh_agent`,
    `${runtime}/1password`,
    `${runtime}/op-ssh-sign.sock`,
    `${runtime}/bitwarden`,
    `${runtime}/bitwarden-ssh-agent.sock`,
    `${runtime}/keepassxc`,
  ];
}

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
      ...credentialAgentPaths(workerUid),
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
  if (profile.hardened) {
    for (const name of [".npmrc", ".yarnrc", ".yarnrc.yml", ".pnpmrc", "bunfig.toml", ".netrc"]) {
      properties.push(`InaccessiblePaths=${quoteSystemdPath(`-${resolve(cwd, name)}`)}`);
    }
  }
  if (profile.git === "read-only") {
    const metadataPaths = gitMetadataPaths.length ? gitMetadataPaths : [resolve(cwd, ".git")];
    for (const path of [...new Set(metadataPaths.map((item) => resolve(item)))]) {
      properties.push(`ReadOnlyPaths=${quoteSystemdPath(`-${path}`)}`);
      if (existingDirectory(path)) properties.push(`InaccessiblePaths=${quoteSystemdPath(`-${resolve(path, "glab-cli")}`)}`);
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

function isSafeTeaSlug(value: string): boolean {
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/.test(value)) return false;
  return value.split("/").every((segment) => segment !== "." && segment !== "..");
}

function isSafeTeaName(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && value !== "." && value !== "..";
}

function validateTeaTargetArgs(args: string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--repo" || arg === "-r") {
      if (index + 1 >= args.length || !isSafeTeaSlug(args[++index])) return false;
      continue;
    }
    if (["--remote", "-R", "--login", "-l"].includes(arg)) {
      if (index + 1 >= args.length || !isSafeTeaName(args[++index])) return false;
      continue;
    }
    if (arg.startsWith("--repo=")) {
      if (!isSafeTeaSlug(arg.slice("--repo=".length))) return false;
      continue;
    }
    if (arg.startsWith("--remote=")) {
      if (!isSafeTeaName(arg.slice("--remote=".length))) return false;
      continue;
    }
    if (arg.startsWith("--login=")) {
      if (!isSafeTeaName(arg.slice("--login=".length))) return false;
      continue;
    }
    if (/^-r.+/.test(arg) && !isSafeTeaSlug(arg.slice(2).replace(/^=/, ""))) return false;
    if (/^-[Rl].+/.test(arg) && !isSafeTeaName(arg.slice(2).replace(/^=/, ""))) return false;
  }
  return true;
}

function readOnlyTeaApiArgs(args: string[]): boolean {
  let method = "GET";
  let methodSeen = false;
  let endpoint: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") return false;
    if (["--field", "-f", "--Field", "-F", "--data", "-d", "--header", "-H", "--login", "-l", "--repo", "-r", "--remote", "-R"].includes(arg)) return false;
    if (/^(?:--field|--Field|--data|--header|--login|--repo|--remote)=/.test(arg) || /^-(?:f|F|d|H|l|r|R).+/.test(arg)) return false;
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
    if (arg === "--output" || arg === "-o") {
      if (index + 1 >= args.length || args[++index] !== "-") return false;
      continue;
    }
    if (arg === "--output=-" || arg === "-o-") continue;
    if (arg === "--include" || arg === "-i") continue;
    if (arg.startsWith("-")) return false;
    if (endpoint !== undefined) return false;
    endpoint = arg;
  }
  if (!endpoint || !["GET", "HEAD"].includes(method)) return false;
  if (endpoint.includes("://") || endpoint.startsWith("//") || endpoint.includes("\\") || endpoint.includes("%")) return false;
  if (/[?&](?:_?method|http_method_override)=/i.test(endpoint)) return false;
  return true;
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
  if (hasUnsafeGlabExternalTarget(args) || !validateTeaTargetArgs(args)) return false;
  if (teaCommand === "actions") {
    if (args.length < 3) return false;
    return SAFE_TEA_ACTION_SUBCOMMANDS[args[1]]?.has(args[2]) ?? false;
  }
  if (args.length < 2 || !(SAFE_TEA_SUBCOMMANDS[teaCommand]?.has(args[1]) ?? false)) return false;
  if (teaCommand === "labels" && args.slice(2).some((arg) => arg === "--save" || arg.startsWith("--save=") || arg === "-s" || /^-s.+/.test(arg))) return false;
  return true;
}

function isSafeGhRepo(value: string): boolean {
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value)) return false;
  return value.split("/").every((segment) => segment !== "." && segment !== "..");
}

function normalizeGhTargetArgs(args: string[]): string[] | undefined {
  const normalized: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") return undefined;
    if (arg === "-R" || arg === "--repo") {
      if (index + 1 >= args.length || !isSafeGhRepo(args[index + 1])) return undefined;
      index += 1;
      continue;
    }
    if (arg.startsWith("--repo=")) {
      if (!isSafeGhRepo(arg.slice("--repo=".length))) return undefined;
      continue;
    }
    if (/^-R.+/.test(arg)) {
      if (!isSafeGhRepo(arg.slice(2).replace(/^=/, ""))) return undefined;
      continue;
    }
    normalized.push(arg);
  }
  return normalized;
}

function readOnlyGhApiArgs(args: string[]): boolean {
  let method = "GET";
  let methodSeen = false;
  let endpoint: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") return false;
    if (["--field", "-F", "--raw-field", "-f", "--input", "--header", "-H", "--hostname", "--cache", "--preview", "-p", "--jq", "-q", "--template", "-t"].includes(arg)) return false;
    if (/^(?:--field|--raw-field|--input|--header|--hostname|--cache|--preview|--jq|--template)=/.test(arg) || /^-(?:F|f|H|p|q|t).+/.test(arg)) return false;
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
    if (["--include", "-i", "--paginate", "--silent", "--slurp"].includes(arg)) continue;
    if (arg.startsWith("-")) return false;
    if (endpoint !== undefined) return false;
    endpoint = arg;
  }
  if (!endpoint || !["GET", "HEAD"].includes(method)) return false;
  if (endpoint.includes("://") || endpoint.startsWith("//") || endpoint.includes("\\") || endpoint.includes("%")) return false;
  const lower = endpoint.toLowerCase();
  if (/(^|\/)graphql(?:[/?]|$)/.test(lower)) return false;
  if (/[?&](?:_?method|http_method_override)=/i.test(lower)) return false;
  return true;
}

export function isReadOnlyGhInvocation(args: string[]): boolean {
  if (args.length === 0) return true;
  if (args.some((arg) => arg === "--help" || arg === "-h")) return true;
  if (args.length === 1 && ["--version", "version"].includes(args[0])) return true;
  if (args[0] === "help") return true;
  if (args.some((arg) => arg === "--web" || arg.startsWith("--web=") || arg === "-w" || /^-w.+/.test(arg) || arg === "--browser" || arg.startsWith("--browser=") || arg === "--hostname" || arg.startsWith("--hostname=") || arg === "--show-token" || arg.startsWith("--show-token=") || arg === "-t" || /^-t.+/.test(arg))) return false;
  if (args[0] === "api") return readOnlyGhApiArgs(args.slice(1));
  if (hasUnsafeGlabExternalTarget(args)) return false;
  const normalized = normalizeGhTargetArgs(args);
  if (!normalized?.length) return false;
  const [command, subcommand] = normalized;
  if (command === "status") return normalized.length === 1;
  if (command === "search") return ["code", "commits", "issues", "prs", "repos"].includes(subcommand);
  const safe: Record<string, Set<string>> = {
    auth: new Set(["status"]),
    repo: new Set(["list", "view"]),
    pr: new Set(["list", "view", "status", "checks", "diff"]),
    issue: new Set(["list", "view", "status"]),
    run: new Set(["list", "view", "watch"]),
    workflow: new Set(["list", "view"]),
    release: new Set(["list", "view"]),
    gist: new Set(["list", "view"]),
  };
  return safe[command]?.has(subcommand) ?? false;
}

interface NormalizedGlabArgs {
  args: string[];
  targetFlagSeen: boolean;
}

function isSafeGlabNamespacePath(value: string, requireSlash: boolean): boolean {
  if (!/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(value)) return false;
  const segments = value.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) return false;
  return !requireSlash || segments.length > 1;
}

function hasUnsafeGlabExternalTarget(args: string[]): boolean {
  return args.some((arg) => /[\u0000-\u001f\u007f]/.test(arg)
    || arg.includes("://")
    || arg.startsWith("//")
    || arg.includes("\\")
    || arg.includes("@")
    || arg.includes(":")
    || arg.includes("%"));
}

function normalizeGlabTargetArgs(args: string[]): NormalizedGlabArgs | undefined {
  const normalized: string[] = [];
  let targetFlagSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") return undefined;
    if (arg === "-R" || arg === "--repo") {
      if (index + 1 >= args.length || !isSafeGlabNamespacePath(args[index + 1], true)) return undefined;
      targetFlagSeen = true;
      index += 1;
      continue;
    }
    if (arg === "-g" || arg === "--group") {
      if (index + 1 >= args.length || !isSafeGlabNamespacePath(args[index + 1], false)) return undefined;
      targetFlagSeen = true;
      index += 1;
      continue;
    }
    if (arg.startsWith("--repo=")) {
      if (!isSafeGlabNamespacePath(arg.slice("--repo=".length), true)) return undefined;
      targetFlagSeen = true;
      continue;
    }
    if (arg.startsWith("--group=")) {
      if (!isSafeGlabNamespacePath(arg.slice("--group=".length), false)) return undefined;
      targetFlagSeen = true;
      continue;
    }
    if (/^-R.+/.test(arg)) {
      if (!isSafeGlabNamespacePath(arg.slice(2).replace(/^=/, ""), true)) return undefined;
      targetFlagSeen = true;
      continue;
    }
    if (/^-g.+/.test(arg)) {
      if (!isSafeGlabNamespacePath(arg.slice(2).replace(/^=/, ""), false)) return undefined;
      targetFlagSeen = true;
      continue;
    }
    normalized.push(arg);
  }
  return { args: normalized, targetFlagSeen };
}

function readOnlyGlabApiArgs(args: string[]): boolean {
  let method = "GET";
  let methodSeen = false;
  let endpoint: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") return false;
    if (["--field", "-F", "--form", "--raw-field", "-f", "--input", "--header", "-H", "--hostname"].includes(arg)) return false;
    if (/^(?:--field|--form|--raw-field|--input|--header|--hostname)=/.test(arg) || /^-(?:F|f|H).+/.test(arg)) return false;
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
    if (arg === "--output") {
      if (index + 1 >= args.length || !["json", "ndjson"].includes(args[++index])) return false;
      continue;
    }
    if (arg.startsWith("--output=")) {
      if (!["json", "ndjson"].includes(arg.slice("--output=".length))) return false;
      continue;
    }
    if (["--include", "-i", "--paginate", "--silent"].includes(arg)) continue;
    if (arg.startsWith("-")) return false;
    if (endpoint !== undefined) return false;
    endpoint = arg;
  }
  if (!endpoint || !["GET", "HEAD"].includes(method)) return false;
  if (endpoint.includes("://") || endpoint.startsWith("//") || endpoint.includes("\\") || endpoint.includes("%")) return false;
  const lowerEndpoint = endpoint.toLowerCase();
  if (/(^|\/)graphql(?:[/?]|$)/.test(lowerEndpoint)) return false;
  if (/[?&](?:_?method|http_method_override)=/i.test(lowerEndpoint) || /%5fmethod=/i.test(lowerEndpoint)) return false;
  return true;
}

export function isReadOnlyGlabInvocation(args: string[]): boolean {
  if (args.length === 0) return true;
  if (args.some((arg) => arg === "--help" || arg === "-h")) return true;
  if (args.length === 1 && ["--version", "-v", "version"].includes(args[0])) return true;
  if (args[0] === "help") return true;
  if (args.some((arg) => arg === "--web" || arg.startsWith("--web=") || arg === "-w" || /^-w.+/.test(arg) || arg === "--with-variables" || arg.startsWith("--with-variables="))) return false;
  if (args[0] === "api") return readOnlyGlabApiArgs(args.slice(1));
  if (hasUnsafeGlabExternalTarget(args)) return false;

  const normalized = normalizeGlabTargetArgs(args);
  if (!normalized || normalized.args.length < 2) return false;
  let command = normalized.args[0];
  const subcommand = normalized.args[1];
  if (command === "api") return false;
  if (command === "pipeline") command = "ci";

  const safeSubcommands: Record<string, Set<string>> = {
    issue: new Set(["list", "ls", "view", "show"]),
    mr: new Set(["approvers", "diff", "issues", "list", "ls", "view", "show"]),
    repo: new Set(["contributors", "list", "ls", "search", "view"]),
    release: new Set(["list", "ls", "view"]),
    ci: new Set(["get", "list", "status", "trace"]),
  };
  if (command === "ci" && subcommand === "config") return normalized.args[2] === "compile";
  return safeSubcommands[command]?.has(subcommand) ?? false;
}

function isNpmCredentialOrRegistryOverride(arg: string): boolean {
  if (!/^-{1,2}[^-]/.test(arg)) return false;
  const withoutDashes = arg.replace(/^-{1,2}/, "");
  const key = withoutDashes.slice(0, withoutDashes.indexOf("=") >= 0 ? withoutDashes.indexOf("=") : undefined).toLowerCase();
  return /^(?:reg|userc|globalc|_?auth|always-auth|otp|cert|key|caf|proxy|https-proxy|noproxy|strict-ssl|scope|prefix)/.test(key)
    || /(?:token|password)/.test(key);
}

export function isReadOnlyNpmInvocation(args: string[]): boolean {
  if (args.length === 0 || args.some((arg) => arg === "--help" || arg === "-h")) return true;
  if (args.length === 1 && ["--version", "-v"].includes(args[0])) return true;
  if (args.some(isNpmCredentialOrRegistryOverride)) return false;
  const index = args.findIndex((arg) => !arg.startsWith("-"));
  if (index < 0) return false;
  const aliases: Record<string, string> = {
    i: "install", in: "install", isntall: "install", t: "test", tst: "test", rb: "rebuild",
    rm: "uninstall", r: "uninstall", remove: "uninstall", unlink: "uninstall", up: "update",
    list: "ls", ll: "ls", la: "ls", x: "exec", "run-script": "run", show: "view", why: "explain",
  };
  const command = aliases[args[index]] ?? args[index];
  if (command === "config") return ["get", "list", "ls"].includes(args[index + 1]);
  if (command === "dist-tag") return ["ls", "list"].includes(args[index + 1]);
  return new Set([
    "install", "ci", "uninstall", "update", "dedupe", "prune", "rebuild", "run", "test", "exec", "start", "stop", "restart", "init",
    "ls", "view", "info", "search", "outdated", "explain", "root", "prefix", "bin", "pack", "ping", "doctor", "audit", "fund", "cache", "help", "help-search",
  ]).has(command);
}

const CLOUD_CONTROL_COMMANDS = new Set(["gcloud", "wrangler", "cloudflared", "cf"]);
export function isCloudControlInspection(command: string, args: string[]): boolean {
  if (!CLOUD_CONTROL_COMMANDS.has(command)) return false;
  if (args.length === 0 || args.some((arg) => arg === "--help" || arg === "-h" || arg === "-help")) return true;
  if (args.length === 1 && args[0] === "--version") return true;
  if (command === "gcloud") return args.length === 1 && args[0] === "version";
  return args.length === 1 && ["version", "-v"].includes(args[0]);
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
  const ghInvocations = command.matchAll(/(?:^|[\s;&|()])(?:[\w./-]+\/)?gh(?:\s+([^\n;&|)]*))?/gi);
  for (const match of ghInvocations) {
    if (!isReadOnlyGhInvocation(shellWords((match[1] ?? "").trim()))) {
      return "GitHub write operation is blocked by the read-only Git policy";
    }
  }
  const teaInvocations = command.matchAll(/(?:^|[\s;&|()])(?:[\w./-]+\/)?tea(?:\s+([^\n;&|)]*))?/gi);
  for (const match of teaInvocations) {
    if (!isReadOnlyTeaInvocation(shellWords((match[1] ?? "").trim()))) {
      return "Forgejo write operation is blocked by the read-only Git policy";
    }
  }
  const glabInvocations = command.matchAll(/(?:^|[\s;&|()])(?:[\w./-]+\/)?glab(?:\s+([^\n;&|)]*))?/gi);
  for (const match of glabInvocations) {
    if (!isReadOnlyGlabInvocation(shellWords((match[1] ?? "").trim()))) {
      return "GitLab write operation is blocked by the read-only Git policy";
    }
  }
  const npmInvocations = command.matchAll(/(?:^|[\s;&|()])(?:[\w./-]+\/)?npm\b(?:\s+([^\n;&|)]*))?/gi);
  for (const match of npmInvocations) {
    if (!isReadOnlyNpmInvocation(shellWords((match[1] ?? "").trim()))) {
      return "npm registry write operation is blocked by the restricted credential policy";
    }
  }
  const cloudInvocations = command.matchAll(/(?:^|[\s;&|()])(?:[\w./-]+\/)?(gcloud|wrangler|cloudflared|cf)\b(?:\s+([^\n;&|)]*))?/gi);
  for (const match of cloudInvocations) {
    const name = match[1].toLowerCase();
    if (!isCloudControlInspection(name, shellWords((match[2] ?? "").trim()))) {
      return `${name} control operation is blocked by the restricted credential policy`;
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

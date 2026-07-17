import { access, copyFile, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { Harness } from "./types.ts";

export interface WorkerRuntime {
  root: string;
  workerRoot: string;
  environment: Record<string, string>;
  writablePaths: string[];
  readOnlyPaths: string[];
  inaccessiblePaths: string[];
  bindPaths: string[];
  extraArgs: string[];
}

async function copyOptional(source: string, destination: string): Promise<void> {
  try {
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(source, destination);
  } catch {
    // Optional harness configuration or auth may not exist on every installation.
  }
}

async function copyAllowedShellEnvironment(source: string, destination: string, allowed: Set<string>): Promise<void> {
  try {
    const lines = (await readFile(source, "utf8")).split("\n").filter((line) => {
      const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
      return match ? allowed.has(match[1]) : /^\s*(?:#.*)?$/.test(line);
    });
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, `${lines.join("\n").trimEnd()}\n`, { mode: 0o600 });
  } catch {
    // Optional provider environment may not exist on every installation.
  }
}

async function symlinkOptional(source: string, destination: string): Promise<void> {
  try {
    await access(source);
    await rm(destination, { recursive: true, force: true });
    await symlink(source, destination);
  } catch {
    // Optional skills/plugins may not exist on every installation.
  }
}

async function copyJsonWithFilter(source: string, destination: string, filter: (value: any) => any, copyOnParseFailure = true): Promise<void> {
  try {
    const value = JSON.parse(await readFile(source, "utf8"));
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, `${JSON.stringify(filter(value), null, 2)}\n`, { mode: 0o600 });
  } catch {
    if (copyOnParseFailure) await copyOptional(source, destination);
  }
}

export function workerRuntimeRoot(workerId: string, agentDir: string): string {
  return join(agentDir, "intercom", "orchestrator", "worker-runtime", workerId);
}

export function workerSocketRuntimeRoot(_workerId: string, runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid?.() ?? ""}`): string {
  return join(runtimeDir, "agent-intercom-worker");
}

export async function prepareWorkerRuntime(
  harness: Harness,
  workerId: string,
  agentDir: string,
  options: { homeDir?: string; runtimeDir?: string } = {},
): Promise<WorkerRuntime> {
  const sourceHome = options.homeDir ?? homedir();
  const root = workerRuntimeRoot(workerId, agentDir);
  const runtimeDir = options.runtimeDir ?? process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? ""}`;
  const workerRoot = workerSocketRuntimeRoot(workerId, runtimeDir);
  const legacyWorkerRoot = join(runtimeDir, "agent-intercom-workers");
  const toPersistent = (workerPath: string) => join(root, relative(workerRoot, workerPath));
  const home = join(workerRoot, "home");
  const privateAgentDir = join(workerRoot, "pi-agent");
  const privateIntercomDir = join(privateAgentDir, "intercom");

  await Promise.all([
    mkdir(root, { recursive: true, mode: 0o700 }),
    mkdir(workerRoot, { recursive: true, mode: 0o700 }),
    mkdir(legacyWorkerRoot, { recursive: true, mode: 0o700 }),
    mkdir(toPersistent(home), { recursive: true, mode: 0o700 }),
    mkdir(toPersistent(privateIntercomDir), { recursive: true, mode: 0o700 }),
  ]);

  for (const file of ["settings.json", "auth.json", "models.json", "trust.json"]) {
    await copyOptional(join(agentDir, file), toPersistent(join(privateAgentDir, file)));
  }
  for (const directory of ["extensions", "git", "npm", "skills"]) {
    await symlinkOptional(join(agentDir, directory), toPersistent(join(privateAgentDir, directory)));
  }
  await copyOptional(join(agentDir, "intercom", "config.json"), toPersistent(join(privateIntercomDir, "config.json")));

  const environment: Record<string, string> = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_RUNTIME_DIR: workerRoot,
    PI_CODING_AGENT_DIR: privateAgentDir,
    AGENT_INTERCOM_BROKER_SOURCE: join(agentDir, "intercom", "broker.sock"),
    AGENT_INTERCOM_MASK_PATHS: JSON.stringify([join(agentDir, "intercom"), legacyWorkerRoot]),
    MISE_DATA_DIR: join(sourceHome, ".local", "share", "mise"),
    MISE_CONFIG_DIR: join(sourceHome, ".config", "mise"),
    MISE_CACHE_DIR: join(home, ".cache", "mise"),
    RUSTUP_HOME: join(sourceHome, ".rustup"),
    CARGO_HOME: join(home, ".cargo"),
    NPM_CONFIG_CACHE: join(home, ".cache", "npm"),
    PIP_CACHE_DIR: join(home, ".cache", "pip"),
    UV_CACHE_DIR: join(home, ".cache", "uv"),
  };
  await rm(toPersistent(join(home, ".local", "bin")), { recursive: true, force: true });
  await rm(toPersistent(join(home, "src")), { recursive: true, force: true });
  await Promise.all([
    environment.XDG_CONFIG_HOME,
    environment.XDG_DATA_HOME,
    environment.XDG_STATE_HOME,
    environment.XDG_CACHE_HOME,
    join(home, ".local", "bin"),
    join(home, "src", "github.com", "dataforxyz"),
  ].map((path) => mkdir(toPersistent(path), { recursive: true, mode: 0o700 })));
  for (const file of ["_cliproxy-env", "_codex-cliproxy-args"]) {
    await copyOptional(join(sourceHome, ".local", "bin", file), toPersistent(join(home, ".local", "bin", file)));
  }
  for (const repository of ["agent-intercom-codex", "agent-intercom-claude"]) {
    await symlinkOptional(
      join(sourceHome, "src", "github.com", "dataforxyz", repository),
      toPersistent(join(home, "src", "github.com", "dataforxyz", repository)),
    );
  }
  await copyAllowedShellEnvironment(
    join(sourceHome, ".config", "claude-aliases", "env"),
    toPersistent(join(home, ".config", "claude-aliases", "env")),
    new Set(["CLIPROXY_API_KEY", "CLIPROXY_BASE_URL", "CLIPROXY_CLAUDE_MODEL"]),
  );

  const writablePaths: string[] = [];
  const readOnlyPaths: string[] = [];
  const inaccessiblePaths = [dirname(root)];
  const bindPaths = [`${root}:${workerRoot}`];
  const extraArgs: string[] = [];

  if (harness === "pi") {
    environment.PI_CODING_AGENT_SESSION_DIR = join(workerRoot, "pi-sessions");
    await mkdir(toPersistent(environment.PI_CODING_AGENT_SESSION_DIR), { recursive: true, mode: 0o700 });
    return { root, workerRoot, environment, writablePaths, readOnlyPaths, inaccessiblePaths, bindPaths, extraArgs };
  }

  if (harness === "codex") {
    const source = join(sourceHome, ".codex");
    const target = join(home, ".codex");
    await mkdir(toPersistent(target), { recursive: true, mode: 0o700 });
    for (const file of ["auth.json", "config.toml", "cliproxy.config.toml", "installation_id", "AGENTS.md", "RTK.md", "models_cache.json"]) {
      await copyOptional(join(source, file), toPersistent(join(target, file)));
    }
    for (const directory of ["rules", "skills", "plugins", "vendor_imports"]) {
      await symlinkOptional(join(source, directory), toPersistent(join(target, directory)));
    }
    environment.CODEX_HOME = target;
    extraArgs.push(
      "-c", `mcp_servers.codex-intercom.env.PI_CODING_AGENT_DIR=${JSON.stringify(privateAgentDir)}`,
      "--state", join(workerRoot, "coi-state.json"),
      "--socket", join(workerRoot, "coi.sock"),
    );
  } else if (harness === "claude") {
    const source = join(sourceHome, ".claude");
    const target = join(home, ".claude");
    await mkdir(toPersistent(target), { recursive: true, mode: 0o700 });
    await rm(toPersistent(join(home, ".claude.json")), { force: true });
    await copyJsonWithFilter(join(source, "settings.json"), toPersistent(join(target, "settings.json")), (value) => {
      if (!value?.hooks) return value;
      const hooks = Object.fromEntries(Object.entries(value.hooks).map(([event, groups]: [string, any]) => [
        event,
        Array.isArray(groups)
          ? groups.map((group: any) => ({ ...group, hooks: Array.isArray(group?.hooks) ? group.hooks.filter((hook: any) => !String(hook?.command ?? "").includes("omarchy-session")) : group?.hooks })).filter((group: any) => group.hooks?.length)
          : groups,
      ]));
      return { ...value, hooks };
    });
    for (const file of ["CLAUDE.md", "RTK.md"]) await copyOptional(join(source, file), toPersistent(join(target, file)));
    for (const directory of ["plugins", "skills"]) await symlinkOptional(join(source, directory), toPersistent(join(target, directory)));
    const aliasProfile = join(home, ".config", "claude-aliases", "profiles", "cliproxy");
    await mkdir(toPersistent(aliasProfile), { recursive: true, mode: 0o700 });
    await copyOptional(join(sourceHome, ".config", "claude-aliases", "profiles", "cliproxy", "settings.json"), toPersistent(join(aliasProfile, "settings.json")));
    await copyJsonWithFilter(
      join(sourceHome, ".config", "claude-aliases", "profiles", "cliproxy", ".claude.json"),
      toPersistent(join(aliasProfile, ".claude.json")),
      (value) => {
        const { projects: _projects, ...safe } = value ?? {};
        return safe;
      },
      false,
    );
    await rm(toPersistent(join(aliasProfile, ".git-credentials")), { force: true });
    environment.CLAUDE_CONFIG_DIR = aliasProfile;
    extraArgs.push("--dangerously-skip-permissions", "--state", join(workerRoot, "claude-state.json"));
  } else {
    const config = join(home, ".config", "opencode");
    const data = join(home, ".local", "share", "opencode");
    const state = join(home, ".local", "state", "opencode");
    const cache = join(home, ".cache", "opencode");
    await Promise.all([config, data, state, cache].map((path) => mkdir(toPersistent(path), { recursive: true, mode: 0o700 })));
    await rm(toPersistent(join(config, "plugins")), { recursive: true, force: true });
    await copyJsonWithFilter(join(sourceHome, ".config", "opencode", "opencode.json"), toPersistent(join(config, "opencode.json")), (value) => ({
      ...value,
      plugin: Array.isArray(value?.plugin) ? value.plugin.filter((entry: unknown) => !String(entry).includes("omarchy-session-registry")) : value?.plugin,
    }));
    for (const file of ["tui.json", "package.json", "package-lock.json"]) {
      await copyOptional(join(sourceHome, ".config", "opencode", file), toPersistent(join(config, file)));
    }
    await symlinkOptional(join(sourceHome, ".config", "opencode", "node_modules"), toPersistent(join(config, "node_modules")));
    await copyOptional(join(sourceHome, ".local", "share", "opencode", "auth.json"), toPersistent(join(data, "auth.json")));
    await rm(toPersistent(join(data, "account.json")), { force: true });
    await symlinkOptional(join(sourceHome, ".local", "share", "opencode", "bin"), toPersistent(join(data, "bin")));
  }
  return { root, workerRoot, environment, writablePaths, readOnlyPaths, inaccessiblePaths, bindPaths, extraArgs };
}

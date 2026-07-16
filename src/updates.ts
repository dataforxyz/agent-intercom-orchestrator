import { access, readFile, realpath } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export type AdapterId = "pi" | "codex" | "claude" | "opencode" | "orchestrator";

export interface UpdateCommand {
  command: string;
  args: string[];
  display: string;
}

export interface AdapterVersion {
  id: AdapterId;
  packageName: string;
  current?: string;
  latest?: string;
  source: "pi-git" | "pi-npm" | "npm-global" | "git" | "local" | "missing";
  root?: string;
  sourceSpec?: string;
  status: "current" | "outdated" | "ahead" | "missing" | "unknown";
  update?: UpdateCommand;
  blockedReason?: string;
}

export interface HarnessVersion {
  harness: "pi" | "codex" | "claude" | "opencode";
  version?: string;
  command?: string;
}

const ADAPTERS: Array<{ id: AdapterId; packageName: string; repo: string; binary?: "coi" | "cci" }> = [
  { id: "pi", packageName: "@dataforxyz/agent-intercom-pi", repo: "agent-intercom-pi" },
  { id: "codex", packageName: "@dataforxyz/agent-intercom-codex", repo: "agent-intercom-codex", binary: "coi" },
  { id: "claude", packageName: "@dataforxyz/agent-intercom-claude", repo: "agent-intercom-claude", binary: "cci" },
  { id: "opencode", packageName: "@dataforxyz/agent-intercom-opencode", repo: "agent-intercom-opencode" },
  { id: "orchestrator", packageName: "@dataforxyz/agent-intercom-orchestrator", repo: "agent-intercom-orchestrator" },
];

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@+-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function commandSpec(command: string, args: string[]): UpdateCommand {
  return { command, args, display: [command, ...args].map(shellQuote).join(" ") };
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function readJson(path: string): Promise<any | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return undefined; }
}

async function packageRootFrom(start: string | undefined, packageName: string): Promise<string | undefined> {
  if (!start) return undefined;
  let current: string;
  try {
    const resolved = await realpath(start);
    current = (await exists(join(resolved, "package.json"))) ? resolved : dirname(resolved);
  } catch {
    return undefined;
  }
  const root = parse(current).root;
  while (current !== root) {
    const manifest = await readJson(join(current, "package.json"));
    if (manifest?.name === packageName) return current;
    current = dirname(current);
  }
  return undefined;
}

async function versionAt(root: string | undefined): Promise<string | undefined> {
  if (!root) return undefined;
  const manifest = await readJson(join(root, "package.json"));
  return typeof manifest?.version === "string" ? manifest.version : undefined;
}

function gitRoot(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const result = spawnSync("git", ["-C", path, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

function gitDirty(path: string): boolean {
  const result = spawnSync("git", ["-C", path, "status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return result.status !== 0 || Boolean(result.stdout.trim());
}

function npmGlobalRoot(): string | undefined {
  const result = spawnSync("npm", ["root", "-g"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

async function piPackageSources(agentDir: string): Promise<string[]> {
  const settings = await readJson(join(agentDir, "settings.json"));
  return Array.isArray(settings?.packages) ? settings.packages.filter((entry: unknown): entry is string => typeof entry === "string") : [];
}

function sourceMatches(source: string, adapter: { packageName: string; repo: string }): boolean {
  return source.includes(adapter.packageName) || source.includes(`dataforxyz/${adapter.repo}`);
}

function rootFromPiSource(agentDir: string, source: string, adapter: { packageName: string; repo: string }): string | undefined {
  if (source.startsWith("git:github.com/")) return join(agentDir, "git", "github.com", "dataforxyz", adapter.repo);
  if (source.startsWith("npm:")) return join(agentDir, "npm", "node_modules", "@dataforxyz", adapter.repo);
  return undefined;
}

async function configuredOpenCodePluginRoot(home: string | undefined, packageName: string): Promise<string | undefined> {
  if (!home) return undefined;
  for (const file of [join(home, ".config", "opencode", "opencode.json"), join(home, ".config", "opencode", "opencode.jsonc")]) {
    const config = await readJson(file);
    if (!Array.isArray(config?.plugin)) continue;
    for (const entry of config.plugin) {
      if (typeof entry !== "string" || !entry.includes("agent-intercom-opencode")) continue;
      const root = await packageRootFrom(resolve(entry), packageName);
      if (root) return root;
    }
  }
  return undefined;
}

export async function fetchLatestNpmVersion(packageName: string): Promise<string | undefined> {
  try {
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return undefined;
    const body = await response.json() as { version?: unknown };
    return typeof body.version === "string" ? body.version : undefined;
  } catch {
    return undefined;
  }
}

function statusFor(current: string | undefined, latest: string | undefined): AdapterVersion["status"] {
  if (!current) return "missing";
  if (!latest) return "unknown";
  if (current === latest) return "current";
  const comparison = current.localeCompare(latest, undefined, { numeric: true, sensitivity: "base" });
  return comparison < 0 ? "outdated" : "ahead";
}

export async function inspectAdapterFamily(options: {
  agentDir: string;
  currentPackageRoot: string;
  commandPaths?: Partial<Record<"coi" | "cci", string>>;
  home?: string;
  latest?: (packageName: string) => Promise<string | undefined>;
  globalNpmRoot?: string;
}): Promise<AdapterVersion[]> {
  const latestResolver = options.latest ?? fetchLatestNpmVersion;
  const piSources = await piPackageSources(options.agentDir);
  const globalRoot = options.globalNpmRoot ?? npmGlobalRoot();
  const results: AdapterVersion[] = [];
  const latestByPackage = new Map(await Promise.all(ADAPTERS.map(async (adapter) => [adapter.packageName, await latestResolver(adapter.packageName)] as const)));

  for (const adapter of ADAPTERS) {
    const sourceSpec = piSources.find((source) => sourceMatches(source, adapter));
    let root = sourceSpec ? rootFromPiSource(options.agentDir, sourceSpec, adapter) : undefined;
    if (adapter.id === "orchestrator") root = root ?? options.currentPackageRoot;
    if (adapter.binary) root = root ?? await packageRootFrom(options.commandPaths?.[adapter.binary], adapter.packageName);
    if (adapter.id === "opencode") root = root ?? await configuredOpenCodePluginRoot(options.home, adapter.packageName);
    root = root ?? (globalRoot ? await packageRootFrom(join(globalRoot, "@dataforxyz", adapter.repo), adapter.packageName) : undefined);
    if (root && !(await exists(root))) root = undefined;

    const current = await versionAt(root);
    const latest = latestByPackage.get(adapter.packageName);
    let source: AdapterVersion["source"] = "missing";
    if (sourceSpec?.startsWith("git:")) source = "pi-git";
    else if (sourceSpec?.startsWith("npm:")) source = "pi-npm";
    else if (root && globalRoot && resolve(root).startsWith(`${resolve(globalRoot)}/`)) source = "npm-global";
    else if (root && gitRoot(root)) source = "git";
    else if (root) source = "local";

    let update: UpdateCommand | undefined;
    let blockedReason: string | undefined;
    if (sourceSpec) {
      if (/@v?\d+\.\d+\.\d+(?:$|[#?])/.test(sourceSpec)) {
        blockedReason = `Pi package source is pinned: ${sourceSpec}`;
      } else {
        update = commandSpec("pi", ["update", "--extension", sourceSpec]);
      }
    } else if (source === "npm-global") {
      update = commandSpec("npm", ["install", "-g", `${adapter.packageName}@${latest ?? "latest"}`]);
    } else if (source === "missing" && (adapter.id === "pi" || adapter.id === "orchestrator")) {
      update = commandSpec("pi", ["install", `npm:${adapter.packageName}@${latest ?? "latest"}`]);
    } else if (source === "missing") {
      update = commandSpec("npm", ["install", "-g", `${adapter.packageName}@${latest ?? "latest"}`]);
    } else if (source === "git" && root) {
      const repository = gitRoot(root)!;
      if (gitDirty(repository)) blockedReason = `Git checkout is dirty: ${repository}`;
      else update = commandSpec("git", ["-C", repository, "pull", "--ff-only"]);
    } else if (source === "local") {
      blockedReason = `Local package source is not safely updateable: ${root}`;
    }

    results.push({ id: adapter.id, packageName: adapter.packageName, current, latest, source, root, sourceSpec, status: statusFor(current, latest), update, blockedReason });
  }
  return results;
}

export function formatAdapterVersions(adapters: AdapterVersion[]): string {
  const lines = ["Agent Intercom adapters:"];
  for (const adapter of adapters) {
    lines.push(`- ${adapter.id}: installed=${adapter.current ?? "missing"} latest=${adapter.latest ?? "unknown"} source=${adapter.source} status=${adapter.status}`);
  }
  return lines.join("\n");
}

export function formatUpdatePlan(adapters: AdapterVersion[]): string {
  const pending = adapters.filter((adapter) => adapter.status === "outdated" || adapter.status === "missing");
  if (!pending.length) return "All detected Agent Intercom adapters are current.";
  const lines = ["Agent Intercom update plan:"];
  for (const adapter of pending) {
    lines.push(`- ${adapter.id}: ${adapter.current ?? "missing"} -> ${adapter.latest ?? "latest"}`);
    if (adapter.update) lines.push(`  ${adapter.update.display}`);
    else lines.push(`  blocked: ${adapter.blockedReason ?? "no safe update command detected"}`);
  }
  return lines.join("\n");
}

export function detectHarnessVersions(commandPaths: Partial<Record<"pi" | "codex" | "claude" | "opencode", string>>): HarnessVersion[] {
  return (["pi", "codex", "claude", "opencode"] as const).map((harness) => {
    const command = commandPaths[harness];
    if (!command) return { harness };
    const result = spawnSync(command, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    const version = result.status === 0 ? result.stdout.trim().split(/\r?\n/, 1)[0] : undefined;
    return { harness, command, version };
  });
}

export function formatHarnessVersions(harnesses: HarnessVersion[]): string {
  return ["Harness CLIs:", ...harnesses.map((entry) => `- ${entry.harness}: ${entry.version ?? "not detected"}${entry.command ? ` (${entry.command})` : ""}`)].join("\n");
}

#!/usr/bin/env node
import { accessSync, constants, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);

function safeRepo(value) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) return false;
  return value.split("/").every((segment) => segment !== "." && segment !== "..");
}

function unsafeExternalTarget(argv) {
  return argv.some((arg) => /[\u0000-\u001f\u007f]/.test(arg)
    || arg.includes("://")
    || arg.startsWith("//")
    || arg.includes("\\")
    || arg.includes("@")
    || arg.includes(":")
    || arg.includes("%"));
}

function normalizeTargetArgs(argv) {
  const normalized = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") return undefined;
    if (arg === "-R" || arg === "--repo") {
      if (index + 1 >= argv.length || !safeRepo(argv[index + 1])) return undefined;
      index += 1;
      continue;
    }
    if (arg.startsWith("--repo=")) {
      if (!safeRepo(arg.slice("--repo=".length))) return undefined;
      continue;
    }
    if (/^-R.+/.test(arg)) {
      if (!safeRepo(arg.slice(2).replace(/^=/, ""))) return undefined;
      continue;
    }
    normalized.push(arg);
  }
  return normalized;
}

function readOnlyApi(argv) {
  let method = "GET";
  let methodSeen = false;
  let endpoint;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") return false;
    if (["--field", "-F", "--raw-field", "-f", "--input", "--header", "-H", "--hostname", "--cache", "--preview", "-p", "--jq", "-q", "--template", "-t"].includes(arg)) return false;
    if (/^(?:--field|--raw-field|--input|--header|--hostname|--cache|--preview|--jq|--template)=/.test(arg) || /^-(?:F|f|H|p|q|t).+/.test(arg)) return false;
    if (arg === "--method" || arg === "-X") {
      if (methodSeen || index + 1 >= argv.length) return false;
      methodSeen = true;
      method = argv[++index].toUpperCase();
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

function isReadOnlyInvocation(argv) {
  if (argv.length === 0) return true;
  if (argv.some((arg) => arg === "--help" || arg === "-h")) return true;
  if (argv.length === 1 && ["--version", "version"].includes(argv[0])) return true;
  if (argv[0] === "help") return true;
  if (argv.some((arg) => arg === "--web" || arg.startsWith("--web=") || arg === "-w" || /^-w.+/.test(arg) || arg === "--browser" || arg.startsWith("--browser=") || arg === "--hostname" || arg.startsWith("--hostname=") || arg === "--show-token" || arg.startsWith("--show-token=") || arg === "-t" || /^-t.+/.test(arg))) return false;
  if (argv[0] === "api") return readOnlyApi(argv.slice(1));
  if (unsafeExternalTarget(argv)) return false;
  const normalized = normalizeTargetArgs(argv);
  if (!normalized?.length) return false;
  const [command, subcommand] = normalized;
  if (command === "status") return normalized.length === 1;
  if (command === "search") return ["code", "commits", "issues", "prs", "repos"].includes(subcommand);
  const safe = {
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

if (!isReadOnlyInvocation(args)) {
  process.stderr.write(`gh ${args.slice(0, 3).join(" ") || "write"} blocked by Agent Intercom read-only remote policy\n`);
  process.exit(126);
}

const configured = process.env.AGENT_INTERCOM_REAL_GH || "/usr/bin/gh";
function trustedExecutable(path) {
  if (!isAbsolute(path) || basename(path) !== "gh") return undefined;
  let resolved;
  try {
    resolved = realpathSync(path);
    if (basename(resolved) !== "gh") return undefined;
    accessSync(resolved, constants.X_OK);
    for (const candidate of new Set([path, resolved])) {
      let current = candidate;
      while (true) {
        try { accessSync(current, constants.W_OK); return undefined; } catch {}
        if (current === "/") break;
        current = dirname(current);
      }
    }
  } catch {
    return undefined;
  }
  return resolved;
}

const realGh = trustedExecutable(configured);
if (!realGh) {
  process.stderr.write(`Refusing untrusted real gh path ${configured}\n`);
  process.exit(127);
}

const configDir = mkdtempSync("/tmp/agent-intercom-gh.");
const environment = { ...process.env,
  GH_CONFIG_DIR: configDir,
  GH_PAGER: "/bin/cat",
  PAGER: "/bin/cat",
  GH_BROWSER: "/bin/false",
  BROWSER: "/bin/false",
  GH_EDITOR: "/bin/false",
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
  GH_TELEMETRY: "false",
};
for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_HOST", "GH_REPO", "GH_DEBUG", "DEBUG", "GH_PATH"]) delete environment[name];

const cleanup = () => rmSync(configDir, { recursive: true, force: true });
const child = spawn(realGh, args, { stdio: "inherit", env: environment });
child.on("error", (error) => {
  cleanup();
  process.stderr.write(`Could not execute real gh at ${configured}: ${error.message}\n`);
  process.exit(127);
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  cleanup();
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});

#!/usr/bin/env node
import { accessSync, constants, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import { spawn } from "node:child_process";

const configuredGit = process.env.AGENT_INTERCOM_REAL_GIT || "/usr/bin/git";
const args = process.argv.slice(2);

function commandIndex(argv) {
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === "-C" || arg === "-c" || arg === "--git-dir" || arg === "--work-tree") {
      index += 2;
      continue;
    }
    if (arg === "--no-pager" || arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=")) {
      index += 1;
      continue;
    }
    return index;
  }
  return -1;
}

function isReadOnlyInvocation(argv) {
  const index = commandIndex(argv);
  if (index < 0) return true;
  const command = argv[index];
  const rest = argv.slice(index + 1);
  if (["--version", "version", "--help", "help"].includes(command)) return true;
  const safe = new Set([
    "status", "diff", "log", "show", "rev-parse", "ls-files", "ls-tree", "grep", "blame",
    "shortlog", "describe", "name-rev", "cat-file", "for-each-ref",
  ]);
  if (safe.has(command)) return true;
  if (command === "branch") return rest.length === 0 || rest.every((arg) => ["-a", "--all", "-r", "--remotes", "-v", "-vv", "--show-current", "--list"].includes(arg));
  if (command === "tag") return rest.length === 0 || rest[0] === "-l" || rest[0] === "--list";
  if (command === "remote") return rest.length === 0 || rest[0] === "-v" || rest[0] === "get-url";
  if (command === "config") return rest.some((arg) => ["--get", "--get-all", "--get-regexp", "--list", "--show-origin", "--show-scope"].includes(arg))
    && !rest.some((arg) => ["--add", "--replace-all", "--unset", "--unset-all", "--rename-section", "--remove-section"].includes(arg));
  if (command === "stash") return rest[0] === "list" || rest[0] === "show";
  return false;
}

if (!isReadOnlyInvocation(args)) {
  const index = commandIndex(args);
  const command = index >= 0 ? args[index] : "mutation";
  process.stderr.write(`git ${command} blocked by Agent Intercom permission profile ${process.env.AGENT_INTERCOM_PERMISSION_PROFILE || "read-only"}\n`);
  process.exit(126);
}

function trustedExecutable(path) {
  if (!isAbsolute(path) || basename(path) !== "git") return undefined;
  try {
    const resolved = realpathSync(path);
    if (basename(resolved) !== "git") return undefined;
    accessSync(resolved, constants.X_OK);
    for (const candidate of new Set([path, resolved])) {
      let current = candidate;
      while (true) {
        try { accessSync(current, constants.W_OK); return undefined; } catch {}
        if (current === "/") break;
        current = dirname(current);
      }
    }
    return resolved;
  } catch {
    return undefined;
  }
}
const realGit = trustedExecutable(configuredGit);
if (!realGit) {
  process.stderr.write(`Refusing untrusted real git path ${configuredGit}\n`);
  process.exit(127);
}
const environment = { ...process.env,
  GIT_ASKPASS: "/bin/false",
  SSH_ASKPASS: "/bin/false",
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_PAGER: "/bin/cat",
  PAGER: "/bin/cat",
  GIT_EDITOR: "/bin/false",
};
for (const name of ["SSH_AUTH_SOCK", "GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_EXTERNAL_DIFF", "GIT_DIFF_OPTS"]) delete environment[name];
for (const name of Object.keys(environment)) if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(name)) delete environment[name];
const child = spawn(realGit, args, { stdio: "inherit", env: environment });
child.on("error", (error) => {
  process.stderr.write(`Could not execute real git at ${configuredGit}: ${error.message}\n`);
  process.exit(127);
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});

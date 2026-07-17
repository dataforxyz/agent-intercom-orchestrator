#!/usr/bin/env node
import { accessSync, constants, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const aliases = new Map([
  ["i", "install"], ["in", "install"], ["isntall", "install"],
  ["t", "test"], ["tst", "test"], ["rb", "rebuild"],
  ["rm", "uninstall"], ["r", "uninstall"], ["remove", "uninstall"], ["unlink", "uninstall"],
  ["up", "update"], ["list", "ls"], ["ll", "ls"], ["la", "ls"],
  ["x", "exec"], ["run-script", "run"], ["show", "view"], ["why", "explain"],
]);
const safeCommands = new Set([
  "install", "ci", "uninstall", "update", "dedupe", "prune", "rebuild",
  "run", "test", "exec", "start", "stop", "restart", "init",
  "ls", "view", "info", "search", "outdated", "explain", "root", "prefix", "bin",
  "pack", "ping", "doctor", "audit", "fund", "cache", "help", "help-search",
]);

function hasCredentialOrRegistryOverride(arg) {
  if (!/^-{1,2}[^-]/.test(arg)) return false;
  const withoutDashes = arg.replace(/^-{1,2}/, "");
  const key = withoutDashes.slice(0, withoutDashes.indexOf("=") >= 0 ? withoutDashes.indexOf("=") : undefined).toLowerCase();
  return /^(?:reg|userc|globalc|_?auth|always-auth|otp|cert|key|caf|proxy|https-proxy|noproxy|strict-ssl|scope|prefix)/.test(key)
    || /(?:token|password)/.test(key);
}

function isReadOnlyRemoteInvocation(argv) {
  if (argv.length === 0 || argv.some((arg) => arg === "--help" || arg === "-h")) return true;
  if (argv.length === 1 && ["--version", "-v"].includes(argv[0])) return true;
  if (argv.some(hasCredentialOrRegistryOverride)) return false;
  const commandIndex = argv.findIndex((arg) => !arg.startsWith("-"));
  if (commandIndex < 0) return false;
  const raw = argv[commandIndex];
  const command = aliases.get(raw) || raw;
  if (command === "config") return ["get", "list", "ls"].includes(argv[commandIndex + 1]);
  if (command === "dist-tag") return ["ls", "list"].includes(argv[commandIndex + 1]);
  return safeCommands.has(command);
}

if (!isReadOnlyRemoteInvocation(args)) {
  process.stderr.write(`npm ${args.slice(0, 3).join(" ") || "remote write"} blocked by Agent Intercom registry policy\n`);
  process.exit(126);
}

const configured = process.env.AGENT_INTERCOM_REAL_NPM || "/usr/bin/npm";
function trustedExecutable(path) {
  if (!isAbsolute(path) || basename(path) !== "npm") return undefined;
  try {
    const resolved = realpathSync(path);
    accessSync(path, constants.X_OK);
    accessSync(resolved, constants.X_OK);
    for (const candidate of new Set([path, resolved])) {
      let current = candidate;
      while (true) {
        try { accessSync(current, constants.W_OK); return undefined; } catch {}
        if (current === "/") break;
        current = dirname(current);
      }
    }
    return path;
  } catch {
    return undefined;
  }
}

const realNpm = trustedExecutable(configured);
if (!realNpm) {
  process.stderr.write(`Refusing untrusted real npm path ${configured}\n`);
  process.exit(127);
}

const configDir = mkdtempSync("/tmp/agent-intercom-npm.");
const userConfig = `${configDir}/user.npmrc`;
const globalConfig = `${configDir}/global.npmrc`;
writeFileSync(userConfig, "", { mode: 0o600 });
writeFileSync(globalConfig, "", { mode: 0o600 });
const environment = { ...process.env,
  NPM_CONFIG_USERCONFIG: userConfig,
  npm_config_userconfig: userConfig,
  NPM_CONFIG_GLOBALCONFIG: globalConfig,
  npm_config_globalconfig: globalConfig,
  NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
  npm_config_registry: "https://registry.npmjs.org/",
  NPM_CONFIG_PROVENANCE: "false",
};
for (const name of [
  "NPM_TOKEN", "NODE_AUTH_TOKEN", "NPM_AUTH_TOKEN", "YARN_NPM_AUTH_TOKEN", "BUN_AUTH_TOKEN",
  "NPM_CONFIG__AUTH", "NPM_CONFIG__AUTHTOKEN", "npm_config__auth", "npm_config__authToken",
  "NPM_CONFIG_EMAIL", "NPM_CONFIG_USERNAME", "NPM_CONFIG_PASSWORD",
]) delete environment[name];
for (const name of Object.keys(environment)) {
  if (/^(?:NPM_CONFIG|npm_config)_.+(?:AUTH|TOKEN|PASSWORD|USERNAME|EMAIL)/i.test(name)) delete environment[name];
}

const cleanup = () => rmSync(configDir, { recursive: true, force: true });
const child = spawn(realNpm, args, { stdio: "inherit", env: environment });
child.on("error", (error) => {
  cleanup();
  process.stderr.write(`Could not execute real npm at ${configured}: ${error.message}\n`);
  process.exit(127);
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => {
  cleanup();
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});

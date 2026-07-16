#!/usr/bin/env node
const separator = process.argv.indexOf("--");
const commandArgs = separator >= 0 ? process.argv.slice(separator + 1) : process.argv.slice(2);
const [command, ...args] = commandArgs;
if (!command) {
  process.stderr.write("clean-env-launcher requires a command after --\n");
  process.exit(2);
}

const baseAllowed = new Set([
  "HOME", "USER", "LOGNAME", "SHELL", "PATH", "LANG", "LANGUAGE", "TERM", "COLORTERM", "TZ",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
]);
for (const key of (process.env.AGENT_INTERCOM_ENV_ALLOWLIST || "").split(",")) {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) baseAllowed.add(key);
}
const environment = {};
for (const key of baseAllowed) {
  if (process.env[key] !== undefined) environment[key] = process.env[key];
}
delete environment.AGENT_INTERCOM_ENV_ALLOWLIST;

try {
  process.execve(command, [command, ...args], environment);
} catch (error) {
  process.stderr.write(`Could not exec ${command} with clean environment: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(127);
}

#!/usr/bin/env node
import { accessSync, constants, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import { spawn } from "node:child_process";

const [cli, ...args] = process.argv.slice(2);
const supported = new Set(["gcloud", "wrangler", "cloudflared", "cf"]);
if (!supported.has(cli)) {
  process.stderr.write(`Unsupported cloud-control guard name: ${cli}\n`);
  process.exit(127);
}

function safeInvocation() {
  if (args.length === 0 || args.some((arg) => arg === "--help" || arg === "-h" || arg === "-help")) return true;
  if (args.length === 1 && args[0] === "--version") return true;
  if (cli === "gcloud") return args.length === 1 && args[0] === "version";
  if (["wrangler", "cloudflared", "cf"].includes(cli)) return args.length === 1 && ["version", "-v"].includes(args[0]);
  return false;
}

if (!safeInvocation()) {
  process.stderr.write(`${cli} ${args.slice(0, 3).join(" ") || "control operation"} blocked by Agent Intercom cloud-control policy\n`);
  process.exit(126);
}

const envName = `AGENT_INTERCOM_REAL_${cli.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
const configured = process.env[envName] || `/usr/bin/${cli}`;
function trustedExecutable(path) {
  if (!isAbsolute(path) || basename(path) !== cli) return undefined;
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
const executable = trustedExecutable(configured);
if (!executable) {
  process.stderr.write(`Refusing untrusted real ${cli} path ${configured}\n`);
  process.exit(127);
}

const environment = { ...process.env };
for (const name of [
  "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_APPLICATION_CREDENTIALS_JSON", "GOOGLE_CREDENTIALS", "GOOGLE_OAUTH_ACCESS_TOKEN", "GOOGLE_GHA_CREDS_PATH", "GOOGLE_API_KEY", "CLOUDSDK_CONFIG", "CLOUDSDK_AUTH_ACCESS_TOKEN", "CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE", "CLOUDSDK_CORE_ACCOUNT", "CLOUDSDK_CORE_PROJECT", "CLOUDSDK_ACTIVE_CONFIG_NAME", "GCE_METADATA_HOST", "GCE_METADATA_IP",
  "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL", "CF_EMAIL", "CLOUDFLARE_API_USER_SERVICE_KEY", "CLOUDFLARE_ACCESS_CLIENT_ID", "CLOUDFLARE_ACCESS_CLIENT_SECRET", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_ZONE_ID", "CF_API_TOKEN", "CF_API_KEY", "CF_ACCOUNT_ID", "WRANGLER_CF_AUTHORIZATION_TOKEN", "WRANGLER_R2_SQL_AUTH_TOKEN", "CLOUDFLARE_AUTH_USE_KEYRING", "WRANGLER_AUTH_DOMAIN", "WRANGLER_AUTH_URL", "WRANGLER_TOKEN_URL", "WRANGLER_REVOKE_URL", "CLOUDFLARE_API_BASE_URL", "CLOUDFLARE_BASE_URL", "CLOUDFLARED_TOKEN", "TUNNEL_TOKEN", "TUNNEL_ORIGIN_CERT", "TUNNEL_CRED_FILE", "TUNNEL_CREDENTIALS_FILE",
  "CF_HOME", "CF_PLUGIN_HOME", "CF_USERNAME", "CF_PASSWORD", "CF_CLIENT", "CF_CLIENT_ID", "CF_CLIENT_SECRET", "CF_DOCKER_PASSWORD", "CF_API", "CF_ORG", "CF_SPACE", "CF_TRACE", "CF_TRACE_FILE", "CF_SKIP_SSL_VALIDATION",
]) delete environment[name];

const child = spawn(executable, args, { stdio: "inherit", env: environment });
child.on("error", (error) => {
  process.stderr.write(`Could not execute real ${cli} at ${configured}: ${error.message}\n`);
  process.exit(127);
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});

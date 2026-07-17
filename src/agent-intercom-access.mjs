#!/usr/bin/env -S node --experimental-strip-types
import { checkRemoteAccessHealth, issueRemoteEnrollmentFile, revokeRemoteSubtree } from "./intercom-access.ts";

function usage() {
  return [
    "Usage:",
    "  agent-intercom-access enroll --parent SESSION --name NAME --host HOST --output PATH [--ttl-minutes N] [--expires-at ISO]",
    "  agent-intercom-access revoke --principal SESSION --confirm SESSION",
    "  agent-intercom-access health",
  ].join("\n");
}

function flags(argv) {
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error(usage());
    values[flag.slice(2)] = value;
  }
  return values;
}

function parseEnroll(values) {
  for (const required of ["parent", "name", "host", "output"]) {
    if (!values[required]) throw new Error(`Missing --${required}. ${usage()}`);
  }
  let ttlMs;
  if (values["ttl-minutes"] !== undefined) {
    const minutes = Number(values["ttl-minutes"]);
    if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 1440) throw new Error("--ttl-minutes must be an integer from 1 to 1440");
    ttlMs = minutes * 60_000;
  }
  let expiresAt;
  if (values["expires-at"] !== undefined) {
    expiresAt = Date.parse(values["expires-at"]);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw new Error("--expires-at must be a future ISO timestamp");
  }
  return {
    parentSessionId: values.parent,
    name: values.name,
    remoteHostId: values.host,
    outputPath: values.output,
    ...(ttlMs !== undefined ? { ttlMs } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

try {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const values = flags(argv);
  if (command === "health") {
    if (argv.length !== 1) throw new Error(usage());
    const result = await checkRemoteAccessHealth();
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
  } else if (command === "enroll") {
    const result = await issueRemoteEnrollmentFile(parseEnroll(values));
    process.stdout.write(`${JSON.stringify({ ok: true, credentialPath: result.path, expiresAt: result.expiresAt })}\n`);
  } else if (command === "revoke") {
    if (!values.principal) throw new Error(`Missing --principal. ${usage()}`);
    if (values.confirm !== values.principal) throw new Error("Revocation requires --confirm with the exact principal ID");
    const result = await revokeRemoteSubtree({ principalId: values.principal });
    process.stdout.write(`${JSON.stringify({ ok: true, changedPrincipalIds: result.changedPrincipalIds })}\n`);
  } else {
    throw new Error(usage());
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

#!/usr/bin/env -S node --experimental-strip-types
import { issueRemoteEnrollmentFile } from "./intercom-access.ts";

function usage() {
  return "Usage: agent-intercom-access enroll --parent SESSION --name NAME --host HOST --output PATH [--ttl-minutes N] [--expires-at ISO]";
}

function parseArgs(argv) {
  if (argv[0] !== "enroll") throw new Error(usage());
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error(usage());
    values[flag.slice(2)] = value;
  }
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
  const result = await issueRemoteEnrollmentFile(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify({ ok: true, credentialPath: result.path, expiresAt: result.expiresAt })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

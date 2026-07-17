#!/usr/bin/env -S node --experimental-strip-types
import { checkRemoteAccessHealth, issueDelegatedEnrollmentFile, issueRemoteEnrollmentFile, revokeRemoteSubtree } from "./intercom-access.ts";

function usage() {
  return [
    "Usage:",
    "  agent-intercom-access enroll --parent SESSION --name NAME --host HOST --output PATH [capability options]",
    "  agent-intercom-access delegate --credential PATH --name NAME --output PATH [capability options]",
    "  agent-intercom-access revoke --principal SESSION --confirm SESSION",
    "  agent-intercom-access health",
    "Capability options: --ttl-minutes N --expires-at ISO --can-delegate true|false --max-depth N --max-children N --confirm-delegation NAME",
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

function capabilityOptions(values) {
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
  let canDelegate;
  if (values["can-delegate"] !== undefined) {
    if (values["can-delegate"] !== "true" && values["can-delegate"] !== "false") throw new Error("--can-delegate must be true or false");
    canDelegate = values["can-delegate"] === "true";
    if (canDelegate && values["confirm-delegation"] !== values.name) {
      throw new Error("Delegation privilege requires --confirm-delegation with the exact child name");
    }
  }
  const integer = (name, minimum, maximum) => {
    if (values[name] === undefined) return undefined;
    const parsed = Number(values[name]);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`--${name} must be an integer from ${minimum} to ${maximum}`);
    return parsed;
  };
  const maxDepth = integer("max-depth", 1, 32);
  const maxChildren = integer("max-children", 0, 128);
  return {
    ...(ttlMs !== undefined ? { ttlMs } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(canDelegate !== undefined ? { canDelegate } : {}),
    ...(maxDepth !== undefined ? { maxDepth } : {}),
    ...(maxChildren !== undefined ? { maxChildren } : {}),
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
    for (const required of ["parent", "name", "host", "output"]) if (!values[required]) throw new Error(`Missing --${required}. ${usage()}`);
    const result = await issueRemoteEnrollmentFile({
      parentSessionId: values.parent,
      name: values.name,
      remoteHostId: values.host,
      outputPath: values.output,
      ...capabilityOptions(values),
    });
    process.stdout.write(`${JSON.stringify({ ok: true, credentialPath: result.path, expiresAt: result.expiresAt })}\n`);
  } else if (command === "delegate") {
    for (const required of ["credential", "name", "output"]) if (!values[required]) throw new Error(`Missing --${required}. ${usage()}`);
    const result = await issueDelegatedEnrollmentFile({
      credentialPath: values.credential,
      name: values.name,
      outputPath: values.output,
      ...capabilityOptions(values),
    });
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

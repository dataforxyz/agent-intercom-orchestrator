import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { BossCreateCapabilityReport } from "./boss-create-capabilities.ts";
import {
  TRUSTED_LOCAL_BOSS_RESOURCE_VERSION,
  type TrustedLocalBossResource,
} from "./boss-trusted-local.ts";

const execFileAsync = promisify(execFile);
const GIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const BOSS_RUN_ID = /^boss-[0-9a-f-]{36}$/;

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("/usr/bin/git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
  });
  return result.stdout.trim();
}

async function canonical(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("Boss canonical resource path must be absolute");
  return resolve(await realpath(path));
}

function canonicalTimestamp(value: Date, field: string): string {
  const timestamp = value.toISOString();
  if (Number.isNaN(value.valueOf()) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp)) {
    throw new Error(`Boss canonical resource ${field} is invalid`);
  }
  return timestamp;
}

/**
 * Observes a Controller-provisioned linked worktree and creates the immutable first
 * lease revision. This performs read-only Git inspection and never creates branches,
 * worktrees, commits, or transport credentials.
 */
export async function observeProvisionedBossResource(input: {
  bossRunId: string;
  path: string;
  baseSha: string;
  capabilityReport: BossCreateCapabilityReport;
  leaseAcquiredAt?: Date;
  leaseDurationMs: number;
}): Promise<TrustedLocalBossResource> {
  if (!BOSS_RUN_ID.test(input.bossRunId)) throw new Error("Boss canonical resource requires an exact run id");
  if (!GIT_SHA.test(input.baseSha)) throw new Error("Boss canonical resource base SHA is invalid");
  if (!Number.isSafeInteger(input.leaseDurationMs) || input.leaseDurationMs < 60_000) throw new Error("Boss canonical resource lease duration must be at least one minute");
  if (input.capabilityReport.status !== "ready" || input.capabilityReport.gaps.length) throw new Error("Boss canonical resource refuses a capability report with gaps");

  const path = await canonical(input.path);
  const reportedCwd = await canonical(input.capabilityReport.cwd);
  if (reportedCwd !== path) throw new Error("Boss canonical resource capability report is not bound to the exact worktree path");
  if (await git(path, ["rev-parse", "--is-inside-work-tree"]) !== "true") throw new Error("Boss canonical resource is not a Git worktree");
  const topLevel = await canonical(await git(path, ["rev-parse", "--show-toplevel"]));
  if (topLevel !== path) throw new Error("Boss canonical resource path must be the exact worktree root");

  const gitAdminDirectory = await canonical(await git(path, ["rev-parse", "--absolute-git-dir"]));
  const gitCommonDirectory = await canonical(await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const adminRelationship = relative(gitCommonDirectory, gitAdminDirectory).split(sep);
  if (gitAdminDirectory === gitCommonDirectory || adminRelationship.length !== 2 || adminRelationship[0] !== "worktrees" || !adminRelationship[1]) {
    throw new Error("Boss canonical resource must be an exact linked worktree");
  }
  const listed = (await git(path, ["worktree", "list", "--porcelain"]))
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
  const listedCanonical = await Promise.all(listed.map((candidate) => canonical(candidate).catch(() => "")));
  if (!listedCanonical.includes(path)) throw new Error("Boss canonical resource is absent from Git's worktree inventory");

  const branch = await git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (!branch) throw new Error("Boss canonical resource requires an attached branch");
  const headSha = await git(path, ["rev-parse", "HEAD"]);
  if (!GIT_SHA.test(headSha)) throw new Error("Boss canonical resource HEAD is invalid");
  try {
    await git(path, ["merge-base", "--is-ancestor", input.baseSha, headSha]);
  } catch {
    throw new Error("Boss canonical resource HEAD is not descended from the recorded base SHA");
  }

  const acquired = input.leaseAcquiredAt ?? new Date();
  const leaseAcquiredAt = canonicalTimestamp(acquired, "lease acquisition time");
  const leaseExpiresAt = canonicalTimestamp(new Date(acquired.valueOf() + input.leaseDurationMs), "lease expiry time");
  return {
    version: TRUSTED_LOCAL_BOSS_RESOURCE_VERSION,
    resourceId: `resource-${randomUUID()}`,
    revision: 1,
    kind: "linked-worktree",
    path,
    gitAdminDirectory,
    gitCommonDirectory,
    branch,
    baseSha: input.baseSha,
    headSha,
    existence: "verified",
    leaseState: "active",
    leaseOwnerBossRunId: input.bossRunId,
    leaseAcquiredAt,
    leaseExpiresAt,
    capabilities: input.capabilityReport.probes.map((finding) => ({ ...finding })),
  };
}

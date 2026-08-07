import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, realpath, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
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

async function gitResult(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync("/usr/bin/git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
  });
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
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

export interface ProvisionedBossWorktree {
  bossRunId: string;
  sourceRepository: string;
  path: string;
  branch: string;
  baseSha: string;
}

/**
 * Creates one dedicated direct-child linked worktree without Git transport. If any
 * observation step fails, both the worktree and branch are rolled back before the
 * error escapes. Persistence remains the caller's transaction boundary; callers
 * must invoke rollbackProvisionedBossWorktree if run persistence later fails.
 */
export async function provisionBossLinkedWorktree(input: {
  bossRunId: string;
  sourceCwd: string;
  leaseRoot: string;
  observe: (provisioned: ProvisionedBossWorktree) => Promise<void>;
}): Promise<ProvisionedBossWorktree> {
  if (!BOSS_RUN_ID.test(input.bossRunId)) throw new Error("Boss worktree provisioning requires an exact run id");
  const sourceCwd = await canonical(input.sourceCwd);
  if (await git(sourceCwd, ["rev-parse", "--is-inside-work-tree"]) !== "true") throw new Error("Boss worktree provisioning requires a Git source checkout");
  const sourceRepository = await canonical(await git(sourceCwd, ["rev-parse", "--show-toplevel"]));
  if (!isAbsolute(input.leaseRoot)) throw new Error("Boss worktree lease root must be absolute");
  await mkdir(input.leaseRoot, { recursive: true, mode: 0o700 });
  const leaseRoot = await canonical(input.leaseRoot);
  const path = resolve(join(leaseRoot, input.bossRunId));
  if (relative(leaseRoot, path) !== input.bossRunId || basename(path) !== input.bossRunId) {
    throw new Error("Boss worktree path escaped the configured lease root");
  }
  const branch = `boss/run-${input.bossRunId.slice("boss-".length)}`;
  const baseSha = await git(sourceRepository, ["rev-parse", "HEAD"]);
  if (!GIT_SHA.test(baseSha)) throw new Error("Boss worktree provisioning could not resolve the base HEAD");
  const provisioned = { bossRunId: input.bossRunId, sourceRepository, path, branch, baseSha };
  let added = false;
  try {
    await gitResult(sourceRepository, ["worktree", "add", "-b", branch, path, baseSha]);
    added = true;
    provisioned.path = await canonical(path);
    await input.observe(provisioned);
    return provisioned;
  } catch (error) {
    if (added) {
      try {
        await rollbackProvisionedBossWorktree(provisioned);
      } catch (rollbackError) {
        throw new Error(`Boss worktree provisioning failed and rollback was incomplete: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`, { cause: error });
      }
    }
    throw error;
  }
}

export async function rollbackProvisionedBossWorktree(provisioned: ProvisionedBossWorktree): Promise<void> {
  const failures: string[] = [];
  try {
    await gitResult(provisioned.sourceRepository, ["worktree", "remove", "--force", provisioned.path]);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
    await rm(provisioned.path, { recursive: true, force: true }).catch(() => undefined);
    await gitResult(provisioned.sourceRepository, ["worktree", "prune"]).catch(() => undefined);
  }
  try {
    await gitResult(provisioned.sourceRepository, ["branch", "-D", provisioned.branch]);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  if (failures.length) throw new Error(`Boss worktree rollback was incomplete: ${failures.join("; ")}`);
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

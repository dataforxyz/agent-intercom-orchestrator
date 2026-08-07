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

async function gitDirectoryResult(gitDirectory: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync("/usr/bin/git", ["--git-dir", gitDirectory, ...args], {
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

export interface BossResourceCleanupResult {
  resource: TrustedLocalBossResource;
  removed: boolean;
  dirty: boolean;
  dirtyStatus?: string;
  error?: string;
}

function nextResourceRevision(resource: TrustedLocalBossResource, changes: Partial<TrustedLocalBossResource>): TrustedLocalBossResource {
  if (!Number.isSafeInteger(resource.revision) || resource.revision < 1) throw new Error("Boss canonical resource revision is invalid");
  return { ...resource, ...changes, resourceId: resource.resourceId, revision: resource.revision + 1 };
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

/** Refreshes Controller-observed mutable resource fields while preserving identity. */
export async function refreshProvisionedBossResource(input: {
  resource: TrustedLocalBossResource;
  capabilityReport: BossCreateCapabilityReport;
  leaseDurationMs: number;
  observedAt?: Date;
}): Promise<TrustedLocalBossResource> {
  if (input.resource.leaseState !== "active" || input.resource.existence !== "verified") throw new Error("Boss canonical resource refresh requires an active verified lease");
  const observed = await observeProvisionedBossResource({
    bossRunId: input.resource.leaseOwnerBossRunId,
    path: input.resource.path,
    baseSha: input.resource.baseSha,
    capabilityReport: input.capabilityReport,
    leaseAcquiredAt: input.observedAt,
    leaseDurationMs: input.leaseDurationMs,
  });
  for (const field of ["path", "gitAdminDirectory", "gitCommonDirectory", "branch", "baseSha", "leaseOwnerBossRunId"] as const) {
    if (observed[field] !== input.resource[field]) throw new Error(`Boss canonical resource ${field} changed during refresh`);
  }
  return nextResourceRevision(input.resource, {
    headSha: observed.headSha,
    existence: observed.existence,
    leaseState: "active",
    leaseExpiresAt: observed.leaseExpiresAt,
    capabilities: observed.capabilities,
  });
}

/**
 * Explicit terminal cleanup. Dirty worktrees are released but preserved. Clean
 * worktrees are removed with their dedicated branch; failures are represented in
 * the returned monotonic resource transition instead of being hidden.
 */
export async function cleanupProvisionedBossResource(resource: TrustedLocalBossResource): Promise<BossResourceCleanupResult> {
  if (resource.leaseState === "released" && resource.existence === "missing") return { resource, removed: true, dirty: false };
  if (resource.leaseState !== "active" && resource.leaseState !== "cleanup_failed") throw new Error(`Boss canonical resource cannot be cleaned from ${resource.leaseState}`);
  let dirtyStatus = "";
  let currentHead = "";
  try {
    const path = await canonical(resource.path);
    const topLevel = await canonical(await git(path, ["rev-parse", "--show-toplevel"]));
    const gitAdminDirectory = await canonical(await git(path, ["rev-parse", "--absolute-git-dir"]));
    const gitCommonDirectory = await canonical(await git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
    const branch = await git(path, ["symbolic-ref", "--short", "HEAD"]);
    currentHead = await git(path, ["rev-parse", "HEAD"]);
    if (path !== resource.path || topLevel !== resource.path || gitAdminDirectory !== resource.gitAdminDirectory || gitCommonDirectory !== resource.gitCommonDirectory || branch !== resource.branch || !GIT_SHA.test(currentHead)) {
      throw new Error("canonical worktree identity, branch, or HEAD changed before cleanup");
    }
    dirtyStatus = (await gitResult(path, ["status", "--porcelain=v1", "--untracked-files=all"])).stdout;
  } catch (error) {
    const message = `Boss canonical resource cleanup failed during safe candidate inspection: ${error instanceof Error ? error.message : String(error)}`;
    return { resource: nextResourceRevision(resource, { leaseState: "cleanup_failed" }), removed: false, dirty: false, error: message };
  }
  const committedDivergence = currentHead !== resource.baseSha || resource.headSha !== resource.baseSha;
  if (dirtyStatus || committedDivergence) {
    const preservationStatus = [
      dirtyStatus,
      ...(committedDivergence ? [`committed candidate preserved: base ${resource.baseSha}, recorded HEAD ${resource.headSha}, current HEAD ${currentHead}`] : []),
    ].filter(Boolean).join("\n");
    return {
      resource: nextResourceRevision(resource, { headSha: currentHead, leaseState: "released" }),
      removed: false,
      dirty: true,
      dirtyStatus: preservationStatus,
    };
  }
  try {
    await gitDirectoryResult(resource.gitCommonDirectory, ["worktree", "remove", resource.path]);
    await gitDirectoryResult(resource.gitCommonDirectory, ["branch", "-D", resource.branch]);
    return {
      resource: nextResourceRevision(resource, { existence: "missing", leaseState: "released" }),
      removed: true,
      dirty: false,
    };
  } catch (error) {
    const exists = await realpath(resource.path).then(() => true).catch(() => false);
    const message = `Boss canonical resource cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
    return {
      resource: nextResourceRevision(resource, { existence: exists ? "verified" : "missing", leaseState: "cleanup_failed" }),
      removed: false,
      dirty: false,
      error: message,
    };
  }
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

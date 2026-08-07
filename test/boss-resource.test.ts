import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { cleanupProvisionedBossResource, observeProvisionedBossResource, provisionBossLinkedWorktree, refreshProvisionedBossResource, rollbackProvisionedBossWorktree } from "../src/boss-resource.ts";
import { TrustedLocalBossStore } from "../src/boss-trusted-local.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("/usr/bin/git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim();
}

async function fixture(context: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "boss-resource-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "repository");
  const worktree = join(root, "leased-worktree");
  await mkdir(repository);
  await git(repository, "init", "-b", "main");
  await git(repository, "config", "user.name", "Boss Resource Test");
  await git(repository, "config", "user.email", "boss-resource@example.invalid");
  await writeFile(join(repository, "README.md"), "base\n");
  await git(repository, "add", "README.md");
  await git(repository, "commit", "-m", "base");
  const baseSha = await git(repository, "rev-parse", "HEAD");
  await git(repository, "worktree", "add", "-b", "boss/test-resource", worktree, baseSha);
  return { root, repository, worktree: await realpath(worktree), baseSha };
}

function readyReport(cwd: string) {
  const probes = [{
    capability: "worktree-identity" as const,
    requested: "required" as const,
    availability: "verified" as const,
    evidence: "Controller verified exact linked-worktree identity",
  }];
  return { status: "ready" as const, cwd, requested: { worktree: "write" as const }, probes, gaps: [] };
}

test("provisions a dedicated direct-child worktree and rolls back observation failures", async (context) => {
  const { root, repository, baseSha } = await fixture(context);
  const leaseRoot = join(root, "leases");
  const bossRunId = "boss-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const provisioned = await provisionBossLinkedWorktree({
    bossRunId,
    sourceCwd: repository,
    leaseRoot,
    observe: async (candidate) => {
      assert.equal(candidate.baseSha, baseSha);
      assert.equal(candidate.path, join(leaseRoot, bossRunId));
      assert.equal(await git(candidate.path, "symbolic-ref", "--short", "HEAD"), candidate.branch);
    },
  });
  assert.equal(await git(repository, "worktree", "list", "--porcelain").then((value) => value.includes(provisioned.path)), true);
  await rollbackProvisionedBossWorktree(provisioned);
  await assert.rejects(realpath(provisioned.path));
  await assert.rejects(git(repository, "show-ref", "--verify", `refs/heads/${provisioned.branch}`));

  const failedId = "boss-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  await assert.rejects(provisionBossLinkedWorktree({ bossRunId: failedId, sourceCwd: repository, leaseRoot, observe: async () => { throw new Error("observation failed"); } }), /observation failed/);
  await assert.rejects(realpath(join(leaseRoot, failedId)));
  await assert.rejects(git(repository, "show-ref", "--verify", `refs/heads/boss/run-${failedId.slice(5)}`));
});

test("fails closed on branch collisions without deleting the pre-existing branch", async (context) => {
  const { root, repository } = await fixture(context);
  const bossRunId = "boss-cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const branch = `boss/run-${bossRunId.slice(5)}`;
  await git(repository, "branch", branch);
  await assert.rejects(provisionBossLinkedWorktree({ bossRunId, sourceCwd: repository, leaseRoot: join(root, "leases"), observe: async () => undefined }));
  assert.match(await git(repository, "show-ref", "--verify", `refs/heads/${branch}`), /refs\/heads\/boss\/run-/);
});

test("observes an exact Controller-provisioned linked worktree and binds an active lease", async (context) => {
  const { worktree, baseSha } = await fixture(context);
  const bossRunId = "boss-11111111-1111-4111-8111-111111111111";
  const resource = await observeProvisionedBossResource({
    bossRunId,
    path: worktree,
    baseSha,
    capabilityReport: readyReport(worktree),
    leaseAcquiredAt: new Date("2026-02-03T04:05:06.000Z"),
    leaseDurationMs: 60 * 60_000,
  });
  assert.equal(resource.revision, 1);
  assert.equal(resource.path, worktree);
  assert.equal(resource.branch, "boss/test-resource");
  assert.equal(resource.baseSha, baseSha);
  assert.equal(resource.headSha, baseSha);
  assert.equal(resource.leaseState, "active");
  assert.equal(resource.leaseOwnerBossRunId, bossRunId);
  assert.equal(resource.leaseExpiresAt, "2026-02-03T05:05:06.000Z");
  assert.notEqual(resource.gitAdminDirectory, resource.gitCommonDirectory);
});

test("canonicalizes aliases and fails closed on mismatched reports, capability gaps, and unrelated bases", async (context) => {
  const { root, repository, worktree, baseSha } = await fixture(context);
  const bossRunId = "boss-22222222-2222-4222-8222-222222222222";
  const alias = join(root, "worktree-alias");
  await symlink(worktree, alias);
  const aliased = await observeProvisionedBossResource({
    bossRunId, path: alias, baseSha, capabilityReport: readyReport(alias), leaseDurationMs: 60_000,
  });
  assert.equal(aliased.path, worktree);
  await assert.rejects(observeProvisionedBossResource({
    bossRunId, path: worktree, baseSha, capabilityReport: readyReport(repository), leaseDurationMs: 60_000,
  }), /not bound to the exact worktree path/);

  const gap = { ...readyReport(worktree).probes[0], availability: "gap" as const, evidence: "gap" };
  const blocked = { status: "blocked" as const, cwd: worktree, requested: { worktree: "write" as const }, probes: [gap], gaps: [gap] };
  await assert.rejects(observeProvisionedBossResource({
    bossRunId, path: worktree, baseSha, capabilityReport: blocked, leaseDurationMs: 60_000,
  }), /capability report with gaps/);

  await git(repository, "checkout", "--orphan", "unrelated");
  await writeFile(join(repository, "unrelated.txt"), "unrelated\n");
  await git(repository, "add", "unrelated.txt");
  await git(repository, "commit", "-m", "unrelated");
  const unrelated = await git(repository, "rev-parse", "HEAD");
  await assert.rejects(observeProvisionedBossResource({
    bossRunId, path: worktree, baseSha: unrelated, capabilityReport: readyReport(worktree), leaseDurationMs: 60_000,
  }), /not descended/);
});

test("trusted-local store accepts one exact initial resource and migrates it durably", async (context) => {
  const { root, worktree, baseSha } = await fixture(context);
  const store = new TrustedLocalBossStore(join(root, "runs.json"), () => new Date("2026-02-03T04:05:06.000Z"));
  const created = await store.execute({ action: "create", goal: "bind canonical resource" }, "controller-resource");
  const resource = await observeProvisionedBossResource({
    bossRunId: created.run!.bossRunId,
    path: worktree,
    baseSha,
    capabilityReport: readyReport(worktree),
    leaseAcquiredAt: new Date("2026-02-03T04:05:06.000Z"),
    leaseDurationMs: 60_000,
  });
  const bound = await store.recordProvisionedResource(created.run!.bossRunId, resource);
  assert.deepEqual(bound.resource, resource);
  assert.deepEqual(bound.assignments.map((assignment) => assignment.resourceRevision), [1, 1, 1]);
  assert.match((await store.execute({ action: "status", bossRunId: created.run!.bossRunId }, "controller-resource")).message, /resource: resource-/);
  await assert.rejects(store.recordProvisionedResource(created.run!.bossRunId, resource), /already has a canonical resource/);
});

test("persists a provisioned run and stamps every initial assignment with the resource revision", async (context) => {
  const { root, worktree, baseSha } = await fixture(context);
  const store = new TrustedLocalBossStore(join(root, "provisioned-runs.json"), () => new Date("2026-02-03T04:05:06.000Z"));
  const bossRunId = "boss-dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const resource = await observeProvisionedBossResource({ bossRunId, path: worktree, baseSha, capabilityReport: readyReport(worktree), leaseDurationMs: 60_000 });
  const result = await store.createProvisionedRun({ bossRunId, goal: "use canonical cwd", managerSessionId: "controller-provisioned", resource });
  assert.equal(result.run?.resource?.path, worktree);
  assert.deepEqual(result.run?.assignments.map((assignment) => assignment.resourceRevision), [1, 1, 1]);
});

test("refreshes resource observations with monotonic revisions and CAS persistence", async (context) => {
  const { root, worktree, baseSha } = await fixture(context);
  const bossRunId = "boss-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const resource = await observeProvisionedBossResource({
    bossRunId, path: worktree, baseSha, capabilityReport: readyReport(worktree), leaseAcquiredAt: new Date("2026-02-03T04:00:00.000Z"), leaseDurationMs: 60_000,
  });
  await writeFile(join(worktree, "README.md"), "advanced\n");
  await git(worktree, "add", "README.md");
  await git(worktree, "-c", "user.name=Boss Resource Test", "-c", "user.email=boss-resource@example.invalid", "commit", "-m", "advance");
  const refreshed = await refreshProvisionedBossResource({
    resource, capabilityReport: readyReport(worktree), observedAt: new Date("2026-02-03T04:01:00.000Z"), leaseDurationMs: 120_000,
  });
  assert.equal(refreshed.revision, 2);
  assert.notEqual(refreshed.headSha, resource.headSha);
  assert.equal(refreshed.leaseExpiresAt, "2026-02-03T04:03:00.000Z");
  assert.equal(refreshed.resourceId, resource.resourceId);

  const store = new TrustedLocalBossStore(join(root, "refresh-runs.json"));
  await store.createProvisionedRun({ bossRunId, goal: "refresh canonical resource", managerSessionId: "controller-refresh", resource });
  const transitioned = await store.recordResourceTransition(bossRunId, 1, refreshed);
  assert.deepEqual(transitioned.assignments.map((assignment) => assignment.resourceRevision), [2, 2, 2]);
  await assert.rejects(store.recordResourceTransition(bossRunId, 1, refreshed), /revision conflict/);
  assert.deepEqual(await store.protectedResourcePaths(), [worktree]);
});

test("terminal cleanup preserves dirty candidates and records a released revision", async (context) => {
  const { worktree, baseSha } = await fixture(context);
  const bossRunId = "boss-ffffffff-ffff-4fff-8fff-ffffffffffff";
  const resource = await observeProvisionedBossResource({ bossRunId, path: worktree, baseSha, capabilityReport: readyReport(worktree), leaseDurationMs: 60_000 });
  await writeFile(join(worktree, "candidate.txt"), "keep me\n");
  const cleanup = await cleanupProvisionedBossResource(resource);
  assert.equal(cleanup.dirty, true);
  assert.equal(cleanup.removed, false);
  assert.match(cleanup.dirtyStatus ?? "", /candidate\.txt/);
  assert.equal(cleanup.resource.revision, 2);
  assert.equal(cleanup.resource.leaseState, "released");
  assert.equal(await realpath(worktree), worktree);
});

test("terminal cleanup removes clean resources and reports failures honestly", async (context) => {
  const cleanFixture = await fixture(context);
  const cleanRunId = "boss-99999999-9999-4999-8999-999999999999";
  const clean = await observeProvisionedBossResource({ bossRunId: cleanRunId, path: cleanFixture.worktree, baseSha: cleanFixture.baseSha, capabilityReport: readyReport(cleanFixture.worktree), leaseDurationMs: 60_000 });
  const removed = await cleanupProvisionedBossResource(clean);
  assert.equal(removed.removed, true);
  assert.equal(removed.resource.revision, 2);
  assert.equal(removed.resource.existence, "missing");
  assert.equal(removed.resource.leaseState, "released");
  await assert.rejects(realpath(cleanFixture.worktree));
  await assert.rejects(git(cleanFixture.repository, "show-ref", "--verify", `refs/heads/${clean.branch}`));

  const failedFixture = await fixture(context);
  const failedRunId = "boss-88888888-8888-4888-8888-888888888888";
  const failedResource = await observeProvisionedBossResource({ bossRunId: failedRunId, path: failedFixture.worktree, baseSha: failedFixture.baseSha, capabilityReport: readyReport(failedFixture.worktree), leaseDurationMs: 60_000 });
  const failure = await cleanupProvisionedBossResource({ ...failedResource, gitCommonDirectory: join(failedFixture.root, "missing-git-common") });
  assert.equal(failure.removed, false);
  assert.equal(failure.resource.revision, 2);
  assert.equal(failure.resource.existence, "verified");
  assert.equal(failure.resource.leaseState, "cleanup_failed");
  assert.match(failure.error ?? "", /cleanup failed/);
});

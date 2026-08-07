import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { observeProvisionedBossResource, provisionBossLinkedWorktree, rollbackProvisionedBossWorktree } from "../src/boss-resource.ts";
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

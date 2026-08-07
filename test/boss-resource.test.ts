import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { observeProvisionedBossResource } from "../src/boss-resource.ts";
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
  assert.match((await store.execute({ action: "status", bossRunId: created.run!.bossRunId }, "controller-resource")).message, /resource: resource-/);
  await assert.rejects(store.recordProvisionedResource(created.run!.bossRunId, resource), /already has a canonical resource/);
});

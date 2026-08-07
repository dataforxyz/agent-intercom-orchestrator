import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { BOSS_CANDIDATE_FINGERPRINT_VERSION, observeBossCandidateFingerprint } from "../src/boss-candidate-fingerprint.ts";
import { observeProvisionedBossResource } from "../src/boss-resource.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("/usr/bin/git", ["-C", cwd, ...args], { encoding: "utf8" })).stdout.trim();
}

async function fixture(context: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "boss-candidate-fingerprint-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "repository");
  const worktree = join(root, "candidate");
  await mkdir(repository);
  await git(repository, "init", "-b", "main");
  await git(repository, "config", "user.name", "Boss Fingerprint Test");
  await git(repository, "config", "user.email", "boss-fingerprint@example.invalid");
  await writeFile(join(repository, "README.md"), "base\n");
  await git(repository, "add", "README.md");
  await git(repository, "commit", "-m", "base");
  const baseSha = await git(repository, "rev-parse", "HEAD");
  await git(repository, "worktree", "add", "-b", "boss/fingerprint", worktree, baseSha);
  const cwd = await realpath(worktree);
  const resource = await observeProvisionedBossResource({
    bossRunId: "boss-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    path: cwd,
    baseSha,
    capabilityReport: {
      status: "ready",
      cwd,
      requested: { worktree: "write" },
      probes: [{ capability: "worktree-identity", requested: "required", availability: "verified", evidence: "exact linked worktree" }],
      gaps: [],
    },
    leaseDurationMs: 60_000,
  });
  return { root, repository, worktree: cwd, resource };
}

test("candidate fingerprints are deterministic and bind tracked plus complete untracked content", async (context) => {
  const { worktree, resource } = await fixture(context);
  const clean = await observeBossCandidateFingerprint(resource);
  assert.equal(clean.version, BOSS_CANDIDATE_FINGERPRINT_VERSION);
  assert.equal(clean.headSha, resource.headSha);
  assert.equal(clean.trackedDirtyBytes, 0);
  assert.deepEqual(clean.untrackedManifest, []);
  assert.match(clean.aggregateSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(await observeBossCandidateFingerprint(resource), clean);

  await writeFile(join(worktree, "README.md"), "dirty tracked content\n");
  await writeFile(join(worktree, "untracked.txt"), "candidate bytes\n");
  await symlink("untracked.txt", join(worktree, "candidate-link"));
  const dirty = await observeBossCandidateFingerprint(resource);
  assert.notEqual(dirty.aggregateSha256, clean.aggregateSha256);
  assert.ok(dirty.trackedDirtyBytes > 0);
  assert.deepEqual(dirty.untrackedManifest.map((entry) => [entry.path, entry.type]), [["candidate-link", "symlink"], ["untracked.txt", "file"]]);

  await writeFile(join(worktree, "untracked.txt"), "different candidate bytes\n");
  const contentChanged = await observeBossCandidateFingerprint(resource);
  assert.notEqual(contentChanged.aggregateSha256, dirty.aggregateSha256);
  assert.notEqual(contentChanged.untrackedManifest[1].sha256, dirty.untrackedManifest[1].sha256);

  await unlink(join(worktree, "candidate-link"));
  await symlink("README.md", join(worktree, "candidate-link"));
  const linkChanged = await observeBossCandidateFingerprint(resource);
  assert.notEqual(linkChanged.aggregateSha256, contentChanged.aggregateSha256);
  assert.notEqual(linkChanged.untrackedManifest[0].sha256, contentChanged.untrackedManifest[0].sha256);
});

test("candidate tracked fingerprints disable textconv and bind raw candidate changes", async (context) => {
  const { root, repository, worktree, resource } = await fixture(context);
  const textconv = join(root, "constant-textconv.sh");
  await writeFile(textconv, "#!/bin/sh\nprintf 'constant presentation\\n'\n");
  await chmod(textconv, 0o700);
  await writeFile(join(repository, ".git", "info", "attributes"), "README.md diff=constant\n");
  await git(repository, "config", "diff.constant.textconv", textconv);
  await writeFile(join(worktree, "README.md"), "changed raw candidate bytes\n");

  assert.equal(await git(worktree, "diff", "--no-ext-diff", "HEAD", "--", "README.md"), "", "the configured presentation filter hides the tracked change from ordinary diff");
  const fingerprint = await observeBossCandidateFingerprint(resource);
  assert.ok(fingerprint.trackedDirtyBytes > 0, "the canonical fingerprint hashes the raw binary patch instead of textconv output");
  assert.notEqual(fingerprint.trackedDirtySha256, createHash("sha256").update("").digest("hex"));
});

test("candidate observation fails closed on bounds, special files, identity drift, and inactive leases", async (context) => {
  const { worktree, resource } = await fixture(context);
  await writeFile(join(worktree, "large.txt"), "12345");
  await assert.rejects(observeBossCandidateFingerprint(resource, { maxUntrackedFileBytes: 4 }), /byte bounds/);
  await assert.rejects(observeBossCandidateFingerprint(resource, { maxUntrackedFiles: 1, betweenObservations: async () => writeFile(join(worktree, "second.txt"), "x") }), /file count|observation window/);
  await unlink(join(worktree, "large.txt"));
  await execFileAsync("/usr/bin/mkfifo", [join(worktree, "unsupported.fifo")]);
  await assert.rejects(observeBossCandidateFingerprint(resource), /unsupported file type/);
  await unlink(join(worktree, "unsupported.fifo"));

  await assert.rejects(observeBossCandidateFingerprint({ ...resource, branch: "boss/not-the-branch" }), /identity drifted/);
  await assert.rejects(observeBossCandidateFingerprint({ ...resource, leaseState: "released" }), /active verified/);
});

test("candidate observation rejects movement between its two exact snapshots", async (context) => {
  const { worktree, resource } = await fixture(context);
  await writeFile(join(worktree, "candidate.txt"), "first\n");
  await assert.rejects(observeBossCandidateFingerprint(resource, {
    betweenObservations: async () => writeFile(join(worktree, "candidate.txt"), "second\n"),
  }), /changed during the fingerprint observation window/);
});

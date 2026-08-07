import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatBossCreateCapabilityReport, inspectBossCreateCapabilities } from "../src/boss-create-capabilities.ts";
import { DEFAULT_PERMISSION_PROFILES } from "../src/permissions.ts";

async function linkedWorktreeFixture() {
  const dir = await mkdtemp(join(tmpdir(), "boss-create-capabilities-"));
  const commonGit = join(dir, "repository", ".git");
  const admin = join(commonGit, "worktrees", "feature");
  const worktree = join(dir, "feature");
  const cwd = join(worktree, "nested");
  await mkdir(admin, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(join(worktree, ".git"), `gitdir: ${admin}\n`);
  await writeFile(join(admin, "commondir"), "../..\n");
  return { cwd, dir };
}

test("Boss create reports requested worktree/edit access separately from effective availability", async () => {
  const { cwd, dir } = await linkedWorktreeFixture();
  try {
    const report = await inspectBossCreateCapabilities({
      cwd,
      requirements: { worktree: "write", edit: true },
      workerPermissionProfileName: "builder-restricted",
      workerPermissionProfile: DEFAULT_PERMISSION_PROFILES["builder-restricted"],
    });
    assert.equal(report.status, "ready");
    assert.deepEqual(report.requirements, { worktree: "write", edit: true });
    assert.deepEqual(report.findings.map((finding) => [finding.capability, finding.requested, finding.availability]), [
      ["worktree", "write", "available"],
      ["edit", "required", "available"],
    ]);
    assert.match(formatBossCreateCapabilityReport(report), /worktree: requested=write; availability=available/);
    assert.match(formatBossCreateCapabilityReport(report), /not proof that implementation or validation succeeded/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a read-only exact worktree visibly blocks requested write and edit before staffing", async () => {
  const { cwd, dir } = await linkedWorktreeFixture();
  try {
    const readable = await inspectBossCreateCapabilities({
      cwd,
      requirements: { worktree: "read" },
      workerPermissionProfileName: "review-readonly",
      workerPermissionProfile: DEFAULT_PERMISSION_PROFILES["review-readonly"],
    });
    assert.equal(readable.status, "ready");
    assert.equal(readable.findings[0].availability, "available");

    const blocked = await inspectBossCreateCapabilities({
      cwd,
      requirements: { worktree: "write", edit: true },
      workerPermissionProfileName: "review-readonly",
      workerPermissionProfile: DEFAULT_PERMISSION_PROFILES["review-readonly"],
    });
    assert.equal(blocked.status, "blocked");
    assert.deepEqual(blocked.findings.map((finding) => [finding.capability, finding.availability]), [
      ["worktree", "unavailable"],
      ["edit", "unavailable"],
    ]);
    const formatted = formatBossCreateCapabilityReport(blocked);
    assert.match(formatted, /linked worktree .* is read-only under effective Worker profile review-readonly/);
    assert.match(formatted, /No Boss run was created/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("unprobed tests and Git transport stay unavailable instead of inheriting configured tools", async () => {
  const report = await inspectBossCreateCapabilities({
    cwd: "/tmp",
    requirements: { tests: true, gitTransport: "read" },
    workerPermissionProfileName: "trusted",
    workerPermissionProfile: DEFAULT_PERMISSION_PROFILES.trusted,
  });
  assert.equal(report.status, "blocked");
  assert.deepEqual(report.findings.map((finding) => [finding.capability, finding.requested, finding.availability]), [
    ["tests", "required", "unavailable"],
    ["git-transport", "read", "unavailable"],
  ]);
  const formatted = formatBossCreateCapabilityReport(report);
  assert.match(formatted, /no project-specific test command or toolchain was effectively probed/);
  assert.match(formatted, /remote reachability, credentials, and read transport authority were not effectively probed/);
});

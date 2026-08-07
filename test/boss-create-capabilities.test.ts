import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatBossCreateCapabilityReport, inspectBossCreateCapabilities } from "../src/boss-create-capabilities.ts";
import { DEFAULT_PERMISSION_PROFILES } from "../src/permissions.ts";

test("Boss create capability report verifies linked worktrees and configured Worker edit/test policy", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boss-create-capabilities-"));
  try {
    const commonGit = join(dir, "repository", ".git");
    const admin = join(commonGit, "worktrees", "feature");
    const worktree = join(dir, "feature");
    const cwd = join(worktree, "nested");
    await mkdir(admin, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(join(worktree, ".git"), `gitdir: ${admin}\n`);
    await writeFile(join(admin, "commondir"), "../..\n");

    const report = await inspectBossCreateCapabilities({
      cwd,
      needs: ["worktree", "edit", "test"],
      workerPermissionProfileName: "builder-restricted",
      workerPermissionProfile: DEFAULT_PERMISSION_PROFILES["builder-restricted"],
    });
    assert.equal(report.status, "ready");
    assert.deepEqual(report.findings.map((finding) => [finding.need, finding.status]), [
      ["worktree", "verified"],
      ["edit", "configured"],
      ["test", "configured"],
    ]);
    assert.match(formatBossCreateCapabilityReport(report), /project-specific commands and toolchains are not claimed as preflight-verified/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Boss create capability report fails closed for a main checkout and unverified Git transport", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boss-create-capability-gaps-"));
  try {
    await mkdir(join(dir, ".git"));
    const report = await inspectBossCreateCapabilities({
      cwd: dir,
      needs: ["worktree", "git-transport"],
      workerPermissionProfileName: "trusted",
      workerPermissionProfile: DEFAULT_PERMISSION_PROFILES.trusted,
    });
    assert.equal(report.status, "blocked");
    assert.deepEqual(report.findings.map((finding) => [finding.need, finding.status]), [
      ["worktree", "gap"],
      ["git-transport", "gap"],
    ]);
    const formatted = formatBossCreateCapabilityReport(report);
    assert.match(formatted, /Boss does not provision worktrees/);
    assert.match(formatted, /does not verify remote reachability, credentials, or write authority/);
    assert.match(formatted, /No Boss run was created/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Boss create capability report treats missing Worker tools as explicit gaps", async () => {
  const report = await inspectBossCreateCapabilities({
    cwd: "/tmp",
    needs: ["edit", "test"],
    workerPermissionProfileName: "custom-readonly",
    workerPermissionProfile: { workspace: "read-only", git: "read-only", piTools: ["read"] },
  });
  assert.equal(report.status, "blocked");
  assert.deepEqual(report.findings.map((finding) => finding.status), ["gap", "gap"]);
});

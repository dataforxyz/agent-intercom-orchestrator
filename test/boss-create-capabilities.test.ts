import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { formatBossCreateCapabilityReport, inspectBossCreateCapabilities } from "../src/boss-create-capabilities.ts";
import { DEFAULT_PERMISSION_PROFILES } from "../src/permissions.ts";
import type { PermissionProfile } from "../src/types.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("/usr/bin/git", ["-C", cwd, ...args], { timeout: 10_000 });
}

async function linkedWorktreeFixture() {
  const dir = await mkdtemp(join(tmpdir(), "boss-create-capabilities-"));
  const repository = join(dir, "repository");
  const worktree = join(dir, "feature");
  await mkdir(repository);
  await git(repository, ["init", "-q"]);
  await git(repository, ["config", "user.email", "test@example.invalid"]);
  await git(repository, ["config", "user.name", "Test"]);
  await writeFile(join(repository, "tracked.txt"), "fixture\n");
  await git(repository, ["add", "tracked.txt"]);
  await git(repository, ["commit", "-qm", "fixture"]);
  await git(repository, ["worktree", "add", "--detach", worktree, "HEAD"]);
  const cwd = join(worktree, "nested");
  await mkdir(cwd);
  return { cwd, dir, worktree };
}

test("Boss create verifies a real linked worktree but reports Worker access as configured", async () => {
  const { dir, worktree } = await linkedWorktreeFixture();
  try {
    const report = await inspectBossCreateCapabilities({
      cwd: worktree,
      requirements: { worktree: "write", edit: true },
      workerPermissionProfileName: "builder-restricted",
      workerPermissionProfile: DEFAULT_PERMISSION_PROFILES["builder-restricted"],
    });
    assert.equal(report.status, "ready");
    assert.deepEqual(report.requested, { worktree: "write", edit: true });
    assert.deepEqual(report.probes.map((finding) => [finding.capability, finding.requested, finding.availability]), [
      ["worktree-identity", "required", "verified"],
      ["worktree-write", "write", "configured"],
      ["edit", "required", "configured"],
    ]);
    assert.deepEqual(report.gaps, []);
    const formatted = formatBossCreateCapabilityReport(report);
    assert.match(formatted, /\/usr\/bin\/git verified linked worktree/);
    assert.match(formatted, /configured access is policy evidence, not proof of effective Worker access/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("canonical cwd identity accepts a symlink to the exact linked-worktree root", async () => {
  const { dir, worktree } = await linkedWorktreeFixture();
  try {
    const alias = join(dir, "worktree-alias");
    await symlink(worktree, alias, "dir");
    const report = await inspectBossCreateCapabilities({
      cwd: alias,
      requirements: { worktree: "write" },
      workerPermissionProfileName: "builder-restricted",
      workerPermissionProfile: DEFAULT_PERMISSION_PROFILES["builder-restricted"],
    });
    assert.equal(report.status, "ready");
    assert.equal(report.cwd, worktree);
    assert.deepEqual(report.probes.map((finding) => finding.availability), ["verified", "configured"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("worktree write requires R|W|X on the canonical root", async () => {
  const { dir, worktree } = await linkedWorktreeFixture();
  try {
    await chmod(worktree, 0o500);
    const report = await inspectBossCreateCapabilities({
      cwd: worktree,
      requirements: { worktree: "write" },
      workerPermissionProfileName: "builder-restricted",
      workerPermissionProfile: DEFAULT_PERMISSION_PROFILES["builder-restricted"],
    });
    assert.equal(report.status, "blocked");
    assert.equal(report.probes[0].availability, "verified");
    assert.equal(report.gaps[0].capability, "worktree-write");
    assert.match(report.gaps[0].evidence, /failed the required R\|W\|X Controller access prerequisite/);
  } finally {
    await chmod(worktree, 0o755).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("marker-shaped directories cannot forge linked worktree identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boss-create-forged-worktree-"));
  try {
    const fake = join(dir, "fake");
    const admin = join(dir, "repository", ".git", "worktrees", "fake");
    await mkdir(fake, { recursive: true });
    await mkdir(admin, { recursive: true });
    await writeFile(join(fake, ".git"), `gitdir: ${admin}\n`);
    await writeFile(join(admin, "commondir"), "../..\n");
    const report = await inspectBossCreateCapabilities({
      cwd: fake,
      requirements: { worktree: "read" },
      workerPermissionProfileName: "review-readonly",
      workerPermissionProfile: DEFAULT_PERMISSION_PROFILES["review-readonly"],
    });
    assert.equal(report.status, "blocked");
    assert.deepEqual(report.probes.map((finding) => [finding.capability, finding.availability]), [
      ["worktree-identity", "gap"],
      ["worktree-read", "gap"],
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("read-only policy permits configured read but blocks requested worktree write and edit", async () => {
  const { cwd, dir } = await linkedWorktreeFixture();
  try {
    const readable = await inspectBossCreateCapabilities({
      cwd,
      requirements: { worktree: "read" },
      workerPermissionProfileName: "review-readonly",
      workerPermissionProfile: DEFAULT_PERMISSION_PROFILES["review-readonly"],
    });
    assert.equal(readable.status, "ready");
    assert.deepEqual(readable.probes.map((finding) => finding.availability), ["verified", "configured"]);

    const blocked = await inspectBossCreateCapabilities({
      cwd,
      requirements: { worktree: "write", edit: true },
      workerPermissionProfileName: "review-readonly",
      workerPermissionProfile: DEFAULT_PERMISSION_PROFILES["review-readonly"],
    });
    assert.equal(blocked.status, "blocked");
    assert.deepEqual(blocked.probes.map((finding) => [finding.capability, finding.availability]), [
      ["worktree-identity", "verified"],
      ["worktree-write", "gap"],
      ["edit", "gap"],
    ]);
    assert.deepEqual(blocked.gaps.map((finding) => finding.capability), ["worktree-write", "edit"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("nested cwd does not imply whole-worktree write under the standard builder profile", async () => {
  const { cwd, dir } = await linkedWorktreeFixture();
  try {
    const report = await inspectBossCreateCapabilities({
      cwd,
      requirements: { worktree: "write", edit: true },
      workerPermissionProfileName: "builder-restricted",
      workerPermissionProfile: DEFAULT_PERMISSION_PROFILES["builder-restricted"],
    });
    assert.equal(report.status, "blocked");
    assert.deepEqual(report.probes.map((finding) => [finding.capability, finding.availability]), [
      ["worktree-identity", "verified"],
      ["worktree-write", "gap"],
      ["edit", "configured"],
    ]);
    assert.match(report.gaps[0].evidence, /assigned cwd .* is nested below linked worktree root/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("custom profile path and systemd modifiers that can alter cwd fail closed", async () => {
  const variants: Array<[PermissionProfile, RegExp]> = [
    [{ ...DEFAULT_PERMISSION_PROFILES["builder-restricted"], inaccessiblePaths: ["/tmp"] }, /inaccessiblePaths entry \/tmp intersects/],
    [{ ...DEFAULT_PERMISSION_PROFILES["builder-restricted"], writablePaths: ["relative-path"] }, /writablePaths contains a relative path.*cannot model/],
    [{ ...DEFAULT_PERMISSION_PROFILES["builder-restricted"], systemdProperties: { ReadWritePaths: "/some/custom/boundary" } }, /custom systemdProperties.*not modeled/],
    [{ ...DEFAULT_PERMISSION_PROFILES["builder-restricted"], hardened: false }, /require a hardened permission profile/],
    [{ ...DEFAULT_PERMISSION_PROFILES["builder-restricted"], environment: { ...(DEFAULT_PERMISSION_PROFILES["builder-restricted"].environment ?? {}), AGENT_INTERCOM_WORKSPACE_POLICY: "read-only" } }, /environment overrides AGENT_INTERCOM_WORKSPACE_POLICY=read-only/],
  ];
  for (const [custom, evidence] of variants) {
    const report = await inspectBossCreateCapabilities({
      cwd: "/tmp",
      requirements: { edit: true },
      workerPermissionProfileName: "custom-builder",
      workerPermissionProfile: custom,
    });
    assert.equal(report.status, "blocked");
    assert.equal(report.gaps[0].capability, "edit");
    assert.match(report.gaps[0].evidence, evidence);
  }
});

test("an empty Pi tool list does not claim edit tools after Boss adds supervision-only tools", async () => {
  const report = await inspectBossCreateCapabilities({
    cwd: "/tmp",
    requirements: { edit: true },
    workerPermissionProfileName: "empty-tools-builder",
    workerPermissionProfile: { ...DEFAULT_PERMISSION_PROFILES["builder-restricted"], piTools: [] },
  });
  assert.equal(report.status, "blocked");
  assert.match(report.gaps[0].evidence, /does not configure both Pi edit and write tools/);
});

test("configured shell and Git inspection do not become verified tests or transport", async () => {
  const report = await inspectBossCreateCapabilities({
    cwd: "/tmp",
    requirements: { tests: true, gitTransport: "read" },
    workerPermissionProfileName: "builder-restricted",
    workerPermissionProfile: DEFAULT_PERMISSION_PROFILES["builder-restricted"],
  });
  assert.equal(report.status, "blocked");
  assert.deepEqual(report.probes.map((finding) => [finding.capability, finding.requested, finding.availability]), [
    ["tests", "required", "gap"],
    ["git-transport", "read", "gap"],
  ]);
  assert.deepEqual(report.gaps, report.probes);
  const formatted = formatBossCreateCapabilityReport(report);
  assert.match(formatted, /configures a shell, but no project-specific test command or toolchain was concretely probed/);
  assert.match(formatted, /read-only Git inspection is not transport/);
});

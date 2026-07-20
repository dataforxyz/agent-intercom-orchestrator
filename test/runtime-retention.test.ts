import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, mergeConfig, readConfig, writeConfigDefaults } from "../src/config.ts";
import {
  deleteOrphanRuntimeSafely,
  deleteTerminalRuntimeSafely,
  executeCleanupCandidatesIsolated,
  formatCleanupActions,
  inspectPath,
  recoverRuntimeCleanupClaims,
  terminalCachePaths,
} from "../src/runtime-retention.ts";
import { workerRuntimeRoot } from "../src/runtime.ts";
import { WorkerStore } from "../src/store.ts";
import { verifyUnitAbsentAndEmpty } from "../src/systemd.ts";
import type { CommandRunner, RuntimeCleanupClaim, WorkerRecord, WorkerStateFile } from "../src/types.ts";
import { reserveWorkerRecord } from "../src/workers.ts";

function worker(overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    id: "retained-worker",
    runId: "old-run",
    harness: "codex",
    backend: "systemd",
    role: "builder",
    task: "test retention",
    cwd: "/tmp",
    state: "stopped",
    owned: true,
    managerSessionId: "old-manager",
    unit: "agent-intercom-worker-retained-worker-old-run.service",
    createdAt: 1,
    updatedAt: 1,
    stoppedAt: 1,
    leaseExpiresAt: 1,
    ...overrides,
  };
}

const absentRunner: CommandRunner = {
  async exec(command, args) {
    if (command === "systemctl" && args.includes("list-units")) return { stdout: "", stderr: "", code: 0 };
    if (command === "systemctl") {
      return { stdout: "LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\n", stderr: "Unit not found", code: 1 };
    }
    if (command === "systemd-cgls") return { stdout: "", stderr: "Unit not found", code: 1 };
    return { stdout: "", stderr: "", code: 0 };
  },
};

test("runtime retention defaults and overrides are configurable", () => {
  assert.equal(DEFAULT_CONFIG.terminalCacheRetentionMinutes, 60);
  assert.equal(DEFAULT_CONFIG.terminalRuntimeRetentionMinutes, 7 * 24 * 60);
  assert.equal(DEFAULT_CONFIG.orphanRuntimeRetentionMinutes, 60);
  const migrated = mergeConfig({ leaseMinutes: 5 });
  assert.equal(migrated.terminalCacheRetentionMinutes, 60);
  assert.equal(migrated.terminalRuntimeRetentionMinutes, 7 * 24 * 60);
  assert.equal(migrated.orphanRuntimeRetentionMinutes, 60);
  const merged = mergeConfig({
    terminalCacheRetentionMinutes: 15,
    terminalRuntimeRetentionMinutes: 120,
    orphanRuntimeRetentionMinutes: 30,
  });
  assert.equal(merged.terminalCacheRetentionMinutes, 15);
  assert.equal(merged.terminalRuntimeRetentionMinutes, 120);
  assert.equal(merged.orphanRuntimeRetentionMinutes, 30);
  const invalid = mergeConfig({ terminalCacheRetentionMinutes: 0, terminalRuntimeRetentionMinutes: -1, orphanRuntimeRetentionMinutes: NaN });
  assert.equal(invalid.terminalCacheRetentionMinutes, 60);
  assert.equal(invalid.terminalRuntimeRetentionMinutes, 7 * 24 * 60);
  assert.equal(invalid.orphanRuntimeRetentionMinutes, 60);
});

test("cleanup reporting distinguishes every action and totals estimated bytes", () => {
  const actions = (["stop", "cache", "full", "orphan"] as const).map((action, index) => ({
    action,
    workerId: `${action}-worker`,
    reason: `${action} reason`,
    estimatedBytes: index,
  }));
  const formatted = formatCleanupActions(actions);
  for (const action of actions) assert.match(formatted, new RegExp(`\\[${action.action}\\] ${action.workerId}`));
  assert.match(formatted, /Total estimated bytes: 6 B/);
});

test("cleanup execution isolates one candidate failure and continues", async () => {
  const result = await executeCleanupCandidatesIsolated(["bad", "good"], async (candidate) => {
    if (candidate === "bad") throw new Error("unsafe runtime path");
    return true;
  });
  assert.deepEqual(result.executed, ["good"]);
  assert.deepEqual(result.errors, [{ candidate: "bad", error: "unsafe runtime path" }]);
});

test("legacy config migration persists explicit retention settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-intercom-retention-config-"));
  const path = join(root, "config.json");
  try {
    await writeFile(path, JSON.stringify({ leaseMinutes: 5 }));
    const config = await readConfig(path);
    config.terminalCacheRetentionMinutes = 10;
    config.terminalRuntimeRetentionMinutes = 20;
    config.orphanRuntimeRetentionMinutes = 30;
    await writeConfigDefaults(path, config);
    const raw = JSON.parse(await readFile(path, "utf8"));
    assert.equal(raw.terminalCacheRetentionMinutes, 10);
    assert.equal(raw.terminalRuntimeRetentionMinutes, 20);
    assert.equal(raw.orphanRuntimeRetentionMinutes, 30);
    assert.equal(raw.leaseMinutes, 5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("terminal cache pruning preserves primary harness state and its worker record", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-intercom-cache-retention-"));
  const agentDir = join(root, "agent");
  const store = new WorkerStore(join(root, "workers.json"));
  const record = worker();
  const runtime = workerRuntimeRoot(record.id, agentDir);
  const cache = terminalCachePaths(record.id, agentDir)[0];
  const primary = join(runtime, "home", ".codex", "thread-state.json");
  try {
    await mkdir(cache, { recursive: true });
    await mkdir(join(runtime, "home", ".codex"), { recursive: true });
    await writeFile(join(cache, "download.bin"), "cache bytes");
    await writeFile(primary, "primary state");
    await store.write({ version: 1, workers: [record] });
    assert.equal(await deleteTerminalRuntimeSafely({
      store,
      runner: absentRunner,
      config: DEFAULT_CONFIG,
      agentDir,
      workerId: record.id,
      runId: record.runId,
      terminalAt: record.stoppedAt!,
      action: "cache",
      now: DEFAULT_CONFIG.terminalCacheRetentionMinutes * 60_000 + 1,
    }), true);
    assert.equal(await readFile(primary, "utf8"), "primary state");
    assert.equal((await store.read()).workers[0].runId, record.runId);
    assert.equal((await inspectPath(cache)).exists, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("terminal deletion refuses a loaded unit before touching runtime files", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-intercom-live-retention-"));
  const agentDir = join(root, "agent");
  const store = new WorkerStore(join(root, "workers.json"));
  const record = worker();
  const runtime = workerRuntimeRoot(record.id, agentDir);
  let removedRuntime = false;
  const runner: CommandRunner = {
    async exec(command) {
      if (command === "systemctl") return { stdout: "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=4242\n", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    },
  };
  try {
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, "state"), "keep");
    await store.write({ version: 1, workers: [record] });
    assert.equal(await deleteTerminalRuntimeSafely({
      store,
      runner,
      config: DEFAULT_CONFIG,
      agentDir,
      workerId: record.id,
      runId: record.runId,
      terminalAt: record.stoppedAt!,
      action: "full",
      now: DEFAULT_CONFIG.terminalRuntimeRetentionMinutes * 60_000 + 1,
      removePath: async (path) => {
        if (path === runtime) removedRuntime = true;
        await rm(path, { recursive: true, force: true });
      },
    }), false);
    assert.equal(removedRuntime, false);
    assert.equal(await readFile(join(runtime, "state"), "utf8"), "keep");
    assert.equal((await store.read()).workers.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unit absence verification rejects residual cgroup processes and unverifiable failures", async () => {
  const residual: CommandRunner = {
    async exec(command) {
      if (command === "systemctl") {
        return { stdout: "LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\n", stderr: "", code: 1 };
      }
      return { stdout: "Control group:\n└─4242 worker\n", stderr: "", code: 0 };
    },
  };
  assert.deepEqual(await verifyUnitAbsentAndEmpty(residual, "worker.service"), {
    absent: false,
    reason: "unit cgroup still owns processes: 4242",
  });
  const unavailable: CommandRunner = {
    async exec() {
      return { stdout: "", stderr: "Failed to connect to bus", code: 1 };
    },
  };
  assert.deepEqual(await verifyUnitAbsentAndEmpty(unavailable, "worker.service"), {
    absent: false,
    reason: "could not verify unit state: Failed to connect to bus",
  });
});

test("terminal cleanup refuses a different loaded run with the same worker id", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-intercom-same-id-unit-"));
  const agentDir = join(root, "agent");
  const store = new WorkerStore(join(root, "workers.json"));
  const record = worker();
  const runtime = workerRuntimeRoot(record.id, agentDir);
  const runner: CommandRunner = {
    async exec(command, args) {
      if (command === "systemctl" && args.includes("list-units")) {
        return { stdout: "agent-intercom-worker-retained-worker-new-run.service loaded active running\n", stderr: "", code: 0 };
      }
      if (command === "systemctl") {
        return { stdout: "LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\n", stderr: "Unit not found", code: 1 };
      }
      return { stdout: "", stderr: "Unit not found", code: 1 };
    },
  };
  try {
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, "keep"), "live same-id state");
    await store.write({ version: 1, workers: [record] });
    assert.equal(await deleteTerminalRuntimeSafely({
      store,
      runner,
      config: DEFAULT_CONFIG,
      agentDir,
      workerId: record.id,
      runId: record.runId,
      terminalAt: record.stoppedAt!,
      action: "full",
      now: Date.now(),
    }), false);
    assert.equal(await readFile(join(runtime, "keep"), "utf8"), "live same-id state");
    assert.equal((await store.read()).runtimeCleanupClaims?.length ?? 0, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cache cleanup rejects a symlinked intermediate directory without touching its target", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-intercom-cache-symlink-"));
  const agentDir = join(root, "agent");
  const store = new WorkerStore(join(root, "workers.json"));
  const record = worker();
  const runtime = workerRuntimeRoot(record.id, agentDir);
  const external = join(root, "external-home");
  try {
    await mkdir(join(external, ".cache"), { recursive: true });
    await writeFile(join(external, ".cache", "keep"), "outside");
    await mkdir(runtime, { recursive: true });
    await symlink(external, join(runtime, "home"), "dir");
    await store.write({ version: 1, workers: [record] });
    await assert.rejects(deleteTerminalRuntimeSafely({
      store,
      runner: absentRunner,
      config: DEFAULT_CONFIG,
      agentDir,
      workerId: record.id,
      runId: record.runId,
      terminalAt: record.stoppedAt!,
      action: "cache",
      now: DEFAULT_CONFIG.terminalCacheRetentionMinutes * 60_000 + 1,
    }), /symlink or non-directory ancestor/);
    assert.equal(await readFile(join(external, ".cache", "keep"), "utf8"), "outside");
    assert.equal((await store.read()).runtimeCleanupClaims?.length ?? 0, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("full cleanup unlinks a runtime-root symlink without following it", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-intercom-full-symlink-"));
  const agentDir = join(root, "agent");
  const store = new WorkerStore(join(root, "workers.json"));
  const record = worker();
  const runtime = workerRuntimeRoot(record.id, agentDir);
  const external = join(root, "external-runtime");
  try {
    await mkdir(external, { recursive: true });
    await writeFile(join(external, "keep"), "outside");
    await mkdir(join(agentDir, "intercom", "orchestrator", "worker-runtime"), { recursive: true });
    await symlink(external, runtime, "dir");
    await store.write({ version: 1, workers: [record] });
    assert.equal(await deleteTerminalRuntimeSafely({
      store,
      runner: absentRunner,
      config: DEFAULT_CONFIG,
      agentDir,
      workerId: record.id,
      runId: record.runId,
      terminalAt: record.stoppedAt!,
      action: "full",
      now: DEFAULT_CONFIG.terminalRuntimeRetentionMinutes * 60_000 + 1,
    }), true);
    assert.equal(await readFile(join(external, "keep"), "utf8"), "outside");
    assert.equal((await store.read()).workers.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stale run candidates do not rewrite state or remove the current runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-intercom-stale-run-"));
  const agentDir = join(root, "agent");
  const statePath = join(root, "workers.json");
  const store = new WorkerStore(statePath);
  const record = worker({ runId: "current-run" });
  const runtime = workerRuntimeRoot(record.id, agentDir);
  try {
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, "keep"), "current");
    await store.write({ version: 1, workers: [record] });
    const before = await readFile(statePath, "utf8");
    assert.equal(await deleteTerminalRuntimeSafely({
      store,
      runner: absentRunner,
      config: DEFAULT_CONFIG,
      agentDir,
      workerId: record.id,
      runId: "stale-run",
      terminalAt: record.stoppedAt!,
      action: "full",
      now: DEFAULT_CONFIG.terminalRuntimeRetentionMinutes * 60_000 + 1,
    }), false);
    assert.equal(await readFile(statePath, "utf8"), before);
    assert.equal(await readFile(join(runtime, "keep"), "utf8"), "current");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a replacement between claim and unit verification fences the stale deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-intercom-replaced-run-"));
  const agentDir = join(root, "agent");
  const store = new WorkerStore(join(root, "workers.json"));
  const old = worker();
  const runtime = workerRuntimeRoot(old.id, agentDir);
  let replaced = false;
  const runner: CommandRunner = {
    async exec(command) {
      if (command === "systemctl" && !replaced) {
        replaced = true;
        await store.mutate((state) => {
          state.workers[0] = worker({ runId: "new-run", state: "provisioning", stoppedAt: undefined, updatedAt: 2 });
        });
        return { stdout: "LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\n", stderr: "Unit not found", code: 1 };
      }
      return { stdout: "", stderr: "Unit not found", code: 1 };
    },
  };
  try {
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, "keep"), "new runtime");
    await store.write({ version: 1, workers: [old] });
    assert.equal(await deleteTerminalRuntimeSafely({
      store,
      runner,
      config: DEFAULT_CONFIG,
      agentDir,
      workerId: old.id,
      runId: old.runId,
      terminalAt: old.stoppedAt!,
      action: "full",
      now: DEFAULT_CONFIG.terminalRuntimeRetentionMinutes * 60_000 + 1,
    }), false);
    assert.equal((await store.read()).workers[0].runId, "new-run");
    assert.equal(await readFile(join(runtime, "keep"), "utf8"), "new runtime");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a fresh cleanup claim blocks same-id reservation only during verification and quarantine", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-intercom-cleanup-claim-"));
  const agentDir = join(root, "agent");
  const store = new WorkerStore(join(root, "workers.json"));
  const old = worker();
  const runtime = workerRuntimeRoot(old.id, agentDir);
  let releaseVerification!: () => void;
  let verificationEntered!: () => void;
  const blocked = new Promise<void>((resolve) => { releaseVerification = resolve; });
  const entered = new Promise<void>((resolve) => { verificationEntered = resolve; });
  const runner: CommandRunner = {
    async exec(command, args) {
      if (command === "systemctl" && args.includes("list-units")) return { stdout: "", stderr: "", code: 0 };
      if (command === "systemctl") {
        verificationEntered();
        await blocked;
        return { stdout: "LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\n", stderr: "Unit not found", code: 1 };
      }
      return { stdout: "", stderr: "Unit not found", code: 1 };
    },
  };
  try {
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, "old"), "old");
    await store.write({ version: 1, workers: [old] });
    const now = Date.now();
    const deleting = deleteTerminalRuntimeSafely({
      store,
      runner,
      config: DEFAULT_CONFIG,
      agentDir,
      workerId: old.id,
      runId: old.runId,
      terminalAt: old.stoppedAt!,
      action: "full",
      now,
    });
    await entered;
    await assert.rejects(store.mutate((state) => reserveWorkerRecord(
      state,
      worker({ runId: "new-run", state: "provisioning", stoppedAt: undefined }),
      now,
    )), /runtime cleanup is in progress/);
    releaseVerification();
    assert.equal(await deleting, true);
    await store.mutate((state) => reserveWorkerRecord(
      state,
      worker({ runId: "new-run", state: "provisioning", stoppedAt: undefined }),
      now,
    ));
    assert.equal((await store.read()).workers[0].runId, "new-run");
  } finally {
    releaseVerification?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("a workers.json commit failure after quarantine rename restores the full runtime", async () => {
  class FailingCommitStore extends WorkerStore {
    failMovedCommit = false;
    override async write(state: WorkerStateFile): Promise<void> {
      if (this.failMovedCommit && state.runtimeCleanupClaims?.some((claim) => claim.phase === "moved")) {
        this.failMovedCommit = false;
        throw new Error("injected state commit failure");
      }
      await super.write(state);
    }
  }
  const root = await mkdtemp(join(tmpdir(), "agent-intercom-commit-recovery-"));
  const agentDir = join(root, "agent");
  const store = new FailingCommitStore(join(root, "workers.json"));
  const record = worker();
  const runtime = workerRuntimeRoot(record.id, agentDir);
  try {
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, "primary-state"), "preserve me");
    await store.write({ version: 1, workers: [record] });
    store.failMovedCommit = true;
    await assert.rejects(deleteTerminalRuntimeSafely({
      store,
      runner: absentRunner,
      config: DEFAULT_CONFIG,
      agentDir,
      workerId: record.id,
      runId: record.runId,
      terminalAt: record.stoppedAt!,
      action: "full",
      now: Date.now(),
    }), /injected state commit failure/);
    assert.equal(await readFile(join(runtime, "primary-state"), "utf8"), "preserve me");
    const state = await store.read();
    assert.equal(state.workers[0].runId, record.runId);
    assert.equal(state.runtimeCleanupClaims?.length ?? 0, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a partial multi-path rename failure rolls quarantined paths back before clearing the claim", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-intercom-partial-rename-"));
  const agentDir = join(root, "agent");
  const store = new WorkerStore(join(root, "workers.json"));
  const record = worker();
  const runtime = workerRuntimeRoot(record.id, agentDir);
  const health = join(agentDir, "intercom", "orchestrator", "opencode-peers", `${record.id}.health.json`);
  let renameCount = 0;
  try {
    await mkdir(runtime, { recursive: true });
    await mkdir(join(health, ".."), { recursive: true });
    await writeFile(join(runtime, "primary-state"), "runtime state");
    await writeFile(health, "health state");
    await store.write({ version: 1, workers: [record] });
    await assert.rejects(deleteTerminalRuntimeSafely({
      store,
      runner: absentRunner,
      config: DEFAULT_CONFIG,
      agentDir,
      workerId: record.id,
      runId: record.runId,
      terminalAt: record.stoppedAt!,
      action: "full",
      now: Date.now(),
      renamePath: async (source, destination) => {
        renameCount += 1;
        if (renameCount === 2) throw new Error("injected partial rename failure");
        await rename(source, destination);
      },
    }), /injected partial rename failure/);
    assert.equal(await readFile(join(runtime, "primary-state"), "utf8"), "runtime state");
    assert.equal(await readFile(health, "utf8"), "health state");
    const state = await store.read();
    assert.equal(state.workers[0].runId, record.runId);
    assert.equal(state.runtimeCleanupClaims?.length ?? 0, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("startup recovery restores a runtime stranded in the moving phase", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-intercom-crash-recovery-"));
  const agentDir = join(root, "agent");
  const store = new WorkerStore(join(root, "workers.json"));
  const token = "full-retained-worker-crash-token";
  const record = worker();
  const claim: RuntimeCleanupClaim = {
    token,
    workerId: record.id,
    runId: record.runId,
    terminalAt: record.stoppedAt,
    unit: record.unit,
    action: "full",
    claimedAt: Date.now(),
    ownerPid: 99_999_999,
    phase: "moving",
    pathIndexes: [0],
  };
  const runtime = workerRuntimeRoot(record.id, agentDir);
  const quarantine = join(agentDir, "intercom", "orchestrator", "runtime-quarantine", token);
  try {
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, "primary-state"), "recover me");
    await mkdir(quarantine, { recursive: true });
    await rename(runtime, join(quarantine, "0"));
    await store.write({ version: 1, workers: [record], runtimeCleanupClaims: [claim] });
    const recovered = await recoverRuntimeCleanupClaims({ store, runner: absentRunner, agentDir });
    assert.equal(recovered.restored, 1);
    assert.equal(await readFile(join(runtime, "primary-state"), "utf8"), "recover me");
    assert.equal((await store.read()).runtimeCleanupClaims?.length ?? 0, 0);
    assert.equal((await inspectPath(quarantine)).exists, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("startup recovery completes a moved orphan claim and removes its durable marker", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-intercom-orphan-recovery-"));
  const agentDir = join(root, "agent");
  const store = new WorkerStore(join(root, "workers.json"));
  const token = "orphan-stranded-worker-token";
  const claim: RuntimeCleanupClaim = { token, workerId: "stranded-worker", action: "orphan", claimedAt: Date.now(), ownerPid: 99_999_999, phase: "moved", pathIndexes: [0] };
  const quarantine = join(agentDir, "intercom", "orchestrator", "runtime-quarantine", token);
  try {
    await mkdir(quarantine, { recursive: true });
    await writeFile(join(quarantine, "0"), "orphan state");
    await store.write({ version: 1, workers: [], runtimeCleanupClaims: [claim] });
    const recovered = await recoverRuntimeCleanupClaims({ store, runner: absentRunner, agentDir });
    assert.equal(recovered.completed, 1);
    assert.equal((await inspectPath(quarantine)).exists, false);
    assert.equal((await store.read()).runtimeCleanupClaims?.length ?? 0, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a recursive deletion failure leaves a retryable durable claim", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-intercom-delete-retry-"));
  const agentDir = join(root, "agent");
  const store = new WorkerStore(join(root, "workers.json"));
  const record = worker();
  const runtime = workerRuntimeRoot(record.id, agentDir);
  try {
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, "primary-state"), "retry deletion");
    await store.write({ version: 1, workers: [record] });
    await assert.rejects(deleteTerminalRuntimeSafely({
      store,
      runner: absentRunner,
      config: DEFAULT_CONFIG,
      agentDir,
      workerId: record.id,
      runId: record.runId,
      terminalAt: record.stoppedAt!,
      action: "full",
      now: Date.now(),
      removePath: async () => { throw new Error("injected recursive deletion failure"); },
    }), /injected recursive deletion failure/);
    const stranded = await store.read();
    assert.equal(stranded.workers[0].runId, record.runId);
    assert.equal(stranded.runtimeCleanupClaims?.[0].phase, "deleting");
    assert.equal(stranded.runtimeCleanupClaims?.[0].ownerPid, 0);
    const recovered = await recoverRuntimeCleanupClaims({ store, runner: absentRunner, agentDir });
    assert.equal(recovered.completed, 1);
    assert.deepEqual(recovered.errors, []);
    const cleaned = await store.read();
    assert.equal(cleaned.workers.length, 0);
    assert.equal(cleaned.runtimeCleanupClaims?.length ?? 0, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("full retention quarantines atomically and releases the state lock before slow deletion", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-intercom-full-respawn-"));
  const agentDir = join(root, "agent");
  const store = new WorkerStore(join(root, "workers.json"));
  const old = worker();
  const runtime = workerRuntimeRoot(old.id, agentDir);
  let releaseDelete!: () => void;
  let deleteEntered!: () => void;
  const blocked = new Promise<void>((resolve) => { releaseDelete = resolve; });
  const entered = new Promise<void>((resolve) => { deleteEntered = resolve; });
  try {
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, "old-state"), "old");
    await store.write({ version: 1, workers: [old] });
    const deleting = deleteTerminalRuntimeSafely({
      store,
      runner: absentRunner,
      config: DEFAULT_CONFIG,
      agentDir,
      workerId: old.id,
      runId: old.runId,
      terminalAt: old.stoppedAt!,
      action: "full",
      now: DEFAULT_CONFIG.terminalRuntimeRetentionMinutes * 60_000 + 1,
      removePath: async (path) => {
        deleteEntered();
        await blocked;
        await rm(path, { recursive: true, force: true });
      },
    });
    await entered;
    await store.mutate((state) => {
      state.workers.push(worker({ id: "unrelated-worker", runId: "other-run" }));
    });
    await assert.rejects(store.mutate((state) => reserveWorkerRecord(
      state,
      worker({ runId: "new-run", state: "provisioning", stoppedAt: undefined, updatedAt: 2 }),
    )), /runtime cleanup is in progress/);
    releaseDelete();
    assert.equal(await deleting, true);
    await store.mutate((state) => reserveWorkerRecord(
      state,
      worker({ runId: "new-run", state: "provisioning", stoppedAt: undefined, updatedAt: 2 }),
    ));
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, "new-state"), "new");
    assert.equal((await store.read()).workers.find((candidate) => candidate.id === old.id)?.runId, "new-run");
    assert.equal(await readFile(join(runtime, "new-state"), "utf8"), "new");
  } finally {
    releaseDelete?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("orphan deletion quarantines atomically and does not hold the state lock during slow removal", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-intercom-orphan-respawn-"));
  const agentDir = join(root, "agent");
  const store = new WorkerStore(join(root, "workers.json"));
  const runtime = workerRuntimeRoot("orphan-worker", agentDir);
  let releaseDelete!: () => void;
  let deleteEntered!: () => void;
  const blocked = new Promise<void>((resolve) => { releaseDelete = resolve; });
  const entered = new Promise<void>((resolve) => { deleteEntered = resolve; });
  try {
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, "old-state"), "old");
    await store.write({ version: 1, workers: [] });
    const deleting = deleteOrphanRuntimeSafely({
      store,
      runner: absentRunner,
      config: DEFAULT_CONFIG,
      agentDir,
      workerId: "orphan-worker",
      path: runtime,
      now: Date.now() + 2 * 60 * 60_000,
      removePath: async (path) => {
        deleteEntered();
        await blocked;
        await rm(path, { recursive: true, force: true });
      },
    });
    await entered;
    await store.mutate((state) => {
      state.workers.push(worker({ id: "unrelated-worker", runId: "other-run" }));
    });
    await assert.rejects(store.mutate((state) => reserveWorkerRecord(
      state,
      worker({ id: "orphan-worker", runId: "new-run", state: "provisioning", stoppedAt: undefined }),
    )), /runtime cleanup is in progress/);
    releaseDelete();
    assert.equal(await deleting, true);
    await store.mutate((state) => reserveWorkerRecord(
      state,
      worker({ id: "orphan-worker", runId: "new-run", state: "provisioning", stoppedAt: undefined }),
    ));
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, "new-state"), "new");
    assert.equal((await store.read()).workers.find((candidate) => candidate.id === "orphan-worker")?.runId, "new-run");
    assert.equal(await readFile(join(runtime, "new-state"), "utf8"), "new");
  } finally {
    releaseDelete?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("orphan cleanup rechecks registration after unit enumeration", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-intercom-orphan-register-race-"));
  const agentDir = join(root, "agent");
  const store = new WorkerStore(join(root, "workers.json"));
  const runtime = workerRuntimeRoot("orphan-worker", agentDir);
  let registered = false;
  const runner: CommandRunner = {
    async exec(command, args) {
      if (command === "systemctl" && args.includes("list-units") && !registered) {
        registered = true;
        await store.mutate((state) => {
          state.workers.push(worker({ id: "orphan-worker", runId: "new-run", state: "provisioning", stoppedAt: undefined }));
        });
      }
      return { stdout: "", stderr: "", code: 0 };
    },
  };
  try {
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, "keep"), "registered runtime");
    await store.write({ version: 1, workers: [] });
    assert.equal(await deleteOrphanRuntimeSafely({
      store,
      runner,
      config: DEFAULT_CONFIG,
      agentDir,
      workerId: "orphan-worker",
      path: runtime,
      now: Date.now() + 2 * 60 * 60_000,
    }), false);
    assert.equal((await store.read()).workers[0].runId, "new-run");
    assert.equal(await readFile(join(runtime, "keep"), "utf8"), "registered runtime");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("orphan cleanup refuses a matching loaded unit and an unverifiable unit list", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-intercom-orphan-unit-"));
  const agentDir = join(root, "agent");
  const store = new WorkerStore(join(root, "workers.json"));
  const runtime = workerRuntimeRoot("orphan-worker", agentDir);
  try {
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, "keep"), "live runtime");
    await store.write({ version: 1, workers: [] });
    const loaded: CommandRunner = {
      async exec() {
        return { stdout: "agent-intercom-worker-orphan-worker-live.service loaded active running\n", stderr: "", code: 0 };
      },
    };
    const input = {
      store,
      config: DEFAULT_CONFIG,
      agentDir,
      workerId: "orphan-worker",
      path: runtime,
      now: Date.now() + 2 * 60 * 60_000,
    };
    assert.equal(await deleteOrphanRuntimeSafely({ ...input, runner: loaded }), false);
    const unavailable: CommandRunner = {
      async exec() {
        return { stdout: "", stderr: "Failed to connect to bus", code: 1 };
      },
    };
    assert.equal(await deleteOrphanRuntimeSafely({ ...input, runner: unavailable }), false);
    assert.equal(await readFile(join(runtime, "keep"), "utf8"), "live runtime");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

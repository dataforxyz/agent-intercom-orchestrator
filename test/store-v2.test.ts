import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  WorkerStore,
  WorkerStoreConflictError,
  WorkerStoreCorruptError,
  WorkerStoreMigrationPendingError,
  WorkerStorePoisonedError,
  WorkerStoreUnsupportedVersionError,
  WorkerStoreValidationError,
} from "../src/store.ts";
import type { LegacyWorkerState, WorkerRecord, WorkerStateFileV3 } from "../src/types.ts";
import { acquireKernelFileLock } from "../src/file-lock.ts";

function legacyWorker(id: string, state: LegacyWorkerState, runId = `run-${id}`): Record<string, unknown> {
  return {
    id,
    runId,
    harness: "pi",
    role: "builder",
    task: `task-${id}`,
    cwd: "/tmp",
    state,
    owned: true,
    managerSessionId: "manager-session",
    createdAt: 1,
    updatedAt: 2,
    leaseExpiresAt: 3,
    ...(state === "completed" ? { stoppedAt: 2, stopReason: "one-shot-complete" } : {}),
  };
}

function apiWorker(id: string, runId = `run-${id}`, state: WorkerRecord["state"] = "stopped"): WorkerRecord {
  return {
    id,
    runId,
    harness: "codex",
    backend: "systemd",
    role: "builder",
    task: `task-${id}`,
    cwd: "/tmp",
    state,
    owned: true,
    managerSessionId: "manager-session",
    createdAt: 1,
    updatedAt: 2,
    leaseExpiresAt: 3,
  };
}

test("durable stop intent round-trips as a late-start fence", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-stop-fence-"));
  const path = join(root, "workers.json");
  try {
    const store = new WorkerStore(path);
    await store.mutate((state) => {
      const worker = apiWorker("stop-fence", "run-stop-fence", "blocked");
      worker.stateReason = "stop_in_progress";
      worker.stopRequestedAt = 1234;
      worker.stopReason = "manager-requested";
      worker.unit = "agent-intercom-worker-stop-fence-run.service";
      worker.lastAuthenticatedIntercomActivityAt = 1200;
      state.workers.push(worker);
    });
    const reloaded = await new WorkerStore(path).read();
    assert.equal(reloaded.workers[0].stopRequestedAt, 1234);
    assert.equal(reloaded.workers[0].stopReason, "manager-requested");
    assert.equal(reloaded.workers[0].unit, "agent-intercom-worker-stop-fence-run.service");
    assert.equal(reloaded.workers[0].lastAuthenticatedIntercomActivityAt, 1200);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("WorkerStore v1 migration maps every state, identity, owner, and audit field without inventing activity evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-v2-mapping-"));
  const path = join(root, "workers.json");
  const states: LegacyWorkerState[] = [
    "provisioning", "running", "idle", "needs_attention", "completed", "failed", "stopping", "stopped", "lost",
  ];
  try {
    const workers = states.map((state) => ({
      ...legacyWorker(state, state),
      // A briefly shipped writer emitted this under an unchanged legacy
      // header. v1 cannot authenticate its semantics, so migration drops it.
      lastAuthenticatedIntercomActivityAt: 9_000,
    }));
    await writeFile(path, JSON.stringify({ version: 1, workers }));
    const store = new WorkerStore(path, { now: () => 10_000 });
    const migrated = await store.read();
    const expected = new Map<LegacyWorkerState, WorkerRecord["state"]>([
      ["provisioning", "provisioning"],
      ["running", "registering"],
      ["idle", "registering"],
      ["needs_attention", "blocked"],
      ["completed", "stopped"],
      ["failed", "failed"],
      ["stopping", "migration_pending"],
      ["stopped", "stopped"],
      ["lost", "lost"],
    ]);
    assert.equal(migrated.version, 3);
    assert.equal(migrated.generation, 1);
    for (const worker of migrated.workers) {
      const original = worker.id as LegacyWorkerState;
      assert.equal(worker.state, expected.get(original));
      assert.equal(worker.workerIncarnationId, `run-${original}`);
      assert.equal(worker.runId, `run-${original}`);
      assert.equal(worker.workerGeneration, 1);
      assert.equal(worker.bossRunId, undefined);
      assert.equal(worker.lastAuthenticatedIntercomActivityAt, undefined);
      assert.deepEqual(worker.managerOwner, {
        context: "pi",
        principalId: "manager-session",
        sessionId: "manager-session",
        bindingEpoch: 0,
      });
      assert.equal(worker.migrationAudit?.originalState, original);
      assert.equal(worker.migrationAudit?.originalRunId, `run-${original}`);
    }
    assert.equal(migrated.workers.find((worker) => worker.id === "running")?.migrationAudit?.requiresReadinessReconciliation, true);
    assert.equal(migrated.workers.find((worker) => worker.id === "idle")?.migrationAudit?.legacyIdleHint, true);
    assert.equal(migrated.workers.find((worker) => worker.id === "needs_attention")?.stateReason, "legacy_needs_attention");
    assert.equal(migrated.workers.find((worker) => worker.id === "completed")?.terminalOutcome, "completed");
    assert.equal(migrated.workers.find((worker) => worker.id === "completed")?.migrationAudit?.originalOutcome.stopReason, "one-shot-complete");
    assert.equal(migrated.workers.find((worker) => worker.id === "stopping")?.migrationAudit?.dispatchDenied, true);

    // A read is non-mutating; the named migration makes the v3 rename durable.
    assert.equal(JSON.parse(await readFile(path, "utf8")).version, 1);
    await store.migrate();
    const raw = JSON.parse(await readFile(path, "utf8"));
    assert.equal(raw.version, 3);
    assert.equal(raw.workers[0].runId, undefined);
    assert.equal(raw.workers[0].managerSessionId, undefined);
    assert.equal(raw.workers[0].workerIncarnationId, "run-provisioning");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("WorkerStore v2 migration preserves canonical state but drops unauthenticated legacy timestamp claims", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-v3-v2-migration-"));
  const path = join(root, "workers.json");
  const source = {
    version: 2,
    generation: 7,
    workers: [{
      id: "legacy-v2",
      workerIncarnationId: "incarnation-v2",
      workerGeneration: 4,
      harness: "codex",
      backend: "systemd",
      role: "builder",
      task: "preserve this task",
      cwd: "/tmp",
      state: "working",
      owned: true,
      managerOwner: { context: "pi", principalId: "manager", sessionId: "manager", bindingEpoch: 2 },
      createdAt: 10,
      updatedAt: 20,
      leaseExpiresAt: 30,
      lastWorkerActivityAt: 19,
      lastAuthenticatedIntercomActivityAt: 18,
    }],
    workerGenerations: [{ workerId: "legacy-v2", generation: 4 }],
  };
  try {
    await writeFile(path, `${JSON.stringify(source)}\n`);
    const store = new WorkerStore(path);
    const migrated = await store.read();
    assert.equal(migrated.version, 3);
    assert.equal(migrated.generation, 7);
    assert.equal(migrated.workers[0].task, "preserve this task");
    assert.equal(migrated.workers[0].lastWorkerActivityAt, 19);
    assert.equal(migrated.workers[0].lastAuthenticatedIntercomActivityAt, undefined);
    assert.equal(JSON.parse(await readFile(path, "utf8")).version, 2, "read must not rewrite legacy state");

    await store.migrate();
    const raw = JSON.parse(await readFile(path, "utf8"));
    assert.equal(raw.version, 3);
    assert.equal(raw.generation, 7);
    assert.equal(raw.workers[0].lastAuthenticatedIntercomActivityAt, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy stopping is read-only and only bounded explicit reconciliation can settle it", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-v2-stopping-"));
  const path = join(root, "workers.json");
  try {
    await writeFile(path, JSON.stringify({ version: 1, workers: [legacyWorker("pending", "stopping")] }));
    const store = new WorkerStore(path, { now: () => 1_000, legacyStoppingSettleMs: 50 });
    await store.migrate();
    await assert.rejects(store.mutate((state) => {
      state.workers[0].task = "dispatch attempted";
    }), WorkerStoreMigrationPendingError);
    await assert.rejects(
      store.reconcileLegacyStopping("pending", "unreachable", { observedAt: 1_049 }),
      /cannot become unreachable before/,
    );
    const settled = await store.reconcileLegacyStopping("pending", "unreachable", { observedAt: 1_050 });
    assert.equal(settled.workers[0].state, "unreachable");
    assert.equal(settled.workers[0].stateReason, "legacy_stopping_unresolved");
    assert.equal(settled.workers[0].migrationAudit?.resolution, "unreachable");
    assert.equal(settled.workers[0].workerGeneration, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("programmatic writes reject proxies, accessors, inherited data, sparse arrays, and unknown fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-v2-exact-data-"));
  const store = new WorkerStore(join(root, "workers.json"));
  try {
    const valid: WorkerStateFileV3 = { version: 3, generation: 0, workers: [], workerGenerations: [] };
    await assert.rejects(store.write(new Proxy(valid, {}) as WorkerStateFileV3), WorkerStoreValidationError);

    const accessor = { workers: [] } as unknown as WorkerStateFileV3;
    Object.defineProperty(accessor, "version", { enumerable: true, get: () => 3 });
    Object.defineProperty(accessor, "generation", { enumerable: true, value: 0 });
    await assert.rejects(store.write(accessor), WorkerStoreValidationError);

    const inherited = Object.assign(Object.create({ inherited: true }), valid) as WorkerStateFileV3;
    await assert.rejects(store.write(inherited), WorkerStoreValidationError);

    const sparse = [] as WorkerRecord[];
    sparse.length = 1;
    await assert.rejects(store.write({ version: 3, generation: 0, workers: sparse }), WorkerStoreValidationError);

    const nonIndex = [] as WorkerRecord[];
    Object.defineProperty(nonIndex, "4294967295", { enumerable: true, value: apiWorker("hidden") });
    await assert.rejects(store.write({ version: 3, generation: 0, workers: nonIndex }), WorkerStoreValidationError);

    await assert.rejects(store.write({ ...valid, unknown: true } as WorkerStateFileV3), WorkerStoreValidationError);
    assert.equal((await store.read()).generation, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("corrupt state is quarantined durably while ENOENT alone reads as empty", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-v2-quarantine-"));
  const path = join(root, "workers.json");
  try {
    const empty = await new WorkerStore(path).read();
    assert.deepEqual(empty, { version: 3, generation: 0, workers: [], workerGenerations: [] });

    await writeFile(path, JSON.stringify({ version: 3, generation: 0, workers: [], workerGenerations: [], surprise: true }));
    const first = new WorkerStore(path, { now: () => 123 });
    let quarantinePath: string | undefined;
    await assert.rejects(first.read(), (error: unknown) => {
      assert.ok(error instanceof WorkerStoreCorruptError);
      quarantinePath = error.quarantinePath;
      return true;
    });
    assert.ok(quarantinePath);
    await access(quarantinePath!);
    await access(`${path}.poison.json`);
    await assert.rejects(new WorkerStore(path).read(), WorkerStorePoisonedError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed poison markers remain fail-closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-v2-malformed-poison-"));
  const path = join(root, "workers.json");
  try {
    for (const marker of ["null\n", "false\n", "{}\n", `${JSON.stringify({ version: 1, kind: "corrupt", statePath: `${path}.other`, detectedAt: 1, reason: "wrong store" })}\n`]) {
      await writeFile(`${path}.poison.json`, marker);
      await assert.rejects(new WorkerStore(path).read(), WorkerStorePoisonedError);
      await rm(`${path}.poison.json`, { force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("newer schemas refuse downgrade without rewriting, quarantining, or poisoning the source", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-v2-newer-"));
  const path = join(root, "workers.json");
  const source = `${JSON.stringify({ version: 4, generation: 99, workers: [], future: true })}\n`;
  try {
    await writeFile(path, source);
    await assert.rejects(new WorkerStore(path).read(), WorkerStoreUnsupportedVersionError);
    assert.equal(await readFile(path, "utf8"), source);
    await assert.rejects(access(`${path}.poison.json`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CAS fences stale writers and a new incarnation advances workerGeneration", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-v2-cas-"));
  const path = join(root, "workers.json");
  try {
    const first = new WorkerStore(path);
    const second = new WorkerStore(path);
    await first.compareAndSwap(0, () => undefined);
    await assert.rejects(second.compareAndSwap(0, () => undefined), WorkerStoreConflictError);
    await first.upsert(apiWorker("worker", "incarnation-1"));
    let snapshot = await first.read();
    assert.equal(snapshot.generation, 2);
    assert.equal(snapshot.workers[0].workerGeneration, 1);

    await first.mutate((state) => {
      state.workers[0].workerIncarnationId = "incarnation-2";
      state.workers[0].state = "provisioning";
    });
    snapshot = await first.read();
    assert.equal(snapshot.generation, 3);
    assert.equal(snapshot.workers[0].workerIncarnationId, "incarnation-2");
    assert.equal(snapshot.workers[0].runId, "incarnation-2");
    assert.equal(snapshot.workers[0].workerGeneration, 2);

    await first.mutate((state) => {
      state.workers[0].managerOwner = {
        context: "opencode",
        principalId: "new-principal",
        sessionId: "new-session",
        bindingEpoch: 1,
      };
    });
    snapshot = await first.read();
    assert.equal(snapshot.workers[0].managerSessionId, "new-session");
    assert.equal(snapshot.workers[0].managerOwner?.context, "opencode");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent stores reclaim one dead directory lock without deleting a replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-v2-stale-lock-"));
  const path = join(root, "workers.json");
  try {
    await mkdir(`${path}.lock`, { mode: 0o700 });
    await writeFile(`${path}.lock/owner.json`, `${JSON.stringify({ pid: 2_147_483_647, token: "dead-owner", createdAt: 0 })}\n`);
    const first = new WorkerStore(path);
    const second = new WorkerStore(path);
    const results = await Promise.allSettled([
      first.compareAndSwap(0, () => undefined),
      second.compareAndSwap(0, () => undefined),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected" && result.reason instanceof WorkerStoreConflictError).length, 1);
    assert.equal((await first.read()).generation, 1);
    await access(`${path}.lock.reclaim`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed fresh owners wait for age while stale guard files recover through kernel locking", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-v2-reclaim-fail-closed-"));
  const path = join(root, "workers.json");
  const lockPath = `${path}.lock`;
  try {
    await mkdir(lockPath, { mode: 0o700 });
    const malformedOwner = `${JSON.stringify({ pid: 0, token: "malformed-owner", createdAt: Date.now() })}\n`;
    await writeFile(`${lockPath}/owner.json`, malformedOwner);
    const store = new WorkerStore(path);
    const first = store.compareAndSwap(0, () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(await readFile(`${lockPath}/owner.json`, "utf8"), malformedOwner);
    await rm(lockPath, { recursive: true, force: true });
    await first;

    await mkdir(lockPath, { mode: 0o700 });
    const deadOwner = `${JSON.stringify({ pid: 2_147_483_647, token: "dead-owner", createdAt: 0 })}\n`;
    await writeFile(`${lockPath}/owner.json`, deadOwner);
    await writeFile(`${lockPath}.reclaim`, "left behind by a crashed helper\n");
    await store.compareAndSwap(1, () => undefined);
    await access(`${lockPath}.reclaim`);
    assert.equal((await store.read()).generation, 2);

    let entered!: () => void;
    const callbackEntered = new Promise<void>((resolve) => { entered = resolve; });
    let settled = false;
    let releaseExternalGuard!: () => Promise<void>;
    const guardedRelease = store.compareAndSwap(2, async () => {
      releaseExternalGuard = await acquireKernelFileLock(`${lockPath}.reclaim`, 1_000);
      entered();
    }).finally(() => { settled = true; });
    await callbackEntered;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(settled, false);
    await access(`${lockPath}/owner.json`);
    await releaseExternalGuard();
    await guardedRelease;
    await assert.rejects(access(lockPath));
    assert.equal((await store.read()).generation, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("public writes cannot enter an awaited same-instance transaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-v2-transaction-isolation-"));
  const path = join(root, "workers.json");
  try {
    const store = new WorkerStore(path);
    await store.upsert(apiWorker("base"));
    const staleA = await store.read();
    const staleB = structuredClone(staleA);
    let writes: Array<Promise<void>> = [];
    await store.transaction(async (state, persist) => {
      writes = [store.write(staleA), store.write(staleB)];
      state.workers[0].task = "transaction-won";
      await persist();
    });
    const results = await Promise.allSettled(writes);
    assert.deepEqual(results.map((result) => result.status), ["rejected", "rejected"]);
    assert.equal((await store.read()).workers[0].task, "transaction-won");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("forgotten worker ids retain generation history across later reuse", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-v2-generation-ledger-"));
  const path = join(root, "workers.json");
  try {
    const store = new WorkerStore(path);
    await store.upsert(apiWorker("reused", "incarnation-1"));
    assert.equal(await store.remove("reused"), true);
    let snapshot = await store.read();
    assert.deepEqual(snapshot.workerGenerations, [{ workerId: "reused", generation: 1 }]);

    await store.upsert(apiWorker("reused", "incarnation-2"));
    snapshot = await store.read();
    assert.equal(snapshot.workers[0].workerGeneration, 2);
    assert.deepEqual(snapshot.workerGenerations, [{ workerId: "reused", generation: 2 }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mutation snapshots publish only after persistence and remain detached afterward", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-v2-detached-"));
  const path = join(root, "workers.json");
  let leaked: WorkerStateFileV3 | undefined;
  try {
    const store = new WorkerStore(path);
    await store.mutate((state) => {
      leaked = state as WorkerStateFileV3;
      state.workers.push(apiWorker("detached"));
    });
    assert.equal(leaked?.generation, 1);
    leaked!.workers[0].task = "post-commit-memory-only";
    assert.equal((await store.read()).workers[0].task, "task-detached");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("crash points preserve the old commit before rename and reconcile the new commit after rename", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-v2-crash-"));
  const path = join(root, "workers.json");
  try {
    const seed = new WorkerStore(path);
    await seed.upsert(apiWorker("crash"));

    let failBeforeRename = true;
    const before = new WorkerStore(path, {
      faultInjector(point) {
        if (point === "after_temp_write" && failBeforeRename) {
          failBeforeRename = false;
          throw new Error("simulated pre-rename crash");
        }
      },
    });
    await assert.rejects(before.mutate((state) => { state.workers[0].task = "not committed"; }), /pre-rename crash/);
    assert.equal((await seed.read()).workers[0].task, "task-crash");

    let failAfterRename = true;
    const after = new WorkerStore(path, {
      faultInjector(point) {
        if (point === "after_rename" && failAfterRename) {
          failAfterRename = false;
          throw new Error("simulated post-rename crash");
        }
      },
    });
    await after.mutate((state) => { state.workers[0].task = "reconciled commit"; });
    assert.equal((await seed.read()).workers[0].task, "reconciled commit");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an ambiguous post-rename mismatch poisons further reads instead of publishing", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-v2-poison-"));
  const path = join(root, "workers.json");
  try {
    await new WorkerStore(path).upsert(apiWorker("poison"));
    let inject = true;
    const store = new WorkerStore(path, {
      async faultInjector(point) {
        if (point === "after_rename" && inject) {
          inject = false;
          await writeFile(path, "ambiguous bytes\n");
          throw new Error("simulated ambiguous rename result");
        }
      },
    });
    await assert.rejects(store.mutate((state) => { state.workers[0].task = "ambiguous"; }), WorkerStorePoisonedError);
    assert.equal((await store.quarantineStatus())?.kind, "ambiguous_commit");
    await assert.rejects(new WorkerStore(path).read(), WorkerStorePoisonedError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

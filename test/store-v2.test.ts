import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import {
  WorkerStore,
  WorkerStoreConflictError,
  WorkerStoreCorruptError,
  WorkerStoreMigrationPendingError,
  WorkerStorePoisonedError,
  WorkerStoreUnsupportedFeatureError,
  WorkerStoreUnsupportedVersionError,
  WorkerStoreValidationError,
} from "../src/store.ts";
import type { LegacyWorkerState, WorkerRecord, WorkerRecordV2, WorkerRecordV3, WorkerStateFileV3 } from "../src/types.ts";
import { acquireKernelFileLock } from "../src/file-lock.ts";

type AssertTrue<T extends true> = T;
type AssertFalse<T extends false> = T;
type V2HasAuthenticatedActivity = "lastAuthenticatedIntercomActivityAt" extends keyof WorkerRecordV2 ? true : false;
type V3HasAuthenticatedActivity = "lastAuthenticatedIntercomActivityAt" extends keyof WorkerRecordV3 ? true : false;
type _V2EvidenceBoundary = AssertFalse<V2HasAuthenticatedActivity>;
type _V3EvidenceBoundary = AssertTrue<V3HasAuthenticatedActivity>;

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

test("WorkerStore v1 migration maps every state, identity, owner, and audit field while leaving activity evidence undefined", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-v2-mapping-"));
  const path = join(root, "workers.json");
  const states: LegacyWorkerState[] = [
    "provisioning", "running", "idle", "needs_attention", "completed", "failed", "stopping", "stopped", "lost",
  ];
  try {
    const workers = states.map((state) => ({
      ...legacyWorker(state, state),
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
    assert.equal(raw.workers[0].lastAuthenticatedIntercomActivityAt, undefined);
    assert.equal(raw.workers[0].runId, undefined);
    assert.equal(raw.workers[0].managerSessionId, undefined);
    assert.equal(raw.workers[0].workerIncarnationId, "run-provisioning");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("WorkerStore v2 migration preserves canonical state while leaving activity evidence undefined", async () => {
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

test("WorkerStore migrates the briefly shipped v2 timestamp as an untrusted compatibility field", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-v3-v2-compat-"));
  const path = join(root, "workers.json");
  const source = {
    version: 2,
    generation: 1,
    workers: [{
      id: "compat-v2",
      workerIncarnationId: "incarnation",
      workerGeneration: 1,
      harness: "pi",
      backend: "systemd",
      role: "builder",
      task: "drop untrusted evidence",
      cwd: "/tmp",
      state: "working",
      owned: true,
      managerOwner: { context: "pi", principalId: "manager", sessionId: "manager", bindingEpoch: 0 },
      createdAt: 1,
      updatedAt: 2,
      leaseExpiresAt: 3,
      lastAuthenticatedIntercomActivityAt: 2,
    }],
    workerGenerations: [{ workerId: "compat-v2", generation: 1 }],
  };
  try {
    await writeFile(path, JSON.stringify(source));
    const store = new WorkerStore(path);
    assert.equal((await store.read()).workers[0].lastAuthenticatedIntercomActivityAt, undefined);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), source, "compatibility reads do not rewrite or quarantine v2");
    await store.migrate();
    const migrated = JSON.parse(await readFile(path, "utf8"));
    assert.equal(migrated.version, 3);
    assert.equal(migrated.workers[0].lastAuthenticatedIntercomActivityAt, undefined);
    await assert.rejects(access(`${path}.poison.json`));
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
  const source = `${JSON.stringify({ version: 4, generation: "must not parse", workers: [null], future: true })}\n`;
  try {
    await writeFile(path, source);
    await assert.rejects(new WorkerStore(path).read(), WorkerStoreUnsupportedVersionError);
    assert.equal(await readFile(path, "utf8"), source);
    await assert.rejects(access(`${path}.poison.json`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unsupported active features refuse before exact nested parsing without quarantine", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-v3-feature-gate-"));
  const path = join(root, "workers.json");
  const source = `${JSON.stringify({
    version: 3,
    generation: 1,
    activeFeatures: ["future-worker-shape"],
    workers: [{ futureNestedField: true }],
    workerGenerations: [],
    futureTopLevelField: true,
  })}\n`;
  try {
    await writeFile(path, source);
    await assert.rejects(new WorkerStore(path).read(), WorkerStoreUnsupportedFeatureError);
    assert.equal(await readFile(path, "utf8"), source);
    await assert.rejects(access(`${path}.poison.json`));
    assert.equal((await new WorkerStore(path, { supportedFeatures: ["future-worker-shape"] }).read().catch((error) => error)).code, "WORKER_STORE_CORRUPT");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed activeFeatures remains corrupt and quarantined instead of being assumed unsupported", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-v3-malformed-feature-gate-"));
  const path = join(root, "workers.json");
  try {
    await writeFile(path, JSON.stringify({
      version: 3,
      generation: 1,
      activeFeatures: { 0: "future-worker-shape", length: 1 },
      workers: [],
      workerGenerations: [],
    }));
    let quarantinePath: string | undefined;
    await assert.rejects(new WorkerStore(path).read(), (error: unknown) => {
      assert.ok(error instanceof WorkerStoreCorruptError);
      quarantinePath = error.quarantinePath;
      assert.match(error.message, /activeFeatures.*plain array/);
      return true;
    });
    assert.ok(quarantinePath);
    await access(quarantinePath!);
    await access(`${path}.poison.json`);
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

test("uncontended acquisition and owned atomic release skip the mutation guard", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-v2-release-guard-"));
  const path = join(root, "workers.json");
  try {
    const store = new WorkerStore(path);
    const instrumented = store as unknown as {
      acquireLockMutationGuard(lockPath: string, timeoutMs?: number): Promise<() => Promise<void>>;
    };
    const original = instrumented.acquireLockMutationGuard.bind(store);
    const timeouts: Array<number | undefined> = [];
    instrumented.acquireLockMutationGuard = async (lockPath, timeoutMs) => {
      timeouts.push(timeoutMs);
      return await original(lockPath, timeoutMs);
    };
    await store.compareAndSwap(0, () => undefined);
    assert.deepEqual(timeouts, []);
    await assert.rejects(access(`${path}.lock`), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("owner metadata write failure removes the incomplete uncontended claim", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-v2-owner-write-failure-"));
  const path = join(root, "workers.json");
  try {
    const store = new WorkerStore(path);
    const instrumented = store as unknown as {
      writeLockOwner(ownerPath: string, token: string): Promise<void>;
    };
    const original = instrumented.writeLockOwner.bind(store);
    instrumented.writeLockOwner = async () => {
      throw new Error("simulated owner metadata failure");
    };
    await assert.rejects(store.compareAndSwap(0, () => undefined), /simulated owner metadata failure/);
    const leftovers = (await readdir(root)).filter((entry) => entry.startsWith("workers.json.lock.released."));
    assert.equal(leftovers.length, 0);

    instrumented.writeLockOwner = original;
    await store.compareAndSwap(0, () => undefined);
    assert.equal((await store.read()).generation, 1);
    await assert.rejects(access(`${path}.lock`), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed fast-path cleanup cannot delete a replacement lock owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-v2-failed-claim-replacement-"));
  const path = join(root, "workers.json");
  const lockPath = `${path}.lock`;
  const ownerPath = `${lockPath}/owner.json`;
  try {
    const store = new WorkerStore(path);
    const instrumented = store as unknown as {
      writeLockOwner(ownerPath: string, token: string): Promise<void>;
    };
    instrumented.writeLockOwner = async () => {
      await rm(lockPath, { recursive: true, force: true });
      await mkdir(lockPath, { mode: 0o700 });
      await writeFile(ownerPath, `${JSON.stringify({ pid: process.pid, token: "replacement-owner", createdAt: Date.now() })}\n`);
      throw new Error("simulated replaced claim");
    };

    await assert.rejects(store.compareAndSwap(0, () => undefined), /simulated replaced claim/);
    const owner = JSON.parse(await readFile(ownerPath, "utf8")) as { token?: unknown };
    assert.equal(owner.token, "replacement-owner");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("contended acquisition retries mkdir under the guard after an owner release race", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-v2-release-race-"));
  const path = join(root, "workers.json");
  const lockPath = `${path}.lock`;
  try {
    await mkdir(lockPath, { mode: 0o700 });
    await writeFile(`${lockPath}/owner.json`, `${JSON.stringify({ pid: 2_147_483_647, token: "releasing-owner", createdAt: Date.now() })}\n`);
    const store = new WorkerStore(path);
    const instrumented = store as unknown as {
      acquireLockMutationGuard(lockPath: string, timeoutMs?: number): Promise<() => Promise<void>>;
    };
    const original = instrumented.acquireLockMutationGuard.bind(store);
    let simulatedRelease = false;
    instrumented.acquireLockMutationGuard = async (candidatePath, timeoutMs) => {
      if (!simulatedRelease && timeoutMs !== undefined) {
        simulatedRelease = true;
        await rm(candidatePath, { recursive: true, force: true });
      }
      return await original(candidatePath, timeoutMs);
    };

    await store.compareAndSwap(0, () => undefined);
    assert.equal(simulatedRelease, true);
    assert.equal((await store.read()).generation, 1);
    await assert.rejects(access(lockPath), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worker lock acquisition timeout reports the live owner and lock age", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-v2-timeout-diagnostics-"));
  const path = join(root, "workers.json");
  const lockPath = `${path}.lock`;
  try {
    await mkdir(lockPath, { mode: 0o700 });
    await writeFile(`${lockPath}/owner.json`, `${JSON.stringify({ pid: process.pid, token: "live-owner", createdAt: Date.now() })}\n`);
    const store = new WorkerStore(path, { lockTimeoutMs: 50 });
    await assert.rejects(
      store.compareAndSwap(0, () => undefined),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Timed out waiting for worker state lock/);
        assert.match(error.message, /timeoutMs=50/);
        assert.match(error.message, new RegExp(`ownerPid=${process.pid}`));
        assert.match(error.message, /ownerAlive=true/);
        assert.match(error.message, /lockAgeMs=\d+/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("worker lock timeout must be a positive safe integer", () => {
  assert.throws(() => new WorkerStore("/tmp/workers.json", { lockTimeoutMs: 0 }), /lockTimeoutMs must be a positive safe integer/);
  assert.throws(() => new WorkerStore("/tmp/workers.json", { lockTimeoutMs: 1.5 }), /lockTimeoutMs must be a positive safe integer/);
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
    assert.equal(settled, true, "owned atomic release must not wait for the reclaim guard");
    await assert.rejects(access(lockPath), { code: "ENOENT" });
    await releaseExternalGuard();
    await guardedRelease;
    await assert.rejects(access(lockPath));
    assert.equal((await store.read()).generation, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("live owners back off without reclaim-helper churn regardless of lock age", async () => {
  for (const age of ["fresh", "stale"] as const) {
    const root = await mkdtemp(join(tmpdir(), `worker-store-v3-live-precheck-${age}-`));
    const path = join(root, "workers.json");
    const lockPath = `${path}.lock`;
    try {
      await mkdir(lockPath, { mode: 0o700 });
      await writeFile(`${lockPath}/owner.json`, `${JSON.stringify({ pid: process.pid, token: "live-owner", createdAt: Date.now() })}\n`);
      if (age === "stale") await utimes(lockPath, new Date(0), new Date(0));
      const metrics: Array<{ operation: string }> = [];
      const store = new WorkerStore(path, { lockTimeoutMs: 120, instrumentation: (metric) => metrics.push(metric) });
      await assert.rejects(store.compareAndSwap(0, () => undefined), /WORKER_STORE|Timed out waiting/);
      await assert.rejects(access(`${lockPath}.reclaim`), { code: "ENOENT" });
      assert.equal(metrics.some((metric) => metric.operation === "lock_live_backoff"), true);
      assert.equal(metrics.some((metric) => metric.operation === "lock_reclaim_guard"), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("release tombstones are unique, replacement-safe, and age-gated", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-v3-release-tombstone-"));
  const path = join(root, "workers.json");
  const lockPath = `${path}.lock`;
  try {
    const fresh = `${lockPath}.released.fresh.token`;
    const aged = `${lockPath}.released.aged.token`;
    await mkdir(fresh, { mode: 0o700 });
    await mkdir(aged, { mode: 0o700 });
    await writeFile(`${fresh}/owner.json`, "fresh\n");
    await writeFile(`${aged}/owner.json`, "aged\n");
    await utimes(aged, new Date(0), new Date(0));

    const store = new WorkerStore(path);
    await store.compareAndSwap(0, () => undefined);
    await access(fresh);
    await assert.rejects(access(aged), { code: "ENOENT" });

    await mkdir(lockPath, { mode: 0o700 });
    await writeFile(`${lockPath}/owner.json`, `${JSON.stringify({ pid: process.pid, token: "replacement", createdAt: Date.now() })}\n`);
    const instrumented = store as unknown as { releaseOwnedLock(lockPath: string, token: string): Promise<void> };
    await assert.rejects(instrumented.releaseOwnedLock(lockPath, "not-replacement"), /token mismatch/);
    assert.equal(JSON.parse(await readFile(`${lockPath}/owner.json`, "utf8")).token, "replacement");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a crash-left release tombstone does not block a replacement owner and is collected only after aging", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-v3-release-crash-"));
  const path = join(root, "workers.json");
  const lockPath = `${path}.lock`;
  const tombstone = `${lockPath}.released.crashed-owner.crash-id`;
  try {
    await mkdir(tombstone, { mode: 0o700 });
    await writeFile(`${tombstone}/owner.json`, `${JSON.stringify({ pid: 2_147_483_647, token: "crashed-owner", createdAt: 0 })}\n`);

    const store = new WorkerStore(path);
    await store.compareAndSwap(0, () => undefined);
    assert.equal((await store.read()).generation, 1);
    await access(tombstone);

    await utimes(tombstone, new Date(0), new Date(0));
    await store.compareAndSwap(1, () => undefined);
    await assert.rejects(access(tombstone), { code: "ENOENT" });
    assert.equal((await store.read()).generation, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("current contenders interoperate with an old-process lock holder", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-v3-old-holder-"));
  const path = join(root, "workers.json");
  const lockPath = `${path}.lock`;
  const script = `
    const fs = require("node:fs");
    const lockPath = process.argv[1];
    fs.mkdirSync(lockPath, { mode: 0o700 });
    fs.writeFileSync(lockPath + "/owner.json", JSON.stringify({ pid: process.pid, token: "old-holder", createdAt: Date.now() }) + "\\n");
    process.stdout.write("ready\\n");
    setTimeout(() => { fs.rmSync(lockPath, { recursive: true, force: true }); }, 150);
  `;
  const child = spawn(process.execPath, ["-e", script, lockPath], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    await once(child.stdout!, "data");
    const store = new WorkerStore(path, { lockTimeoutMs: 2_000 });
    await store.compareAndSwap(0, () => undefined);
    assert.equal((await store.read()).generation, 1);
    if (child.exitCode === null) await once(child, "exit");
  } finally {
    if (child.exitCode === null) child.kill();
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

test("removing an absent worker is a no-op without a generation bump or write", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-v3-absent-remove-"));
  const path = join(root, "workers.json");
  try {
    const store = new WorkerStore(path);
    await store.upsert(apiWorker("present"));
    const before = await readFile(path, "utf8");
    assert.equal(await store.remove("absent"), false);
    assert.equal(await readFile(path, "utf8"), before);
    assert.equal((await store.read()).generation, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("healthy canonical v3 reads are lock-free and detached", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-v3-lock-free-read-"));
  const path = join(root, "workers.json");
  try {
    await new WorkerStore(path).upsert(apiWorker("fast-read"));
    await rm(`${path}.lock.reclaim`, { force: true });
    const metrics: Array<{ operation: string }> = [];
    const store = new WorkerStore(path, { instrumentation: (metric) => metrics.push(metric) });
    const snapshot = await store.read();
    snapshot.workers[0].task = "memory-only";
    assert.equal((await store.read()).workers[0].task, "task-fast-read");
    assert.equal(metrics.filter((metric) => metric.operation === "lock_wait").length, 0);
    await assert.rejects(access(`${path}.lock`), { code: "ENOENT" });
    await assert.rejects(access(`${path}.lock.reclaim`), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lock-free reads fail closed when poison appears after the state snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-v3-lock-free-poison-race-"));
  const path = join(root, "workers.json");
  try {
    await new WorkerStore(path).upsert(apiWorker("poison-race"));
    const store = new WorkerStore(path);
    const instrumented = store as unknown as {
      readPoisonMarker(): Promise<{ version: 1; kind: "corrupt"; statePath: string; detectedAt: number; reason: string } | undefined>;
    };
    let checks = 0;
    instrumented.readPoisonMarker = async () => {
      checks += 1;
      return checks === 2
        ? { version: 1, kind: "corrupt", statePath: path, detectedAt: 1, reason: "injected post-snapshot poison" }
        : undefined;
    };
    await assert.rejects(store.read(), WorkerStorePoisonedError);
    assert.equal(checks, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ENOENT and legacy reads fall back to the serialized locked path", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-v3-read-fallback-"));
  const absentPath = join(root, "absent.json");
  const legacyPath = join(root, "legacy.json");
  try {
    const absentMetrics: Array<{ operation: string }> = [];
    assert.equal((await new WorkerStore(absentPath, { instrumentation: (metric) => absentMetrics.push(metric) }).read()).generation, 0);
    assert.equal(absentMetrics.filter((metric) => metric.operation === "lock_wait").length, 1);

    await writeFile(legacyPath, JSON.stringify({ version: 1, workers: [legacyWorker("fallback", "running")] }));
    const legacyMetrics: Array<{ operation: string }> = [];
    const legacy = await new WorkerStore(legacyPath, { instrumentation: (metric) => legacyMetrics.push(metric) }).read();
    assert.equal(legacy.version, 3);
    assert.equal(legacy.workers[0].state, "registering");
    assert.equal(legacyMetrics.filter((metric) => metric.operation === "lock_wait").length, 1);
    assert.equal(JSON.parse(await readFile(legacyPath, "utf8")).version, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("conditional no-op preserves generation and bytes while returning a defensive snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-v3-conditional-snapshot-"));
  const path = join(root, "workers.json");
  try {
    const store = new WorkerStore(path);
    await store.upsert(apiWorker("conditional"));
    const before = await readFile(path, "utf8");
    const commit = await store.mutateConditionallyWithSnapshot(() => ({ value: "miss", changed: false }));
    assert.equal(commit.value, "miss");
    assert.equal(commit.generation, 1);
    assert.equal(commit.state.generation, 1);
    assert.equal(await readFile(path, "utf8"), before);
    commit.state.workers[0].task = "memory-only";
    assert.equal((await store.read()).workers[0].task, "task-conditional");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("optional WorkerStore instrumentation reports timings and bytes without state contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-v3-instrumentation-"));
  const path = join(root, "workers.json");
  const metrics: Array<{ operation: string; durationMs: number; outcome: string; bytes?: number }> = [];
  try {
    const store = new WorkerStore(path, { instrumentation: (metric) => metrics.push({ ...metric }) });
    await store.mutateConditionally(() => ({ value: undefined, changed: false }));
    await store.upsert(apiWorker("instrumented"));
    await store.read();
    assert.ok(metrics.some((metric) => metric.operation === "mutation" && metric.outcome === "noop"));
    assert.ok(metrics.some((metric) => metric.operation === "mutation" && metric.outcome === "ok"));
    assert.ok(metrics.some((metric) => metric.operation === "commit" && metric.outcome === "ok" && (metric.bytes ?? 0) > 0));
    assert.ok(metrics.some((metric) => metric.operation === "read" && metric.outcome === "ok"));
    assert.ok(metrics.some((metric) => metric.operation === "lock_wait" && metric.outcome === "ok"));
    assert.ok(metrics.some((metric) => metric.operation === "lock_release" && metric.outcome === "ok"));
    assert.deepEqual(await store.inspectLock(), { present: false });
    assert.ok(metrics.every((metric) => Number.isFinite(metric.durationMs) && metric.durationMs >= 0));
    assert.equal(JSON.stringify(metrics).includes("task-instrumented"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("instrumentation callback failures do not affect store operations", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-v3-instrumentation-failure-"));
  const path = join(root, "workers.json");
  try {
    const store = new WorkerStore(path, { instrumentation: () => { throw new Error("observer failed"); } });
    await store.upsert(apiWorker("observer-safe"));
    assert.equal((await store.read()).workers[0].id, "observer-safe");
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

test("WorkerStore preserves the separately digested prior canonical state before overwrite", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-recovery-snapshot-"));
  const path = join(root, "workers.json");
  try {
    const store = new WorkerStore(path, { now: () => 10_000 });
    await store.mutate((state) => { state.workers.push(apiWorker("recoverable", "run-recoverable", "ready")); });
    const populated = await store.read();
    await store.mutate((state) => { state.workers = []; });

    const snapshot = await store.readRecoverySnapshot();
    assert.ok(snapshot);
    assert.equal(snapshot.statePath, path);
    assert.equal(snapshot.capturedAt, 10_000);
    assert.equal(snapshot.state.generation, populated.generation);
    assert.deepEqual(snapshot.state.workers.map((worker) => worker.id), ["recoverable"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("WorkerStore restores an exact validated predecessor only from the assessed empty generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-recovery-restore-"));
  const path = join(root, "workers.json");
  try {
    const store = new WorkerStore(path);
    await store.mutate((state) => { state.workers.push(apiWorker("recoverable", "run-recoverable", "ready")); });
    await store.mutate((state) => { state.workers = []; });
    const empty = await store.read();
    const snapshot = await store.readRecoverySnapshot();
    assert.ok(snapshot);

    const restored = await store.restoreEmptyFromRecovery(empty.generation, snapshot.stateDigest);
    assert.equal(restored.generation, empty.generation + 1);
    assert.deepEqual(restored.workers.map((worker) => worker.id), ["recoverable"]);
    assert.deepEqual((await store.read()).workers, restored.workers);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("WorkerStore restore preserves the populated snapshot across pre- and post-rename faults", async () => {
  for (const faultPoint of ["after_file_fsync", "after_rename"] as const) {
    const root = await mkdtemp(join(tmpdir(), `worker-store-recovery-fault-${faultPoint}-`));
    const path = join(root, "workers.json");
    try {
      const seed = new WorkerStore(path);
      await seed.mutate((state) => { state.workers.push(apiWorker("recoverable", "run-recoverable", "ready")); });
      await seed.mutate((state) => { state.workers = []; });
      const empty = await seed.read();
      const snapshot = await seed.readRecoverySnapshot();
      assert.ok(snapshot);
      let inject = true;
      const restoring = new WorkerStore(path, {
        async faultInjector(point) {
          if (point === faultPoint && inject) {
            inject = false;
            throw new Error(`simulated ${faultPoint} restore failure`);
          }
        },
      });

      if (faultPoint === "after_file_fsync") {
        await assert.rejects(() => restoring.restoreEmptyFromRecovery(empty.generation, snapshot.stateDigest), /simulated/);
      } else {
        const restored = await restoring.restoreEmptyFromRecovery(empty.generation, snapshot.stateDigest);
        assert.deepEqual(restored.workers.map((entry) => entry.id), ["recoverable"]);
      }
      const preserved = await seed.readRecoverySnapshot();
      assert.deepEqual(preserved?.state.workers.map((entry) => entry.id), ["recoverable"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("WorkerStore recurring empty overwrite remains recoverable after a restore", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-recurring-recovery-"));
  const path = join(root, "workers.json");
  try {
    const store = new WorkerStore(path);
    await store.mutate((state) => { state.workers.push(apiWorker("recoverable", "run-recoverable", "ready")); });
    await store.mutate((state) => { state.workers = []; });
    let empty = await store.read();
    let snapshot = await store.readRecoverySnapshot();
    assert.ok(snapshot);
    await store.restoreEmptyFromRecovery(empty.generation, snapshot.stateDigest);

    await store.mutate((state) => { state.workers = []; });
    empty = await store.read();
    snapshot = await store.readRecoverySnapshot();
    assert.ok(snapshot);
    const restoredAgain = await store.restoreEmptyFromRecovery(empty.generation, snapshot.stateDigest);
    assert.deepEqual(restoredAgain.workers.map((entry) => entry.id), ["recoverable"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("WorkerStore recovery restore fails closed after canonical generation changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-recovery-conflict-"));
  const path = join(root, "workers.json");
  try {
    const store = new WorkerStore(path);
    await store.mutate((state) => { state.workers.push(apiWorker("recoverable", "run-recoverable", "ready")); });
    await store.mutate((state) => { state.workers = []; });
    const empty = await store.read();
    const snapshot = await store.readRecoverySnapshot();
    assert.ok(snapshot);
    await store.mutate((state) => { state.activeFeatures = []; });

    await assert.rejects(
      () => store.restoreEmptyFromRecovery(empty.generation, snapshot.stateDigest),
      WorkerStoreConflictError,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("WorkerStore rejects a recovery snapshot whose state no longer matches its digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-recovery-tamper-"));
  const path = join(root, "workers.json");
  try {
    const store = new WorkerStore(path);
    await store.mutate((state) => { state.workers.push(apiWorker("recoverable", "run-recoverable", "ready")); });
    await store.mutate((state) => { state.workers = []; });
    const recoveryPath = `${path}.recovery.json`;
    const snapshot = JSON.parse(await readFile(recoveryPath, "utf8"));
    snapshot.state.workers[0].task = "tampered";
    await writeFile(recoveryPath, JSON.stringify(snapshot));

    await assert.rejects(() => store.readRecoverySnapshot(), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "WORKER_STORE_RECOVERY_INVALID");
      assert.match((error as Error).message, /digest does not match/);
      return true;
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

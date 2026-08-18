import assert from "node:assert/strict";
import test from "node:test";
import { assessWorkerRegistryRecovery } from "../src/worker-registry-recovery.ts";
import type { UnitStatus, WorkerRecordV3, WorkerStateFileV3 } from "../src/types.ts";

const unit = "agent-intercom-worker-builder-inc-1.service";
const worker: WorkerRecordV3 = {
  id: "builder", runId: "inc-1", workerIncarnationId: "inc-1", workerGeneration: 1,
  harness: "codex", backend: "systemd", role: "builder", task: "build", cwd: "/tmp",
  state: "working", owned: true,
  managerOwner: { context: "pi", principalId: "manager", sessionId: "manager", bindingEpoch: 1 }, managerSessionId: "manager",
  unit, createdAt: 1, updatedAt: 2, leaseExpiresAt: 10,
};
const empty: WorkerStateFileV3 = { version: 3, generation: 2, workers: [], workerGenerations: [] };
const recovery: WorkerStateFileV3 = { version: 3, generation: 1, workers: [worker], workerGenerations: [{ workerId: "builder", generation: 1 }] };
const exactStatus: UnitStatus = {
  verified: true, exists: true, activeState: "active", subState: "running", mainPid: 42,
  workerIdentity: { workerId: "builder", workerIncarnationId: "inc-1", unit, managerSessionId: "manager", managerContext: "pi", owned: true },
};

function assess(status: UnitStatus, snapshot: WorkerStateFileV3 | undefined = recovery) {
  return assessWorkerRegistryRecovery({
    current: empty,
    recovery: snapshot,
    inventory: { verified: true, units: [unit] },
    statuses: new Map([[unit, status]]),
  });
}

test("empty registry with an exact live owned incarnation is recoverable", () => {
  const result = assess(exactStatus);
  assert.equal(result.status, "recoverable");
  if (result.status === "recoverable") assert.equal(result.state.workers[0].workerIncarnationId, "inc-1");
});

test("missing identity evidence and identity mismatches fail closed as degraded", () => {
  assert.equal(assess({ ...exactStatus, workerIdentity: undefined }).status, "degraded");
  assert.equal(assess({ ...exactStatus, workerIdentity: { ...exactStatus.workerIdentity!, workerIncarnationId: "replacement" } }).status, "degraded");
  assert.equal(assess({ ...exactStatus, workerIdentity: { ...exactStatus.workerIdentity!, managerSessionId: "other-manager" } }).status, "degraded");
  assert.equal(assessWorkerRegistryRecovery({
    current: empty,
    inventory: { verified: true, units: [unit] },
    statuses: new Map([[unit, exactStatus]]),
  }).status, "degraded");
});

test("transitional and indeterminate managed units fail closed as degraded", () => {
  const cases: Array<UnitStatus | undefined> = [
    { verified: true, exists: true, activeState: "activating" },
    { verified: true, exists: true, activeState: "inactive", job: "77/start" },
    { verified: true, exists: true, activeState: "active", subState: "running" },
    { verified: false, exists: true },
    undefined,
  ];
  for (const status of cases) {
    const result = assessWorkerRegistryRecovery({
      current: empty,
      recovery,
      inventory: { verified: true, units: [unit] },
      statuses: status ? new Map([[unit, status]]) : new Map(),
    });
    assert.equal(result.status, "degraded");
    if (result.status === "degraded") assert.deepEqual(result.units, [unit]);
  }
});

test("authoritative no-live-unit inventory is healthy and unavailable inventory is distinct", () => {
  const inactive = assessWorkerRegistryRecovery({
    current: empty,
    recovery,
    inventory: { verified: true, units: [unit] },
    statuses: new Map([[unit, { verified: true, exists: true, activeState: "inactive" }]]),
  });
  assert.equal(inactive.status, "healthy");
  assert.equal(assessWorkerRegistryRecovery({ current: empty, recovery, inventory: { verified: false, units: [], reason: "timeout" }, statuses: new Map() }).status, "unavailable");
});

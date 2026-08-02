import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { parseBossCommand } from "../src/boss-command.ts";
import { TRUSTED_LOCAL_BOSS_WARNING, TrustedLocalBossStore } from "../src/boss-trusted-local.ts";
import type { WorkerRecord } from "../src/types.ts";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "boss-trusted-local-"));
  let tick = 0;
  const store = new TrustedLocalBossStore(join(dir, "runs.json"), () => new Date(1_700_000_000_000 + tick++));
  return { dir, store };
}

function managerWorker(bossRunId: string, state: WorkerRecord["state"] = "ready"): WorkerRecord {
  return {
    id: "boss-manager-test",
    runId: "worker-incarnation-test",
    workerIncarnationId: "worker-incarnation-test",
    workerGeneration: 1,
    bossRunId,
    harness: "pi",
    backend: "systemd",
    role: "manager",
    task: "manage the run",
    cwd: "/tmp",
    state,
    owned: true,
    managerSessionId: "manager-session-1",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    leaseExpiresAt: 1_700_000_060_000,
  };
}

test("trusted-local Boss creates and reports an explicitly advisory run", async () => {
  const { dir, store } = await fixture();
  try {
    const created = await store.execute(parseBossCommand("create ship the useful workflow"), "manager-session-1");
    assert.equal(created.run?.state, "active");
    assert.match(created.run?.bossRunId ?? "", /^boss-[0-9a-f-]{36}$/);
    assert.match(created.message, new RegExp(TRUSTED_LOCAL_BOSS_WARNING.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(created.message, /evidence is advisory, not tamper-proof/);

    const status = await store.execute(parseBossCommand("status"), "manager-session-1");
    assert.equal(status.run?.bossRunId, created.run?.bossRunId);
    assert.equal(status.run?.goal, "ship the useful workflow");

    const disk = JSON.parse(await readFile(join(dir, "runs.json"), "utf8"));
    assert.equal(disk.revision, 1);
    assert.equal(disk.currentRunId, created.run?.bossRunId);
    assert.equal(disk.runs[0].assignments[0].role, "manager");
    assert.equal(disk.runs[0].assignments[0].state, "requested");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trusted-local Boss supports pause, resume, proof snapshot, and cancel", async () => {
  const { dir, store } = await fixture();
  try {
    const created = await store.execute(parseBossCommand("create coordinate agents"), "manager-session-2");
    const id = created.run!.bossRunId;
    assert.equal((await store.execute(parseBossCommand(`pause ${id}`), "manager-session-2")).run?.state, "paused");
    assert.equal((await store.execute(parseBossCommand(`resume ${id}`), "manager-session-2")).run?.state, "active");
    const proof = await store.execute(parseBossCommand(`proof ${id}`), "manager-session-2");
    assert.match(proof.message, /adversary must be assigned/i);
    assert.equal(proof.run?.proofPackets.length, 0);
    assert.equal((await store.execute(parseBossCommand(`cancel ${id}`), "manager-session-2")).run?.state, "cancelled");
    const status = await store.execute(parseBossCommand(`status ${id}`), "manager-session-2");
    assert.equal(status.run?.state, "cancelled");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trusted-local Boss permits only one open run and rejects premature approvals", async () => {
  const { dir, store } = await fixture();
  try {
    const created = await store.execute(parseBossCommand("create first goal"), "manager-session-3");
    await assert.rejects(store.execute(parseBossCommand("create second goal"), "manager-session-3"), /already open/);
    await assert.rejects(store.execute(parseBossCommand(`approve ${created.run!.bossRunId} looks good`), "manager-session-3"), /proof packet/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trusted-local Boss records Manager staffing and lifecycle changes from ordinary fleet state", async () => {
  const { dir, store } = await fixture();
  try {
    const created = await store.execute(parseBossCommand("create staff and supervise"), "manager-session-5");
    const worker = managerWorker(created.run!.bossRunId);
    const staffed = await store.recordManagerStarted(created.run!.bossRunId, worker);
    assert.equal(staffed.assignments[0].state, "assigned");
    assert.equal(staffed.assignments[0].workerId, worker.id);
    assert.equal(staffed.lifecycle.at(-1)?.workerState, "ready");

    worker.state = "working";
    assert.equal(await store.synchronizeWorkers([worker]), true);
    assert.equal(await store.synchronizeWorkers([worker]), false, "unchanged fleet state must not duplicate lifecycle observations");
    const status = await store.execute(parseBossCommand(`status ${created.run!.bossRunId}`), "manager-session-5");
    assert.match(status.message, /manager revision 1: assigned; worker=boss-manager-test/);
    assert.match(status.message, /assignment delivery: launch-mandate delivered/);
    assert.match(status.message, /boss-manager-test working/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trusted-local Boss revisions Worker and Scout assignments with ordinary delivery results and controls", async () => {
  const { dir, store } = await fixture();
  try {
    const created = await store.execute(parseBossCommand("create staff the delivery ledger"), "manager-session-staff");
    const worker = { ...managerWorker(created.run!.bossRunId), id: "boss-worker-test", runId: "worker-role-incarnation", workerIncarnationId: "worker-role-incarnation", role: "worker" };
    const scout = { ...managerWorker(created.run!.bossRunId), id: "boss-scout-test", runId: "scout-role-incarnation", workerIncarnationId: "scout-role-incarnation", role: "scout" };
    await store.recordAssignmentStartedForRole(created.run!.bossRunId, "worker", worker);
    const staffed = await store.recordAssignmentStartedForRole(created.run!.bossRunId, "scout", scout);
    assert.equal(staffed.deliveries.length, 2);
    assert.deepEqual(staffed.assignmentResults.map((result) => result.outcome), ["accepted", "accepted"]);
    assert.deepEqual(staffed.assignments.filter((assignment) => assignment.role === "worker" || assignment.role === "scout").map((assignment) => assignment.revision), [1, 1]);

    await store.recordControlDelivery(created.run!.bossRunId, "worker", "pause-notice");
    const controlled = await store.recordControlDelivery(created.run!.bossRunId, "scout", "pause-notice", new Error("local relay unavailable"));
    assert.equal(controlled.assignments.find((assignment) => assignment.role === "worker")?.revision, 2);
    assert.equal(controlled.assignments.find((assignment) => assignment.role === "scout")?.revision, 2);
    assert.equal(controlled.deliveries.at(-1)?.state, "failed");
    assert.equal(controlled.assignmentResults.at(-1)?.outcome, "failed");
    assert.match(controlled.assignmentResults.at(-1)?.detail ?? "", /local relay unavailable/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trusted-local Boss fails the run when Manager launch or lifecycle fails", async () => {
  const first = await fixture();
  try {
    const created = await first.store.execute(parseBossCommand("create fail launch safely"), "manager-session-6");
    const failed = await first.store.recordManagerFailed(created.run!.bossRunId, new Error("no launch profile"));
    assert.equal(failed.state, "failed");
    assert.equal(failed.assignments[0].state, "failed");
    assert.match(failed.assignments[0].lastError ?? "", /no launch profile/);
    const replacement = await first.store.execute(parseBossCommand("create retry after terminal failure"), "manager-session-6");
    assert.equal(replacement.run?.state, "active");
  } finally {
    await rm(first.dir, { recursive: true, force: true });
  }

  const second = await fixture();
  try {
    const created = await second.store.execute(parseBossCommand("create observe failure"), "manager-session-7");
    const worker = managerWorker(created.run!.bossRunId);
    await second.store.recordManagerStarted(created.run!.bossRunId, worker);
    worker.state = "failed";
    worker.lastError = "worker process exited";
    await second.store.synchronizeWorkers([worker]);
    const status = await second.store.execute(parseBossCommand(`status ${created.run!.bossRunId}`), "manager-session-7");
    assert.equal(status.run?.state, "failed");
    assert.equal(status.run?.assignments[0].state, "failed");
    assert.match(status.message, /worker process exited/);
  } finally {
    await rm(second.dir, { recursive: true, force: true });
  }
});

test("trusted-local Boss binds advisory proof revisions to an assigned adversary decision", async () => {
  const { dir, store } = await fixture();
  try {
    const created = await store.execute(parseBossCommand("create prove and review"), "manager-session-8");
    await store.recordManagerStarted(created.run!.bossRunId, managerWorker(created.run!.bossRunId));
    const staffing = await store.execute(parseBossCommand(`proof ${created.run!.bossRunId}`), "manager-session-8");
    const reviewer = staffing.run!.assignments.find((assignment) => assignment.role === "adversary")!;
    assert.equal(reviewer.state, "requested");
    assert.equal(staffing.run!.proofPackets.length, 0);
    await assert.rejects(store.execute(parseBossCommand(`approve ${created.run!.bossRunId} premature`), "manager-session-8"), /proof packet/);

    const reviewerWorker = { ...managerWorker(created.run!.bossRunId), id: "boss-adversary-test", runId: "reviewer-incarnation-test", workerIncarnationId: "reviewer-incarnation-test", role: "challenger" };
    await store.recordReviewerStarted(created.run!.bossRunId, reviewerWorker);
    const proof = await store.execute(parseBossCommand(`proof ${created.run!.bossRunId}`), "manager-session-8");
    assert.equal(proof.run!.proofPackets.at(-1)?.revision, 1);
    assert.match(proof.run!.proofPackets.at(-1)?.snapshotSha256 ?? "", /^[0-9a-f]{64}$/);
    assert.notEqual(proof.run!.deliveries.at(-1)?.kind, "proof-review", "proof creation must not claim delivery before the relay outcome");
    const proofPacketId = proof.run!.proofPackets.at(-1)!.proofPacketId;
    const delivered = await store.recordProofDelivery(created.run!.bossRunId, proofPacketId);
    assert.equal(delivered.deliveries.at(-1)?.kind, "proof-review");
    assert.equal(delivered.deliveries.at(-1)?.proofPacketId, proofPacketId);
    const approved = await store.execute(parseBossCommand(`approve ${created.run!.bossRunId} exact revision reviewed`), "manager-session-8");
    assert.equal(approved.run?.state, "approved");
    assert.equal(approved.run?.decisions[0].proofRevision, 1);
    assert.equal(approved.run?.decisions[0].reviewerWorkerId, "boss-adversary-test");
    assert.match(approved.message, /latest decision: approved on proof revision 1/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

 test("trusted-local Boss fences session races and preserves terminal lifecycle", async () => {
  const { dir, store } = await fixture();
  try {
    const created = await store.execute(parseBossCommand("create fence the owner"), "manager-session-owner");
    await assert.rejects(store.execute(parseBossCommand(`cancel ${created.run!.bossRunId}`), "manager-session-foreign"), /owning Manager session/);
    const cancelled = await store.execute(parseBossCommand(`cancel ${created.run!.bossRunId}`), "manager-session-owner");
    assert.equal(cancelled.run?.state, "cancelled");
    await assert.rejects(store.recordManagerStarted(created.run!.bossRunId, managerWorker(created.run!.bossRunId)), /cannot start after run cancelled/);
    const unchanged = await store.recordManagerFailed(created.run!.bossRunId, new Error("late launch completion"));
    assert.equal(unchanged.state, "cancelled");
    assert.equal(unchanged.assignments[0].state, "cancelled");

    const failedRun = await store.execute(parseBossCommand("create stale proof terminal fence"), "manager-session-owner");
    await store.recordManagerStarted(failedRun.run!.bossRunId, managerWorker(failedRun.run!.bossRunId));
    await store.execute(parseBossCommand(`proof ${failedRun.run!.bossRunId}`), "manager-session-owner");
    const reviewerWorker = { ...managerWorker(failedRun.run!.bossRunId), id: "terminal-reviewer", runId: "terminal-reviewer-incarnation", workerIncarnationId: "terminal-reviewer-incarnation", role: "challenger" };
    await store.recordReviewerStarted(failedRun.run!.bossRunId, reviewerWorker);
    const terminalProof = await store.execute(parseBossCommand(`proof ${failedRun.run!.bossRunId}`), "manager-session-owner");
    await store.recordProofDelivery(failedRun.run!.bossRunId, terminalProof.run!.proofPackets.at(-1)!.proofPacketId);
    await store.recordManagerFailed(failedRun.run!.bossRunId, new Error("manager died after proof"));
    await assert.rejects(store.recordAssignmentStartedForRole(failedRun.run!.bossRunId, "worker", { ...managerWorker(failedRun.run!.bossRunId), id: "late-worker", runId: "late-worker-incarnation", workerIncarnationId: "late-worker-incarnation", role: "worker" }), /cannot start after run failed/);
    await assert.rejects(store.recordAssignmentStartedForRole(failedRun.run!.bossRunId, "scout", { ...managerWorker(failedRun.run!.bossRunId), id: "late-scout", runId: "late-scout-incarnation", workerIncarnationId: "late-scout-incarnation", role: "scout" }), /cannot start after run failed/);
    await assert.rejects(store.recordReviewerStarted(failedRun.run!.bossRunId, { ...managerWorker(failedRun.run!.bossRunId), id: "late-adversary", runId: "late-adversary-incarnation", workerIncarnationId: "late-adversary-incarnation", role: "challenger" }), /cannot start after run failed/);
    await assert.rejects(store.execute(parseBossCommand(`approve ${failedRun.run!.bossRunId} stale proof`), "manager-session-owner"), /Cannot approve Boss run from failed/);
    const terminal = await store.execute(parseBossCommand(`status ${failedRun.run!.bossRunId}`), "manager-session-owner");
    assert.equal(terminal.run?.state, "failed");
    assert.equal(terminal.run?.deliveries.filter((delivery) => delivery.targetWorkerId.startsWith("late-")).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

 test("trusted-local Boss rejects writer/parser bound violations without corrupting state", async () => {
  const { dir, store } = await fixture();
  try {
    await assert.rejects(store.execute({ action: "create", goal: "x".repeat(10_001) }, "manager-session-bounds"), /exceeds 10000/);
    const created = await store.execute(parseBossCommand("create bounded proof ledger"), "manager-session-bounds");
    await store.recordManagerStarted(created.run!.bossRunId, managerWorker(created.run!.bossRunId));
    await store.execute(parseBossCommand(`proof ${created.run!.bossRunId}`), "manager-session-bounds");
    const reviewerWorker = { ...managerWorker(created.run!.bossRunId), id: "bounds-reviewer", runId: "bounds-reviewer-incarnation", workerIncarnationId: "bounds-reviewer-incarnation", role: "challenger" };
    await store.recordReviewerStarted(created.run!.bossRunId, reviewerWorker);
    for (let index = 0; index < 64; index += 1) {
      const proof = await store.execute(parseBossCommand(`proof ${created.run!.bossRunId}`), "manager-session-bounds");
      await store.recordProofDelivery(created.run!.bossRunId, proof.run!.proofPackets.at(-1)!.proofPacketId);
    }
    await assert.rejects(store.execute(parseBossCommand(`proof ${created.run!.bossRunId}`), "manager-session-bounds"), /limit 64 reached/);
    const status = await store.execute(parseBossCommand(`status ${created.run!.bossRunId}`), "manager-session-bounds");
    assert.equal(status.run?.proofPackets.length, 64);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

 test("trusted-local Boss retries transient adversary staffing failure with a new assignment revision", async () => {
  const { dir, store } = await fixture();
  try {
    const created = await store.execute(parseBossCommand("create retry transient reviewer launch"), "manager-session-reviewer-retry");
    await store.recordManagerStarted(created.run!.bossRunId, managerWorker(created.run!.bossRunId));
    await store.execute(parseBossCommand(`proof ${created.run!.bossRunId}`), "manager-session-reviewer-retry");
    const failed = await store.recordReviewerFailed(created.run!.bossRunId, new Error("temporary launch profile outage"));
    assert.equal(failed.assignments.find((assignment) => assignment.role === "adversary")?.state, "failed");
    const retry = await store.execute(parseBossCommand(`proof ${created.run!.bossRunId}`), "manager-session-reviewer-retry");
    const retriedAssignment = retry.run!.assignments.find((assignment) => assignment.role === "adversary")!;
    assert.equal(retriedAssignment.state, "requested");
    assert.equal(retriedAssignment.revision, 2);
    assert.equal(retriedAssignment.lastError, undefined);
    const reviewer = { ...managerWorker(created.run!.bossRunId), id: "retry-reviewer", runId: "retry-reviewer-incarnation", workerIncarnationId: "retry-reviewer-incarnation", role: "challenger" };
    await store.recordReviewerStarted(created.run!.bossRunId, reviewer);
    const proof = await store.execute(parseBossCommand(`proof ${created.run!.bossRunId}`), "manager-session-reviewer-retry");
    await store.recordProofDelivery(created.run!.bossRunId, proof.run!.proofPackets.at(-1)!.proofPacketId);
    assert.equal((await store.execute(parseBossCommand(`approve ${created.run!.bossRunId} retry reviewed`), "manager-session-reviewer-retry")).run?.state, "approved");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trusted-local Boss keeps proof delivery live at ledger capacity and retries the same revision", async () => {
  const { dir, store } = await fixture();
  try {
    const created = await store.execute(parseBossCommand("create fill bounded delivery ledger"), "manager-session-proof-cap");
    await store.recordManagerStarted(created.run!.bossRunId, managerWorker(created.run!.bossRunId));
    await store.execute(parseBossCommand(`proof ${created.run!.bossRunId}`), "manager-session-proof-cap");
    const reviewer = { ...managerWorker(created.run!.bossRunId), id: "cap-reviewer", runId: "cap-reviewer-incarnation", workerIncarnationId: "cap-reviewer-incarnation", role: "challenger" };
    await store.recordReviewerStarted(created.run!.bossRunId, reviewer);
    for (let index = 0; index < 254; index += 1) await store.recordControlDelivery(created.run!.bossRunId, "manager", index % 2 === 0 ? "pause-notice" : "resume-notice");
    const full = await store.execute(parseBossCommand(`status ${created.run!.bossRunId}`), "manager-session-proof-cap");
    assert.equal(full.run?.deliveries.length, 256);
    const proof = await store.execute(parseBossCommand(`proof ${created.run!.bossRunId}`), "manager-session-proof-cap");
    const packet = proof.run!.proofPackets.at(-1)!;
    assert.equal(proof.run?.deliveries.length, 255, "proof creation reserves capacity for its required delivery/result");
    await store.recordProofDelivery(created.run!.bossRunId, packet.proofPacketId, new Error("relay unavailable"));
    const retry = await store.execute(parseBossCommand(`proof ${created.run!.bossRunId}`), "manager-session-proof-cap");
    assert.equal(retry.run?.proofPackets.at(-1)?.proofPacketId, packet.proofPacketId, "failed delivery retries the same exact proof revision");
    const delivered = await store.recordProofDelivery(created.run!.bossRunId, packet.proofPacketId);
    assert.equal(delivered.deliveries.length, 256);
    assert.equal(delivered.deliveries.at(-1)?.state, "delivered");
    assert.equal((await store.execute(parseBossCommand(`approve ${created.run!.bossRunId} cap-safe review`), "manager-session-proof-cap")).run?.state, "approved");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trusted-local Boss keeps late reviewer assignment live at lifecycle capacity", async () => {
  const { dir, store } = await fixture();
  try {
    const created = await store.execute(parseBossCommand("create retain bounded lifecycle liveness"), "manager-session-lifecycle-cap");
    const manager = managerWorker(created.run!.bossRunId);
    await store.recordManagerStarted(created.run!.bossRunId, manager);
    for (let index = 0; index < 255; index += 1) {
      manager.state = index % 2 === 0 ? "working" : "ready";
      assert.equal(await store.synchronizeWorkers([manager]), true);
    }
    const full = await store.execute(parseBossCommand(`status ${created.run!.bossRunId}`), "manager-session-lifecycle-cap");
    assert.equal(full.run?.lifecycle.length, 256);
    await store.execute(parseBossCommand(`proof ${created.run!.bossRunId}`), "manager-session-lifecycle-cap");
    const reviewer = { ...managerWorker(created.run!.bossRunId), id: "lifecycle-cap-reviewer", runId: "lifecycle-cap-reviewer-incarnation", workerIncarnationId: "lifecycle-cap-reviewer-incarnation", role: "challenger" };
    const staffed = await store.recordReviewerStarted(created.run!.bossRunId, reviewer);
    assert.equal(staffed.assignments.find((assignment) => assignment.role === "adversary")?.state, "assigned");
    assert.equal(staffed.lifecycle.length, 256);
    assert.equal(staffed.lifecycle.at(-1)?.workerId, reviewer.id);
    const proof = await store.execute(parseBossCommand(`proof ${created.run!.bossRunId}`), "manager-session-lifecycle-cap");
    await store.recordProofDelivery(created.run!.bossRunId, proof.run!.proofPackets.at(-1)!.proofPacketId);
    assert.equal((await store.execute(parseBossCommand(`approve ${created.run!.bossRunId} lifecycle cap reviewed`), "manager-session-lifecycle-cap")).run?.state, "approved");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trusted-local Boss identifies restart-visible uncorrelated Boss workers", async () => {
  const { dir, store } = await fixture();
  try {
    const missingRunWorker = managerWorker("boss-00000000-0000-4000-8000-000000000000", "working");
    const missingRun = await store.findOrphanedWorkers([missingRunWorker]);
    assert.equal(missingRun.length, 1, "Boss-bound workers remain orphans even after their run record is lost");
    assert.equal(missingRun[0].bossRunId, missingRunWorker.bossRunId);
    assert.equal(missingRun[0].managerSessionId, missingRunWorker.managerSessionId);
    assert.equal(missingRun[0].assignmentRole, null);

    const created = await store.execute(parseBossCommand("create contain restart orphan"), "manager-session-orphan");
    await store.execute(parseBossCommand(`proof ${created.run!.bossRunId}`), "manager-session-orphan");
    const orphan = { ...managerWorker(created.run!.bossRunId, "working"), id: `boss-adversary-${created.run!.bossRunId.slice(-12)}`, runId: "orphan-incarnation", workerIncarnationId: "orphan-incarnation", role: "challenger" };
    const found = await store.findOrphanedWorkers([orphan]);
    assert.equal(found.length, 1);
    assert.equal(found[0].assignmentRole, "adversary");
    assert.equal(found[0].managerSessionId, "manager-session-orphan");
    await store.recordOrphanedWorkerContained(created.run!.bossRunId, found[0].assignmentRole, "restart contained exact orphan");
    const status = await store.execute(parseBossCommand(`status ${created.run!.bossRunId}`), "manager-session-orphan");
    assert.equal(status.run?.assignments.find((assignment) => assignment.role === "adversary")?.state, "failed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trusted-local Boss projects missing workers and recovers pending cancellation", async () => {
  const first = await fixture();
  try {
    const created = await first.store.execute(parseBossCommand("create detect missing manager"), "manager-session-missing");
    await first.store.recordManagerStarted(created.run!.bossRunId, managerWorker(created.run!.bossRunId));
    assert.equal(await first.store.synchronizeWorkers([]), true);
    const failed = await first.store.execute(parseBossCommand(`status ${created.run!.bossRunId}`), "manager-session-missing");
    assert.equal(failed.run?.state, "failed");
    assert.equal(failed.run?.assignments[0].state, "failed");
    assert.equal(failed.run?.lifecycle.at(-1)?.workerState, "lost");
  } finally {
    await rm(first.dir, { recursive: true, force: true });
  }

  const second = await fixture();
  try {
    const created = await second.store.execute(parseBossCommand("create recover cancellation"), "manager-session-cancel-recovery");
    const worker = managerWorker(created.run!.bossRunId, "stopped");
    await second.store.recordManagerStarted(created.run!.bossRunId, { ...worker, state: "ready" });
    await second.store.execute(parseBossCommand(`cancel ${created.run!.bossRunId}`), "manager-session-cancel-recovery");
    assert.equal(await second.store.synchronizeWorkers([worker]), true);
    const recovered = await second.store.execute(parseBossCommand(`status ${created.run!.bossRunId}`), "manager-session-cancel-recovery");
    assert.equal(recovered.run?.cancellation?.state, "succeeded");
    assert.equal(recovered.run?.assignments[0].state, "cancelled");
  } finally {
    await rm(second.dir, { recursive: true, force: true });
  }

  const third = await fixture();
  try {
    const created = await third.store.execute(parseBossCommand("create preserve cancellation identity conflict"), "manager-session-cancel-conflict");
    const exact = managerWorker(created.run!.bossRunId, "ready");
    await third.store.recordManagerStarted(created.run!.bossRunId, exact);
    await third.store.execute(parseBossCommand(`cancel ${created.run!.bossRunId}`), "manager-session-cancel-conflict");
    await third.store.recordCancellationResult(created.run!.bossRunId, new Error("initial stop failed"));
    const conflicting = { ...exact, runId: "conflicting-incarnation", workerIncarnationId: "conflicting-incarnation", state: "working" as const };
    assert.equal((await third.store.findOrphanedWorkers([conflicting])).length, 0, "same-ID assigned-incarnation conflict must not be erased as an orphan");
    await third.store.execute(parseBossCommand(`cancel ${created.run!.bossRunId}`), "manager-session-cancel-conflict");
    await third.store.synchronizeWorkers([conflicting]);
    const pending = await third.store.execute(parseBossCommand(`status ${created.run!.bossRunId}`), "manager-session-cancel-conflict");
    assert.equal(pending.run?.cancellation?.state, "pending");
    assert.equal(pending.run?.assignments[0].state, "assigned");
  } finally {
    await rm(third.dir, { recursive: true, force: true });
  }
});

test("trusted-local Boss records durable Manager cancellation outcomes", async () => {
  const { dir, store } = await fixture();
  try {
    const created = await store.execute(parseBossCommand("create cancel exactly"), "manager-session-9");
    await store.recordManagerStarted(created.run!.bossRunId, managerWorker(created.run!.bossRunId));
    await store.recordAssignmentStartedForRole(created.run!.bossRunId, "worker", { ...managerWorker(created.run!.bossRunId), id: "cancel-worker", runId: "cancel-worker-incarnation", workerIncarnationId: "cancel-worker-incarnation", role: "worker" });
    const requested = await store.execute(parseBossCommand(`cancel ${created.run!.bossRunId}`), "manager-session-9");
    assert.equal(requested.run?.cancellation?.state, "pending");
    assert.equal(requested.run?.assignments[0].state, "assigned", "assignment remains bound until the stop outcome is recorded");
    const completed = await store.recordCancellationResult(created.run!.bossRunId);
    assert.equal(completed.cancellation?.state, "succeeded");
    assert.equal(completed.assignments.find((assignment) => assignment.role === "manager")?.state, "cancelled");
    assert.equal(completed.assignments.find((assignment) => assignment.role === "worker")?.state, "cancelled");

    const second = await store.execute(parseBossCommand("create cancellation failure"), "manager-session-9");
    await store.recordManagerStarted(second.run!.bossRunId, managerWorker(second.run!.bossRunId));
    await store.execute(parseBossCommand(`cancel ${second.run!.bossRunId}`), "manager-session-9");
    const failed = await store.recordCancellationResult(second.run!.bossRunId, new Error("systemd stop refused"));
    assert.equal(failed.cancellation?.state, "failed");
    assert.equal(failed.assignments[0].state, "assigned", "failed stop must not claim the Manager was cancelled");
    assert.match(failed.cancellation?.error ?? "", /systemd stop refused/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trusted-local Boss rejects malformed persisted state", async () => {
  const { dir, store } = await fixture();
  try {
    await store.execute(parseBossCommand("create valid goal"), "manager-session-4");
    const path = join(dir, "runs.json");
    const state = JSON.parse(await readFile(path, "utf8"));
    state.runs[0].unexpected = true;
    await import("node:fs/promises").then(({ writeFile }) => writeFile(path, JSON.stringify(state)));
    await assert.rejects(store.execute(parseBossCommand("status"), "manager-session-4"), /invalid run record/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

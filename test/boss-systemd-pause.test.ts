import assert from "node:assert/strict";
import test from "node:test";
import { applyBossSystemdPausePlan, captureBossPausedTimers, recoverBossSystemdPauseTargets, resolveBossSystemdPausePlan, restoreBossWorkerTimers, setBossUnitFreezerState, suspendBossWorkerTimers, validatePersistedBossSystemdPauseTargets, verifyAcceptedBossSystemdPause, waitForUnitFreezerState } from "../src/boss-systemd-pause.ts";
import type { WorkerStore } from "../src/store.ts";
import { TRUSTED_LOCAL_BOSS_RUN_VERSION, type TrustedLocalBossRun } from "../src/boss-trusted-local.ts";
import type { WorkerRecord } from "../src/types.ts";

const ok = (stdout = "") => ({ stdout, stderr: "", code: 0 });

function run(): TrustedLocalBossRun {
  const assignment = (role: "manager" | "worker" | "scout" | "adversary", state: "assigned" | "requested" = "assigned") => ({
    assignmentId: `assignment-00000000-0000-4000-8000-00000000000${role === "manager" ? 1 : role === "worker" ? 2 : role === "scout" ? 3 : 4}`,
    role,
    task: role,
    revision: 1,
    resourceRevision: 1,
    state,
    workerId: state === "assigned" ? `boss-${role}` : null,
    workerIncarnationId: state === "assigned" ? `incarnation-${role}` : null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  return {
    version: TRUSTED_LOCAL_BOSS_RUN_VERSION,
    bossRunId: "boss-00000000-0000-4000-8000-000000000001",
    handle: "boss-aaaaaaaaaa",
    goal: "pause exactly",
    state: "active",
    managerSessionId: "controller-session",
    resource: null,
    acceptanceRevision: null,
    designRevision: null,
    freezeTransitions: [],
    currentFreeze: null,
    pauseTransitions: [],
    currentPause: null,
    pauseReconciliations: [],
    currentPauseDegradation: null,
    dynamicGrowthGrants: [],
    dynamicAssignments: [],
    assignments: [assignment("manager"), assignment("worker"), assignment("scout"), assignment("adversary", "requested")],
    deliveries: [], assignmentResults: [], lifecycle: [], proofPackets: [], decisions: [], cancellation: null,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function worker(role: "manager" | "worker" | "scout", state: WorkerRecord["state"] = "working"): WorkerRecord {
  return {
    id: `boss-${role}`,
    runId: `incarnation-${role}`,
    workerIncarnationId: `incarnation-${role}`,
    workerGeneration: 1,
    bossRunId: "boss-00000000-0000-4000-8000-000000000001",
    harness: "pi",
    backend: "systemd",
    role,
    task: role,
    cwd: "/tmp",
    state,
    owned: true,
    managerSessionId: "controller-session",
    unit: `agent-intercom-worker-boss-${role}.service`,
    mainPid: role === "manager" ? 100 : role === "worker" ? 200 : 300,
    createdAt: 1,
    updatedAt: 1,
    leaseExpiresAt: 2,
  };
}

function status(freezerState: string, pid = 200): string {
  return `LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=${pid}\nResult=success\nExecMainStatus=0\nJob=\nFreezerState=${freezerState}\n`;
}

test("pause planning validates the exact Boss team but never targets the Manager", () => {
  const plan = resolveBossSystemdPausePlan(run(), [worker("manager"), worker("worker"), worker("scout")]);
  assert.deepEqual(plan.targets.map((target) => target.role), ["worker", "scout"]);
  assert.equal(plan.targets.some((target) => target.workerId === "boss-manager"), false);
  assert.deepEqual(plan.intentionallyUnfrozenManager, {
    workerId: "boss-manager",
    workerIncarnationId: "incarnation-manager",
    unit: "agent-intercom-worker-boss-manager.service",
  });
  assert.deepEqual(plan.terminalRoles, []);

  const terminalPlan = resolveBossSystemdPausePlan(run(), [worker("manager"), worker("worker", "stopped"), worker("scout")]);
  assert.deepEqual(terminalPlan.targets.map((target) => target.role), ["scout"]);
  assert.deepEqual(terminalPlan.terminalRoles, ["worker"]);
});

test("pause planning fails closed for missing, conflicting, unowned, or non-systemd assigned participants", () => {
  const base = [worker("manager"), worker("worker"), worker("scout")];
  assert.throws(() => resolveBossSystemdPausePlan(run(), base.slice(0, 2)), /scout exact WorkerStore incarnation is unavailable/);
  assert.throws(() => resolveBossSystemdPausePlan(run(), base.map((entry) => entry.role === "worker" ? { ...entry, bossRunId: "boss-other" } : entry)), /not the exact owned run participant/);
  assert.throws(() => resolveBossSystemdPausePlan(run(), base.map((entry) => entry.role === "worker" ? { ...entry, owned: false } : entry)), /not the exact owned run participant/);
  assert.throws(() => resolveBossSystemdPausePlan(run(), base.map((entry) => entry.role === "worker" ? { ...entry, unit: undefined } : entry)), /not attached to a controllable systemd unit/);
});

test("restart reconciliation rejects changed WorkerStore incarnation, ownership, liveness, unit, and PID", () => {
  const bossRun = run();
  const participant = worker("worker");
  const target = { role: "worker" as const, workerId: participant.id, workerIncarnationId: participant.workerIncarnationId!, unit: participant.unit!, expectedMainPid: participant.mainPid };
  assert.doesNotThrow(() => validatePersistedBossSystemdPauseTargets(bossRun, [participant], [target]));
  assert.throws(() => validatePersistedBossSystemdPauseTargets(bossRun, [{ ...participant, workerIncarnationId: "replacement", runId: "replacement" }], [target]), /incarnation changed/);
  assert.throws(() => validatePersistedBossSystemdPauseTargets(bossRun, [{ ...participant, owned: false }], [target]), /owned live systemd identity changed/);
  assert.throws(() => validatePersistedBossSystemdPauseTargets(bossRun, [{ ...participant, state: "stopped" }], [target]), /owned live systemd identity changed/);
  assert.throws(() => validatePersistedBossSystemdPauseTargets(bossRun, [{ ...participant, unit: "replacement.service" }], [target]), /owned live systemd identity changed/);
  assert.throws(() => validatePersistedBossSystemdPauseTargets(bossRun, [{ ...participant, mainPid: 201 }], [target]), /main PID changed/);
});

test("accepted pause verification requires every exact live target to remain frozen", async () => {
  const bossRun = run();
  const participant = worker("worker");
  bossRun.state = "paused";
  bossRun.currentPause = {
    version: "orc.boss-pause.v1",
    pauseRevision: 1,
    transitionRevision: 1,
    targets: [{ role: "worker", workerId: participant.id, workerIncarnationId: participant.workerIncarnationId!, unit: participant.unit!, mainPid: participant.mainPid! }],
    intentionallyUnfrozenManagerWorkerId: "boss-manager",
    timers: [],
    authorizedBySessionId: "controller-session",
    pausedAt: "2026-01-01T00:00:00.000Z",
  };
  await assert.doesNotReject(verifyAcceptedBossSystemdPause({ async exec() { return ok(status("frozen")); } }, bossRun, [participant]));
  await assert.rejects(verifyAcceptedBossSystemdPause({ async exec() { return ok(status("running")); } }, bossRun, [participant]), /accepted pause drifted.*running/);
  await assert.rejects(verifyAcceptedBossSystemdPause({ async exec() { return ok(status("frozen", 201)); } }, bossRun, [participant]), /main PID changed/);
  await assert.rejects(verifyAcceptedBossSystemdPause({ async exec() { return ok(status("frozen")); } }, bossRun, [{ ...participant, state: "stopped" }]), /owned live systemd identity changed/);
});

test("restart recovery thaws every surviving exact target without reversing prior recovery", async () => {
  const states = new Map([["worker.service", "frozen"], ["scout.service", "frozen"]]);
  const actions: string[] = [];
  const failures = await recoverBossSystemdPauseTargets({ async exec(command, args) {
    const unit = args.includes("show") ? args[2] : args.at(-1)!;
    if (args.includes("show")) return ok(status(states.get(unit)!, unit === "worker.service" ? 200 : 300));
    actions.push(`${args[1]}:${unit}`);
    if (unit === "worker.service") return { stdout: "", stderr: "gone", code: 1 };
    states.set(unit, "running");
    return ok();
  } }, [
    { role: "worker", workerId: "boss-worker", workerIncarnationId: "incarnation-worker", unit: "worker.service", expectedMainPid: 200 },
    { role: "scout", workerId: "boss-scout", workerIncarnationId: "incarnation-scout", unit: "scout.service", expectedMainPid: 300 },
  ], "running", { timeoutMs: 50, intervalMs: 1 });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /worker\.service.*gone/);
  assert.deepEqual(actions, ["thaw:worker.service", "thaw:scout.service"]);
  assert.equal(states.get("scout.service"), "running");
});

test("systemd freeze and thaw require exact settled live identity and verify FreezerState", async () => {
  const freezeCalls: string[][] = [];
  let freezeShows = 0;
  const frozen = await setBossUnitFreezerState({ async exec(command, args) {
    freezeCalls.push([command, ...args]);
    if (command === "systemctl" && args.includes("show")) {
      freezeShows += 1;
      return ok(status(freezeShows === 1 ? "running" : "frozen"));
    }
    return ok();
  } }, { unit: "worker.service", expectedMainPid: 200 }, "frozen", { timeoutMs: 50, intervalMs: 1 });
  assert.equal(frozen.freezerState, "frozen");
  assert.ok(freezeCalls.some((call) => call.join(" ") === "systemctl --user freeze worker.service"));

  let thawShows = 0;
  const thawed = await setBossUnitFreezerState({ async exec(command, args) {
    if (command === "systemctl" && args.includes("show")) {
      thawShows += 1;
      return ok(status(thawShows === 1 ? "frozen" : "running"));
    }
    return ok();
  } }, { unit: "worker.service", expectedMainPid: 200 }, "running", { timeoutMs: 50, intervalMs: 1 });
  assert.equal(thawed.freezerState, "running");
});

test("multi-unit pause compensates already frozen units in reverse when a later target fails", async () => {
  const states = new Map([["worker.service", "running"], ["scout.service", "running"]]);
  const actions: string[] = [];
  await assert.rejects(applyBossSystemdPausePlan({ async exec(command, args) {
    const unit = args.includes("show") ? args[2] : args.at(-1)!;
    if (args.includes("show")) return ok(status(states.get(unit)!, unit === "worker.service" ? 200 : 300));
    const action = args[1]; actions.push(`${action}:${unit}`);
    if (action === "freeze" && unit === "scout.service") return { stdout: "", stderr: "denied", code: 1 };
    states.set(unit, action === "freeze" ? "frozen" : "running");
    return ok();
  } }, [
    { role: "worker", workerId: "boss-worker", workerIncarnationId: "incarnation-worker", unit: "worker.service", expectedMainPid: 200 },
    { role: "scout", workerId: "boss-scout", workerIncarnationId: "incarnation-scout", unit: "scout.service", expectedMainPid: 300 },
  ], "frozen", { timeoutMs: 50, intervalMs: 1 }), /prior unit changes were compensated/);
  assert.deepEqual(actions, ["freeze:worker.service", "freeze:scout.service", "thaw:worker.service"]);
  assert.equal(states.get("worker.service"), "running");
});

test("pause timer capture preserves exact remaining lifecycle budgets", () => {
  const now = 1_000;
  const participant = { ...worker("worker"), leaseExpiresAt: 11_000, idleDeadlineAt: 21_000, checkpointDeadlineAt: 31_000, checkpointLastAttemptAt: 500 };
  const timers = captureBossPausedTimers({ version: 3, activeFeatures: ["authenticated-intercom-activity-v1"], generation: 1, workers: [participant], workerGenerations: [], runtimeCleanupClaims: [] }, [{ role: "worker", workerId: participant.id, workerIncarnationId: participant.workerIncarnationId!, unit: participant.unit!, expectedMainPid: participant.mainPid }], now, 5_000);
  assert.deepEqual(timers, [{ workerId: participant.id, workerIncarnationId: participant.workerIncarnationId, leaseRemainingMs: 10_000, idleRemainingMs: 20_000, checkpointRemainingMs: 30_000, checkpointRetryRemainingMs: 4_500, checkpointRetryIntervalMs: 5_000 }]);
});

test("WorkerStore lifecycle timers are fenced during pause and restored from exact remaining budgets", async () => {
  const participant = { ...worker("worker"), leaseExpiresAt: 11_000, idleDeadlineAt: 21_000, checkpointDeadlineAt: 31_000, checkpointLastAttemptAt: 500 };
  const state = { version: 3 as const, activeFeatures: ["authenticated-intercom-activity-v1"], generation: 1, workers: [participant], workerGenerations: [], runtimeCleanupClaims: [] };
  const fakeStore = { async mutate(fn: (value: typeof state) => unknown) { return fn(state); } } as unknown as WorkerStore;
  const timers = captureBossPausedTimers(state, [{ role: "worker", workerId: participant.id, workerIncarnationId: participant.workerIncarnationId!, unit: participant.unit!, expectedMainPid: participant.mainPid }], 1_000, 5_000);
  await suspendBossWorkerTimers(fakeStore, timers, 1_000, { expectedCurrentAt: 1_000 });
  assert.ok(participant.leaseExpiresAt > 8_000_000_000_000_000);
  assert.equal(participant.idleDeadlineAt, participant.leaseExpiresAt);
  assert.equal(participant.checkpointDeadlineAt, participant.leaseExpiresAt);
  assert.equal(participant.checkpointLastAttemptAt, participant.leaseExpiresAt);
  await restoreBossWorkerTimers(fakeStore, timers, 101_000);
  assert.equal(participant.leaseExpiresAt, 111_000);
  assert.equal(participant.idleDeadlineAt, 121_000);
  assert.equal(participant.checkpointDeadlineAt, 131_000);
  assert.equal(participant.checkpointLastAttemptAt, 100_500);
  await restoreBossWorkerTimers(fakeStore, timers, 201_000);
  assert.equal(participant.leaseExpiresAt, 111_000, "restart retry after timer restoration must not extend the lease budget");
  assert.equal(participant.idleDeadlineAt, 121_000);
  assert.equal(participant.checkpointDeadlineAt, 131_000);
  assert.equal(participant.checkpointLastAttemptAt, 100_500);
});

test("initial timer fencing rejects heartbeat or cleanup lifecycle movement after capture", async () => {
  const participant = { ...worker("worker"), leaseExpiresAt: 11_000, idleDeadlineAt: 21_000, checkpointDeadlineAt: 31_000, checkpointLastAttemptAt: 500 };
  const state = { version: 3 as const, activeFeatures: ["authenticated-intercom-activity-v1"], generation: 1, workers: [participant], workerGenerations: [], runtimeCleanupClaims: [] };
  const fakeStore = { async mutate(fn: (value: typeof state) => unknown) { return fn(state); } } as unknown as WorkerStore;
  const timers = captureBossPausedTimers(state, [{ role: "worker", workerId: participant.id, workerIncarnationId: participant.workerIncarnationId!, unit: participant.unit!, expectedMainPid: participant.mainPid }], 1_000, 5_000);

  participant.leaseExpiresAt += 1;
  await assert.rejects(suspendBossWorkerTimers(fakeStore, timers, 1_001, { expectedCurrentAt: 1_000 }), /lease lifecycle changed before timer fencing/);
  participant.leaseExpiresAt = 11_000;
  participant.state = "blocked";
  participant.stateReason = "stop_in_progress";
  await assert.rejects(suspendBossWorkerTimers(fakeStore, timers, 1_001, { expectedCurrentAt: 1_000 }), /lifecycle changed before timer fencing/);
});

test("systemd pause control rejects PID movement, queued units, unsupported state, command timeout, and ambiguous verification", async () => {
  await assert.rejects(setBossUnitFreezerState({ async exec() { return ok(status("running", 201)); } }, { unit: "worker.service", expectedMainPid: 200 }, "frozen"), /main PID changed/);
  await assert.rejects(setBossUnitFreezerState({ async exec() { return ok(status("running").replace("Job=", "Job=12/start")); } }, { unit: "worker.service", expectedMainPid: 200 }, "frozen"), /not an exact settled live unit/);
  await assert.rejects(setBossUnitFreezerState({ async exec() { return ok(status("")); } }, { unit: "worker.service", expectedMainPid: 200 }, "frozen"), /cannot transition from FreezerState=unknown/);

  let timeoutShows = 0;
  await assert.rejects(setBossUnitFreezerState({ async exec(command, args) {
    if (command === "systemctl" && args.includes("show")) { timeoutShows += 1; return ok(status("running")); }
    return { stdout: "", stderr: "", code: 143, killed: true };
  } }, { unit: "worker.service", expectedMainPid: 200 }, "frozen"), /systemctl timed out/);

  await assert.rejects(waitForUnitFreezerState({ async exec() { return ok(status("mystery")); } }, "worker.service", "frozen", { timeoutMs: 20, intervalMs: 1, expectedMainPid: 200 }), /unavailable or unsupported FreezerState=mystery/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { getUnitStatus, getUserManagerHealth, getWorkerUnitMutationGeneration, launchUnit, parseSystemctlListJobs, stopUnit, waitForUnitRunning, workerSubmissionRejection } from "../src/systemd.ts";
import { stateFromUnit, unitRequiresStopFence } from "../src/workers.ts";

const ok = (stdout = "") => ({ stdout, stderr: "", code: 0 });

test("list-jobs parsing is strict and preserves structured records", () => {
  assert.deepEqual(parseSystemctlListJobs("17 worker-a.service start running\n18 worker-b.service stop waiting\n"), [
    { id: 17, unit: "worker-a.service", type: "start", state: "running", raw: "17 worker-a.service start running" },
    { id: 18, unit: "worker-b.service", type: "stop", state: "waiting", raw: "18 worker-b.service stop waiting" },
  ]);
  assert.throws(() => parseSystemctlListJobs("17 worker-a.service start\n"), /malformed/);
  assert.throws(() => parseSystemctlListJobs("17 worker-a.service start queued\n"), /malformed/);
  assert.throws(() => parseSystemctlListJobs("17 worker-a.service start running\n17 worker-b.service stop waiting\n"), /duplicate/);
});

test("user-manager health distinguishes diagnostics, cap, malformed output, and timeout", async () => {
  let reads = 0;
  const healthy = await getUserManagerHealth({ async exec() {
    reads += 1;
    return reads === 1
      ? ok("17 worker-a.service start running\n18 worker-b.service stop waiting\n")
      : ok("");
  } }, { settleMs: 1 });
  assert.deepEqual(healthy, { responsive: true, parsed: true, settled: true, jobCount: 0, jobs: [], jobRecords: [], overJobCap: false });

  const stuck = await getUserManagerHealth({ async exec() {
    return ok("17 worker-a.service start waiting\n18 worker-b.service stop waiting\n");
  } }, { settleMs: 1 });
  assert.equal(stuck.responsive, true);
  assert.equal(stuck.parsed, true);
  assert.equal(stuck.settled, false);
  assert.equal(stuck.overJobCap, false);
  assert.equal(stuck.persistentJobs?.length, 2);

  const capped = await getUserManagerHealth({ async exec() {
    return ok(Array.from({ length: 33 }, (_, index) => `${index + 1} worker-${index}.service start waiting`).join("\n"));
  } }, { settleMs: 1 });
  assert.equal(capped.responsive, true);
  assert.equal(capped.overJobCap, true);
  assert.equal(capped.jobCount, 33);

  const malformed = await getUserManagerHealth({ async exec() { return ok("not a valid job row"); } });
  assert.equal(malformed.responsive, true);
  assert.equal(malformed.parsed, false);
  assert.match(malformed.error ?? "", /could not parse/);

  const failed = await getUserManagerHealth({ async exec() {
    return { stdout: "", stderr: "manager unavailable", code: 1 };
  } });
  assert.equal(failed.responsive, false);
  assert.match(failed.error ?? "", /manager unavailable/);

  const stalled = await getUserManagerHealth({ async exec() {
    return { stdout: "", stderr: "", code: 143, killed: true };
  } });
  assert.equal(stalled.responsive, false);
  assert.match(stalled.error ?? "", /timed out/);
});

test("worker admission allows unrelated persistent jobs below cap and fails closed otherwise", () => {
  assert.equal(workerSubmissionRejection({
    responsive: true,
    parsed: true,
    settled: false,
    jobCount: 32,
    overJobCap: false,
    persistentJobs: ["17 unrelated.service start running"],
  }), undefined);
  assert.match(workerSubmissionRejection({ responsive: true, parsed: true, jobCount: 33, overJobCap: true }) ?? "", /33 queued jobs/);
  assert.match(workerSubmissionRejection({ responsive: true, parsed: false, error: "malformed" }) ?? "", /ambiguous.*malformed/);
  assert.match(workerSubmissionRejection({ responsive: false, error: "timed out" }) ?? "", /not responsive.*timed out/);
});

test("launch is nonblocking and a killed submission is indeterminate", async () => {
  const calls: string[][] = [];
  const beforeLaunch = getWorkerUnitMutationGeneration();
  await launchUnit({ async exec(_command, args) { calls.push(args); return ok(); } }, {
    unit: "worker.service",
    profile: { harness: "pi", command: "/usr/bin/true", mode: "persistent", env: { AGENT_INTERCOM_MANAGER_CONTEXT: "profile-spoof", AGENT_INTERCOM_RUN_ID: "profile-spoof" } },
    environment: { AGENT_INTERCOM_MANAGER_CONTEXT: "pi", AGENT_INTERCOM_RUN_ID: "owned-incarnation" },
    args: [], cwd: "/tmp", maxRuntime: "2h", stopTimeoutSeconds: 5,
  });
  assert.ok(calls[0].includes("--no-block"));
  assert.ok(calls[0].includes("--setenv=AGENT_INTERCOM_MANAGER_CONTEXT=pi"));
  assert.ok(calls[0].includes("--setenv=AGENT_INTERCOM_RUN_ID=owned-incarnation"));
  assert.equal(calls[0].some((arg) => arg.includes("profile-spoof")), false);
  assert.ok(getWorkerUnitMutationGeneration() > beforeLaunch);

  await assert.rejects(launchUnit({ async exec() { return { stdout: "", stderr: "", code: 143, killed: true }; } }, {
    unit: "worker.service",
    profile: { harness: "pi", command: "/usr/bin/true", mode: "persistent" },
    args: [], cwd: "/tmp", maxRuntime: "2h", stopTimeoutSeconds: 5,
  }), /determine whether .* submitted/);
});

test("stop attempts invalidate cleanup unit inventories", async () => {
  const beforeStop = getWorkerUnitMutationGeneration();
  await stopUnit({ async exec(command, args) {
    if (command === "systemctl" && args.includes("show")) {
      return ok("LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\nJob=\n");
    }
    if (command === "systemd-cgls") return { stdout: "", stderr: "Unit not found", code: 1 };
    return ok();
  } }, "worker.service", { timeoutMs: 50, intervalMs: 1, stableMs: 0 });
  assert.ok(getWorkerUnitMutationGeneration() > beforeStop);
});

test("queued jobs and activation evidence survive status parsing", async () => {
  const queued = await getUnitStatus({ async exec() { return ok(
    "LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\nResult=success\nExecMainStatus=0\nJob=77/start\nActiveEnterTimestampMonotonic=0\nInactiveEnterTimestampMonotonic=12\nExecMainStartTimestampMonotonic=0\n",
  ); } }, "queued.service");
  assert.equal(queued.verified, true);
  assert.equal(queued.job, "77/start");
  assert.equal(queued.inactiveEnterTimestampMonotonic, 12);
  assert.equal(stateFromUnit(queued, "registering"), "provisioning");

  const timedOut = await getUnitStatus({ async exec() { return { stdout: "", stderr: "", code: 143, killed: true }; } }, "unknown.service");
  assert.equal(timedOut.verified, false);
  assert.equal(stateFromUnit(timedOut, "registering"), "registering");

  const identityUnit = "agent-intercom-worker-builder-inc.service";
  const identified = await getUnitStatus({ async exec() { return ok(
    `LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=42\nJob=\nEnvironment=AGENT_INTERCOM_OWNED=1 AGENT_INTERCOM_WORKER_ID=builder AGENT_INTERCOM_RUN_ID=inc AGENT_INTERCOM_SYSTEMD_UNIT=${identityUnit} AGENT_INTERCOM_MANAGER_SESSION_ID=manager AGENT_INTERCOM_MANAGER_CONTEXT=pi\n`,
  ); } }, identityUnit);
  assert.deepEqual(identified.workerIdentity, {
    workerId: "builder", workerIncarnationId: "inc", unit: identityUnit,
    managerSessionId: "manager", managerContext: "pi", owned: true,
  });

  const reassigned = await getUnitStatus({ async exec() { return ok(
    `LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=42\nJob=\nEnvironment=AGENT_INTERCOM_OWNED=0 AGENT_INTERCOM_WORKER_ID=stale AGENT_INTERCOM_RUN_ID=old AGENT_INTERCOM_OWNED=1 AGENT_INTERCOM_WORKER_ID=builder AGENT_INTERCOM_RUN_ID=inc AGENT_INTERCOM_SYSTEMD_UNIT=${identityUnit} AGENT_INTERCOM_MANAGER_SESSION_ID=manager AGENT_INTERCOM_MANAGER_CONTEXT=pi\n`,
  ); } }, identityUnit);
  assert.deepEqual(reassigned.workerIdentity, identified.workerIdentity, "systemd environment assignment semantics are last-assignment-wins");
});

test("running verification waits through a queue and rejects an early crash", async () => {
  let reads = 0;
  const status = await waitForUnitRunning({ async exec() {
    reads += 1;
    return reads === 1
      ? ok("LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\nJob=88/start\n")
      : ok("LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=4242\nJob=\nExecMainStartTimestampMonotonic=10\n");
  } }, "worker.service", { timeoutMs: 100, intervalMs: 1, stableMs: 0 });
  assert.equal(status.mainPid, 4242);

  await assert.rejects(waitForUnitRunning({ async exec() {
    return ok("LoadState=loaded\nActiveState=failed\nSubState=failed\nMainPID=0\nResult=exit-code\nExecMainStatus=1\nJob=\n");
  } }, "failed.service", { timeoutMs: 50, intervalMs: 1 }), /failed before readiness/);
});

test("never-started inactive units are failures, while proven clean exits are stopped", () => {
  assert.equal(stateFromUnit({ exists: true, activeState: "inactive", execMainStatus: 0 }, "registering"), "failed");
  assert.equal(stateFromUnit({ exists: true, activeState: "inactive", execMainStatus: 0, execMainStartTimestampMonotonic: 10 }, "registering"), "stopped");
});

test("durable stop intent fences queued and late-active units without reviving terminal records", () => {
  const worker: any = {
    id: "worker-a", runId: "run-a", harness: "pi", backend: "systemd", role: "advisor", task: "review", cwd: "/tmp",
    state: "stopped", owned: true, managerSessionId: "manager", createdAt: 1, updatedAt: 2, leaseExpiresAt: 3,
    stopRequestedAt: 2, stopReason: "manager-requested", unit: "worker-a.service",
  };
  assert.equal(unitRequiresStopFence(worker, { exists: true, activeState: "inactive", job: "91/start" }), true);
  assert.equal(unitRequiresStopFence(worker, { exists: true, activeState: "active", subState: "running", mainPid: 4242 }), true);
  assert.equal(unitRequiresStopFence(worker, { exists: false, activeState: "inactive" }), false);
  assert.equal(unitRequiresStopFence({ ...worker, state: "registering", stopRequestedAt: undefined, stopReason: undefined }, { exists: true, activeState: "active", mainPid: 4242 }), false);
  assert.equal(unitRequiresStopFence(worker, { verified: false, exists: false, error: "timeout" }), false, "indeterminate status cannot authorize a stop conclusion");
});

test("stop re-verifies after a timed-out request and waits for the queued job to clear", async () => {
  let shows = 0;
  const calls: Array<{ command: string; args: string[] }> = [];
  await stopUnit({ async exec(command, args) {
    calls.push({ command, args });
    if (command === "systemctl" && args.includes("stop")) return { stdout: "", stderr: "", code: 143, killed: true };
    if (command === "systemctl" && args.includes("show")) {
      shows += 1;
      return shows === 1
        ? ok("LoadState=loaded\nActiveState=inactive\nSubState=dead\nJob=90/stop\n")
        : ok("LoadState=not-found\nActiveState=inactive\nSubState=dead\nJob=\n");
    }
    if (command === "systemd-cgls") return { stdout: "", stderr: "unit not found", code: 1 };
    return ok();
  } }, "worker.service", { timeoutMs: 100, intervalMs: 1, stableMs: 0 });
  assert.equal(shows, 2);
  assert.ok(calls.some(({ command, args }) => command === "systemctl" && args.includes("stop") && args.includes("--no-block")));
});

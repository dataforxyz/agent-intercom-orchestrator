import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, mergeConfig, readConfig, resolveProfileCommand, writeConfig, writeConfigDefaults } from "../src/config.ts";
import { parseOpenCodeModelsVerbose, parsePiModels, recordIntercomWorkerActivity, removeWorkerRuntimeAndRecord, renewObservedWorkerLeases, reserveWorkerRecord, workersAttachedToManager } from "../src/index.ts";
import { workerRuntimeRoot } from "../src/runtime.ts";
import { WorkerStore } from "../src/store.ts";
import { getUnitStatus, launchUnit, makeUnitName, parseDurationToSeconds, readUnitProcessTree, sanitizeUnitPart, stopUnit, waitForUnitRunning } from "../src/systemd.ts";
import type { WorkerRecord, WorkerRecordV3 } from "../src/types.ts";
import {
  boundedLeaseExpiry,
  buildWorkerArgs,
  buildWorkerEnvironment,
  cleanupReason,
  cleanupSnapshotStillEligible,
  createSystemdRecord,
  initializeWorkerLifecycle,
  leaseExpiry,
  normalizeModelForHarness,
  rebindManagerOwner,
  recordWorkerActivity,
  workerIdleDeadline,
  stateFromUnit,
  stoppedWorkerRetentionReason,
  isRecentTerminalWorker,
  validateEffort,
  validateWorkerId,
} from "../src/workers.ts";

test("terminal worker visibility and retention distinguish clean and dirty records", () => {
  const now = Date.UTC(2026, 6, 27);
  const base: WorkerRecord = {
    id: "retained", runId: "run-retained", harness: "codex", backend: "systemd", role: "builder", task: "test", cwd: "/tmp",
    state: "stopped", owned: true, managerSessionId: "manager", createdAt: now, updatedAt: now, stoppedAt: now,
    leaseExpiresAt: now,
  };
  assert.equal(isRecentTerminalWorker(base, DEFAULT_CONFIG, now + 5 * 60 * 60_000), true);
  assert.equal(isRecentTerminalWorker(base, DEFAULT_CONFIG, now + 7 * 60 * 60_000), false);
  assert.equal(stoppedWorkerRetentionReason(base, DEFAULT_CONFIG, now + 6 * 24 * 60 * 60_000), undefined);
  assert.match(stoppedWorkerRetentionReason(base, DEFAULT_CONFIG, now + 8 * 24 * 60 * 60_000) ?? "", /stopped worker retention expired/);
  const dirty = { ...base, dirtyAtStop: true };
  assert.equal(stoppedWorkerRetentionReason(dirty, DEFAULT_CONFIG, now + 8 * 24 * 60 * 60_000), undefined);
  assert.match(stoppedWorkerRetentionReason(dirty, DEFAULT_CONFIG, now + 31 * 24 * 60 * 60_000) ?? "", /dirty stopped worker retention expired/);
});

test("unit names are bounded and sanitized", () => {
  assert.equal(sanitizeUnitPart("Codex Build/API !!"), "codex-build-api");
  const unit = makeUnitName("Codex Build/API !!", "ABC_123");
  assert.equal(unit, "agent-intercom-worker-codex-build-api-abc_123.service");
  assert.ok(unit.length < 200);
});

test("worker ids reject shell-like input", () => {
  assert.equal(validateWorkerId("codex-build-api"), "codex-build-api");
  assert.throws(() => validateWorkerId("x; rm -rf /"));
  assert.throws(() => validateWorkerId("x"));
});

test("harness launch args include identity or the initial task", () => {
  const pi = DEFAULT_CONFIG.profiles["pi-peer"];
  const codex = DEFAULT_CONFIG.profiles["codex-safe"];
  const claude = DEFAULT_CONFIG.profiles["claude-safe"];
  const minimalClaude = DEFAULT_CONFIG.profiles["claude-minimal"];
  const trustedClaude = DEFAULT_CONFIG.profiles["claude-trusted"];
  const opencode = DEFAULT_CONFIG.profiles["opencode-run"];
  assert.ok(pi && codex && claude && minimalClaude && trustedClaude && opencode);
  const managerTarget = "manager-a";
  const piArgs = buildWorkerArgs({ harness: "pi", profile: pi, workerId: "advisor-a", cwd: "/repo", role: "advisor", task: "Review", model: "codex/gpt-5.6-sol", effort: "high", managerTarget, permissionProfile: DEFAULT_CONFIG.permissionProfiles["review-readonly"] });
  const codexArgs = buildWorkerArgs({ harness: "codex", profile: codex, workerId: "worker-a", cwd: "/repo", role: "builder", task: "Build", model: "gpt-5.6-sol", effort: "high", managerTarget });
  const claudeArgs = buildWorkerArgs({ harness: "claude", profile: claude, profileName: "claude-safe", workerId: "worker-b", cwd: "/repo", role: "challenger", task: "Challenge", model: "opus", effort: "max", managerTarget });
  const minimalClaudeArgs = buildWorkerArgs({ harness: "claude", profile: minimalClaude, profileName: "claude-minimal", workerId: "worker-minimal", cwd: "/repo", role: "reviewer", task: "Review minimally", model: "opus", effort: "high", managerTarget });
  const trustedClaudeArgs = buildWorkerArgs({ harness: "claude", profile: trustedClaude, profileName: "claude-trusted", workerId: "worker-trusted", cwd: "/repo", role: "builder", task: "Build without prompts", model: "opus", effort: "max", managerTarget });
  const opencodeArgs = buildWorkerArgs({ harness: "opencode", profile: opencode, workerId: "worker-c", cwd: "/repo", role: "tester", task: "Return OPEN_OK", model: "opencode/claude-sonnet-5", effort: "high", managerTarget });
  assert.deepEqual(codexArgs.slice(codexArgs.indexOf("--name"), codexArgs.indexOf("--name") + 4), [
    "--name",
    "worker-a",
    "--id",
    "worker-a",
  ]);
  assert.ok(piArgs.includes("--name"));
  assert.ok(piArgs.includes("--thinking"));
  assert.ok(piArgs.includes("codex/gpt-5.6-sol"));
  assert.ok(piArgs.includes("--tools"));
  assert.equal(piArgs[piArgs.indexOf("--tools") + 1].includes("bash"), false);
  assert.ok(codexArgs.includes("--instructions"));
  assert.ok(codexArgs.includes("model=\"gpt-5.6-sol\""));
  assert.ok(codexArgs.includes("model_reasoning_effort=\"high\""));
  assert.ok(claudeArgs.includes("--safe"));
  assert.ok(claudeArgs.includes("--effort"));
  assert.ok(claudeArgs.includes("worker-b"));
  assert.match(minimalClaudeArgs.join(" "), /final response to each wake/);
  assert.doesNotMatch(minimalClaudeArgs.join(" "), /Use intercom_send for progress/);
  assert.equal(trustedClaudeArgs.includes("--safe"), false);
  assert.ok(trustedClaudeArgs.includes("worker-trusted"));
  assert.equal(opencodeArgs[0], "run");
  assert.ok(opencodeArgs.includes("--variant"));
  assert.match(opencodeArgs.at(-1) ?? "", /Return OPEN_OK/);
  for (const args of [piArgs, codexArgs, claudeArgs, minimalClaudeArgs, trustedClaudeArgs, opencodeArgs]) {
    assert.match(args.join(" "), /manager-a/);
    assert.match(args.join(" "), /intercom_team/);
  }
  for (const args of [piArgs, codexArgs, claudeArgs, trustedClaudeArgs, opencodeArgs]) {
    assert.match(args.join(" "), /intercom_send for progress/);
  }
  for (const args of [piArgs, codexArgs, claudeArgs, minimalClaudeArgs, trustedClaudeArgs, opencodeArgs]) {
    assert.match(args.join(" "), /verify that this worker actually has a browser or browser tool/);
    assert.match(args.join(" "), /never present code inspection as visual evidence/);
  }
  assert.equal(buildWorkerEnvironment("pi", "advisor-a", "advisor").AGENT_INTERCOM_ORCHESTRATOR_DISABLED, "1");
  assert.equal(buildWorkerEnvironment("codex", "builder-a", "builder", "gpt-5.6-sol").CODEX_INTERCOM_MODEL, "gpt-5.6-sol");
  const ownedEnv = buildWorkerEnvironment("pi", "advisor-a", "advisor", undefined, {
    runId: "run-a", unit: "worker-a.service", managerSessionId: "manager-a", fresh: true,
  });
  assert.equal(ownedEnv.AGENT_INTERCOM_WORKER_ID, "advisor-a");
  assert.equal(ownedEnv.AGENT_INTERCOM_SYSTEMD_UNIT, "worker-a.service");
  assert.equal(ownedEnv.AGENT_INTERCOM_MANAGER_SESSION_ID, "manager-a");
  assert.equal(ownedEnv.AGENT_INTERCOM_MANAGER_TARGET, "manager-a");
  assert.equal(ownedEnv.AGENT_INTERCOM_FRESH, "1");
});

test("systemd durations are validated before configuration is saved", () => {
  assert.equal(parseDurationToSeconds("2h 30min"), 9000);
  assert.throws(() => parseDurationToSeconds("tomorrow"), /Invalid systemd duration/);
});

test("systemd launch retains one-shot exit status without --collect", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner = {
    async exec(command: string, args: string[]) {
      calls.push({ command, args });
      return { stdout: "", stderr: "", code: 0 };
    },
  };
  await launchUnit(runner, {
    unit: "agent-intercom-worker-test.service",
    profile: { harness: "opencode", command: "/usr/bin/true", mode: "one-shot" },
    args: [],
    cwd: "/tmp",
    maxRuntime: "2h",
    stopTimeoutSeconds: 5,
  });
  const args = calls[0].args;
  assert.equal(args.includes("--collect"), false);
  assert.ok(args.includes("--no-block"));
  assert.ok(args.includes("--property=RemainAfterExit=yes"));
});

test("unit status preserves queued jobs, activation evidence, and indeterminate timeouts", async () => {
  const queued = await getUnitStatus({
    async exec() {
      return {
        stdout: "LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\nResult=success\nExecMainStatus=0\nJob=77/start\nActiveEnterTimestampMonotonic=0\nInactiveEnterTimestampMonotonic=12\nExecMainStartTimestampMonotonic=0\n",
        stderr: "", code: 0,
      };
    },
  }, "queued.service");
  assert.equal(queued.verified, true);
  assert.equal(queued.job, "77/start");
  assert.equal(queued.inactiveEnterTimestampMonotonic, 12);

  const timedOut = await getUnitStatus({
    async exec() { return { stdout: "", stderr: "", code: 143, killed: true }; },
  }, "unknown.service");
  assert.equal(timedOut.verified, false);
  assert.match(timedOut.error ?? "", /timed out/);
});

test("running verification waits through a queued job and requires an active main pid", async () => {
  let reads = 0;
  const status = await waitForUnitRunning({
    async exec() {
      reads += 1;
      if (reads === 1) return { stdout: "LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\nJob=88/start\n", stderr: "", code: 0 };
      return { stdout: "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=4242\nJob=\nExecMainStartTimestampMonotonic=10\n", stderr: "", code: 0 };
    },
  }, "worker.service", { timeoutMs: 100, intervalMs: 1, stableMs: 0 });
  assert.equal(status.mainPid, 4242);
  assert.equal(reads, 2);
});

test("running verification rejects a process that fails before readiness", async () => {
  await assert.rejects(waitForUnitRunning({
    async exec() {
      return { stdout: "LoadState=loaded\nActiveState=failed\nSubState=failed\nMainPID=0\nResult=exit-code\nExecMainStatus=1\nJob=\n", stderr: "", code: 0 };
    },
  }, "worker.service", { timeoutMs: 50, intervalMs: 1 }), /failed before readiness/);
});

test("stop verifies the worker cgroup and escalates remaining descendants", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  let cgroupReads = 0;
  const runner = {
    async exec(command: string, args: string[]) {
      calls.push({ command, args });
      if (command === "systemd-cgls") {
        cgroupReads += 1;
        return cgroupReads === 1
          ? { stdout: "Control group /user.slice/worker.service:\n└─4242 chromium\n", stderr: "", code: 0 }
          : { stdout: "", stderr: "", code: 1 };
      }
      if (command === "systemctl" && args.includes("show")) {
        return { stdout: "LoadState=not-found\nActiveState=inactive\nSubState=dead\nJob=\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
  };
  assert.deepEqual((await readUnitProcessTree(runner, "worker.service")).pids, [4242]);
  cgroupReads = 0;
  await stopUnit(runner, "worker.service");
  assert.ok(calls.some((call) => call.command === "systemctl" && call.args.includes("kill") && call.args.includes("--signal=SIGKILL")));
  assert.ok(calls.some((call) => call.command === "systemctl" && call.args.includes("reset-failed")));
});

test("stop resets a failed unit even when descendants survive escalation", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner = {
    async exec(command: string, args: string[]) {
      calls.push({ command, args });
      if (command === "systemd-cgls") {
        return { stdout: "Control group /user.slice/worker.service:\n└─4242 stuck-child\n", stderr: "", code: 0 };
      }
      if (command === "systemctl" && args.includes("show")) {
        return { stdout: "LoadState=not-found\nActiveState=inactive\nSubState=dead\nJob=\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    },
  };
  await assert.rejects(stopUnit(runner, "worker.service", { timeoutMs: 50, intervalMs: 1, stableMs: 0 }), /still owns processes/);
  assert.ok(calls.some((call) => call.command === "systemctl" && call.args.includes("reset-failed")));
});

test("unit status maps to canonical worker states without inferring readiness", () => {
  assert.equal(stateFromUnit({ exists: true, activeState: "active", subState: "running" }, "provisioning"), "registering");
  assert.equal(stateFromUnit({ exists: true, activeState: "active", subState: "running" }, "working"), "working");
  assert.equal(stateFromUnit({ exists: true, activeState: "active", subState: "exited", result: "success", execMainStatus: 0 }, "registering"), "stopped");
  assert.equal(stateFromUnit({ exists: true, activeState: "failed", result: "exit-code" }, "registering"), "failed");
  assert.equal(stateFromUnit({ exists: true, activeState: "inactive", execMainStatus: 0 }, "registering"), "failed");
  assert.equal(stateFromUnit({ exists: true, activeState: "inactive", execMainStatus: 0, execMainStartTimestampMonotonic: 10 }, "registering"), "stopped");
  assert.equal(stateFromUnit({ exists: true, activeState: "inactive", job: "42/start" }, "registering"), "provisioning");
  assert.equal(stateFromUnit({ verified: false, exists: false }, "registering"), "registering");
  assert.equal(stateFromUnit({ exists: true, activeState: "deactivating" }, "working"), "working");
  assert.equal(stateFromUnit({ exists: false }, "registering"), "lost");
  assert.equal(stateFromUnit({ exists: false }, "completed"), "completed");
  assert.equal(stateFromUnit({ exists: false }, "stopped"), "stopped");
});

test("Pi agent-info views only include workers attached to that manager session", () => {
  const first = createSystemdRecord({
    id: "first-worker", runId: "run-a", harness: "pi", role: "advisor", task: "a", cwd: "/tmp", profile: "pi-peer",
    unit: "first.service", managerSessionId: "pi-session-a", config: DEFAULT_CONFIG,
  });
  const second = createSystemdRecord({
    id: "second-worker", runId: "run-b", harness: "codex", role: "builder", task: "b", cwd: "/tmp", profile: "codex-safe",
    unit: "second.service", managerSessionId: "pi-session-b", config: DEFAULT_CONFIG,
  });
  assert.deepEqual(workersAttachedToManager([first, second], "pi-session-a").map((worker) => worker.id), ["first-worker"]);
});

test("heartbeat renewal is activity-gated, capped at the idle deadline, and requests one checkpoint", () => {
  const createdAt = 1_000;
  const running = createSystemdRecord({
    id: "running-worker", runId: "run-running", harness: "codex", role: "builder", task: "test", cwd: "/tmp",
    profile: "codex-safe", unit: "running.service", managerSessionId: "session-a", config: DEFAULT_CONFIG, now: createdAt,
  });
  running.state = "running";
  const failed = createSystemdRecord({
    id: "failed-worker", runId: "run-failed", harness: "codex", role: "builder", task: "test", cwd: "/tmp",
    profile: "codex-safe", unit: "failed.service", managerSessionId: "session-a", config: DEFAULT_CONFIG, now: createdAt,
  });
  failed.state = "running";
  const observedFailed = { ...failed, state: "failed" as const };
  const state = { version: 1 as const, workers: [running, failed] };

  const activeHeartbeatAt = createdAt + 20 * 60_000;
  const active = renewObservedWorkerLeases(state, [structuredClone(running), observedFailed], "session-a", DEFAULT_CONFIG, activeHeartbeatAt);
  assert.deepEqual(active.renewed.map((worker) => worker.id), ["running-worker"]);
  assert.deepEqual(active.checkpointRequested, []);
  assert.equal(running.leaseExpiresAt, boundedLeaseExpiry(DEFAULT_CONFIG, createdAt, activeHeartbeatAt));
  assert.equal(failed.leaseExpiresAt, leaseExpiry(DEFAULT_CONFIG, createdAt));

  const warningAt = workerIdleDeadline(DEFAULT_CONFIG, createdAt) - DEFAULT_CONFIG.checkpointWarningMinutes * 60_000;
  const warning = renewObservedWorkerLeases(state, [structuredClone(running)], "session-a", DEFAULT_CONFIG, warningAt);
  assert.equal(running.leaseExpiresAt, workerIdleDeadline(DEFAULT_CONFIG, createdAt));
  assert.deepEqual(warning.checkpointRequested.map((worker) => worker.id), ["running-worker"]);
  const duplicate = renewObservedWorkerLeases(state, [structuredClone(running)], "session-a", DEFAULT_CONFIG, warningAt + 1_000);
  assert.deepEqual(duplicate.checkpointRequested, []);
  const retry = renewObservedWorkerLeases(state, [structuredClone(running)], "session-a", DEFAULT_CONFIG, warningAt + DEFAULT_CONFIG.checkpointRetryMinutes * 60_000);
  assert.deepEqual(retry.checkpointRequested.map((worker) => worker.id), ["running-worker"]);
  assert.equal(running.checkpointAttemptCount, 2);
  const expired = renewObservedWorkerLeases(state, [structuredClone(running)], "session-a", DEFAULT_CONFIG, workerIdleDeadline(DEFAULT_CONFIG, createdAt) + 1);
  assert.deepEqual(expired.renewed, []);
});

test("manager ownership rebind changes exact context and advances the binding epoch", () => {
  const worker = createSystemdRecord({
    id: "owner-worker", runId: "owner-run", harness: "codex", role: "builder", task: "test", cwd: "/tmp",
    profile: "codex-safe", unit: "owner.service", managerSessionId: "pi-manager", config: DEFAULT_CONFIG, now: 1_000,
  });
  worker.managerOwner = { context: "pi", principalId: "pi-manager", sessionId: "pi-manager", bindingEpoch: 0 };
  assert.deepEqual(rebindManagerOwner(worker, "opencode", "open-manager"), {
    context: "opencode", principalId: "open-manager", sessionId: "open-manager", bindingEpoch: 1,
  });
  assert.deepEqual(rebindManagerOwner({ ...worker, managerOwner: { context: "opencode", principalId: "open-manager", sessionId: "open-manager", bindingEpoch: 1 } }, "opencode", "open-manager"), {
    context: "opencode", principalId: "open-manager", sessionId: "open-manager", bindingEpoch: 1,
  });
});

test("manager-received worker Intercom activity resets the idle budget but manager sends cannot", () => {
  const worker = createSystemdRecord({
    id: "worker-a", runId: "run-a", harness: "pi", role: "advisor", task: "test", cwd: "/tmp", profile: "pi-peer",
    unit: "worker-a.service", managerSessionId: "manager-a", config: DEFAULT_CONFIG, now: 1_000,
  });
  worker.state = "running";
  worker.checkpointRequestedAt = 2_000;
  const state = { version: 3 as const, generation: 0, workers: [worker as WorkerRecordV3], workerGenerations: [{ workerId: worker.id, generation: worker.workerGeneration! }] };
  recordWorkerActivity(worker, DEFAULT_CONFIG, 2_500);
  assert.equal(worker.lastAuthenticatedIntercomActivityAt, undefined, "manual renewal activity must not claim inbound Intercom evidence");
  assert.equal(recordIntercomWorkerActivity(state, "manager-a", { id: "other", name: "other" }, DEFAULT_CONFIG, 3_000), undefined);
  assert.equal(recordIntercomWorkerActivity(state, "manager-a", { id: "spoof", name: "worker-a" }, DEFAULT_CONFIG, 3_500), undefined);
  const updated = recordIntercomWorkerActivity(state, "manager-a", { id: "worker-a", name: "display-name" }, DEFAULT_CONFIG, 4_000);
  assert.equal(updated?.lastWorkerActivityAt, 4_000);
  assert.equal(updated?.lastAuthenticatedIntercomActivityAt, 4_000);
  assert.equal(updated?.idleDeadlineAt, workerIdleDeadline(DEFAULT_CONFIG, 4_000));
  assert.equal(updated?.checkpointRequestedAt, undefined);
});

test("legacy live records receive a complete idle window during lifecycle migration", () => {
  const worker = createSystemdRecord({
    id: "legacy-worker", runId: "legacy-run", harness: "pi", role: "advisor", task: "test", cwd: "/tmp",
    profile: "pi-peer", unit: "legacy.service", managerSessionId: "manager", config: DEFAULT_CONFIG, now: 1_000,
  });
  worker.state = "running";
  worker.leaseExpiresAt = 0;
  delete worker.lastWorkerActivityAt;
  delete worker.idleDeadlineAt;
  delete worker.checkpointDeadlineAt;
  const migratedAt = 50_000;
  assert.equal(initializeWorkerLifecycle(worker, DEFAULT_CONFIG, migratedAt), true);
  assert.equal(worker.lastWorkerActivityAt, migratedAt);
  assert.equal(worker.idleDeadlineAt, workerIdleDeadline(DEFAULT_CONFIG, migratedAt));
  assert.equal(cleanupReason(worker, migratedAt), undefined);
});

test("cleanup waits through the checkpoint grace and only selects owned live workers", () => {
  const base: WorkerRecord = createSystemdRecord({
    id: "worker-a",
    runId: "run-a",
    harness: "codex",
    role: "builder",
    task: "test",
    cwd: "/tmp",
    profile: "codex-safe",
    unit: "agent-intercom-worker-worker-a-run-a.service",
    managerSessionId: "session-a",
    config: DEFAULT_CONFIG,
    now: 1000,
  });
  base.state = "running";
  assert.equal(cleanupReason(base, base.idleDeadlineAt!), undefined);
  assert.equal(cleanupReason(base, base.checkpointDeadlineAt! - 1), undefined);
  assert.match(cleanupReason(base, base.checkpointDeadlineAt!) ?? "", /checkpoint grace expired/);
  assert.equal(cleanupReason({ ...base, owned: false }, base.checkpointDeadlineAt!), undefined);
  assert.equal(cleanupReason({ ...base, state: "stopped" }, base.checkpointDeadlineAt!), undefined);
});

test("expired cleanup snapshot is fenced by renewal or adoption activity", () => {
  const worker = createSystemdRecord({
    id: "race-worker", runId: "race-run", harness: "codex", role: "builder", task: "test", cwd: "/tmp",
    profile: "codex-safe", unit: "race.service", managerSessionId: "old-manager", config: DEFAULT_CONFIG, now: 1_000,
  });
  worker.state = "running";
  const expectedDeadline = worker.checkpointDeadlineAt!;
  assert.equal(cleanupSnapshotStillEligible(worker, expectedDeadline, expectedDeadline), true);
  worker.state = "blocked";
  worker.stateReason = "stop_in_progress";
  assert.equal(cleanupSnapshotStillEligible(worker, expectedDeadline, expectedDeadline), false);
  assert.equal(cleanupReason(worker, expectedDeadline), undefined);
  worker.state = "running";
  worker.stateReason = undefined;
  recordWorkerActivity(worker, DEFAULT_CONFIG, expectedDeadline + 1);
  worker.managerSessionId = "new-manager";
  assert.equal(cleanupSnapshotStillEligible(worker, expectedDeadline, expectedDeadline + 2), false);
  assert.ok(worker.checkpointDeadlineAt! > expectedDeadline);
});

test("profile command resolution verifies absolute and PATH executables", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-intercom-command-test-"));
  try {
    const nonExecutable = join(dir, "not-executable");
    await writeFile(nonExecutable, "#!/bin/sh\n");
    assert.equal(resolveProfileCommand("/bin/true"), "/bin/true");
    assert.equal(resolveProfileCommand(nonExecutable), undefined);
    assert.equal(resolveProfileCommand("missing-command", dir), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("configuration merges profiles, defaults, and role presets without dropping built-ins", () => {
  const config = mergeConfig({
    leaseMinutes: 5,
    idleTimeoutMinutes: 90,
    checkpointWarningMinutes: 12,
    checkpointRetryMinutes: 4,
    cleanupGraceMinutes: 20,
    cleanupTimerMinutes: 10,
    cleanupTimerEnabled: false,
    routing: {
      preference: ["claude", "pi", "codex", "opencode", "invalid", "claude"],
      explicitOnly: [],
      roles: { auditor: ["claude", "pi"] },
      profilePreferences: { codex: ["codex-minimal", "codex-safe"] },
      roleRequirements: { auditor: { requiresSubagents: true } },
      modelRouting: {
        unmatchedHarness: "opencode",
        rules: [{ harness: "claude", patterns: ["internal/*", "invalid*middle"] }],
        stripPrefixes: { claude: ["internal/", "unsafe*"] },
      },
      fallback: { preserveRoleInstructions: false },
      capabilities: { requiresSubagents: ["claude"] },
    },
    supervision: { recommendRalphForSubstantialWork: false, recommendReturnOnAfterSpawn: true },
    defaultModels: { pi: "claude/claude-sonnet-5" },
    defaultEfforts: { pi: "max" },
    permissionProfiles: {
      audit: { workspace: "read-only", git: "read-only", hardened: true, piTools: ["read", "grep"] },
    },
    roles: {
      advisor: { instructions: "Override only the instructions." },
      auditor: { harness: "pi", profile: "pi-peer", permissionProfile: "audit", effort: "high", instructions: "Audit evidence." },
    },
    profiles: {
      "codex-yolo": {
        harness: "codex",
        command: "/usr/local/bin/coi-yolo",
        args: ["--no-tui"],
      },
    },
  });
  assert.equal(config.leaseMinutes, 5);
  assert.equal(config.idleTimeoutMinutes, 90);
  assert.equal(config.checkpointWarningMinutes, 12);
  assert.equal(config.checkpointRetryMinutes, 4);
  assert.equal(config.cleanupGraceMinutes, 20);
  assert.equal(config.cleanupTimerMinutes, 10);
  assert.equal(config.cleanupTimerEnabled, false);
  assert.deepEqual(config.routing.preference, ["claude", "pi", "codex", "opencode"]);
  assert.deepEqual(config.routing.explicitOnly, ["opencode"]);
  assert.deepEqual(config.routing.roles.auditor, ["claude", "pi"]);
  assert.deepEqual(config.routing.profilePreferences.codex, ["codex-minimal", "codex-safe"]);
  assert.equal(config.routing.roleRequirements.auditor.requiresSubagents, true);
  assert.equal(config.routing.modelRouting.unmatchedHarness, "opencode");
  assert.deepEqual(config.routing.modelRouting.rules, [{ harness: "claude", patterns: ["internal/*"] }]);
  assert.deepEqual(config.routing.modelRouting.stripPrefixes.claude, ["internal/"]);
  assert.equal(config.routing.fallback.preserveRoleInstructions, false);
  assert.deepEqual(config.routing.capabilities.requiresSubagents, ["claude"]);
  assert.deepEqual(config.supervision, {});
  assert.equal(config.defaultModels.pi, "claude/claude-sonnet-5");
  assert.equal(config.defaultEfforts.pi, "max");
  assert.equal(config.roles.auditor.harness, "pi");
  assert.equal(config.roles.auditor.permissionProfile, "audit");
  assert.equal(config.permissionProfiles.audit.workspace, "read-only");
  assert.equal(config.roles.advisor.harness, "pi");
  assert.equal(config.roles.advisor.profile, "pi-peer");
  assert.equal(config.roles.advisor.instructions, "Override only the instructions.");
  assert.ok(config.profiles["pi-peer"]);
  assert.ok(config.profiles["codex-safe"]);
  assert.equal(config.profiles["codex-yolo"].command, "/usr/local/bin/coi-yolo");
});

test("legacy default profiles seed fallback order unless a new order is explicit", () => {
  const migrated = mergeConfig({
    defaultProfiles: { codex: "codex-custom" },
    profiles: { "codex-custom": { harness: "codex", command: "/bin/codex-custom" } },
  });
  assert.deepEqual(migrated.routing.profilePreferences.codex, ["codex-custom", "codex-safe", "codex-minimal"]);
  const explicit = mergeConfig({
    defaultProfiles: { codex: "codex-custom" },
    routing: { profilePreferences: { codex: ["codex-minimal"] } },
  });
  assert.deepEqual(explicit.routing.profilePreferences.codex, ["codex-minimal"]);
});

test("OpenCode verbose model parsing exposes model-specific variants", () => {
  const output = [
    "opencode/big-pickle",
    JSON.stringify({ id: "big-pickle", variants: {} }, null, 2),
    "anthropic/claude-fable-5",
    JSON.stringify({ id: "claude-fable-5", variants: { low: {}, high: {}, max: {} } }, null, 2),
  ].join("\n");
  assert.deepEqual(parseOpenCodeModelsVerbose(output), [
    { id: "opencode/big-pickle", variants: [] },
    { id: "anthropic/claude-fable-5", variants: ["high", "low", "max"] },
  ]);
});

test("Pi model table parsing returns provider-qualified model ids", () => {
  const output = [
    "provider  model                 context  max-out  thinking  images",
    "claude    claude-opus-4-8       1M       128K     yes       yes",
    "codex     gpt-5.6-sol           272K     128K     yes       yes",
  ].join("\n");
  assert.deepEqual(parsePiModels(output), ["claude/claude-opus-4-8", "codex/gpt-5.6-sol"]);
});

test("model identifiers are normalized for external harness CLIs", () => {
  assert.equal(normalizeModelForHarness("pi", "claude/claude-opus-4-8"), "claude/claude-opus-4-8");
  assert.equal(normalizeModelForHarness("codex", "codex/gpt-5.6-sol"), "gpt-5.6-sol");
  assert.equal(normalizeModelForHarness("codex", "openai/gpt-5.4"), "gpt-5.4");
  assert.equal(normalizeModelForHarness("claude", "claude/claude-opus-4-8"), "claude-opus-4-8");
  assert.equal(normalizeModelForHarness("claude", "anthropic/claude-fable-5"), "claude-fable-5");
  assert.equal(normalizeModelForHarness("opencode", "anthropic/claude-fable-5"), "anthropic/claude-fable-5");
});

test("effort validation is harness-aware", () => {
  assert.equal(validateEffort("pi", "max"), "max");
  assert.equal(validateEffort("claude", "max"), "max");
  assert.throws(() => validateEffort("codex", "minimal"), /does not support/);
  assert.throws(() => validateEffort("codex", "max"), /does not support/);
  assert.throws(() => validateEffort("claude", "minimal"), /does not support/);
});

test("configuration can be written and read back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-intercom-orchestrator-config-test-"));
  try {
    const path = join(dir, "nested", "config.json");
    const config = mergeConfig({ defaultHarness: "pi", defaultModels: { pi: "codex/gpt-5.6-sol" } });
    await writeConfig(path, config);
    const loaded = await readConfig(path);
    assert.equal(loaded.defaultHarness, "pi");
    assert.equal(loaded.defaultModels.pi, "codex/gpt-5.6-sol");
    assert.equal((await readFile(path, "utf8")).endsWith("\n"), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("default configuration writes preserve custom profiles without serializing built-in profiles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-intercom-orchestrator-defaults-test-"));
  try {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({
      profiles: { custom: { harness: "pi", command: "/custom/pi", args: ["--mode", "rpc"] } },
      permissionProfiles: { custom: { workspace: "read-only", git: "read-only", piTools: ["read"] } },
      roles: { custom: { harness: "pi", profile: "custom", permissionProfile: "custom", instructions: "Stay custom." } },
      routing: { futurePolicy: { keep: true } },
      supervision: { futureGuidance: "keep" },
    }));
    const draft = await readConfig(path);
    draft.defaultModels.pi = "codex/gpt-5.6-sol";
    draft.routing.preference = ["codex", "claude", "pi", "opencode"];
    draft.routing.explicitOnly = ["opencode", "claude"];
    draft.routing.roles.custom = ["codex", "claude"];
    draft.routing.profilePreferences.codex = ["codex-minimal", "codex-safe"];
    draft.routing.roleRequirements.custom = { requiresSubagents: true };
    draft.routing.modelRouting.unmatchedHarness = "opencode";
    draft.routing.modelRouting.rules = [{ harness: "pi", patterns: ["google/*"] }];
    draft.routing.modelRouting.stripPrefixes.pi = ["google/"];
    draft.routing.fallback.preserveRoleInstructions = false;
    draft.routing.capabilities.requiresSubagents = ["codex"];
    await writeConfigDefaults(path, draft);
    const raw = JSON.parse(await readFile(path, "utf8"));
    assert.equal(raw.defaultModels.pi, "codex/gpt-5.6-sol");
    assert.equal(raw.profiles.custom.command, "/custom/pi");
    assert.equal(raw.profiles["pi-peer"], undefined);
    assert.equal(raw.permissionProfiles.custom.workspace, "read-only");
    assert.equal(raw.permissionProfiles.trusted, undefined);
    assert.equal(raw.defaultProfiles.pi, undefined);
    assert.equal(raw.roles.advisor, undefined);
    assert.equal(raw.roles.custom.instructions, "Stay custom.");
    assert.deepEqual(raw.routing.preference, ["codex", "claude", "pi", "opencode"]);
    assert.deepEqual(raw.routing.explicitOnly, ["opencode", "claude"]);
    assert.deepEqual(raw.routing.roles.custom, ["codex", "claude"]);
    assert.deepEqual(raw.routing.profilePreferences.codex, ["codex-minimal", "codex-safe"]);
    assert.deepEqual(raw.routing.roleRequirements.custom, { requiresSubagents: true });
    assert.equal(raw.routing.modelRouting.unmatchedHarness, "opencode");
    assert.deepEqual(raw.routing.modelRouting.rules, [{ harness: "pi", patterns: ["google/*"] }]);
    assert.deepEqual(raw.routing.modelRouting.stripPrefixes.pi, ["google/"]);
    assert.equal(raw.routing.fallback.preserveRoleInstructions, false);
    assert.deepEqual(raw.routing.capabilities.requiresSubagents, ["codex"]);
    assert.equal(raw.routing.roles.advisor, undefined);
    assert.deepEqual(raw.routing.futurePolicy, { keep: true });
    assert.equal(raw.supervision.recommendRalphForSubstantialWork, undefined);
    assert.equal(raw.supervision.recommendReturnOnAfterSpawn, undefined);
    assert.equal(raw.supervision.futureGuidance, "keep");
    const loaded = await readConfig(path);
    assert.deepEqual(loaded.routing.modelRouting.rules, draft.routing.modelRouting.rules);
    assert.deepEqual(loaded.routing.profilePreferences.codex, draft.routing.profilePreferences.codex);
    assert.deepEqual(loaded.supervision, {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("default writes preserve an explicit default-valued routing object as authoritative", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-intercom-routing-presence-test-"));
  try {
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({ defaultHarness: "claude", routing: {} }));
    const before = await readConfig(path);
    assert.equal(before.routing.preference[0], "pi");
    await writeConfigDefaults(path, before);
    const raw = JSON.parse(await readFile(path, "utf8"));
    assert.deepEqual(raw.routing, {});
    const after = await readConfig(path);
    assert.equal(after.routing.preference[0], "pi");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("worker store immediately reclaims a lock owned by a dead process", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-intercom-orchestrator-dead-lock-test-"));
  try {
    const path = join(dir, "workers.json");
    const lockPath = `${path}.lock`;
    await mkdir(lockPath, { recursive: true });
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({ pid: 99999999, createdAt: Date.now() }));
    const store = new WorkerStore(path);
    await store.upsert({
      id: "recovered", runId: "recovered", harness: "codex", backend: "systemd", role: "worker", task: "test", cwd: "/tmp",
      state: "stopped", owned: true, managerSessionId: "session", createdAt: 1, updatedAt: 1, leaseExpiresAt: 1,
    });
    assert.deepEqual((await store.read()).workers.map((worker) => worker.id), ["recovered"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("forget keeps the worker id reserved until its runtime deletion finishes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-intercom-forget-respawn-"));
  const agentDir = join(root, ".pi", "agent");
  const store = new WorkerStore(join(root, "workers.json"));
  const oldWorker: WorkerRecord = {
    id: "same-worker", runId: "old-run", harness: "pi", backend: "systemd", role: "builder", task: "old", cwd: "/tmp",
    state: "stopped", owned: true, managerSessionId: "manager", createdAt: 1, updatedAt: 1, leaseExpiresAt: Date.now() + 60_000,
  };
  const newWorker: WorkerRecord = {
    ...oldWorker,
    runId: "new-run",
    workerIncarnationId: "new-run",
    workerGeneration: 1,
    managerOwner: { context: "pi", principalId: "manager", sessionId: "manager", bindingEpoch: 1 },
    task: "new",
    state: "provisioning",
  };
  const runtimeRoot = workerRuntimeRoot(oldWorker.id, agentDir);
  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(join(runtimeRoot, "old-state"), "old\n");
  await store.write({ version: 1, workers: [oldWorker] });
  let releaseDelete!: () => void;
  let deleteEntered!: () => void;
  const deleteBlocked = new Promise<void>((resolve) => { releaseDelete = resolve; });
  const entered = new Promise<void>((resolve) => { deleteEntered = resolve; });
  try {
    const forgetting = removeWorkerRuntimeAndRecord(store, oldWorker, agentDir, async (path) => {
      deleteEntered();
      await deleteBlocked;
      await rm(path, { recursive: true, force: true });
    });
    await entered;
    await assert.rejects(store.mutate((state) => reserveWorkerRecord(state, newWorker)), /runtime cleanup in progress/);
    assert.equal(await readFile(join(runtimeRoot, "old-state"), "utf8"), "old\n");
    releaseDelete();
    await forgetting;
    await store.mutate((state) => reserveWorkerRecord(state, newWorker));
    await mkdir(runtimeRoot, { recursive: true });
    await writeFile(join(runtimeRoot, "new-state"), "new\n");
    const state = await store.read();
    assert.equal(state.workers.length, 1);
    assert.equal(state.workers[0].runId, "new-run");
    assert.equal(await readFile(join(runtimeRoot, "new-state"), "utf8"), "new\n");
  } finally {
    releaseDelete?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("worker store writes atomically and serializes concurrent mutations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-intercom-orchestrator-test-"));
  try {
    const path = join(dir, "workers.json");
    const store = new WorkerStore(path);
    const secondStore = new WorkerStore(path);
    const makeWorker = (id: string): WorkerRecord => ({
      id,
      runId: id,
      harness: "codex",
      backend: "systemd",
      role: "worker",
      task: "test",
      cwd: "/tmp",
      state: "stopped",
      owned: true,
      managerSessionId: "session",
      createdAt: 1,
      updatedAt: 1,
      leaseExpiresAt: 1,
    });
    await Promise.all([store.upsert(makeWorker("worker-a")), secondStore.upsert(makeWorker("worker-b"))]);
    const state = await store.read();
    assert.deepEqual(state.workers.map((worker) => worker.id).sort(), ["worker-a", "worker-b"]);
    const raw = await readFile(path, "utf8");
    assert.doesNotThrow(() => JSON.parse(raw));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

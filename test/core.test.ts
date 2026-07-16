import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, mergeConfig, readConfig, writeConfig, writeConfigDefaults } from "../src/config.ts";
import { parseOpenCodeModelsVerbose, parsePiModels, workersAttachedToManager } from "../src/index.ts";
import { WorkerStore } from "../src/store.ts";
import { launchUnit, makeUnitName, parseDurationToSeconds, readUnitProcessTree, sanitizeUnitPart, stopUnit } from "../src/systemd.ts";
import type { WorkerRecord } from "../src/types.ts";
import {
  buildWorkerArgs,
  buildWorkerEnvironment,
  cleanupReason,
  createSystemdRecord,
  normalizeModelForHarness,
  stateFromUnit,
  validateEffort,
  validateWorkerId,
} from "../src/workers.ts";

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
  const opencode = DEFAULT_CONFIG.profiles["opencode-run"];
  assert.ok(pi && codex && claude && opencode);
  const managerTarget = "manager-a";
  const piArgs = buildWorkerArgs({ harness: "pi", profile: pi, workerId: "advisor-a", cwd: "/repo", role: "advisor", task: "Review", model: "codex/gpt-5.6-sol", effort: "high", managerTarget });
  const codexArgs = buildWorkerArgs({ harness: "codex", profile: codex, workerId: "worker-a", cwd: "/repo", role: "builder", task: "Build", model: "gpt-5.6-sol", effort: "high", managerTarget });
  const claudeArgs = buildWorkerArgs({ harness: "claude", profile: claude, workerId: "worker-b", cwd: "/repo", role: "challenger", task: "Challenge", model: "opus", effort: "max", managerTarget });
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
  assert.ok(codexArgs.includes("--instructions"));
  assert.ok(codexArgs.includes("model=\"gpt-5.6-sol\""));
  assert.ok(codexArgs.includes("model_reasoning_effort=\"high\""));
  assert.ok(claudeArgs.includes("--safe"));
  assert.ok(claudeArgs.includes("--effort"));
  assert.ok(claudeArgs.includes("worker-b"));
  assert.equal(opencodeArgs[0], "run");
  assert.ok(opencodeArgs.includes("--variant"));
  assert.match(opencodeArgs.at(-1) ?? "", /Return OPEN_OK/);
  for (const args of [piArgs, codexArgs, claudeArgs, opencodeArgs]) {
    assert.match(args.join(" "), /manager-a/);
    assert.match(args.join(" "), /intercom_team/);
    assert.match(args.join(" "), /intercom_send for progress/);
  }
  assert.equal(buildWorkerEnvironment("pi", "advisor-a", "advisor").AGENT_INTERCOM_ORCHESTRATOR_DISABLED, "1");
  assert.equal(buildWorkerEnvironment("codex", "builder-a", "builder", "gpt-5.6-sol").CODEX_INTERCOM_MODEL, "gpt-5.6-sol");
  const ownedEnv = buildWorkerEnvironment("pi", "advisor-a", "advisor", undefined, {
    runId: "run-a", unit: "worker-a.service", managerSessionId: "manager-a",
  });
  assert.equal(ownedEnv.AGENT_INTERCOM_WORKER_ID, "advisor-a");
  assert.equal(ownedEnv.AGENT_INTERCOM_SYSTEMD_UNIT, "worker-a.service");
  assert.equal(ownedEnv.AGENT_INTERCOM_MANAGER_SESSION_ID, "manager-a");
  assert.equal(ownedEnv.AGENT_INTERCOM_MANAGER_TARGET, "manager-a");
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
  assert.ok(args.includes("--property=RemainAfterExit=yes"));
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
      return { stdout: "", stderr: "", code: 0 };
    },
  };
  assert.deepEqual((await readUnitProcessTree(runner, "worker.service")).pids, [4242]);
  cgroupReads = 0;
  await stopUnit(runner, "worker.service");
  assert.ok(calls.some((call) => call.command === "systemctl" && call.args.includes("kill") && call.args.includes("--signal=SIGKILL")));
});

test("unit status maps to normalized worker states", () => {
  assert.equal(stateFromUnit({ exists: true, activeState: "active", subState: "running" }, "provisioning"), "running");
  assert.equal(stateFromUnit({ exists: true, activeState: "active", subState: "exited", result: "success", execMainStatus: 0 }, "running"), "completed");
  assert.equal(stateFromUnit({ exists: true, activeState: "failed", result: "exit-code" }, "running"), "failed");
  assert.equal(stateFromUnit({ exists: true, activeState: "inactive", execMainStatus: 0 }, "running"), "completed");
  assert.equal(stateFromUnit({ exists: false }, "running"), "lost");
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

test("cleanup only selects owned live workers with expired leases", () => {
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
  base.leaseExpiresAt = 2000;
  assert.match(cleanupReason(base, 3000) ?? "", /lease expired/);
  assert.equal(cleanupReason({ ...base, owned: false }, 3000), undefined);
  assert.equal(cleanupReason({ ...base, state: "stopped" }, 3000), undefined);
});

test("configuration merges profiles, defaults, and role presets without dropping built-ins", () => {
  const config = mergeConfig({
    leaseMinutes: 5,
    defaultModels: { pi: "claude/claude-sonnet-5" },
    defaultEfforts: { pi: "max" },
    roles: {
      advisor: { instructions: "Override only the instructions." },
      auditor: { harness: "pi", profile: "pi-peer", effort: "high", instructions: "Audit evidence." },
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
  assert.equal(config.defaultModels.pi, "claude/claude-sonnet-5");
  assert.equal(config.defaultEfforts.pi, "max");
  assert.equal(config.roles.auditor.harness, "pi");
  assert.equal(config.roles.advisor.harness, "pi");
  assert.equal(config.roles.advisor.profile, "pi-peer");
  assert.equal(config.roles.advisor.instructions, "Override only the instructions.");
  assert.ok(config.profiles["pi-peer"]);
  assert.ok(config.profiles["codex-safe"]);
  assert.equal(config.profiles["codex-yolo"].command, "/usr/local/bin/coi-yolo");
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
  assert.equal(normalizeModelForHarness("claude", "claude/claude-opus-4-8"), "claude-opus-4-8");
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
      roles: { custom: { harness: "pi", profile: "custom", instructions: "Stay custom." } },
    }));
    const draft = await readConfig(path);
    draft.defaultModels.pi = "codex/gpt-5.6-sol";
    await writeConfigDefaults(path, draft);
    const raw = JSON.parse(await readFile(path, "utf8"));
    assert.equal(raw.defaultModels.pi, "codex/gpt-5.6-sol");
    assert.equal(raw.profiles.custom.command, "/custom/pi");
    assert.equal(raw.profiles["pi-peer"], undefined);
    assert.equal(raw.defaultProfiles.pi, undefined);
    assert.equal(raw.roles.advisor, undefined);
    assert.equal(raw.roles.custom.instructions, "Stay custom.");
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

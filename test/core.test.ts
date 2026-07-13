import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.ts";
import { WorkerStore } from "../src/store.ts";
import { makeUnitName, sanitizeUnitPart } from "../src/systemd.ts";
import type { WorkerRecord } from "../src/types.ts";
import {
  buildWorkerArgs,
  cleanupReason,
  createSystemdRecord,
  stateFromUnit,
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

test("Codex and Claude launch args include stable identity", () => {
  const codex = DEFAULT_CONFIG.profiles["codex-safe"];
  const claude = DEFAULT_CONFIG.profiles["claude-safe"];
  assert.ok(codex && claude);
  const codexArgs = buildWorkerArgs("codex", codex, "worker-a", "/repo", "builder");
  const claudeArgs = buildWorkerArgs("claude", claude, "worker-b", "/repo", "challenger");
  assert.deepEqual(codexArgs.slice(codexArgs.indexOf("--name"), codexArgs.indexOf("--name") + 4), [
    "--name",
    "worker-a",
    "--id",
    "worker-a",
  ]);
  assert.ok(codexArgs.includes("--instructions"));
  assert.ok(claudeArgs.includes("--safe"));
  assert.ok(claudeArgs.includes("worker-b"));
});

test("unit status maps to normalized worker states", () => {
  assert.equal(stateFromUnit({ exists: true, activeState: "active", subState: "running" }, "provisioning"), "running");
  assert.equal(stateFromUnit({ exists: true, activeState: "failed", result: "exit-code" }, "running"), "failed");
  assert.equal(stateFromUnit({ exists: true, activeState: "inactive", execMainStatus: 0 }, "running"), "completed");
  assert.equal(stateFromUnit({ exists: false }, "running"), "lost");
  assert.equal(stateFromUnit({ exists: false }, "stopped"), "stopped");
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

test("configuration merges custom profiles without dropping defaults", () => {
  const config = mergeConfig({
    leaseMinutes: 5,
    profiles: {
      "codex-yolo": {
        harness: "codex",
        command: "/usr/local/bin/coi-yolo",
        args: ["--no-tui"],
      },
    },
  });
  assert.equal(config.leaseMinutes, 5);
  assert.ok(config.profiles["codex-safe"]);
  assert.equal(config.profiles["codex-yolo"].command, "/usr/local/bin/coi-yolo");
});

test("worker store writes atomically and serializes concurrent mutations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-intercom-orchestrator-test-"));
  try {
    const path = join(dir, "workers.json");
    const store = new WorkerStore(path);
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
    await Promise.all([store.upsert(makeWorker("worker-a")), store.upsert(makeWorker("worker-b"))]);
    const state = await store.read();
    assert.deepEqual(state.workers.map((worker) => worker.id).sort(), ["worker-a", "worker-b"]);
    const raw = await readFile(path, "utf8");
    assert.doesNotThrow(() => JSON.parse(raw));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

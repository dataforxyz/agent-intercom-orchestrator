import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cleanupUnitContents, CLEANUP_SERVICE, CLEANUP_TIMER, ensureCleanupTimer } from "../src/cleanup-timer.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";

test("cleanup timer units use exact packaged paths and a persistent bounded interval", () => {
  const units = cleanupUnitContents({
    nodePath: "/opt/node/bin/node",
    cleanupScriptPath: "/opt/agent intercom/agent-fleet-cleanup.mjs",
    intervalMinutes: 15,
    agentDir: "/home/test/.pi/agent",
  });
  assert.match(units.service, /Type=oneshot/);
  assert.match(units.service, /ExecStart="\/opt\/node\/bin\/node" "\/opt\/agent intercom\/agent-fleet-cleanup\.mjs"/);
  assert.match(units.service, /Environment="PI_CODING_AGENT_DIR=\/home\/test\/\.pi\/agent"/);
  assert.match(units.timer, /OnUnitActiveSec=15min/);
  assert.match(units.timer, /Persistent=true/);
  assert.match(units.timer, new RegExp(`Unit=${CLEANUP_SERVICE}`));
});

test("cleanup timer installation is idempotent and enables the exact timer", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-intercom-cleanup-timer-"));
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner = {
    async exec(command: string, args: string[]) {
      calls.push({ command, args });
      return { stdout: "", stderr: "", code: 0 };
    },
  };
  try {
    const input = {
      runner,
      config: DEFAULT_CONFIG,
      cleanupScriptPath: "/opt/agent-intercom/src/agent-fleet-cleanup.mjs",
      agentDir: "/home/test/.pi/agent",
      userConfigDir: root,
    };
    const first = await ensureCleanupTimer(input);
    assert.deepEqual(first, { enabled: true, changed: true });
    assert.match(await readFile(join(root, CLEANUP_SERVICE), "utf8"), /agent-fleet-cleanup\.mjs/);
    assert.match(await readFile(join(root, CLEANUP_TIMER), "utf8"), /OnUnitActiveSec=15min/);
    assert.ok(calls.some((call) => call.command === "systemctl" && call.args.includes("daemon-reload")));
    assert.ok(calls.some((call) => call.command === "systemctl" && call.args.includes("enable") && call.args.includes(CLEANUP_TIMER)));

    calls.length = 0;
    const second = await ensureCleanupTimer(input);
    assert.deepEqual(second, { enabled: true, changed: false });
    assert.equal(calls.some((call) => call.args.includes("daemon-reload")), false);
    assert.ok(calls.some((call) => call.args.includes("enable") && call.args.includes(CLEANUP_TIMER)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disabled cleanup timer stops and disables without rewriting units", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner = {
    async exec(command: string, args: string[]) {
      calls.push({ command, args });
      return { stdout: "", stderr: "", code: 0 };
    },
  };
  const config = { ...DEFAULT_CONFIG, cleanupTimerEnabled: false };
  assert.deepEqual(await ensureCleanupTimer({
    runner,
    config,
    cleanupScriptPath: "/unused",
    agentDir: "/unused",
    userConfigDir: "/unused",
  }), { enabled: false, changed: false });
  assert.deepEqual(calls[0], { command: "systemctl", args: ["--user", "disable", "--now", CLEANUP_TIMER] });
});

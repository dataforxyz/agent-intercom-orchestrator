import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

async function runChild(script: URL, env: NodeJS.ProcessEnv, input?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--experimental-strip-types", script.pathname], {
    cwd: process.cwd(), env, stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.end(input);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return { code, stdout, stderr };
}

test("agent-intercom-fleet CLI hosts the same agent_fleet tool for non-Pi managers", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "agent-intercom-fleet-cli-"));
  try {
    const cli = new URL("../src/agent-fleet-cli.mjs", import.meta.url);
    const { code, stdout, stderr } = await runChild(cli, {
      ...process.env, PI_CODING_AGENT_DIR: agentDir, AGENT_INTERCOM_ORCHESTRATOR_DISABLED: "",
    }, JSON.stringify({
      managerSessionId: "opencode-manager-test",
      cwd: process.cwd(),
      params: { action: "capabilities" },
    }));
    assert.equal(code, 0, stderr);
    const response = JSON.parse(stdout);
    assert.equal(response.ok, true);
    assert.match(response.result.content[0].text, /opencode: modes=persistent,one-shot/);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("CLI renew records activity before startup cleanup can expire the worker", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "agent-intercom-fleet-renew-cli-"));
  try {
    const orchestratorDir = join(agentDir, "intercom", "orchestrator");
    await mkdir(orchestratorDir, { recursive: true });
    const old = Date.now() - 2 * 60 * 60_000;
    await writeFile(join(orchestratorDir, "workers.json"), JSON.stringify({ version: 1, workers: [{
      id: "quiet-worker", runId: "quiet-run", harness: "pi", backend: "systemd", role: "advisor", task: "quiet", cwd: "/tmp",
      state: "running", owned: true, managerSessionId: "opencode-manager-test", intercomTarget: "quiet-worker",
      createdAt: old, updatedAt: old, leaseExpiresAt: old, lastWorkerActivityAt: old, idleDeadlineAt: old, checkpointDeadlineAt: old,
    }] }));
    const cli = new URL("../src/agent-fleet-cli.mjs", import.meta.url);
    const { code, stdout, stderr } = await runChild(cli, {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      AGENT_INTERCOM_ORCHESTRATOR_DISABLED: "",
      AGENT_INTERCOM_DISABLE_CLEANUP_TIMER: "1",
    }, JSON.stringify({
      managerSessionId: "opencode-manager-test",
      cwd: process.cwd(),
      params: { action: "renew", id: "quiet-worker" },
    }));
    assert.equal(code, 0, stderr);
    const response = JSON.parse(stdout);
    assert.equal(response.ok, true);
    assert.match(response.result.content[0].text, /Renewed 1 worker lease/);
    const state = JSON.parse(await readFile(join(orchestratorDir, "workers.json"), "utf8"));
    assert.equal(state.workers[0].state, "running");
    assert.ok(state.workers[0].lastWorkerActivityAt > old);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("internal manager heartbeat returns checkpoint requests without exposing a model-facing action", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "agent-intercom-fleet-heartbeat-cli-"));
  try {
    const orchestratorDir = join(agentDir, "intercom", "orchestrator");
    await mkdir(orchestratorDir, { recursive: true });
    const now = Date.now();
    const lastActivity = now - 55 * 60_000;
    await writeFile(join(orchestratorDir, "workers.json"), JSON.stringify({ version: 1, workers: [{
      id: "checkpoint-worker", runId: "checkpoint-run", harness: "pi", backend: "systemd", role: "advisor", task: "quiet", cwd: "/tmp",
      state: "running", owned: true, managerSessionId: "opencode-manager-test", intercomTarget: "checkpoint-worker",
      createdAt: lastActivity, updatedAt: lastActivity, leaseExpiresAt: now + 5 * 60_000,
      lastWorkerActivityAt: lastActivity, idleDeadlineAt: lastActivity + 60 * 60_000, checkpointDeadlineAt: lastActivity + 75 * 60_000,
    }] }));
    const cli = new URL("../src/agent-fleet-cli.mjs", import.meta.url);
    const { code, stdout, stderr } = await runChild(cli, {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      AGENT_INTERCOM_ORCHESTRATOR_DISABLED: "",
      AGENT_INTERCOM_DISABLE_CLEANUP_TIMER: "1",
    }, JSON.stringify({
      managerSessionId: "opencode-manager-test",
      cwd: process.cwd(),
      params: { action: "_heartbeat" },
    }));
    assert.equal(code, 0, stderr);
    const response = JSON.parse(stdout);
    assert.equal(response.ok, true);
    assert.equal(response.result.details.checkpointRequests.length, 1);
    assert.equal(response.result.details.checkpointRequests[0].target, "checkpoint-worker");
    assert.match(response.result.details.checkpointRequests[0].message, /Lifecycle checkpoint requested/);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("managerless cleanup wrapper executes exact fleet cleanup against the configured state", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "agent-intercom-fleet-cleanup-cli-"));
  try {
    const script = new URL("../src/agent-fleet-cleanup.mjs", import.meta.url);
    const { code, stdout, stderr } = await runChild(script, {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      AGENT_INTERCOM_ORCHESTRATOR_DISABLED: "",
      AGENT_INTERCOM_DISABLE_CLEANUP_TIMER: "1",
    });
    assert.equal(code, 0, stderr);
    const response = JSON.parse(stdout);
    assert.equal(response.ok, true);
    assert.match(response.result.content[0].text, /No owned workers have expired/);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

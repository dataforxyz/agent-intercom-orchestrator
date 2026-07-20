import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
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
    assert.equal(code, 0, `${stderr}\n${stdout}`);
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
    assert.equal(code, 0, `${stderr}\n${stdout}`);
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
    assert.equal(code, 0, `${stderr}\n${stdout}`);
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
    assert.equal(code, 0, `${stderr}\n${stdout}`);
    const response = JSON.parse(stdout);
    assert.equal(response.ok, true);
    assert.match(response.result.content[0].text, /No worker cleanup actions are currently eligible/);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("managerless cleanup preview is global and reports stop, cache, full, orphan, and bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-intercom-fleet-global-cleanup-"));
  const agentDir = join(root, "agent");
  const bin = join(root, "bin");
  const orchestratorDir = join(agentDir, "intercom", "orchestrator");
  const runtimeDir = join(orchestratorDir, "worker-runtime");
  try {
    await mkdir(bin, { recursive: true });
    await mkdir(runtimeDir, { recursive: true });
    const systemctl = join(bin, "systemctl");
    const cgls = join(bin, "systemd-cgls");
    await writeFile(systemctl, `#!/bin/sh
case "$*" in
  *list-units*) exit 0 ;;
  *live.service*) printf 'LoadState=loaded\\nActiveState=active\\nSubState=running\\nMainPID=4242\\nResult=success\\nExecMainStatus=0\\n'; exit 0 ;;
  *) printf 'LoadState=not-found\\nActiveState=inactive\\nSubState=dead\\nMainPID=0\\n'; exit 1 ;;
esac
`);
    await writeFile(cgls, "#!/bin/sh\nprintf 'Unit not found\\n' >&2\nexit 1\n");
    await chmod(systemctl, 0o755);
    await chmod(cgls, 0o755);
    const now = Date.now();
    const liveAt = now - 2 * 60 * 60_000;
    const cacheAt = now - 2 * 60 * 60_000;
    const fullAt = now - 8 * 24 * 60 * 60_000;
    await writeFile(join(orchestratorDir, "workers.json"), JSON.stringify({ version: 1, workers: [
      {
        id: "live-worker", runId: "live-run", harness: "pi", backend: "systemd", role: "advisor", task: "live", cwd: "/tmp",
        state: "running", owned: true, managerSessionId: "some-other-manager", unit: "live.service",
        createdAt: liveAt, updatedAt: liveAt, leaseExpiresAt: liveAt, lastWorkerActivityAt: liveAt,
        idleDeadlineAt: liveAt + 60 * 60_000, checkpointDeadlineAt: liveAt + 75 * 60_000,
      },
      {
        id: "cache-worker", runId: "cache-run", harness: "codex", backend: "systemd", role: "builder", task: "cache", cwd: "/tmp",
        state: "stopped", owned: true, managerSessionId: "another-manager", unit: "cache.service",
        createdAt: cacheAt, updatedAt: cacheAt, stoppedAt: cacheAt, leaseExpiresAt: cacheAt,
      },
      {
        id: "full-worker", runId: "full-run", harness: "claude", backend: "systemd", role: "builder", task: "full", cwd: "/tmp",
        state: "stopped", owned: true, managerSessionId: "third-manager", unit: "full.service",
        createdAt: fullAt, updatedAt: fullAt, stoppedAt: fullAt, leaseExpiresAt: fullAt,
      },
    ] }));
    const cachePath = join(runtimeDir, "cache-worker", "home", ".cache");
    const fullPath = join(runtimeDir, "full-worker");
    const orphanPath = join(runtimeDir, "orphan-worker");
    await mkdir(cachePath, { recursive: true });
    await mkdir(fullPath, { recursive: true });
    await mkdir(orphanPath, { recursive: true });
    await writeFile(join(cachePath, "cache.bin"), "123456789");
    await writeFile(join(fullPath, "state.bin"), "12345");
    await writeFile(join(orphanPath, "cache.bin"), "1234567");
    const orphanTime = new Date(now - 2 * 60 * 60_000);
    await utimes(join(orphanPath, "cache.bin"), orphanTime, orphanTime);
    await utimes(orphanPath, orphanTime, orphanTime);
    const script = new URL("../src/agent-fleet-cli.mjs", import.meta.url);
    const { code, stdout, stderr } = await runChild(script, {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      PI_CODING_AGENT_DIR: agentDir,
      AGENT_INTERCOM_ORCHESTRATOR_DISABLED: "",
      AGENT_INTERCOM_DISABLE_CLEANUP_TIMER: "1",
    }, JSON.stringify({ managerSessionId: "timer-manager", cwd: root, params: { action: "cleanup" } }));
    assert.equal(code, 0, `${stderr}\n${stdout}`);
    const response = JSON.parse(stdout);
    assert.equal(response.ok, true);
    assert.equal(response.result.details.scope, "global");
    assert.deepEqual(response.result.details.actions.map((action: { action: string }) => action.action).sort(), ["cache", "full", "orphan", "stop"]);
    assert.ok(response.result.details.estimatedBytes >= 21);
    assert.match(response.result.content[0].text, /\[stop\] live-worker/);
    assert.match(response.result.content[0].text, /\[cache\] cache-worker/);
    assert.match(response.result.content[0].text, /\[full\] full-worker/);
    assert.match(response.result.content[0].text, /\[orphan\] orphan-worker/);
    assert.match(response.result.content[0].text, /Total estimated bytes:/);
    const executedResult = await runChild(script, {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      PI_CODING_AGENT_DIR: agentDir,
      AGENT_INTERCOM_ORCHESTRATOR_DISABLED: "",
      AGENT_INTERCOM_DISABLE_CLEANUP_TIMER: "1",
    }, JSON.stringify({ managerSessionId: "timer-manager", cwd: root, params: { action: "cleanup", execute: true } }));
    assert.equal(executedResult.code, 0, `${executedResult.stderr}\n${executedResult.stdout}`);
    const executed = JSON.parse(executedResult.stdout);
    assert.equal(executed.ok, true);
    assert.deepEqual(executed.result.details.executed.map((action: { action: string }) => action.action).sort(), ["cache", "full", "orphan", "stop"]);
    assert.ok(executed.result.details.estimatedBytes >= 21);
    const state = JSON.parse(await readFile(join(orchestratorDir, "workers.json"), "utf8"));
    assert.equal(state.workers.find((worker: { id: string }) => worker.id === "live-worker")?.state, "stopped");
    assert.equal(state.workers.some((worker: { id: string }) => worker.id === "cache-worker"), true);
    assert.equal(state.workers.some((worker: { id: string }) => worker.id === "full-worker"), false);
    await assert.rejects(readFile(cachePath), /ENOENT/);
    await assert.rejects(readFile(orphanPath), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireKernelFileLock } from "../src/file-lock.ts";

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
    const orchestratorDir = join(agentDir, "intercom", "orchestrator");
    await mkdir(orchestratorDir, { recursive: true });
    await writeFile(join(orchestratorDir, "config.json"), JSON.stringify({
      profiles: {
        "pi-peer": { harness: "pi", command: process.execPath, mode: "persistent" },
        "codex-safe": { harness: "codex", command: process.execPath, mode: "persistent" },
        "claude-safe": { harness: "claude", command: process.execPath, mode: "persistent" },
        "opencode-peer": { harness: "opencode", command: process.execPath, mode: "persistent" },
      },
      routing: {
        explicitOnly: [],
        roleRequirements: { builder: { requiresSubagents: true } },
        modelRouting: { unmatchedHarness: "opencode" },
      },
    }));
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

    const route = await runChild(cli, {
      ...process.env, PI_CODING_AGENT_DIR: agentDir, AGENT_INTERCOM_ORCHESTRATOR_DISABLED: "",
    }, JSON.stringify({
      managerSessionId: "opencode-manager-test",
      cwd: process.cwd(),
      params: { action: "route", role: "builder" },
    }));
    assert.equal(route.code, 0, route.stderr);
    const routeResponse = JSON.parse(route.stdout);
    assert.equal(routeResponse.ok, true);
    assert.equal(routeResponse.result.details.routing.selected, "codex");
    assert.equal(routeResponse.result.details.routing.requiresSubagents, true);
    assert.match(routeResponse.result.content[0].text, /Preview only; no coworker was spawned/);

    const unmatched = await runChild(cli, {
      ...process.env, PI_CODING_AGENT_DIR: agentDir, AGENT_INTERCOM_ORCHESTRATOR_DISABLED: "",
    }, JSON.stringify({
      managerSessionId: "opencode-manager-test",
      cwd: process.cwd(),
      params: { action: "route", model: "custom-provider/custom-model" },
    }));
    assert.equal(unmatched.code, 0, unmatched.stderr);
    const unmatchedResponse = JSON.parse(unmatched.stdout);
    assert.equal(unmatchedResponse.result.details.routing.selected, "opencode");
    assert.equal(unmatchedResponse.result.details.routing.explicitSource, "model");
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("OpenCode manager CLI keeps persistent Pi process-stable instead of timing out without a control bridge", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "agent-intercom-fleet-cli-pi-spawn-"));
  try {
    const orchestratorDir = join(agentDir, "intercom", "orchestrator");
    const binDir = join(agentDir, "bin");
    await mkdir(orchestratorDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(join(orchestratorDir, "config.json"), JSON.stringify({
      profiles: { "pi-peer": { harness: "pi", command: process.execPath, mode: "persistent" } },
      cleanupExpiredOnStart: false,
    }));
    await writeFile(join(binDir, "systemd-run"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(join(binDir, "systemctl"), `#!/bin/sh
case "$*" in
  *list-jobs*) exit 0 ;;
  *show*) cat <<'EOF'
LoadState=loaded
ActiveState=active
SubState=running
MainPID=4242
ExecMainStatus=0
ExecMainCode=0
ActiveEnterTimestampMonotonic=123
InactiveEnterTimestampMonotonic=0
Result=success
Job=
ControlGroup=/test
EOF
    exit 0 ;;
  *) exit 0 ;;
esac
`, { mode: 0o755 });
    const cli = new URL("../src/agent-fleet-cli.mjs", import.meta.url);
    const result = await runChild(cli, {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      PI_CODING_AGENT_DIR: agentDir,
      AGENT_INTERCOM_ORCHESTRATOR_DISABLED: "",
      AGENT_INTERCOM_DISABLE_CLEANUP_TIMER: "1",
      OPENCODE_INTERCOM_FLEET: "1",
    }, JSON.stringify({
      managerSessionId: "opencode-manager-test",
      cwd: process.cwd(),
      params: {
        action: "spawn",
        id: "cli-pi-worker",
        harness: "pi",
        profile: "pi-peer",
        permissionProfile: "trusted",
        role: "advisor",
        task: "review",
      },
    }));
    assert.equal(result.code, 0, result.stderr);
    const response = JSON.parse(result.stdout);
    assert.equal(response.ok, true);
    assert.equal(response.result.details.worker.state, "registering");
    assert.equal(response.result.details.worker.backendDetails.readiness, "process-stable-unverified");
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
      OPENCODE_INTERCOM_FLEET: "1",
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
    assert.equal(state.workers[0].state, "registering");
    assert.equal(state.workers[0].managerOwner.context, "opencode");
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
      OPENCODE_INTERCOM_FLEET: "1",
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

test("explicit cleanup bypasses startup cleanup and runs one cleanup pass", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "agent-intercom-fleet-single-cleanup-cli-"));
  try {
    const orchestratorDir = join(agentDir, "intercom", "orchestrator");
    const binDir = join(agentDir, "bin");
    const callsPath = join(agentDir, "systemctl.calls");
    await mkdir(orchestratorDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(join(orchestratorDir, "config.json"), JSON.stringify({ cleanupExpiredOnStart: true }));
    await writeFile(join(binDir, "systemctl"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(callsPath)}\nexit 0\n`, { mode: 0o755 });
    const cli = new URL("../src/agent-fleet-cli.mjs", import.meta.url);
    const result = await runChild(cli, {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      PI_CODING_AGENT_DIR: agentDir,
      AGENT_INTERCOM_ORCHESTRATOR_DISABLED: "",
      AGENT_INTERCOM_DISABLE_CLEANUP_TIMER: "1",
    }, JSON.stringify({
      managerSessionId: "cleanup-single-pass-test",
      cwd: process.cwd(),
      params: { action: "cleanup", execute: true },
    }));
    assert.equal(result.code, 0, result.stderr);
    const calls = await readFile(callsPath, "utf8");
    assert.ok(calls.split("\n").filter((line) => line.includes("list-units")).length >= 1);
    const cleanupState = JSON.parse(await readFile(join(orchestratorDir, "cleanup-run.json"), "utf8"));
    assert.equal(cleanupState.outcome, "ok");
    assert.equal(cleanupState.errors, 0);
    assert.equal(cleanupState.deferred, 0);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("managerless cleanup skips while another cleanup run holds the crash-released lock", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "agent-intercom-fleet-coalesced-cleanup-cli-"));
  let release: (() => Promise<void>) | undefined;
  try {
    const orchestratorDir = join(agentDir, "intercom", "orchestrator");
    const binDir = join(agentDir, "bin");
    await mkdir(orchestratorDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(join(orchestratorDir, "config.json"), JSON.stringify({ cleanupExpiredOnStart: true }));
    await writeFile(join(binDir, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    release = await acquireKernelFileLock(join(orchestratorDir, "cleanup-run.lock"), 1_000);
    const script = new URL("../src/agent-fleet-cleanup.mjs", import.meta.url);
    const { code, stdout, stderr } = await runChild(script, {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      PI_CODING_AGENT_DIR: agentDir,
      AGENT_INTERCOM_ORCHESTRATOR_DISABLED: "",
      AGENT_INTERCOM_DISABLE_CLEANUP_TIMER: "1",
    });
    assert.equal(code, 0, stderr);
    const response = JSON.parse(stdout);
    assert.equal(response.ok, true);
    assert.equal(response.result.details.skipped, "in_progress");
    assert.match(response.result.content[0].text, /another cleanup run is in progress/);
  } finally {
    await release?.();
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("managerless cleanup wrapper executes exact fleet cleanup against the configured state", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "agent-intercom-fleet-cleanup-cli-"));
  try {
    const binDir = join(agentDir, "bin");
    await mkdir(binDir, { recursive: true });
    await writeFile(join(binDir, "systemctl"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const script = new URL("../src/agent-fleet-cleanup.mjs", import.meta.url);
    const { code, stdout, stderr } = await runChild(script, {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      PI_CODING_AGENT_DIR: agentDir,
      AGENT_INTERCOM_ORCHESTRATOR_DISABLED: "",
      AGENT_INTERCOM_DISABLE_CLEANUP_TIMER: "1",
    });
    assert.equal(code, 0, stderr);
    const response = JSON.parse(stdout);
    assert.equal(response.ok, true);
    assert.match(response.result.content[0].text, /No live workers need stopping, no terminal worker retention has expired, no disposable runtime caches remain, and no orphan runtimes exist/);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

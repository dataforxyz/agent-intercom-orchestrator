import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function commandResult() {
  return { stdout: "", stderr: "", code: 0, killed: false };
}

test("reconciliation retires completed one-shot units after preserving their completed state", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "agent-intercom-orchestrator-retire-test-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const statePath = join(agentDir, "intercom", "orchestrator", "workers.json");
    await mkdir(join(agentDir, "intercom", "orchestrator"), { recursive: true });
    await writeFile(statePath, JSON.stringify({ version: 1, workers: [{
      id: "completed-run", runId: "run-1", harness: "opencode", role: "builder", task: "finish", cwd: "/tmp",
      profile: "opencode-run", state: "running", unit: "agent-intercom-worker-completed-run.service", owned: true,
      managerSessionId: "old-manager", createdAt: 1, updatedAt: 1, leaseExpiresAt: Date.now() + 60_000,
    }] }));
    const lifecycle = new Map<string, (...args: any[]) => any>();
    const tools = new Map<string, any>();
    let stopped = false;
    const pi: any = {
      on(name: string, handler: (...args: any[]) => any) { lifecycle.set(name, handler); },
      events: { on() { return () => {}; }, emit() {} },
      registerTool(tool: any) { tools.set(tool.name, tool); },
      registerCommand() {},
      async exec(command: string, args: string[]) {
        if (command === "systemctl" && args[1] === "show") {
          return stopped ? { ...commandResult(), code: 1 } : {
            ...commandResult(),
            stdout: "LoadState=loaded\nActiveState=active\nSubState=exited\nMainPID=0\nResult=success\nExecMainStatus=0\n",
          };
        }
        if (command === "systemctl" && args[1] === "stop") stopped = true;
        return commandResult();
      },
    };
    const ctx: any = {
      cwd: "/tmp", mode: "rpc", hasUI: false,
      sessionManager: { getSessionId: () => "new-manager", getSessionFile: () => undefined },
      ui: { setStatus() {}, notify() {} },
    };
    const extensionUrl = new URL(`../src/index.ts?retire=${Date.now()}`, import.meta.url);
    const { default: extension } = await import(extensionUrl.href);
    extension(pi);
    await lifecycle.get("session_start")?.({}, ctx);
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(saved.workers[0].state, "stopped");
    assert.equal(saved.workers[0].terminalOutcome, "completed");
    assert.equal(stopped, true);
    await lifecycle.get("session_shutdown")?.({ reason: "reload" }, ctx);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("reconciliation observes only live worker units and skips retained terminal history", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "agent-intercom-orchestrator-live-reconcile-test-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousSkipStartupCleanup = process.env.AGENT_INTERCOM_SKIP_STARTUP_CLEANUP;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.AGENT_INTERCOM_SKIP_STARTUP_CLEANUP = "1";
  try {
    const orchestratorDir = join(agentDir, "intercom", "orchestrator");
    const statePath = join(orchestratorDir, "workers.json");
    await mkdir(orchestratorDir, { recursive: true });
    const worker = (id: string, state: "running" | "stopped" | "failed" | "lost" | "completed") => ({
      id,
      runId: `run-${id}`,
      harness: "pi",
      role: "reviewer",
      task: "review",
      cwd: "/tmp",
      state,
      unit: `agent-intercom-worker-${id}.service`,
      owned: true,
      managerSessionId: "manager-a",
      createdAt: 1,
      updatedAt: 1,
      leaseExpiresAt: Date.now() + 60_000,
      ...(state === "completed" ? { stoppedAt: 2, stopReason: "one-shot-complete" } : {}),
    });
    await writeFile(statePath, JSON.stringify({
      version: 1,
      workers: [
        worker("live", "running"),
        worker("stopped", "stopped"),
        worker("failed", "failed"),
        worker("lost", "lost"),
        worker("completed", "completed"),
      ],
    }));

    const lifecycle = new Map<string, (...args: any[]) => any>();
    const observedUnits: string[] = [];
    const pi: any = {
      on(name: string, handler: (...args: any[]) => any) { lifecycle.set(name, handler); },
      events: { on() { return () => {}; }, emit() {} },
      registerTool() {},
      registerCommand() {},
      async exec(command: string, args: string[]) {
        if (command === "systemctl" && args[1] === "show") {
          observedUnits.push(args[2]);
          return {
            ...commandResult(),
            stdout: "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=123\nResult=success\nExecMainStatus=0\n",
          };
        }
        return commandResult();
      },
    };
    const ctx: any = {
      cwd: "/tmp",
      mode: "rpc",
      hasUI: false,
      sessionManager: { getSessionId: () => "manager-a", getSessionFile: () => undefined },
      ui: { setStatus() {}, notify() {} },
    };
    const extensionUrl = new URL(`../src/index.ts?live-reconcile=${Date.now()}`, import.meta.url);
    const { default: extension } = await import(extensionUrl.href);
    extension(pi);
    await lifecycle.get("session_start")?.({}, ctx);

    assert.deepEqual(observedUnits, ["agent-intercom-worker-live.service"]);
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(saved.workers.find((candidate: any) => candidate.id === "live").state, "registering");
    assert.equal(saved.workers.find((candidate: any) => candidate.id === "stopped").state, "stopped");
    assert.equal(saved.workers.find((candidate: any) => candidate.id === "failed").state, "failed");
    assert.equal(saved.workers.find((candidate: any) => candidate.id === "lost").state, "lost");
    assert.equal(saved.workers.find((candidate: any) => candidate.id === "completed").state, "stopped");
    assert.equal(saved.workers.find((candidate: any) => candidate.id === "completed").terminalOutcome, "completed");
    await lifecycle.get("session_shutdown")?.({ reason: "reload" }, ctx);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousSkipStartupCleanup === undefined) delete process.env.AGENT_INTERCOM_SKIP_STARTUP_CLEANUP;
    else process.env.AGENT_INTERCOM_SKIP_STARTUP_CLEANUP = previousSkipStartupCleanup;
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("stop patches the current worker record without clobbering concurrent metadata", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "agent-intercom-orchestrator-stop-patch-test-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const orchestratorDir = join(agentDir, "intercom", "orchestrator");
    await mkdir(orchestratorDir, { recursive: true });
    const statePath = join(orchestratorDir, "workers.json");
    await writeFile(statePath, JSON.stringify({ version: 1, workers: [{
      id: "patch-worker", runId: "run-patch", harness: "codex", role: "builder", task: "work", cwd: "/tmp",
      state: "running", unit: "agent-intercom-worker-patch-worker.service", owned: true, managerSessionId: "patch-manager",
      createdAt: 1, updatedAt: 1, leaseExpiresAt: Date.now() + 60_000,
    }] }));

    const lifecycle = new Map<string, (...args: any[]) => any>();
    const tools = new Map<string, any>();
    let releaseStop!: () => void;
    const stopBlocked = new Promise<void>((resolve) => { releaseStop = resolve; });
    let stopStarted!: () => void;
    const stopEntered = new Promise<void>((resolve) => { stopStarted = resolve; });
    const pi: any = {
      on(name: string, handler: (...args: any[]) => any) { lifecycle.set(name, handler); },
      events: { on() { return () => {}; }, emit() {} },
      registerTool(tool: any) { tools.set(tool.name, tool); },
      registerCommand() {},
      async exec(command: string, args: string[]) {
        if (command.endsWith("/git") && args.includes("status")) {
          return { ...commandResult(), stdout: " M file.ts\n" };
        }
        if (command === "systemctl" && args[1] === "stop") {
          stopStarted();
          await stopBlocked;
        }
        return commandResult();
      },
    };
    const ctx: any = {
      cwd: "/tmp", mode: "rpc", hasUI: false,
      sessionManager: { getSessionId: () => "patch-manager", getSessionFile: () => undefined },
      ui: { setStatus() {}, notify() {} },
    };
    const extensionUrl = new URL(`../src/index.ts?stop-patch=${Date.now()}`, import.meta.url);
    const { default: extension } = await import(extensionUrl.href);
    extension(pi);
    await lifecycle.get("session_start")?.({}, ctx);

    const stopping = tools.get("agent_fleet").execute("stop-patch", { action: "stop", id: "patch-worker" }, new AbortController().signal, () => {}, ctx);
    await stopEntered;
    const concurrent = JSON.parse(await readFile(statePath, "utf8"));
    concurrent.workers[0].backendDetails = { marker: "preserve-me" };
    await writeFile(statePath, JSON.stringify(concurrent));
    releaseStop();
    await stopping;

    const saved = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(saved.workers[0].state, "stopped");
    assert.equal(saved.workers[0].stopReason, "manager-requested");
    assert.equal(saved.workers[0].dirtyAtStop, true);
    assert.equal(saved.workers[0].dirtyStatusAtStop, "M file.ts");
    assert.equal(saved.workers[0].backendDetails.marker, "preserve-me");
    await lifecycle.get("session_shutdown")?.({ reason: "reload" }, ctx);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("manager-received worker Intercom metadata renews only the matching owned worker", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "agent-intercom-orchestrator-activity-test-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const orchestratorDir = join(agentDir, "intercom", "orchestrator");
    await mkdir(orchestratorDir, { recursive: true });
    const before = Date.now() - 30 * 60_000;
    await writeFile(join(orchestratorDir, "workers.json"), JSON.stringify({ version: 1, workers: [{
      id: "activity-worker", runId: "run-activity", harness: "pi", role: "advisor", task: "review", cwd: "/tmp",
      state: "running", unit: "agent-intercom-worker-activity-worker.service", owned: true, managerSessionId: "manager-a",
      intercomTarget: "activity-worker", createdAt: before, updatedAt: before, lastWorkerActivityAt: before,
      idleDeadlineAt: before + 60 * 60_000, checkpointDeadlineAt: before + 75 * 60_000, leaseExpiresAt: before + 30 * 60_000,
    }] }));
    const lifecycle = new Map<string, (...args: any[]) => any>();
    const tools = new Map<string, any>();
    const bus = new Map<string, (payload: unknown) => void>();
    const pi: any = {
      on(name: string, handler: (...args: any[]) => any) { lifecycle.set(name, handler); },
      events: {
        on(name: string, handler: (payload: unknown) => void) { bus.set(name, handler); return () => bus.delete(name); },
        emit(name: string, payload: unknown) { bus.get(name)?.(payload); },
      },
      registerTool(tool: any) { tools.set(tool.name, tool); },
      registerCommand() {},
      async exec(command: string, args: string[]) {
        if (command === "systemctl" && args.includes("show")) {
          return { ...commandResult(), stdout: "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=123\nResult=success\nExecMainStatus=0\n" };
        }
        return commandResult();
      },
    };
    const ctx: any = {
      cwd: "/tmp", mode: "rpc", hasUI: false,
      sessionManager: { getSessionId: () => "manager-a", getSessionFile: () => undefined },
      ui: { setStatus() {}, notify() {} },
    };
    const extensionUrl = new URL(`../src/index.ts?activity=${Date.now()}`, import.meta.url);
    const { default: extension } = await import(extensionUrl.href);
    extension(pi);
    await lifecycle.get("session_start")?.({}, ctx);
    pi.events.emit("agent-intercom:inbound-message", { from: { id: "activity-worker", name: "activity-worker" }, message: { id: "progress-1" } });
    let saved: any;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      saved = JSON.parse(await readFile(join(orchestratorDir, "workers.json"), "utf8"));
      if (saved.workers[0].lastWorkerActivityAt > before) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(saved.workers[0].lastWorkerActivityAt > before);
    assert.equal(saved.workers[0].checkpointRequestedAt, undefined);
    assert.ok(saved.workers[0].leaseExpiresAt > before + 30 * 60_000);
    await lifecycle.get("session_shutdown")?.({ reason: "reload" }, ctx);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("concurrent spawns reserve a worker id before launching a systemd unit", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "agent-intercom-orchestrator-spawn-reservation-test-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const orchestratorDir = join(agentDir, "intercom", "orchestrator");
    await mkdir(orchestratorDir, { recursive: true });
    const executable = join(agentDir, "fake-pi");
    const intercomExtension = join(agentDir, "git", "github.com", "dataforxyz", "agent-intercom-pi", "index.ts");
    await mkdir(join(agentDir, "git", "github.com", "dataforxyz", "agent-intercom-pi"), { recursive: true });
    await writeFile(intercomExtension, "export default function () {}\n");
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o755);
    await writeFile(join(orchestratorDir, "config.json"), JSON.stringify({
      profiles: {
        "pi-peer": { harness: "pi", command: executable, args: [], mode: "persistent", maxRuntime: "12h" },
      },
    }));

    const lifecycle = new Map<string, (...args: any[]) => any>();
    const tools = new Map<string, any>();
    let launches = 0;
    const pi: any = {
      on(name: string, handler: (...args: any[]) => any) { lifecycle.set(name, handler); },
      events: { on() { return () => {}; }, emit() {} },
      registerTool(tool: any) { tools.set(tool.name, tool); },
      registerCommand() {},
      async exec(command: string, args: string[]) {
        if (command === "systemd-run") {
          launches += 1;
          await new Promise((resolve) => setTimeout(resolve, 30));
          return commandResult();
        }
        if (command === "systemctl" && args.includes("show") && args.includes("--property=LoadState,ActiveState,SubState,MainPID,Result,ExecMainStatus")) {
          return { ...commandResult(), stdout: "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=123\nResult=success\nExecMainStatus=0\n" };
        }
        return commandResult();
      },
    };
    const ctx: any = {
      cwd: "/tmp", mode: "rpc", hasUI: false,
      sessionManager: { getSessionId: () => "spawn-manager", getSessionFile: () => undefined },
      ui: { setStatus() {}, notify() {} },
    };
    const extensionUrl = new URL(`../src/index.ts?spawn-reservation=${Date.now()}`, import.meta.url);
    const { default: extension } = await import(extensionUrl.href);
    extension(pi);
    await lifecycle.get("session_start")?.({}, ctx);

    const fleet = tools.get("agent_fleet");
    const calls = await Promise.allSettled([
      fleet.execute("spawn-a", { action: "spawn", harness: "pi", profile: "pi-peer", id: "same-worker", cwd: "/tmp", task: "work" }, new AbortController().signal, () => {}, ctx),
      fleet.execute("spawn-b", { action: "spawn", harness: "pi", profile: "pi-peer", id: "same-worker", cwd: "/tmp", task: "work" }, new AbortController().signal, () => {}, ctx),
    ]);
    assert.equal(calls.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(calls.filter((result) => result.status === "rejected").length, 1);
    assert.equal(launches, 1);
    const state = JSON.parse(await readFile(join(orchestratorDir, "workers.json"), "utf8"));
    assert.equal(state.workers.filter((worker: any) => worker.id === "same-worker").length, 1);

    await lifecycle.get("session_shutdown")?.({ reason: "reload" }, ctx);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("persistent OpenCode spawn persists resumable state before returning ready", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "agent-intercom-orchestrator-opencode-state-test-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const orchestratorDir = join(agentDir, "intercom", "orchestrator");
    await mkdir(orchestratorDir, { recursive: true });
    const executable = join(agentDir, "fake-opencode");
    await writeFile(executable, "#!/bin/sh\nexit 0\n");
    await chmod(executable, 0o755);
    await writeFile(join(orchestratorDir, "config.json"), JSON.stringify({
      profiles: {
        "opencode-peer": { harness: "opencode", command: executable, args: [], mode: "persistent", maxRuntime: "12h" },
      },
    }));

    const lifecycle = new Map<string, (...args: any[]) => any>();
    const tools = new Map<string, any>();
    let systemdArgs: string[] = [];
    const pi: any = {
      on(name: string, handler: (...args: any[]) => any) { lifecycle.set(name, handler); },
      events: { on() { return () => {}; }, emit() {} },
      registerTool(tool: any) { tools.set(tool.name, tool); },
      registerCommand() {},
      async exec(command: string, args: string[]) {
        if (command === "systemd-run") {
          systemdArgs = [...args];
          const environment = Object.fromEntries(args
            .filter((arg) => arg.startsWith("--setenv="))
            .map((arg) => {
              const value = arg.slice("--setenv=".length);
              const separator = value.indexOf("=");
              return [value.slice(0, separator), value.slice(separator + 1)];
            }));
          await mkdir(join(orchestratorDir, "opencode-peers"), { recursive: true });
          const bind = args.find((arg) => arg.startsWith("--property=BindPaths="))?.slice("--property=BindPaths=".length);
          const [bindSource, bindTarget] = bind?.split(":") ?? [];
          const healthPath = bindSource && bindTarget && environment.AGENT_INTERCOM_OPENCODE_HEALTH_PATH.startsWith(bindTarget)
            ? `${bindSource}${environment.AGENT_INTERCOM_OPENCODE_HEALTH_PATH.slice(bindTarget.length)}`
            : environment.AGENT_INTERCOM_OPENCODE_HEALTH_PATH;
          await writeFile(healthPath, JSON.stringify({
            version: 1,
            runId: environment.AGENT_INTERCOM_RUN_ID,
            ready: true,
            connected: true,
            openCodeSessionId: "ses_immediate_state",
            status: "idle",
          }));
          return commandResult();
        }
        if (command === "systemctl" && args.includes("show") && args.includes("--property=LoadState,ActiveState,SubState,MainPID,Result,ExecMainStatus")) {
          return { ...commandResult(), stdout: "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=123\nResult=success\nExecMainStatus=0\n" };
        }
        return commandResult();
      },
    };
    const ctx: any = {
      cwd: "/tmp", mode: "rpc", hasUI: false,
      sessionManager: { getSessionId: () => "opencode-state-manager", getSessionFile: () => undefined },
      ui: { setStatus() {}, notify() {} },
    };
    const extensionUrl = new URL(`../src/index.ts?opencode-state=${Date.now()}`, import.meta.url);
    const { default: extension } = await import(extensionUrl.href);
    extension(pi);
    await lifecycle.get("session_start")?.({}, ctx);

    const result = await tools.get("agent_fleet").execute(
      "spawn-opencode-state",
      { action: "spawn", harness: "opencode", profile: "opencode-peer", id: "state-race", cwd: "/tmp", task: "wait" },
      new AbortController().signal,
      () => {},
      ctx,
    );
    assert.match(result.content[0].text, /session=ses_immediate_state/);
    assert.match(result.content[0].text, /permission=builder-restricted/);
    assert.ok(systemdArgs.includes("--property=PrivateUsers=self"));
    assert.ok(systemdArgs.some((arg) => arg.startsWith("--property=TemporaryFileSystem=/run/user/") && arg.endsWith(":rw")));
    assert.ok(systemdArgs.some((arg) => arg.startsWith("--property=InaccessiblePaths=") && arg.includes("worker-runtime")));
    assert.ok(systemdArgs.some((arg) => arg.startsWith("--property=InaccessiblePaths=") && arg.includes("/hypr")));
    assert.ok(systemdArgs.some((arg) => arg.startsWith("--property=BindPaths=") && arg.includes("agent-intercom-worker")));
    assert.ok(systemdArgs.includes('--property=ReadOnlyPaths="-/tmp/.git"'));
    assert.ok(systemdArgs.includes("--setenv=GIT_TERMINAL_PROMPT=0"));
    assert.ok(systemdArgs.includes("--setenv=HYPRLAND_INSTANCE_SIGNATURE="));
    assert.ok(systemdArgs.includes("--setenv=ALACRITTY_SOCKET="));
    assert.ok(systemdArgs.includes("--setenv=WAYLAND_DISPLAY="));
    assert.ok(systemdArgs.some((arg) => arg.startsWith("--setenv=XDG_RUNTIME_DIR=") && arg.includes("agent-intercom-worker")));
    assert.ok(systemdArgs.some((arg) => arg.startsWith("--setenv=PATH=") && arg.includes("guard-bin")));
    assert.ok(systemdArgs.some((arg) => arg.startsWith("--setenv=AGENT_INTERCOM_REAL_GIT=")));
    assert.ok(systemdArgs.some((arg) => arg.startsWith("--setenv=AGENT_INTERCOM_REAL_GH=")));
    assert.ok(systemdArgs.some((arg) => arg.startsWith("--setenv=AGENT_INTERCOM_REAL_NPM=")));
    if (spawnSync("sh", ["-c", "command -v tea >/dev/null"]).status === 0) {
      assert.ok(systemdArgs.some((arg) => arg.startsWith("--setenv=AGENT_INTERCOM_REAL_TEA=")));
    }
    if (spawnSync("sh", ["-c", "command -v glab >/dev/null"]).status === 0) {
      assert.ok(systemdArgs.some((arg) => arg.startsWith("--setenv=AGENT_INTERCOM_REAL_GLAB=")));
    }
    if (spawnSync("sh", ["-c", "command -v gcloud >/dev/null"]).status === 0) {
      assert.ok(systemdArgs.some((arg) => arg.startsWith("--setenv=AGENT_INTERCOM_REAL_GCLOUD=")));
    }
    assert.ok(systemdArgs.some((arg) => arg.includes("clean-env-launcher.mjs")));
    const state = JSON.parse(await readFile(join(orchestratorDir, "worker-runtime", "state-race", "state-race.state.json"), "utf8"));
    assert.equal(state.workerId, "state-race");
    assert.equal(state.sessionId, "ses_immediate_state");
    assert.equal(state.directory, "/tmp");

    await lifecycle.get("session_shutdown")?.({ reason: "reload" }, ctx);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("agent_fleet list and unqualified status default to the current manager's workers", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "agent-intercom-orchestrator-manager-list-test-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const orchestratorDir = join(agentDir, "intercom", "orchestrator");
    await mkdir(orchestratorDir, { recursive: true });
    const worker = (id: string, owner: string) => ({
      id,
      runId: `run-${id}`,
      harness: "pi",
      role: "advisor",
      task: `Task for ${id}`,
      cwd: "/tmp",
      state: "stopped",
      owned: true,
      managerSessionId: owner,
      intercomTarget: `${id}-target`,
      createdAt: 1,
      updatedAt: Date.now(),
      stoppedAt: Date.now(),
      leaseExpiresAt: Date.now() + 60_000,
    });
    const oldStoppedAt = Date.now() - 7 * 60 * 60_000;
    const oldMine = { ...worker("old-mine", "manager-a"), updatedAt: oldStoppedAt, stoppedAt: oldStoppedAt };
    await writeFile(join(orchestratorDir, "workers.json"), JSON.stringify({
      version: 1,
      workers: [worker("mine", "manager-a"), worker("theirs", "manager-b"), oldMine],
    }));

    const lifecycle = new Map<string, (...args: any[]) => any>();
    const tools = new Map<string, any>();
    const pi: any = {
      on(name: string, handler: (...args: any[]) => any) { lifecycle.set(name, handler); },
      events: { on() { return () => {}; }, emit() {} },
      registerTool(tool: any) { tools.set(tool.name, tool); },
      registerCommand() {},
      async exec() { return commandResult(); },
    };
    const ctx: any = {
      cwd: "/tmp",
      mode: "rpc",
      hasUI: false,
      sessionManager: { getSessionId: () => "manager-a", getSessionFile: () => undefined },
      ui: { setStatus() {}, notify() {} },
    };
    const extensionUrl = new URL(`../src/index.ts?manager-list=${Date.now()}`, import.meta.url);
    const { default: extension } = await import(extensionUrl.href);
    extension(pi);
    await lifecycle.get("session_start")?.({}, ctx);

    const fleet = tools.get("agent_fleet");
    assert.ok(fleet.parameters.properties.all, "agent_fleet should expose explicit cross-manager listing");

    const ownList = await fleet.execute("list-own", { action: "list" }, new AbortController().signal, () => {}, ctx);
    assert.deepEqual(ownList.details.workers.map((record: any) => record.id), ["mine"]);
    assert.match(ownList.content[0].text, /target=mine-target/);
    assert.match(ownList.content[0].text, /1 older terminal worker is hidden/);
    assert.doesNotMatch(ownList.content[0].text, /theirs/);
    assert.doesNotMatch(ownList.content[0].text, /old-mine \[/);

    const ownHistory = await fleet.execute("history-own", { action: "history" }, new AbortController().signal, () => {}, ctx);
    assert.deepEqual(ownHistory.details.workers.map((record: any) => record.id), ["mine", "old-mine"]);

    const allList = await fleet.execute("list-all", { action: "list", all: true }, new AbortController().signal, () => {}, ctx);
    assert.deepEqual(allList.details.workers.map((record: any) => record.id), ["mine", "theirs", "old-mine"]);

    const ownStatus = await fleet.execute("status-own", { action: "status" }, new AbortController().signal, () => {}, ctx);
    assert.deepEqual(ownStatus.details.workers.map((record: any) => record.id), ["mine", "old-mine"]);
    await assert.rejects(
      fleet.execute("status-hidden", { action: "status", id: "theirs" }, new AbortController().signal, () => {}, ctx),
      /Unknown managed worker: theirs/,
    );

    const allStatus = await fleet.execute("status-all", { action: "status", all: true }, new AbortController().signal, () => {}, ctx);
    assert.deepEqual(allStatus.details.workers.map((record: any) => record.id), ["mine", "theirs", "old-mine"]);
    const otherStatus = await fleet.execute("status-other", { action: "status", id: "theirs", all: true }, new AbortController().signal, () => {}, ctx);
    assert.deepEqual(otherStatus.details.workers.map((record: any) => record.id), ["theirs"]);

    await lifecycle.get("session_shutdown")?.({ reason: "reload" }, ctx);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("cleanup prunes retention-expired terminal workers and preserves recent history", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "agent-intercom-orchestrator-retention-cleanup-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const orchestratorDir = join(agentDir, "intercom", "orchestrator");
    await mkdir(orchestratorDir, { recursive: true });
    await writeFile(join(orchestratorDir, "config.json"), JSON.stringify({
      cleanupExpiredOnStart: false,
      cleanupOnShutdown: false,
      stoppedWorkerRetentionDays: 1,
      dirtyStoppedWorkerRetentionDays: 3,
      pruneStoppedWorkersOnCleanup: true,
    }));
    const now = Date.now();
    const worker = (id: string, stoppedAt: number, dirtyAtStop = false) => ({
      id, runId: `run-${id}`, harness: "pi", role: "advisor", task: "review", cwd: "/tmp",
      state: "stopped", owned: true, managerSessionId: "manager-a", stopReason: "manager-requested",
      dirtyAtStop, stoppedAt, createdAt: stoppedAt, updatedAt: stoppedAt, leaseExpiresAt: stoppedAt,
    });
    await writeFile(join(orchestratorDir, "workers.json"), JSON.stringify({ version: 1, workers: [
      worker("expired-clean", now - 2 * 24 * 60 * 60_000),
      worker("retained-recent", now - 2 * 60 * 60_000),
      worker("retained-dirty", now - 2 * 24 * 60 * 60_000, true),
      worker("unsafe-cache", now - 2 * 60 * 60_000),
    ] }));
    for (const id of ["expired-clean", "retained-recent", "retained-dirty", "unsafe-cache"]) {
      const root = join(orchestratorDir, "worker-runtime", id);
      await mkdir(root, { recursive: true });
      await writeFile(join(root, "state"), "retained\n");
    }
    const retainedCache = join(orchestratorDir, "worker-runtime", "retained-recent", "home", ".cache", "npm", "_npx");
    await mkdir(retainedCache, { recursive: true });
    await writeFile(join(retainedCache, "downloaded-tool"), "cache\n");
    const externalHome = join(agentDir, "external-cache-home");
    await mkdir(join(externalHome, ".cache", "npm"), { recursive: true });
    await writeFile(join(externalHome, ".cache", "npm", "keep"), "outside\n");
    await symlink(externalHome, join(orchestratorDir, "worker-runtime", "unsafe-cache", "home"), "dir");
    const orphanRuntime = join(orchestratorDir, "worker-runtime", "orphaned-run");
    await mkdir(orphanRuntime, { recursive: true });
    await writeFile(join(orphanRuntime, "state"), "orphan\n");
    await utimes(orphanRuntime, new Date(now - 2 * 60 * 60_000), new Date(now - 2 * 60 * 60_000));

    const lifecycle = new Map<string, (...args: any[]) => any>();
    const tools = new Map<string, any>();
    const pi: any = {
      on(name: string, handler: (...args: any[]) => any) { lifecycle.set(name, handler); },
      events: { on() { return () => {}; }, emit() {} },
      registerTool(tool: any) { tools.set(tool.name, tool); },
      registerCommand() {},
      async exec() { return commandResult(); },
    };
    const ctx: any = {
      cwd: "/tmp", mode: "rpc", hasUI: false,
      sessionManager: { getSessionId: () => "manager-a", getSessionFile: () => undefined },
      ui: { setStatus() {}, notify() {} },
    };
    const extensionUrl = new URL(`../src/index.ts?retention-cleanup=${Date.now()}`, import.meta.url);
    const { default: extension } = await import(extensionUrl.href);
    extension(pi);
    await lifecycle.get("session_start")?.({}, ctx);
    const fleet = tools.get("agent_fleet");
    const preview = await fleet.execute("cleanup-preview", { action: "cleanup" }, new AbortController().signal, () => {}, ctx);
    assert.deepEqual(preview.details.candidates.map((candidate: any) => [candidate.kind === "orphan" ? candidate.workerId : candidate.worker.id, candidate.kind]), [
      ["expired-clean", "prune"],
      ["retained-recent", "cache"],
      ["unsafe-cache", "cache"],
      ["orphaned-run", "orphan"],
    ]);
    const executed = await fleet.execute("cleanup-execute", { action: "cleanup", execute: true }, new AbortController().signal, () => {}, ctx);
    assert.deepEqual(executed.details.errors.map(({ candidate, error }: any) => [candidate.worker.id, candidate.kind, /symlink/.test(error)]), [
      ["unsafe-cache", "cache", true],
    ]);
    const saved = JSON.parse(await readFile(join(orchestratorDir, "workers.json"), "utf8"));
    assert.deepEqual(saved.workers.map((record: any) => record.id), ["retained-recent", "retained-dirty", "unsafe-cache"]);
    await assert.rejects(access(join(orchestratorDir, "worker-runtime", "expired-clean")));
    await assert.rejects(access(join(orchestratorDir, "worker-runtime", "orphaned-run")));
    await assert.rejects(access(join(orchestratorDir, "worker-runtime", "retained-recent", "home", ".cache", "npm")));
    assert.equal(await readFile(join(orchestratorDir, "worker-runtime", "retained-recent", "state"), "utf8"), "retained\n");
    assert.equal(await readFile(join(orchestratorDir, "worker-runtime", "retained-dirty", "state"), "utf8"), "retained\n");
    assert.equal(await readFile(join(externalHome, ".cache", "npm", "keep"), "utf8"), "outside\n");
    await lifecycle.get("session_shutdown")?.({ reason: "reload" }, ctx);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("bulk prune requires acknowledgment and remains manager scoped", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "agent-intercom-orchestrator-bulk-prune-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const orchestratorDir = join(agentDir, "intercom", "orchestrator");
    await mkdir(orchestratorDir, { recursive: true });
    await writeFile(join(orchestratorDir, "config.json"), JSON.stringify({ cleanupExpiredOnStart: false, cleanupOnShutdown: false }));
    const record = (id: string, owner: string) => ({
      id, runId: `run-${id}`, harness: "pi", role: "advisor", task: "review", cwd: "/tmp", state: "stopped",
      owned: true, managerSessionId: owner, stoppedAt: Date.now(), createdAt: 1, updatedAt: Date.now(), leaseExpiresAt: 1,
    });
    await writeFile(join(orchestratorDir, "workers.json"), JSON.stringify({ version: 1, workers: [record("mine", "manager-a"), record("theirs", "manager-b")] }));
    const lifecycle = new Map<string, (...args: any[]) => any>();
    const tools = new Map<string, any>();
    const pi: any = {
      on(name: string, handler: (...args: any[]) => any) { lifecycle.set(name, handler); },
      events: { on() { return () => {}; }, emit() {} }, registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() {},
      async exec() { return commandResult(); },
    };
    const ctx: any = { cwd: "/tmp", mode: "rpc", hasUI: false, sessionManager: { getSessionId: () => "manager-a", getSessionFile: () => undefined }, ui: { setStatus() {}, notify() {} } };
    const { default: extension } = await import(new URL(`../src/index.ts?bulk-prune=${Date.now()}`, import.meta.url).href);
    extension(pi);
    await lifecycle.get("session_start")?.({}, ctx);
    const fleet = tools.get("agent_fleet");
    await assert.rejects(fleet.execute("prune-refused", { action: "prune" }, new AbortController().signal, () => {}, ctx), /acknowledge=true/);
    const result = await fleet.execute("prune-owned", { action: "prune", acknowledge: true }, new AbortController().signal, () => {}, ctx);
    assert.deepEqual(result.details.pruned, ["mine"]);
    const saved = JSON.parse(await readFile(join(orchestratorDir, "workers.json"), "utf8"));
    assert.deepEqual(saved.workers.map((worker: any) => worker.id), ["theirs"]);
    await lifecycle.get("session_shutdown")?.({ reason: "reload" }, ctx);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("forget requires explicit manager acknowledgment after a worker is stopped", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "agent-intercom-orchestrator-forget-ack-test-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const orchestratorDir = join(agentDir, "intercom", "orchestrator");
    await mkdir(orchestratorDir, { recursive: true });
    await writeFile(join(orchestratorDir, "workers.json"), JSON.stringify({ version: 1, workers: [{
      id: "stopped-worker", runId: "run-stopped", harness: "pi", role: "advisor", task: "review", cwd: "/tmp",
      state: "stopped", unit: "agent-intercom-worker-stopped-worker.service", owned: true, managerSessionId: "manager-a",
      stopReason: "manager-requested", stoppedAt: Date.now(), createdAt: 1, updatedAt: 1, leaseExpiresAt: 1,
    }] }));
    const lifecycle = new Map<string, (...args: any[]) => any>();
    const tools = new Map<string, any>();
    const pi: any = {
      on(name: string, handler: (...args: any[]) => any) { lifecycle.set(name, handler); },
      events: { on() { return () => {}; }, emit() {} },
      registerTool(tool: any) { tools.set(tool.name, tool); },
      registerCommand() {},
      async exec(command: string, args: string[]) {
        if (command === "systemctl" && args.includes("show")) {
          return { stdout: "LoadState=not-found\nActiveState=inactive\nSubState=dead\nMainPID=0\n", stderr: "Unit not found", code: 1, killed: false };
        }
        if (command === "systemd-cgls") return { stdout: "", stderr: "Unit not found", code: 1, killed: false };
        return commandResult();
      },
    };
    const ctx: any = {
      cwd: "/tmp", mode: "rpc", hasUI: false,
      sessionManager: { getSessionId: () => "manager-a", getSessionFile: () => undefined },
      ui: { setStatus() {}, notify() {} },
    };
    const extensionUrl = new URL(`../src/index.ts?forget-ack=${Date.now()}`, import.meta.url);
    const { default: extension } = await import(extensionUrl.href);
    extension(pi);
    await lifecycle.get("session_start")?.({}, ctx);
    const fleet = tools.get("agent_fleet");
    await assert.rejects(
      fleet.execute("forget-no-ack", { action: "forget", id: "stopped-worker" }, new AbortController().signal, () => {}, ctx),
      /acknowledge=true/,
    );
    await fleet.execute("forget-ack", { action: "forget", id: "stopped-worker", acknowledge: true }, new AbortController().signal, () => {}, ctx);
    const saved = JSON.parse(await readFile(join(orchestratorDir, "workers.json"), "utf8"));
    assert.deepEqual(saved.workers, []);
    await lifecycle.get("session_shutdown")?.({ reason: "reload" }, ctx);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("extension registers discovery tools and interactive configuration commands", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "agent-intercom-orchestrator-extension-test-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  globalThis.fetch = async () => new Response(JSON.stringify({ version: "0.9.3" }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const lifecycle = new Map<string, (...args: any[]) => any>();
    const tools = new Map<string, any>();
    const commands = new Map<string, any>();
    const selections = ["Save and close"];
    const pi: any = {
      on(name: string, handler: (...args: any[]) => any) { lifecycle.set(name, handler); },
      events: { on() { return () => {}; }, emit() {} },
      registerTool(tool: any) { tools.set(tool.name, tool); },
      registerCommand(name: string, command: any) { commands.set(name, command); },
      async exec() { return commandResult(); },
    };
    const ctx: any = {
      cwd: process.cwd(),
      mode: "rpc",
      hasUI: true,
      sessionManager: { getSessionId: () => "extension-test", getSessionFile: () => undefined },
      ui: {
        setStatus() {},
        notify() {},
        async select() { return selections.shift(); },
        async input() { return undefined; },
        async editor() { return undefined; },
        async confirm() { return false; },
      },
    };
    const extensionUrl = new URL(`../src/index.ts?test=${Date.now()}`, import.meta.url);
    const { default: extension } = await import(extensionUrl.href);
    extension(pi);
    await lifecycle.get("session_start")?.({}, ctx);

    assert.ok(tools.has("agent_fleet"));
    assert.match(tools.get("agent_fleet").promptGuidelines.join("\n"), /returned intercomTarget/);
    assert.match(tools.get("agent_fleet").promptGuidelines.join("\n"), /progress\/status checkpoints/);
    assert.match(tools.get("agent_fleet").promptGuidelines.join("\n"), /create the feature worktree before spawning/i);
    assert.match(JSON.stringify(tools.get("agent_fleet").parameters), /versions/);
    assert.match(JSON.stringify(tools.get("agent_fleet").parameters), /update/);
    assert.match(JSON.stringify(tools.get("agent_fleet").parameters), /permissionProfile/);
    for (const command of ["boss", "agents", "agents-new", "agents-config", "agents-models", "agents-cleanup"]) {
      assert.ok(commands.has(command), `missing /${command}`);
    }

    const capabilities = await tools.get("agent_fleet").execute(
      "capabilities-test",
      { action: "capabilities" },
      new AbortController().signal,
      () => {},
      ctx,
    );
    assert.match(capabilities.content[0].text, /pi: modes=persistent/);
    assert.match(capabilities.content[0].text, /opencode: modes=persistent,one-shot/);
    assert.match(capabilities.content[0].text, /permissions: builder-restricted,manager-restricted,review-readonly,trusted/);
    const permissions = await tools.get("agent_fleet").execute("permissions-test", { action: "permissions" }, new AbortController().signal, () => {}, ctx);
    assert.match(permissions.content[0].text, /review-readonly \[workspace=read-only git=read-only hardened\]/);

    const versions = await tools.get("agent_fleet").execute("versions-test", { action: "versions" }, new AbortController().signal, () => {}, ctx);
    assert.match(versions.content[0].text, /Agent Intercom adapters:/);
    assert.match(versions.content[0].text, /Harness CLIs:/);
    const update = await tools.get("agent_fleet").execute("update-test", { action: "update" }, new AbortController().signal, () => {}, ctx);
    assert.match(update.content[0].text, /Preview only/);

    const doctor = await tools.get("agent_fleet").execute(
      "doctor-test",
      { action: "doctor" },
      new AbortController().signal,
      () => {},
      ctx,
    );
    assert.match(doctor.content[0].text, /cleanup timer: enabled=true active=true source-current=false/);
    assert.match(doctor.content[0].text, /OpenCode Intercom plugin: (?:not detected|could not inspect)/);

    await commands.get("agents-config").handler("", ctx);
    const saved = JSON.parse(await readFile(join(agentDir, "intercom", "orchestrator", "config.json"), "utf8"));
    assert.equal(saved.defaultHarness, "pi");
    assert.equal(saved.defaultProfiles.pi, undefined);
    assert.equal(saved.roles.advisor, undefined);

    await lifecycle.get("session_shutdown")?.({ reason: "reload" }, ctx);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("route previews automatic selection and explicit profile overrides without spawning", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "agent-intercom-orchestrator-route-test-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const orchestratorDir = join(agentDir, "intercom", "orchestrator");
    await mkdir(orchestratorDir, { recursive: true });
    await writeFile(join(orchestratorDir, "config.json"), JSON.stringify({
      profiles: {
        "pi-peer": { harness: "pi", command: "/bin/true", mode: "persistent", maxRuntime: "12h" },
        "codex-missing": { harness: "codex", command: "missing-codex-command-for-profile-fallback", mode: "persistent", maxRuntime: "12h" },
        "codex-safe": { harness: "codex", command: "/bin/true", mode: "persistent", maxRuntime: "12h" },
        "claude-safe": { harness: "claude", command: "missing-claude-command-for-routing-test", mode: "persistent", maxRuntime: "12h" },
        "claude-minimal": { harness: "claude", command: "missing-claude-minimal-for-routing-test", mode: "persistent", maxRuntime: "12h" },
        "opencode-run": { harness: "opencode", command: "/bin/true", mode: "one-shot", maxRuntime: "2h" },
      },
      roles: {
        fallback: { harness: "claude", profile: "claude-safe", permissionProfile: "trusted", model: "claude/claude-opus-4-8", effort: "max", instructions: "Keep the role instructions." },
      },
      routing: {
        explicitOnly: [],
        roles: { fallback: ["claude", "codex", "pi"], codexFallback: ["codex", "pi"], nestedDefault: ["pi", "codex"], open: ["opencode", "pi"] },
        profilePreferences: { codex: ["codex-missing", "codex-safe"], opencode: ["opencode-run"] },
        roleRequirements: { nestedDefault: { requiresSubagents: true } },
        fallback: { preserveRoleInstructions: false },
      },
    }));
    const lifecycle = new Map<string, (...args: any[]) => any>();
    const tools = new Map<string, any>();
    let launches = 0;
    const pi: any = {
      on(name: string, handler: (...args: any[]) => any) { lifecycle.set(name, handler); },
      events: { on() { return () => {}; }, emit() {} },
      registerTool(tool: any) { tools.set(tool.name, tool); },
      registerCommand() {},
      async exec(command: string) {
        if (command === "systemd-run") launches += 1;
        return commandResult();
      },
    };
    const ctx: any = {
      cwd: "/tmp", mode: "rpc", hasUI: false,
      sessionManager: { getSessionId: () => "route-manager", getSessionFile: () => undefined },
      ui: { setStatus() {}, notify() {} },
    };
    const extensionUrl = new URL(`../src/index.ts?route=${Date.now()}`, import.meta.url);
    const { default: extension } = await import(extensionUrl.href);
    extension(pi);
    await lifecycle.get("session_start")?.({}, ctx);
    const fleet = tools.get("agent_fleet");

    const builder = await fleet.execute("route-builder", {
      action: "route", role: "builder", harness: "auto", profile: "", model: "", effort: "auto",
      subagents: "auto", requiresSubagents: false, permissionProfile: "", instructions: "",
    }, new AbortController().signal, () => {}, ctx);
    assert.match(builder.content[0].text, /Recommended harness: codex/);
    assert.equal(builder.details.routing.selected, "codex");
    assert.equal(builder.details.profile, "codex-safe");
    assert.deepEqual(builder.details.availability.codex.profileCandidates.slice(0, 2), ["codex-safe", "codex-missing"]);

    const profileFallback = await fleet.execute("route-profile-fallback", { action: "route", role: "codexFallback" }, new AbortController().signal, () => {}, ctx);
    assert.equal(profileFallback.details.routing.selected, "codex");
    assert.equal(profileFallback.details.profile, "codex-safe");
    assert.deepEqual(profileFallback.details.availability.codex.profileCandidates.slice(0, 2), ["codex-missing", "codex-safe"]);
    assert.match(profileFallback.content[0].text, /profile fallback:.*codex-missing/);

    const nestedDefault = await fleet.execute("route-nested-default", {
      action: "route", role: "nestedDefault", harness: "auto", effort: "auto",
      subagents: "auto", requiresSubagents: false,
    }, new AbortController().signal, () => {}, ctx);
    assert.equal(nestedDefault.details.routing.requiresSubagents, true);
    assert.equal(nestedDefault.details.routing.selected, "codex");

    const nestedDisabled = await fleet.execute("route-nested-disabled", {
      action: "route", role: "nestedDefault", harness: "auto", effort: "auto", subagents: "not-required",
    }, new AbortController().signal, () => {}, ctx);
    assert.equal(nestedDisabled.details.routing.requiresSubagents, false);
    assert.equal(nestedDisabled.details.routing.selected, "pi");

    const configuredOpenCode = await fleet.execute("route-open", { action: "route", role: "open" }, new AbortController().signal, () => {}, ctx);
    assert.equal(configuredOpenCode.details.routing.automatic, true);
    assert.equal(configuredOpenCode.details.routing.selected, "pi");
    assert.equal(configuredOpenCode.details.profile, "pi-peer");
    assert.match(configuredOpenCode.content[0].text, /opencode \[excluded\].*explicit-only/);

    const nested = await fleet.execute("route-nested", { action: "route", role: "advisor", requiresSubagents: true }, new AbortController().signal, () => {}, ctx);
    assert.match(nested.content[0].text, /Recommended harness: codex/);
    assert.match(nested.content[0].text, /pi \[excluded\].*nested subagents are required/);

    const explicit = await fleet.execute("route-explicit", { action: "route", profile: "opencode-run" }, new AbortController().signal, () => {}, ctx);
    assert.match(explicit.content[0].text, /Explicit harness: opencode/);
    assert.equal(explicit.details.routing.explicitSource, "profile");

    const directModel = await fleet.execute("route-model", { action: "route", model: "claude/claude-opus-4-8" }, new AbortController().signal, () => {}, ctx);
    assert.match(directModel.content[0].text, /Explicit harness: claude/);
    assert.equal(directModel.details.routing.explicitSource, "model");
    assert.match(directModel.content[0].text, /use action=models to verify live availability/);

    const explicitHarness = await fleet.execute("route-harness", { action: "route", harness: "pi", requiresSubagents: true }, new AbortController().signal, () => {}, ctx);
    assert.match(explicitHarness.content[0].text, /Explicit harness: pi/);
    assert.match(explicitHarness.content[0].text, /capability warning.*does not support configured nested subagents/);
    assert.equal(explicitHarness.details.routing.explicitSource, "harness");

    const none = await fleet.execute("route-none", { action: "route", role: "builder", requiresSubagents: true, effort: "minimal" }, new AbortController().signal, () => {}, ctx);
    assert.match(none.content[0].text, /Recommended harness: none/);
    assert.equal(none.details.routing.selected, undefined);
    assert.equal(none.details.routing.candidates.length, 4);
    await assert.rejects(
      fleet.execute("spawn-none", { action: "spawn", id: "no-route", role: "builder", requiresSubagents: true, effort: "minimal", task: "Cannot route." }, new AbortController().signal, () => {}, ctx),
      /Use action=route to inspect exclusions/,
    );
    assert.equal(launches, 0);

    const automaticSpawn = await fleet.execute("spawn-builder", {
      action: "spawn", id: "routed-builder", role: "builder", task: "Implement the route.", cwd: "/tmp", permissionProfile: "trusted",
    }, new AbortController().signal, () => {}, ctx);
    assert.match(automaticSpawn.content[0].text, /Started routed-builder \[codex\/builder\]/);
    assert.match(automaticSpawn.content[0].text, /automatically selected codex/);
    assert.doesNotMatch(automaticSpawn.content[0].text, /bounded Ralph loop|return_on|cannot wake the manager/i);
    assert.equal(automaticSpawn.details.routing.selected, "codex");
    assert.equal(launches, 1);

    const fallbackSpawn = await fleet.execute("spawn-fallback", {
      action: "spawn", id: "fallback-worker", role: "fallback", task: "Fall through safely.", cwd: "/tmp",
    }, new AbortController().signal, () => {}, ctx);
    assert.equal(fallbackSpawn.details.worker.harness, "codex");
    assert.equal(fallbackSpawn.details.worker.model, undefined);
    assert.equal(fallbackSpawn.details.worker.effort, undefined);
    assert.equal(fallbackSpawn.details.worker.instructions, undefined);
    assert.match(fallbackSpawn.details.routing.reasons.join(" "), /ignored harness-specific preset model and effort/);
    assert.equal(launches, 2);

    assert.doesNotMatch(fleet.promptGuidelines.join("\n"), /Ralph loop|return_on|cannot wake the manager/i);
    assert.match(fleet.promptGuidelines.join("\n"), /Harnesses configured as explicit-only: opencode/);

    await lifecycle.get("session_shutdown")?.({ reason: "reload" }, ctx);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
});

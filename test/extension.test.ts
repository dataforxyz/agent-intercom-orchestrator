import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    assert.equal(saved.workers[0].state, "completed");
    assert.equal(stopped, true);
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
    const pi: any = {
      on(name: string, handler: (...args: any[]) => any) { lifecycle.set(name, handler); },
      events: { on() { return () => {}; }, emit() {} },
      registerTool(tool: any) { tools.set(tool.name, tool); },
      registerCommand() {},
      async exec(command: string, args: string[]) {
        if (command === "systemd-run") {
          const environment = Object.fromEntries(args
            .filter((arg) => arg.startsWith("--setenv="))
            .map((arg) => {
              const value = arg.slice("--setenv=".length);
              const separator = value.indexOf("=");
              return [value.slice(0, separator), value.slice(separator + 1)];
            }));
          await mkdir(join(orchestratorDir, "opencode-peers"), { recursive: true });
          await writeFile(environment.AGENT_INTERCOM_OPENCODE_HEALTH_PATH, JSON.stringify({
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
    const state = JSON.parse(await readFile(join(orchestratorDir, "opencode-peers", "state-race.state.json"), "utf8"));
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

test("extension registers discovery tools and interactive configuration commands", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "agent-intercom-orchestrator-extension-test-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
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
    for (const command of ["agents", "agents-new", "agents-config", "agents-models", "agents-cleanup"]) {
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

    const doctor = await tools.get("agent_fleet").execute(
      "doctor-test",
      { action: "doctor" },
      new AbortController().signal,
      () => {},
      ctx,
    );
    assert.match(doctor.content[0].text, /OpenCode Intercom plugin: not detected/);

    await commands.get("agents-config").handler("", ctx);
    const saved = JSON.parse(await readFile(join(agentDir, "intercom", "orchestrator", "config.json"), "utf8"));
    assert.equal(saved.defaultHarness, "pi");
    assert.equal(saved.defaultProfiles.pi, undefined);
    assert.equal(saved.roles.advisor, undefined);

    await lifecycle.get("session_shutdown")?.({ reason: "reload" }, ctx);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
});

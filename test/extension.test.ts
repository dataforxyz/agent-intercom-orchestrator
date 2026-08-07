import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

function commandResult() {
  return { stdout: "", stderr: "", code: 0, killed: false };
}

test("owned Boss participants cannot register /boss, boss, or agent_fleet when orchestration is disabled", async () => {
  const keys = [
    "AGENT_INTERCOM_ORCHESTRATOR_DISABLED",
    "AGENT_INTERCOM_BOSS_RUN_ID",
    "AGENT_INTERCOM_BOSS_ROLE",
    "AGENT_INTERCOM_BOSS_CONTROLLER_TARGET",
    "AGENT_INTERCOM_BOSS_MANAGER_TARGET",
    "AGENT_INTERCOM_BOSS_TEAM_TARGETS",
    "AGENT_INTERCOM_BOSS_VISIBILITY",
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.AGENT_INTERCOM_ORCHESTRATOR_DISABLED = "1";
    process.env.AGENT_INTERCOM_BOSS_RUN_ID = "boss-00000000-0000-4000-8000-123456789abc";
    process.env.AGENT_INTERCOM_BOSS_CONTROLLER_TARGET = "controller-exact-target";
    process.env.AGENT_INTERCOM_BOSS_MANAGER_TARGET = "boss-manager-123456789abc";
    process.env.AGENT_INTERCOM_BOSS_TEAM_TARGETS = JSON.stringify(["boss-manager-123456789abc", "boss-worker-123456789abc", "boss-scout-123456789abc", "boss-adversary-123456789abc"]);
    process.env.AGENT_INTERCOM_BOSS_VISIBILITY = "team-only";
    for (const role of ["manager", "worker", "scout", "adversary"] as const) {
      process.env.AGENT_INTERCOM_BOSS_ROLE = role;
      const tools = new Map<string, unknown>();
      const commands = new Map<string, unknown>();
      const pi: any = {
        on() {},
        events: { on() { return () => {}; }, emit() {} },
        registerTool(tool: any) { tools.set(tool.name, tool); },
        registerCommand(name: string, command: any) { commands.set(name, command); },
      };
      const { default: extension } = await import(new URL(`../src/index.ts?disabled-boss=${role}-${Date.now()}`, import.meta.url).href);
      extension(pi);
      assert.equal(tools.has("agent_fleet"), false, `${role} must not own agent_fleet`);
      assert.equal(tools.has("boss"), false, `${role} must not own boss`);
      assert.equal(commands.has("boss"), false, `${role} must not own /boss`);
    }
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("Boss participant launches carry isolated Ralph state, exact extensions, tools, and role prompts", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "agent-intercom-orchestrator-boss-launch-"));
  const runtimeDir = await mkdtemp(join(tmpdir(), "agent-intercom-orchestrator-boss-runtime-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
  const previousManagerContext = process.env.AGENT_INTERCOM_MANAGER_CONTEXT;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  process.env.AGENT_INTERCOM_MANAGER_CONTEXT = "headless_cli";
  try {
    const orchestratorDir = join(agentDir, "intercom", "orchestrator");
    const intercomExtension = join(agentDir, "git", "github.com", "dataforxyz", "agent-intercom-pi", "index.ts");
    const ralphExtension = join(agentDir, "git", "github.com", "dataforxyz", "pi-extensions", "pi-ralph-wiggum", "index.ts");
    const returnOnExtension = join(agentDir, "git", "github.com", "dataforxyz", "pi-return-on", "src", "index.ts");
    const resources = [
      [dirname(intercomExtension), "@dataforxyz/agent-intercom-pi"],
      [join(agentDir, "git", "github.com", "dataforxyz", "agent-intercom-orchestrator"), "@dataforxyz/agent-intercom-orchestrator"],
      [join(agentDir, "git", "github.com", "dataforxyz", "pi-extensions"), "pi-extensions"],
      [join(agentDir, "git", "github.com", "dataforxyz", "pi-return-on"), "pi-return-on"],
    ] as const;
    await mkdir(orchestratorDir, { recursive: true });
    await mkdir(dirname(intercomExtension), { recursive: true });
    await mkdir(join(resources[1][0], "src"), { recursive: true });
    await mkdir(dirname(ralphExtension), { recursive: true });
    await mkdir(dirname(returnOnExtension), { recursive: true });
    await writeFile(intercomExtension, "export default function () {}\n");
    await writeFile(join(resources[1][0], "src", "index.ts"), "export default function () {}\n");
    await writeFile(ralphExtension, "export default function () {}\n");
    await writeFile(returnOnExtension, "export default function () {}\n");
    for (const [root, name] of resources) {
      await writeFile(join(root, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
      spawnSync("git", ["init", "-q", root]);
      spawnSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
      spawnSync("git", ["-C", root, "config", "user.name", "Test"]);
      spawnSync("git", ["-C", root, "add", "."]);
      spawnSync("git", ["-C", root, "commit", "-qm", "fixture"]);
    }
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [
      "git:github.com/dataforxyz/agent-intercom-pi",
      "git:github.com/dataforxyz/agent-intercom-orchestrator",
      { source: "git:github.com/dataforxyz/pi-extensions", extensions: ["pi-ralph-wiggum/index.ts"] },
      "git:github.com/dataforxyz/pi-return-on",
    ] }));
    await writeFile(join(orchestratorDir, "config.json"), JSON.stringify({
      profiles: {
        "pi-peer": { harness: "pi", command: "/bin/true", args: ["--mode", "rpc", "--exclude-tools", "agent_fleet"], mode: "persistent", maxRuntime: "12h" },
      },
      boss: {
        worktreeRoot: join(agentDir, "boss-worktrees"),
        onboarding: { version: "orc.boss-onboarding.v1", completedAt: "2026-03-01T12:34:56.000Z" },
        roles: {
          manager: { model: "provider/manager", effort: "high" },
          worker: { model: "provider/worker", effort: "medium" },
          scout: { model: "provider/scout", effort: "low" },
          adversary: { model: "provider/adversary", effort: "xhigh" },
        },
      },
    }));

    const lifecycle = new Map<string, (...args: any[]) => any>();
    const tools = new Map<string, any>();
    const launches: string[][] = [];
    const stoppedUnits = new Set<string>();
    const intercomDeliveries: Array<{ to: string; message: string }> = [];
    let contextStale = false;
    let failNextBossLaunch = false;
    let failNextBossStop = false;
    const pi: any = {
      on(name: string, handler: (...args: any[]) => any) { lifecycle.set(name, handler); },
      events: {
        on() { return () => {}; },
        emit(name: string, payload: { to: string; message: string }) {
          if (name === "agent-intercom:lifecycle-send") intercomDeliveries.push(payload);
        },
      },
      registerTool(tool: any) { tools.set(tool.name, tool); },
      registerCommand() {},
      async exec(command: string, args: string[]) {
        if (command === "systemd-run" && args.some((arg) => arg.startsWith("--unit=agent-intercom-worker-boss-"))) {
          if (failNextBossLaunch) {
            failNextBossLaunch = false;
            return { ...commandResult(), code: 1, stderr: "injected Manager launch failure" };
          }
          launches.push([...args]);
        }
        if (command === "systemd") return { ...commandResult(), stdout: "systemd 257\n" };
        if (command === "systemctl" && args.includes("stop")) {
          if (failNextBossStop) {
            failNextBossStop = false;
            return { ...commandResult(), code: 1, stderr: "injected participant stop failure" };
          }
          stoppedUnits.add(args.at(-1)!);
          return commandResult();
        }
        if (command === "systemctl" && args.includes("show")) {
          const stopped = stoppedUnits.has(args[args.indexOf("show") + 1]);
          return { ...commandResult(), stdout: stopped
            ? "LoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\nResult=success\nExecMainStatus=0\nJob=\nInactiveEnterTimestampMonotonic=20\n"
            : "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=123\nResult=success\nExecMainStatus=0\nJob=\nExecMainStartTimestampMonotonic=10\n" };
        }
        return commandResult();
      },
    };
    const ctx: any = {
      cwd: resources[1][0], mode: "rpc", hasUI: false,
      sessionManager: { getSessionId: () => "controller-exact-target", getSessionFile: () => undefined },
      ui: { setStatus() { if (contextStale) throw new Error("stale context used during reload shutdown"); }, notify() {} },
    };
    const extensionUrl = new URL(`../src/index.ts?boss-launch=${Date.now()}`, import.meta.url);
    const { default: extension } = await import(extensionUrl.href);
    extension(pi);
    await lifecycle.get("session_start")?.({}, ctx);
    const planned = await tools.get("boss").execute("boss-plan-test", { action: "plan" }, new AbortController().signal, () => {}, ctx);
    assert.match(planned.content[0].text, /Orc Boss setup plan: ready/);
    assert.match(planned.content[0].text, /No automatic install changes are proposed/);
    const diagnosed = await tools.get("boss").execute("boss-doctor-test", { action: "doctor" }, new AbortController().signal, () => {}, ctx);
    assert.match(diagnosed.content[0].text, /Orc Boss trusted-local readiness: warning/);
    assert.match(diagnosed.content[0].text, /required-stack: ready/);
    assert.match(diagnosed.content[0].text, /models: warning/);
    const blocked = await tools.get("boss").execute(
      "boss-capability-gap-test",
      { action: "create", goal: "test and publish through Git", requirements: { tests: true, gitTransport: "write" } },
      new AbortController().signal,
      () => {},
      ctx,
    );
    assert.equal(blocked.details.created, false);
    assert.deepEqual(blocked.details.capabilityReport.requested, { tests: true, gitTransport: "write" });
    assert.deepEqual(blocked.details.capabilityReport.probes.map((finding: any) => [finding.capability, finding.requested, finding.availability]), [
      ["tests", "required", "gap"],
      ["git-transport", "write", "gap"],
    ]);
    assert.deepEqual(blocked.details.gaps, blocked.details.capabilityReport.probes);
    assert.match(blocked.content[0].text, /BOSS_CAPABILITY_GAP:[\s\S]*No Boss run was created/);
    assert.equal(launches.length, 0, "a requested capability gap must fail before staffing");
    const afterGap = await tools.get("boss").execute("boss-after-gap-status", { action: "status" }, new AbortController().signal, () => {}, ctx);
    assert.match(afterGap.content[0].text, /No Boss runs are owned by this Controller/);
    const created = await tools.get("boss").execute(
      "boss-launch-test",
      { action: "create", goal: "ship supervised Ralph loops", requirements: { worktree: "write", edit: true } },
      new AbortController().signal,
      () => {},
      ctx,
    );

    assert.equal(created.details.created, true);
    assert.equal(created.details.capabilityReport.status, "ready");
    assert.deepEqual(created.details.capabilityReport.probes.map((finding: any) => [finding.capability, finding.requested, finding.availability]), [
      ["worktree-identity", "required", "verified"],
      ["worktree-write", "write", "configured"],
      ["edit", "required", "configured"],
    ]);
    assert.deepEqual(created.details.gaps, []);
    assert.match(created.content[0].text, /Boss create capability report: ready/);
    assert.match(created.content[0].text, /configured access is policy evidence, not proof of effective Worker access/);

    assert.equal(launches.length, 3);
    const bossRunId = created.details.run.bossRunId as string;
    const canonicalCwd = created.details.run.resource.path as string;
    assert.equal(created.details.run.resource.revision, 1);
    assert.equal(canonicalCwd, join(agentDir, "boss-worktrees", bossRunId));
    assert.deepEqual(created.details.run.assignments.map((assignment: any) => assignment.resourceRevision), [1, 1, 1]);
    const suffix = bossRunId.slice(-12);
    const orchestratorExtension = new URL("../src/index.ts", import.meta.url).pathname;
    for (const role of ["manager", "worker", "scout"] as const) {
      const launch = launches.find((args) => args.some((arg) => arg === `--setenv=AGENT_INTERCOM_BOSS_ROLE=${role}`));
      assert.ok(launch, `missing ${role} launch`);
      assert.ok(launch.includes(`--setenv=AGENT_INTERCOM_BOSS_RUN_ID=${bossRunId}`));
      assert.ok(launch.includes("--setenv=AGENT_INTERCOM_BOSS_CONTROLLER_TARGET=controller-exact-target"));
      assert.ok(launch.includes(`--setenv=AGENT_INTERCOM_BOSS_MANAGER_TARGET=boss-manager-${suffix}`));
      assert.ok(launch.includes(`--working-directory=${canonicalCwd}`), `${role} did not launch in the canonical resource`);
      assert.ok(launch.includes(`--setenv=PI_RALPH_STATE_ROOT=${join(runtimeDir, "agent-intercom-worker", "boss-ralph", bossRunId, role)}`));
      assert.ok(launch.includes(`--setenv=PI_RETURN_ON_STATE_DIR=${join(runtimeDir, "agent-intercom-worker", "boss-return-on", bossRunId, role)}`));
      assert.ok(launch.includes("--no-extensions"));
      for (const extensionPath of [intercomExtension, orchestratorExtension, ralphExtension, returnOnExtension]) {
        assert.ok(launch.includes(extensionPath), `${role} missing extension ${extensionPath}`);
      }
      const toolsIndex = launch.indexOf("--tools");
      assert.notEqual(toolsIndex, -1);
      const allowedTools = launch[toolsIndex + 1].split(",");
      for (const requiredTool of ["ralph_start", "ralph_update", "ralph_done", "return_on", "return_on_cancel", "return_on_list", "return_on_status"]) {
        assert.ok(allowedTools.includes(requiredTool), `${role} missing ${requiredTool}`);
      }
      assert.equal(allowedTools.includes("agent_fleet"), false);
      assert.equal(allowedTools.includes("boss"), false);
      const prompt = launch.join("\n");
      assert.match(prompt, new RegExp(`Immediately start the isolated Ralph loop named boss-${suffix}-${role}`));
      assert.match(prompt, /itemsPerIteration=3, reflectEvery=5, maxIterations=100/);
      assert.ok(prompt.includes(`Canonical resource: ${canonicalCwd} at resource revision 1`));
      const modelIndex = launch.indexOf("--model");
      const thinkingIndex = launch.indexOf("--thinking");
      assert.equal(launch[modelIndex + 1], `provider/${role}`);
      assert.equal(launch[thinkingIndex + 1], role === "manager" ? "high" : role === "worker" ? "medium" : "low");
    }
    const managerPrompt = launches.find((args) => args.includes("--setenv=AGENT_INTERCOM_BOSS_ROLE=manager"))!.join("\n");
    assert.match(managerPrompt, /At the start of every Ralph iteration, call intercom_team/);
    assert.match(managerPrompt, /Every iteration, send bounded progress nudges to both Worker and Scout/);
    assert.match(managerPrompt, /stop without ralph_done so inbound Intercom can wake the idle Manager/);
    const workerPrompt = launches.find((args) => args.includes("--setenv=AGENT_INTERCOM_BOSS_ROLE=worker"))!.join("\n");
    assert.match(workerPrompt, /Report concrete progress, verification evidence, and blockers to the Manager/);
    assert.equal(intercomDeliveries.length, 3);
    assert.deepEqual(intercomDeliveries.map((delivery) => delivery.to).sort(), [
      `boss-manager-${suffix}`,
      `boss-scout-${suffix}`,
      `boss-worker-${suffix}`,
    ].sort());
    for (const delivery of intercomDeliveries) {
      assert.match(delivery.message, /Initial (manager|worker|scout) assignment/);
      assert.match(delivery.message, /resource revision 1/);
      assert.ok(delivery.message.includes(`Canonical cwd: ${canonicalCwd}`));
      assert.match(delivery.message, /Begin now using the isolated Ralph protocol/);
    }

    const cancelled = await tools.get("boss").execute(
      "boss-clean-resource-test",
      { action: "cancel", bossRunId },
      new AbortController().signal,
      () => {},
      ctx,
    );
    assert.equal(cancelled.details.run.cancellation.state, "succeeded");
    assert.equal(cancelled.details.run.resource.revision, 2);
    assert.equal(cancelled.details.run.resource.leaseState, "released");
    assert.equal(cancelled.details.run.resource.existence, "missing");
    assert.match(cancelled.content[0].text, /clean worktree and branch were removed/);
    await assert.rejects(access(canonicalCwd));

    const defaultCreated = await tools.get("boss").execute(
      "boss-default-create-test",
      { action: "create", goal: "preserve default create behavior" },
      new AbortController().signal,
      () => {},
      ctx,
    );
    assert.equal(defaultCreated.details.created, true);
    assert.equal(defaultCreated.details.capabilityReport, undefined);
    assert.ok(defaultCreated.details.run?.bossRunId);
    assert.doesNotMatch(defaultCreated.content[0].text, /Boss create capability report/);
    assert.equal(launches.length, 6, "omitting requirements preserves ordinary three-role staffing");

    const reviewable = await tools.get("boss").execute(
      "boss-review-cleanup-retry-create",
      { action: "create", goal: "retry terminal cleanup after transient stop failure", requirements: { worktree: "write" } },
      new AbortController().signal,
      () => {},
      ctx,
    );
    const reviewableRunId = reviewable.details.run.bossRunId as string;
    const reviewableCwd = reviewable.details.run.resource.path as string;
    const proof = await tools.get("boss").execute(
      "boss-review-cleanup-retry-proof",
      { action: "proof", bossRunId: reviewableRunId },
      new AbortController().signal,
      () => {},
      ctx,
    );
    assert.equal(proof.details.run.proofPackets.length, 1);
    const freshProof = await tools.get("boss").execute(
      "boss-review-cleanup-fresh-proof",
      { action: "proof", bossRunId: reviewableRunId },
      new AbortController().signal,
      () => {},
      ctx,
    );
    assert.ok(freshProof.details.run.proofPackets.length >= 1);
    failNextBossStop = true;
    const firstApproval = await tools.get("boss").execute(
      "boss-review-cleanup-first-approval",
      { action: "approve", bossRunId: reviewableRunId, note: "exact proof reviewed" },
      new AbortController().signal,
      () => {},
      ctx,
    );
    assert.equal(firstApproval.details.run.state, "approved");
    assert.equal(firstApproval.details.run.resource.leaseState, "active");
    assert.match(firstApproval.content[0].text, /cleanup was not attempted because exact participant shutdown failed/);
    assert.equal(await access(reviewableCwd).then(() => true), true);
    const retriedApproval = await tools.get("boss").execute(
      "boss-review-cleanup-retried-approval",
      { action: "approve", bossRunId: reviewableRunId, note: "retry exact terminal cleanup" },
      new AbortController().signal,
      () => {},
      ctx,
    );
    assert.equal(retriedApproval.details.run.state, "approved");
    assert.equal(retriedApproval.details.run.decisions.length, 1);
    assert.equal(retriedApproval.details.run.resource.leaseState, "released");
    assert.equal(retriedApproval.details.run.resource.existence, "missing");
    await assert.rejects(access(reviewableCwd));

    const launchesBeforeManagerFailure = launches.length;
    failNextBossLaunch = true;
    const managerFailed = await tools.get("boss").execute(
      "boss-manager-failure-cleanup-test",
      { action: "create", goal: "fail initial Manager launch safely", requirements: { worktree: "write" } },
      new AbortController().signal,
      () => {},
      ctx,
    );
    const failedCanonicalCwd = managerFailed.details.run.resource.path as string;
    assert.equal(managerFailed.details.run.state, "failed");
    assert.equal(managerFailed.details.run.assignments[0].state, "failed");
    assert.equal(managerFailed.details.run.resource.revision, 2);
    assert.equal(managerFailed.details.run.resource.leaseState, "released");
    assert.equal(managerFailed.details.run.resource.existence, "missing");
    assert.match(managerFailed.content[0].text, /clean worktree and branch were removed/);
    await assert.rejects(access(failedCanonicalCwd));
    assert.equal(launches.length, launchesBeforeManagerFailure, "Manager launch failure must not continue staffing Worker or Scout");

    contextStale = true;
    await lifecycle.get("session_shutdown")?.({ reason: "reload" }, ctx);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
    if (previousManagerContext === undefined) delete process.env.AGENT_INTERCOM_MANAGER_CONTEXT;
    else process.env.AGENT_INTERCOM_MANAGER_CONTEXT = previousManagerContext;
    await rm(agentDir, { recursive: true, force: true });
    await rm(runtimeDir, { recursive: true, force: true });
  }
});

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

test("periodic heartbeat reconciles only workers attached to its manager", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "agent-intercom-orchestrator-scoped-heartbeat-test-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousSkipStartupCleanup = process.env.AGENT_INTERCOM_SKIP_STARTUP_CLEANUP;
  const previousDisableCleanupTimer = process.env.AGENT_INTERCOM_DISABLE_CLEANUP_TIMER;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.AGENT_INTERCOM_SKIP_STARTUP_CLEANUP = "1";
  process.env.AGENT_INTERCOM_DISABLE_CLEANUP_TIMER = "1";
  try {
    const orchestratorDir = join(agentDir, "intercom", "orchestrator");
    const statePath = join(orchestratorDir, "workers.json");
    await mkdir(orchestratorDir, { recursive: true });
    const worker = (id: string, managerSessionId: string) => ({
      id,
      runId: `run-${id}`,
      harness: "pi",
      role: "reviewer",
      task: "review",
      cwd: "/tmp",
      state: "running",
      unit: `agent-intercom-worker-${id}.service`,
      owned: true,
      managerSessionId,
      createdAt: 1,
      updatedAt: 1,
      leaseExpiresAt: Date.now() + 60_000,
    });
    const seedWorkers = [
      worker("owned-a", "manager-a"),
      worker("owned-b", "manager-a"),
      ...Array.from({ length: 100 }, (_, index) => worker(`unrelated-${index}`, "manager-b")),
    ];
    await writeFile(statePath, JSON.stringify({ version: 1, workers: seedWorkers }));

    const lifecycle = new Map<string, (...args: any[]) => any>();
    const tools = new Map<string, any>();
    const observedUnits: string[] = [];
    let resolveLegacyStopping = false;
    const pi: any = {
      on(name: string, handler: (...args: any[]) => any) { lifecycle.set(name, handler); },
      events: { on() { return () => {}; }, emit() {} },
      registerTool(tool: any) { tools.set(tool.name, tool); },
      registerCommand() {},
      async exec(command: string, args: string[]) {
        if (command === "systemctl" && args[1] === "show") {
          observedUnits.push(args[2]);
          if (args[2] === "agent-intercom-worker-legacy-stopping.service" && resolveLegacyStopping) {
            return { ...commandResult(), code: 1 };
          }
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
    const extensionUrl = new URL(`../src/index.ts?scoped-heartbeat=${Date.now()}`, import.meta.url);
    const { default: extension } = await import(extensionUrl.href);
    extension(pi);
    await lifecycle.get("session_start")?.({}, ctx);

    assert.equal(observedUnits.length, 102, "startup reconciliation remains global");
    await writeFile(statePath, JSON.stringify({
      version: 1,
      workers: [...seedWorkers, { ...worker("legacy-stopping", "manager-b"), state: "stopping" }],
    }));
    const { WorkerStore } = await import("../src/store.ts");
    await new WorkerStore(statePath).migrate();
    observedUnits.length = 0;
    await tools.get("agent_fleet").execute(
      "heartbeat-test",
      { action: "_heartbeat" },
      new AbortController().signal,
      () => {},
      ctx,
    );
    assert.deepEqual(observedUnits.sort(), [
      "agent-intercom-worker-owned-a.service",
      "agent-intercom-worker-owned-b.service",
    ]);
    assert.equal(
      JSON.parse(await readFile(statePath, "utf8")).workers.find((candidate: any) => candidate.id === "legacy-stopping").state,
      "migration_pending",
      "another manager's migration remains untouched by the scoped heartbeat",
    );

    observedUnits.length = 0;
    resolveLegacyStopping = true;
    await tools.get("agent_fleet").execute(
      "global-list-test",
      { action: "list", all: true },
      new AbortController().signal,
      () => {},
      ctx,
    );
    assert.equal(observedUnits.length, 103, "explicit all-manager reconciliation remains global");
    assert.ok(observedUnits.includes("agent-intercom-worker-legacy-stopping.service"));
    assert.equal(
      JSON.parse(await readFile(statePath, "utf8")).workers.find((candidate: any) => candidate.id === "legacy-stopping").state,
      "lost",
      "the global path still resolves an unattached migration",
    );
    await lifecycle.get("session_shutdown")?.({ reason: "reload" }, ctx);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousSkipStartupCleanup === undefined) delete process.env.AGENT_INTERCOM_SKIP_STARTUP_CLEANUP;
    else process.env.AGENT_INTERCOM_SKIP_STARTUP_CLEANUP = previousSkipStartupCleanup;
    if (previousDisableCleanupTimer === undefined) delete process.env.AGENT_INTERCOM_DISABLE_CLEANUP_TIMER;
    else process.env.AGENT_INTERCOM_DISABLE_CLEANUP_TIMER = previousDisableCleanupTimer;
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("idle heartbeat with no attached live workers performs no unit checks or store write", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "agent-intercom-orchestrator-idle-heartbeat-test-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousSkipStartupCleanup = process.env.AGENT_INTERCOM_SKIP_STARTUP_CLEANUP;
  const previousDisableCleanupTimer = process.env.AGENT_INTERCOM_DISABLE_CLEANUP_TIMER;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.AGENT_INTERCOM_SKIP_STARTUP_CLEANUP = "1";
  process.env.AGENT_INTERCOM_DISABLE_CLEANUP_TIMER = "1";
  try {
    const orchestratorDir = join(agentDir, "intercom", "orchestrator");
    const statePath = join(orchestratorDir, "workers.json");
    await mkdir(orchestratorDir, { recursive: true });
    await writeFile(statePath, JSON.stringify({
      version: 1,
      workers: Array.from({ length: 63 }, (_, index) => ({
        id: `unrelated-${index}`,
        runId: `run-${index}`,
        harness: "pi",
        role: "reviewer",
        task: "review",
        cwd: "/tmp",
        state: "running",
        unit: `agent-intercom-worker-unrelated-${index}.service`,
        owned: true,
        managerSessionId: "manager-b",
        createdAt: 1,
        updatedAt: 1,
        leaseExpiresAt: Date.now() + 60_000,
      })),
    }));

    const lifecycle = new Map<string, (...args: any[]) => any>();
    const tools = new Map<string, any>();
    let unitChecks = 0;
    const pi: any = {
      on(name: string, handler: (...args: any[]) => any) { lifecycle.set(name, handler); },
      events: { on() { return () => {}; }, emit() {} },
      registerTool(tool: any) { tools.set(tool.name, tool); },
      registerCommand() {},
      async exec(command: string, args: string[]) {
        if (command === "systemctl" && args[1] === "show") {
          unitChecks += 1;
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
    const extensionUrl = new URL(`../src/index.ts?idle-heartbeat=${Date.now()}`, import.meta.url);
    const { default: extension } = await import(extensionUrl.href);
    extension(pi);
    await lifecycle.get("session_start")?.({}, ctx);

    assert.equal(unitChecks, 63, "startup reconciliation remains global");
    unitChecks = 0;
    const before = await readFile(statePath, "utf8");
    await tools.get("agent_fleet").execute(
      "idle-heartbeat-test",
      { action: "_heartbeat" },
      new AbortController().signal,
      () => {},
      ctx,
    );
    assert.equal(unitChecks, 0);
    assert.equal(await readFile(statePath, "utf8"), before, "no-op heartbeat must not rewrite or advance the store");
    await lifecycle.get("session_shutdown")?.({ reason: "reload" }, ctx);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousSkipStartupCleanup === undefined) delete process.env.AGENT_INTERCOM_SKIP_STARTUP_CLEANUP;
    else process.env.AGENT_INTERCOM_SKIP_STARTUP_CLEANUP = previousSkipStartupCleanup;
    if (previousDisableCleanupTimer === undefined) delete process.env.AGENT_INTERCOM_DISABLE_CLEANUP_TIMER;
    else process.env.AGENT_INTERCOM_DISABLE_CLEANUP_TIMER = previousDisableCleanupTimer;
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
    let unitStopped = false;
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
          unitStopped = true;
        }
        if (command === "systemctl" && args.includes("show")) {
          return unitStopped
            ? { ...commandResult(), stdout: "LoadState=not-found\nActiveState=inactive\nSubState=dead\nJob=\n" }
            : { ...commandResult(), stdout: "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=123\nJob=\nExecMainStartTimestampMonotonic=10\n" };
        }
        if (command === "systemd-cgls") return { ...commandResult(), code: 1, stderr: "unit not found" };
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
    assert.equal(saved.workers[0].lastAuthenticatedIntercomActivityAt, saved.workers[0].lastWorkerActivityAt);
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
    const eventListeners = new Map<string, Array<(payload: any) => void>>();
    const pi: any = {
      on(name: string, handler: (...args: any[]) => any) { lifecycle.set(name, handler); },
      events: {
        on(name: string, handler: (payload: any) => void) {
          const listeners = eventListeners.get(name) ?? [];
          listeners.push(handler);
          eventListeners.set(name, listeners);
          return () => eventListeners.set(name, listeners.filter((candidate) => candidate !== handler));
        },
        emit(name: string, payload: any) {
          if (name === "intercom:control:send" && payload?.control?.type === "agent-intercom.orchestrator/readiness-probe") {
            queueMicrotask(() => {
              for (const listener of eventListeners.get("intercom:control") ?? []) listener({
                from: { id: payload.to },
                control: {
                  type: "agent-intercom.orchestrator/readiness-ack",
                  version: 1,
                  data: { requestId: payload.control.data.requestId, runId: payload.control.data.expectedRunId },
                },
              });
            });
          }
        },
      },
      registerTool(tool: any) { tools.set(tool.name, tool); },
      registerCommand() {},
      async exec(command: string, args: string[]) {
        if (command === "systemd-run") {
          launches += 1;
          await new Promise((resolve) => setTimeout(resolve, 30));
          return commandResult();
        }
        if (command === "systemctl" && args.includes("show") && args.some((arg) => arg.startsWith("--property=LoadState,ActiveState,SubState,MainPID,Result,ExecMainStatus"))) {
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
        if (command === "systemctl" && args.includes("show") && args.some((arg) => arg.startsWith("--property=LoadState,ActiveState,SubState,MainPID,Result,ExecMainStatus"))) {
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
    assert.ok(tools.has("boss"));
    assert.match(tools.get("boss").promptGuidelines.join("\n"), /do not ask the user to type \/boss/i);
    assert.match(JSON.stringify(tools.get("boss").parameters), /bossRunId/);
    const bossStatus = await tools.get("boss").execute(
      "boss-status-test",
      { action: "status" },
      new AbortController().signal,
      () => {},
      ctx,
    );
    assert.match(bossStatus.content[0].text, /TRUSTED LOCAL MODE/);
    assert.match(bossStatus.content[0].text, /No Boss runs are owned by this Controller/);
    assert.match(tools.get("agent_fleet").promptGuidelines.join("\n"), /returned intercomTarget/);
    assert.match(tools.get("agent_fleet").promptGuidelines.join("\n"), /progress\/status checkpoints/);
    assert.match(tools.get("agent_fleet").promptGuidelines.join("\n"), /create the feature worktree before spawning/i);
    assert.match(JSON.stringify(tools.get("agent_fleet").parameters), /versions/);
    assert.match(JSON.stringify(tools.get("agent_fleet").parameters), /update/);
    assert.match(JSON.stringify(tools.get("agent_fleet").parameters), /permissionProfile/);
    for (const command of ["boss", "agents-new", "agents-config", "agents-models", "agents-cleanup"]) {
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
        "codex-custom": { harness: "codex", command: "/bin/true", mode: "persistent", maxRuntime: "12h" },
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
      async exec(command: string, args: string[]) {
        if (command === "systemd-run") {
          launches += 1;
          const environment = Object.fromEntries(args
            .filter((arg) => arg.startsWith("--setenv="))
            .map((arg) => {
              const value = arg.slice("--setenv=".length);
              const separator = value.indexOf("=");
              return [value.slice(0, separator), value.slice(separator + 1)];
            }));
          if (environment.AGENT_INTERCOM_ADAPTER_HEALTH_PATH) {
            await mkdir(dirname(environment.AGENT_INTERCOM_ADAPTER_HEALTH_PATH), { recursive: true });
            await writeFile(environment.AGENT_INTERCOM_ADAPTER_HEALTH_PATH, JSON.stringify({
              version: 1,
              runId: environment.AGENT_INTERCOM_RUN_ID,
              ready: true,
              connected: true,
              status: "idle",
            }));
          }
        }
        if (command === "systemctl" && args.includes("show")) {
          return { ...commandResult(), stdout: "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=123\nResult=success\nExecMainStatus=0\nJob=\nExecMainStartTimestampMonotonic=10\n" };
        }
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

    const customSpawn = await fleet.execute("spawn-custom", {
      action: "spawn", id: "custom-worker", profile: "codex-custom", task: "Use a custom adapter.", cwd: "/tmp", permissionProfile: "trusted",
    }, new AbortController().signal, () => {}, ctx);
    assert.equal(customSpawn.details.worker.state, "registering");
    assert.equal(customSpawn.details.worker.backendDetails.readiness, "process-stable-unverified");
    assert.match(customSpawn.content[0].text, /Launched custom-worker/);
    assert.match(customSpawn.content[0].text, /did not produce a persistent readiness acknowledgment/);
    assert.equal(launches, 3);

    assert.doesNotMatch(fleet.promptGuidelines.join("\n"), /Ralph loop|return_on|cannot wake the manager/i);
    assert.match(fleet.promptGuidelines.join("\n"), /Harnesses configured as explicit-only: opencode/);

    await lifecycle.get("session_shutdown")?.({ reason: "reload" }, ctx);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  }
});

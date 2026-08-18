import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkerStore } from "../src/store.ts";
import type { WorkerRecordV3 } from "../src/types.ts";

const unit = "agent-intercom-worker-recovered-inc-1.service";
const worker: WorkerRecordV3 = {
  id: "recovered", runId: "inc-1", workerIncarnationId: "inc-1", workerGeneration: 1,
  harness: "codex", backend: "systemd", role: "builder", task: "recover registry", cwd: "/tmp",
  state: "working", owned: true,
  managerOwner: { context: "pi", principalId: "registry-manager", sessionId: "registry-manager", bindingEpoch: 1 },
  managerSessionId: "registry-manager", unit, createdAt: 1, updatedAt: 2, leaseExpiresAt: Date.now() + 60_000,
};

function commandResult(stdout = "", code = 0) {
  return { stdout, stderr: "", code, killed: false };
}

async function fixture(identityIncarnation = "inc-1", unitStatus?: string, record: WorkerRecordV3 = worker) {
  const agentDir = await mkdtemp(join(tmpdir(), "orcboss-registry-extension-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const orchestratorDir = join(agentDir, "intercom", "orchestrator");
  await mkdir(orchestratorDir, { recursive: true });
  const store = new WorkerStore(join(orchestratorDir, "workers.json"));
  await store.upsert(record);
  await store.mutate((state) => { state.workers = []; });

  const lifecycle = new Map<string, (...args: any[]) => any>();
  const tools = new Map<string, any>();
  const pi: any = {
    on(name: string, handler: (...args: any[]) => any) { lifecycle.set(name, handler); },
    events: { on() { return () => {}; }, emit() {} },
    registerTool(tool: any) { tools.set(tool.name, tool); },
    registerCommand() {},
    async exec(command: string, args: string[]) {
      if (command === "systemctl" && args.includes("list-units")) return commandResult(`${unit} loaded active running worker\n`);
      if (command === "systemctl" && args.includes("show") && args.includes(unit)) {
        const environment = [
          "AGENT_INTERCOM_OWNED=1", "AGENT_INTERCOM_WORKER_ID=recovered",
          `AGENT_INTERCOM_RUN_ID=${identityIncarnation}`, `AGENT_INTERCOM_SYSTEMD_UNIT=${unit}`,
          "AGENT_INTERCOM_MANAGER_SESSION_ID=registry-manager", "AGENT_INTERCOM_MANAGER_CONTEXT=pi",
        ].join(" ");
        return commandResult(unitStatus ?? `LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=4242\nResult=success\nExecMainStatus=0\nEnvironment=${environment}\n`);
      }
      return commandResult();
    },
  };
  const ctx: any = {
    cwd: "/tmp", mode: "rpc", hasUI: false,
    sessionManager: { getSessionId: () => "registry-manager", getSessionFile: () => undefined },
    ui: { setStatus() {}, notify() {} },
  };
  const { default: extension } = await import(new URL(`../src/index.ts?registry-extension=${identityIncarnation}-${Date.now()}`, import.meta.url).href);
  extension(pi);
  const cleanup = async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(agentDir, { recursive: true, force: true });
  };
  return { agentDir, store, lifecycle, tools, ctx, cleanup };
}

test("extension startup exactly restores an overwritten empty registry", async () => {
  const setup = await fixture();
  try {
    await setup.lifecycle.get("session_start")?.({}, setup.ctx);
    const result = await setup.tools.get("agent_fleet").execute("list-recovered", { action: "list" }, new AbortController().signal, () => {}, setup.ctx);
    assert.equal(result.details.degraded, undefined);
    assert.deepEqual(result.details.workers.map((entry: any) => entry.id), ["recovered"]);
    assert.deepEqual((await setup.store.read()).workers.map((entry) => entry.id), ["recovered"]);
  } finally { await setup.cleanup(); }
});

test("restored live workers receive a fresh cleanup grace window", async () => {
  const expiredAt = Date.now() - 60_000;
  const setup = await fixture("inc-1", undefined, {
    ...worker,
    updatedAt: expiredAt,
    leaseExpiresAt: expiredAt,
    lastWorkerActivityAt: expiredAt,
    idleDeadlineAt: expiredAt,
    checkpointDeadlineAt: expiredAt,
  });
  try {
    const before = Date.now();
    await setup.lifecycle.get("session_start")?.({}, setup.ctx);
    const restored = (await setup.store.read()).workers[0];
    assert.ok(restored.leaseExpiresAt > before);
    assert.ok(restored.idleDeadlineAt! > before);
    assert.ok(restored.checkpointDeadlineAt! > restored.idleDeadlineAt!);
    assert.ok(restored.lastWorkerActivityAt! >= before);
  } finally { await setup.cleanup(); }
});

test("healthy startup clears a stale degraded diagnostic left by a prior process", async () => {
  const setup = await fixture();
  const diagnosticPath = join(setup.agentDir, "intercom", "orchestrator", "worker-registry-diagnostic.json");
  try {
    const empty = await setup.store.read();
    const snapshot = await setup.store.readRecoverySnapshot();
    assert.ok(snapshot);
    await setup.store.restoreEmptyFromRecovery(empty.generation, snapshot.stateDigest);
    await writeFile(diagnosticPath, JSON.stringify({ version: 1, degraded: true, reason: "stale restart diagnostic", untrackedLiveUnits: [unit] }));

    await setup.lifecycle.get("session_start")?.({}, setup.ctx);
    await assert.rejects(() => readFile(diagnosticPath, "utf8"), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
  } finally { await setup.cleanup(); }
});

test("transitional managed units degrade startup instead of appearing absent", async () => {
  const setup = await fixture("inc-1", "LoadState=loaded\nActiveState=activating\nSubState=start\nMainPID=0\nJob=77/start\n");
  try {
    await setup.lifecycle.get("session_start")?.({}, setup.ctx);
    const listed = await setup.tools.get("agent_fleet").execute("list-transitional", { action: "list" }, new AbortController().signal, () => {}, setup.ctx);
    assert.equal(listed.details.degraded, true);
    assert.deepEqual(listed.details.untrackedLiveUnits, [unit]);
    assert.match(listed.details.reason, /transitional|indeterminate/);
  } finally { await setup.cleanup(); }
});

test("identity mismatch exposes degraded list output and fences every fleet mutation", async () => {
  const setup = await fixture("replacement-incarnation");
  try {
    await setup.lifecycle.get("session_start")?.({}, setup.ctx);
    const fleet = setup.tools.get("agent_fleet");
    const listed = await fleet.execute("list-degraded", { action: "list" }, new AbortController().signal, () => {}, setup.ctx);
    assert.equal(listed.details.degraded, true);
    assert.deepEqual(listed.details.untrackedLiveUnits, [unit]);
    assert.match(listed.content[0].text, /Unsafe worker mutations are blocked/);
    const mutations = [
      { action: "spawn", harness: "pi", id: "new", cwd: "/tmp", task: "blocked" },
      { action: "stop", id: "recovered" },
      { action: "cleanup", execute: true },
      { action: "prune", execute: true, acknowledge: true },
      { action: "renew", id: "recovered" },
      { action: "forget", id: "recovered" },
      { action: "adopt", id: "recovered" },
    ];
    for (const params of mutations) {
      await assert.rejects(
        fleet.execute(`blocked-${params.action}`, params, new AbortController().signal, () => {}, setup.ctx),
        /Worker registry is degraded/,
        `${params.action} must fail at registry admission`,
      );
    }
    const diagnostic = JSON.parse(await readFile(join(setup.agentDir, "intercom", "orchestrator", "worker-registry-diagnostic.json"), "utf8"));
    assert.deepEqual(diagnostic.untrackedLiveUnits, [unit]);
  } finally { await setup.cleanup(); }
});

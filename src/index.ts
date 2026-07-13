import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { readConfig, resolveProfileCommand } from "./config.ts";
import { callSubagentRpc, findRunId } from "./pi-subagents.ts";
import { WorkerStore } from "./store.ts";
import {
  getUnitStatus,
  launchUnit,
  makeUnitName,
  readUnitLogs,
  stopUnit,
  systemdAvailable,
} from "./systemd.ts";
import type {
  CommandRunner,
  Harness,
  OrchestratorConfig,
  WorkerRecord,
  WorkerStateFile,
} from "./types.ts";
import {
  buildWorkerArgs,
  buildWorkerEnvironment,
  cleanupReason,
  createSystemdRecord,
  isLiveState,
  leaseExpiry,
  newRunId,
  stateFromUnit,
  validateWorkerId,
} from "./workers.ts";

const ACTIONS = ["spawn", "list", "status", "stop", "cleanup", "doctor", "logs", "renew", "forget"] as const;
const HARNESSES = ["pi", "codex", "claude", "opencode"] as const;
const STATUS_KEY = "agent-intercom-orchestrator";

const AgentFleetParams = Type.Object({
  action: StringEnum(ACTIONS),
  id: Type.Optional(Type.String({ description: "Stable worker id" })),
  harness: Type.Optional(StringEnum(HARNESSES)),
  role: Type.Optional(Type.String({ description: "Worker role, for example builder or challenger" })),
  task: Type.Optional(Type.String({ description: "Assignment to record for the worker" })),
  cwd: Type.Optional(Type.String({ description: "Worker working directory" })),
  profile: Type.Optional(Type.String({ description: "Configured external launch profile" })),
  agent: Type.Optional(Type.String({ description: "pi-subagents agent name when harness=pi" })),
  execute: Type.Optional(Type.Boolean({ description: "Actually execute cleanup; false previews it" })),
  lines: Type.Optional(Type.Number({ description: "Journal lines for logs (1-500)" })),
});

type FleetParams = {
  action: typeof ACTIONS[number];
  id?: string;
  harness?: Harness;
  role?: string;
  task?: string;
  cwd?: string;
  profile?: string;
  agent?: string;
  execute?: boolean;
  lines?: number;
};

function textResult(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

function managerSessionId(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId() || ctx.sessionManager.getSessionFile() || `process-${process.pid}`;
}

function runnerFor(pi: ExtensionAPI): CommandRunner {
  return {
    async exec(command, args, options) {
      const result = await pi.exec(command, args, options);
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.code,
        killed: result.killed,
      };
    },
  };
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function formatWorker(worker: WorkerRecord): string {
  const target = worker.intercomTarget ? ` target=${worker.intercomTarget}` : "";
  const unit = worker.unit ? ` unit=${worker.unit}` : "";
  const error = worker.lastError ? ` error=${worker.lastError}` : "";
  return `${worker.id} [${worker.harness}/${worker.role}] ${worker.state}${target}${unit} lease=${formatTime(worker.leaseExpiresAt)}${error}`;
}

function formatWorkers(workers: WorkerRecord[]): string {
  if (workers.length === 0) return "No managed workers.";
  return workers.map(formatWorker).join("\n");
}

function extractWorkers(state: WorkerStateFile, id?: string): WorkerRecord[] {
  if (!id) return [...state.workers];
  const worker = state.workers.find((candidate) => candidate.id === id);
  if (!worker) throw new Error(`Unknown managed worker: ${id}`);
  return [worker];
}

export default function agentIntercomOrchestrator(pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  const configPath = join(agentDir, "intercom", "orchestrator", "config.json");
  const statePath = join(agentDir, "intercom", "orchestrator", "workers.json");
  const store = new WorkerStore(statePath);
  const runner = runnerFor(pi);
  let config: OrchestratorConfig;
  let currentCtx: ExtensionContext | undefined;
  let heartbeat: NodeJS.Timeout | undefined;

  const loadConfig = async () => {
    config = await readConfig(configPath);
    return config;
  };

  const updateStatus = async (ctx = currentCtx) => {
    if (!ctx) return;
    const state = await store.read();
    const running = state.workers.filter((worker) => isLiveState(worker.state)).length;
    const stale = state.workers.filter((worker) => cleanupReason(worker)).length;
    const text = running === 0 && stale === 0 ? undefined : `agents ${running}${stale ? ` · stale ${stale}` : ""}`;
    ctx.ui.setStatus(STATUS_KEY, text);
  };

  const reconcile = async (): Promise<WorkerRecord[]> => {
    const state = await store.read();
    let changed = false;
    for (const worker of state.workers) {
      if (worker.backend !== "systemd" || !worker.unit) continue;
      const status = await getUnitStatus(runner, worker.unit);
      const nextState = stateFromUnit(status, worker.state);
      if (nextState !== worker.state || status.mainPid !== worker.mainPid) {
        worker.state = nextState;
        worker.mainPid = status.mainPid;
        worker.updatedAt = Date.now();
        if (nextState === "failed") worker.lastError = status.result || `service exited with ${status.execMainStatus ?? "unknown status"}`;
        changed = true;
      }
    }
    if (changed) await store.write(state);
    await updateStatus();
    return state.workers;
  };

  const stopWorker = async (worker: WorkerRecord): Promise<void> => {
    worker.state = "stopping";
    worker.updatedAt = Date.now();
    await store.upsert(worker);
    try {
      if (worker.backend === "systemd" && worker.unit) {
        await stopUnit(runner, worker.unit);
      } else if (worker.backend === "pi-subagents" && worker.externalRunId) {
        await callSubagentRpc(pi, "stop", { id: worker.externalRunId }, 8000);
      }
      worker.state = "stopped";
      worker.updatedAt = Date.now();
      worker.lastError = undefined;
    } catch (error) {
      worker.state = "failed";
      worker.updatedAt = Date.now();
      worker.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      await store.upsert(worker);
      await updateStatus();
    }
  };

  const cleanupExpired = async (execute: boolean, now = Date.now()) => {
    const workers = await reconcile();
    const candidates = workers
      .map((worker) => ({ worker, reason: cleanupReason(worker, now) }))
      .filter((item): item is { worker: WorkerRecord; reason: string } => Boolean(item.reason));
    if (execute) {
      for (const { worker } of candidates) await stopWorker(worker);
    }
    return candidates;
  };

  const spawnPi = async (params: FleetParams, ctx: ExtensionContext): Promise<WorkerRecord> => {
    const id = validateWorkerId(params.id || `pi-${params.role || params.agent || "worker"}-${newRunId().slice(0, 6)}`);
    const task = params.task?.trim();
    if (!task) throw new Error("spawn requires task");
    const agent = params.agent?.trim() || "worker";
    const cwd = resolve(ctx.cwd, params.cwd || ".");
    const existing = (await store.read()).workers.find((worker) => worker.id === id && isLiveState(worker.state));
    if (existing) throw new Error(`Worker ${id} is already ${existing.state}`);
    const response = await callSubagentRpc(pi, "spawn", { agent, task, cwd, async: true, clarify: false }, 15000);
    const externalRunId = findRunId(response) || id;
    const now = Date.now();
    const worker: WorkerRecord = {
      id,
      runId: newRunId(),
      harness: "pi",
      backend: "pi-subagents",
      role: params.role?.trim() || agent,
      task,
      cwd,
      state: "running",
      owned: true,
      managerSessionId: managerSessionId(ctx),
      externalRunId,
      createdAt: now,
      updatedAt: now,
      leaseExpiresAt: leaseExpiry(config, now),
      backendDetails: response,
    };
    await store.upsert(worker);
    return worker;
  };

  const spawnExternal = async (params: FleetParams, ctx: ExtensionContext): Promise<WorkerRecord> => {
    const harness = params.harness && params.harness !== "pi" ? params.harness : undefined;
    if (!harness) throw new Error("External spawn requires harness=codex, claude, or opencode");
    const role = params.role?.trim() || "worker";
    const id = validateWorkerId(params.id || `${harness}-${role}-${newRunId().slice(0, 6)}`);
    const task = params.task?.trim();
    if (!task) throw new Error("spawn requires task");
    const cwd = resolve(ctx.cwd, params.cwd || ".");
    const profileName = params.profile || config.defaultProfiles[harness];
    if (!profileName) throw new Error(`No default profile configured for ${harness}`);
    const profile = config.profiles[profileName];
    if (!profile) throw new Error(`Unknown launch profile: ${profileName}`);
    if (profile.harness !== harness) throw new Error(`Profile ${profileName} launches ${profile.harness}, not ${harness}`);
    if (profile.spawnable === false) throw new Error(profile.description || `Profile ${profileName} is attach-only`);
    const existing = (await store.read()).workers.find((worker) => worker.id === id && isLiveState(worker.state));
    if (existing) throw new Error(`Worker ${id} is already ${existing.state}`);

    const runId = newRunId();
    const unit = makeUnitName(id, runId);
    const worker = createSystemdRecord({
      id,
      runId,
      harness,
      role,
      task,
      cwd,
      profile: profileName,
      unit,
      managerSessionId: managerSessionId(ctx),
      config,
    });
    await store.upsert(worker);
    try {
      await launchUnit(runner, {
        unit,
        profile,
        args: buildWorkerArgs(harness, profile, id, cwd, role),
        cwd,
        maxRuntime: config.maxRuntime,
        stopTimeoutSeconds: config.stopTimeoutSeconds,
        environment: buildWorkerEnvironment(harness, id, role),
      });
      const status = await getUnitStatus(runner, unit);
      worker.state = stateFromUnit(status, "provisioning");
      worker.mainPid = status.mainPid;
      worker.updatedAt = Date.now();
      await store.upsert(worker);
      return worker;
    } catch (error) {
      worker.state = "failed";
      worker.updatedAt = Date.now();
      worker.lastError = error instanceof Error ? error.message : String(error);
      await store.upsert(worker);
      throw error;
    }
  };

  pi.registerTool({
    name: "agent_fleet",
    label: "Agent Fleet",
    description:
      "Create and manage owned Pi, Codex, Claude Code, and OpenCode workers. External workers run in systemd user services so their sidecars and child processes can be stopped as one cgroup. Use spawn, list, status, stop, cleanup, doctor, logs, renew, or forget. External spawn records the assignment but does not send it yet; after spawn, use the intercom tool to send the task to the returned intercom target.",
    promptSnippet: "Create, inspect, stop, and clean up owned cross-harness workers",
    promptGuidelines: [
      "Use agent_fleet to create or stop persistent workers; do not launch coi, cci, OpenCode, tmux, or sidecars directly when agent_fleet can own their lifecycle.",
      "After agent_fleet spawns an external worker, wait for it to appear in intercom list and send the recorded task with intercom send.",
      "Use agent_fleet cleanup in preview mode before execute mode, and never kill sessions the fleet does not own.",
    ],
    parameters: AgentFleetParams,

    async execute(_toolCallId, params: FleetParams, signal, onUpdate, ctx) {
      if (!config) await loadConfig();
      if (signal?.aborted) throw new Error("Agent fleet action cancelled");

      if (params.action === "spawn") {
        const harness = params.harness || config.defaultHarness;
        onUpdate?.(textResult(`Starting ${harness} worker...`));
        const worker = harness === "pi"
          ? await spawnPi({ ...params, harness }, ctx)
          : await spawnExternal({ ...params, harness }, ctx);
        await updateStatus(ctx);
        const next = worker.backend === "systemd"
          ? `\nNext: wait for '${worker.intercomTarget}' in intercom list, then send this task with intercom send:\n${worker.task}`
          : "";
        return textResult(`Started ${formatWorker(worker)}${next}`, { worker });
      }

      if (params.action === "list") {
        return textResult(formatWorkers(await reconcile()), { workers: await store.read().then((state) => state.workers) });
      }

      if (params.action === "status") {
        const workers = extractWorkers({ version: 1, workers: await reconcile() }, params.id);
        if (workers.length === 1 && workers[0].backend === "pi-subagents" && workers[0].externalRunId) {
          try {
            workers[0].backendDetails = await callSubagentRpc(pi, "status", { id: workers[0].externalRunId }, 8000);
            workers[0].updatedAt = Date.now();
            await store.upsert(workers[0]);
          } catch (error) {
            workers[0].lastError = error instanceof Error ? error.message : String(error);
          }
        }
        return textResult(formatWorkers(workers), { workers });
      }

      if (params.action === "stop") {
        if (!params.id) throw new Error("stop requires id");
        const worker = extractWorkers(await store.read(), params.id)[0];
        if (!worker.owned) throw new Error(`Worker ${worker.id} is not owned by this orchestrator`);
        await stopWorker(worker);
        return textResult(`Stopped ${worker.id}.`, { worker });
      }

      if (params.action === "cleanup") {
        const candidates = await cleanupExpired(Boolean(params.execute));
        if (candidates.length === 0) return textResult("No owned workers have expired leases.", { candidates: [] });
        const lines = candidates.map(({ worker, reason }) => `${worker.id}: ${reason}`);
        return textResult(
          `${params.execute ? "Cleaned" : "Cleanup preview"}:\n${lines.join("\n")}${params.execute ? "" : "\nRun cleanup with execute=true to stop these owned workers."}`,
          { candidates },
        );
      }

      if (params.action === "doctor") {
        const available = await systemdAvailable(runner);
        const profileLines = Object.entries(config.profiles).map(([name, profile]) => {
          const resolved = resolveProfileCommand(profile.command);
          return `${name} [${profile.harness}] ${profile.spawnable === false ? "attach-only" : resolved ? `ok: ${resolved}` : `missing: ${profile.command}`}`;
        });
        let subagents = "unavailable";
        try {
          await callSubagentRpc(pi, "ping", undefined, 2000);
          subagents = "available";
        } catch {
          // Optional integration.
        }
        return textResult(
          [
            `systemd user manager: ${available ? "available" : "unavailable"}`,
            `pi-subagents RPC: ${subagents}`,
            `config: ${configPath}`,
            `state: ${statePath}`,
            ...profileLines,
          ].join("\n"),
          { systemd: available, piSubagents: subagents, configPath, statePath },
        );
      }

      if (params.action === "logs") {
        if (!params.id) throw new Error("logs requires id");
        const worker = extractWorkers(await store.read(), params.id)[0];
        if (!worker.unit) throw new Error(`Worker ${worker.id} does not use a systemd unit`);
        return textResult(await readUnitLogs(runner, worker.unit, params.lines), { worker });
      }

      if (params.action === "renew") {
        const workers = extractWorkers(await store.read(), params.id);
        const now = Date.now();
        for (const worker of workers) {
          if (!worker.owned || !isLiveState(worker.state)) continue;
          worker.leaseExpiresAt = leaseExpiry(config, now);
          worker.updatedAt = now;
          await store.upsert(worker);
        }
        await updateStatus(ctx);
        return textResult(`Renewed ${workers.length} worker lease${workers.length === 1 ? "" : "s"}.`, { workers });
      }

      if (params.action === "forget") {
        if (!params.id) throw new Error("forget requires id");
        const worker = extractWorkers(await store.read(), params.id)[0];
        if (isLiveState(worker.state)) throw new Error(`Refusing to forget live worker ${worker.id}; stop it first`);
        await store.remove(worker.id);
        await updateStatus(ctx);
        return textResult(`Forgot worker record ${worker.id}.`);
      }

      throw new Error(`Unsupported action: ${params.action}`);
    },

    renderCall(args, theme) {
      const id = args.id ? ` ${args.id}` : "";
      const harness = args.harness ? ` [${args.harness}]` : "";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("agent_fleet "))}${theme.fg("accent", args.action)}${theme.fg("muted", `${id}${harness}`)}`,
        0,
        0,
      );
    },

    renderResult(result, { isPartial }, theme) {
      const first = result.content[0];
      const text = first?.type === "text" ? first.text : "(no output)";
      return new Text(theme.fg(isPartial ? "warning" : "toolOutput", text), 0, 0);
    },
  });

  pi.registerCommand("agents", {
    description: "Show managed Agent Intercom workers",
    handler: async (_args, ctx) => {
      if (!config) await loadConfig();
      const workers = await reconcile();
      if (ctx.hasUI) await ctx.ui.editor("Managed workers", formatWorkers(workers));
      else ctx.ui.notify(formatWorkers(workers), "info");
    },
  });

  pi.registerCommand("agents-cleanup", {
    description: "Preview or execute cleanup of owned workers with expired leases",
    handler: async (args, ctx) => {
      if (!config) await loadConfig();
      const execute = args.trim() === "execute" || args.trim() === "--execute";
      const candidates = await cleanupExpired(false);
      if (candidates.length === 0) {
        ctx.ui.notify("No owned workers have expired leases.", "info");
        return;
      }
      const summary = candidates.map(({ worker, reason }) => `${worker.id}: ${reason}`).join("\n");
      if (!execute) {
        if (ctx.hasUI) await ctx.ui.editor("Cleanup preview", `${summary}\n\nRun /agents-cleanup execute to stop them.`);
        return;
      }
      if (ctx.hasUI && !(await ctx.ui.confirm("Stop expired workers?", summary))) return;
      await cleanupExpired(true);
      ctx.ui.notify(`Stopped ${candidates.length} expired worker${candidates.length === 1 ? "" : "s"}.`, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    await loadConfig();
    await reconcile();
    if (config.cleanupExpiredOnStart) await cleanupExpired(true);
    clearInterval(heartbeat);
    heartbeat = setInterval(() => {
      const sessionId = managerSessionId(ctx);
      const now = Date.now();
      void store.mutate((state) => {
        for (const worker of state.workers) {
          if (worker.managerSessionId !== sessionId || !worker.owned || !isLiveState(worker.state)) continue;
          worker.leaseExpiresAt = leaseExpiry(config, now);
          worker.updatedAt = now;
        }
      }).then(() => updateStatus(ctx)).catch(() => undefined);
    }, Math.max(10, config.heartbeatSeconds) * 1000);
    heartbeat.unref?.();
  });

  pi.on("session_shutdown", async (event, ctx) => {
    clearInterval(heartbeat);
    heartbeat = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    if (config?.cleanupOnShutdown && event.reason !== "reload") {
      const sessionId = managerSessionId(ctx);
      const state = await store.read();
      for (const worker of state.workers) {
        if (worker.managerSessionId === sessionId && worker.owned && isLiveState(worker.state)) {
          try {
            await stopWorker(worker);
          } catch {
            // Failure is persisted on the worker record and reconciled next startup.
          }
        }
      }
    }
    currentCtx = undefined;
  });
}

import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { readConfig, resolveProfileCommand, writeConfigDefaults } from "./config.ts";
import { WorkerStore } from "./store.ts";
import { getUnitStatus, launchUnit, listWorkerUnits, makeUnitName, parseDurationToSeconds, readUnitLogs, stopUnit, systemdAvailable } from "./systemd.ts";
import type { CommandRunner, Effort, Harness, OrchestratorConfig, RolePreset, WorkerRecord, WorkerStateFile } from "./types.ts";
import {
  buildWorkerArgs,
  buildWorkerEnvironment,
  cleanupReason,
  createSystemdRecord,
  HARNESS_EFFORTS,
  isLiveState,
  leaseExpiry,
  newRunId,
  normalizeModelForHarness,
  stateFromUnit,
  validateEffort,
  validateWorkerId,
} from "./workers.ts";

const ACTIONS = [
  "spawn",
  "list",
  "status",
  "stop",
  "cleanup",
  "doctor",
  "logs",
  "renew",
  "forget",
  "adopt",
  "capabilities",
  "profiles",
  "models",
  "config",
] as const;
const HARNESSES = ["pi", "codex", "claude", "opencode"] as const;
const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const STATUS_KEY = "agent-intercom-orchestrator";
const PI_PEER_LAUNCHER = fileURLToPath(new URL("./pi-peer-launcher.mjs", import.meta.url));
const OPENCODE_PEER_LAUNCHER = fileURLToPath(new URL("./opencode-peer-launcher.mjs", import.meta.url));

const AgentFleetParams = Type.Object({
  action: StringEnum(ACTIONS),
  id: Type.Optional(Type.String({ description: "Stable worker id" })),
  harness: Type.Optional(StringEnum(HARNESSES)),
  role: Type.Optional(Type.String({ description: "Worker role or configured role preset, for example advisor or challenger" })),
  task: Type.Optional(Type.String({ description: "Assignment or standing mandate for the worker" })),
  cwd: Type.Optional(Type.String({ description: "Worker working directory" })),
  profile: Type.Optional(Type.String({ description: "Configured launch profile" })),
  model: Type.Optional(Type.String({ description: "Harness model name or provider/model identifier" })),
  effort: Type.Optional(StringEnum(EFFORTS)),
  instructions: Type.Optional(Type.String({ description: "Additional standing instructions for the coworker" })),
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
  model?: string;
  effort?: Effort;
  instructions?: string;
  execute?: boolean;
  lines?: number;
};

type ResolvedSpawn = {
  harness: Harness;
  role: string;
  task: string;
  cwd: string;
  profileName: string;
  model?: string;
  effort?: Effort;
  instructions?: string;
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
      return { stdout: result.stdout, stderr: result.stderr, code: result.code, killed: result.killed };
    },
  };
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function formatWorker(worker: WorkerRecord): string {
  const target = worker.intercomTarget ? ` target=${worker.intercomTarget}` : "";
  const unit = worker.unit ? ` unit=${worker.unit}` : "";
  const model = worker.model ? ` model=${worker.model}` : "";
  const effort = worker.effort ? ` effort=${worker.effort}` : "";
  const error = worker.lastError ? ` error=${worker.lastError}` : "";
  return `${worker.id} [${worker.harness}/${worker.role}] ${worker.state}${model}${effort}${target}${unit} lease=${formatTime(worker.leaseExpiresAt)}${error}`;
}

function formatWorkers(workers: WorkerRecord[]): string {
  return workers.length === 0 ? "No managed workers." : workers.map(formatWorker).join("\n");
}

export function workersAttachedToManager(workers: WorkerRecord[], sessionId: string): WorkerRecord[] {
  return workers.filter((worker) => worker.managerSessionId === sessionId);
}

function extractWorkers(state: WorkerStateFile, id?: string): WorkerRecord[] {
  if (!id) return [...state.workers];
  const worker = state.workers.find((candidate) => candidate.id === id);
  if (!worker) throw new Error(`Unknown managed worker: ${id}`);
  return [worker];
}

export function parsePiModels(output: string): string[] {
  const models = new Set<string>();
  for (const line of output.split("\n").slice(1)) {
    const match = line.trim().match(/^(\S+)\s+(\S+)\s+/);
    if (match) models.add(`${match[1]}/${match[2]}`);
  }
  return [...models];
}

function preferredFirst<T extends string>(items: T[], preferred?: T): T[] {
  return preferred && items.includes(preferred) ? [preferred, ...items.filter((item) => item !== preferred)] : items;
}

function configuredModels(config: OrchestratorConfig, harness: Harness): string[] {
  const models = new Set<string>();
  const direct = normalizeModelForHarness(harness, config.defaultModels[harness]);
  if (direct) models.add(direct);
  for (const role of Object.values(config.roles)) {
    const model = normalizeModelForHarness(harness, role.model);
    if ((!role.harness || role.harness === harness) && model) models.add(model);
  }
  return [...models];
}

function formatConfig(config: OrchestratorConfig, configPath: string): string {
  const lines = [`config: ${configPath}`, `default harness: ${config.defaultHarness}`];
  for (const harness of HARNESSES) {
    lines.push(
      `${harness}: profile=${config.defaultProfiles[harness] ?? "(none)"} model=${config.defaultModels[harness] ?? "(harness default)"} effort=${config.defaultEfforts[harness] ?? "(harness default)"}`,
    );
  }
  lines.push(`roles: ${Object.keys(config.roles).sort().join(", ") || "(none)"}`);
  lines.push(`lease=${config.leaseMinutes}m heartbeat=${config.heartbeatSeconds}s max-runtime=${config.maxRuntime}`);
  lines.push(`cleanup: startup=${config.cleanupExpiredOnStart} shutdown=${config.cleanupOnShutdown}`);
  return lines.join("\n");
}

export default function agentIntercomOrchestrator(pi: ExtensionAPI) {
  if (process.env.AGENT_INTERCOM_ORCHESTRATOR_DISABLED === "1") return;
  const agentDir = getAgentDir();
  const configPath = join(agentDir, "intercom", "orchestrator", "config.json");
  const statePath = join(agentDir, "intercom", "orchestrator", "workers.json");
  const store = new WorkerStore(statePath);
  const runner = runnerFor(pi);
  let config: OrchestratorConfig;
  let currentCtx: ExtensionContext | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  const modelCache = new Map<Harness, { expiresAt: number; models: string[] }>();

  const loadConfig = async () => {
    config = await readConfig(configPath);
    return config;
  };

  const updateStatus = async (ctx = currentCtx) => {
    if (!ctx) return;
    const state = await store.read();
    const attached = workersAttachedToManager(state.workers, managerSessionId(ctx));
    const running = attached.filter((worker) => isLiveState(worker.state)).length;
    const stale = attached.filter((worker) => cleanupReason(worker)).length;
    ctx.ui.setStatus(STATUS_KEY, running === 0 && stale === 0 ? undefined : `agents ${running}${stale ? ` · stale ${stale}` : ""}`);
  };

  const reconcile = async (): Promise<WorkerRecord[]> => {
    const snapshot = await store.read();
    const observations = await Promise.all(
      snapshot.workers
        .filter((worker): worker is WorkerRecord & { unit: string } => Boolean(worker.unit))
        .map(async (worker) => ({ id: worker.id, runId: worker.runId, unit: worker.unit, status: await getUnitStatus(runner, worker.unit) })),
    );
    const { workers, retireUnits } = await store.mutate((state) => {
      const retireUnits: string[] = [];
      for (const observation of observations) {
        const worker = state.workers.find((candidate) => candidate.id === observation.id && candidate.runId === observation.runId && candidate.unit === observation.unit);
        if (!worker) continue;
        const nextState = stateFromUnit(observation.status, worker.state);
        if (nextState !== worker.state || observation.status.mainPid !== worker.mainPid) {
          worker.state = nextState;
          worker.mainPid = observation.status.mainPid;
          worker.updatedAt = Date.now();
          if (nextState === "failed") worker.lastError = observation.status.result || `service exited with ${observation.status.execMainStatus ?? "unknown status"}`;
        }
        if (nextState === "completed" && observation.status.activeState === "active" && observation.status.subState === "exited") {
          retireUnits.push(observation.unit);
        }
      }
      return { workers: structuredClone(state.workers), retireUnits };
    });
    await Promise.allSettled(retireUnits.map((unit) => stopUnit(runner, unit)));
    await updateStatus();
    return workers;
  };

  const stopWorker = async (worker: WorkerRecord): Promise<void> => {
    worker.state = "stopping";
    worker.updatedAt = Date.now();
    await store.upsert(worker);
    try {
      if (worker.unit) await stopUnit(runner, worker.unit);
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
    if (execute) for (const { worker } of candidates) await stopWorker(worker);
    return candidates;
  };

  const enumerateModels = async (harness: Harness): Promise<string[]> => {
    const cached = modelCache.get(harness);
    if (cached && cached.expiresAt > Date.now()) return [...cached.models];
    const models = new Set(configuredModels(config, harness));
    if (harness === "opencode") {
      const profileName = config.defaultProfiles.opencode;
      const command = profileName ? config.profiles[profileName]?.command : "opencode";
      const executable = command ? resolveProfileCommand(command) : undefined;
      if (executable) {
        const result = await runner.exec(executable, ["models"], { timeout: 30000 });
        if (result.code === 0) for (const line of result.stdout.split("\n")) if (line.trim()) models.add(line.trim());
      }
    } else {
      const piProfileName = config.defaultProfiles.pi;
      const piCommand = piProfileName ? config.profiles[piProfileName]?.command : "pi";
      const executable = piCommand ? resolveProfileCommand(piCommand) : undefined;
      if (executable) {
        const result = await runner.exec(executable, ["--list-models"], { timeout: 30000 });
        if (result.code === 0) {
          for (const model of parsePiModels(result.stdout)) {
            if (harness === "pi") models.add(model);
            else if (model.startsWith(`${harness}/`)) models.add(normalizeModelForHarness(harness, model) ?? model);
          }
        }
      }
    }
    const result = [...models].sort();
    modelCache.set(harness, { expiresAt: Date.now() + 5 * 60_000, models: result });
    return [...result];
  };

  const resolveSpawn = (params: FleetParams, ctx: ExtensionContext): ResolvedSpawn => {
    const role = params.role?.trim() || "worker";
    const preset: RolePreset | undefined = config.roles[role];
    const harness = params.harness || preset?.harness || config.defaultHarness;
    const task = params.task?.trim();
    if (!task) throw new Error("spawn requires task");
    const profileName = params.profile || preset?.profile || config.defaultProfiles[harness];
    if (!profileName) throw new Error(`No default profile configured for ${harness}`);
    const model = normalizeModelForHarness(harness, params.model?.trim() || preset?.model || config.defaultModels[harness]);
    const effort = validateEffort(harness, params.effort || preset?.effort || config.defaultEfforts[harness]);
    const instructions = params.instructions?.trim() || preset?.instructions;
    return {
      harness,
      role,
      task,
      cwd: resolve(ctx.cwd, params.cwd || "."),
      profileName,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(instructions ? { instructions } : {}),
    };
  };

  const spawnWorker = async (params: FleetParams, ctx: ExtensionContext): Promise<WorkerRecord> => {
    const resolved = resolveSpawn(params, ctx);
    const { harness, role, task, cwd, profileName, model, effort, instructions } = resolved;
    const profile = config.profiles[profileName];
    if (!profile) throw new Error(`Unknown launch profile: ${profileName}`);
    if (profile.harness !== harness) throw new Error(`Profile ${profileName} launches ${profile.harness}, not ${harness}`);
    if (profile.spawnable === false) throw new Error(profile.description || `Profile ${profileName} is attach-only`);
    const id = validateWorkerId(params.id || `${harness}-${role}-${newRunId().slice(0, 6)}`);
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
      model,
      effort,
      instructions,
      unit,
      managerSessionId: managerSessionId(ctx),
      config,
    });
    await store.upsert(worker);
    try {
      const harnessArgs = buildWorkerArgs({ harness, profile, workerId: id, cwd, role, task, model, effort, instructions });
      const executable = resolveProfileCommand(profile.command);
      if (!executable) throw new Error(`Launch command not found or not executable: ${profile.command}`);
      const wrappedLauncher = harness === "pi"
        ? PI_PEER_LAUNCHER
        : harness === "opencode" && profile.mode === "persistent"
          ? OPENCODE_PEER_LAUNCHER
          : undefined;
      const launchProfile = wrappedLauncher ? { ...profile, command: process.execPath, args: undefined } : profile;
      const args = wrappedLauncher ? [wrappedLauncher, "--", executable, ...harnessArgs] : harnessArgs;
      await launchUnit(runner, {
        unit,
        profile: launchProfile,
        args,
        cwd,
        maxRuntime: profile.maxRuntime || config.maxRuntime,
        stopTimeoutSeconds: config.stopTimeoutSeconds,
        environment: buildWorkerEnvironment(harness, id, role, model),
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

  const formatCapabilities = (): string => HARNESSES.map((harness) => {
    const matching = Object.entries(config.profiles).filter(([, profile]) => profile.harness === harness);
    const profiles = matching.map(([name]) => name);
    const modes = [...new Set(matching.map(([, profile]) => profile.mode ?? "persistent"))];
    return `${harness}: modes=${modes.join(",") || "(none)"} efforts=${HARNESS_EFFORTS[harness].join(",")} profiles=${profiles.join(",") || "(none)"}`;
  }).join("\n");

  pi.registerTool({
    name: "agent_fleet",
    label: "Agent Fleet",
    description:
      "Create and manage owned independent Pi, Codex, Claude Code, and OpenCode coworkers. Workers run in systemd user services so their process trees are owned and cleanable. Supports normalized model/effort selection plus capabilities, profiles, models, and config enumeration.",
    promptSnippet: "Create, inspect, configure, stop, and clean up owned cross-harness coworkers",
    promptGuidelines: [
      "Pi workers are independent Intercom peers, not pi-subagents. Use role=advisor for a persistent Pi advisor coworker.",
      "After spawning Pi, Codex, or Claude workers, wait for them in intercom list and send the task. OpenCode workers receive the initial task at launch; persistent OpenCode peers remain wakeable afterward.",
      "Use capabilities, profiles, models, or config before guessing model names, effort levels, or defaults.",
      "Preview cleanup before execute=true, and never kill sessions the fleet does not own.",
    ],
    parameters: AgentFleetParams,

    async execute(_toolCallId, params: FleetParams, signal, onUpdate, ctx) {
      if (!config) await loadConfig();
      if (signal?.aborted) throw new Error("Agent fleet action cancelled");

      if (params.action === "spawn") {
        const preview = resolveSpawn(params, ctx);
        onUpdate?.(textResult(`Starting ${preview.harness}/${preview.role} coworker...`));
        const worker = await spawnWorker(params, ctx);
        await updateStatus(ctx);
        const mode = worker.profile ? config.profiles[worker.profile]?.mode : undefined;
        const next = worker.harness === "opencode"
          ? mode === "persistent"
            ? "\nThe task initialized this persistent OpenCode session. It remains wakeable through Intercom until stopped."
            : "\nThe task was passed to this one-shot OpenCode run as its initial prompt."
          : `\nNext: wait for '${worker.intercomTarget}' in intercom list, then send this task with intercom send or ask:\n${worker.task}`;
        return textResult(`Started ${formatWorker(worker)}${next}`, { worker });
      }

      if (params.action === "list") {
        const workers = await reconcile();
        return textResult(formatWorkers(workers), { workers });
      }

      if (params.action === "status") {
        const workers = extractWorkers({ version: 1, workers: await reconcile() }, params.id);
        return textResult(formatWorkers(workers), { workers });
      }

      if (params.action === "stop") {
        if (!params.id) throw new Error("stop requires id");
        const worker = extractWorkers(await store.read(), params.id)[0];
        if (!worker.owned) throw new Error(`Worker ${worker.id} is not owned by this orchestrator`);
        if (worker.managerSessionId !== managerSessionId(ctx)) throw new Error(`Worker ${worker.id} belongs to another manager session; adopt it before stopping`);
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
          return `${name} [${profile.harness}/${profile.mode ?? "persistent"}] ${profile.spawnable === false ? "attach-only" : resolved ? `ok: ${resolved}` : `missing: ${profile.command}`}`;
        });
        const opencodeProfileName = config.defaultProfiles.opencode;
        const opencodeCommand = opencodeProfileName ? resolveProfileCommand(config.profiles[opencodeProfileName]?.command || "") : undefined;
        let opencodeIntercomPlugin = "could not inspect";
        if (opencodeCommand) {
          const debugConfig = await runner.exec(opencodeCommand, ["debug", "config"], { timeout: 15000 });
          if (debugConfig.code === 0) {
            opencodeIntercomPlugin = /agent[-_]intercom[-_]opencode|opencode[-_]intercom/i.test(debugConfig.stdout)
              ? "configured"
              : "not detected — persistent OpenCode peers will not receive Intercom messages";
          }
        }
        const state = await store.read();
        const recordedUnits = new Set(state.workers.map((worker) => worker.unit).filter(Boolean));
        const units = available ? await listWorkerUnits(runner) : [];
        const untrackedUnits = units.filter((unit) => !recordedUnits.has(unit));
        return textResult(
          [`systemd user manager: ${available ? "available" : "unavailable"}`, `Pi peer launcher: ${PI_PEER_LAUNCHER}`, `OpenCode peer launcher: ${OPENCODE_PEER_LAUNCHER}`, `OpenCode Intercom plugin: ${opencodeIntercomPlugin}`, `config: ${configPath}`, `state: ${statePath}`, `untracked worker units: ${untrackedUnits.length ? untrackedUnits.join(", ") : "none"}`, ...profileLines].join("\n"),
          { systemd: available, piPeerLauncher: PI_PEER_LAUNCHER, opencodePeerLauncher: OPENCODE_PEER_LAUNCHER, opencodeIntercomPlugin, configPath, statePath, untrackedUnits },
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
          if (worker.managerSessionId !== managerSessionId(ctx)) throw new Error(`Worker ${worker.id} belongs to another manager session; adopt it before renewing`);
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
        if (isLiveState(worker.state)) {
          if (worker.managerSessionId !== managerSessionId(ctx)) throw new Error(`Worker ${worker.id} belongs to another manager session; adopt it before forgetting`);
          throw new Error(`Refusing to forget live worker ${worker.id}; stop it first`);
        }
        if (worker.unit) await stopUnit(runner, worker.unit);
        await store.remove(worker.id);
        await updateStatus(ctx);
        return textResult(`Forgot worker record ${worker.id}.`);
      }

      if (params.action === "adopt") {
        if (!params.id) throw new Error("adopt requires id");
        const worker = extractWorkers({ version: 1, workers: await reconcile() }, params.id)[0];
        if (!worker.owned) throw new Error(`Worker ${worker.id} was not created by this orchestrator`);
        if (!isLiveState(worker.state)) throw new Error(`Worker ${worker.id} is ${worker.state}; only live workers can be adopted`);
        worker.managerSessionId = managerSessionId(ctx);
        worker.leaseExpiresAt = leaseExpiry(config);
        worker.updatedAt = Date.now();
        await store.upsert(worker);
        await updateStatus(ctx);
        return textResult(`Adopted ${worker.id} into this manager session.`, { worker });
      }

      if (params.action === "capabilities") {
        return textResult(formatCapabilities(), { efforts: HARNESS_EFFORTS, roles: config.roles });
      }

      if (params.action === "profiles") {
        const profiles = Object.entries(config.profiles).filter(([, profile]) => !params.harness || profile.harness === params.harness);
        const text = profiles.length === 0 ? "No matching profiles." : profiles.map(([name, profile]) => `${name} [${profile.harness}/${profile.mode ?? "persistent"}] ${profile.description ?? profile.command}`).join("\n");
        return textResult(text, { profiles: Object.fromEntries(profiles) });
      }

      if (params.action === "models") {
        const harness = params.harness || config.defaultHarness;
        const models = await enumerateModels(harness);
        return textResult(models.length ? `${harness} models:\n${models.join("\n")}` : `No ${harness} models could be enumerated.`, { harness, models });
      }

      if (params.action === "config") return textResult(formatConfig(config, configPath), { config, configPath });
      throw new Error(`Unsupported action: ${params.action}`);
    },

    renderCall(args, theme) {
      const id = args.id ? ` ${args.id}` : "";
      const harness = args.harness ? ` [${args.harness}]` : "";
      return new Text(`${theme.fg("toolTitle", theme.bold("agent_fleet "))}${theme.fg("accent", args.action)}${theme.fg("muted", `${id}${harness}`)}`, 0, 0);
    },

    renderResult(result, { isPartial }, theme) {
      const first = result.content[0];
      const text = first?.type === "text" ? first.text : "(no output)";
      return new Text(theme.fg(isPartial ? "warning" : "toolOutput", text), 0, 0);
    },
  });

  pi.registerCommand("agents", {
    description: "Show coworkers attached to this Pi session; use /agents all for every managed worker",
    handler: async (args, ctx) => {
      if (!config) await loadConfig();
      const workers = await reconcile();
      const visible = args.trim().toLowerCase() === "all"
        ? workers
        : workersAttachedToManager(workers, managerSessionId(ctx));
      const text = formatWorkers(visible);
      if (ctx.hasUI) await ctx.ui.editor(args.trim().toLowerCase() === "all" ? "All managed coworkers" : "Coworkers attached to this Pi", text);
      else ctx.ui.notify(text, "info");
    },
  });

  pi.registerCommand("agents-models", {
    description: "Browse models available to a worker harness",
    handler: async (args, ctx) => {
      if (!config) await loadConfig();
      const requested = args.trim();
      const harness = HARNESSES.includes(requested as Harness) ? requested as Harness : config.defaultHarness;
      const models = await enumerateModels(harness);
      const text = models.length ? models.join("\n") : `No ${harness} models could be enumerated.`;
      if (ctx.hasUI) await ctx.ui.editor(`${harness} models`, text);
      else ctx.ui.notify(text, "info");
    },
  });

  pi.registerCommand("agents-new", {
    description: "Interactively create an owned coworker",
    handler: async (_args, ctx) => {
      if (!config) await loadConfig();
      if (!ctx.hasUI) {
        ctx.ui.notify("/agents-new requires the interactive Pi UI.", "error");
        return;
      }
      const roleNames = Object.keys(config.roles).sort();
      const roleChoice = await ctx.ui.select("Coworker role", [...roleNames, "custom"]);
      if (!roleChoice) return;
      const role = roleChoice === "custom" ? (await ctx.ui.input("Custom role", "reviewer"))?.trim() || "worker" : roleChoice;
      const preset = config.roles[role];
      const harness = await ctx.ui.select("Harness", preferredFirst([...HARNESSES], preset?.harness || config.defaultHarness)) as Harness | undefined;
      if (!harness) return;
      const profiles = Object.entries(config.profiles).filter(([, profile]) => profile.harness === harness).map(([name]) => name);
      const profile = await ctx.ui.select("Launch profile", preferredFirst(profiles, preset?.profile || config.defaultProfiles[harness]));
      if (!profile) return;
      const models = await enumerateModels(harness);
      const defaultModel = preset?.model || config.defaultModels[harness];
      const modelOptions = ["(harness default)", ...models];
      const modelChoice = await ctx.ui.select("Model", preferredFirst(modelOptions, defaultModel || "(harness default)"));
      if (!modelChoice) return;
      const effortChoice = await ctx.ui.select("Effort", preferredFirst(["(harness default)", ...HARNESS_EFFORTS[harness]], preset?.effort || config.defaultEfforts[harness] || "(harness default)"));
      if (!effortChoice) return;
      const effort = effortChoice === "(harness default)" ? undefined : effortChoice as Effort;
      const suggestedId = `${harness}-${role}-${newRunId().slice(0, 6)}`;
      const id = (await ctx.ui.input("Worker id", suggestedId))?.trim() || suggestedId;
      const cwd = (await ctx.ui.input("Working directory", ctx.cwd))?.trim() || ctx.cwd;
      const task = await ctx.ui.editor("Assignment or standing mandate", preset?.instructions || "");
      if (!task?.trim()) return;
      const summary = [`id: ${id}`, `role: ${role}`, `harness: ${harness}`, `profile: ${profile}`, `model: ${modelChoice}`, `effort: ${effort ?? "(harness default)"}`, `cwd: ${cwd}`, "", task.trim()].join("\n");
      if (!(await ctx.ui.confirm("Spawn coworker?", summary))) return;
      const worker = await spawnWorker({ action: "spawn", id, role, harness, profile, model: modelChoice === "(harness default)" ? undefined : modelChoice, effort, cwd, task: task.trim() }, ctx);
      const mode = worker.profile ? config.profiles[worker.profile]?.mode : undefined;
      const next = worker.harness === "opencode"
        ? mode === "persistent" ? "The OpenCode session is initialized and remains wakeable through Intercom." : "Task started as the initial OpenCode prompt."
        : `Wait for ${worker.intercomTarget} in Intercom, then send or ask the assignment.`;
      ctx.ui.notify(`Started ${worker.id}. ${next}`, "info");
      await updateStatus(ctx);
    },
  });

  pi.registerCommand("agents-config", {
    description: "Interactively edit Agent Fleet defaults",
    handler: async (_args, ctx) => {
      if (!config) await loadConfig();
      if (!ctx.hasUI) {
        ctx.ui.notify(formatConfig(config, configPath), "info");
        return;
      }
      const draft = structuredClone(config);
      while (true) {
        const choice = await ctx.ui.select("Agent Fleet defaults", [
          "Default harness",
          "Pi defaults",
          "Codex defaults",
          "Claude defaults",
          "OpenCode defaults",
          "Lifecycle",
          "Role preset",
          "Save and close",
          "Cancel",
        ]);
        if (!choice || choice === "Cancel") return;
        if (choice === "Save and close") {
          await writeConfigDefaults(configPath, draft);
          config = draft;
          modelCache.clear();
          ctx.ui.notify(`Saved Agent Fleet defaults to ${configPath}`, "info");
          return;
        }
        if (choice === "Default harness") {
          const harness = await ctx.ui.select("Default harness", preferredFirst([...HARNESSES], draft.defaultHarness)) as Harness | undefined;
          if (harness) draft.defaultHarness = harness;
          continue;
        }
        if (choice === "Lifecycle") {
          const lease = await ctx.ui.input("Lease minutes", String(draft.leaseMinutes));
          const heartbeatSeconds = await ctx.ui.input("Heartbeat seconds", String(draft.heartbeatSeconds));
          const maxRuntime = await ctx.ui.input("Maximum runtime (systemd duration)", draft.maxRuntime);
          const cleanupChoice = await ctx.ui.select("Cleanup live owned workers on manager shutdown?", preferredFirst(["yes", "no"], draft.cleanupOnShutdown ? "yes" : "no"));
          if (lease && Number(lease) > 0) draft.leaseMinutes = Number(lease);
          if (heartbeatSeconds && Number(heartbeatSeconds) > 0) draft.heartbeatSeconds = Number(heartbeatSeconds);
          if (maxRuntime?.trim()) {
            try {
              parseDurationToSeconds(maxRuntime.trim());
              draft.maxRuntime = maxRuntime.trim();
            } catch (error) {
              ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
              continue;
            }
          }
          if (cleanupChoice === "yes") draft.cleanupOnShutdown = true;
          if (cleanupChoice === "no") draft.cleanupOnShutdown = false;
          continue;
        }
        if (choice === "Role preset") {
          const roleName = await ctx.ui.select("Role preset", Object.keys(draft.roles).sort());
          if (!roleName) continue;
          const role = draft.roles[roleName];
          const harness = await ctx.ui.select("Role harness", preferredFirst([...HARNESSES], role.harness || draft.defaultHarness)) as Harness | undefined;
          if (!harness) continue;
          const profiles = Object.entries(draft.profiles).filter(([, profile]) => profile.harness === harness).map(([name]) => name);
          const profile = await ctx.ui.select("Role profile", preferredFirst(profiles, role.profile || draft.defaultProfiles[harness]));
          const model = await ctx.ui.input("Role model (blank = harness default)", role.model || "");
          const effortChoice = await ctx.ui.select("Role effort", preferredFirst(["(harness default)", ...HARNESS_EFFORTS[harness]], role.effort || draft.defaultEfforts[harness] || "(harness default)"));
          const effort = effortChoice && effortChoice !== "(harness default)" ? effortChoice as Effort : undefined;
          const instructions = await ctx.ui.editor("Role instructions", role.instructions || "");
          draft.roles[roleName] = { harness, ...(profile ? { profile } : {}), ...(model?.trim() ? { model: model.trim() } : {}), ...(effort ? { effort } : {}), ...(instructions?.trim() ? { instructions: instructions.trim() } : {}) };
          continue;
        }
        const harness = choice.toLowerCase().replace(" defaults", "") as Harness;
        const profiles = Object.entries(draft.profiles).filter(([, profile]) => profile.harness === harness).map(([name]) => name);
        const profile = await ctx.ui.select(`${harness} profile`, preferredFirst(profiles, draft.defaultProfiles[harness]));
        const model = await ctx.ui.input(`${harness} model (blank = harness default)`, draft.defaultModels[harness] || "");
        const effortChoice = await ctx.ui.select(`${harness} effort`, preferredFirst(["(harness default)", ...HARNESS_EFFORTS[harness]], draft.defaultEfforts[harness] || "(harness default)"));
        if (profile) draft.defaultProfiles[harness] = profile;
        if (model?.trim()) draft.defaultModels[harness] = model.trim();
        else delete draft.defaultModels[harness];
        if (effortChoice && effortChoice !== "(harness default)") draft.defaultEfforts[harness] = effortChoice as Effort;
        else delete draft.defaultEfforts[harness];
      }
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

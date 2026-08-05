import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { access, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { DEFAULT_CONFIG, readConfig, resolveProfileCommand, writeConfigDefaults } from "./config.ts";
import { assertDirectInteractiveBossCommand, parseBossCommand } from "./boss-command.ts";
import { assertTrustedLocalBossControllerTarget, assertTrustedLocalBossWorkerAdoptionAllowed, buildOptionalTrustedLocalBossTeamEnvironment, buildTrustedLocalBossParticipantPrompt, buildTrustedLocalBossRalphEnvironment, TRUSTED_LOCAL_BOSS_PARTICIPANT_HARNESS, trustedLocalBossParticipantTargets, type TrustedLocalBossTeamIdentity } from "./boss-team-environment.ts";
import { TRUSTED_LOCAL_BOSS_WARNING, TrustedLocalBossStore } from "./boss-trusted-local.ts";
import { CLEANUP_SERVICE, CLEANUP_TIMER, ensureCleanupTimer } from "./cleanup-timer.ts";
import { addPiTools, buildPermissionEnvironment, buildPermissionUnitProperties, registerWorkerPermissionPolicy, SAFE_PI_BOSS_RALPH_TOOLS } from "./permissions.ts";
import { resolvePiRuntime } from "./pi-runtime.ts";
import { prepareWorkerRuntime, workerRuntimeRoot, workerSocketRuntimeRoot } from "./runtime.ts";
import { INTERCOM_CONTROL_RECEIVED_EVENT, INTERCOM_CONTROL_REGISTER_EVENT, INTERCOM_CONTROL_SEND_EVENT, registerOwnedWorkerReadinessProbeType, registerOwnedWorkerReadinessResponder, WORKER_READINESS_ACK, WORKER_READINESS_PROBE, WorkerReadinessAckTracker } from "./readiness.ts";
import { captureCleanupUnitInventory, deleteOrphanRuntimeSafely, deleteTerminalRuntimeBatchSafely, deleteTerminalRuntimeSafely, executeCleanupCandidatesIsolated, existingTerminalCachePaths, listRuntimeRoots, recoverStaleRuntimeCleanupClaims, removeFullRuntimePathsSafely, terminalWorkerAt } from "./runtime-cleanup.ts";
import { detectHarnessAvailability, formatRoutingDecision, inferHarnessFromModel, normalizeModelForHarness, roleInstructionsForHarness, roleRequiresSubagents, resolveHarnessRoute, type HarnessAvailability, type RoutingDecision } from "./routing.ts";
import { WorkerStore } from "./store.ts";
import { formatUnitStatus, getUnitStatus, getUserManagerHealth, launchUnit, listWorkerUnits, makeUnitName, parseDurationToSeconds, readUnitLogs, readUnitProcessTree, sanitizeUnitPart, stopUnit, systemdAvailable, waitForUnitRunning } from "./systemd.ts";
import type { CommandRunner, Effort, Harness, OrchestratorConfig, PermissionProfile, RolePreset, WorkerRecord, WorkerStateFile } from "./types.ts";
import {
  boundedLeaseExpiry,
  buildWorkerArgs,
  buildWorkerEnvironment,
  checkpointWarningAt,
  cleanupReason,
  cleanupSnapshotStillEligible,
  createSystemdRecord,
  HARNESS_EFFORTS,
  initializeWorkerLifecycle,
  isLiveState,
  isRecentTerminalWorker,
  isTerminalState,
  newRunId,
  rebindManagerOwner,
  recordWorkerActivity,
  stateFromUnit,
  stoppedWorkerRetentionReason,
  unitRequiresStopFence,
  validateEffort,
  validateWorkerId,
} from "./workers.ts";
import { detectHarnessVersions, formatAdapterVersions, formatHarnessVersions, formatUpdatePlan, inspectAdapterFamily } from "./updates.ts";

const ACTIONS = [
  "spawn",
  "route",
  "list",
  "history",
  "status",
  "stop",
  "cleanup",
  "prune",
  "doctor",
  "versions",
  "update",
  "logs",
  "renew",
  "forget",
  "adopt",
  "capabilities",
  "profiles",
  "permissions",
  "models",
  "variants",
  "config",
] as const;
const HARNESSES = ["pi", "codex", "claude", "opencode"] as const;
const COORDINATED_ADAPTER_PROFILES = new Set(["codex-safe", "codex-minimal", "claude-safe", "claude-minimal", "claude-trusted"]);
const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const STATUS_KEY = "agent-intercom-orchestrator";
const PI_PEER_LAUNCHER = fileURLToPath(new URL("./pi-peer-launcher.mjs", import.meta.url));
const ADAPTER_READINESS_LAUNCHER = fileURLToPath(new URL("./adapter-readiness-launcher.mjs", import.meta.url));
const OPENCODE_PEER_LAUNCHER = fileURLToPath(new URL("./opencode-peer-launcher.mjs", import.meta.url));
const GIT_GUARD_BIN = fileURLToPath(new URL("./guard-bin", import.meta.url));
const CLEAN_ENV_LAUNCHER = fileURLToPath(new URL("./clean-env-launcher.mjs", import.meta.url));
const SANDBOX_SUPERVISOR = fileURLToPath(new URL("./sandbox-supervisor.mjs", import.meta.url));
const FLEET_CLEANUP_SCRIPT = fileURLToPath(new URL("./agent-fleet-cleanup.mjs", import.meta.url));
const ORCHESTRATOR_EXTENSION = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = dirname(dirname(ORCHESTRATOR_EXTENSION));
const INTERCOM_INBOUND_ACTIVITY_EVENT = "agent-intercom:inbound-message";
const INTERCOM_LIFECYCLE_SEND_EVENT = "agent-intercom:lifecycle-send";

const AgentFleetParams = Type.Object({
  action: StringEnum(ACTIONS),
  id: Type.Optional(Type.String({ description: "Stable worker id" })),
  harness: Type.Optional(StringEnum(["auto", "pi", "codex", "claude", "opencode"] as const, { description: "Use 'auto' unless the caller explicitly selected a harness" })),
  role: Type.Optional(Type.String({ description: "Worker role or configured role preset, for example advisor or challenger" })),
  task: Type.Optional(Type.String({ description: "Assignment or standing mandate for the worker" })),
  cwd: Type.Optional(Type.String({ description: "Worker working directory" })),
  profile: Type.Optional(Type.String({ description: "Configured launch profile" })),
  permissionProfile: Type.Optional(Type.String({ description: "Configured permission profile, for example review-readonly or builder-restricted" })),
  model: Type.Optional(Type.String({ description: "Harness model name or provider/model identifier" })),
  effort: Type.Optional(StringEnum(["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const, { description: "Use 'auto' unless the caller explicitly selected an effort" })),
  instructions: Type.Optional(Type.String({ description: "Additional standing instructions for the coworker" })),
  subagents: Type.Optional(StringEnum(["auto", "required", "not-required"] as const, { description: "Use 'auto' unless the caller explicitly requires or forbids nested-subagent capability" })),
  requiresSubagents: Type.Optional(Type.Boolean({ description: "Legacy nested-subagent override; prefer subagents=auto|required|not-required" })),
  fresh: Type.Optional(Type.Boolean({ description: "Start a fresh persistent harness session instead of resuming state for this worker id" })),
  all: Type.Optional(Type.Boolean({ description: "Include workers owned by other manager sessions for list/status diagnostics" })),
  execute: Type.Optional(Type.Boolean({ description: "Actually execute cleanup or updates; false previews them" })),
  acknowledge: Type.Optional(Type.Boolean({ description: "Manager acknowledgment required before deleting stopped worker records" })),
  lines: Type.Optional(Type.Number({ description: "Journal lines for logs (1-500)" })),
});

type FleetParams = {
  action: typeof ACTIONS[number] | "_heartbeat";
  id?: string;
  harness?: Harness | "auto";
  role?: string;
  task?: string;
  cwd?: string;
  profile?: string;
  permissionProfile?: string;
  model?: string;
  effort?: Effort | "auto";
  instructions?: string;
  subagents?: "auto" | "required" | "not-required";
  requiresSubagents?: boolean;
  fresh?: boolean;
  all?: boolean;
  execute?: boolean;
  acknowledge?: boolean;
  lines?: number;
  bossTeam?: TrustedLocalBossTeamIdentity;
};

type CleanupCandidate =
  | { kind: "stop"; worker: WorkerRecord; reason: string }
  | { kind: "prune"; worker: WorkerRecord; reason: string }
  | { kind: "cache"; worker: WorkerRecord; reason: string }
  | { kind: "orphan"; workerId: string; path: string; reason: string };

type CleanupExecution = {
  candidates: CleanupCandidate[];
  handled: CleanupCandidate[];
  errors: Array<{ candidate: CleanupCandidate; error: string }>;
};

type ResolvedSpawn = {
  harness: Harness;
  role: string;
  task: string;
  cwd: string;
  profileName: string;
  permissionProfileName: string;
  permissionProfile: PermissionProfile;
  model?: string;
  effort?: Effort;
  instructions?: string;
  routing: RoutingDecision;
};

type ResolvedRoute = {
  role: string;
  harness?: Harness;
  profileName?: string;
  permissionProfileName: string;
  effectiveEffort?: Effort;
  availability: Record<Harness, HarnessAvailability>;
  decision: RoutingDecision;
};

function textResult(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

function managerSessionId(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionId() || ctx.sessionManager.getSessionFile() || `process-${process.pid}`;
}

function parseInboundActivitySender(payload: unknown): { id?: string; name?: string } | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const from = (payload as { from?: unknown }).from;
  if (!from || typeof from !== "object") return undefined;
  const id = typeof (from as { id?: unknown }).id === "string" ? (from as { id: string }).id : undefined;
  const name = typeof (from as { name?: unknown }).name === "string" ? (from as { name: string }).name : undefined;
  return id || name ? { ...(id ? { id } : {}), ...(name ? { name } : {}) } : undefined;
}

function checkpointMessage(worker: WorkerRecord, config: OrchestratorConfig): string {
  return [
    `Lifecycle checkpoint requested for ${worker.id}.`,
    `Your idle deadline is ${formatTime(worker.idleDeadlineAt!)}; the exact worker unit may be stopped after a ${config.cleanupGraceMinutes}-minute grace period.`,
    "Stop beginning new work. Save or commit current changes, report the current commit/worktree status and tests, then send a final handoff to your manager.",
    "If continued quiet work is intentional, ask the manager to renew the lease explicitly.",
    "Your worker record and supported harness session state will be retained if the unit is stopped.",
  ].join("\n");
}

type OpenCodePeerHealth = {
  runId?: string;
  ready?: boolean;
  connected?: boolean;
  openCodeSessionId?: string;
  serverUrl?: string;
  status?: string;
  error?: string;
  updatedAt?: number;
};

async function readOpenCodePeerHealth(path: string): Promise<OpenCodePeerHealth | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as OpenCodePeerHealth;
  } catch {
    return undefined;
  }
}

async function waitForOpenCodePeerHealth(path: string, runId: string, timeoutMs = 180000): Promise<OpenCodePeerHealth> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await readOpenCodePeerHealth(path);
    if (health?.runId === runId && health.error) throw new Error(`OpenCode peer failed readiness: ${health.error}`);
    if (health?.runId === runId && health.ready === true && health.connected === true && health.openCodeSessionId) return health;
    await delay(100);
  }
  throw new Error(`Timed out waiting for OpenCode peer readiness at ${path}`);
}

async function waitForAdapterPeerHealth(path: string, runId: string, harness: "codex" | "claude", timeoutMs = 30_000): Promise<OpenCodePeerHealth> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await readOpenCodePeerHealth(path);
    if (health?.runId === runId && health.error) throw new Error(`${harness} adapter failed readiness: ${health.error}`);
    if (health?.runId === runId && health.ready === true && health.connected === true) return health;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${harness} adapter Intercom readiness at ${path}`);
}

async function persistOpenCodePeerState(path: string, workerId: string, sessionId: string, cwd: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify({
    version: 1,
    workerId,
    sessionId,
    directory: cwd,
    updatedAt: Date.now(),
  }, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

function runnerFor(pi: ExtensionAPI): CommandRunner {
  return {
    async exec(command, args, options) {
      const result = await pi.exec(command, args, options);
      return { stdout: result.stdout, stderr: result.stderr, code: result.code, killed: result.killed };
    },
  };
}

async function systemdVersion(runner: CommandRunner): Promise<number | undefined> {
  const result = await runner.exec("systemd", ["--version"], { timeout: 5000 });
  const match = result.code === 0 ? /systemd\s+(\d+)/.exec(result.stdout) : undefined;
  return match ? Number(match[1]) : undefined;
}

async function discoverGitMetadataPaths(runner: CommandRunner, cwd: string): Promise<string[]> {
  const git = resolveProfileCommand("git");
  if (!git) return [];
  const result = await runner.exec(git, ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], { timeout: 5000 });
  if (result.code !== 0) return [resolve(cwd, ".git")];
  return [...new Set([resolve(cwd, ".git"), ...result.stdout.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("/"))])];
}

async function resolveInstalledPiExtension(candidates: string[], requirement: string): Promise<string> {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next supported Pi package cache location.
    }
  }
  throw new Error(requirement);
}

async function resolvePiIntercomExtension(agentDir: string): Promise<string> {
  return resolveInstalledPiExtension([
    join(agentDir, "git", "github.com", "dataforxyz", "agent-intercom-pi", "index.ts"),
    join(agentDir, "npm", "node_modules", "@dataforxyz", "agent-intercom-pi", "index.ts"),
  ], "Hardened Pi workers require agent-intercom-pi in the Pi git or npm package cache");
}

async function resolvePiRalphExtension(agentDir: string): Promise<string> {
  return resolveInstalledPiExtension([
    join(agentDir, "git", "github.com", "dataforxyz", "pi-extensions", "pi-ralph-wiggum", "index.ts"),
    join(agentDir, "git", "github.com", "tmustier", "pi-extensions", "pi-ralph-wiggum", "index.ts"),
    join(agentDir, "npm", "node_modules", "@tmustier", "pi-ralph-wiggum", "index.ts"),
  ], "Trusted-local Boss Pi participants require pi-ralph-wiggum in the Pi git or npm package cache");
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function workerIncarnation(worker: WorkerRecord): string {
  const incarnation = worker.workerIncarnationId ?? worker.runId;
  if (!incarnation) throw new Error(`Worker ${worker.id} has no incarnation identity`);
  return incarnation;
}

function formatWorker(worker: WorkerRecord): string {
  const target = worker.intercomTarget ? ` target=${worker.intercomTarget}` : "";
  const unit = worker.unit ? ` unit=${worker.unit}` : "";
  const model = worker.model ? ` model=${worker.model}` : "";
  const effort = worker.effort ? ` effort=${worker.effort}` : "";
  const permission = worker.permissionProfile ? ` permission=${worker.permissionProfile}` : "";
  const externalSession = worker.externalSessionId ? ` session=${worker.externalSessionId}` : "";
  const idle = worker.idleDeadlineAt && isLiveState(worker.state) ? ` idle=${formatTime(worker.idleDeadlineAt)}` : "";
  const checkpoint = worker.checkpointRequestedAt ? ` checkpoint=${formatTime(worker.checkpointRequestedAt)} attempts=${worker.checkpointAttemptCount ?? 1}` : "";
  const stopped = worker.stopReason ? ` stop=${worker.stopReason}${worker.dirtyAtStop ? ":dirty" : ""}` : "";
  const error = worker.lastError ? ` error=${worker.lastError}` : "";
  return `${worker.id} [${worker.harness}/${worker.role}] ${worker.state}${model}${effort}${permission}${externalSession}${target}${unit} lease=${formatTime(worker.leaseExpiresAt)}${idle}${checkpoint}${stopped}${error}`;
}

function formatWorkers(workers: WorkerRecord[], hiddenHistory = 0): string {
  const historyHint = hiddenHistory > 0
    ? `\n${hiddenHistory} older terminal worker${hiddenHistory === 1 ? " is" : "s are"} hidden; use action=history to inspect retained history.`
    : "";
  return `${workers.length === 0 ? "No managed workers." : workers.map(formatWorker).join("\n")}${historyHint}`;
}

export function workersAttachedToManager(workers: WorkerRecord[], sessionId: string): WorkerRecord[] {
  return workers.filter((worker) => worker.managerSessionId === sessionId);
}

export function reserveWorkerRecord(state: WorkerStateFile, worker: WorkerRecord): void {
  if (state.runtimeCleanupClaims?.some((claim) => claim.workerId === worker.id)) {
    throw new Error(`Worker ${worker.id} has runtime cleanup in progress`);
  }
  const index = state.workers.findIndex((candidate) => candidate.id === worker.id);
  const existing = index >= 0 ? state.workers[index] : undefined;
  if (existing && isLiveState(existing.state)) throw new Error(`Worker ${worker.id} is already ${existing.state}`);
  if (index >= 0) state.workers[index] = worker;
  else state.workers.push(worker);
}

export async function removeWorkerRuntimeAndRecord(
  store: WorkerStore,
  worker: WorkerRecord,
  agentDir: string,
  removeRuntime: (path: string) => Promise<void> = async (path) => rm(path, { recursive: true, force: true }),
): Promise<void> {
  const incarnation = workerIncarnation(worker);
  const token = `forget-${worker.id}-${randomUUID()}`;
  await store.mutate((state) => {
    const current = state.workers.find((candidate) => candidate.id === worker.id && workerIncarnation(candidate) === incarnation);
    if (!current) throw new Error(`Worker ${worker.id} changed before runtime cleanup`);
    if (state.runtimeCleanupClaims?.some((claim) => claim.workerId === worker.id)) {
      throw new Error(`Worker ${worker.id} has runtime cleanup in progress`);
    }
    (state.runtimeCleanupClaims ??= []).push({
      token,
      workerId: worker.id,
      runId: incarnation,
      terminalAt: terminalWorkerAt(current),
      unit: current.unit,
      action: "full",
      claimedAt: Date.now(),
      ownerPid: process.pid,
      phase: "deleting",
      pathIndexes: [],
    });
  });
  try {
    await removeFullRuntimePathsSafely(worker.id, agentDir, removeRuntime);
    await store.mutate((state) => {
      state.workers = state.workers.filter((candidate) => candidate.id !== worker.id || workerIncarnation(candidate) !== incarnation);
      state.runtimeCleanupClaims = state.runtimeCleanupClaims?.filter((claim) => claim.token !== token);
    });
  } catch (error) {
    await store.mutateConditionally((state) => {
      const claim = state.runtimeCleanupClaims?.find((candidate) => candidate.token === token);
      if (!claim) return { value: undefined, changed: false };
      claim.ownerPid = 0;
      return { value: undefined, changed: true };
    }).catch(() => undefined);
    throw error;
  }
}

export type LeaseHeartbeatResult = {
  renewed: WorkerRecord[];
  checkpointRequested: WorkerRecord[];
  changed: boolean;
};

export function renewObservedWorkerLeases(
  state: WorkerStateFile,
  observedWorkers: WorkerRecord[],
  managerId: string,
  config: OrchestratorConfig,
  now = Date.now(),
): LeaseHeartbeatResult {
  const observedLiveRuns = new Set(observedWorkers
    .filter((worker) => worker.managerSessionId === managerId && worker.owned && isLiveState(worker.state) && worker.stateReason !== "stop_in_progress")
    .map((worker) => `${worker.id}\u0000${worker.runId}`));
  const renewed: WorkerRecord[] = [];
  const checkpointRequested: WorkerRecord[] = [];
  let changed = false;
  for (const worker of state.workers) {
    if (!observedLiveRuns.has(`${worker.id}\u0000${worker.runId}`)) continue;
    if (worker.managerSessionId !== managerId || !worker.owned || !isLiveState(worker.state) || worker.stateReason === "stop_in_progress") continue;
    changed = initializeWorkerLifecycle(worker, config, now) || changed;
    const lastActivity = worker.lastWorkerActivityAt!;
    const idleDeadline = worker.idleDeadlineAt!;
    if (now < idleDeadline) {
      const nextLease = boundedLeaseExpiry(config, lastActivity, now);
      if (nextLease > worker.leaseExpiresAt) {
        worker.leaseExpiresAt = nextLease;
        worker.updatedAt = now;
        renewed.push(structuredClone(worker));
        changed = true;
      }
    }
    const warningAt = checkpointWarningAt(worker, config);
    const retryAfter = config.checkpointRetryMinutes * 60_000;
    const checkpointAttemptDue = worker.checkpointLastAttemptAt === undefined || now - worker.checkpointLastAttemptAt >= retryAfter;
    if (warningAt !== undefined && now >= warningAt && now < worker.checkpointDeadlineAt! && checkpointAttemptDue) {
      worker.checkpointRequestedAt ??= now;
      worker.checkpointLastAttemptAt = now;
      worker.checkpointAttemptCount = (worker.checkpointAttemptCount ?? 0) + 1;
      worker.updatedAt = now;
      checkpointRequested.push(structuredClone(worker));
      changed = true;
    }
  }
  return { renewed, checkpointRequested, changed };
}

export function recordIntercomWorkerActivity(
  state: WorkerStateFile,
  managerId: string,
  sender: { id?: string; name?: string },
  config: OrchestratorConfig,
  now = Date.now(),
): WorkerRecord | undefined {
  const worker = state.workers.find((candidate) => {
    if (candidate.managerSessionId !== managerId || !candidate.owned || !isLiveState(candidate.state) || candidate.stateReason === "stop_in_progress") return false;
    const expectedSenderId = candidate.intercomTarget ?? candidate.id;
    // Broker-assigned/stable sender IDs are authoritative. A display name must
    // never be able to keep another worker's lease alive.
    return sender.id === expectedSenderId || (!sender.id && sender.name === expectedSenderId);
  });
  if (!worker) return undefined;
  recordWorkerActivity(worker, config, now);
  return structuredClone(worker);
}

function extractWorkers(state: WorkerStateFile, id?: string): WorkerRecord[] {
  if (!id) return [...state.workers];
  const worker = state.workers.find((candidate) => candidate.id === id);
  if (!worker) throw new Error(`Unknown managed worker: ${id}`);
  return [worker];
}

export type OpenCodeModelInfo = { id: string; variants: string[] };

export function parseOpenCodeModelsVerbose(output: string): OpenCodeModelInfo[] {
  const result: OpenCodeModelInfo[] = [];
  const lines = output.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const id = lines[index].trim();
    if (!/^[^\s/]+\/[^\s]+$/.test(id)) continue;
    let json = "";
    for (index += 1; index < lines.length; index += 1) {
      json += `${lines[index]}\n`;
      try {
        const parsed = JSON.parse(json) as { variants?: Record<string, unknown> };
        result.push({ id, variants: Object.keys(parsed.variants ?? {}).sort() });
        break;
      } catch {
        // Continue until the complete pretty-printed model object is buffered.
      }
    }
  }
  return result;
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
  const direct = normalizeModelForHarness(harness, config.defaultModels[harness], config.routing.modelRouting);
  if (direct) models.add(direct);
  for (const role of Object.values(config.roles)) {
    const model = normalizeModelForHarness(harness, role.model, config.routing.modelRouting);
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
  lines.push(`permissions: ${Object.keys(config.permissionProfiles).sort().join(", ") || "(none)"}`);
  lines.push(`roles: ${Object.keys(config.roles).sort().join(", ") || "(none)"}`);
  lines.push(`routing preference: ${config.routing.preference.join(" -> ") || "(none)"}`);
  lines.push(`routing explicit-only: ${config.routing.explicitOnly.join(", ") || "(none)"}`);
  lines.push(`routing subagent-capable: ${config.routing.capabilities.requiresSubagents.join(", ") || "(none)"}`);
  for (const harness of HARNESSES) {
    lines.push(`routing ${harness} profiles: ${config.routing.profilePreferences[harness]?.join(" -> ") || "(legacy default only)"}`);
  }
  lines.push(`routing role requirements: ${Object.entries(config.routing.roleRequirements).map(([role, requirement]) => `${role}(requiresSubagents=${requirement.requiresSubagents ?? false})`).join(", ") || "(none)"}`);
  lines.push(`routing unmatched model harness: ${config.routing.modelRouting.unmatchedHarness ?? "(normal role routing)"}`);
  lines.push(`routing model rules: ${config.routing.modelRouting.rules.map((rule) => `${rule.harness}=[${rule.patterns.join(",")}]`).join("; ") || "(none)"}`);
  lines.push(`routing model prefix stripping: ${HARNESSES.map((harness) => `${harness}=[${config.routing.modelRouting.stripPrefixes[harness]?.join(",") ?? ""}]`).join(" ")}`);
  lines.push(`routing preserve role instructions on fallback: ${config.routing.fallback.preserveRoleInstructions}`);
  lines.push(`lease=${config.leaseMinutes}m idle=${config.idleTimeoutMinutes}m checkpoint-warning=${config.checkpointWarningMinutes}m retry=${config.checkpointRetryMinutes}m grace=${config.cleanupGraceMinutes}m heartbeat=${config.heartbeatSeconds}s max-runtime=${config.maxRuntime}`);
  lines.push(`cleanup: startup=${config.cleanupExpiredOnStart} shutdown=${config.cleanupOnShutdown} timer=${config.cleanupTimerEnabled ? `${config.cleanupTimerMinutes}m` : "disabled"} prune-stopped=${config.pruneStoppedWorkersOnCleanup}`);
  lines.push(`history: recent=${config.recentStoppedWorkerHours}h retention=${config.stoppedWorkerRetentionDays}d dirty-retention=${config.dirtyStoppedWorkerRetentionDays}d orphan-runtime-retention=${config.orphanRuntimeRetentionMinutes}m prune-caches-on-stop=${config.pruneRuntimeCachesOnStop}`);
  return lines.join("\n");
}

function fleetPromptGuidelines(config: OrchestratorConfig): string[] {
  const explicitOnly = config.routing.explicitOnly.length
    ? ` Harnesses configured as explicit-only: ${config.routing.explicitOnly.join(", ")}.`
    : " No harness is currently configured as explicit-only.";
  return [
    "Pi workers are independent Intercom peers, not pi-subagents. Use role=advisor for a persistent Pi advisor coworker.",
    "After agent_fleet spawns Pi, Codex, or Claude, send its assignment to the returned intercomTarget with intercom_send; reserve intercom_ask for a question that blocks the manager's next step. Use intercom_send for progress/status checkpoints. Do not call intercom_list merely to rediscover an owned worker. Persistent Pi workers created by an interactive Pi manager and built-in coordinated Codex/Claude profiles wait for exact-run Intercom readiness; headless/OpenCode-manager Pi workers and custom persistent adapter profiles remain honestly `registering` after process stability unless they adopt the readiness contract. OpenCode receives its initial task after its plugin/session readiness handshake. A failed assignment delivery is therefore a new disconnect and should be investigated with status/logs, not treated as normal startup delay.",
    "For sandboxed builder profiles such as codex-safe, create the feature worktree before spawning and pass that worktree as cwd. Do not ask the worker to create a sibling worktree outside its writable cwd.",
    "Use capabilities, profiles, permissions, models, variants, versions, or config before guessing models, permission policy, effort levels, package state, or defaults.",
    `When the caller did not explicitly choose routing fields, pass harness=auto, effort=auto, and subagents=auto (or omit them when the client preserves optional fields); never invent pi/off/false placeholders. Capability-aware routing then chooses an installed eligible harness. Use action=route with the same explicit constraints to preview the selection. Explicit harness/profile choices always win; explicit model identifiers use the configured model-routing rules and unmatched-model harness.${explicitOnly}`,
    "Preview update and cleanup before execute=true. Updates preserve detected install sources; never kill sessions the fleet does not own.",
    "Persistent workers expire after an activity-bounded idle budget. Worker messages to the manager or explicit renew extend it; manager heartbeat alone does not. Default list output hides older terminal history; use history when needed. Stop completed workers promptly, rely on configured retention cleanup, and use forget or bulk prune with acknowledge=true only after deliberate closure.",
  ];
}

export default function agentIntercomOrchestrator(pi: ExtensionAPI) {
  registerWorkerPermissionPolicy(pi);
  const unsubscribeWorkerReadiness = registerOwnedWorkerReadinessResponder(pi);
  if (process.env.AGENT_INTERCOM_ORCHESTRATOR_DISABLED === "1") {
    if (unsubscribeWorkerReadiness) {
      pi.on("session_start", () => { registerOwnedWorkerReadinessProbeType(pi); });
      pi.on("session_shutdown", () => unsubscribeWorkerReadiness());
    }
    return;
  }
  const agentDir = getAgentDir();
  const configPath = join(agentDir, "intercom", "orchestrator", "config.json");
  const statePath = join(agentDir, "intercom", "orchestrator", "workers.json");
  const trustedLocalBossStatePath = join(agentDir, "intercom", "orchestrator", "boss-trusted-local.json");
  const openCodePeerDir = join(agentDir, "intercom", "orchestrator", "opencode-peers");
  const configuredManagerContext = process.env.AGENT_INTERCOM_MANAGER_CONTEXT;
  const managerOwnerContext = configuredManagerContext === "opencode" || configuredManagerContext === "headless_cli" ? configuredManagerContext : "pi";
  const store = new WorkerStore(statePath, { legacyManagerContext: managerOwnerContext });
  const trustedLocalBossStore = new TrustedLocalBossStore(trustedLocalBossStatePath);
  const runner = runnerFor(pi);
  const readinessAcks = new WorkerReadinessAckTracker();
  pi.events.emit(INTERCOM_CONTROL_REGISTER_EVENT, { type: WORKER_READINESS_ACK, version: 1 });
  const unsubscribeReadinessAcks = pi.events.on(INTERCOM_CONTROL_RECEIVED_EVENT, (payload) => readinessAcks.record(payload));
  let config: OrchestratorConfig;
  let currentCtx: ExtensionContext | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  let heartbeatRunning = false;
  const bossBindingsInFlight = new Set<string>();
  const promptGuidelines = fleetPromptGuidelines(DEFAULT_CONFIG);
  const unsubscribeWorkerActivity = pi.events.on(INTERCOM_INBOUND_ACTIVITY_EVENT, (payload) => {
    const ctx = currentCtx;
    const sender = parseInboundActivitySender(payload);
    if (!ctx || !config || !sender) return;
    const now = Date.now();
    void store.mutate((state) => recordIntercomWorkerActivity(state, managerSessionId(ctx), sender, config, now))
      .then((worker) => { if (worker) return updateStatus(ctx); })
      .catch(() => undefined);
  });
  const modelCache = new Map<Harness, { expiresAt: number; models: string[] }>();
  let openCodeModelInfoCache: { expiresAt: number; models: OpenCodeModelInfo[] } | undefined;

  const loadConfig = async () => {
    config = await readConfig(configPath);
    promptGuidelines.splice(0, promptGuidelines.length, ...fleetPromptGuidelines(config));
    return config;
  };

  const waitForPiPeerReadiness = async (target: string, runId: string, unit: string, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    let lastStatus = await getUnitStatus(runner, unit);
    while (Date.now() < deadline) {
      if (lastStatus.verified !== false && !lastStatus.job && lastStatus.exists
        && lastStatus.activeState === "active" && lastStatus.mainPid) {
        const requestId = `readiness-${runId}-${randomUUID()}`;
        readinessAcks.expect(requestId, runId, target);
        pi.events.emit(INTERCOM_CONTROL_SEND_EVENT, {
          requestId,
          to: target,
          control: {
            type: WORKER_READINESS_PROBE,
            version: 1,
            data: { requestId, expectedRunId: runId },
          },
        });
        const attemptDeadline = Math.min(deadline, Date.now() + 500);
        while (Date.now() < attemptDeadline) {
          if (readinessAcks.consume(requestId)) return lastStatus;
          await delay(50);
        }
        readinessAcks.discard(requestId);
      } else if (lastStatus.verified !== false && !lastStatus.job
        && (!lastStatus.exists || lastStatus.activeState === "failed" || lastStatus.activeState === "inactive")) {
        throw new Error(`Pi worker ${target} exited before Intercom readiness (${formatUnitStatus(lastStatus)})`);
      }
      await delay(100);
      lastStatus = await getUnitStatus(runner, unit);
    }
    throw new Error(`Timed out waiting for Pi worker ${target} Intercom readiness for run ${runId} (${formatUnitStatus(lastStatus)})`);
  };

  const inspectVersions = () => inspectAdapterFamily({
    agentDir,
    currentPackageRoot: PACKAGE_ROOT,
    home: process.env.HOME,
    commandPaths: {
      coi: resolveProfileCommand("coi"),
      cci: resolveProfileCommand("cci"),
    },
  });

  const harnessVersions = async () => {
    const piProfileName = config.defaultProfiles.pi;
    const piProfile = piProfileName ? config.profiles[piProfileName] : undefined;
    const piRuntime = piProfileName && piProfile?.harness === "pi"
      ? await resolvePiRuntime({
        profileName: piProfileName,
        profile: piProfile,
        configuredExecutable: resolveProfileCommand(piProfile.command),
        builtInProfile: DEFAULT_CONFIG.profiles["pi-peer"],
      })
      : undefined;
    return detectHarnessVersions({
      pi: piRuntime,
      codex: resolveProfileCommand("codex"),
      claude: resolveProfileCommand("claude"),
      opencode: resolveProfileCommand("opencode"),
    });
  };

  const publishStatus = (ctx: ExtensionContext, workers: WorkerRecord[]) => {
    const attached = workersAttachedToManager(workers, managerSessionId(ctx));
    const running = attached.filter((worker) => isLiveState(worker.state)).length;
    const stale = attached.filter((worker) => cleanupReason(worker)).length;
    ctx.ui.setStatus(STATUS_KEY, running === 0 && stale === 0 ? undefined : `agents ${running}${stale ? ` · stale ${stale}` : ""}`);
  };

  const updateStatus = async (ctx = currentCtx) => {
    if (!ctx) return;
    const state = await store.read();
    publishStatus(ctx, state.workers);
  };

  const recoverCleanupClaims = async () => {
    const recovery = await recoverStaleRuntimeCleanupClaims({ store, runner, agentDir });
    for (const failure of recovery.errors) {
      console.error(`[agent-intercom-orchestrator] Runtime cleanup recovery ${failure.token} failed: ${failure.error}`);
    }
    return recovery;
  };

  const reconcile = async (managerId?: string, publish = true): Promise<WorkerRecord[]> => {
    const isInScope = (worker: WorkerRecord) => managerId === undefined || worker.managerSessionId === managerId;
    let snapshot = await store.read();
    for (const pending of snapshot.workers.filter((worker) => worker.state === "migration_pending" && isInScope(worker))) {
      const status = pending.unit ? await getUnitStatus(runner, pending.unit) : { exists: false };
      let resolution: "stopped" | "failed" | "lost" | "unreachable" | undefined;
      if (!status.exists) resolution = "lost";
      else if (status.activeState === "failed" || (status.result && status.result !== "success")) resolution = "failed";
      else if (status.activeState === "inactive" || (status.activeState === "active" && status.subState === "exited")) resolution = status.execMainStatus === 0 ? "stopped" : "failed";
      else if (pending.migrationAudit?.reconcileBy !== undefined && Date.now() >= pending.migrationAudit.reconcileBy) resolution = "unreachable";
      if (resolution) {
        await store.reconcileLegacyStopping(pending.id, resolution, {
          expectedGeneration: snapshot.generation,
          observedAt: Date.now(),
          reason: resolution === "unreachable" ? "legacy_stopping_unresolved" : "legacy_stopping_reconciled",
        });
        snapshot = await store.read();
      }
    }
    const observations = await Promise.all(
      snapshot.workers
        .filter((worker) => isLiveState(worker.state))
        .filter(isInScope)
        .filter((worker) => typeof worker.unit === "string")
        .map(async (worker) => {
          const unit = worker.unit!;
          return {
            id: worker.id,
            runId: workerIncarnation(worker),
            unit,
            status: await getUnitStatus(runner, unit),
            health: worker.healthPath ? await readOpenCodePeerHealth(worker.healthPath) : undefined,
          };
        }),
    );
    const { workers, retireUnits } = await store.mutateConditionally((state) => {
      const retireUnits: string[] = [];
      let changed = false;
      for (const observation of observations) {
        const worker = state.workers.find((candidate) => candidate.id === observation.id && workerIncarnation(candidate) === observation.runId && candidate.unit === observation.unit);
        if (!worker) continue;
        if (unitRequiresStopFence(worker, observation.status)) {
          const lastError = `stopped or terminal worker record still has a live or queued unit (${formatUnitStatus(observation.status)})`;
          if (worker.lastError !== lastError) {
            worker.lastError = lastError;
            worker.updatedAt = Date.now();
            changed = true;
          }
          retireUnits.push(observation.unit);
          continue;
        }
        const observedState = stateFromUnit(observation.status, worker.state);
        const nextState = observedState;
        if (observation.health?.runId === worker.runId) {
          if (JSON.stringify(worker.backendDetails) !== JSON.stringify(observation.health)) {
            worker.backendDetails = observation.health;
            changed = true;
          }
          if (observation.health.openCodeSessionId && worker.externalSessionId !== observation.health.openCodeSessionId) {
            worker.externalSessionId = observation.health.openCodeSessionId;
            changed = true;
          }
          const nextError = observation.health.error
            ? observation.health.error
            : observation.health.ready && nextState !== "failed"
              ? undefined
              : worker.lastError;
          if (worker.lastError !== nextError) {
            worker.lastError = nextError;
            changed = true;
          }
        }
        if (nextState !== worker.state || observation.status.mainPid !== worker.mainPid) {
          worker.state = nextState;
          if (observation.status.activeState === "active" && observation.status.subState === "exited" && observation.status.execMainStatus === 0) {
            worker.terminalOutcome = "completed";
          }
          worker.mainPid = observation.status.mainPid;
          worker.updatedAt = Date.now();
          if (nextState === "failed") worker.lastError = observation.status.result || `service exited with ${observation.status.execMainStatus ?? "unknown status"}`;
          changed = true;
        }
        if (observation.status.activeState === "active" && observation.status.subState === "exited") {
          retireUnits.push(observation.unit);
        }
      }
      return { value: { workers: structuredClone(state.workers), retireUnits }, changed };
    });
    await Promise.allSettled(retireUnits.map((unit) => stopUnit(runner, unit)));
    if (publish) await updateStatus();
    return workers;
  };

  const inspectWorkerDirtyState = async (worker: WorkerRecord): Promise<{ dirty?: boolean; status?: string; error?: string }> => {
    if (worker.permissionProfile && config.permissionProfiles[worker.permissionProfile]?.workspace === "read-only") return {};
    const git = resolveProfileCommand("git");
    if (!git) return { error: "git executable unavailable" };
    const result = await runner.exec(git, ["-C", worker.cwd, "status", "--short"], { timeout: 5000 });
    if (result.code !== 0) return { error: result.stderr.trim() || `git status exited ${result.code}` };
    const status = result.stdout.trim();
    return { dirty: status.length > 0, ...(status ? { status } : {}) };
  };

  const stopWorker = async (target: WorkerRecord, options: {
    expectedManagerSessionId?: string;
    reason?: string;
    expectedCheckpointDeadlineAt?: number;
  } = {}): Promise<WorkerRecord> => {
    const stoppedAt = Date.now();
    const worker = await store.mutate((state) => {
      const current = state.workers.find((candidate) => candidate.id === target.id && workerIncarnation(candidate) === workerIncarnation(target));
      if (!current) throw new Error(`Worker ${target.id} changed before it could be stopped`);
      if (!current.owned) throw new Error(`Worker ${current.id} is not owned by this orchestrator`);
      if (options.expectedManagerSessionId && current.managerSessionId !== options.expectedManagerSessionId) {
        throw new Error(`Worker ${current.id} belongs to another manager session; adopt it before stopping`);
      }
      if (options.expectedCheckpointDeadlineAt !== undefined
        && !cleanupSnapshotStillEligible(current, options.expectedCheckpointDeadlineAt, stoppedAt)) {
        throw new Error(`Worker ${current.id} lifecycle changed or was renewed before expired cleanup`);
      }
      current.state = "blocked";
      current.stateReason = "stop_in_progress";
      current.stopReason = options.reason ?? "manager-requested";
      current.stopRequestedAt = stoppedAt;
      current.updatedAt = stoppedAt;
      return structuredClone(current);
    });

    const dirty: { dirty?: boolean; status?: string; error?: string } = await inspectWorkerDirtyState(worker)
      .catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
    await store.mutate((state) => {
      const current = state.workers.find((candidate) => candidate.id === worker.id && workerIncarnation(candidate) === workerIncarnation(worker));
      if (!current) return;
      if (dirty.dirty !== undefined) current.dirtyAtStop = dirty.dirty;
      if (dirty.status) current.dirtyStatusAtStop = dirty.status;
      if (dirty.error) current.dirtyCheckErrorAtStop = dirty.error;
    });

    let stopError: unknown;
    try {
      if (worker.unit) await stopUnit(runner, worker.unit);
    } catch (error) {
      stopError = error;
    }

    const finalWorker = await store.mutate((state) => {
      const current = state.workers.find((candidate) => candidate.id === worker.id && workerIncarnation(candidate) === workerIncarnation(worker));
      if (!current) throw new Error(`Worker ${worker.id} changed while it was stopping`);
      current.state = stopError ? "failed" : "stopped";
      current.stateReason = undefined;
      if (!stopError) current.mainPid = undefined;
      current.stoppedAt = Date.now();
      current.updatedAt = current.stoppedAt;
      current.lastError = stopError ? (stopError instanceof Error ? stopError.message : String(stopError)) : undefined;
      return structuredClone(current);
    });
    await updateStatus();
    if (stopError) throw stopError;
    if (config.pruneRuntimeCachesOnStop) {
      const terminalAt = terminalWorkerAt(finalWorker);
      if (terminalAt !== undefined) {
        await deleteTerminalRuntimeSafely({
          store,
          runner,
          agentDir,
          workerId: finalWorker.id,
          runId: workerIncarnation(finalWorker),
          terminalAt,
          action: "cache",
          eligible: (candidate) => isTerminalState(candidate.state),
        }).catch(() => false);
      }
    }
    return finalWorker;
  };

  const stopBossOrphanWorker = async (target: WorkerRecord, expectedManagerSessionId: string): Promise<WorkerRecord> => {
    const snapshot = await store.read();
    const worker = snapshot.workers.find((candidate) => candidate.id === target.id && workerIncarnation(candidate) === workerIncarnation(target));
    if (!worker) throw new Error(`Boss orphan ${target.id} changed before containment`);
    if (!worker.owned) throw new Error(`Boss orphan ${worker.id} is not owned by this orchestrator`);
    if (worker.managerSessionId !== expectedManagerSessionId) throw new Error(`Boss orphan ${worker.id} belongs to another manager session`);
    try {
      if (worker.unit) await stopUnit(runner, worker.unit);
      else if (!isTerminalState(worker.state) || worker.mainPid !== undefined) throw new Error(`Boss orphan ${worker.id} has no verifiable stopped unit`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await store.mutate((state) => {
        const current = state.workers.find((candidate) => candidate.id === worker.id && workerIncarnation(candidate) === workerIncarnation(worker));
        if (!current || current.bossRunId !== worker.bossRunId) return;
        current.lastError = message;
        current.stopReason = "boss-uncorrelated-worker-containment-failed";
        current.stopRequestedAt = Date.now();
        current.updatedAt = current.stopRequestedAt;
      });
      throw error;
    }
    return store.mutate((state) => {
      const current = state.workers.find((candidate) => candidate.id === worker.id && workerIncarnation(candidate) === workerIncarnation(worker));
      if (!current || current.bossRunId !== worker.bossRunId) throw new Error(`Boss orphan ${worker.id} changed while containment completed`);
      if (!current.owned || current.managerSessionId !== expectedManagerSessionId) throw new Error(`Boss orphan ${worker.id} ownership changed while containment completed`);
      current.state = "stopped";
      current.stateReason = undefined;
      current.mainPid = undefined;
      current.stoppedAt = Date.now();
      current.updatedAt = current.stoppedAt;
      current.stopReason = "boss-uncorrelated-worker-contained";
      current.lastError = undefined;
      delete current.bossRunId;
      return structuredClone(current);
    });
  };

  const synchronizeTrustedLocalBossWorkers = async (): Promise<boolean> => {
    let snapshot = await store.read();
    const recoveredBindings = await trustedLocalBossStore.recoverRequestedWorkerBindings(snapshot.workers);
    if (recoveredBindings) snapshot = await store.read();
    const orphans = (await trustedLocalBossStore.findOrphanedWorkers(snapshot.workers)).filter(({ worker }) => !bossBindingsInFlight.has(`${worker.id}\0${workerIncarnation(worker)}`));
    const failures: string[] = [];
    for (const orphan of orphans) {
      try {
        await stopBossOrphanWorker(orphan.worker, orphan.managerSessionId);
        await trustedLocalBossStore.recordOrphanedWorkerContained(orphan.bossRunId, orphan.assignmentRole, `Uncorrelated ${orphan.assignmentRole ?? "Boss"} worker ${orphan.worker.id} was stopped and de-correlated`);
      } catch (error) {
        failures.push(`${orphan.worker.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    snapshot = await store.read();
    const changed = await trustedLocalBossStore.synchronizeWorkers(snapshot.workers);
    if (failures.length) throw new Error(`Trusted-local Boss orphan containment failed: ${failures.join("; ")}`);
    return recoveredBindings || changed || orphans.length > 0;
  };

  const pruneTerminalWorker = async (target: WorkerRecord, expectedReason?: string, now = Date.now()): Promise<boolean> => {
    const terminalAt = terminalWorkerAt(target);
    if (terminalAt === undefined) return false;
    if (target.unit) await stopUnit(runner, target.unit);
    return deleteTerminalRuntimeSafely({
      store,
      runner,
      agentDir,
      workerId: target.id,
      runId: workerIncarnation(target),
      terminalAt,
      action: "full",
      now,
      eligible: (candidate) => isTerminalState(candidate.state)
        && (!expectedReason || stoppedWorkerRetentionReason(candidate, config, now) === expectedReason),
    });
  };

  const cleanupExpired = async (execute: boolean, now = Date.now()): Promise<CleanupExecution> => {
    await recoverCleanupClaims();
    await reconcile();
    await store.mutateConditionally((state) => {
      let changed = false;
      for (const worker of state.workers) changed = initializeWorkerLifecycle(worker, config, now) || changed;
      return { value: undefined, changed };
    });
    const migrated = await store.read();
    const claimedIds = new Set((migrated.runtimeCleanupClaims ?? []).map((claim) => claim.workerId));
    const liveCandidates = migrated.workers.flatMap((worker) => {
      const reason = cleanupReason(worker, now);
      return reason ? [{ worker, reason, kind: "stop" as const }] : [];
    });
    const pruneCandidates = config.pruneStoppedWorkersOnCleanup
      ? migrated.workers
        .filter((worker) => !claimedIds.has(worker.id))
        .flatMap((worker) => {
          const reason = stoppedWorkerRetentionReason(worker, config, now);
          return reason ? [{ worker, reason, kind: "prune" as const }] : [];
        })
      : [];
    const prunedRuns = new Set(pruneCandidates.map(({ worker }) => `${worker.id}\u0000${worker.runId}`));
    const cacheCandidates = config.pruneRuntimeCachesOnStop
      ? (await Promise.all(migrated.workers
        .filter((worker) => !claimedIds.has(worker.id) && isTerminalState(worker.state) && !prunedRuns.has(`${worker.id}\u0000${worker.runId}`))
        .map(async (worker) => {
          try {
            return { worker, paths: await existingTerminalCachePaths(worker.id, agentDir), error: undefined };
          } catch (error) {
            return { worker, paths: [], error: error instanceof Error ? error.message : String(error) };
          }
        })))
        .filter(({ paths, error }) => paths.length > 0 || Boolean(error))
        .map(({ worker, error }) => ({
          worker,
          reason: error ? `runtime cache inspection failed safely: ${error}` : "disposable runtime caches retained",
          kind: "cache" as const,
        }))
      : [];
    const registeredIds = new Set(migrated.workers.map((worker) => worker.id));
    const cleanupInventory = await captureCleanupUnitInventory(runner);
    const orphanCandidates: Array<Extract<CleanupCandidate, { kind: "orphan" }>> = [];
    if (cleanupInventory.verified) {
      const cutoff = now - config.orphanRuntimeRetentionMinutes * 60_000;
      for (const runtime of await listRuntimeRoots(agentDir)) {
        if (registeredIds.has(runtime.workerId) || claimedIds.has(runtime.workerId)) continue;
        const prefix = `agent-intercom-worker-${sanitizeUnitPart(runtime.workerId)}-`;
        if ([...cleanupInventory.units].some((unit) => unit.startsWith(prefix))) continue;
        const metadata = await lstat(runtime.path).catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        });
        if (metadata && metadata.mtimeMs <= cutoff) {
          orphanCandidates.push({
            workerId: runtime.workerId,
            path: runtime.path,
            reason: `private runtime has no worker record and has been unchanged for ${Math.ceil((now - metadata.mtimeMs) / 60_000)}m`,
            kind: "orphan",
          });
        }
      }
    }
    const candidates: CleanupCandidate[] = [...liveCandidates, ...pruneCandidates, ...cacheCandidates, ...orphanCandidates];
    if (!execute) return { candidates, handled: [], errors: [] };
    const handled = new Set<CleanupCandidate>();
    const errors: Array<{ candidate: CleanupCandidate; error: string }> = [];
    const stopResult = await executeCleanupCandidatesIsolated(liveCandidates, async (candidate) => {
      try {
        await stopWorker(candidate.worker, {
          reason: "idle-grace-expired",
          expectedCheckpointDeadlineAt: candidate.worker.checkpointDeadlineAt,
        });
        return true;
      } catch (error) {
        if (/lifecycle changed|renewed before expired cleanup/.test(error instanceof Error ? error.message : String(error))) return false;
        throw error;
      }
    });
    for (const candidate of stopResult.executed) handled.add(candidate);
    errors.push(...stopResult.errors);

    const terminalCandidates = [...pruneCandidates, ...cacheCandidates];
    const terminalResult = await deleteTerminalRuntimeBatchSafely({
      store,
      runner,
      agentDir,
      preMoveInventory: cleanupInventory,
      candidates: terminalCandidates.map((candidate) => {
        const terminalAt = terminalWorkerAt(candidate.worker);
        if (terminalAt === undefined) throw new Error(`Worker ${candidate.worker.id} changed before runtime cleanup batching`);
        return {
          workerId: candidate.worker.id,
          runId: workerIncarnation(candidate.worker),
          terminalAt,
          action: candidate.kind === "prune" ? "full" as const : "cache" as const,
          now,
          ...(candidate.kind === "prune" && candidate.worker.unit ? { stopRecordedUnit: candidate.worker.unit } : {}),
          eligible: (worker: WorkerRecord) => isTerminalState(worker.state)
            && (candidate.kind !== "prune" || stoppedWorkerRetentionReason(worker, config, now) === candidate.reason),
        };
      }),
    });
    terminalResult.deleted.forEach((deleted, index) => {
      if (deleted) handled.add(terminalCandidates[index]);
    });
    errors.push(...terminalResult.errors.map(({ index, error }) => ({ candidate: terminalCandidates[index], error })));

    const orphanResult = await executeCleanupCandidatesIsolated(orphanCandidates, async (candidate) => {
      return deleteOrphanRuntimeSafely({
        store,
        runner,
        config,
        agentDir,
        workerId: candidate.workerId,
        path: candidate.path,
        now,
      });
    });
    for (const candidate of orphanResult.executed) handled.add(candidate);
    errors.push(...orphanResult.errors);
    await updateStatus();
    return { candidates, handled: candidates.filter((candidate) => handled.has(candidate)), errors };
  };

  // Frequent manager heartbeats only observe their attached workers. Startup,
  // explicit fleet actions, and the managerless cleanup timer keep global
  // reconciliation, bounding detached-owner convergence without multiplying
  // every live unit check across every idle Pi session.
  const runLifecycleHeartbeat = async (ctx: ExtensionContext) => {
    const sessionId = managerSessionId(ctx);
    const snapshot = await store.read();
    const attached = workersAttachedToManager(snapshot.workers, sessionId);
    if (!attached.some((worker) => isLiveState(worker.state) || worker.state === "migration_pending")) {
      publishStatus(ctx, snapshot.workers);
      return { renewed: [], checkpointRequested: [], changed: false, checkpointRequests: [] };
    }
    const observedWorkers = await reconcile(sessionId, false);
    const now = Date.now();
    const result = await store.mutateConditionally((state) => {
      const value = renewObservedWorkerLeases(state, observedWorkers, sessionId, config, now);
      return { value, changed: value.changed };
    });
    publishStatus(ctx, observedWorkers);
    const checkpointRequests = result.checkpointRequested.flatMap((worker) => worker.intercomTarget ? [{
      workerId: worker.id,
      runId: worker.runId,
      target: worker.intercomTarget,
      message: checkpointMessage(worker, config),
    }] : []);
    return { ...result, checkpointRequests };
  };

  const enumerateOpenCodeModelInfo = async (): Promise<OpenCodeModelInfo[]> => {
    if (openCodeModelInfoCache && openCodeModelInfoCache.expiresAt > Date.now()) {
      return structuredClone(openCodeModelInfoCache.models);
    }
    const profileName = config.defaultProfiles.opencode;
    const command = profileName ? config.profiles[profileName]?.command : "opencode";
    const executable = command ? resolveProfileCommand(command) : undefined;
    if (!executable) return [];
    const result = await runner.exec(executable, ["models", "--verbose"], { timeout: 30000 });
    if (result.code !== 0) return [];
    const models = parseOpenCodeModelsVerbose(result.stdout);
    openCodeModelInfoCache = { expiresAt: Date.now() + 5 * 60_000, models };
    return structuredClone(models);
  };

  const enumerateModels = async (harness: Harness): Promise<string[]> => {
    const cached = modelCache.get(harness);
    if (cached && cached.expiresAt > Date.now()) return [...cached.models];
    const models = new Set(configuredModels(config, harness));
    if (harness === "opencode") {
      for (const info of await enumerateOpenCodeModelInfo()) models.add(info.id);
    } else {
      const piProfileName = config.defaultProfiles.pi;
      const piCommand = piProfileName ? config.profiles[piProfileName]?.command : "pi";
      const executable = piCommand ? resolveProfileCommand(piCommand) : undefined;
      if (executable) {
        const result = await runner.exec(executable, ["--list-models"], { timeout: 30000 });
        if (result.code === 0) {
          for (const model of parsePiModels(result.stdout)) {
            if (harness === "pi") models.add(model);
            else if (inferHarnessFromModel(model, config.routing.modelRouting) === harness) {
              models.add(normalizeModelForHarness(harness, model, config.routing.modelRouting) ?? model);
            }
          }
        }
      }
    }
    const result = [...models].sort();
    modelCache.set(harness, { expiresAt: Date.now() + 5 * 60_000, models: result });
    return [...result];
  };

  const resolveRouting = async (params: FleetParams): Promise<ResolvedRoute> => {
    const callerHarness = params.harness === "auto" ? undefined : params.harness;
    const callerEffort = params.effort === "auto" ? undefined : params.effort;
    const callerRequiresSubagents = params.subagents === "required"
      ? true
      : params.subagents === "not-required"
        ? false
        : params.subagents === "auto"
          ? undefined
          : params.requiresSubagents;
    const role = params.role?.trim() || "worker";
    const preset: RolePreset | undefined = config.roles[role];
    const requestedProfileName = params.profile?.trim() || undefined;
    const requestedProfile = requestedProfileName ? config.profiles[requestedProfileName] : undefined;
    if (requestedProfileName && !requestedProfile) throw new Error(`Unknown launch profile: ${requestedProfileName}`);
    const presetProfile = preset?.profile ? config.profiles[preset.profile] : undefined;
    const presetHarness = preset?.harness ?? presetProfile?.harness;
    const modelHarness = !callerHarness && !requestedProfile
      ? inferHarnessFromModel(params.model, config.routing.modelRouting)
      : undefined;
    const explicitHarness = callerHarness ?? requestedProfile?.harness ?? modelHarness;
    const profileOverrides: Partial<Record<Harness, string>> = {};
    if (requestedProfileName && explicitHarness) profileOverrides[explicitHarness] = requestedProfileName;
    const preferredProfiles: Partial<Record<Harness, string[]>> = {};
    if (!requestedProfileName && preset?.profile && presetHarness) preferredProfiles[presetHarness] = [preset.profile];
    const availability = detectHarnessAvailability(config, {
      profileOverrides,
      preferredProfiles,
      supportedEfforts: HARNESS_EFFORTS,
      resolveCommand: resolveProfileCommand,
    });

    const piFallbackReasons: string[] = [];
    for (const piProfileName of availability.pi.profileCandidates ?? []) {
      const piProfile = config.profiles[piProfileName];
      if (!piProfile) {
        piFallbackReasons.push(`profile fallback: profile '${piProfileName}' does not exist`);
        continue;
      }
      if (piProfile.harness !== "pi") {
        piFallbackReasons.push(`profile fallback: profile '${piProfileName}' launches ${piProfile.harness}, not pi`);
        continue;
      }
      if (piProfile.spawnable === false) {
        piFallbackReasons.push(`profile fallback: ${piProfile.description || `profile '${piProfileName}' is attach-only`}`);
        continue;
      }
      const configuredExecutable = resolveProfileCommand(piProfile.command);
      const piRuntime = await resolvePiRuntime({
        profileName: piProfileName,
        profile: piProfile,
        configuredExecutable,
        builtInProfile: DEFAULT_CONFIG.profiles["pi-peer"],
      });
      if (piRuntime) {
        availability.pi = {
          ...availability.pi,
          available: true,
          profile: piProfileName,
          executable: piRuntime.command,
          mode: piProfile.mode ?? "persistent",
          reasons: [...piFallbackReasons, piRuntime.source === "manager-runtime"
            ? `profile '${piProfileName}' is spawnable in ${piProfile.mode ?? "persistent"} mode through verified manager Pi${piRuntime.version ? ` ${piRuntime.version}` : ""} at ${piRuntime.command}`
            : `profile '${piProfileName}' is spawnable in ${piProfile.mode ?? "persistent"} mode at ${piRuntime.command}`],
        };
        break;
      }
      piFallbackReasons.push(`profile fallback: profile '${piProfileName}' (${piProfile.mode ?? "persistent"}) command '${piProfile.command}' is not executable`);
    }

    const permissionProfileName = params.permissionProfile?.trim() || preset?.permissionProfile || "builder-restricted";
    if (!config.permissionProfiles[permissionProfileName]) throw new Error(`Unknown permission profile: ${permissionProfileName}`);
    const candidateEfforts = Object.fromEntries(HARNESSES.flatMap((harness) => {
      const presetEffort = !presetHarness || presetHarness === harness ? preset?.effort : undefined;
      const effort = callerEffort ?? presetEffort ?? config.defaultEfforts[harness];
      return effort ? [[harness, effort]] : [];
    })) as Partial<Record<Harness, Effort>>;
    const requiresSubagents = roleRequiresSubagents(config.routing, role, callerRequiresSubagents);
    const decision = resolveHarnessRoute({
      role,
      defaultHarness: config.defaultHarness,
      routing: config.routing,
      availability,
      presetHarness,
      ...(explicitHarness ? { explicitHarness } : {}),
      ...(callerHarness
        ? { explicitSource: "harness" as const }
        : requestedProfile
          ? { explicitSource: "profile" as const }
          : modelHarness
            ? { explicitSource: "model" as const }
            : {}),
      requiresSubagents,
      requestedEffort: callerEffort,
      candidateEfforts,
    });
    const harness = decision.selected;
    const profileName = harness
      ? requestedProfileName
        ?? availability[harness].profile
        ?? (preset?.profile && presetProfile?.harness === harness ? preset.profile : undefined)
        ?? config.defaultProfiles[harness]
      : undefined;
    const effectiveEffort = harness ? candidateEfforts[harness] : undefined;
    return { role, harness, profileName, permissionProfileName, ...(effectiveEffort ? { effectiveEffort } : {}), availability, decision };
  };

  const resolveSpawn = async (params: FleetParams, ctx: ExtensionContext): Promise<ResolvedSpawn> => {
    const routed = await resolveRouting(params);
    const { role, harness, profileName, permissionProfileName } = routed;
    if (!harness) throw new Error(`${routed.decision.reasons[0]}. Use action=route to inspect exclusions or pass an explicit harness/profile/model.`);
    const task = params.task?.trim();
    if (!task) throw new Error("spawn requires task");
    if (!profileName) throw new Error(`No default profile configured for ${harness}`);
    const preset: RolePreset | undefined = config.roles[role];
    const presetProfile = preset?.profile ? config.profiles[preset.profile] : undefined;
    const presetHarness = preset?.harness ?? presetProfile?.harness;
    const presetMatchesHarness = !presetHarness || presetHarness === harness;
    if (presetHarness && !presetMatchesHarness) {
      routed.decision.reasons.push(`fell back from ${presetHarness} to ${harness}; ignored harness-specific preset model and effort`);
    }
    const permissionProfile = config.permissionProfiles[permissionProfileName];
    const model = normalizeModelForHarness(
      harness,
      params.model?.trim() || (presetMatchesHarness ? preset?.model : undefined) || config.defaultModels[harness],
      config.routing.modelRouting,
    );
    const effort = validateEffort(harness, routed.effectiveEffort);
    const instructions = roleInstructionsForHarness({
      routing: config.routing,
      preset,
      presetHarness,
      selectedHarness: harness,
      explicitInstructions: params.instructions,
    });
    return {
      harness,
      role,
      task,
      cwd: resolve(ctx.cwd, params.cwd || "."),
      profileName,
      permissionProfileName,
      permissionProfile,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(instructions ? { instructions } : {}),
      routing: routed.decision,
    };
  };

  const spawnWorker = async (params: FleetParams, ctx: ExtensionContext, resolved: ResolvedSpawn): Promise<WorkerRecord> => {
    const { harness, role, task, cwd, profileName, permissionProfileName, permissionProfile, model, effort, instructions } = resolved;
    if (harness === "opencode" && model && effort && effort !== "off") {
      const info = (await enumerateOpenCodeModelInfo()).find((candidate) => candidate.id === model);
      if (info && !info.variants.includes(effort)) {
        throw new Error(`OpenCode model ${model} does not support variant ${effort}; available variants: ${info.variants.join(", ") || "none"}`);
      }
    }
    const profile = config.profiles[profileName];
    if (!profile) throw new Error(`Unknown launch profile: ${profileName}`);
    if (profile.harness !== harness) throw new Error(`Profile ${profileName} launches ${profile.harness}, not ${harness}`);
    if (profile.spawnable === false) throw new Error(profile.description || `Profile ${profileName} is attach-only`);
    const effectiveMaxRuntime = profile.maxRuntime || config.maxRuntime;
    if (profile.mode !== "one-shot") {
      const runtimeSeconds = parseDurationToSeconds(effectiveMaxRuntime);
      const lifecycleSeconds = (config.idleTimeoutMinutes + config.cleanupGraceMinutes) * 60;
      if (Number.isFinite(runtimeSeconds) && runtimeSeconds <= lifecycleSeconds) {
        throw new Error(`Profile ${profileName} maxRuntime ${effectiveMaxRuntime} must exceed the ${config.idleTimeoutMinutes + config.cleanupGraceMinutes}-minute idle plus cleanup-grace window`);
      }
    }
    const id = validateWorkerId(params.id || `${harness}-${role}-${newRunId().slice(0, 6)}`);
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
      permissionProfile: permissionProfileName,
      model,
      effort,
      instructions,
      unit,
      managerSessionId: managerSessionId(ctx),
      config,
    });
    if (params.bossTeam) assertTrustedLocalBossControllerTarget(params.bossTeam, worker.managerSessionId);
    const persistentPi = harness === "pi" && profile.mode === "persistent";
    const verifiedPersistentPi = persistentPi && managerOwnerContext === "pi";
    const persistentOpenCode = harness === "opencode" && profile.mode === "persistent";
    const persistentAdapter = (harness === "codex" || harness === "claude")
      && profile.mode === "persistent"
      && COORDINATED_ADAPTER_PROFILES.has(profileName);
    const managerHealth = await getUserManagerHealth(runner);
    if (!managerHealth.responsive) {
      throw new Error(`systemd user manager is not responsive; refusing worker submission: ${managerHealth.error ?? "unknown liveness failure"}`);
    }
    if (managerHealth.settled === false) {
      throw new Error(`systemd user manager has ${managerHealth.persistentJobs?.length ?? managerHealth.jobCount ?? "unknown"} jobs that remained queued across the liveness window; refusing worker submission until the backlog clears`);
    }
    if ((managerHealth.jobCount ?? 0) > 32) {
      throw new Error(`systemd user manager has ${managerHealth.jobCount} queued jobs; refusing worker submission until the backlog clears`);
    }
    if (permissionProfile.hardened) {
      const version = await systemdVersion(runner);
      if (version !== undefined && version < 257) throw new Error(`Permission profile ${permissionProfileName} requires systemd 257 or newer for PrivatePIDs (found ${version})`);
      const bubblewrap = await runner.exec("/usr/bin/test", ["-x", "/usr/bin/bwrap"], { timeout: 5_000 });
      if (bubblewrap.code !== 0) {
        throw new Error(`Permission profile ${permissionProfileName} requires bubblewrap at /usr/bin/bwrap to isolate shared harness state`);
      }
    }
    const runtimeRoot = permissionProfile.hardened ? workerRuntimeRoot(id, agentDir) : undefined;
    const runtimeWorkerRoot = permissionProfile.hardened ? workerSocketRuntimeRoot(id) : undefined;
    let workerHealthPath: string | undefined;
    let workerStatePath: string | undefined;
    if (persistentOpenCode) {
      const stateDir = runtimeRoot ?? openCodePeerDir;
      const launchStateDir = runtimeWorkerRoot ?? stateDir;
      worker.healthPath = join(stateDir, `${id}.health.json`);
      worker.runtimeStatePath = join(stateDir, `${id}.state.json`);
      workerHealthPath = join(launchStateDir, `${id}.health.json`);
      workerStatePath = join(launchStateDir, `${id}.state.json`);
    } else if (persistentAdapter) {
      const stateDir = runtimeRoot ?? join(agentDir, "intercom", "orchestrator", "adapter-health");
      const launchStateDir = runtimeWorkerRoot ?? stateDir;
      worker.healthPath = join(stateDir, `${id}.${runId}.adapter-health.json`);
      workerHealthPath = join(launchStateDir, `${id}.${runId}.adapter-health.json`);
    }
    await store.mutate((state) => reserveWorkerRecord(state, worker));
    try {
      const runtime = permissionProfile.hardened ? await prepareWorkerRuntime(harness, id, agentDir, { profileName }) : undefined;
      if (persistentOpenCode || persistentAdapter) await rm(worker.healthPath!, { force: true });
      if (persistentOpenCode && params.fresh) await rm(worker.runtimeStatePath!, { force: true });
      let harnessArgs = buildWorkerArgs({ harness, profile, profileName, workerId: id, cwd, role, task, model, effort, instructions, managerTarget: worker.managerSessionId, permissionProfile });
      if (runtime?.extraArgs.length) harnessArgs.push(...runtime.extraArgs);
      const gitMetadataPaths = permissionProfile.git === "read-only" ? await discoverGitMetadataPaths(runner, cwd) : [];
      if (harness === "pi" && params.bossTeam) harnessArgs = addPiTools(harnessArgs, SAFE_PI_BOSS_RALPH_TOOLS);
      if (harness === "pi" && (permissionProfile.hardened || params.bossTeam)) {
        const extensions = [await resolvePiIntercomExtension(agentDir), ORCHESTRATOR_EXTENSION];
        if (params.bossTeam) extensions.push(await resolvePiRalphExtension(agentDir));
        harnessArgs.push("--no-extensions", ...extensions.flatMap((extension) => ["--extension", extension]));
      }
      const permissionEnvironment = buildPermissionEnvironment(permissionProfileName, permissionProfile);
      if (permissionProfile.git === "read-only") {
        permissionEnvironment.AGENT_INTERCOM_REAL_GIT = resolveProfileCommand("git") || "/usr/bin/git";
        const realGh = resolveProfileCommand("gh");
        if (realGh) permissionEnvironment.AGENT_INTERCOM_REAL_GH = realGh;
        const realTea = resolveProfileCommand("tea");
        if (realTea) permissionEnvironment.AGENT_INTERCOM_REAL_TEA = realTea;
        const realGlab = resolveProfileCommand("glab");
        if (realGlab) permissionEnvironment.AGENT_INTERCOM_REAL_GLAB = realGlab;
        const realNpm = resolveProfileCommand("npm");
        if (realNpm) permissionEnvironment.AGENT_INTERCOM_REAL_NPM = realNpm;
        for (const command of ["gcloud", "wrangler", "cloudflared", "cf"]) {
          const executable = resolveProfileCommand(command);
          if (executable) permissionEnvironment[`AGENT_INTERCOM_REAL_${command.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`] = executable;
        }
        permissionEnvironment.PATH = `${GIT_GUARD_BIN}:${profile.env?.PATH || process.env.PATH || ""}`;
      }
      const configuredExecutable = resolveProfileCommand(profile.command);
      const piRuntime = harness === "pi"
        ? await resolvePiRuntime({
          profileName,
          profile,
          configuredExecutable,
          builtInProfile: DEFAULT_CONFIG.profiles["pi-peer"],
        })
        : undefined;
      const executable = piRuntime?.command ?? configuredExecutable;
      if (!executable) throw new Error(`Launch command not found or not executable: ${profile.command}`);
      const wrappedLauncher = harness === "pi"
        ? PI_PEER_LAUNCHER
        : persistentAdapter
          ? ADAPTER_READINESS_LAUNCHER
          : harness === "opencode" && profile.mode === "persistent"
            ? OPENCODE_PEER_LAUNCHER
            : undefined;
      let launchCommand = wrappedLauncher ? process.execPath : executable;
      let args = wrappedLauncher
        ? persistentAdapter
          ? [wrappedLauncher, "--harness", harness, "--", executable, ...harnessArgs]
          : [wrappedLauncher, "--", executable, ...(piRuntime?.args ?? []), ...harnessArgs]
        : harnessArgs;
      if (params.bossTeam && !runtimeWorkerRoot) {
        throw new Error("Trusted-local Boss Pi participants require a hardened permission profile with a private runtime root");
      }
      const unitEnvironment: Record<string, string> = {
        ...permissionEnvironment,
        ...(runtime?.environment ?? {}),
        ...buildWorkerEnvironment(harness, id, role, model, {
          runId,
          unit,
          managerSessionId: worker.managerSessionId,
          fresh: params.fresh,
        }),
        ...buildOptionalTrustedLocalBossTeamEnvironment(params.bossTeam),
        ...(params.bossTeam ? buildTrustedLocalBossRalphEnvironment(params.bossTeam, runtimeWorkerRoot!) : {}),
        ...(persistentOpenCode ? {
          AGENT_INTERCOM_OPENCODE_HEALTH_PATH: workerHealthPath!,
          AGENT_INTERCOM_OPENCODE_STATE_PATH: workerStatePath!,
        } : {}),
        ...(persistentAdapter ? {
          AGENT_INTERCOM_ADAPTER_HEALTH_PATH: workerHealthPath!,
        } : {}),
      };
      if (permissionProfile.hardened) {
        unitEnvironment.AGENT_INTERCOM_ENV_ALLOWLIST = [...new Set([...Object.keys(profile.env ?? {}), ...Object.keys(unitEnvironment)])].join(",");
        args = [CLEAN_ENV_LAUNCHER, "--", process.execPath, SANDBOX_SUPERVISOR, "--", launchCommand, ...args];
        launchCommand = process.execPath;
      }
      await launchUnit(runner, {
        unit,
        profile: { ...profile, command: launchCommand, args: undefined },
        args,
        cwd,
        maxRuntime: effectiveMaxRuntime,
        stopTimeoutSeconds: config.stopTimeoutSeconds,
        properties: buildPermissionUnitProperties(
          permissionProfile,
          cwd,
          gitMetadataPaths,
          runtime?.writablePaths ?? [],
          runtime?.readOnlyPaths ?? [],
          runtime?.inaccessiblePaths ?? [],
          runtime?.bindPaths ?? [],
        ),
        environment: unitEnvironment,
      });
      let status = profile.mode === "persistent"
        ? await waitForUnitRunning(runner, unit)
        : await getUnitStatus(runner, unit);
      if (verifiedPersistentPi) {
        status = await waitForPiPeerReadiness(id, runId, unit);
      }
      if (persistentOpenCode) {
        const health = await waitForOpenCodePeerHealth(worker.healthPath!, runId);
        worker.externalSessionId = health.openCodeSessionId;
        worker.backendDetails = { ...health, systemd: status, readiness: "intercom-runid-verified" };
        await persistOpenCodePeerState(worker.runtimeStatePath!, id, health.openCodeSessionId!, cwd);
      } else if (persistentAdapter) {
        const health = await waitForAdapterPeerHealth(worker.healthPath!, runId, harness);
        worker.backendDetails = { ...health, systemd: status, readiness: "intercom-runid-verified" };
        await rm(worker.healthPath!, { force: true });
        worker.healthPath = undefined;
      } else {
        worker.backendDetails = {
          systemd: status,
          readiness: verifiedPersistentPi
            ? "intercom-runid-verified"
            : profile.mode === "persistent"
              ? "process-stable-unverified"
              : "submitted",
        };
      }
      if (profile.mode === "persistent") {
        status = await waitForUnitRunning(runner, unit, { timeoutMs: 5_000, stableMs: 250 });
        worker.backendDetails = { ...(worker.backendDetails as Record<string, unknown>), systemd: status };
      }
      return await store.mutate((state) => {
        const current = state.workers.find((candidate) => candidate.id === id && candidate.runId === runId);
        if (!current) throw new Error(`Worker ${id} changed while it was starting`);
        if (current.state === "provisioning") current.state = stateFromUnit(status, "provisioning");
        if ((verifiedPersistentPi || persistentOpenCode || persistentAdapter) && current.state === "registering") {
          current.state = "ready";
        }
        current.mainPid = status.mainPid;
        current.updatedAt = Date.now();
        if (worker.externalSessionId) current.externalSessionId = worker.externalSessionId;
        if (persistentAdapter) current.healthPath = undefined;
        if (worker.backendDetails) current.backendDetails = worker.backendDetails;
        if (profile.mode === "persistent" && current.state !== "registering" && current.state !== "ready") {
          throw new Error(`Worker ${id} did not reach a running registration state (${formatUnitStatus(status)})`);
        }
        return structuredClone(current);
      });
    } catch (error) {
      const cleanupError = await stopUnit(runner, unit).then(() => undefined).catch((stopError) => stopError);
      if (persistentAdapter && worker.healthPath) await rm(worker.healthPath, { force: true }).catch(() => undefined);
      await store.mutate((state) => {
        const current = state.workers.find((candidate) => candidate.id === id && candidate.runId === runId);
        if (!current) return;
        current.state = "failed";
        current.updatedAt = Date.now();
        const primary = error instanceof Error ? error.message : String(error);
        current.stopReason = "spawn-failed";
        current.stopRequestedAt = Date.now();
        if (persistentAdapter) current.healthPath = undefined;
        current.lastError = cleanupError
          ? `${primary}; cleanup is indeterminate: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
          : primary;
      });
      throw error;
    }
  };

  const formatCapabilities = async (): Promise<{ text: string; availability: Record<Harness, HarnessAvailability> }> => {
    const { availability } = await resolveRouting({ action: "route" });
    const text = [
      ...HARNESSES.map((harness) => {
      const matching = Object.entries(config.profiles).filter(([, profile]) => profile.harness === harness);
      const profiles = matching.map(([name]) => name);
      const modes = [...new Set(matching.map(([, profile]) => profile.mode ?? "persistent"))];
        const detected = availability[harness];
        return `${harness}: modes=${modes.join(",") || "(none)"} efforts=${HARNESS_EFFORTS[harness].join(",")} profiles=${profiles.join(",") || "(none)"} available=${detected.available} subagents=${detected.supportsSubagents}${detected.available ? "" : ` reason=${detected.reasons.join("; ")}`}`;
      }),
      `permissions: ${Object.keys(config.permissionProfiles).sort().join(",") || "(none)"}`,
    ].join("\n");
    return { text, availability };
  };

  pi.registerTool({
    name: "agent_fleet",
    label: "Agent Fleet",
    description:
      "Create and manage owned independent Pi, Codex, Claude Code, and OpenCode coworkers. Inspect coordinated adapter versions and preview or execute source-aware updates. Spawn/list results include direct Intercom targets; list/status default to workers owned by the current manager session.",
    promptSnippet: "Create, inspect, update, stop, and clean up owned cross-harness coworkers",
    promptGuidelines,
    parameters: AgentFleetParams,

    async execute(_toolCallId, params: FleetParams, signal, onUpdate, ctx) {
      if (!config) await loadConfig();
      if (signal?.aborted) throw new Error("Agent fleet action cancelled");

      if (params.action === "_heartbeat") {
        const result = await runLifecycleHeartbeat(ctx);
        return textResult(`Lifecycle heartbeat: renewed=${result.renewed.length} checkpoint=${result.checkpointRequests.length}.`, result);
      }

      if (params.action === "spawn") {
        const preview = await resolveSpawn(params, ctx);
        onUpdate?.(textResult(`Starting ${preview.harness}/${preview.role} coworker...`));
        const worker = await spawnWorker(params, ctx, preview);
        await updateStatus(ctx);
        const mode = worker.profile ? config.profiles[worker.profile]?.mode : undefined;
        const next = worker.harness === "opencode"
          ? mode === "persistent"
            ? "\nThe task initialized this persistent OpenCode session. It remains wakeable through Intercom until stopped."
            : "\nThe task was passed to this one-shot OpenCode run as its initial prompt."
          : worker.state === "ready"
            ? `\nIntercom registration for run ${worker.runId} was verified. Send the task directly to '${worker.intercomTarget}' with intercom_send:\n${worker.task}`
            : `\nThe worker process was submitted but did not produce a persistent readiness acknowledgment. Inspect status/logs before assignment delivery:\n${worker.task}`;
        const verb = worker.state === "ready" || worker.state === "working" || worker.state === "waiting" ? "Started" : "Launched";
        return textResult(`${verb} ${formatWorker(worker)}${preview.routing.automatic ? `\n${preview.routing.reasons[0]}.` : ""}${next}`, { worker, routing: preview.routing });
      }

      if (params.action === "route") {
        const routed = await resolveRouting(params);
        const selectedAvailability = routed.harness ? routed.availability[routed.harness] : undefined;
        const profile = routed.profileName
          ? `\nProfile: ${routed.profileName} (${selectedAvailability?.mode ?? "persistent"})`
          : "";
        const permission = `\nPermission: ${routed.permissionProfileName}`;
        const effort = `\nEffort: ${routed.effectiveEffort ?? "harness default"}`;
        const model = params.model?.trim()
          ? `\nModel: ${params.model.trim()}${routed.decision.explicitSource === "model" ? " (selected the direct harness; use action=models to verify live availability)" : ""}`
          : "";
        return textResult(`${formatRoutingDecision(routed.decision)}${profile}${permission}${effort}${model}\nPreview only; no coworker was spawned.`, {
          routing: routed.decision,
          availability: routed.availability,
          profile: routed.profileName,
          permissionProfile: routed.permissionProfileName,
          effort: routed.effectiveEffort,
          model: params.model?.trim(),
        });
      }

      if (params.action === "list" || params.action === "history") {
        const reconciled = await reconcile();
        const scoped = params.all
          ? reconciled
          : workersAttachedToManager(reconciled, managerSessionId(ctx));
        const workers = params.action === "history" || params.all
          ? scoped
          : scoped.filter((worker) => isLiveState(worker.state) || isRecentTerminalWorker(worker, config));
        const hiddenHistory = scoped.length - workers.length;
        return textResult(formatWorkers(workers, hiddenHistory), {
          workers,
          hiddenHistory,
          scope: params.all ? "all" : "manager",
          view: params.action,
        });
      }

      if (params.action === "status") {
        const reconciled = await reconcile();
        const visible = params.all
          ? reconciled
          : workersAttachedToManager(reconciled, managerSessionId(ctx));
        const workers = extractWorkers({ version: 1, workers: visible }, params.id);
        if (params.id && workers[0]?.unit) {
          const [processes, unitStatus] = await Promise.all([
            readUnitProcessTree(runner, workers[0].unit),
            getUnitStatus(runner, workers[0].unit),
          ]);
          const processText = processes.tree || "(unit cgroup is empty or unloaded)";
          return textResult(`${formatWorkers(workers)}\n\nSystemd: ${formatUnitStatus(unitStatus)}\n\nCgroup process tree:\n${processText}`, { workers, processes, unitStatus });
        }
        return textResult(formatWorkers(workers), { workers });
      }

      if (params.action === "stop") {
        if (!params.id) throw new Error("stop requires id");
        const worker = extractWorkers(await store.read(), params.id)[0];
        const stopped = await stopWorker(worker, { expectedManagerSessionId: managerSessionId(ctx), reason: "manager-requested" });
        const dirty = stopped.dirtyAtStop ? ` Worker cwd was dirty when stopped.${stopped.dirtyStatusAtStop ? `\n${stopped.dirtyStatusAtStop}` : ""}` : "";
        return textResult(`Stopped ${stopped.id}.${dirty}`, { worker: stopped });
      }

      if (params.action === "cleanup") {
        const result = await cleanupExpired(Boolean(params.execute));
        if (result.candidates.length === 0) return textResult("No live workers need stopping, no terminal worker retention has expired, no disposable runtime caches remain, and no orphan runtimes exist.", result);
        const selected = params.execute ? result.handled : result.candidates;
        const lines = selected.map((candidate) => `${candidate.kind === "orphan" ? candidate.workerId : candidate.worker.id} [${candidate.kind}]: ${candidate.reason}`);
        const failures = result.errors.map(({ candidate, error }) => `${candidate.kind === "orphan" ? candidate.workerId : candidate.worker.id} [${candidate.kind}]: ${error}`);
        return textResult(
          `${params.execute ? "Cleaned" : "Cleanup preview"}:\n${lines.join("\n") || "(no actions applied)"}${failures.length ? `\n\nFailed safely:\n${failures.join("\n")}` : ""}${params.execute ? "" : "\nRun cleanup with execute=true to stop expired live workers, prune retention-expired terminal workers, remove disposable caches, and delete orphan runtimes."}`,
          result,
        );
      }

      if (params.action === "prune") {
        if (params.acknowledge !== true) {
          throw new Error("Refusing bulk prune without acknowledge=true; this deletes retained harness session state");
        }
        const reconciled = await reconcile();
        const scoped = params.all
          ? reconciled
          : workersAttachedToManager(reconciled, managerSessionId(ctx));
        const selected = params.id
          ? extractWorkers({ version: 1, workers: scoped }, params.id)
          : scoped;
        const candidates = selected.filter((worker) => isTerminalState(worker.state));
        const pruned: string[] = [];
        const errors: Array<{ workerId: string; error: string }> = [];
        for (const worker of candidates) {
          try {
            if (await pruneTerminalWorker(worker)) pruned.push(worker.id);
          } catch (error) {
            errors.push({ workerId: worker.id, error: error instanceof Error ? error.message : String(error) });
          }
        }
        await updateStatus(ctx);
        const summary = pruned.length
          ? `Pruned ${pruned.length} terminal worker record${pruned.length === 1 ? "" : "s"}:\n${pruned.join("\n")}`
          : "No terminal workers were eligible for pruning.";
        const failures = errors.length ? `\n\nFailed safely:\n${errors.map(({ workerId, error }) => `${workerId}: ${error}`).join("\n")}` : "";
        return textResult(`${summary}${failures}`, { pruned, errors, scope: params.all ? "all" : "manager" });
      }

      if (params.action === "versions") {
        const adapters = await inspectVersions();
        const harnesses = await harnessVersions();
        return textResult(`${formatAdapterVersions(adapters)}\n\n${formatHarnessVersions(harnesses)}`, { adapters, harnesses });
      }

      if (params.action === "update") {
        const adapters = await inspectVersions();
        const plan = formatUpdatePlan(adapters);
        if (!params.execute) {
          return textResult(`${plan}\n\nPreview only. Run update with execute=true to apply recognized safe adapter updates.`, { adapters, executed: false });
        }
        const results: Array<{ id: string; command?: string; code?: number; stdout?: string; stderr?: string; skipped?: string }> = [];
        for (const adapter of adapters.filter((candidate) => candidate.status === "outdated" || candidate.status === "missing")) {
          if (!adapter.update) {
            results.push({ id: adapter.id, skipped: adapter.blockedReason ?? "no safe update command detected" });
            continue;
          }
          const result = await runner.exec(adapter.update.command, adapter.update.args, { timeout: 180000 });
          results.push({ id: adapter.id, command: adapter.update.display, code: result.code, stdout: result.stdout.trim(), stderr: result.stderr.trim() });
        }
        const lines = results.length === 0
          ? ["All detected Agent Intercom adapters are current."]
          : results.map((result) => result.skipped
            ? `${result.id}: skipped — ${result.skipped}`
            : `${result.id}: ${result.code === 0 ? "updated" : `failed (${result.code})`} — ${result.command}${result.stderr ? `\n  ${result.stderr}` : ""}`);
        lines.push("Restart updated coworkers. Run /reload in Pi after Pi or orchestrator updates.");
        return textResult(lines.join("\n"), { adapters, executed: true, results });
      }

      if (params.action === "doctor") {
        const managerHealth = await getUserManagerHealth(runner);
        const available = managerHealth.responsive && await systemdAvailable(runner);
        const adapters = await inspectVersions();
        const adapterDrift = adapters.filter((adapter) => adapter.status === "outdated" || adapter.status === "missing");
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
        const installedSystemdVersion = await systemdVersion(runner);
        const bubblewrap = await runner.exec("/usr/bin/bwrap", ["--version"], { timeout: 5000 });
        const bubblewrapAvailable = bubblewrap.code === 0;
        const hardenedProfilesReady = installedSystemdVersion === undefined
          ? "unknown"
          : installedSystemdVersion >= 257 && bubblewrapAvailable
            ? "yes"
            : `no (${installedSystemdVersion < 257 ? "requires systemd 257+" : "requires /usr/bin/bwrap"})`;
        const managedHelpers = await Promise.all([
          runner.exec("systemctl", ["is-active", "systemd-nsresourced.socket"], { timeout: 5000 }),
          runner.exec("systemctl", ["is-active", "systemd-mountfsd.socket"], { timeout: 5000 }),
        ]);
        const cleanupTimerChecks = await Promise.all([
          runner.exec("systemctl", ["--user", "is-enabled", CLEANUP_TIMER], { timeout: 5000 }),
          runner.exec("systemctl", ["--user", "is-active", CLEANUP_TIMER], { timeout: 5000 }),
          runner.exec("systemctl", ["--user", "cat", CLEANUP_SERVICE], { timeout: 5000 }),
        ]);
        const cleanupTimerStatus = {
          enabled: cleanupTimerChecks[0].code === 0,
          active: cleanupTimerChecks[1].code === 0,
          sourceCurrent: cleanupTimerChecks[2].code === 0
            && cleanupTimerChecks[2].stdout.includes(FLEET_CLEANUP_SCRIPT)
            && cleanupTimerChecks[2].stdout.includes(process.execPath),
        };
        const managedUserNamespaces = {
          nsresourced: managedHelpers[0].code === 0 ? managedHelpers[0].stdout.trim() || "active" : managedHelpers[0].stdout.trim() || "inactive",
          mountfsd: managedHelpers[1].code === 0 ? managedHelpers[1].stdout.trim() || "active" : managedHelpers[1].stdout.trim() || "inactive",
        };
        const state = await store.read();
        const recordedUnits = new Set(state.workers.map((worker) => worker.unit).filter(Boolean));
        const units = available ? await listWorkerUnits(runner) : [];
        const untrackedUnits = units.filter((unit) => !recordedUnits.has(unit));
        return textResult(
          [`systemd user manager: ${available ? "available" : "unavailable"} responsive=${managerHealth.responsive} settled=${managerHealth.settled ?? "unknown"} jobs=${managerHealth.jobCount ?? "unknown"}${managerHealth.error ? ` error=${managerHealth.error}` : ""} version=${installedSystemdVersion ?? "unknown"} bubblewrap=${bubblewrapAvailable ? "available" : "missing"} hardened-profiles=${hardenedProfilesReady}`, ...(managerHealth.jobs?.length ? [`systemd queued jobs: ${managerHealth.jobs.slice(0, 10).join(" | ")}${managerHealth.jobs.length > 10 ? ` | +${managerHealth.jobs.length - 10} more` : ""}`] : []), `managed user namespaces: nsresourced=${managedUserNamespaces.nsresourced} mountfsd=${managedUserNamespaces.mountfsd}`, `cleanup timer: enabled=${cleanupTimerStatus.enabled} active=${cleanupTimerStatus.active} source-current=${cleanupTimerStatus.sourceCurrent}`, `Pi peer launcher: ${PI_PEER_LAUNCHER}`, `Adapter readiness launcher: ${ADAPTER_READINESS_LAUNCHER}`, `OpenCode peer launcher: ${OPENCODE_PEER_LAUNCHER}`, `OpenCode Intercom plugin: ${opencodeIntercomPlugin}`, `adapter versions: ${adapterDrift.length ? `${adapterDrift.map((adapter) => `${adapter.id}=${adapter.current ?? "missing"}->${adapter.latest ?? "unknown"}`).join(", ")} — run agent_fleet update for commands` : "coordinated"}`, `permission profiles: ${Object.keys(config.permissionProfiles).sort().join(", ")}`, `config: ${configPath}`, `state: ${statePath}`, `untracked worker units: ${untrackedUnits.length ? untrackedUnits.join(", ") : "none"}`, ...profileLines].join("\n"),
          { systemd: available, managerHealth, systemdVersion: installedSystemdVersion, bubblewrapAvailable, hardenedProfilesReady, managedUserNamespaces, cleanupTimerStatus, piPeerLauncher: PI_PEER_LAUNCHER, adapterReadinessLauncher: ADAPTER_READINESS_LAUNCHER, opencodePeerLauncher: OPENCODE_PEER_LAUNCHER, opencodeIntercomPlugin, adapters, configPath, statePath, untrackedUnits },
        );
      }

      if (params.action === "logs") {
        if (!params.id) throw new Error("logs requires id");
        const worker = extractWorkers(await store.read(), params.id)[0];
        if (!worker.unit) throw new Error(`Worker ${worker.id} does not use a systemd unit`);
        const [logs, unitStatus] = await Promise.all([
          readUnitLogs(runner, worker.unit, params.lines),
          getUnitStatus(runner, worker.unit),
        ]);
        const neverStarted = !unitStatus.execMainStartTimestampMonotonic && !unitStatus.activeEnterTimestampMonotonic && !unitStatus.mainPid;
        const diagnostic = logs.startsWith("(no journal output") && neverStarted
          ? `\n\nSystemd: ${formatUnitStatus(unitStatus)}\nNo journal exists because systemd has no evidence that ExecStart ever ran.`
          : `\n\nSystemd: ${formatUnitStatus(unitStatus)}`;
        return textResult(`${logs}${diagnostic}`, { worker, unitStatus });
      }

      if (params.action === "renew") {
        const owner = managerSessionId(ctx);
        const now = Date.now();
        const workers = await store.mutate((state) => {
          const selected = extractWorkers(state, params.id);
          const renewed: WorkerRecord[] = [];
          for (const worker of selected) {
            if (!worker.owned || !isLiveState(worker.state) || worker.stateReason === "stop_in_progress") continue;
            if (worker.managerSessionId !== owner) throw new Error(`Worker ${worker.id} belongs to another manager session; adopt it before renewing`);
            recordWorkerActivity(worker, config, now);
            renewed.push(structuredClone(worker));
          }
          return renewed;
        });
        await updateStatus(ctx);
        return textResult(`Renewed ${workers.length} worker lease${workers.length === 1 ? "" : "s"}.`, { workers });
      }

      if (params.action === "forget") {
        if (!params.id) throw new Error("forget requires id");
        const owner = managerSessionId(ctx);
        const worker = extractWorkers(await store.read(), params.id)[0];
        if (!isTerminalState(worker.state)) {
          if (worker.managerSessionId !== owner) throw new Error(`Worker ${worker.id} belongs to another manager session; adopt it before forgetting`);
          throw new Error(worker.state === "migration_pending"
            ? `Refusing to forget migration-pending worker ${worker.id}; reconcile its legacy stopping state first`
            : `Refusing to forget live worker ${worker.id}; stop it first`);
        }
        if (params.acknowledge !== true) {
          const warnings = [
            worker.dirtyAtStop ? "worker cwd was dirty when stopped" : undefined,
            worker.stopReason?.startsWith("idle-") ? `worker stopped after ${worker.stopReason}` : undefined,
            !worker.stopReason ? "worker has no recorded stop reason or accepted handoff" : undefined,
          ].filter(Boolean).join("; ");
          throw new Error(`Refusing to forget stopped worker ${worker.id} without manager acknowledge=true${warnings ? ` (${warnings})` : ""}`);
        }
        const terminalAt = terminalWorkerAt(worker);
        if (terminalAt === undefined) throw new Error(`Worker ${worker.id} changed before its runtime could be deleted`);
        if (worker.unit) await stopUnit(runner, worker.unit);
        const forgotten = await deleteTerminalRuntimeSafely({
          store,
          runner,
          agentDir,
          workerId: worker.id,
          runId: workerIncarnation(worker),
          terminalAt,
          action: "full",
          eligible: (candidate) => isTerminalState(candidate.state),
        });
        if (!forgotten) throw new Error(`Worker ${worker.id} changed or a same-ID unit could not be verified absent before runtime deletion`);
        await updateStatus(ctx);
        return textResult(`Forgot worker record ${worker.id}.`);
      }

      if (params.action === "adopt") {
        if (!params.id) throw new Error("adopt requires id");
        const observed = extractWorkers({ version: 1, workers: await reconcile() }, params.id)[0];
        const owner = managerSessionId(ctx);
        const worker = await store.mutate((state) => {
          const current = state.workers.find((candidate) => candidate.id === observed.id && candidate.runId === observed.runId);
          if (!current) throw new Error(`Worker ${observed.id} changed before it could be adopted`);
          if (!current.owned) throw new Error(`Worker ${current.id} was not created by this orchestrator`);
          assertTrustedLocalBossWorkerAdoptionAllowed(current);
          if (!isLiveState(current.state) || current.stateReason === "stop_in_progress") throw new Error(`Worker ${current.id} is ${current.state}; only active live workers can be adopted`);
          const now = Date.now();
          current.managerOwner = rebindManagerOwner(current, managerOwnerContext, owner);
          current.managerSessionId = owner;
          recordWorkerActivity(current, config, now);
          return structuredClone(current);
        });
        await updateStatus(ctx);
        return textResult(`Adopted ${worker.id} into this manager session.`, { worker });
      }

      if (params.action === "capabilities") {
        const { text, availability } = await formatCapabilities();
        return textResult(text, { efforts: HARNESS_EFFORTS, roles: config.roles, routing: config.routing, availability, permissionProfiles: config.permissionProfiles });
      }

      if (params.action === "profiles") {
        const harness = params.harness === "auto" ? undefined : params.harness;
        const profiles = Object.entries(config.profiles).filter(([, profile]) => !harness || profile.harness === harness);
        const text = profiles.length === 0 ? "No matching profiles." : profiles.map(([name, profile]) => `${name} [${profile.harness}/${profile.mode ?? "persistent"}] ${profile.description ?? profile.command}`).join("\n");
        return textResult(text, { profiles: Object.fromEntries(profiles) });
      }

      if (params.action === "permissions") {
        const profiles = Object.entries(config.permissionProfiles);
        const text = profiles.length === 0
          ? "No permission profiles."
          : profiles.map(([name, profile]) => `${name} [workspace=${profile.workspace} git=${profile.git}${profile.hardened ? " hardened" : ""}] ${profile.description ?? ""}`.trim()).join("\n");
        return textResult(text, { permissionProfiles: config.permissionProfiles });
      }

      if (params.action === "models") {
        const harness = params.harness && params.harness !== "auto" ? params.harness : config.defaultHarness;
        if (harness === "opencode") {
          const info = await enumerateOpenCodeModelInfo();
          const text = info.length
            ? `opencode models:\n${info.map((model) => `${model.id}${model.variants.length ? ` [${model.variants.join(", ")}]` : " [no variants]"}`).join("\n")}`
            : "No opencode models could be enumerated.";
          return textResult(text, { harness, models: info.map((model) => model.id), modelInfo: info });
        }
        const models = await enumerateModels(harness);
        return textResult(models.length ? `${harness} models:\n${models.join("\n")}` : `No ${harness} models could be enumerated.`, { harness, models });
      }

      if (params.action === "variants") {
        if (!params.model) throw new Error("variants requires model");
        const info = (await enumerateOpenCodeModelInfo()).find((candidate) => candidate.id === params.model);
        if (!info) throw new Error(`OpenCode model not found: ${params.model}`);
        return textResult(info.variants.length ? `${info.id} variants:\n${info.variants.join("\n")}` : `${info.id} has no configured variants.`, { model: info.id, variants: info.variants });
      }

      if (params.action === "config") return textResult(formatConfig(config, configPath), { config, configPath });
      throw new Error(`Unsupported action: ${params.action}`);
    },

    renderCall(args, theme) {
      const id = args.id ? ` ${args.id}` : "";
      const harness = args.harness ? ` [${args.harness}]` : "";
      const permission = args.permissionProfile ? ` permission=${args.permissionProfile}` : "";
      return new Text(`${theme.fg("toolTitle", theme.bold("agent_fleet "))}${theme.fg("accent", args.action)}${theme.fg("muted", `${id}${harness}${permission}`)}`, 0, 0);
    },

    renderResult(result, { isPartial }, theme) {
      const first = result.content[0];
      const text = first?.type === "text" ? first.text : "(no output)";
      return new Text(theme.fg(isPartial ? "warning" : "toolOutput", text), 0, 0);
    },
  });

  async function executeTrustedLocalBoss(args: string, ctx: ExtensionContext) {
    if (!config) await loadConfig();
    await synchronizeTrustedLocalBossWorkers();
    const request = parseBossCommand(args);
    let result = await trustedLocalBossStore.execute(request, managerSessionId(ctx));

    if (request.action === "proof" && result.run) {
      const reviewer = result.run.assignments.find((assignment) => assignment.role === "adversary");
      if (reviewer?.state === "requested") {
        const reviewerParams: FleetParams = {
          action: "spawn",
          id: `boss-adversary-${result.run.bossRunId.slice(-12)}`,
          role: "challenger",
          task: [
            TRUSTED_LOCAL_BOSS_WARNING,
            `Adversarially review trusted-local Boss run ${result.run.bossRunId}.`,
            `Goal: ${result.run.goal}`,
            buildTrustedLocalBossParticipantPrompt({ bossRunId: result.run.bossRunId, role: "adversary", controllerTarget: result.run.managerSessionId }, result.run.goal),
            "Wait for the owning Pi session to deliver an exact advisory proof revision and digest before returning a decision.",
            "Do not claim protected authority, independent attestation, or tamper-proof evidence.",
          ].join("\n"),
          cwd: ctx.cwd,
          harness: TRUSTED_LOCAL_BOSS_PARTICIPANT_HARNESS,
          effort: "auto",
          subagents: "auto",
          bossTeam: { bossRunId: result.run.bossRunId, role: "adversary", controllerTarget: result.run.managerSessionId },
        };
        let spawnedReviewer: WorkerRecord | undefined;
        let reviewerBindingKey: string | undefined;
        try {
          const worker = await spawnWorker(reviewerParams, ctx, await resolveSpawn(reviewerParams, ctx));
          spawnedReviewer = worker;
          reviewerBindingKey = `${worker.id}\0${workerIncarnation(worker)}`;
          bossBindingsInFlight.add(reviewerBindingKey);
          await store.mutate((state) => {
            const current = state.workers.find((candidate) => candidate.id === worker.id && candidate.runId === worker.runId);
            if (!current) throw new Error(`Boss adversary ${worker.id} disappeared before run binding`);
            if (current.managerSessionId !== result.run!.managerSessionId) throw new Error(`Boss adversary ${worker.id} Controller ownership changed before run binding`);
            current.bossRunId = result.run!.bossRunId;
            current.updatedAt = Date.now();
          });
          worker.bossRunId = result.run.bossRunId;
          await trustedLocalBossStore.recordReviewerStarted(result.run.bossRunId, worker);
          if (reviewerBindingKey) bossBindingsInFlight.delete(reviewerBindingKey);
          spawnedReviewer = undefined;
        } catch (error) {
          if (reviewerBindingKey) bossBindingsInFlight.delete(reviewerBindingKey);
          if (spawnedReviewer) await stopBossOrphanWorker(spawnedReviewer, managerSessionId(ctx)).catch(() => undefined);
          await trustedLocalBossStore.recordReviewerFailed(result.run.bossRunId, error);
        }
        result = await trustedLocalBossStore.execute(request, managerSessionId(ctx));
      }
      const deliveredProof = result.run?.proofPackets.at(-1);
      const assignedReviewer = result.run?.assignments.find((assignment) => assignment.role === "adversary");
      const priorProofDelivery = deliveredProof ? result.run?.deliveries.find((delivery) => delivery.kind === "proof-review" && delivery.proofPacketId === deliveredProof.proofPacketId) : undefined;
      if (deliveredProof && assignedReviewer?.workerId && (!priorProofDelivery || priorProofDelivery.state === "failed")) {
        let deliveryError: unknown;
        try {
          const snapshot = await store.read();
          const reviewerWorker = snapshot.workers.find((candidate) => candidate.id === assignedReviewer.workerId && workerIncarnation(candidate) === assignedReviewer.workerIncarnationId && candidate.bossRunId === result.run!.bossRunId && candidate.managerSessionId === result.run!.managerSessionId);
          if (!reviewerWorker || !isLiveState(reviewerWorker.state)) throw new Error("Exact live Boss adversary is unavailable for proof delivery");
          pi.events.emit(INTERCOM_LIFECYCLE_SEND_EVENT, {
            to: reviewerWorker.intercomTarget ?? reviewerWorker.id,
            message: `${TRUSTED_LOCAL_BOSS_WARNING}\nReview exact advisory proof ${deliveredProof.proofPacketId} revision ${deliveredProof.revision} sha256:${deliveredProof.snapshotSha256} for Boss run ${result.run!.bossRunId}. Report concrete blockers to the owning Pi session.`,
          });
        } catch (error) {
          deliveryError = error;
        }
        await trustedLocalBossStore.recordProofDelivery(result.run!.bossRunId, deliveredProof.proofPacketId, deliveryError);
        result = await trustedLocalBossStore.execute({ action: "status", bossRunId: result.run!.bossRunId }, managerSessionId(ctx));
        result.message += `\n\nProof revision ${deliveredProof.revision} is bound to sha256:${deliveredProof.snapshotSha256}; local review delivery ${deliveryError === undefined ? "succeeded" : "failed"}. No protected attestation is claimed.`;
      }
      return result;
    }

    if (request.action === "cancel" && result.run) {
      let stopError: unknown;
      try {
        const snapshot = await store.read();
        const failures: string[] = [];
        for (const assignment of result.run.assignments.filter((candidate) => candidate.state === "assigned" && candidate.workerId && candidate.workerIncarnationId)) {
          try {
            const worker = snapshot.workers.find((candidate) => candidate.id === assignment.workerId && workerIncarnation(candidate) === assignment.workerIncarnationId && candidate.bossRunId === result.run!.bossRunId && candidate.managerSessionId === result.run!.managerSessionId);
            if (!worker) {
              const conflicting = snapshot.workers.find((candidate) => candidate.id === assignment.workerId && candidate.bossRunId === result.run!.bossRunId && candidate.managerSessionId === result.run!.managerSessionId);
              if (conflicting) throw new Error(`Boss ${assignment.role} worker identity changed before cancellation`);
              continue;
            }
            if (isLiveState(worker.state)) await stopWorker(worker, { expectedManagerSessionId: result.run!.managerSessionId, reason: "boss-run-cancelled" });
          } catch (error) {
            failures.push(`${assignment.role}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (failures.length) throw new Error(failures.join("; "));
      } catch (error) {
        stopError = error;
      }
      result = { title: result.title, message: result.message, run: await trustedLocalBossStore.recordCancellationResult(result.run.bossRunId, stopError) };
      result.message = `${result.run ? `${TRUSTED_LOCAL_BOSS_WARNING}\nrun: ${result.run.bossRunId}\nstate: ${result.run.state}\ncancellation: ${result.run.cancellation?.state}${result.run.cancellation?.error ? ` — ${result.run.cancellation.error}` : ""}` : result.message}`;
      return result;
    }

    if ((request.action === "pause" || request.action === "resume") && result.run) {
      const kind = request.action === "pause" ? "pause-notice" : "resume-notice";
      const snapshot = await store.read();
      for (const assignment of result.run.assignments.filter((candidate) => candidate.state === "assigned" && candidate.workerId && candidate.workerIncarnationId)) {
        let deliveryError: unknown;
        try {
          const worker = snapshot.workers.find((candidate) => candidate.id === assignment.workerId && workerIncarnation(candidate) === assignment.workerIncarnationId && candidate.bossRunId === result.run!.bossRunId && candidate.managerSessionId === result.run!.managerSessionId);
          if (!worker || !isLiveState(worker.state)) throw new Error(`Exact live ${assignment.role} worker is unavailable`);
          pi.events.emit(INTERCOM_LIFECYCLE_SEND_EVENT, {
            to: worker.intercomTarget ?? worker.id,
            message: `${TRUSTED_LOCAL_BOSS_WARNING}\nBoss run ${result.run.bossRunId} ${request.action} requested. ${request.note ?? "Apply this as a best-effort local workflow control and report your state."}`,
          });
        } catch (error) {
          deliveryError = error;
        }
        await trustedLocalBossStore.recordControlDelivery(result.run.bossRunId, assignment.role, kind, deliveryError);
      }
      result = await trustedLocalBossStore.execute({ action: "status", bossRunId: result.run.bossRunId }, managerSessionId(ctx));
      return result;
    }

    if (request.action !== "create" || !result.run) {
      return result;
    }

    const bossRunId = result.run.bossRunId;
    const [managerTarget, workerTarget, scoutTarget] = trustedLocalBossParticipantTargets(bossRunId);
    const staffing = [
      { role: "manager" as const, fleetRole: "manager", id: managerTarget, task: `You are the sole Manager for trusted-local Boss run ${bossRunId}. Build a bounded plan, coordinate the assigned Worker and Scout through ordinary Agent Intercom, track evidence and blockers, and report progress to the owning Pi session.` },
      { role: "worker" as const, fleetRole: "worker", id: workerTarget, task: `You are the implementation Worker for trusted-local Boss run ${bossRunId}. Execute bounded work assigned by the Manager, verify it, and report progress and blockers through ordinary Agent Intercom.` },
      { role: "scout" as const, fleetRole: "scout", id: scoutTarget, task: `You are the Scout for trusted-local Boss run ${bossRunId}. Investigate dependencies, risks, and verification gaps; make no authority claims and report findings through ordinary Agent Intercom.` },
    ];
    for (const member of staffing) {
      const params: FleetParams = {
        action: "spawn",
        id: member.id,
        role: member.fleetRole,
        task: [
          TRUSTED_LOCAL_BOSS_WARNING,
          member.task,
          `Goal: ${result.run.goal}`,
          buildTrustedLocalBossParticipantPrompt({ bossRunId, role: member.role, controllerTarget: result.run.managerSessionId }, result.run.goal),
          "Do not claim protected authority or tamper-proof evidence.",
        ].join("\n"),
        cwd: ctx.cwd,
        harness: TRUSTED_LOCAL_BOSS_PARTICIPANT_HARNESS,
        effort: "auto",
        subagents: "auto",
        bossTeam: { bossRunId, role: member.role, controllerTarget: result.run.managerSessionId },
      };
      let spawnedMember: WorkerRecord | undefined;
      let memberBindingKey: string | undefined;
      try {
        const worker = await spawnWorker(params, ctx, await resolveSpawn(params, ctx));
        spawnedMember = worker;
        memberBindingKey = `${worker.id}\0${workerIncarnation(worker)}`;
        bossBindingsInFlight.add(memberBindingKey);
        await store.mutate((state) => {
          const current = state.workers.find((candidate) => candidate.id === worker.id && candidate.runId === worker.runId);
          if (!current) throw new Error(`Boss ${member.role} ${worker.id} disappeared before run binding`);
          if (current.managerSessionId !== result.run!.managerSessionId) throw new Error(`Boss ${member.role} ${worker.id} Controller ownership changed before run binding`);
          current.bossRunId = bossRunId;
          current.updatedAt = Date.now();
        });
        worker.bossRunId = bossRunId;
        await trustedLocalBossStore.recordAssignmentStartedForRole(bossRunId, member.role, worker);
        if (memberBindingKey) bossBindingsInFlight.delete(memberBindingKey);
        spawnedMember = undefined;
        await updateStatus(ctx);
      } catch (error) {
        if (memberBindingKey) bossBindingsInFlight.delete(memberBindingKey);
        if (spawnedMember) await stopBossOrphanWorker(spawnedMember, managerSessionId(ctx)).catch(() => undefined);
        await trustedLocalBossStore.recordAssignmentFailedForRole(bossRunId, member.role, error);
        if (member.role === "manager") break;
      }
    }
    const staffed = await trustedLocalBossStore.execute({ action: "status", bossRunId }, managerSessionId(ctx));
    if (staffed.run) {
      const snapshot = await store.read();
      for (const assignment of staffed.run.assignments.filter((candidate) => candidate.state === "assigned" && candidate.workerId && candidate.workerIncarnationId)) {
        const worker = snapshot.workers.find((candidate) => candidate.id === assignment.workerId
          && workerIncarnation(candidate) === assignment.workerIncarnationId
          && candidate.bossRunId === bossRunId
          && candidate.managerSessionId === staffed.run!.managerSessionId);
        if (!worker || !isLiveState(worker.state)) continue;
        pi.events.emit(INTERCOM_LIFECYCLE_SEND_EVENT, {
          to: worker.intercomTarget ?? worker.id,
          message: `${TRUSTED_LOCAL_BOSS_WARNING}\nInitial ${assignment.role} assignment for Boss run ${bossRunId}: ${assignment.task}\nBegin now using the isolated Ralph protocol from your launch mandate.`,
        });
      }
    }
    return staffed;
  }

  pi.registerTool({
    name: "boss",
    label: "Boss",
    description: "Create and manage Controller-owned trusted-local Boss runs. The current top-level Pi session is the Controller. Boss participants cannot access this tool.",
    promptSnippet: "Create and manage Controller-owned trusted-local Boss teams",
    promptGuidelines: [
      "Use boss when the user asks the top-level Pi Controller to create or manage a Boss run; do not ask the user to type /boss.",
      "Boss runs use trusted-local advisory scoping, not protected or tamper-proof authority.",
      "Use exact bossRunId values returned by boss for status, pause, resume, proof, approval, rejection, and cancellation.",
    ],
    parameters: Type.Object({
      action: StringEnum(["create", "status", "resume", "pause", "cancel", "proof", "approve", "reject"] as const),
      goal: Type.Optional(Type.String({ description: "Explicit goal; required for create." })),
      bossRunId: Type.Optional(Type.String({ description: "Exact Boss run id; required except for create and status-all." })),
      note: Type.Optional(Type.String({ description: "Optional control or decision note." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const args = params.action === "create"
        ? `create ${params.goal ?? ""}`
        : `${params.action}${params.bossRunId ? ` ${params.bossRunId}` : ""}${params.note ? ` ${params.note}` : ""}`;
      const result = await executeTrustedLocalBoss(args, ctx);
      return {
        content: [{ type: "text", text: result.message }],
        details: { title: result.title, run: result.run, runs: result.runs },
      };
    },
    renderCall(args, theme) {
      const target = args.bossRunId ? ` ${args.bossRunId}` : "";
      return new Text(`${theme.fg("toolTitle", theme.bold("boss "))}${theme.fg("accent", args.action)}${theme.fg("muted", target)}`, 0, 0);
    },
    renderResult(result, { isPartial }, theme) {
      const first = result.content[0];
      const text = first?.type === "text" ? first.text : "(no output)";
      return new Text(theme.fg(isPartial ? "warning" : "toolOutput", text), 0, 0);
    },
  });

  pi.registerCommand("boss", {
    description: "Create and manage a trusted-local Boss run (same-user agents trusted; advisory evidence)",
    getArgumentCompletions: (prefix) => {
      const actions = ["create", "status", "resume", "pause", "cancel", "proof", "approve", "reject"];
      const filtered = actions.filter((action) => action.startsWith(prefix.trim().toLowerCase()));
      return filtered.length ? filtered.map((action) => ({ value: action, label: action })) : null;
    },
    handler: async (args, ctx) => {
      try {
        assertDirectInteractiveBossCommand(ctx);
        const result = await executeTrustedLocalBoss(args, ctx);
        await ctx.ui.editor(result.title, result.message);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("agents-models", {
    description: "Browse models available to a worker harness",
    handler: async (args, ctx) => {
      if (!config) await loadConfig();
      const requested = args.trim();
      const harness = HARNESSES.includes(requested as Harness) ? requested as Harness : config.defaultHarness;
      const models = await enumerateModels(harness);
      const text = harness === "opencode"
        ? (await enumerateOpenCodeModelInfo()).map((model) => `${model.id}${model.variants.length ? ` [${model.variants.join(", ")}]` : " [no variants]"}`).join("\n")
        : models.join("\n");
      const display = text || `No ${harness} models could be enumerated.`;
      if (ctx.hasUI) await ctx.ui.editor(`${harness} models`, display);
      else ctx.ui.notify(display, "info");
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
      const permissionProfile = await ctx.ui.select(
        "Permission profile",
        preferredFirst(Object.keys(config.permissionProfiles).sort(), preset?.permissionProfile || "builder-restricted"),
      );
      if (!permissionProfile) return;
      const models = await enumerateModels(harness);
      const defaultModel = preset?.model || config.defaultModels[harness];
      const modelOptions = ["(harness default)", ...models];
      const modelChoice = await ctx.ui.select("Model", preferredFirst(modelOptions, defaultModel || "(harness default)"));
      if (!modelChoice) return;
      let effortOptions: string[] = ["(harness default)", ...HARNESS_EFFORTS[harness]];
      let defaultEffort = preset?.effort || config.defaultEfforts[harness] || "(harness default)";
      if (harness === "opencode" && modelChoice !== "(harness default)") {
        const info = (await enumerateOpenCodeModelInfo()).find((candidate) => candidate.id === modelChoice);
        const variants = info?.variants.filter((variant): variant is Effort => EFFORTS.includes(variant as Effort)) ?? [];
        effortOptions = ["(model default)", "off", ...variants];
        if (!effortOptions.includes(defaultEffort)) defaultEffort = "(model default)";
      }
      const effortChoice = await ctx.ui.select("Effort / model variant", preferredFirst(effortOptions, defaultEffort));
      if (!effortChoice) return;
      const effort = effortChoice === "(harness default)" || effortChoice === "(model default)" ? undefined : effortChoice as Effort;
      const suggestedId = `${harness}-${role}-${newRunId().slice(0, 6)}`;
      const id = (await ctx.ui.input("Worker id", suggestedId))?.trim() || suggestedId;
      const cwd = (await ctx.ui.input("Working directory", ctx.cwd))?.trim() || ctx.cwd;
      const task = await ctx.ui.editor("Assignment or standing mandate", preset?.instructions || "");
      if (!task?.trim()) return;
      const summary = [`id: ${id}`, `role: ${role}`, `harness: ${harness}`, `profile: ${profile}`, `permission: ${permissionProfile}`, `model: ${modelChoice}`, `effort: ${effort ?? "(harness default)"}`, `cwd: ${cwd}`, "", task.trim()].join("\n");
      if (!(await ctx.ui.confirm("Spawn coworker?", summary))) return;
      const spawnParams: FleetParams = { action: "spawn", id, role, harness, profile, permissionProfile, model: modelChoice === "(harness default)" ? undefined : modelChoice, effort, cwd, task: task.trim() };
      const worker = await spawnWorker(spawnParams, ctx, await resolveSpawn(spawnParams, ctx));
      const mode = worker.profile ? config.profiles[worker.profile]?.mode : undefined;
      const next = worker.harness === "opencode"
        ? mode === "persistent" ? "The OpenCode session is initialized and remains wakeable through Intercom." : "Task started as the initial OpenCode prompt."
        : `Send the assignment directly to ${worker.intercomTarget} with intercom_send; retry briefly if it is still registering. Use intercom_ask only for a later blocking decision.`;
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
          openCodeModelInfoCache = undefined;
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
          const idleTimeout = await ctx.ui.input("Idle timeout minutes", String(draft.idleTimeoutMinutes));
          const checkpointWarning = await ctx.ui.input("Checkpoint warning minutes before idle deadline", String(draft.checkpointWarningMinutes));
          const checkpointRetry = await ctx.ui.input("Checkpoint retry minutes", String(draft.checkpointRetryMinutes));
          const cleanupGrace = await ctx.ui.input("Cleanup grace minutes after idle deadline", String(draft.cleanupGraceMinutes));
          const cleanupTimerChoice = await ctx.ui.select("Enable managerless cleanup timer?", preferredFirst(["yes", "no"], draft.cleanupTimerEnabled ? "yes" : "no"));
          const cleanupTimer = await ctx.ui.input("Managerless cleanup timer minutes", String(draft.cleanupTimerMinutes));
          const recentStoppedHours = await ctx.ui.input("Hours of terminal history shown by default", String(draft.recentStoppedWorkerHours));
          const stoppedRetentionDays = await ctx.ui.input("Clean terminal worker retention days", String(draft.stoppedWorkerRetentionDays));
          const dirtyRetentionDays = await ctx.ui.input("Dirty terminal worker retention days", String(draft.dirtyStoppedWorkerRetentionDays));
          const orphanRetentionMinutes = await ctx.ui.input("Unregistered runtime retention minutes", String(draft.orphanRuntimeRetentionMinutes));
          const pruneStoppedChoice = await ctx.ui.select("Prune retention-expired terminal workers during cleanup?", preferredFirst(["yes", "no"], draft.pruneStoppedWorkersOnCleanup ? "yes" : "no"));
          const pruneCachesChoice = await ctx.ui.select("Remove disposable package caches from stopped runtimes?", preferredFirst(["yes", "no"], draft.pruneRuntimeCachesOnStop ? "yes" : "no"));
          const heartbeatSeconds = await ctx.ui.input("Heartbeat seconds", String(draft.heartbeatSeconds));
          const maxRuntime = await ctx.ui.input("Maximum runtime (systemd duration)", draft.maxRuntime);
          const cleanupChoice = await ctx.ui.select("Cleanup live owned workers on manager shutdown?", preferredFirst(["yes", "no"], draft.cleanupOnShutdown ? "yes" : "no"));
          if (lease && Number(lease) > 0) draft.leaseMinutes = Number(lease);
          if (idleTimeout && Number(idleTimeout) > 0) draft.idleTimeoutMinutes = Number(idleTimeout);
          if (checkpointWarning && Number(checkpointWarning) > 0) draft.checkpointWarningMinutes = Number(checkpointWarning);
          if (checkpointRetry && Number(checkpointRetry) > 0) draft.checkpointRetryMinutes = Number(checkpointRetry);
          if (cleanupGrace && Number(cleanupGrace) > 0) draft.cleanupGraceMinutes = Number(cleanupGrace);
          if (cleanupTimerChoice === "yes") draft.cleanupTimerEnabled = true;
          if (cleanupTimerChoice === "no") draft.cleanupTimerEnabled = false;
          if (cleanupTimer && Number(cleanupTimer) > 0) draft.cleanupTimerMinutes = Number(cleanupTimer);
          if (recentStoppedHours && Number(recentStoppedHours) > 0) draft.recentStoppedWorkerHours = Number(recentStoppedHours);
          if (stoppedRetentionDays && Number(stoppedRetentionDays) > 0) draft.stoppedWorkerRetentionDays = Number(stoppedRetentionDays);
          if (dirtyRetentionDays && Number(dirtyRetentionDays) > 0) draft.dirtyStoppedWorkerRetentionDays = Number(dirtyRetentionDays);
          if (orphanRetentionMinutes && Number(orphanRetentionMinutes) > 0) draft.orphanRuntimeRetentionMinutes = Number(orphanRetentionMinutes);
          if (pruneStoppedChoice === "yes") draft.pruneStoppedWorkersOnCleanup = true;
          if (pruneStoppedChoice === "no") draft.pruneStoppedWorkersOnCleanup = false;
          if (pruneCachesChoice === "yes") draft.pruneRuntimeCachesOnStop = true;
          if (pruneCachesChoice === "no") draft.pruneRuntimeCachesOnStop = false;
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
          const permissionProfile = await ctx.ui.select("Role permission profile", preferredFirst(Object.keys(draft.permissionProfiles).sort(), role.permissionProfile || "builder-restricted"));
          const model = await ctx.ui.input("Role model (blank = harness default)", role.model || "");
          const effortChoice = await ctx.ui.select("Role effort", preferredFirst(["(harness default)", ...HARNESS_EFFORTS[harness]], role.effort || draft.defaultEfforts[harness] || "(harness default)"));
          const effort = effortChoice && effortChoice !== "(harness default)" ? effortChoice as Effort : undefined;
          const instructions = await ctx.ui.editor("Role instructions", role.instructions || "");
          draft.roles[roleName] = { harness, ...(profile ? { profile } : {}), ...(permissionProfile ? { permissionProfile } : {}), ...(model?.trim() ? { model: model.trim() } : {}), ...(effort ? { effort } : {}), ...(instructions?.trim() ? { instructions: instructions.trim() } : {}) };
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
    description: "Preview or execute live-worker, retained-history, and runtime-cache cleanup",
    handler: async (args, ctx) => {
      if (!config) await loadConfig();
      const execute = args.trim() === "execute" || args.trim() === "--execute";
      const preview = await cleanupExpired(false);
      if (preview.candidates.length === 0) {
        ctx.ui.notify("No live workers need stopping, no terminal worker retention has expired, no disposable runtime caches remain, and no orphan runtimes exist.", "info");
        return;
      }
      const summary = preview.candidates.map((candidate) => `${candidate.kind === "orphan" ? candidate.workerId : candidate.worker.id} [${candidate.kind}]: ${candidate.reason}`).join("\n");
      if (!execute) {
        if (ctx.hasUI) await ctx.ui.editor("Cleanup preview", `${summary}\n\nRun /agents-cleanup execute to apply cleanup.`);
        return;
      }
      if (ctx.hasUI && !(await ctx.ui.confirm("Apply worker cleanup?", summary))) return;
      const result = await cleanupExpired(true);
      ctx.ui.notify(`Applied ${result.handled.length} cleanup action${result.handled.length === 1 ? "" : "s"}${result.errors.length ? `; ${result.errors.length} failed safely` : ""}.`, result.errors.length ? "warning" : "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    pi.events.emit(INTERCOM_CONTROL_REGISTER_EVENT, { type: WORKER_READINESS_ACK, version: 1 });
    registerOwnedWorkerReadinessProbeType(pi);
    await loadConfig();
    await recoverCleanupClaims();
    if (process.env.AGENT_INTERCOM_DISABLE_CLEANUP_TIMER !== "1") {
      void ensureCleanupTimer({ runner, config, cleanupScriptPath: FLEET_CLEANUP_SCRIPT, agentDir }).catch((error) => {
        console.error(`[agent-intercom-orchestrator] Could not configure cleanup timer: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    await reconcile();
    await synchronizeTrustedLocalBossWorkers();
    if (config.cleanupExpiredOnStart && process.env.AGENT_INTERCOM_SKIP_STARTUP_CLEANUP !== "1") await cleanupExpired(true);
    clearInterval(heartbeat);
    heartbeatRunning = false;
    heartbeat = setInterval(() => {
      if (heartbeatRunning) return;
      heartbeatRunning = true;
      void runLifecycleHeartbeat(ctx).then(async (result) => {
        if (currentCtx !== ctx) return;
        await synchronizeTrustedLocalBossWorkers();
        for (const request of result.checkpointRequests) {
          pi.events.emit(INTERCOM_LIFECYCLE_SEND_EVENT, {
            to: request.target,
            message: request.message,
            workerId: request.workerId,
            runId: request.runId,
          });
        }
      }).catch(() => undefined).finally(() => {
        heartbeatRunning = false;
      });
    }, Math.max(10, config.heartbeatSeconds) * 1000);
    heartbeat.unref?.();
  });

  pi.on("session_shutdown", async (event, ctx) => {
    clearInterval(heartbeat);
    heartbeat = undefined;
    heartbeatRunning = false;
    unsubscribeWorkerActivity();
    unsubscribeReadinessAcks();
    unsubscribeWorkerReadiness?.();
    readinessAcks.clear();
    ctx.ui.setStatus(STATUS_KEY, undefined);
    if (config?.cleanupOnShutdown && event.reason !== "reload") {
      const sessionId = managerSessionId(ctx);
      const state = await store.read();
      for (const worker of state.workers) {
        if (worker.managerSessionId === sessionId && worker.owned && isLiveState(worker.state)) {
          try {
            await stopWorker(worker, { reason: "manager-session-shutdown" });
          } catch {
            // Failure is persisted on the worker record and reconciled next startup.
          }
        }
      }
    }
    currentCtx = undefined;
  });
}

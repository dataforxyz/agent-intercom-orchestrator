import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { applyCodexPermissionArgs, applyPiPermissionArgs } from "./permissions.ts";
export { normalizeModelForHarness } from "./routing.ts";
import type { Effort, Harness, LaunchProfile, ManagerOwnerBinding, ManagerOwnerKind, OrchestratorConfig, PermissionProfile, UnitStatus, WorkerRecord, WorkerState } from "./types.ts";

export const EFFORT_LEVELS: Effort[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export const HARNESS_EFFORTS: Record<Harness, Effort[]> = {
  pi: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh"],
  claude: ["low", "medium", "high", "xhigh", "max"],
  opencode: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
};

export function newRunId(): string {
  return randomUUID().replaceAll("-", "").slice(0, 12);
}

export function leaseExpiry(config: OrchestratorConfig, now = Date.now()): number {
  return now + config.leaseMinutes * 60_000;
}

export function workerIdleDeadline(config: OrchestratorConfig, lastWorkerActivityAt: number): number {
  return lastWorkerActivityAt + config.idleTimeoutMinutes * 60_000;
}

export function boundedLeaseExpiry(config: OrchestratorConfig, lastWorkerActivityAt: number, now = Date.now()): number {
  return Math.min(leaseExpiry(config, now), workerIdleDeadline(config, lastWorkerActivityAt));
}

export function initializeWorkerLifecycle(worker: WorkerRecord, config: OrchestratorConfig, now = Date.now()): boolean {
  if (!worker.owned || !isLiveState(worker.state)) return false;
  let changed = false;
  if (!Number.isFinite(worker.lastWorkerActivityAt)) {
    // Existing records receive a complete idle window when lifecycle enforcement
    // first sees them instead of being expired immediately during migration.
    worker.lastWorkerActivityAt = now;
    changed = true;
  }
  const idleDeadlineAt = workerIdleDeadline(config, worker.lastWorkerActivityAt!);
  if (worker.idleDeadlineAt !== idleDeadlineAt) {
    worker.idleDeadlineAt = idleDeadlineAt;
    changed = true;
  }
  const checkpointDeadlineAt = idleDeadlineAt + config.cleanupGraceMinutes * 60_000;
  if (worker.checkpointDeadlineAt !== checkpointDeadlineAt) {
    worker.checkpointDeadlineAt = checkpointDeadlineAt;
    changed = true;
  }
  const leaseDeadline = boundedLeaseExpiry(config, worker.lastWorkerActivityAt!, now);
  if (worker.leaseExpiresAt > idleDeadlineAt || worker.leaseExpiresAt < now) {
    worker.leaseExpiresAt = leaseDeadline;
    changed = true;
  }
  if (changed) worker.updatedAt = now;
  return changed;
}

export function rebindManagerOwner(worker: WorkerRecord, context: ManagerOwnerKind, sessionId: string): ManagerOwnerBinding {
  const previous = worker.managerOwner;
  const sameBinding = previous?.context === context && previous.principalId === sessionId && previous.sessionId === sessionId;
  return {
    context,
    principalId: sessionId,
    sessionId,
    bindingEpoch: previous ? previous.bindingEpoch + (sameBinding ? 0 : 1) : 0,
  } as ManagerOwnerBinding;
}

export function recordWorkerActivity(worker: WorkerRecord, config: OrchestratorConfig, now = Date.now()): void {
  worker.lastWorkerActivityAt = now;
  worker.idleDeadlineAt = workerIdleDeadline(config, now);
  worker.checkpointDeadlineAt = worker.idleDeadlineAt + config.cleanupGraceMinutes * 60_000;
  worker.leaseExpiresAt = boundedLeaseExpiry(config, now, now);
  worker.checkpointRequestedAt = undefined;
  worker.checkpointLastAttemptAt = undefined;
  worker.checkpointAttemptCount = undefined;
  worker.updatedAt = now;
}

export function checkpointWarningAt(worker: WorkerRecord, config: OrchestratorConfig): number | undefined {
  if (!worker.idleDeadlineAt) return undefined;
  return worker.idleDeadlineAt - config.checkpointWarningMinutes * 60_000;
}

export function cleanupSnapshotStillEligible(worker: WorkerRecord, expectedCheckpointDeadlineAt: number, now = Date.now()): boolean {
  return worker.owned
    && isLiveState(worker.state)
    && worker.stateReason !== "stop_in_progress"
    && worker.checkpointDeadlineAt === expectedCheckpointDeadlineAt
    && worker.checkpointDeadlineAt <= now;
}

export function validateWorkerId(value: string): string {
  const id = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{1,79}$/.test(id)) {
    throw new Error("Worker id must be 2-80 characters using letters, numbers, dot, underscore, or dash.");
  }
  return id;
}

export function validateEffort(harness: Harness, effort: Effort | undefined): Effort | undefined {
  if (!effort) return undefined;
  if (!HARNESS_EFFORTS[harness].includes(effort)) {
    throw new Error(`${harness} does not support effort '${effort}'. Choose: ${HARNESS_EFFORTS[harness].join(", ")}`);
  }
  return effort;
}

export function standingInstructions(
  role: string,
  task: string,
  managerTarget: string,
  instructions?: string,
  communicationInstructions = "Wait for work through Agent Intercom. Use intercom_send for progress, blockers, status, and completion evidence; use intercom_ask only when your next step genuinely depends on the manager's answer.",
): string {
  return [
    `You are the independent ${role} coworker managed by Agent Intercom. You are a peer, not a child subagent.`,
    `Your manager's Intercom target is ${managerTarget}. Use intercom_team whenever you need the current manager or your managed coworkers.`,
    instructions,
    `Standing assignment: ${task}`,
    communicationInstructions,
    "Before promising browser-based validation, screenshots, or saved artifacts, verify that this worker actually has a browser or browser tool, a usable browser executable, and write access to the intended artifact directory. If any requirement is unavailable, report the exact gap immediately and ask the manager to capture locally or re-route the work; never present code inspection as visual evidence.",
    "Keep downstream tools inside this worker process tree. Do not create detached systemd services, background containers, or remote jobs unless the manager explicitly asks; report every external resource ID so the manager can own its cleanup.",
  ].filter(Boolean).join("\n\n");
}

export function buildWorkerArgs(input: {
  harness: Harness;
  profile: LaunchProfile;
  profileName?: string;
  workerId: string;
  cwd: string;
  role: string;
  task: string;
  model?: string;
  effort?: Effort;
  instructions?: string;
  managerTarget: string;
  permissionProfile?: PermissionProfile;
}): string[] {
  const { harness, profile, profileName, workerId, cwd, role, task, model, effort, instructions, managerTarget, permissionProfile } = input;
  let args = [...(profile.args ?? [])];
  const communicationInstructions = harness === "claude" && profileName === "claude-minimal"
    ? "Wait for work through Agent Intercom. Minimal Claude mode does not expose MCP tools such as intercom_send; put progress, blockers, status, and completion evidence in the final response to each wake so the bridge can relay it to the manager. Do not claim that you called an unavailable Intercom tool."
    : undefined;
  const mandate = standingInstructions(role, task, managerTarget, instructions, communicationInstructions);

  if (harness === "pi") {
    if (permissionProfile) args = applyPiPermissionArgs(args, permissionProfile);
    args.push("--name", workerId, "--session-id", workerId);
    if (model) args.push("--model", model);
    if (effort) args.push("--thinking", effort);
    args.push("--append-system-prompt", mandate);
  } else if (harness === "codex") {
    if (permissionProfile) args = applyCodexPermissionArgs(args, permissionProfile);
    if (model) args.push("-c", `model=\"${model}\"`);
    if (effort) args.push("-c", `model_reasoning_effort=\"${effort}\"`);
    args.push("--name", workerId, "--id", workerId, "--cwd", cwd, "--instructions", mandate);
  } else if (harness === "claude") {
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    args.push("--name", workerId, "--id", workerId, "--cwd", cwd, "--instructions", mandate);
  } else {
    if (model) args.push("--model", model);
    if (effort && effort !== "off") args.push("--variant", effort);
    args.push(mandate);
  }
  return args;
}

export function buildWorkerEnvironment(
  harness: Harness,
  workerId: string,
  role: string,
  model?: string,
  ownership?: { runId: string; unit: string; managerSessionId: string; fresh?: boolean },
): Record<string, string> {
  const ownedEnvironment = {
    AGENT_INTERCOM_ROLE: role,
    AGENT_INTERCOM_WORKER_ID: workerId,
    AGENT_INTERCOM_OWNED: "1",
    ...(ownership ? {
      AGENT_INTERCOM_RUN_ID: ownership.runId,
      AGENT_INTERCOM_SYSTEMD_UNIT: ownership.unit,
      AGENT_INTERCOM_MANAGER_SESSION_ID: ownership.managerSessionId,
      AGENT_INTERCOM_MANAGER_TARGET: ownership.managerSessionId,
      ...(ownership.fresh ? { AGENT_INTERCOM_FRESH: "1" } : {}),
    } : {}),
  };
  if (harness === "opencode") {
    return {
      ...ownedEnvironment,
      OPENCODE_INTERCOM_NAME: workerId,
      OPENCODE_INTERCOM_SESSION_ID: workerId,
    };
  }
  if (harness === "pi") {
    return {
      ...ownedEnvironment,
      AGENT_INTERCOM_ORCHESTRATOR_DISABLED: "1",
    };
  }
  if (harness === "codex") {
    return {
      ...ownedEnvironment,
      ...(model ? { CODEX_INTERCOM_MODEL: model } : {}),
    };
  }
  return ownedEnvironment;
}

export function isTerminalState(state: WorkerState): boolean {
  return state === "failed" || state === "lost" || state === "stopped" || state === "completed";
}

export function isLiveState(state: WorkerState): boolean {
  return state !== "migration_pending" && !isTerminalState(state);
}

export function unitRequiresStopFence(worker: WorkerRecord, status: UnitStatus): boolean {
  if (status.verified === false) return false;
  const stopIntent = Boolean(worker.stopRequestedAt || worker.stateReason === "stop_in_progress" || isTerminalState(worker.state));
  if (!stopIntent) return false;
  return Boolean(status.job
    || status.activeState === "active"
    || status.activeState === "activating"
    || status.activeState === "deactivating"
    || status.mainPid);
}

export function stateFromUnit(status: UnitStatus, previous: WorkerState): WorkerState {
  // An unverifiable snapshot or a queued systemd job must never become a
  // terminal conclusion. Preserve terminal intent, otherwise keep waiting.
  if (status.verified === false) return previous;
  if (status.job) return isTerminalState(previous) ? previous : "provisioning";
  if (!status.exists) return isTerminalState(previous) ? previous : "lost";
  if (status.activeState === "active" && status.subState === "exited") return "stopped";
  if (status.activeState === "active") {
    if (["ready", "working", "waiting", "paused", "stalled", "blocked", "unreachable"].includes(previous)) return previous;
    return "registering";
  }
  if (status.activeState === "activating" || status.activeState === "reloading") return "provisioning";
  if (status.activeState === "failed" || (status.result && status.result !== "success")) return "failed";
  if (status.activeState === "deactivating") return previous;
  if (status.activeState === "inactive") {
    if (previous === "stopped") return "stopped";
    // ExecMainStatus defaults to zero even when ExecStart never ran. Require
    // activation/start evidence before interpreting zero as a clean stop.
    const started = Boolean(status.execMainStartTimestampMonotonic || status.activeEnterTimestampMonotonic || status.mainPid);
    return started && status.execMainStatus === 0 ? "stopped" : "failed";
  }
  return previous;
}

export function createSystemdRecord(input: {
  id: string;
  runId: string;
  harness: Harness;
  role: string;
  task: string;
  cwd: string;
  profile: string;
  permissionProfile?: string;
  model?: string;
  effort?: Effort;
  instructions?: string;
  unit: string;
  managerSessionId: string;
  config: OrchestratorConfig;
  now?: number;
}): WorkerRecord {
  const now = input.now ?? Date.now();
  return {
    id: input.id,
    runId: input.runId,
    harness: input.harness,
    backend: "systemd",
    role: input.role,
    task: input.task,
    cwd: resolve(input.cwd),
    profile: input.profile,
    ...(input.permissionProfile ? { permissionProfile: input.permissionProfile } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(input.instructions ? { instructions: input.instructions } : {}),
    state: "provisioning",
    owned: true,
    managerSessionId: input.managerSessionId,
    intercomTarget: input.id,
    unit: input.unit,
    createdAt: now,
    updatedAt: now,
    leaseExpiresAt: boundedLeaseExpiry(input.config, now, now),
    lastWorkerActivityAt: now,
    idleDeadlineAt: workerIdleDeadline(input.config, now),
    checkpointDeadlineAt: workerIdleDeadline(input.config, now) + input.config.cleanupGraceMinutes * 60_000,
  };
}

export function terminalWorkerTimestamp(worker: WorkerRecord): number {
  return worker.stoppedAt ?? worker.updatedAt ?? worker.createdAt;
}

export function isRecentTerminalWorker(worker: WorkerRecord, config: OrchestratorConfig, now = Date.now()): boolean {
  return isTerminalState(worker.state)
    && terminalWorkerTimestamp(worker) > now - config.recentStoppedWorkerHours * 60 * 60_000;
}

export function stoppedWorkerRetentionReason(worker: WorkerRecord, config: OrchestratorConfig, now = Date.now()): string | undefined {
  if (!worker.owned || !isTerminalState(worker.state)) return undefined;
  const retentionDays = worker.dirtyAtStop
    ? config.dirtyStoppedWorkerRetentionDays
    : config.stoppedWorkerRetentionDays;
  const retainedUntil = terminalWorkerTimestamp(worker) + retentionDays * 24 * 60 * 60_000;
  if (retainedUntil > now) return undefined;
  return `${worker.dirtyAtStop ? "dirty " : ""}${worker.state} worker retention expired ${Math.ceil((now - retainedUntil) / 1000)}s ago`;
}

export function cleanupReason(worker: WorkerRecord, now = Date.now()): string | undefined {
  if (!worker.owned || !isLiveState(worker.state) || worker.stateReason === "stop_in_progress") return undefined;
  if (worker.checkpointDeadlineAt !== undefined && worker.checkpointDeadlineAt <= now) {
    return `idle checkpoint grace expired ${Math.ceil((now - worker.checkpointDeadlineAt) / 1000)}s ago`;
  }
  return undefined;
}

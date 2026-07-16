import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { Effort, Harness, LaunchProfile, OrchestratorConfig, UnitStatus, WorkerRecord, WorkerState } from "./types.ts";

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

export function validateWorkerId(value: string): string {
  const id = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{1,79}$/.test(id)) {
    throw new Error("Worker id must be 2-80 characters using letters, numbers, dot, underscore, or dash.");
  }
  return id;
}

export function normalizeModelForHarness(harness: Harness, model: string | undefined): string | undefined {
  const normalized = model?.trim();
  if (!normalized) return undefined;
  if (harness === "codex" && normalized.startsWith("codex/")) return normalized.slice("codex/".length);
  if (harness === "claude" && normalized.startsWith("claude/")) return normalized.slice("claude/".length);
  return normalized;
}

export function validateEffort(harness: Harness, effort: Effort | undefined): Effort | undefined {
  if (!effort) return undefined;
  if (!HARNESS_EFFORTS[harness].includes(effort)) {
    throw new Error(`${harness} does not support effort '${effort}'. Choose: ${HARNESS_EFFORTS[harness].join(", ")}`);
  }
  return effort;
}

export function standingInstructions(role: string, task: string, managerTarget: string, instructions?: string): string {
  return [
    `You are the independent ${role} coworker managed by Agent Intercom. You are a peer, not a child subagent.`,
    `Your manager's Intercom target is ${managerTarget}. Use intercom_team whenever you need the current manager or your managed coworkers.`,
    instructions,
    `Standing assignment: ${task}`,
    "Wait for work through Agent Intercom, report blockers early, and include evidence with completion claims.",
    "Keep downstream tools inside this worker process tree. Do not create detached systemd services, background containers, or remote jobs unless the manager explicitly asks; report every external resource ID so the manager can own its cleanup.",
  ].filter(Boolean).join("\n\n");
}

export function buildWorkerArgs(input: {
  harness: Harness;
  profile: LaunchProfile;
  workerId: string;
  cwd: string;
  role: string;
  task: string;
  model?: string;
  effort?: Effort;
  instructions?: string;
  managerTarget: string;
}): string[] {
  const { harness, profile, workerId, cwd, role, task, model, effort, instructions, managerTarget } = input;
  const args = [...(profile.args ?? [])];
  const mandate = standingInstructions(role, task, managerTarget, instructions);

  if (harness === "pi") {
    args.push("--name", workerId, "--session-id", workerId);
    if (model) args.push("--model", model);
    if (effort) args.push("--thinking", effort);
    args.push("--append-system-prompt", mandate);
  } else if (harness === "codex") {
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
  ownership?: { runId: string; unit: string; managerSessionId: string },
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

export function stateFromUnit(status: UnitStatus, previous: WorkerState): WorkerState {
  if (!status.exists) {
    if (previous === "stopped" || previous === "completed") return previous;
    return "lost";
  }
  if (status.activeState === "active" && status.subState === "exited") return "completed";
  if (status.activeState === "active") return "running";
  if (status.activeState === "activating" || status.activeState === "reloading") return "provisioning";
  if (status.activeState === "failed" || (status.result && status.result !== "success")) return "failed";
  if (status.activeState === "deactivating") return "stopping";
  if (status.activeState === "inactive") {
    return status.execMainStatus === 0 ? "completed" : previous === "stopped" ? "stopped" : "failed";
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
    leaseExpiresAt: leaseExpiry(input.config, now),
  };
}

export function isLiveState(state: WorkerState): boolean {
  return state === "provisioning" || state === "running" || state === "idle" || state === "needs_attention" || state === "stopping";
}

export function cleanupReason(worker: WorkerRecord, now = Date.now()): string | undefined {
  if (!worker.owned || !isLiveState(worker.state)) return undefined;
  if (worker.leaseExpiresAt <= now) return `lease expired ${Math.ceil((now - worker.leaseExpiresAt) / 1000)}s ago`;
  return undefined;
}

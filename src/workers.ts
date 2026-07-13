import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { Harness, LaunchProfile, OrchestratorConfig, UnitStatus, WorkerRecord, WorkerState } from "./types.ts";

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

export function buildWorkerArgs(
  harness: Exclude<Harness, "pi">,
  profile: LaunchProfile,
  workerId: string,
  cwd: string,
  role: string,
  task?: string,
): string[] {
  const args = [...(profile.args ?? [])];
  if (harness === "codex" || harness === "claude") {
    args.push(
      "--name",
      workerId,
      "--id",
      workerId,
      "--cwd",
      cwd,
      "--instructions",
      `You are the ${role} worker managed by Agent Intercom. Wait for assignments through Intercom. Report blockers early and include evidence with completion claims.`,
    );
  } else if (harness === "opencode") {
    if (!task) throw new Error("OpenCode run workers require an initial task");
    args.push(
      `You are the ${role} worker '${workerId}' managed by Agent Intercom. Complete this assignment, report blockers early, and include evidence with completion claims.\n\n${task}`,
    );
  }
  return args;
}

export function buildWorkerEnvironment(
  harness: Exclude<Harness, "pi">,
  workerId: string,
  role: string,
): Record<string, string> {
  if (harness === "opencode") {
    return {
      OPENCODE_INTERCOM_NAME: workerId,
      OPENCODE_INTERCOM_SESSION_ID: workerId,
      AGENT_INTERCOM_ROLE: role,
    };
  }
  return { AGENT_INTERCOM_ROLE: role };
}

export function stateFromUnit(status: UnitStatus, previous: WorkerState): WorkerState {
  if (!status.exists) {
    if (previous === "stopped" || previous === "completed") return previous;
    if (status.result && status.result !== "success") return "failed";
    if (status.execMainStatus === 0 && status.result === "success") return "completed";
    return "lost";
  }
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
  harness: Exclude<Harness, "pi">;
  role: string;
  task: string;
  cwd: string;
  profile: string;
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

import type { UnitStatus, WorkerRecord, WorkerStateFileV3 } from "./types.ts";

export type WorkerRegistryRecoveryAssessment =
  | { status: "healthy" }
  | { status: "unavailable"; reason: string }
  | { status: "recoverable"; state: WorkerStateFileV3; units: string[] }
  | { status: "degraded"; units: string[]; reason: string };

function live(status: UnitStatus): boolean {
  return status.verified !== false && status.exists && !status.job
    && status.activeState === "active" && status.subState !== "exited"
    && status.mainPid !== undefined;
}

function exactIdentity(worker: WorkerRecord, unit: string, status: UnitStatus): boolean {
  const identity = status.workerIdentity;
  return worker.owned === true
    && worker.managerOwner !== undefined
    && worker.unit === unit
    && identity?.owned === true
    && identity.workerId === worker.id
    && identity.workerIncarnationId === (worker.workerIncarnationId ?? worker.runId)
    && identity.unit === unit
    && identity.managerSessionId === worker.managerOwner.sessionId
    && identity.managerContext === worker.managerOwner.context;
}

/**
 * Compare an empty canonical registry with an authoritative systemd inventory
 * and a separately validated predecessor snapshot. No recovery is proposed
 * unless every live managed unit has one exact owned incarnation match.
 */
export function assessWorkerRegistryRecovery(input: {
  current: WorkerStateFileV3;
  recovery?: WorkerStateFileV3;
  inventory: { verified: boolean; units: string[]; reason?: string };
  statuses: ReadonlyMap<string, UnitStatus>;
}): WorkerRegistryRecoveryAssessment {
  if (input.current.workers.length !== 0) return { status: "healthy" };
  if (!input.inventory.verified) return { status: "unavailable", reason: input.inventory.reason ?? "worker unit inventory unavailable" };
  const liveUnits = input.inventory.units.filter((unit) => {
    const status = input.statuses.get(unit);
    return status ? live(status) : false;
  });
  if (liveUnits.length === 0) return { status: "healthy" };
  if (!input.recovery) return { status: "degraded", units: liveUnits, reason: "live managed units exist but no validated recovery snapshot is available" };

  const matched = new Set<string>();
  for (const unit of liveUnits) {
    const status = input.statuses.get(unit)!;
    const candidates = input.recovery.workers.filter((worker) => exactIdentity(worker, unit, status));
    if (candidates.length !== 1) {
      return { status: "degraded", units: liveUnits, reason: `live unit ${unit} does not have exactly one owned recovery identity match` };
    }
    matched.add(candidates[0].id);
  }
  const unmatchedLiveRecords = input.recovery.workers.filter((worker) => worker.unit && live(input.statuses.get(worker.unit) ?? { verified: false, exists: false }) && !matched.has(worker.id));
  if (unmatchedLiveRecords.length) {
    return { status: "degraded", units: liveUnits, reason: "recovery snapshot contains a conflicting live worker identity" };
  }
  return { status: "recoverable", state: structuredClone(input.recovery), units: liveUnits };
}

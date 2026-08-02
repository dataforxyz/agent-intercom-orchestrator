import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { acquireKernelFileLock } from "./file-lock.ts";
import type { BossCommandRequest } from "./boss-command.ts";
import type { WorkerRecord, WorkerState } from "./types.ts";

export const TRUSTED_LOCAL_BOSS_STORE_VERSION = "orc.boss-trusted-local.v1" as const;
export const TRUSTED_LOCAL_BOSS_WARNING = "TRUSTED LOCAL MODE — same-user agents and local files are trusted; evidence is advisory, not tamper-proof.";

export type TrustedLocalBossRunState = "active" | "paused" | "cancelled" | "failed" | "approved" | "rejected";
export type TrustedLocalBossAssignmentState = "requested" | "assigned" | "failed" | "cancelled";
export type TrustedLocalBossAssignmentRole = "manager" | "worker" | "scout" | "adversary";
export type TrustedLocalBossDeliveryKind = "launch-mandate" | "pause-notice" | "resume-notice" | "proof-review";

const MAX_GOAL_LENGTH = 10_000;
const MAX_PROOF_PACKETS = 64;

const TRUSTED_LOCAL_WORKER_STATES = new Set<WorkerState>([
  "provisioning", "running", "idle", "needs_attention", "completed", "failed", "stopping", "stopped", "lost",
  "registering", "ready", "working", "waiting", "paused", "stalled", "blocked", "unreachable", "migration_pending",
]);
const TERMINAL_RUN_STATES = new Set<TrustedLocalBossRunState>(["cancelled", "failed", "approved", "rejected"]);

export interface TrustedLocalBossAssignment {
  assignmentId: string;
  role: TrustedLocalBossAssignmentRole;
  task: string;
  revision: number;
  state: TrustedLocalBossAssignmentState;
  workerId: string | null;
  workerIncarnationId: string | null;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
}

export interface TrustedLocalBossDelivery {
  deliveryId: string;
  assignmentId: string;
  assignmentRevision: number;
  kind: TrustedLocalBossDeliveryKind;
  state: "delivered" | "failed";
  targetWorkerId: string;
  attemptedAt: string;
  completedAt: string;
  proofPacketId?: string;
  error?: string;
}

export interface TrustedLocalBossAssignmentResult {
  resultId: string;
  deliveryId: string;
  assignmentId: string;
  assignmentRevision: number;
  outcome: "accepted" | "failed";
  observedAt: string;
  detail: string;
}

export interface TrustedLocalBossLifecycleObservation {
  observationId: string;
  assignmentId: string;
  workerId: string;
  workerIncarnationId: string;
  workerState: WorkerState;
  observedAt: string;
  detail?: string;
}

export interface TrustedLocalBossProofPacket {
  proofPacketId: string;
  revision: number;
  bossRunId: string;
  runState: TrustedLocalBossRunState;
  managerAssignmentId: string;
  reviewerAssignmentId: string;
  lifecycleCount: number;
  generatedAt: string;
  snapshotSha256: string;
}

export interface TrustedLocalBossReviewDecision {
  decisionId: string;
  proofPacketId: string;
  proofRevision: number;
  reviewerAssignmentId: string;
  reviewerWorkerId: string;
  outcome: "approved" | "rejected";
  note: string;
  decidedBySessionId: string;
  decidedAt: string;
}

export interface TrustedLocalBossCancellation {
  actionId: string;
  state: "pending" | "succeeded" | "failed";
  requestedAt: string;
  completedAt?: string;
  error?: string;
}

export interface TrustedLocalBossRun {
  version: typeof TRUSTED_LOCAL_BOSS_STORE_VERSION;
  bossRunId: string;
  goal: string;
  state: TrustedLocalBossRunState;
  managerSessionId: string;
  assignments: TrustedLocalBossAssignment[];
  deliveries: TrustedLocalBossDelivery[];
  assignmentResults: TrustedLocalBossAssignmentResult[];
  lifecycle: TrustedLocalBossLifecycleObservation[];
  proofPackets: TrustedLocalBossProofPacket[];
  decisions: TrustedLocalBossReviewDecision[];
  cancellation: TrustedLocalBossCancellation | null;
  createdAt: string;
  updatedAt: string;
}

interface TrustedLocalBossState {
  version: typeof TRUSTED_LOCAL_BOSS_STORE_VERSION;
  revision: number;
  currentRunId: string | null;
  runs: TrustedLocalBossRun[];
}

export interface TrustedLocalBossResult {
  title: string;
  message: string;
  run?: TrustedLocalBossRun;
}

export interface TrustedLocalBossOrphanedWorker {
  worker: WorkerRecord;
  bossRunId: string;
  managerSessionId: string;
  assignmentRole: TrustedLocalBossAssignmentRole | null;
}

function initialState(): TrustedLocalBossState {
  return { version: TRUSTED_LOCAL_BOSS_STORE_VERSION, revision: 0, currentRunId: null, runs: [] };
}

function canonicalTimestamp(now: () => Date): string {
  const value = now().toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) throw new Error("Trusted-local Boss clock returned an invalid timestamp");
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index]);
}

function parseTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`Trusted-local Boss state contains invalid ${field}`);
  }
  return value;
}

function parseAssignment(value: unknown): TrustedLocalBossAssignment {
  if (!isPlainRecord(value)) throw new Error("Trusted-local Boss state contains an invalid assignment record");
  const required = ["assignmentId", "createdAt", "revision", "role", "state", "task", "updatedAt", "workerId", "workerIncarnationId"];
  const expected = "lastError" in value ? [...required, "lastError"] : required;
  if (!exactKeys(value, expected)) throw new Error("Trusted-local Boss state contains an invalid assignment record");
  const { assignmentId, createdAt, lastError, revision, role, state, task, updatedAt, workerId, workerIncarnationId } = value;
  if (typeof assignmentId !== "string" || !/^assignment-[0-9a-f-]{36}$/.test(assignmentId)
    || (role !== "manager" && role !== "worker" && role !== "scout" && role !== "adversary")
    || !Number.isSafeInteger(revision) || (revision as number) < 1
    || typeof task !== "string" || task.length < 1 || task.length > 20_000
    || (state !== "requested" && state !== "assigned" && state !== "failed" && state !== "cancelled")
    || (workerId !== null && (typeof workerId !== "string" || workerId.length < 1 || workerId.length > 128))
    || (workerIncarnationId !== null && (typeof workerIncarnationId !== "string" || workerIncarnationId.length < 1 || workerIncarnationId.length > 128))
    || (lastError !== undefined && (typeof lastError !== "string" || lastError.length < 1 || lastError.length > 4_096))) {
    throw new Error("Trusted-local Boss state contains invalid assignment fields");
  }
  if (state === "assigned" && (!workerId || !workerIncarnationId)) throw new Error("Trusted-local Boss assigned worker lacks identity");
  if (state === "requested" && (workerId !== null || workerIncarnationId !== null || lastError !== undefined)) throw new Error("Trusted-local Boss requested assignment contains premature outcome fields");
  return { assignmentId, role, task, revision: revision as number, state, workerId, workerIncarnationId, createdAt: parseTimestamp(createdAt, "assignment createdAt"), updatedAt: parseTimestamp(updatedAt, "assignment updatedAt"), ...(lastError !== undefined ? { lastError } : {}) };
}

function parseDelivery(value: unknown): TrustedLocalBossDelivery {
  if (!isPlainRecord(value)) throw new Error("Trusted-local Boss state contains an invalid delivery record");
  const required = ["assignmentId", "assignmentRevision", "attemptedAt", "completedAt", "deliveryId", "kind", "state", "targetWorkerId"];
  const expected = [...required, ...(value.proofPacketId !== undefined ? ["proofPacketId"] : []), ...(value.error !== undefined ? ["error"] : [])];
  if (!exactKeys(value, expected)) throw new Error("Trusted-local Boss state contains an invalid delivery record");
  const delivery = value as unknown as TrustedLocalBossDelivery;
  if (!/^delivery-[0-9a-f-]{36}$/.test(delivery.deliveryId) || !/^assignment-[0-9a-f-]{36}$/.test(delivery.assignmentId)
    || !Number.isSafeInteger(delivery.assignmentRevision) || delivery.assignmentRevision < 1
    || (delivery.kind !== "launch-mandate" && delivery.kind !== "pause-notice" && delivery.kind !== "resume-notice" && delivery.kind !== "proof-review")
    || (delivery.state !== "delivered" && delivery.state !== "failed") || typeof delivery.targetWorkerId !== "string" || delivery.targetWorkerId.length < 1 || delivery.targetWorkerId.length > 128
    || (delivery.kind === "proof-review" ? typeof delivery.proofPacketId !== "string" || !/^proof-[0-9a-f-]{36}$/.test(delivery.proofPacketId) : delivery.proofPacketId !== undefined)
    || (delivery.error !== undefined && (typeof delivery.error !== "string" || delivery.error.length < 1 || delivery.error.length > 4_096))
    || (delivery.state === "delivered" && delivery.error !== undefined) || (delivery.state === "failed" && delivery.error === undefined)) throw new Error("Trusted-local Boss state contains invalid delivery fields");
  return { ...delivery, attemptedAt: parseTimestamp(delivery.attemptedAt, "delivery attemptedAt"), completedAt: parseTimestamp(delivery.completedAt, "delivery completedAt") };
}

function parseAssignmentResult(value: unknown): TrustedLocalBossAssignmentResult {
  if (!isPlainRecord(value) || !exactKeys(value, ["assignmentId", "assignmentRevision", "deliveryId", "detail", "observedAt", "outcome", "resultId"])) throw new Error("Trusted-local Boss state contains an invalid assignment result");
  const result = value as unknown as TrustedLocalBossAssignmentResult;
  if (!/^result-[0-9a-f-]{36}$/.test(result.resultId) || !/^delivery-[0-9a-f-]{36}$/.test(result.deliveryId) || !/^assignment-[0-9a-f-]{36}$/.test(result.assignmentId)
    || !Number.isSafeInteger(result.assignmentRevision) || result.assignmentRevision < 1 || (result.outcome !== "accepted" && result.outcome !== "failed")
    || typeof result.detail !== "string" || result.detail.length < 1 || result.detail.length > 4_096) throw new Error("Trusted-local Boss state contains invalid assignment result fields");
  return { ...result, observedAt: parseTimestamp(result.observedAt, "assignment result observedAt") };
}

function parseLifecycleObservation(value: unknown): TrustedLocalBossLifecycleObservation {
  if (!isPlainRecord(value)) throw new Error("Trusted-local Boss state contains an invalid lifecycle observation");
  const required = ["assignmentId", "observationId", "observedAt", "workerId", "workerIncarnationId", "workerState"];
  const expected = "detail" in value ? [...required, "detail"] : required;
  if (!exactKeys(value, expected)) throw new Error("Trusted-local Boss state contains an invalid lifecycle observation");
  const { assignmentId, detail, observationId, observedAt, workerId, workerIncarnationId, workerState } = value;
  if (typeof observationId !== "string" || !/^observation-[0-9a-f-]{36}$/.test(observationId)
    || typeof assignmentId !== "string" || !/^assignment-[0-9a-f-]{36}$/.test(assignmentId)
    || typeof workerId !== "string" || workerId.length < 1 || workerId.length > 128
    || typeof workerIncarnationId !== "string" || workerIncarnationId.length < 1 || workerIncarnationId.length > 128
    || typeof workerState !== "string" || !TRUSTED_LOCAL_WORKER_STATES.has(workerState as WorkerState)
    || (detail !== undefined && (typeof detail !== "string" || detail.length < 1 || detail.length > 4_096))) throw new Error("Trusted-local Boss state contains invalid lifecycle observation fields");
  return { observationId, assignmentId, workerId, workerIncarnationId, workerState: workerState as WorkerState, observedAt: parseTimestamp(observedAt, "lifecycle observedAt"), ...(detail !== undefined ? { detail } : {}) };
}

function parseProofPacket(value: unknown): TrustedLocalBossProofPacket {
  if (!isPlainRecord(value) || !exactKeys(value, ["bossRunId", "generatedAt", "lifecycleCount", "managerAssignmentId", "proofPacketId", "reviewerAssignmentId", "revision", "runState", "snapshotSha256"])) throw new Error("Trusted-local Boss state contains an invalid proof packet");
  const packet = value as unknown as TrustedLocalBossProofPacket;
  if (!/^proof-[0-9a-f-]{36}$/.test(packet.proofPacketId) || !Number.isSafeInteger(packet.revision) || packet.revision < 1
    || !/^boss-[0-9a-f-]{36}$/.test(packet.bossRunId) || !/^assignment-[0-9a-f-]{36}$/.test(packet.managerAssignmentId)
    || !/^assignment-[0-9a-f-]{36}$/.test(packet.reviewerAssignmentId) || !Number.isSafeInteger(packet.lifecycleCount) || packet.lifecycleCount < 0 || packet.lifecycleCount > 256
    || !TERMINAL_RUN_STATES.has(packet.runState) && packet.runState !== "active" && packet.runState !== "paused"
    || !/^[0-9a-f]{64}$/.test(packet.snapshotSha256)) throw new Error("Trusted-local Boss state contains invalid proof packet fields");
  return { ...packet, generatedAt: parseTimestamp(packet.generatedAt, "proof generatedAt") };
}

function parseDecision(value: unknown): TrustedLocalBossReviewDecision {
  if (!isPlainRecord(value) || !exactKeys(value, ["decidedAt", "decidedBySessionId", "decisionId", "note", "outcome", "proofPacketId", "proofRevision", "reviewerAssignmentId", "reviewerWorkerId"])) throw new Error("Trusted-local Boss state contains an invalid review decision");
  const decision = value as unknown as TrustedLocalBossReviewDecision;
  if (!/^decision-[0-9a-f-]{36}$/.test(decision.decisionId) || !/^proof-[0-9a-f-]{36}$/.test(decision.proofPacketId)
    || !Number.isSafeInteger(decision.proofRevision) || decision.proofRevision < 1 || !/^assignment-[0-9a-f-]{36}$/.test(decision.reviewerAssignmentId)
    || typeof decision.reviewerWorkerId !== "string" || decision.reviewerWorkerId.length < 1 || decision.reviewerWorkerId.length > 128
    || (decision.outcome !== "approved" && decision.outcome !== "rejected") || typeof decision.note !== "string" || decision.note.length < 1 || decision.note.length > 4_096
    || typeof decision.decidedBySessionId !== "string" || decision.decidedBySessionId.length < 1 || decision.decidedBySessionId.length > 1_024) throw new Error("Trusted-local Boss state contains invalid review decision fields");
  return { ...decision, decidedAt: parseTimestamp(decision.decidedAt, "decision decidedAt") };
}

function parseCancellation(value: unknown): TrustedLocalBossCancellation | null {
  if (value === null) return null;
  if (!isPlainRecord(value)) throw new Error("Trusted-local Boss state contains invalid cancellation action");
  const required = ["actionId", "requestedAt", "state"];
  const expected = [...required, ...(value.completedAt !== undefined ? ["completedAt"] : []), ...(value.error !== undefined ? ["error"] : [])];
  if (!exactKeys(value, expected)) throw new Error("Trusted-local Boss state contains invalid cancellation action");
  const { actionId, completedAt, error, requestedAt, state } = value;
  if (typeof actionId !== "string" || !/^cancel-[0-9a-f-]{36}$/.test(actionId) || (state !== "pending" && state !== "succeeded" && state !== "failed")
    || (completedAt !== undefined && typeof completedAt !== "string") || (error !== undefined && (typeof error !== "string" || error.length < 1 || error.length > 4_096))
    || (state === "pending" && (completedAt !== undefined || error !== undefined)) || (state !== "pending" && completedAt === undefined)
    || (state === "succeeded" && error !== undefined) || (state === "failed" && error === undefined)) throw new Error("Trusted-local Boss state contains invalid cancellation fields");
  return { actionId, state, requestedAt: parseTimestamp(requestedAt, "cancellation requestedAt"), ...(completedAt !== undefined ? { completedAt: parseTimestamp(completedAt, "cancellation completedAt") } : {}), ...(error !== undefined ? { error } : {}) };
}

function parseRun(value: unknown): TrustedLocalBossRun {
  const keys = ["assignmentResults", "assignments", "bossRunId", "cancellation", "createdAt", "decisions", "deliveries", "goal", "lifecycle", "managerSessionId", "proofPackets", "state", "updatedAt", "version"];
  if (!isPlainRecord(value) || !exactKeys(value, keys)) throw new Error("Trusted-local Boss state contains an invalid run record");
  const { assignmentResults, assignments, bossRunId, cancellation, createdAt, decisions, deliveries, goal, lifecycle, managerSessionId, proofPackets, state, updatedAt, version } = value;
  if (version !== TRUSTED_LOCAL_BOSS_STORE_VERSION || typeof bossRunId !== "string" || !/^boss-[0-9a-f-]{36}$/.test(bossRunId)
    || typeof goal !== "string" || goal.length < 1 || goal.length > MAX_GOAL_LENGTH || typeof managerSessionId !== "string" || managerSessionId.length < 1 || managerSessionId.length > 1_024
    || (state !== "active" && state !== "paused" && !TERMINAL_RUN_STATES.has(state as TrustedLocalBossRunState))
    || !Array.isArray(assignments) || assignments.length < 3 || assignments.length > 4 || !Array.isArray(deliveries) || deliveries.length > 256 || !Array.isArray(assignmentResults) || assignmentResults.length > 256 || !Array.isArray(lifecycle) || lifecycle.length > 256
    || !Array.isArray(proofPackets) || proofPackets.length > MAX_PROOF_PACKETS || !Array.isArray(decisions) || decisions.length > 64) throw new Error("Trusted-local Boss state contains invalid run fields");
  const parsedAssignments = assignments.map(parseAssignment);
  if (parsedAssignments.filter((assignment) => assignment.role === "manager").length !== 1 || parsedAssignments.filter((assignment) => assignment.role === "worker").length !== 1 || parsedAssignments.filter((assignment) => assignment.role === "scout").length !== 1 || parsedAssignments.filter((assignment) => assignment.role === "adversary").length > 1) throw new Error("Trusted-local Boss state contains invalid staffing roles");
  const parsedDeliveries = deliveries.map(parseDelivery);
  const parsedResults = assignmentResults.map(parseAssignmentResult);
  const parsedLifecycle = lifecycle.map(parseLifecycleObservation);
  const parsedProofs = proofPackets.map(parseProofPacket);
  const parsedDecisions = decisions.map(parseDecision);
  const assignmentIds = new Set(parsedAssignments.map((assignment) => assignment.assignmentId));
  if (assignmentIds.size !== parsedAssignments.length || parsedLifecycle.some((entry) => !assignmentIds.has(entry.assignmentId))) throw new Error("Trusted-local Boss state contains invalid assignment correlation");
  const assignmentById = new Map(parsedAssignments.map((assignment) => [assignment.assignmentId, assignment]));
  const deliveryById = new Map(parsedDeliveries.map((delivery) => [delivery.deliveryId, delivery]));
  if (deliveryById.size !== parsedDeliveries.length || parsedDeliveries.some((delivery) => { const assignment = assignmentById.get(delivery.assignmentId); return !assignment || delivery.assignmentRevision > assignment.revision || delivery.targetWorkerId !== assignment.workerId; })) throw new Error("Trusted-local Boss state contains invalid delivery correlation");
  if (new Set(parsedResults.map((result) => result.resultId)).size !== parsedResults.length || parsedResults.some((result) => { const delivery = deliveryById.get(result.deliveryId); return !delivery || result.assignmentId !== delivery.assignmentId || result.assignmentRevision !== delivery.assignmentRevision || (delivery.state === "delivered") !== (result.outcome === "accepted"); })) throw new Error("Trusted-local Boss state contains invalid assignment result correlation");
  if (parsedProofs.some((packet, index) => packet.bossRunId !== bossRunId || packet.revision !== index + 1 || !assignmentIds.has(packet.managerAssignmentId) || !assignmentIds.has(packet.reviewerAssignmentId))) throw new Error("Trusted-local Boss state contains invalid proof correlation");
  const proofById = new Map(parsedProofs.map((packet) => [packet.proofPacketId, packet]));
  if (parsedProofs.some((proof) => { const matches = parsedDeliveries.filter((delivery) => delivery.kind === "proof-review" && delivery.proofPacketId === proof.proofPacketId); if (matches.length > 1) return true; if (matches.length === 0) return false; const delivery = matches[0]; const reviewer = assignmentById.get(proof.reviewerAssignmentId); const result = parsedResults.find((candidate) => candidate.deliveryId === delivery.deliveryId); return !reviewer || delivery.assignmentId !== reviewer.assignmentId || delivery.targetWorkerId !== reviewer.workerId || !result; })) throw new Error("Trusted-local Boss state contains invalid proof delivery correlation");
  if (parsedDecisions.some((decision) => { const proof = proofById.get(decision.proofPacketId); return !proof || proof.revision !== decision.proofRevision || proof.reviewerAssignmentId !== decision.reviewerAssignmentId; })) throw new Error("Trusted-local Boss state contains invalid decision correlation");
  return { version, bossRunId, goal, state: state as TrustedLocalBossRunState, managerSessionId, assignments: parsedAssignments, deliveries: parsedDeliveries, assignmentResults: parsedResults, lifecycle: parsedLifecycle, proofPackets: parsedProofs, decisions: parsedDecisions, cancellation: parseCancellation(cancellation), createdAt: parseTimestamp(createdAt, "run createdAt"), updatedAt: parseTimestamp(updatedAt, "run updatedAt") };
}

function parseState(value: unknown): TrustedLocalBossState {
  if (!isPlainRecord(value) || !exactKeys(value, ["currentRunId", "revision", "runs", "version"])) throw new Error("Trusted-local Boss state has an invalid top-level shape");
  if (value.version !== TRUSTED_LOCAL_BOSS_STORE_VERSION || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || !Array.isArray(value.runs)) throw new Error("Trusted-local Boss state has invalid metadata");
  const runs = value.runs.map(parseRun);
  const ids = new Set(runs.map((run) => run.bossRunId));
  if (ids.size !== runs.length) throw new Error("Trusted-local Boss state contains duplicate run ids");
  const currentRunId = value.currentRunId;
  if (currentRunId !== null && (typeof currentRunId !== "string" || !ids.has(currentRunId))) throw new Error("Trusted-local Boss current run is invalid");
  const current = currentRunId === null ? undefined : runs.find((run) => run.bossRunId === currentRunId);
  if (current && TERMINAL_RUN_STATES.has(current.state)) throw new Error("Trusted-local Boss current run is terminal");
  return { version: TRUSTED_LOCAL_BOSS_STORE_VERSION, revision: value.revision as number, currentRunId, runs };
}

function formatRun(run: TrustedLocalBossRun): string {
  const manager = run.assignments.find((assignment) => assignment.role === "manager")!;
  const reviewer = run.assignments.find((assignment) => assignment.role === "adversary");
  const latestProof = run.proofPackets.at(-1);
  const latestDecision = run.decisions.at(-1);
  const lifecycle = run.lifecycle.length ? run.lifecycle.slice(-8).map((entry) => `- ${entry.observedAt} ${entry.workerId} ${entry.workerState}${entry.detail ? ` — ${entry.detail}` : ""}`).join("\n") : "- no worker lifecycle observations recorded";
  const staffing = run.assignments.map((assignment) => `- ${assignment.role} revision ${assignment.revision}: ${assignment.state}; worker=${assignment.workerId ?? "not launched"}${assignment.lastError ? `; error=${assignment.lastError}` : ""}`).join("\n");
  const latestDelivery = run.deliveries.at(-1);
  return [TRUSTED_LOCAL_BOSS_WARNING, `run: ${run.bossRunId}`, `state: ${run.state}`, `goal: ${run.goal}`, `manager session: ${run.managerSessionId}`, "staffing:", staffing, `adversary assignment: ${reviewer ? `${reviewer.assignmentId} (${reviewer.state})` : "not requested"}`, `assignment delivery: ${latestDelivery ? `${latestDelivery.kind} ${latestDelivery.state} to ${latestDelivery.targetWorkerId} at revision ${latestDelivery.assignmentRevision}` : "none"}`, `assignment results: ${run.assignmentResults.length}`, `latest proof: ${latestProof ? `${latestProof.proofPacketId} revision ${latestProof.revision} sha256:${latestProof.snapshotSha256}` : "none"}`, `latest decision: ${latestDecision ? `${latestDecision.outcome} on proof revision ${latestDecision.proofRevision} — ${latestDecision.note}` : "none"}`, `cancellation: ${run.cancellation ? `${run.cancellation.state}${run.cancellation.error ? ` — ${run.cancellation.error}` : ""}` : "not requested"}`, `created: ${run.createdAt}`, `updated: ${run.updatedAt}`, "lifecycle:", lifecycle].join("\n");
}

function workerIncarnation(worker: WorkerRecord): string { return worker.workerIncarnationId ?? worker.runId; }
function assignmentForRole(run: TrustedLocalBossRun, role: TrustedLocalBossAssignmentRole): TrustedLocalBossAssignment { const assignment = run.assignments.find((candidate) => candidate.role === role); if (!assignment) throw new Error(`Trusted-local Boss ${role} assignment is unavailable`); return assignment; }
function assertOwningSession(run: TrustedLocalBossRun, managerSessionId: string): void { if (run.managerSessionId !== managerSessionId) throw new Error("Trusted-local Boss mutation requires the owning Manager session."); }
function isTerminalWorkerState(state: WorkerState): boolean { return state === "completed" || state === "failed" || state === "stopped" || state === "lost"; }
function expectedWorkerId(run: TrustedLocalBossRun, role: TrustedLocalBossAssignmentRole): string { return `boss-${role === "adversary" ? "adversary" : role}-${run.bossRunId.slice(-12)}`; }
function pruneOldestDeliveryPair(run: TrustedLocalBossRun): void { const removed = run.deliveries.shift(); if (!removed) return; const resultIndex = run.assignmentResults.findIndex((result) => result.deliveryId === removed.deliveryId); if (resultIndex >= 0) run.assignmentResults.splice(resultIndex, 1); }

function proofDigest(run: TrustedLocalBossRun, reviewer: TrustedLocalBossAssignment): string {
  const manager = assignmentForRole(run, "manager");
  const proofDeliveryIds = new Set(run.deliveries.filter((delivery) => delivery.kind === "proof-review").map((delivery) => delivery.deliveryId));
  const snapshot = { bossRunId: run.bossRunId, goal: run.goal, state: run.state, assignments: run.assignments.map((assignment) => ({ ...assignment })), deliveries: run.deliveries.filter((delivery) => delivery.kind !== "proof-review").map((delivery) => ({ ...delivery })), assignmentResults: run.assignmentResults.filter((result) => !proofDeliveryIds.has(result.deliveryId)).map((result) => ({ ...result })), manager: { assignmentId: manager.assignmentId, state: manager.state, workerId: manager.workerId, workerIncarnationId: manager.workerIncarnationId, updatedAt: manager.updatedAt }, reviewer: { assignmentId: reviewer.assignmentId, state: reviewer.state, workerId: reviewer.workerId, workerIncarnationId: reviewer.workerIncarnationId, updatedAt: reviewer.updatedAt }, lifecycle: run.lifecycle.map((entry) => ({ ...entry })) };
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

export class TrustedLocalBossStore {
  readonly path: string;
  private readonly now: () => Date;
  constructor(path: string, now: () => Date = () => new Date()) { this.path = path; this.now = now; }

  private async readState(): Promise<TrustedLocalBossState> { try { return parseState(JSON.parse(await readFile(this.path, "utf8"))); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return initialState(); throw error; } }
  private async writeState(state: TrustedLocalBossState): Promise<void> { await mkdir(dirname(this.path), { recursive: true, mode: 0o700 }); const temp = `${this.path}.tmp-${process.pid}-${randomUUID()}`; try { await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" }); await rename(temp, this.path); } finally { await rm(temp, { force: true }).catch(() => undefined); } }
  private async mutate<T>(operation: (state: TrustedLocalBossState, timestamp: string) => T | Promise<T>): Promise<T> { await mkdir(dirname(this.path), { recursive: true, mode: 0o700 }); const release = await acquireKernelFileLock(`${this.path}.lock`, 5_000); try { const state = await this.readState(); const before = JSON.stringify(state); const result = await operation(state, canonicalTimestamp(this.now)); parseState(structuredClone(state)); if (JSON.stringify(state) !== before) await this.writeState(state); return result; } finally { await release(); } }

  private async recordAssignmentStarted(bossRunId: string, role: TrustedLocalBossAssignmentRole, worker: WorkerRecord): Promise<TrustedLocalBossRun> {
    return this.mutate((state, timestamp) => { const run = state.runs.find((candidate) => candidate.bossRunId === bossRunId); if (!run) throw new Error(`Trusted-local Boss run not found: ${bossRunId}`); if (TERMINAL_RUN_STATES.has(run.state)) throw new Error(`Trusted-local Boss ${role} assignment cannot start after run ${run.state}`); const assignment = assignmentForRole(run, role); if (assignment.state !== "requested") throw new Error(`Trusted-local Boss ${role} assignment is already ${assignment.state}`); assignment.state = "assigned"; assignment.workerId = worker.id; assignment.workerIncarnationId = workerIncarnation(worker); assignment.updatedAt = timestamp; while (run.deliveries.length >= 256) pruneOldestDeliveryPair(run); const deliveryId = `delivery-${randomUUID()}`; run.deliveries.push({ deliveryId, assignmentId: assignment.assignmentId, assignmentRevision: assignment.revision, kind: "launch-mandate", state: "delivered", targetWorkerId: worker.id, attemptedAt: timestamp, completedAt: timestamp }); run.assignmentResults.push({ resultId: `result-${randomUUID()}`, deliveryId, assignmentId: assignment.assignmentId, assignmentRevision: assignment.revision, outcome: "accepted", observedAt: timestamp, detail: `${role} launch mandate accepted by ordinary agent_fleet readiness` }); run.updatedAt = timestamp; run.lifecycle.push({ observationId: `observation-${randomUUID()}`, assignmentId: assignment.assignmentId, workerId: worker.id, workerIncarnationId: workerIncarnation(worker), workerState: worker.state, observedAt: timestamp, detail: `${role} launch recorded from ordinary agent_fleet state` }); if (run.lifecycle.length > 256) run.lifecycle.splice(0, run.lifecycle.length - 256); state.revision += 1; return structuredClone(run); });
  }
  private async recordAssignmentFailed(bossRunId: string, role: TrustedLocalBossAssignmentRole, error: unknown): Promise<TrustedLocalBossRun> {
    return this.mutate((state, timestamp) => { const run = state.runs.find((candidate) => candidate.bossRunId === bossRunId); if (!run) throw new Error(`Trusted-local Boss run not found: ${bossRunId}`); const assignment = assignmentForRole(run, role); if (assignment.state === "cancelled" || assignment.state === "failed" || TERMINAL_RUN_STATES.has(run.state)) return structuredClone(run); const message = error instanceof Error ? error.message : String(error); assignment.state = "failed"; assignment.lastError = message.slice(0, 4_096) || `${role} launch failed`; assignment.updatedAt = timestamp; if (role === "manager") { run.state = "failed"; state.currentRunId = null; } run.updatedAt = timestamp; state.revision += 1; return structuredClone(run); });
  }
  async recordAssignmentStartedForRole(bossRunId: string, role: TrustedLocalBossAssignmentRole, worker: WorkerRecord): Promise<TrustedLocalBossRun> { return this.recordAssignmentStarted(bossRunId, role, worker); }
  async recordAssignmentFailedForRole(bossRunId: string, role: TrustedLocalBossAssignmentRole, error: unknown): Promise<TrustedLocalBossRun> { return this.recordAssignmentFailed(bossRunId, role, error); }
  async recordManagerStarted(bossRunId: string, worker: WorkerRecord): Promise<TrustedLocalBossRun> { return this.recordAssignmentStarted(bossRunId, "manager", worker); }
  async recordManagerFailed(bossRunId: string, error: unknown): Promise<TrustedLocalBossRun> { return this.recordAssignmentFailed(bossRunId, "manager", error); }
  async recordReviewerStarted(bossRunId: string, worker: WorkerRecord): Promise<TrustedLocalBossRun> { return this.recordAssignmentStarted(bossRunId, "adversary", worker); }
  async recordReviewerFailed(bossRunId: string, error: unknown): Promise<TrustedLocalBossRun> { return this.recordAssignmentFailed(bossRunId, "adversary", error); }

  async recordControlDelivery(bossRunId: string, role: TrustedLocalBossAssignmentRole, kind: "pause-notice" | "resume-notice", error?: unknown): Promise<TrustedLocalBossRun> {
    return this.mutate((state, timestamp) => { const run = state.runs.find((candidate) => candidate.bossRunId === bossRunId); if (!run) throw new Error(`Trusted-local Boss run not found: ${bossRunId}`); const assignment = assignmentForRole(run, role); if (assignment.state !== "assigned" || !assignment.workerId) throw new Error(`Trusted-local Boss ${role} assignment is not available for ${kind}`); assignment.revision += 1; assignment.updatedAt = timestamp; const deliveryId = `delivery-${randomUUID()}`; const failed = error !== undefined; const detail = failed ? (error instanceof Error ? error.message : String(error)).slice(0, 4_096) || `${kind} delivery failed` : `${kind} accepted by the local Agent Intercom event relay`; run.deliveries.push({ deliveryId, assignmentId: assignment.assignmentId, assignmentRevision: assignment.revision, kind, state: failed ? "failed" : "delivered", targetWorkerId: assignment.workerId, attemptedAt: timestamp, completedAt: timestamp, ...(failed ? { error: detail } : {}) }); run.assignmentResults.push({ resultId: `result-${randomUUID()}`, deliveryId, assignmentId: assignment.assignmentId, assignmentRevision: assignment.revision, outcome: failed ? "failed" : "accepted", observedAt: timestamp, detail }); while (run.deliveries.length > 256) pruneOldestDeliveryPair(run); run.updatedAt = timestamp; state.revision += 1; return structuredClone(run); });
  }

  async recordProofDelivery(bossRunId: string, proofPacketId: string, error?: unknown): Promise<TrustedLocalBossRun> {
    return this.mutate((state, timestamp) => {
      const run = state.runs.find((candidate) => candidate.bossRunId === bossRunId); if (!run) throw new Error(`Trusted-local Boss run not found: ${bossRunId}`);
      const proof = run.proofPackets.find((candidate) => candidate.proofPacketId === proofPacketId); if (!proof) throw new Error("Trusted-local Boss proof packet is unavailable for delivery");
      const reviewer = assignmentForRole(run, "adversary"); if (reviewer.assignmentId !== proof.reviewerAssignmentId || reviewer.state !== "assigned" || !reviewer.workerId) throw new Error("Trusted-local Boss proof reviewer is unavailable");
      const existing = run.deliveries.find((delivery) => delivery.kind === "proof-review" && delivery.proofPacketId === proofPacketId);
      if (existing?.state === "delivered") throw new Error("Trusted-local Boss proof delivery is already recorded");
      if (existing) { const resultIndex = run.assignmentResults.findIndex((result) => result.deliveryId === existing.deliveryId); if (resultIndex >= 0) run.assignmentResults.splice(resultIndex, 1); run.deliveries.splice(run.deliveries.indexOf(existing), 1); }
      while (run.deliveries.length >= 256) pruneOldestDeliveryPair(run);
      const deliveryId = `delivery-${randomUUID()}`;
      const failed = error !== undefined;
      const detail = failed ? (error instanceof Error ? error.message : String(error)).slice(0, 4_096) || "Exact advisory proof delivery failed" : `Exact advisory proof ${proofPacketId} accepted by the local Agent Intercom review relay`;
      run.deliveries.push({ deliveryId, assignmentId: reviewer.assignmentId, assignmentRevision: reviewer.revision, kind: "proof-review", state: failed ? "failed" : "delivered", targetWorkerId: reviewer.workerId, attemptedAt: timestamp, completedAt: timestamp, proofPacketId, ...(failed ? { error: detail } : {}) });
      run.assignmentResults.push({ resultId: `result-${randomUUID()}`, deliveryId, assignmentId: reviewer.assignmentId, assignmentRevision: reviewer.revision, outcome: failed ? "failed" : "accepted", observedAt: timestamp, detail });
      run.updatedAt = timestamp; state.revision += 1; return structuredClone(run);
    });
  }

  async recordCancellationResult(bossRunId: string, error?: unknown): Promise<TrustedLocalBossRun> {
    return this.mutate((state, timestamp) => { const run = state.runs.find((candidate) => candidate.bossRunId === bossRunId); if (!run || !run.cancellation || run.cancellation.state !== "pending") throw new Error("Trusted-local Boss cancellation is not pending"); if (error === undefined) { run.cancellation.state = "succeeded"; run.cancellation.completedAt = timestamp; } else { run.cancellation.state = "failed"; run.cancellation.completedAt = timestamp; run.cancellation.error = (error instanceof Error ? error.message : String(error)).slice(0, 4_096) || "Boss staffing stop failed"; } if (error === undefined) { for (const assignment of run.assignments) { if (assignment.state === "assigned") { assignment.state = "cancelled"; assignment.updatedAt = timestamp; } } } run.updatedAt = timestamp; state.revision += 1; return structuredClone(run); });
  }

  async findOrphanedWorkers(workers: readonly WorkerRecord[]): Promise<TrustedLocalBossOrphanedWorker[]> {
    const state = await this.readState();
    const orphans: TrustedLocalBossOrphanedWorker[] = [];
    for (const worker of workers) {
      if (typeof worker.bossRunId !== "string") continue;
      const run = state.runs.find((candidate) => candidate.bossRunId === worker.bossRunId);
      if (!run) { orphans.push({ worker: structuredClone(worker), bossRunId: worker.bossRunId, managerSessionId: worker.managerSessionId, assignmentRole: null }); continue; }
      const represented = run.assignments.some((assignment) => assignment.state === "assigned" && assignment.workerId === worker.id && assignment.workerIncarnationId === workerIncarnation(worker));
      if (represented) continue;
      const assignedIdentityConflict = run.assignments.some((assignment) => assignment.state === "assigned" && assignment.workerId === worker.id && assignment.workerIncarnationId !== workerIncarnation(worker));
      if (assignedIdentityConflict) continue;
      const assignmentRole = run.assignments.find((assignment) => assignment.state === "requested" && expectedWorkerId(run, assignment.role) === worker.id)?.role ?? null;
      orphans.push({ worker: structuredClone(worker), bossRunId: run.bossRunId, managerSessionId: run.managerSessionId, assignmentRole });
    }
    return orphans;
  }

  async recordOrphanedWorkerContained(bossRunId: string, role: TrustedLocalBossAssignmentRole | null, detail: string): Promise<void> {
    await this.mutate((state, timestamp) => {
      const run = state.runs.find((candidate) => candidate.bossRunId === bossRunId); if (!run || !role) return;
      const assignment = assignmentForRole(run, role); if (assignment.state !== "requested") return;
      assignment.state = "failed"; assignment.lastError = detail.slice(0, 4_096) || "Uncorrelated Boss worker was contained"; assignment.updatedAt = timestamp;
      if (role === "manager" && !TERMINAL_RUN_STATES.has(run.state)) { run.state = "failed"; if (state.currentRunId === run.bossRunId) state.currentRunId = null; }
      run.updatedAt = timestamp; state.revision += 1;
    });
  }

  async synchronizeWorkers(workers: readonly WorkerRecord[]): Promise<boolean> {
    const snapshot = await this.readState();
    if (!snapshot.runs.some((run) => run.assignments.some((assignment) => assignment.state === "assigned") || run.cancellation?.state === "pending")) return false;
    return this.mutate((state, timestamp) => {
      let changed = false;
      for (const run of state.runs) {
        for (const assignment of run.assignments.filter((candidate) => candidate.state === "assigned" && candidate.workerId && candidate.workerIncarnationId)) {
          const worker = workers.find((candidate) => candidate.id === assignment.workerId && workerIncarnation(candidate) === assignment.workerIncarnationId && candidate.bossRunId === run.bossRunId);
          const workerState: WorkerState = worker?.state ?? "lost";
          const detail = worker ? worker.lastError ?? worker.stopReason ?? worker.stateReason : `${assignment.role} exact WorkerStore incarnation is missing`;
          const previous = [...run.lifecycle].reverse().find((entry) => entry.assignmentId === assignment.assignmentId);
          if (previous?.workerState !== workerState || previous.detail !== detail) {
            run.lifecycle.push({ observationId: `observation-${randomUUID()}`, assignmentId: assignment.assignmentId, workerId: assignment.workerId!, workerIncarnationId: assignment.workerIncarnationId!, workerState, observedAt: timestamp, ...(detail ? { detail: detail.slice(0, 4_096) } : {}) });
            if (run.lifecycle.length > 256) run.lifecycle.splice(0, run.lifecycle.length - 256);
            run.updatedAt = timestamp;
            changed = true;
          }
          if (!TERMINAL_RUN_STATES.has(run.state) && (workerState === "failed" || workerState === "lost" || workerState === "stopped")) {
            assignment.state = "failed";
            assignment.lastError = (detail ?? `${assignment.role} worker entered ${workerState}`).slice(0, 4_096);
            assignment.updatedAt = timestamp;
            run.state = "failed";
            if (state.currentRunId === run.bossRunId) state.currentRunId = null;
            changed = true;
          }
        }
        if (run.state === "cancelled" && run.cancellation?.state === "pending") {
          const bound = run.assignments.filter((assignment) => assignment.state === "assigned" && assignment.workerId && assignment.workerIncarnationId);
          const allSettled = bound.every((assignment) => {
            const worker = workers.find((candidate) => candidate.id === assignment.workerId && workerIncarnation(candidate) === assignment.workerIncarnationId && candidate.bossRunId === run.bossRunId);
            if (worker) return isTerminalWorkerState(worker.state);
            const conflicting = workers.some((candidate) => candidate.id === assignment.workerId && candidate.bossRunId === run.bossRunId && workerIncarnation(candidate) !== assignment.workerIncarnationId);
            return !conflicting;
          });
          if (allSettled) {
            run.cancellation.state = "succeeded";
            run.cancellation.completedAt = timestamp;
            for (const assignment of bound) { assignment.state = "cancelled"; assignment.updatedAt = timestamp; }
            run.updatedAt = timestamp;
            changed = true;
          }
        }
      }
      if (changed) state.revision += 1;
      return changed;
    });
  }

  async execute(request: BossCommandRequest, managerSessionId: string): Promise<TrustedLocalBossResult> {
    return this.mutate((state, timestamp) => {
      const requestedId = "bossRunId" in request ? request.bossRunId : undefined;
      const selected = requestedId ? state.runs.find((run) => run.bossRunId === requestedId) : state.currentRunId ? state.runs.find((run) => run.bossRunId === state.currentRunId) : undefined;
      if (request.action === "status") { if (!selected) return { title: "Boss trusted-local status", message: `${TRUSTED_LOCAL_BOSS_WARNING}\n\nNo Boss run is selected.` }; return { title: "Boss trusted-local status", message: formatRun(selected), run: structuredClone(selected) }; }
      if (request.action === "create") {
        if (request.goal.length > MAX_GOAL_LENGTH) throw new Error(`Trusted-local Boss goal exceeds ${MAX_GOAL_LENGTH} characters.`);
        const live = state.runs.find((run) => !TERMINAL_RUN_STATES.has(run.state)); if (live) throw new Error(`A trusted-local Boss run is already open: ${live.bossRunId}`);
        const assignment = (role: "manager" | "worker" | "scout", task: string): TrustedLocalBossAssignment => ({ assignmentId: `assignment-${randomUUID()}`, role, task, revision: 1, state: "requested", workerId: null, workerIncarnationId: null, createdAt: timestamp, updatedAt: timestamp });
        const assignments = [assignment("manager", `Manage the trusted-local Boss goal: ${request.goal}`), assignment("worker", `Implement the highest-priority bounded work for: ${request.goal}`), assignment("scout", `Scout risks, dependencies, and verification gaps for: ${request.goal}`)];
        const run: TrustedLocalBossRun = { version: TRUSTED_LOCAL_BOSS_STORE_VERSION, bossRunId: `boss-${randomUUID()}`, goal: request.goal, state: "active", managerSessionId, assignments, deliveries: [], assignmentResults: [], lifecycle: [], proofPackets: [], decisions: [], cancellation: null, createdAt: timestamp, updatedAt: timestamp };
        state.runs.push(run); state.currentRunId = run.bossRunId; state.revision += 1; return { title: "Boss trusted-local run created", message: formatRun(run), run: structuredClone(run) };
      }
      if (!selected) throw new Error("No matching trusted-local Boss run exists.");
      assertOwningSession(selected, managerSessionId);
      if (request.action === "proof") {
        if (TERMINAL_RUN_STATES.has(selected.state)) throw new Error(`Cannot create a proof packet for ${selected.state} Boss run.`);
        let reviewer = selected.assignments.find((assignment) => assignment.role === "adversary");
        if (!reviewer) {
          reviewer = { assignmentId: `assignment-${randomUUID()}`, role: "adversary", task: `Adversarially review trusted-local Boss run ${selected.bossRunId} against an exact advisory proof revision.`, revision: 1, state: "requested", workerId: null, workerIncarnationId: null, createdAt: timestamp, updatedAt: timestamp };
          selected.assignments.push(reviewer);
          selected.updatedAt = timestamp;
          state.revision += 1;
          return { title: "Boss adversary staffing requested", message: `${formatRun(selected)}\n\nThe adversary must be assigned before an exact proof revision can be generated and delivered.`, run: structuredClone(selected) };
        }
        if (reviewer.state === "failed") {
          reviewer.state = "requested"; reviewer.revision += 1; reviewer.workerId = null; reviewer.workerIncarnationId = null; delete reviewer.lastError; reviewer.updatedAt = timestamp; selected.updatedAt = timestamp; state.revision += 1;
          return { title: "Boss adversary staffing retry requested", message: `${formatRun(selected)}\n\nThe failed adversary assignment was advanced to a new requested revision for ordinary fleet retry.`, run: structuredClone(selected) };
        }
        if (reviewer.state !== "assigned" || !reviewer.workerId) return { title: "Boss adversary staffing pending", message: `${formatRun(selected)}\n\nThe adversary must be assigned before an exact proof revision can be generated and delivered.`, run: structuredClone(selected) };
        const latestProof = selected.proofPackets.at(-1);
        if (latestProof && latestProof.snapshotSha256 === proofDigest(selected, reviewer)) {
          const latestDelivery = selected.deliveries.find((delivery) => delivery.kind === "proof-review" && delivery.proofPacketId === latestProof.proofPacketId);
          if (!latestDelivery || latestDelivery.state === "failed") return { title: "Advisory proof delivery retry", message: `${formatRun(selected)}\n\nProof revision ${latestProof.revision} remains current and requires exact local review delivery retry.`, run: structuredClone(selected) };
        }
        if (selected.proofPackets.length >= MAX_PROOF_PACKETS) throw new Error(`Trusted-local Boss proof packet limit ${MAX_PROOF_PACKETS} reached.`);
        while (selected.deliveries.length >= 256) pruneOldestDeliveryPair(selected);
        const manager = assignmentForRole(selected, "manager");
        const proofPacketId = `proof-${randomUUID()}`;
        const packet: TrustedLocalBossProofPacket = { proofPacketId, revision: selected.proofPackets.length + 1, bossRunId: selected.bossRunId, runState: selected.state, managerAssignmentId: manager.assignmentId, reviewerAssignmentId: reviewer.assignmentId, lifecycleCount: selected.lifecycle.length, generatedAt: timestamp, snapshotSha256: proofDigest(selected, reviewer) };
        selected.proofPackets.push(packet); selected.updatedAt = timestamp; state.revision += 1;
        return { title: "Advisory proof packet", message: `${formatRun(selected)}\n\nProof revision ${packet.revision} is bound to sha256:${packet.snapshotSha256} and awaits exact local review delivery. No protected attestation is claimed.`, run: structuredClone(selected) };
      }
      if (request.action === "approve" || request.action === "reject") {
        if (!request.note) throw new Error(`Trusted-local ${request.action} requires an explicit review note.`);
        if (selected.state !== "active" && selected.state !== "paused") throw new Error(`Cannot ${request.action} Boss run from ${selected.state}.`);
        const proof = selected.proofPackets.at(-1); if (!proof) throw new Error(`Trusted-local ${request.action} requires an advisory proof packet.`);
        const reviewer = assignmentForRole(selected, "adversary"); if (reviewer.state !== "assigned" || !reviewer.workerId) throw new Error(`Trusted-local ${request.action} requires an assigned adversary reviewer.`);
        const proofDelivery = selected.deliveries.find((delivery) => delivery.kind === "proof-review" && delivery.proofPacketId === proof.proofPacketId);
        const proofResult = proofDelivery ? selected.assignmentResults.find((result) => result.deliveryId === proofDelivery.deliveryId) : undefined;
        if (!proofDelivery || proofDelivery.state !== "delivered" || proofResult?.outcome !== "accepted") throw new Error(`Trusted-local ${request.action} requires successful delivery of the exact latest proof.`);
        if (proof.runState !== selected.state || proof.snapshotSha256 !== proofDigest(selected, reviewer)) throw new Error(`Trusted-local ${request.action} requires a fresh proof of the exact current run state.`);
        if (selected.decisions.length) throw new Error("Trusted-local Boss run already has a review decision.");
        const outcome = request.action === "approve" ? "approved" : "rejected";
        selected.decisions.push({ decisionId: `decision-${randomUUID()}`, proofPacketId: proof.proofPacketId, proofRevision: proof.revision, reviewerAssignmentId: reviewer.assignmentId, reviewerWorkerId: reviewer.workerId, outcome, note: request.note.slice(0, 4_096), decidedBySessionId: managerSessionId, decidedAt: timestamp });
        selected.state = outcome; selected.updatedAt = timestamp; state.currentRunId = null; state.revision += 1;
        return { title: `Boss trusted-local run ${outcome}`, message: formatRun(selected), run: structuredClone(selected) };
      }
      const nextState = request.action === "pause" ? "paused" : request.action === "resume" ? "active" : "cancelled";
      if (request.action === "pause" && selected.state !== "active") throw new Error(`Cannot pause Boss run from ${selected.state}.`);
      if (request.action === "resume" && selected.state !== "paused") throw new Error(`Cannot resume Boss run from ${selected.state}.`);
      if (request.action === "cancel" && selected.state === "cancelled" && selected.cancellation?.state === "pending") return { title: "Boss trusted-local cancellation pending", message: formatRun(selected), run: structuredClone(selected) };
      if (request.action === "cancel" && selected.state === "cancelled" && selected.cancellation?.state === "failed") {
        selected.cancellation = { actionId: `cancel-${randomUUID()}`, state: "pending", requestedAt: timestamp };
        selected.updatedAt = timestamp;
        state.revision += 1;
        return { title: "Boss trusted-local cancellation retry requested", message: formatRun(selected), run: structuredClone(selected) };
      }
      if (request.action === "cancel" && TERMINAL_RUN_STATES.has(selected.state)) throw new Error(`Boss run is already ${selected.state}.`);
      selected.state = nextState; selected.updatedAt = timestamp;
      if (nextState === "cancelled") { state.currentRunId = null; selected.cancellation = { actionId: `cancel-${randomUUID()}`, state: "pending", requestedAt: timestamp }; for (const assignment of selected.assignments) { if (assignment.state === "requested") { assignment.state = "cancelled"; assignment.updatedAt = timestamp; } } } else state.currentRunId = selected.bossRunId;
      state.revision += 1; const titleAction = request.action === "pause" ? "paused" : request.action === "resume" ? "resumed" : "cancellation requested";
      return { title: `Boss trusted-local run ${titleAction}`, message: formatRun(selected), run: structuredClone(selected) };
    });
  }
}

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, normalize } from "node:path";
import { assertDelegationGrantSubset } from "./delegated-fleet-authorization.ts";
import { acquireKernelFileLock } from "./file-lock.ts";
import type { BossCandidateFingerprint } from "./boss-candidate-fingerprint.ts";
import type { BossCommandRequest } from "./boss-command.ts";
import { parseDelegationGrant } from "./store.ts";
import type { DelegationGrantV1, WorkerRecord, WorkerState } from "./types.ts";

export const TRUSTED_LOCAL_BOSS_RUN_VERSION = "orc.boss-trusted-local.v9" as const;
const LEGACY_TRUSTED_LOCAL_BOSS_RUN_VERSIONS = new Set(["orc.boss-trusted-local.v1", "orc.boss-trusted-local.v2", "orc.boss-trusted-local.v3", "orc.boss-trusted-local.v4", "orc.boss-trusted-local.v5", "orc.boss-trusted-local.v6", "orc.boss-trusted-local.v7", "orc.boss-trusted-local.v8"]);
export const TRUSTED_LOCAL_BOSS_RESOURCE_VERSION = "orc.boss-resource.v1" as const;
export const TRUSTED_LOCAL_BOSS_STORE_VERSION = "orc.boss-trusted-local.v11" as const;
const LEGACY_TRUSTED_LOCAL_BOSS_STORE_VERSIONS = new Set(["orc.boss-trusted-local.v1", "orc.boss-trusted-local.v2", "orc.boss-trusted-local.v3", "orc.boss-trusted-local.v4", "orc.boss-trusted-local.v5", "orc.boss-trusted-local.v6", "orc.boss-trusted-local.v7", "orc.boss-trusted-local.v8", "orc.boss-trusted-local.v9", "orc.boss-trusted-local.v10"]);
export const TRUSTED_LOCAL_BOSS_FREEZE_TRANSITION_VERSION = "orc.boss-freeze-transition.v1" as const;
export const TRUSTED_LOCAL_BOSS_FREEZE_VERSION = "orc.boss-freeze.v1" as const;
export const TRUSTED_LOCAL_BOSS_PAUSE_TRANSITION_VERSION = "orc.boss-pause-transition.v2" as const;
const LEGACY_TRUSTED_LOCAL_BOSS_PAUSE_TRANSITION_VERSION = "orc.boss-pause-transition.v1" as const;
export const TRUSTED_LOCAL_BOSS_PAUSE_VERSION = "orc.boss-pause.v1" as const;
export const TRUSTED_LOCAL_BOSS_PAUSE_RECONCILIATION_VERSION = "orc.boss-pause-reconciliation.v1" as const;
export const TRUSTED_LOCAL_BOSS_WARNING = "TRUSTED LOCAL MODE — same-user agents and local files are trusted; evidence is advisory, not tamper-proof.";
export const TRUSTED_LOCAL_BOSS_AUTHENTICATED_COMMUNICATION_DEADLINE_MS = 10 * 60_000;

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

export type TrustedLocalBossResourceLeaseState = "active" | "released" | "cleanup_failed";

export interface TrustedLocalBossResourceCapability {
  capability: "worktree-identity" | "worktree-read" | "worktree-write" | "edit" | "tests" | "git-transport";
  requested: "read" | "write" | "required";
  availability: "verified" | "configured" | "gap";
  evidence: string;
}

export interface TrustedLocalBossResource {
  version: typeof TRUSTED_LOCAL_BOSS_RESOURCE_VERSION;
  resourceId: string;
  revision: number;
  kind: "linked-worktree";
  path: string;
  gitAdminDirectory: string;
  gitCommonDirectory: string;
  branch: string;
  baseSha: string;
  headSha: string;
  existence: "verified" | "missing";
  leaseState: TrustedLocalBossResourceLeaseState;
  leaseOwnerBossRunId: string;
  leaseAcquiredAt: string;
  leaseExpiresAt: string;
  capabilities: TrustedLocalBossResourceCapability[];
}

export interface TrustedLocalBossAssignment {
  assignmentId: string;
  role: TrustedLocalBossAssignmentRole;
  task: string;
  revision: number;
  resourceRevision: number | null;
  state: TrustedLocalBossAssignmentState;
  workerId: string | null;
  workerIncarnationId: string | null;
  createdAt: string;
  updatedAt: string;
  workerBoundAt?: string;
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
  authenticatedIntercomBaselineAt?: string;
  authenticatedIntercomActivityAt?: string;
  detail?: string;
}

export type TrustedLocalBossCommunicationStatus = "not_assigned" | "deadline_unavailable" | "awaiting_authenticated_communication" | "authenticated_communication_stale" | "authenticated_communication_observed" | "suspended";

export interface TrustedLocalBossAssignmentCommunication {
  assignmentId: string;
  role: TrustedLocalBossAssignmentRole;
  workerId: string | null;
  workerState: WorkerState | null;
  transportProcessReadiness: "not_launched" | "observed" | "unavailable";
  assignmentAcknowledgementEvidence: "unavailable";
  assignmentAcknowledgedAt: null;
  authenticatedCommunicationEvidence: "authenticated_intercom" | "none_observed" | "unavailable";
  authenticatedCommunicationObservedAt: string | null;
  substantiveCheckpointEvidence: "unavailable";
  substantiveCheckpointObservedAt: null;
  authenticatedCommunicationDeadlineAt: string | null;
  communicationStatus: TrustedLocalBossCommunicationStatus;
}

export type TrustedLocalBossPendingDecisionOwner = "controller" | TrustedLocalBossAssignmentRole | "none" | "unavailable";
export type TrustedLocalBossPendingDecisionReason = "terminal" | "cancellation_settlement" | "pause_reconciliation" | "pause_disposition" | "participant_staffing" | "authenticated_communication_stale" | "review_decision" | "unavailable";

/** A control-plane next-action projection derived only from persisted state and explicit deadlines. */
export interface TrustedLocalBossPendingDecision {
  owner: TrustedLocalBossPendingDecisionOwner;
  reason: TrustedLocalBossPendingDecisionReason;
  freshness: "current" | "unavailable";
  targetRole: TrustedLocalBossAssignmentRole | null;
  assignmentId: string | null;
  sourceObservedAt: string | null;
  derivedAt: string;
  detail: string;
}

export interface TrustedLocalBossProofPacket {
  proofPacketId: string;
  revision: number;
  bossRunId: string;
  runState: TrustedLocalBossRunState;
  managerAssignmentId: string;
  reviewerAssignmentId: string;
  lifecycleCount: number;
  freezeRevision: number | null;
  acceptanceRevision: number | null;
  designRevision: number | null;
  resourceRevision: number | null;
  fingerprintSha256: string | null;
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

export interface TrustedLocalBossFreezeTransition {
  version: typeof TRUSTED_LOCAL_BOSS_FREEZE_TRANSITION_VERSION;
  actionId: string;
  revision: number;
  action: "freeze" | "unfreeze";
  outcome: "accepted" | "rejected";
  authorizedBySessionId: string;
  acceptanceRevision: number;
  designRevision: number;
  resourceRevision: number;
  freezeRevision: number | null;
  fingerprint: BossCandidateFingerprint;
  reason: string | null;
  occurredAt: string;
}

export interface TrustedLocalBossPausedTimer {
  workerId: string;
  workerIncarnationId: string;
  leaseRemainingMs: number;
  idleRemainingMs: number | null;
  checkpointRemainingMs: number | null;
  checkpointRetryRemainingMs: number | null;
  checkpointRetryIntervalMs: number | null;
}

export interface TrustedLocalBossPauseTarget {
  role: Exclude<TrustedLocalBossAssignmentRole, "manager">;
  workerId: string;
  workerIncarnationId: string;
  unit: string;
  mainPid: number;
}

export interface TrustedLocalBossPauseSettledTarget {
  workerId: string;
  workerIncarnationId: string;
  outcome: "terminal_inactive";
}

export interface TrustedLocalBossPauseTransition {
  version: typeof TRUSTED_LOCAL_BOSS_PAUSE_TRANSITION_VERSION;
  actionId: string;
  revision: number;
  action: "pause" | "resume";
  phase: "applying" | "accepted" | "failed";
  authorizedBySessionId: string;
  pauseRevision: number;
  targets: TrustedLocalBossPauseTarget[];
  intentionallyUnfrozenManagerWorkerId: string | null;
  timers: TrustedLocalBossPausedTimer[];
  settledTargets: TrustedLocalBossPauseSettledTarget[];
  reason: string | null;
  occurredAt: string;
  completedAt: string | null;
}

export interface TrustedLocalBossPause {
  version: typeof TRUSTED_LOCAL_BOSS_PAUSE_VERSION;
  pauseRevision: number;
  transitionRevision: number;
  targets: TrustedLocalBossPauseTarget[];
  intentionallyUnfrozenManagerWorkerId: string | null;
  timers: TrustedLocalBossPausedTimer[];
  authorizedBySessionId: string;
  pausedAt: string;
}

export interface TrustedLocalBossPauseReconciliation {
  version: typeof TRUSTED_LOCAL_BOSS_PAUSE_RECONCILIATION_VERSION;
  reconciliationId: string;
  revision: number;
  pauseRevision: number;
  transitionRevision: number;
  outcome: "degraded";
  detail: string;
  observedAt: string;
}

export interface TrustedLocalBossFreeze {
  version: typeof TRUSTED_LOCAL_BOSS_FREEZE_VERSION;
  freezeRevision: number;
  transitionRevision: number;
  acceptanceRevision: number;
  designRevision: number;
  resourceRevision: number;
  fingerprint: BossCandidateFingerprint;
  authorizedBySessionId: string;
  authorizedAt: string;
}

export interface TrustedLocalBossDynamicGrowthGrant {
  version: "orc.boss-dynamic-growth-grant.v1";
  revision: number;
  bossRunId: string;
  participantRole: TrustedLocalBossAssignmentRole;
  participantWorkerId: string;
  participantWorkerIncarnationId: string;
  acceptanceRevision: number;
  designRevision: number;
  delegationGrant: DelegationGrantV1;
  state: "active" | "revoked";
  authorizedBySessionId: string;
  authorizedAt: string;
  revokedBySessionId?: string;
  revokedAt?: string;
}

export interface TrustedLocalBossDynamicAssignment {
  workerId: string;
  workerIncarnationId: string;
  parentWorkerIncarnationId: string;
  grantId: string;
  growthGrantRevision: number;
  state: "active" | "released";
  createdAt: string;
  releasedAt?: string;
  releaseReason?: "launch-failed" | "terminal" | "forgotten";
}

export interface TrustedLocalBossRun {
  version: typeof TRUSTED_LOCAL_BOSS_RUN_VERSION;
  bossRunId: string;
  handle: string;
  goal: string;
  state: TrustedLocalBossRunState;
  managerSessionId: string;
  resource: TrustedLocalBossResource | null;
  acceptanceRevision: number | null;
  designRevision: number | null;
  freezeTransitions: TrustedLocalBossFreezeTransition[];
  currentFreeze: TrustedLocalBossFreeze | null;
  pauseTransitions: TrustedLocalBossPauseTransition[];
  currentPause: TrustedLocalBossPause | null;
  pauseReconciliations: TrustedLocalBossPauseReconciliation[];
  currentPauseDegradation: TrustedLocalBossPauseReconciliation | null;
  dynamicGrowthGrants: TrustedLocalBossDynamicGrowthGrant[];
  dynamicAssignments: TrustedLocalBossDynamicAssignment[];
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
  runs: TrustedLocalBossRun[];
}

export interface TrustedLocalBossResult {
  title: string;
  message: string;
  run?: TrustedLocalBossRun;
  runs?: TrustedLocalBossRun[];
  communication?: TrustedLocalBossAssignmentCommunication[];
  pendingDecision?: TrustedLocalBossPendingDecision;
  freezeTransition?: TrustedLocalBossFreezeTransition;
  pauseTransition?: TrustedLocalBossPauseTransition;
}

export interface TrustedLocalBossOrphanedWorker {
  worker: WorkerRecord;
  bossRunId: string;
  managerSessionId: string;
  assignmentRole: TrustedLocalBossAssignmentRole | null;
}

function initialState(): TrustedLocalBossState {
  return { version: TRUSTED_LOCAL_BOSS_STORE_VERSION, revision: 0, runs: [] };
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

function parseAssignment(value: unknown, legacy = false): TrustedLocalBossAssignment {
  if (!isPlainRecord(value)) throw new Error("Trusted-local Boss state contains an invalid assignment record");
  const required = ["assignmentId", "createdAt", "revision", "role", "state", "task", "updatedAt", "workerId", "workerIncarnationId", ...(legacy ? [] : ["resourceRevision"])];
  const expected = [...required, ...(value.workerBoundAt !== undefined ? ["workerBoundAt"] : []), ...(value.lastError !== undefined ? ["lastError"] : [])];
  if (!exactKeys(value, expected)) throw new Error("Trusted-local Boss state contains an invalid assignment record");
  const { assignmentId, createdAt, lastError, revision, role, state, task, updatedAt, workerBoundAt, workerId, workerIncarnationId } = value;
  const resourceRevision = legacy ? null : value.resourceRevision;
  if (typeof assignmentId !== "string" || !/^assignment-[0-9a-f-]{36}$/.test(assignmentId)
    || (role !== "manager" && role !== "worker" && role !== "scout" && role !== "adversary")
    || !Number.isSafeInteger(revision) || (revision as number) < 1
    || (resourceRevision !== null && (!Number.isSafeInteger(resourceRevision) || (resourceRevision as number) < 1))
    || typeof task !== "string" || task.length < 1 || task.length > 20_000
    || (state !== "requested" && state !== "assigned" && state !== "failed" && state !== "cancelled")
    || (workerId !== null && (typeof workerId !== "string" || workerId.length < 1 || workerId.length > 128))
    || (workerIncarnationId !== null && (typeof workerIncarnationId !== "string" || workerIncarnationId.length < 1 || workerIncarnationId.length > 128))
    || (workerBoundAt !== undefined && typeof workerBoundAt !== "string")
    || (lastError !== undefined && (typeof lastError !== "string" || lastError.length < 1 || lastError.length > 4_096))) {
    throw new Error("Trusted-local Boss state contains invalid assignment fields");
  }
  if (state === "assigned" && (!workerId || !workerIncarnationId)) throw new Error("Trusted-local Boss assigned worker lacks identity");
  if (state === "requested" && (workerId !== null || workerIncarnationId !== null || workerBoundAt !== undefined || lastError !== undefined)) throw new Error("Trusted-local Boss requested assignment contains premature outcome fields");
  return { assignmentId, role, task, revision: revision as number, resourceRevision: resourceRevision as number | null, state, workerId, workerIncarnationId, createdAt: parseTimestamp(createdAt, "assignment createdAt"), updatedAt: parseTimestamp(updatedAt, "assignment updatedAt"), ...(workerBoundAt !== undefined ? { workerBoundAt: parseTimestamp(workerBoundAt, "assignment workerBoundAt") } : {}), ...(lastError !== undefined ? { lastError } : {}) };
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
  const expected = [...required,
    ...(value.authenticatedIntercomBaselineAt !== undefined ? ["authenticatedIntercomBaselineAt"] : []),
    ...(value.authenticatedIntercomActivityAt !== undefined ? ["authenticatedIntercomActivityAt"] : []),
    ...(value.detail !== undefined ? ["detail"] : []),
  ];
  if (!exactKeys(value, expected)) throw new Error("Trusted-local Boss state contains an invalid lifecycle observation");
  const { assignmentId, authenticatedIntercomActivityAt, authenticatedIntercomBaselineAt, detail, observationId, observedAt, workerId, workerIncarnationId, workerState } = value;
  if (typeof observationId !== "string" || !/^observation-[0-9a-f-]{36}$/.test(observationId)
    || typeof assignmentId !== "string" || !/^assignment-[0-9a-f-]{36}$/.test(assignmentId)
    || typeof workerId !== "string" || workerId.length < 1 || workerId.length > 128
    || typeof workerIncarnationId !== "string" || workerIncarnationId.length < 1 || workerIncarnationId.length > 128
    || typeof workerState !== "string" || !TRUSTED_LOCAL_WORKER_STATES.has(workerState as WorkerState)
    || (authenticatedIntercomBaselineAt !== undefined && typeof authenticatedIntercomBaselineAt !== "string")
    || (authenticatedIntercomActivityAt !== undefined && typeof authenticatedIntercomActivityAt !== "string")
    || (detail !== undefined && (typeof detail !== "string" || detail.length < 1 || detail.length > 4_096))) throw new Error("Trusted-local Boss state contains invalid lifecycle observation fields");
  const parsedBaseline = authenticatedIntercomBaselineAt === undefined ? undefined : parseTimestamp(authenticatedIntercomBaselineAt, "authenticated Intercom baseline");
  const parsedActivity = authenticatedIntercomActivityAt === undefined ? undefined : parseTimestamp(authenticatedIntercomActivityAt, "authenticated Intercom activity");
  if (parsedActivity && parsedBaseline && Date.parse(parsedActivity) <= Date.parse(parsedBaseline)) throw new Error("Trusted-local Boss state contains invalid authenticated Intercom activity evidence");
  return { observationId, assignmentId, workerId, workerIncarnationId, workerState: workerState as WorkerState, observedAt: parseTimestamp(observedAt, "lifecycle observedAt"), ...(parsedBaseline ? { authenticatedIntercomBaselineAt: parsedBaseline } : {}), ...(parsedActivity ? { authenticatedIntercomActivityAt: parsedActivity } : {}), ...(detail !== undefined ? { detail } : {}) };
}

function parseProofPacket(value: unknown, legacyBinding = false): TrustedLocalBossProofPacket {
  const legacyKeys = ["bossRunId", "generatedAt", "lifecycleCount", "managerAssignmentId", "proofPacketId", "reviewerAssignmentId", "revision", "runState", "snapshotSha256"];
  const currentKeys = ["acceptanceRevision", ...legacyKeys, "designRevision", "fingerprintSha256", "freezeRevision", "resourceRevision"];
  if (!isPlainRecord(value) || !exactKeys(value, legacyBinding ? legacyKeys : currentKeys)) throw new Error("Trusted-local Boss state contains an invalid proof packet");
  const packet = value as unknown as TrustedLocalBossProofPacket;
  const bindings = legacyBinding
    ? { freezeRevision: null, acceptanceRevision: null, designRevision: null, resourceRevision: null, fingerprintSha256: null }
    : { freezeRevision: packet.freezeRevision, acceptanceRevision: packet.acceptanceRevision, designRevision: packet.designRevision, resourceRevision: packet.resourceRevision, fingerprintSha256: packet.fingerprintSha256 };
  const allBindingsUnavailable = Object.values(bindings).every((binding) => binding === null);
  const allBindingsCurrent = Number.isSafeInteger(bindings.freezeRevision) && (bindings.freezeRevision as number) >= 1
    && Number.isSafeInteger(bindings.acceptanceRevision) && (bindings.acceptanceRevision as number) >= 1
    && Number.isSafeInteger(bindings.designRevision) && (bindings.designRevision as number) >= 1
    && Number.isSafeInteger(bindings.resourceRevision) && (bindings.resourceRevision as number) >= 1
    && typeof bindings.fingerprintSha256 === "string" && /^[0-9a-f]{64}$/.test(bindings.fingerprintSha256);
  if (!/^proof-[0-9a-f-]{36}$/.test(packet.proofPacketId) || !Number.isSafeInteger(packet.revision) || packet.revision < 1
    || !/^boss-[0-9a-f-]{36}$/.test(packet.bossRunId) || !/^assignment-[0-9a-f-]{36}$/.test(packet.managerAssignmentId)
    || !/^assignment-[0-9a-f-]{36}$/.test(packet.reviewerAssignmentId) || !Number.isSafeInteger(packet.lifecycleCount) || packet.lifecycleCount < 0 || packet.lifecycleCount > 256
    || !TERMINAL_RUN_STATES.has(packet.runState) && packet.runState !== "active" && packet.runState !== "paused"
    || (!allBindingsUnavailable && !allBindingsCurrent)
    || !/^[0-9a-f]{64}$/.test(packet.snapshotSha256)) throw new Error("Trusted-local Boss state contains invalid proof packet fields");
  return { ...packet, ...bindings, generatedAt: parseTimestamp(packet.generatedAt, "proof generatedAt") };
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

function parseResourceCapability(value: unknown): TrustedLocalBossResourceCapability {
  if (!isPlainRecord(value) || !exactKeys(value, ["availability", "capability", "evidence", "requested"])) throw new Error("Trusted-local Boss state contains an invalid resource capability");
  const capability = value.capability;
  const requested = value.requested;
  const availability = value.availability;
  const evidence = value.evidence;
  if ((capability !== "worktree-identity" && capability !== "worktree-read" && capability !== "worktree-write" && capability !== "edit" && capability !== "tests" && capability !== "git-transport")
    || (requested !== "read" && requested !== "write" && requested !== "required")
    || (availability !== "verified" && availability !== "configured" && availability !== "gap")
    || typeof evidence !== "string" || evidence.length < 1 || evidence.length > 4_096) throw new Error("Trusted-local Boss state contains invalid resource capability fields");
  return { capability, requested, availability, evidence };
}

function parseResource(value: unknown, bossRunId: string): TrustedLocalBossResource | null {
  if (value === null || value === undefined) return null;
  if (!isPlainRecord(value) || !exactKeys(value, ["baseSha", "branch", "capabilities", "existence", "gitAdminDirectory", "gitCommonDirectory", "headSha", "kind", "leaseAcquiredAt", "leaseExpiresAt", "leaseOwnerBossRunId", "leaseState", "path", "resourceId", "revision", "version"])) throw new Error("Trusted-local Boss state contains an invalid resource record");
  const resource = value as unknown as TrustedLocalBossResource;
  const paths = [resource.path, resource.gitAdminDirectory, resource.gitCommonDirectory];
  if (resource.version !== TRUSTED_LOCAL_BOSS_RESOURCE_VERSION || !/^resource-[0-9a-f-]{36}$/.test(resource.resourceId)
    || !Number.isSafeInteger(resource.revision) || resource.revision < 1 || resource.kind !== "linked-worktree"
    || paths.some((path) => typeof path !== "string" || !isAbsolute(path) || normalize(path) !== path)
    || resource.gitAdminDirectory === resource.gitCommonDirectory
    || typeof resource.branch !== "string" || resource.branch.length < 1 || resource.branch.length > 512 || /[\u0000-\u001f\u007f]/.test(resource.branch)
    || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(resource.baseSha) || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(resource.headSha)
    || (resource.existence !== "verified" && resource.existence !== "missing")
    || (resource.leaseState !== "active" && resource.leaseState !== "released" && resource.leaseState !== "cleanup_failed")
    || resource.leaseOwnerBossRunId !== bossRunId || !Array.isArray(resource.capabilities) || resource.capabilities.length < 1 || resource.capabilities.length > 16) throw new Error("Trusted-local Boss state contains invalid resource fields");
  const leaseAcquiredAt = parseTimestamp(resource.leaseAcquiredAt, "resource leaseAcquiredAt");
  const leaseExpiresAt = parseTimestamp(resource.leaseExpiresAt, "resource leaseExpiresAt");
  if (Date.parse(leaseExpiresAt) <= Date.parse(leaseAcquiredAt)) throw new Error("Trusted-local Boss resource lease must expire after acquisition");
  if (resource.leaseState === "active" && resource.existence !== "verified") throw new Error("Trusted-local Boss active resource lease requires verified existence");
  return { ...resource, leaseAcquiredAt, leaseExpiresAt, capabilities: resource.capabilities.map(parseResourceCapability) };
}

function parseCandidateFingerprint(value: unknown): BossCandidateFingerprint {
  if (!isPlainRecord(value) || !exactKeys(value, ["aggregateSha256", "baseSha", "branch", "cwd", "gitAdminDirectory", "gitCommonDirectory", "headSha", "resourceId", "resourceRevision", "trackedDirtyBytes", "trackedDirtySha256", "untrackedBytes", "untrackedManifest", "version"])) throw new Error("Trusted-local Boss state contains an invalid candidate fingerprint");
  const fingerprint = value as unknown as BossCandidateFingerprint;
  if (fingerprint.version !== "orc.boss-candidate-fingerprint.v1" || !/^resource-[0-9a-f-]{36}$/.test(fingerprint.resourceId)
    || !Number.isSafeInteger(fingerprint.resourceRevision) || fingerprint.resourceRevision < 1
    || [fingerprint.cwd, fingerprint.gitAdminDirectory, fingerprint.gitCommonDirectory].some((path) => typeof path !== "string" || !isAbsolute(path) || normalize(path) !== path)
    || typeof fingerprint.branch !== "string" || fingerprint.branch.length < 1 || fingerprint.branch.length > 512
    || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(fingerprint.baseSha) || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(fingerprint.headSha)
    || !Number.isSafeInteger(fingerprint.trackedDirtyBytes) || fingerprint.trackedDirtyBytes < 0 || !/^[0-9a-f]{64}$/.test(fingerprint.trackedDirtySha256)
    || !Number.isSafeInteger(fingerprint.untrackedBytes) || fingerprint.untrackedBytes < 0 || !Array.isArray(fingerprint.untrackedManifest) || fingerprint.untrackedManifest.length > 4_096
    || !/^[0-9a-f]{64}$/.test(fingerprint.aggregateSha256)) throw new Error("Trusted-local Boss state contains invalid candidate fingerprint fields");
  const paths = new Set<string>();
  let totalBytes = 0;
  const manifest = fingerprint.untrackedManifest.map((entry) => {
    if (!isPlainRecord(entry) || !exactKeys(entry, ["path", "sha256", "size", "type"]) || typeof entry.path !== "string" || !entry.path || entry.path.startsWith("/")
      || entry.path.split("/").some((part) => !part || part === "." || part === "..") || /[\u0000-\u001f\u007f]/.test(entry.path) || paths.has(entry.path)
      || (entry.type !== "file" && entry.type !== "symlink") || !Number.isSafeInteger(entry.size) || (entry.size as number) < 0 || !/^[0-9a-f]{64}$/.test(entry.sha256 as string)) {
      throw new Error("Trusted-local Boss state contains an invalid candidate untracked manifest");
    }
    paths.add(entry.path); totalBytes += entry.size as number;
    return { path: entry.path, type: entry.type, size: entry.size as number, sha256: entry.sha256 as string };
  });
  if (totalBytes !== fingerprint.untrackedBytes) throw new Error("Trusted-local Boss candidate untracked byte total does not match its manifest");
  const sortedPaths = [...paths].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  if (manifest.some((entry, index) => entry.path !== sortedPaths[index])) throw new Error("Trusted-local Boss candidate untracked manifest is not byte-sorted");
  const canonicalPayload = {
    version: fingerprint.version,
    resourceId: fingerprint.resourceId,
    resourceRevision: fingerprint.resourceRevision,
    cwd: fingerprint.cwd,
    gitAdminDirectory: fingerprint.gitAdminDirectory,
    gitCommonDirectory: fingerprint.gitCommonDirectory,
    branch: fingerprint.branch,
    baseSha: fingerprint.baseSha,
    headSha: fingerprint.headSha,
    trackedDirtyBytes: fingerprint.trackedDirtyBytes,
    trackedDirtySha256: fingerprint.trackedDirtySha256,
    untrackedBytes: fingerprint.untrackedBytes,
    untrackedManifest: manifest,
  };
  if (createHash("sha256").update(JSON.stringify(canonicalPayload)).digest("hex") !== fingerprint.aggregateSha256) throw new Error("Trusted-local Boss candidate aggregate fingerprint is invalid");
  return { ...canonicalPayload, aggregateSha256: fingerprint.aggregateSha256 };
}

function positiveRevision(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`Trusted-local Boss state contains invalid ${field}`);
  return value as number;
}

function parseFreezeTransition(value: unknown): TrustedLocalBossFreezeTransition {
  if (!isPlainRecord(value) || !exactKeys(value, ["acceptanceRevision", "action", "actionId", "authorizedBySessionId", "designRevision", "fingerprint", "freezeRevision", "occurredAt", "outcome", "reason", "resourceRevision", "revision", "version"])) throw new Error("Trusted-local Boss state contains an invalid freeze transition");
  const transition = value as unknown as TrustedLocalBossFreezeTransition;
  if (transition.version !== TRUSTED_LOCAL_BOSS_FREEZE_TRANSITION_VERSION || !/^freeze-action-[0-9a-f-]{36}$/.test(transition.actionId)
    || (transition.action !== "freeze" && transition.action !== "unfreeze") || (transition.outcome !== "accepted" && transition.outcome !== "rejected")
    || typeof transition.authorizedBySessionId !== "string" || transition.authorizedBySessionId.length < 1 || transition.authorizedBySessionId.length > 1_024
    || (transition.freezeRevision !== null && (!Number.isSafeInteger(transition.freezeRevision) || transition.freezeRevision < 1))
    || (transition.outcome === "accepted") !== (transition.reason === null)
    || (transition.reason !== null && (typeof transition.reason !== "string" || transition.reason.length < 1 || transition.reason.length > 4_096))) throw new Error("Trusted-local Boss state contains invalid freeze transition fields");
  return { ...transition, revision: positiveRevision(transition.revision, "freeze transition revision"), acceptanceRevision: positiveRevision(transition.acceptanceRevision, "freeze acceptance revision"), designRevision: positiveRevision(transition.designRevision, "freeze design revision"), resourceRevision: positiveRevision(transition.resourceRevision, "freeze resource revision"), fingerprint: parseCandidateFingerprint(transition.fingerprint), occurredAt: parseTimestamp(transition.occurredAt, "freeze transition occurredAt") };
}

function parseCurrentFreeze(value: unknown): TrustedLocalBossFreeze | null {
  if (value === null) return null;
  if (!isPlainRecord(value) || !exactKeys(value, ["acceptanceRevision", "authorizedAt", "authorizedBySessionId", "designRevision", "fingerprint", "freezeRevision", "resourceRevision", "transitionRevision", "version"])) throw new Error("Trusted-local Boss state contains an invalid current freeze");
  const freeze = value as unknown as TrustedLocalBossFreeze;
  if (freeze.version !== TRUSTED_LOCAL_BOSS_FREEZE_VERSION || typeof freeze.authorizedBySessionId !== "string" || freeze.authorizedBySessionId.length < 1 || freeze.authorizedBySessionId.length > 1_024) throw new Error("Trusted-local Boss state contains invalid current freeze fields");
  return { ...freeze, freezeRevision: positiveRevision(freeze.freezeRevision, "freeze revision"), transitionRevision: positiveRevision(freeze.transitionRevision, "freeze transition revision"), acceptanceRevision: positiveRevision(freeze.acceptanceRevision, "freeze acceptance revision"), designRevision: positiveRevision(freeze.designRevision, "freeze design revision"), resourceRevision: positiveRevision(freeze.resourceRevision, "freeze resource revision"), fingerprint: parseCandidateFingerprint(freeze.fingerprint), authorizedAt: parseTimestamp(freeze.authorizedAt, "freeze authorizedAt") };
}

function parsePauseTarget(value: unknown): TrustedLocalBossPauseTarget {
  if (!isPlainRecord(value) || !exactKeys(value, ["mainPid", "role", "unit", "workerId", "workerIncarnationId"])) throw new Error("Trusted-local Boss state contains an invalid pause target");
  const target = value as unknown as TrustedLocalBossPauseTarget;
  if ((target.role !== "worker" && target.role !== "scout" && target.role !== "adversary")
    || typeof target.workerId !== "string" || target.workerId.length < 1 || target.workerId.length > 128
    || typeof target.workerIncarnationId !== "string" || target.workerIncarnationId.length < 1 || target.workerIncarnationId.length > 128
    || typeof target.unit !== "string" || target.unit.length < 9 || target.unit.length > 256 || !target.unit.endsWith(".service") || /[\u0000-\u001f\u007f/]/.test(target.unit)
    || !Number.isSafeInteger(target.mainPid) || target.mainPid < 1) throw new Error("Trusted-local Boss state contains invalid pause target fields");
  return { ...target };
}

function parsePausedTimer(value: unknown): TrustedLocalBossPausedTimer {
  if (!isPlainRecord(value) || !exactKeys(value, ["checkpointRemainingMs", "checkpointRetryIntervalMs", "checkpointRetryRemainingMs", "idleRemainingMs", "leaseRemainingMs", "workerId", "workerIncarnationId"])) throw new Error("Trusted-local Boss state contains an invalid paused timer");
  const timer = value as unknown as TrustedLocalBossPausedTimer;
  const optionalDuration = (duration: unknown): boolean => duration === null || (Number.isSafeInteger(duration) && (duration as number) >= 0);
  if (typeof timer.workerId !== "string" || timer.workerId.length < 1 || timer.workerId.length > 128
    || typeof timer.workerIncarnationId !== "string" || timer.workerIncarnationId.length < 1 || timer.workerIncarnationId.length > 128
    || !Number.isSafeInteger(timer.leaseRemainingMs) || timer.leaseRemainingMs < 0
    || !optionalDuration(timer.idleRemainingMs) || !optionalDuration(timer.checkpointRemainingMs) || !optionalDuration(timer.checkpointRetryRemainingMs) || !optionalDuration(timer.checkpointRetryIntervalMs)
    || ((timer.checkpointRetryRemainingMs === null) !== (timer.checkpointRetryIntervalMs === null))) throw new Error("Trusted-local Boss state contains invalid paused timer fields");
  return { ...timer };
}

function parsePauseSettledTarget(value: unknown): TrustedLocalBossPauseSettledTarget {
  if (!isPlainRecord(value) || !exactKeys(value, ["outcome", "workerId", "workerIncarnationId"])) throw new Error("Trusted-local Boss state contains an invalid pause settled target");
  const target = value as unknown as TrustedLocalBossPauseSettledTarget;
  if (target.outcome !== "terminal_inactive" || typeof target.workerId !== "string" || target.workerId.length < 1 || target.workerId.length > 128
    || typeof target.workerIncarnationId !== "string" || target.workerIncarnationId.length < 1 || target.workerIncarnationId.length > 128) throw new Error("Trusted-local Boss state contains invalid pause settled target fields");
  return { ...target };
}

function parsePauseTransition(value: unknown, legacySettlement: boolean): TrustedLocalBossPauseTransition {
  const expectedKeys = ["action", "actionId", "authorizedBySessionId", "completedAt", "intentionallyUnfrozenManagerWorkerId", "occurredAt", "pauseRevision", "phase", "reason", "revision", "targets", "timers", "version", ...(legacySettlement ? [] : ["settledTargets"])];
  if (!isPlainRecord(value) || !exactKeys(value, expectedKeys)) throw new Error("Trusted-local Boss state contains an invalid pause transition");
  const transition = value as unknown as TrustedLocalBossPauseTransition;
  const rawVersion = value.version;
  if ((legacySettlement ? rawVersion !== LEGACY_TRUSTED_LOCAL_BOSS_PAUSE_TRANSITION_VERSION : rawVersion !== TRUSTED_LOCAL_BOSS_PAUSE_TRANSITION_VERSION) || !/^pause-action-[0-9a-f-]{36}$/.test(transition.actionId)
    || (transition.action !== "pause" && transition.action !== "resume") || (transition.phase !== "applying" && transition.phase !== "accepted" && transition.phase !== "failed")
    || typeof transition.authorizedBySessionId !== "string" || transition.authorizedBySessionId.length < 1 || transition.authorizedBySessionId.length > 1_024
    || !Array.isArray(transition.targets) || transition.targets.length > 3 || !Array.isArray(transition.timers) || transition.timers.length > 3
    || (transition.intentionallyUnfrozenManagerWorkerId !== null && (typeof transition.intentionallyUnfrozenManagerWorkerId !== "string" || transition.intentionallyUnfrozenManagerWorkerId.length < 1 || transition.intentionallyUnfrozenManagerWorkerId.length > 128))
    || (transition.phase === "applying" ? transition.completedAt !== null || transition.reason !== null : typeof transition.completedAt !== "string")
    || (transition.phase === "failed" ? typeof transition.reason !== "string" || transition.reason.length < 1 || transition.reason.length > 4_096 : transition.reason !== null)) throw new Error("Trusted-local Boss state contains invalid pause transition fields");
  const targets = transition.targets.map(parsePauseTarget);
  const timers = transition.timers.map(parsePausedTimer);
  const settledTargets = legacySettlement ? [] : Array.isArray(transition.settledTargets) ? transition.settledTargets.map(parsePauseSettledTarget) : (() => { throw new Error("Trusted-local Boss state contains invalid pause settled targets"); })();
  const targetKeys = new Set(targets.map((target) => `${target.workerId}\0${target.workerIncarnationId}`));
  if (new Set(targets.map((target) => target.workerId)).size !== targets.length || new Set(timers.map((timer) => timer.workerId)).size !== timers.length
    || new Set(settledTargets.map((target) => `${target.workerId}\0${target.workerIncarnationId}`)).size !== settledTargets.length
    || settledTargets.some((target) => !targetKeys.has(`${target.workerId}\0${target.workerIncarnationId}`))
    || settledTargets.length > 0 && (transition.action !== "resume" || transition.phase !== "accepted")) throw new Error("Trusted-local Boss pause transition contains invalid or duplicate identities");
  return { ...transition, version: TRUSTED_LOCAL_BOSS_PAUSE_TRANSITION_VERSION, revision: positiveRevision(transition.revision, "pause transition revision"), pauseRevision: positiveRevision(transition.pauseRevision, "pause revision"), targets, timers, settledTargets, occurredAt: parseTimestamp(transition.occurredAt, "pause transition occurredAt"), completedAt: transition.completedAt === null ? null : parseTimestamp(transition.completedAt, "pause transition completedAt") };
}

function parseCurrentPause(value: unknown): TrustedLocalBossPause | null {
  if (value === null) return null;
  if (!isPlainRecord(value) || !exactKeys(value, ["authorizedBySessionId", "intentionallyUnfrozenManagerWorkerId", "pauseRevision", "pausedAt", "targets", "timers", "transitionRevision", "version"])) throw new Error("Trusted-local Boss state contains an invalid current pause");
  const pause = value as unknown as TrustedLocalBossPause;
  if (pause.version !== TRUSTED_LOCAL_BOSS_PAUSE_VERSION || typeof pause.authorizedBySessionId !== "string" || !Array.isArray(pause.targets) || !Array.isArray(pause.timers)
    || (pause.intentionallyUnfrozenManagerWorkerId !== null && typeof pause.intentionallyUnfrozenManagerWorkerId !== "string")) throw new Error("Trusted-local Boss state contains invalid current pause fields");
  return { ...pause, pauseRevision: positiveRevision(pause.pauseRevision, "pause revision"), transitionRevision: positiveRevision(pause.transitionRevision, "pause transition revision"), targets: pause.targets.map(parsePauseTarget), timers: pause.timers.map(parsePausedTimer), pausedAt: parseTimestamp(pause.pausedAt, "pause pausedAt") };
}

function parsePauseReconciliation(value: unknown): TrustedLocalBossPauseReconciliation {
  if (!isPlainRecord(value) || !exactKeys(value, ["detail", "observedAt", "outcome", "pauseRevision", "reconciliationId", "revision", "transitionRevision", "version"])) throw new Error("Trusted-local Boss state contains an invalid pause reconciliation");
  const reconciliation = value as unknown as TrustedLocalBossPauseReconciliation;
  if (reconciliation.version !== TRUSTED_LOCAL_BOSS_PAUSE_RECONCILIATION_VERSION || !/^pause-reconciliation-[0-9a-f-]{36}$/.test(reconciliation.reconciliationId)
    || reconciliation.outcome !== "degraded" || typeof reconciliation.detail !== "string" || reconciliation.detail.length < 1 || reconciliation.detail.length > 4_096) throw new Error("Trusted-local Boss state contains invalid pause reconciliation fields");
  return { ...reconciliation, revision: positiveRevision(reconciliation.revision, "pause reconciliation revision"), pauseRevision: positiveRevision(reconciliation.pauseRevision, "pause reconciliation pause revision"), transitionRevision: positiveRevision(reconciliation.transitionRevision, "pause reconciliation transition revision"), observedAt: parseTimestamp(reconciliation.observedAt, "pause reconciliation observedAt") };
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

const BOSS_HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?-[a-z2-7]{10}$/;
const BOSS_HANDLE_PREFIX = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export function deterministicBossRunHandle(bossRunId: string, prefix = "boss"): string {
  if (!/^boss-[0-9a-f-]{36}$/.test(bossRunId)) throw new Error("Trusted-local Boss handle requires an exact run id");
  if (!BOSS_HANDLE_PREFIX.test(prefix)) throw new Error("Trusted-local Boss handle prefix is invalid");
  const digest = createHash("sha256").update(`orc-boss-handle-v1\0${bossRunId}`).digest();
  let bits = 0;
  let value = 0;
  let suffix = "";
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5 && suffix.length < 10) {
      suffix += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (suffix.length === 10) break;
  }
  return `${prefix}-${suffix}`;
}

function parseDynamicGrowthGrant(value: unknown, bossRunId: string): TrustedLocalBossDynamicGrowthGrant {
  if (!isPlainRecord(value)) throw new Error("Trusted-local Boss state contains an invalid dynamic growth grant");
  const revoked = value.state === "revoked";
  const keys = ["acceptanceRevision", "authorizedAt", "authorizedBySessionId", "bossRunId", "delegationGrant", "designRevision", "participantRole", "participantWorkerId", "participantWorkerIncarnationId", "revision", "state", "version", ...(revoked ? ["revokedAt", "revokedBySessionId"] : [])];
  if (!exactKeys(value, keys)) throw new Error("Trusted-local Boss state contains an invalid dynamic growth grant");
  const grant = value as unknown as TrustedLocalBossDynamicGrowthGrant;
  if (grant.version !== "orc.boss-dynamic-growth-grant.v1" || grant.bossRunId !== bossRunId
    || !Number.isSafeInteger(grant.revision) || grant.revision < 1
    || (grant.participantRole !== "manager" && grant.participantRole !== "worker" && grant.participantRole !== "scout" && grant.participantRole !== "adversary")
    || typeof grant.participantWorkerId !== "string" || grant.participantWorkerId.length < 1 || grant.participantWorkerId.length > 128
    || typeof grant.participantWorkerIncarnationId !== "string" || grant.participantWorkerIncarnationId.length < 1 || grant.participantWorkerIncarnationId.length > 128
    || !Number.isSafeInteger(grant.acceptanceRevision) || grant.acceptanceRevision < 1
    || !Number.isSafeInteger(grant.designRevision) || grant.designRevision < 1
    || (grant.state !== "active" && grant.state !== "revoked")
    || typeof grant.authorizedBySessionId !== "string" || grant.authorizedBySessionId.length < 1 || grant.authorizedBySessionId.length > 1_024
    || (revoked && (typeof grant.revokedBySessionId !== "string" || grant.revokedBySessionId.length < 1 || grant.revokedBySessionId.length > 1_024 || typeof grant.revokedAt !== "string"))) throw new Error("Trusted-local Boss state contains invalid dynamic growth grant fields");
  const authorizedAt = parseTimestamp(grant.authorizedAt, "dynamic growth authorizedAt");
  const revokedAt = revoked ? parseTimestamp(grant.revokedAt, "dynamic growth revokedAt") : undefined;
  if (revokedAt && Date.parse(revokedAt) < Date.parse(authorizedAt)) throw new Error("Trusted-local Boss dynamic growth revocation predates authorization");
  return { ...grant, delegationGrant: parseDelegationGrant(grant.delegationGrant, "boss.dynamicGrowthGrant.delegationGrant"), authorizedAt, ...(revoked ? { revokedAt } : {}) };
}

function parseDynamicAssignment(value: unknown): TrustedLocalBossDynamicAssignment {
  if (!isPlainRecord(value)) throw new Error("Trusted-local Boss state contains an invalid dynamic assignment");
  const released = value.state === "released";
  if (!exactKeys(value, ["createdAt", "grantId", "growthGrantRevision", "parentWorkerIncarnationId", ...(released ? ["releaseReason", "releasedAt"] : []), "state", "workerId", "workerIncarnationId"])) throw new Error("Trusted-local Boss state contains an invalid dynamic assignment");
  const assignment = value as unknown as TrustedLocalBossDynamicAssignment;
  if ([assignment.workerId, assignment.workerIncarnationId, assignment.parentWorkerIncarnationId, assignment.grantId].some((field) => typeof field !== "string" || field.length < 1 || field.length > 128)
    || !Number.isSafeInteger(assignment.growthGrantRevision) || assignment.growthGrantRevision < 1
    || (assignment.state !== "active" && assignment.state !== "released")
    || (released && assignment.releaseReason !== "launch-failed" && assignment.releaseReason !== "terminal" && assignment.releaseReason !== "forgotten")) throw new Error("Trusted-local Boss state contains invalid dynamic assignment fields");
  const createdAt = parseTimestamp(assignment.createdAt, "dynamic assignment createdAt");
  const releasedAt = released ? parseTimestamp(assignment.releasedAt, "dynamic assignment releasedAt") : undefined;
  if (releasedAt && Date.parse(releasedAt) < Date.parse(createdAt)) throw new Error("Trusted-local Boss dynamic assignment release predates creation");
  return { ...assignment, createdAt, ...(released ? { releasedAt } : {}) };
}

function parseRun(value: unknown, handlePrefix: string): TrustedLocalBossRun {
  if (!isPlainRecord(value)) throw new Error("Trusted-local Boss state contains an invalid run record");
  const legacyVersion = typeof value.version === "string" && LEGACY_TRUSTED_LOCAL_BOSS_RUN_VERSIONS.has(value.version);
  const legacyHandle = value.version === "orc.boss-trusted-local.v1";
  const legacyResource = value.version === "orc.boss-trusted-local.v1" || value.version === "orc.boss-trusted-local.v2";
  const legacyFreeze = value.version === "orc.boss-trusted-local.v1" || value.version === "orc.boss-trusted-local.v2" || value.version === "orc.boss-trusted-local.v3";
  const legacyPause = value.version === "orc.boss-trusted-local.v1" || value.version === "orc.boss-trusted-local.v2" || value.version === "orc.boss-trusted-local.v3" || value.version === "orc.boss-trusted-local.v4" || value.version === "orc.boss-trusted-local.v5";
  const legacyPauseReconciliation = value.version === "orc.boss-trusted-local.v1" || value.version === "orc.boss-trusted-local.v2" || value.version === "orc.boss-trusted-local.v3" || value.version === "orc.boss-trusted-local.v4" || value.version === "orc.boss-trusted-local.v5" || value.version === "orc.boss-trusted-local.v6";
  const legacyPauseSettlement = legacyVersion;
  const legacyDynamicGrowth = legacyVersion && value.dynamicAssignments === undefined && value.dynamicGrowthGrants === undefined;
  const keys = ["assignmentResults", "assignments", "bossRunId", "cancellation", "createdAt", "decisions", "deliveries", "goal", "lifecycle", "managerSessionId", "proofPackets", "state", "updatedAt", "version", ...(legacyHandle ? [] : ["handle"]), ...(legacyResource ? [] : ["resource"]), ...(legacyFreeze ? [] : ["acceptanceRevision", "currentFreeze", "designRevision", "freezeTransitions"]), ...(legacyPause ? [] : ["currentPause", "pauseTransitions"]), ...(legacyPauseReconciliation ? [] : ["currentPauseDegradation", "pauseReconciliations"]), ...(legacyDynamicGrowth ? [] : ["dynamicAssignments", "dynamicGrowthGrants"])];
  if (!exactKeys(value, keys)) throw new Error("Trusted-local Boss state contains an invalid run record");
  const { assignmentResults, assignments, bossRunId, cancellation, createdAt, decisions, deliveries, goal, lifecycle, managerSessionId, proofPackets, state, updatedAt } = value;
  if ((!legacyVersion && value.version !== TRUSTED_LOCAL_BOSS_RUN_VERSION) || typeof bossRunId !== "string" || !/^boss-[0-9a-f-]{36}$/.test(bossRunId)
    || typeof goal !== "string" || goal.length < 1 || goal.length > MAX_GOAL_LENGTH || typeof managerSessionId !== "string" || managerSessionId.length < 1 || managerSessionId.length > 1_024
    || (state !== "active" && state !== "paused" && !TERMINAL_RUN_STATES.has(state as TrustedLocalBossRunState))
    || !Array.isArray(assignments) || assignments.length < 3 || assignments.length > 4 || !Array.isArray(deliveries) || deliveries.length > 256 || !Array.isArray(assignmentResults) || assignmentResults.length > 256 || !Array.isArray(lifecycle) || lifecycle.length > 256
    || !Array.isArray(proofPackets) || proofPackets.length > MAX_PROOF_PACKETS || !Array.isArray(decisions) || decisions.length > 64) throw new Error("Trusted-local Boss state contains invalid run fields");
  const dynamicGrowthGrants = legacyDynamicGrowth ? [] : Array.isArray(value.dynamicGrowthGrants) ? value.dynamicGrowthGrants.map((grant) => parseDynamicGrowthGrant(grant, bossRunId)) : (() => { throw new Error("Trusted-local Boss state contains invalid dynamic growth grants"); })();
  const dynamicAssignments = legacyDynamicGrowth ? [] : Array.isArray(value.dynamicAssignments) ? value.dynamicAssignments.map(parseDynamicAssignment) : (() => { throw new Error("Trusted-local Boss state contains invalid dynamic assignments"); })();
  const activeGrowthParticipants = dynamicGrowthGrants.filter((grant) => grant.state === "active").map((grant) => grant.participantWorkerIncarnationId);
  if (dynamicGrowthGrants.length > 64 || dynamicAssignments.length > 256
    || dynamicGrowthGrants.some((grant, index) => grant.revision !== index + 1)
    || new Set(activeGrowthParticipants).size !== activeGrowthParticipants.length
    || new Set(dynamicAssignments.map((assignment) => assignment.workerId)).size !== dynamicAssignments.length
    || new Set(dynamicAssignments.map((assignment) => assignment.workerIncarnationId)).size !== dynamicAssignments.length
    || dynamicAssignments.some((assignment) => !dynamicGrowthGrants.some((grant) => grant.revision === assignment.growthGrantRevision && grant.delegationGrant.grantId === assignment.grantId && grant.participantWorkerIncarnationId === assignment.parentWorkerIncarnationId))) throw new Error("Trusted-local Boss state contains invalid dynamic growth correlation");
  const parsedAssignments = assignments.map((assignment) => parseAssignment(assignment, legacyResource));
  if (parsedAssignments.filter((assignment) => assignment.role === "manager").length !== 1 || parsedAssignments.filter((assignment) => assignment.role === "worker").length !== 1 || parsedAssignments.filter((assignment) => assignment.role === "scout").length !== 1 || parsedAssignments.filter((assignment) => assignment.role === "adversary").length > 1) throw new Error("Trusted-local Boss state contains invalid staffing roles");
  const parsedDeliveries = deliveries.map(parseDelivery);
  const parsedResults = assignmentResults.map(parseAssignmentResult);
  const parsedLifecycle = lifecycle.map(parseLifecycleObservation);
  // Bound proof packets shipped with run v5. Only v1-v4 use the legacy
  // unbound shape; later run-schema additions must not reinterpret v5 proofs.
  const legacyProof = value.version === "orc.boss-trusted-local.v1"
    || value.version === "orc.boss-trusted-local.v2"
    || value.version === "orc.boss-trusted-local.v3"
    || value.version === "orc.boss-trusted-local.v4";
  const parsedProofs = proofPackets.map((packet) => parseProofPacket(packet, legacyProof));
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
  const handle = legacyHandle ? deterministicBossRunHandle(bossRunId, handlePrefix) : value.handle;
  if (typeof handle !== "string" || !BOSS_HANDLE.test(handle)) throw new Error("Trusted-local Boss state contains an invalid run handle");
  const resource = parseResource(legacyResource ? null : value.resource, bossRunId);
  // v3 introduced Controller-provisioned canonical resources before explicit acceptance/design
  // fields existed. Their initial resource attachment already represented revision 1 of both
  // Controller-owned inputs; preserve that durable meaning so migrated canonical runs remain
  // operable without inventing revisions for older resource-less runs.
  const legacyCanonicalRevision = legacyFreeze && resource ? 1 : null;
  const acceptanceRevision = legacyFreeze ? legacyCanonicalRevision : value.acceptanceRevision === null ? null : positiveRevision(value.acceptanceRevision, "acceptance revision");
  const designRevision = legacyFreeze ? legacyCanonicalRevision : value.designRevision === null ? null : positiveRevision(value.designRevision, "design revision");
  if ((acceptanceRevision === null) !== (designRevision === null)) throw new Error("Trusted-local Boss acceptance and design revisions must be jointly available");
  const freezeTransitions = legacyFreeze ? [] : Array.isArray(value.freezeTransitions) ? value.freezeTransitions.map(parseFreezeTransition) : (() => { throw new Error("Trusted-local Boss state contains invalid freeze transitions"); })();
  if (freezeTransitions.some((transition, index) => transition.revision !== index + 1)) throw new Error("Trusted-local Boss freeze transition revisions must be monotonic");
  const currentFreeze = legacyFreeze ? null : parseCurrentFreeze(value.currentFreeze);
  let derivedFreeze: TrustedLocalBossFreeze | null = null;
  let nextFreezeRevision = 1;
  for (const transition of freezeTransitions) {
    if (transition.fingerprint.resourceRevision !== transition.resourceRevision) throw new Error("Trusted-local Boss freeze transition fingerprint revision does not match its resource revision");
    if (transition.outcome === "rejected") continue;
    if (transition.action === "freeze") {
      if (derivedFreeze || transition.freezeRevision !== nextFreezeRevision) throw new Error("Trusted-local Boss accepted freeze transition is not a valid monotonic projection");
      derivedFreeze = { version: TRUSTED_LOCAL_BOSS_FREEZE_VERSION, freezeRevision: transition.freezeRevision, transitionRevision: transition.revision, acceptanceRevision: transition.acceptanceRevision, designRevision: transition.designRevision, resourceRevision: transition.resourceRevision, fingerprint: transition.fingerprint, authorizedBySessionId: transition.authorizedBySessionId, authorizedAt: transition.occurredAt };
      nextFreezeRevision += 1;
    } else {
      if (!derivedFreeze || transition.freezeRevision !== derivedFreeze.freezeRevision || transition.acceptanceRevision !== derivedFreeze.acceptanceRevision || transition.designRevision !== derivedFreeze.designRevision || transition.resourceRevision !== derivedFreeze.resourceRevision || transition.fingerprint.aggregateSha256 !== derivedFreeze.fingerprint.aggregateSha256) throw new Error("Trusted-local Boss accepted unfreeze transition does not match the current freeze");
      derivedFreeze = null;
    }
  }
  if (JSON.stringify(currentFreeze) !== JSON.stringify(derivedFreeze)) throw new Error("Trusted-local Boss current freeze is not derived from accepted Controller transitions");
  const pauseTransitions = legacyPause ? [] : Array.isArray(value.pauseTransitions) ? value.pauseTransitions.map((transition) => parsePauseTransition(transition, legacyPauseSettlement)) : (() => { throw new Error("Trusted-local Boss state contains invalid pause transitions"); })();
  if (pauseTransitions.some((transition, index) => transition.revision !== index + 1) || pauseTransitions.filter((transition) => transition.phase === "applying").length > 1 || pauseTransitions.some((transition, index) => transition.phase === "applying" && index !== pauseTransitions.length - 1)) throw new Error("Trusted-local Boss pause transition revisions or pending state are invalid");
  let derivedPause: TrustedLocalBossPause | null = null;
  let nextPauseRevision = 1;
  for (const transition of pauseTransitions) {
    if (transition.phase !== "accepted") continue;
    if (transition.action === "pause") {
      if (derivedPause || transition.pauseRevision !== nextPauseRevision) throw new Error("Trusted-local Boss accepted pause transition is not a valid monotonic projection");
      derivedPause = { version: TRUSTED_LOCAL_BOSS_PAUSE_VERSION, pauseRevision: transition.pauseRevision, transitionRevision: transition.revision, targets: transition.targets, intentionallyUnfrozenManagerWorkerId: transition.intentionallyUnfrozenManagerWorkerId, timers: transition.timers, authorizedBySessionId: transition.authorizedBySessionId, pausedAt: transition.completedAt! };
      nextPauseRevision += 1;
    } else {
      if (!derivedPause || transition.pauseRevision !== derivedPause.pauseRevision) throw new Error("Trusted-local Boss accepted resume transition does not match the current pause");
      derivedPause = null;
    }
  }
  const currentPause = legacyPause ? null : parseCurrentPause(value.currentPause);
  const migratedState = legacyPause && state === "paused" ? "active" : state as TrustedLocalBossRunState;
  if (JSON.stringify(currentPause) !== JSON.stringify(derivedPause) || (migratedState === "paused") !== Boolean(currentPause)) throw new Error("Trusted-local Boss current pause is not derived from accepted cgroup transitions");
  const pauseReconciliations = legacyPauseReconciliation ? [] : Array.isArray(value.pauseReconciliations) ? value.pauseReconciliations.map(parsePauseReconciliation) : (() => { throw new Error("Trusted-local Boss state contains invalid pause reconciliations"); })();
  if (pauseReconciliations.some((entry, index) => entry.revision !== index + 1 || !pauseTransitions.some((transition) => transition.phase === "accepted" && transition.action === "pause" && transition.pauseRevision === entry.pauseRevision && transition.revision === entry.transitionRevision))) throw new Error("Trusted-local Boss pause reconciliation does not bind an accepted pause transition");
  const derivedPauseDegradation = currentPause ? [...pauseReconciliations].reverse().find((entry) => entry.pauseRevision === currentPause.pauseRevision && entry.transitionRevision === currentPause.transitionRevision) ?? null : null;
  const currentPauseDegradation = legacyPauseReconciliation ? null : value.currentPauseDegradation === null ? null : parsePauseReconciliation(value.currentPauseDegradation);
  if (JSON.stringify(currentPauseDegradation) !== JSON.stringify(derivedPauseDegradation)) throw new Error("Trusted-local Boss current pause degradation is not derived from observed reconciliation evidence");
  return { version: TRUSTED_LOCAL_BOSS_RUN_VERSION, bossRunId, handle, goal, state: migratedState, managerSessionId, resource, acceptanceRevision, designRevision, freezeTransitions, currentFreeze, pauseTransitions, currentPause, pauseReconciliations, currentPauseDegradation, dynamicGrowthGrants, dynamicAssignments, assignments: parsedAssignments, deliveries: parsedDeliveries, assignmentResults: parsedResults, lifecycle: parsedLifecycle, proofPackets: parsedProofs, decisions: parsedDecisions, cancellation: parseCancellation(cancellation), createdAt: parseTimestamp(createdAt, "run createdAt"), updatedAt: parseTimestamp(updatedAt, "run updatedAt") };
}

function parseState(value: unknown, handlePrefix: string): TrustedLocalBossState {
  if (!isPlainRecord(value)) throw new Error("Trusted-local Boss state has an invalid top-level shape");
  const legacyVersion = typeof value.version === "string" && LEGACY_TRUSTED_LOCAL_BOSS_STORE_VERSIONS.has(value.version);
  const hasLegacyCurrent = value.version === "orc.boss-trusted-local.v1";
  const expectedKeys = hasLegacyCurrent ? ["currentRunId", "revision", "runs", "version"] : ["revision", "runs", "version"];
  if (!exactKeys(value, expectedKeys)) throw new Error("Trusted-local Boss state has an invalid top-level shape");
  if ((!legacyVersion && value.version !== TRUSTED_LOCAL_BOSS_STORE_VERSION) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 || !Array.isArray(value.runs)) throw new Error("Trusted-local Boss state has invalid metadata");
  const runs = value.runs.map((run) => parseRun(run, handlePrefix));
  const ids = new Set(runs.map((run) => run.bossRunId));
  const handles = new Set(runs.map((run) => run.handle));
  if (ids.size !== runs.length) throw new Error("Trusted-local Boss state contains duplicate run ids");
  if (handles.size !== runs.length) throw new Error("Trusted-local Boss state contains duplicate run handles");
  if (hasLegacyCurrent) {
    const currentRunId = value.currentRunId;
    if (currentRunId !== null && (typeof currentRunId !== "string" || !ids.has(currentRunId))) throw new Error("Trusted-local Boss legacy current run is invalid");
  }
  return { version: TRUSTED_LOCAL_BOSS_STORE_VERSION, revision: value.revision as number, runs };
}

function compareRunsForOwnedSummary(left: TrustedLocalBossRun, right: TrustedLocalBossRun): number {
  return right.createdAt.localeCompare(left.createdAt) || left.bossRunId.localeCompare(right.bossRunId);
}

function assignmentCommunication(run: TrustedLocalBossRun, assignment: TrustedLocalBossAssignment, now: string): TrustedLocalBossAssignmentCommunication {
  const observations = run.lifecycle.filter((entry) => entry.assignmentId === assignment.assignmentId);
  const latest = observations.at(-1);
  const observedCommunication = [...observations].reverse().find((entry) => entry.authenticatedIntercomActivityAt)?.authenticatedIntercomActivityAt ?? null;
  const common = {
    assignmentId: assignment.assignmentId,
    role: assignment.role,
    workerId: assignment.workerId,
    workerState: latest?.workerState ?? null,
    assignmentAcknowledgementEvidence: "unavailable" as const,
    assignmentAcknowledgedAt: null,
    substantiveCheckpointEvidence: "unavailable" as const,
    substantiveCheckpointObservedAt: null,
  };
  if (assignment.state !== "assigned" || !assignment.workerId) {
    return {
      ...common,
      transportProcessReadiness: latest ? "observed" : assignment.workerId ? "unavailable" : "not_launched",
      authenticatedCommunicationEvidence: observedCommunication ? "authenticated_intercom" : assignment.workerId ? "none_observed" : "unavailable",
      authenticatedCommunicationObservedAt: observedCommunication,
      authenticatedCommunicationDeadlineAt: null,
      communicationStatus: "not_assigned",
    };
  }
  const deadline = assignment.workerBoundAt
    ? new Date(Date.parse(assignment.workerBoundAt) + TRUSTED_LOCAL_BOSS_AUTHENTICATED_COMMUNICATION_DEADLINE_MS).toISOString()
    : null;
  const active = run.state === "active";
  return {
    ...common,
    transportProcessReadiness: latest ? "observed" : "unavailable",
    authenticatedCommunicationEvidence: observedCommunication ? "authenticated_intercom" : "none_observed",
    authenticatedCommunicationObservedAt: observedCommunication,
    authenticatedCommunicationDeadlineAt: deadline,
    communicationStatus: observedCommunication
      ? "authenticated_communication_observed"
      : !active
        ? "suspended"
        : deadline === null
          ? "deadline_unavailable"
          : Date.parse(now) >= Date.parse(deadline)
          ? "authenticated_communication_stale"
          : "awaiting_authenticated_communication",
  };
}

function runCommunication(run: TrustedLocalBossRun, now: string): TrustedLocalBossAssignmentCommunication[] {
  return run.assignments.map((assignment) => assignmentCommunication(run, assignment, now));
}

function runPendingDecision(run: TrustedLocalBossRun, now: string): TrustedLocalBossPendingDecision {
  const decision = (owner: TrustedLocalBossPendingDecisionOwner, reason: TrustedLocalBossPendingDecisionReason, detail: string, sourceObservedAt: string | null, target?: TrustedLocalBossAssignment): TrustedLocalBossPendingDecision => ({
    owner,
    reason,
    freshness: owner === "unavailable" ? "unavailable" : "current",
    targetRole: target?.role ?? null,
    assignmentId: target?.assignmentId ?? null,
    sourceObservedAt,
    derivedAt: now,
    detail,
  });
  if (run.cancellation?.state === "pending" || run.cancellation?.state === "failed") {
    return decision("controller", "cancellation_settlement", run.cancellation.state === "pending" ? "Controller must verify exact participant shutdown and canonical resource cleanup." : "Controller must explicitly retry or disposition failed participant shutdown and canonical resource cleanup.", run.cancellation.completedAt ?? run.cancellation.requestedAt);
  }
  if (run.currentPauseDegradation) return decision("controller", "pause_reconciliation", "Controller must reconcile exact cgroup thaw and WorkerStore timer restoration before terminal control can proceed.", run.currentPauseDegradation.observedAt);
  const applyingPause = run.pauseTransitions.at(-1);
  if (applyingPause?.phase === "applying") return decision("controller", "pause_reconciliation", `Controller must reconcile the exact applying ${applyingPause.action} transition before another lifecycle decision.`, applyingPause.occurredAt);
  if (TERMINAL_RUN_STATES.has(run.state)) return decision("none", "terminal", `Run is ${run.state}; no pending control decision is represented in persisted state.`, run.updatedAt);
  if (run.state === "paused") return decision("controller", "pause_disposition", "Controller owns the explicit resume, cancellation, or other disposition of this enforced pause.", run.currentPause?.pausedAt ?? run.updatedAt);
  const staffing = run.assignments.find((assignment) => assignment.state === "requested" || assignment.state === "failed");
  if (staffing) return decision("controller", "participant_staffing", `Controller must ${staffing.state === "failed" ? "retry or disposition" : "complete"} exact ${staffing.role} staffing revision ${staffing.revision}.`, staffing.updatedAt, staffing);
  const stale = runCommunication(run, now).find((entry) => entry.communicationStatus === "authenticated_communication_stale");
  if (stale) {
    const target = run.assignments.find((assignment) => assignment.assignmentId === stale.assignmentId)!;
    return decision(stale.role === "manager" ? "controller" : "manager", "authenticated_communication_stale", `${stale.role === "manager" ? "Controller" : "Manager"} must inspect the exact ${stale.role} communication deadline; authenticated traffic is communication evidence only, not proof of productivity.`, stale.authenticatedCommunicationDeadlineAt, target);
  }
  const proof = run.proofPackets.at(-1);
  if (proof && !run.decisions.length) {
    const delivery = run.deliveries.find((candidate) => candidate.kind === "proof-review" && candidate.proofPacketId === proof.proofPacketId);
    const result = delivery ? run.assignmentResults.find((candidate) => candidate.deliveryId === delivery.deliveryId) : undefined;
    if (delivery?.state === "delivered" && result?.outcome === "accepted") return decision("controller", "review_decision", `Controller must approve or reject exact advisory proof revision ${proof.revision}; authenticated delivery is not protected attestation.`, result.observedAt, run.assignments.find((assignment) => assignment.assignmentId === proof.reviewerAssignmentId));
  }
  return decision("unavailable", "unavailable", "No typed substantive checkpoint or blocker establishes a current decision owner. Process state and authenticated traffic are not used to infer productivity or next action.", null);
}

function formatRunList(runs: readonly TrustedLocalBossRun[], now: string): string {
  if (runs.length === 0) return `${TRUSTED_LOCAL_BOSS_WARNING}\n\nNo Boss runs are owned by this Controller.`;
  const entries = runs.map((run) => {
    const communicationStates = [...new Set(runCommunication(run, now).map((entry) => entry.communicationStatus))];
    const pendingDecision = runPendingDecision(run, now);
    return `- ${run.handle} (${run.bossRunId}) [${run.state}; communication=${communicationStates.join(",")}; pending-decision=${pendingDecision.owner}/${pendingDecision.reason}] ${run.goal}`;
  });
  return `${TRUSTED_LOCAL_BOSS_WARNING}\n\nOwned Boss runs (${runs.length}):\n${entries.join("\n")}\n\nWorker lifecycle is process/transport evidence only. Use /boss status <handle-or-exact-run-id> for details, including separate assignment acknowledgement, authenticated communication, substantive checkpoint, and unavailable telemetry fields; mutation results always include the exact run id.`;
}

function formatRun(run: TrustedLocalBossRun, now: string): string {
  const manager = run.assignments.find((assignment) => assignment.role === "manager")!;
  const reviewer = run.assignments.find((assignment) => assignment.role === "adversary");
  const latestProof = run.proofPackets.at(-1);
  const latestDecision = run.decisions.at(-1);
  const lifecycle = run.lifecycle.length ? run.lifecycle.slice(-8).map((entry) => `- ${entry.observedAt} ${entry.workerId} ${entry.workerState}${entry.detail ? ` — ${entry.detail}` : ""}`).join("\n") : "- no worker lifecycle observations recorded";
  const staffing = run.assignments.map((assignment) => `- ${assignment.role} revision ${assignment.revision}: ${assignment.state}; worker=${assignment.workerId ?? "not launched"}${assignment.lastError ? `; error=${assignment.lastError}` : ""}`).join("\n");
  const communication = runCommunication(run, now).map((entry) => {
    const transport = entry.workerState === null ? entry.transportProcessReadiness : `${entry.transportProcessReadiness} (${entry.workerState})`;
    const authenticated = entry.authenticatedCommunicationObservedAt ? `authenticated Intercom communication at ${entry.authenticatedCommunicationObservedAt}` : entry.authenticatedCommunicationEvidence.replaceAll("_", " ");
    return `- ${entry.role}: transport/process=${transport}; assignment-acknowledgement=${entry.assignmentAcknowledgementEvidence}; authenticated-communication=${authenticated}; substantive-checkpoint=${entry.substantiveCheckpointEvidence}; communication-status=${entry.communicationStatus.replaceAll("_", "-")}${entry.authenticatedCommunicationDeadlineAt ? `; communication-deadline=${entry.authenticatedCommunicationDeadlineAt}` : ""}`;
  }).join("\n");
  const latestDelivery = run.deliveries.at(-1);
  const pendingDecision = runPendingDecision(run, now);
  const resource = run.resource
    ? `resource: ${run.resource.resourceId} revision ${run.resource.revision}; path=${run.resource.path}; branch=${run.resource.branch}; base=${run.resource.baseSha}; HEAD=${run.resource.headSha}; existence=${run.resource.existence}; lease=${run.resource.leaseState} until ${run.resource.leaseExpiresAt}`
    : "resource: unavailable (this run predates or did not request a canonical worktree resource)";
  const freeze = run.currentFreeze
    ? `freeze: Controller-authorized advisory revision ${run.currentFreeze.freezeRevision}; fingerprint=${run.currentFreeze.fingerprint.aggregateSha256}; HEAD=${run.currentFreeze.fingerprint.headSha}; tracked-bytes=${run.currentFreeze.fingerprint.trackedDirtyBytes}; untracked-files=${run.currentFreeze.fingerprint.untrackedManifest.length}; acceptance/design/resource=${run.currentFreeze.acceptanceRevision}/${run.currentFreeze.designRevision}/${run.currentFreeze.resourceRevision}; authorized=${run.currentFreeze.authorizedBySessionId} at ${run.currentFreeze.authorizedAt}. This is not process suspension; trusted same-UID processes may still move files.`
    : `freeze: none; acceptance/design revisions=${run.acceptanceRevision ?? "unavailable"}/${run.designRevision ?? "unavailable"}`;
  const pause = run.currentPauseDegradation
    ? `pause-control: degraded revision ${run.currentPauseDegradation.pauseRevision}; enforcement is unavailable after reconciliation at ${run.currentPauseDegradation.observedAt}: ${run.currentPauseDegradation.detail}. No new Controller authorization is implied; terminal control remains fail-closed until exact thaw/timer restoration can be verified.`
    : run.currentPause
    ? `pause-control: enforced revision ${run.currentPause.pauseRevision}; frozen-units=${run.currentPause.targets.map((target) => target.unit).join(",") || "none"}; Manager=${run.currentPause.intentionallyUnfrozenManagerWorkerId ?? "unavailable"} intentionally unfrozen; WorkerStore timers suspended=${run.currentPause.timers.length}. systemd RuntimeMaxSec continues to elapse; trusted same-UID processes outside these exact units remain unattached.`
    : run.pauseTransitions.at(-1)?.phase === "applying"
      ? `pause-control: reconciliation required for ${run.pauseTransitions.at(-1)!.action} transition ${run.pauseTransitions.at(-1)!.actionId}; enforcement is unavailable until exact unit and timer reconciliation completes.`
      : "pause-control: not enforced; unattached same-UID processes are outside Boss control";
  return [TRUSTED_LOCAL_BOSS_WARNING, `handle: ${run.handle}`, `run: ${run.bossRunId}`, `state: ${run.state}`, `pending decision: owner=${pendingDecision.owner}; reason=${pendingDecision.reason}; freshness=${pendingDecision.freshness}; target-role=${pendingDecision.targetRole ?? "none"}; assignment=${pendingDecision.assignmentId ?? "none"}; source-observed=${pendingDecision.sourceObservedAt ?? "unavailable"}; derived=${pendingDecision.derivedAt}; detail=${pendingDecision.detail}`, pause, `goal: ${run.goal}`, `manager session: ${run.managerSessionId}`, resource, freeze, "readiness: WorkerStore lifecycle reports process/transport state only; it does not prove productive task activity.", "communication evidence: authenticated worker Intercom traffic proves communication only; assignment acknowledgement and substantive typed checkpoint telemetry are unavailable unless explicitly reported as separate fields.", "staffing:", staffing, "communication:", communication, `adversary assignment: ${reviewer ? `${reviewer.assignmentId} (${reviewer.state})` : "not requested"}`, `assignment delivery: ${latestDelivery ? `${latestDelivery.kind} ${latestDelivery.state} to ${latestDelivery.targetWorkerId} at revision ${latestDelivery.assignmentRevision}` : "none"}`, `assignment results: ${run.assignmentResults.length}`, `latest proof: ${latestProof ? `${latestProof.proofPacketId} revision ${latestProof.revision} sha256:${latestProof.snapshotSha256}` : "none"}`, `latest decision: ${latestDecision ? `${latestDecision.outcome} on proof revision ${latestDecision.proofRevision} — ${latestDecision.note}` : "none"}`, `cancellation: ${run.cancellation ? `${run.cancellation.state}${run.cancellation.error ? ` — ${run.cancellation.error}` : ""}` : "not requested"}`, `created: ${run.createdAt}`, `updated: ${run.updatedAt}`, "lifecycle:", lifecycle].join("\n");
}

function workerIncarnation(worker: WorkerRecord): string { return worker.workerIncarnationId ?? worker.runId; }
function authenticatedIntercomActivityTimestamp(worker: WorkerRecord): string | undefined {
  const value = worker.lastAuthenticatedIntercomActivityAt;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.valueOf()) ? undefined : timestamp.toISOString();
}
function assignmentForRole(run: TrustedLocalBossRun, role: TrustedLocalBossAssignmentRole): TrustedLocalBossAssignment { const assignment = run.assignments.find((candidate) => candidate.role === role); if (!assignment) throw new Error(`Trusted-local Boss ${role} assignment is unavailable`); return assignment; }
function assertOwningSession(run: TrustedLocalBossRun, managerSessionId: string): void { if (run.managerSessionId !== managerSessionId) throw new Error("Trusted-local Boss access requires the owning Controller session."); }
function isTerminalWorkerState(state: WorkerState): boolean { return state === "completed" || state === "failed" || state === "stopped" || state === "lost"; }
function expectedWorkerId(run: TrustedLocalBossRun, role: TrustedLocalBossAssignmentRole): string { return `boss-${role === "adversary" ? "adversary" : role}-${run.bossRunId.slice(-12)}`; }
function pruneOldestDeliveryPair(run: TrustedLocalBossRun): void { const removed = run.deliveries.shift(); if (!removed) return; const resultIndex = run.assignmentResults.findIndex((result) => result.deliveryId === removed.deliveryId); if (resultIndex >= 0) run.assignmentResults.splice(resultIndex, 1); }

function assertExactCurrentFreeze(run: TrustedLocalBossRun, fingerprintValue: BossCandidateFingerprint | undefined, action: string): { freeze: TrustedLocalBossFreeze; fingerprint: BossCandidateFingerprint } {
  if (!run.currentFreeze) throw new Error(`Trusted-local Boss ${action} requires a current Controller-authorized freeze.`);
  const fingerprint = parseCandidateFingerprint(structuredClone(fingerprintValue));
  const freeze = run.currentFreeze;
  if (!run.resource || run.resource.leaseState !== "active" || run.resource.existence !== "verified"
    || freeze.acceptanceRevision !== run.acceptanceRevision || freeze.designRevision !== run.designRevision || freeze.resourceRevision !== run.resource.revision
    || fingerprint.resourceId !== run.resource.resourceId || fingerprint.resourceRevision !== run.resource.revision || fingerprint.cwd !== run.resource.path
    || fingerprint.gitAdminDirectory !== run.resource.gitAdminDirectory || fingerprint.gitCommonDirectory !== run.resource.gitCommonDirectory
    || fingerprint.branch !== run.resource.branch || fingerprint.baseSha !== run.resource.baseSha
    || fingerprint.aggregateSha256 !== freeze.fingerprint.aggregateSha256) {
    throw new Error(`Trusted-local Boss ${action} found a stale freeze because the canonical candidate or bound revisions moved; explicitly unfreeze and authorize a new freeze.`);
  }
  return { freeze, fingerprint };
}

function proofDigest(run: TrustedLocalBossRun, reviewer: TrustedLocalBossAssignment): string {
  const manager = assignmentForRole(run, "manager");
  const proofDeliveryIds = new Set(run.deliveries.filter((delivery) => delivery.kind === "proof-review").map((delivery) => delivery.deliveryId));
  const snapshot = { bossRunId: run.bossRunId, goal: run.goal, state: run.state, currentFreeze: run.currentFreeze, assignments: run.assignments.map((assignment) => ({ ...assignment })), deliveries: run.deliveries.filter((delivery) => delivery.kind !== "proof-review").map((delivery) => ({ ...delivery })), assignmentResults: run.assignmentResults.filter((result) => !proofDeliveryIds.has(result.deliveryId)).map((result) => ({ ...result })), manager: { assignmentId: manager.assignmentId, state: manager.state, workerId: manager.workerId, workerIncarnationId: manager.workerIncarnationId, updatedAt: manager.updatedAt }, reviewer: { assignmentId: reviewer.assignmentId, state: reviewer.state, workerId: reviewer.workerId, workerIncarnationId: reviewer.workerIncarnationId, updatedAt: reviewer.updatedAt }, lifecycle: run.lifecycle.map((entry) => ({ ...entry })) };
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

export class TrustedLocalBossStore {
  readonly path: string;
  private readonly now: () => Date;
  private handlePrefix: string;
  constructor(path: string, now: () => Date = () => new Date(), handlePrefix = "boss") { this.path = path; this.now = now; this.handlePrefix = handlePrefix; this.setHandlePrefix(handlePrefix); }
  setHandlePrefix(prefix: string): void { if (!BOSS_HANDLE_PREFIX.test(prefix)) throw new Error("Trusted-local Boss handle prefix is invalid"); this.handlePrefix = prefix; }

  private async readState(): Promise<TrustedLocalBossState> { try { return parseState(JSON.parse(await readFile(this.path, "utf8")), this.handlePrefix); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return initialState(); throw error; } }
  private async writeState(state: TrustedLocalBossState): Promise<void> { await mkdir(dirname(this.path), { recursive: true, mode: 0o700 }); const temp = `${this.path}.tmp-${process.pid}-${randomUUID()}`; try { await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" }); await rename(temp, this.path); } finally { await rm(temp, { force: true }).catch(() => undefined); } }
  private async mutate<T>(operation: (state: TrustedLocalBossState, timestamp: string) => T | Promise<T>): Promise<T> { await mkdir(dirname(this.path), { recursive: true, mode: 0o700 }); const release = await acquireKernelFileLock(`${this.path}.lock`, 5_000); try { const state = await this.readState(); const before = JSON.stringify(state); const result = await operation(state, canonicalTimestamp(this.now)); parseState(structuredClone(state), this.handlePrefix); if (JSON.stringify(state) !== before) await this.writeState(state); return result; } finally { await release(); } }

  async createProvisionedRun(input: { bossRunId: string; goal: string; managerSessionId: string; resource: TrustedLocalBossResource }): Promise<TrustedLocalBossResult> {
    return this.mutate((state, timestamp) => {
      if (!/^boss-[0-9a-f-]{36}$/.test(input.bossRunId)) throw new Error("Trusted-local Boss provisioned run id is invalid");
      if (!input.goal || input.goal.length > MAX_GOAL_LENGTH) throw new Error(`Trusted-local Boss goal must be 1-${MAX_GOAL_LENGTH} characters.`);
      if (state.runs.some((candidate) => candidate.bossRunId === input.bossRunId)) throw new Error("Trusted-local Boss provisioned run id already exists");
      const resource = parseResource(structuredClone(input.resource), input.bossRunId);
      if (!resource || resource.revision !== 1 || resource.leaseState !== "active" || resource.existence !== "verified") throw new Error("Trusted-local Boss provisioned run requires a verified active revision-1 resource");
      const assignment = (role: "manager" | "worker" | "scout", task: string): TrustedLocalBossAssignment => ({ assignmentId: `assignment-${randomUUID()}`, role, task, revision: 1, resourceRevision: resource.revision, state: "requested", workerId: null, workerIncarnationId: null, createdAt: timestamp, updatedAt: timestamp });
      const assignments = [assignment("manager", `Manage the trusted-local Boss goal: ${input.goal}`), assignment("worker", `Implement the highest-priority bounded work for: ${input.goal}`), assignment("scout", `Scout risks, dependencies, and verification gaps for: ${input.goal}`)];
      const handle = deterministicBossRunHandle(input.bossRunId, this.handlePrefix);
      if (state.runs.some((candidate) => candidate.handle === handle)) throw new Error("Trusted-local Boss deterministic handle collision; no run was created");
      const run: TrustedLocalBossRun = { version: TRUSTED_LOCAL_BOSS_RUN_VERSION, bossRunId: input.bossRunId, handle, goal: input.goal, state: "active", managerSessionId: input.managerSessionId, resource, acceptanceRevision: 1, designRevision: 1, freezeTransitions: [], currentFreeze: null, pauseTransitions: [], currentPause: null, pauseReconciliations: [], currentPauseDegradation: null, dynamicGrowthGrants: [], dynamicAssignments: [], assignments, deliveries: [], assignmentResults: [], lifecycle: [], proofPackets: [], decisions: [], cancellation: null, createdAt: timestamp, updatedAt: timestamp };
      state.runs.push(run);
      state.revision += 1;
      return { title: "Boss trusted-local run created", message: formatRun(run, timestamp), run: structuredClone(run) };
    });
  }

  async authorizeDynamicGrowth(input: {
    bossRunId: string;
    managerSessionId: string;
    participantRole: TrustedLocalBossAssignmentRole;
    participantWorkerId: string;
    participantWorkerIncarnationId: string;
    expectedAcceptanceRevision: number;
    expectedDesignRevision: number;
    delegationGrant: DelegationGrantV1;
  }): Promise<TrustedLocalBossResult> {
    return this.mutate((state, timestamp) => {
      const run = state.runs.find((candidate) => candidate.bossRunId === input.bossRunId || candidate.handle === input.bossRunId);
      if (!run) throw new Error("No matching trusted-local Boss run exists.");
      assertOwningSession(run, input.managerSessionId);
      if (run.state !== "active" || run.currentPause || run.currentFreeze || run.cancellation) throw new Error("Trusted-local Boss dynamic growth requires an active, unpaused, unfrozen, non-cancelling run.");
      if (run.acceptanceRevision !== input.expectedAcceptanceRevision || run.designRevision !== input.expectedDesignRevision) throw new Error("Trusted-local Boss dynamic growth revisions are stale.");
      const assignment = assignmentForRole(run, input.participantRole);
      if (assignment.state !== "assigned" || assignment.workerId !== input.participantWorkerId || assignment.workerIncarnationId !== input.participantWorkerIncarnationId) {
        throw new Error("Trusted-local Boss dynamic growth participant identity does not match the exact assigned incarnation.");
      }
      const delegationGrant = parseDelegationGrant(structuredClone(input.delegationGrant), "boss.dynamicGrowthGrant.delegationGrant");
      if (delegationGrant.issuedByWorkerIncarnationId !== input.participantWorkerIncarnationId) {
        throw new Error("Trusted-local Boss dynamic growth grant issuer must match the exact participant incarnation.");
      }
      const previous = [...run.dynamicGrowthGrants].reverse().find((candidate) => candidate.participantWorkerIncarnationId === input.participantWorkerIncarnationId);
      if (previous) assertDelegationGrantSubset(previous.delegationGrant, delegationGrant);
      const existingAssignments = run.dynamicAssignments.filter((candidate) => candidate.state === "active" && candidate.parentWorkerIncarnationId === input.participantWorkerIncarnationId);
      if (existingAssignments.length > delegationGrant.maxLiveDirectChildren || existingAssignments.length > delegationGrant.maxLiveDescendants) {
        throw new Error("Trusted-local Boss dynamic growth grant cannot narrow below existing dynamic assignments.");
      }
      const active = run.dynamicGrowthGrants.find((candidate) => candidate.state === "active" && candidate.participantWorkerIncarnationId === input.participantWorkerIncarnationId);
      if (active) {
        active.state = "revoked";
        active.revokedBySessionId = input.managerSessionId;
        active.revokedAt = timestamp;
      }
      const grant: TrustedLocalBossDynamicGrowthGrant = {
        version: "orc.boss-dynamic-growth-grant.v1",
        revision: run.dynamicGrowthGrants.length + 1,
        bossRunId: run.bossRunId,
        participantRole: input.participantRole,
        participantWorkerId: input.participantWorkerId,
        participantWorkerIncarnationId: input.participantWorkerIncarnationId,
        acceptanceRevision: input.expectedAcceptanceRevision,
        designRevision: input.expectedDesignRevision,
        delegationGrant,
        state: "active",
        authorizedBySessionId: input.managerSessionId,
        authorizedAt: timestamp,
      };
      run.dynamicGrowthGrants.push(grant);
      run.updatedAt = timestamp;
      state.revision += 1;
      return { title: "Boss dynamic growth authorized", message: formatRun(run, timestamp), run: structuredClone(run) };
    });
  }

  async reserveDynamicAssignment(input: {
    bossRunId: string;
    managerSessionId: string;
    expectedGrowthGrantRevision: number;
    parentWorkerIncarnationId: string;
    workerId: string;
    workerIncarnationId: string;
  }): Promise<TrustedLocalBossResult> {
    return this.mutate((state, timestamp) => {
      const run = state.runs.find((candidate) => candidate.bossRunId === input.bossRunId || candidate.handle === input.bossRunId);
      if (!run) throw new Error("No matching trusted-local Boss run exists.");
      assertOwningSession(run, input.managerSessionId);
      if (run.state !== "active" || run.currentPause || run.currentFreeze || run.cancellation) throw new Error("Trusted-local Boss dynamic assignment requires an active, unpaused, unfrozen, non-cancelling run.");
      const grant = run.dynamicGrowthGrants.find((candidate) => candidate.revision === input.expectedGrowthGrantRevision);
      if (!grant || grant.state !== "active") throw new Error("Trusted-local Boss dynamic growth grant revision is stale or inactive.");
      if (grant.participantWorkerIncarnationId !== input.parentWorkerIncarnationId) throw new Error("Trusted-local Boss dynamic assignment parent does not match the authorized participant incarnation.");
      if (run.dynamicAssignments.some((candidate) => candidate.workerId === input.workerId || candidate.workerIncarnationId === input.workerIncarnationId)) throw new Error("Trusted-local Boss dynamic assignment identity already exists.");
      const directAssignments = run.dynamicAssignments.filter((candidate) => candidate.state === "active" && candidate.parentWorkerIncarnationId === input.parentWorkerIncarnationId);
      if (directAssignments.length >= grant.delegationGrant.maxLiveDirectChildren || directAssignments.length >= grant.delegationGrant.maxLiveDescendants) {
        throw new Error("Trusted-local Boss dynamic assignment exceeds the active growth grant budget.");
      }
      run.dynamicAssignments.push({
        workerId: input.workerId,
        workerIncarnationId: input.workerIncarnationId,
        parentWorkerIncarnationId: input.parentWorkerIncarnationId,
        grantId: grant.delegationGrant.grantId,
        growthGrantRevision: grant.revision,
        state: "active",
        createdAt: timestamp,
      });
      run.updatedAt = timestamp;
      state.revision += 1;
      return { title: "Boss dynamic assignment reserved", message: formatRun(run, timestamp), run: structuredClone(run) };
    });
  }

  async releaseDynamicAssignment(input: {
    bossRunId: string;
    managerSessionId: string;
    workerIncarnationId: string;
    releaseReason: "launch-failed" | "terminal" | "forgotten";
  }): Promise<TrustedLocalBossResult> {
    return this.mutate((state, timestamp) => {
      const run = state.runs.find((candidate) => candidate.bossRunId === input.bossRunId || candidate.handle === input.bossRunId);
      if (!run) throw new Error("No matching trusted-local Boss run exists.");
      assertOwningSession(run, input.managerSessionId);
      const assignment = run.dynamicAssignments.find((candidate) => candidate.workerIncarnationId === input.workerIncarnationId);
      if (!assignment || assignment.state !== "active") throw new Error("Trusted-local Boss dynamic assignment is stale or inactive.");
      assignment.state = "released";
      assignment.releasedAt = timestamp;
      assignment.releaseReason = input.releaseReason;
      run.updatedAt = timestamp;
      state.revision += 1;
      return { title: "Boss dynamic assignment released", message: formatRun(run, timestamp), run: structuredClone(run) };
    });
  }

  async revokeDynamicGrowth(input: { bossRunId: string; managerSessionId: string; expectedGrowthGrantRevision: number }): Promise<TrustedLocalBossResult> {
    return this.mutate((state, timestamp) => {
      const run = state.runs.find((candidate) => candidate.bossRunId === input.bossRunId || candidate.handle === input.bossRunId);
      if (!run) throw new Error("No matching trusted-local Boss run exists.");
      assertOwningSession(run, input.managerSessionId);
      if (run.state !== "active" || run.currentPause || run.currentFreeze || run.cancellation) throw new Error("Trusted-local Boss dynamic growth revocation requires an active, unpaused, unfrozen, non-cancelling run.");
      const grant = run.dynamicGrowthGrants.find((candidate) => candidate.revision === input.expectedGrowthGrantRevision);
      if (!grant || grant.state !== "active") throw new Error("Trusted-local Boss dynamic growth grant revision is stale or inactive.");
      grant.state = "revoked";
      grant.revokedBySessionId = input.managerSessionId;
      grant.revokedAt = timestamp;
      run.updatedAt = timestamp;
      state.revision += 1;
      return { title: "Boss dynamic growth revoked", message: formatRun(run, timestamp), run: structuredClone(run) };
    });
  }

  async recordProvisionedResource(bossRunId: string, resourceValue: TrustedLocalBossResource): Promise<TrustedLocalBossRun> {
    return this.mutate((state, timestamp) => {
      const run = state.runs.find((candidate) => candidate.bossRunId === bossRunId);
      if (!run) throw new Error(`Trusted-local Boss run not found: ${bossRunId}`);
      if (TERMINAL_RUN_STATES.has(run.state)) throw new Error(`Trusted-local Boss resource cannot be attached after run ${run.state}`);
      if (run.resource) throw new Error("Trusted-local Boss run already has a canonical resource");
      const resource = parseResource(structuredClone(resourceValue), bossRunId);
      if (!resource || resource.revision !== 1 || resource.leaseState !== "active" || resource.existence !== "verified") {
        throw new Error("Trusted-local Boss initial canonical resource must be verified at active revision 1");
      }
      run.resource = resource;
      if (run.acceptanceRevision === null && run.designRevision === null) {
        run.acceptanceRevision = 1;
        run.designRevision = 1;
      }
      for (const assignment of run.assignments) assignment.resourceRevision = resource.revision;
      run.updatedAt = timestamp;
      state.revision += 1;
      return structuredClone(run);
    });
  }

  async recordResourceTransition(bossRunId: string, expectedRevision: number, resourceValue: TrustedLocalBossResource): Promise<TrustedLocalBossRun> {
    return this.mutate((state, timestamp) => {
      const run = state.runs.find((candidate) => candidate.bossRunId === bossRunId);
      if (!run?.resource) throw new Error(`Trusted-local Boss canonical resource not found: ${bossRunId}`);
      const previous = run.resource;
      if (previous.revision !== expectedRevision) throw new Error(`Trusted-local Boss resource revision conflict: expected ${expectedRevision}, found ${previous.revision}`);
      const resource = parseResource(structuredClone(resourceValue), bossRunId);
      if (!resource || resource.revision !== previous.revision + 1) throw new Error("Trusted-local Boss resource revision must advance exactly once");
      for (const field of ["version", "resourceId", "kind", "path", "gitAdminDirectory", "gitCommonDirectory", "branch", "baseSha", "leaseOwnerBossRunId", "leaseAcquiredAt"] as const) {
        if (resource[field] !== previous[field]) throw new Error(`Trusted-local Boss resource ${field} is immutable`);
      }
      if (previous.leaseState === "released") throw new Error("Trusted-local Boss released resource is terminal");
      if (previous.leaseState === "cleanup_failed" && resource.leaseState === "active") throw new Error("Trusted-local Boss cleanup-failed resource cannot reactivate");
      if (resource.leaseState === "active" && Date.parse(resource.leaseExpiresAt) <= Date.parse(previous.leaseExpiresAt)) throw new Error("Trusted-local Boss active lease refresh must extend expiry monotonically");
      run.resource = resource;
      for (const assignment of run.assignments) assignment.resourceRevision = resource.revision;
      run.updatedAt = timestamp;
      state.revision += 1;
      return structuredClone(run);
    });
  }

  async authorizeFreeze(input: {
    bossRunId: string;
    managerSessionId: string;
    expectedAcceptanceRevision: number;
    expectedDesignRevision: number;
    fingerprint: BossCandidateFingerprint;
  }): Promise<TrustedLocalBossResult> {
    return this.mutate((state, timestamp) => {
      const run = state.runs.find((candidate) => candidate.bossRunId === input.bossRunId || candidate.handle === input.bossRunId);
      if (!run) throw new Error("No matching trusted-local Boss run exists.");
      assertOwningSession(run, input.managerSessionId);
      const fingerprint = parseCandidateFingerprint(structuredClone(input.fingerprint));
      const transitionRevision = run.freezeTransitions.length + 1;
      const rejection = (reason: string): TrustedLocalBossResult => {
        const transition: TrustedLocalBossFreezeTransition = { version: TRUSTED_LOCAL_BOSS_FREEZE_TRANSITION_VERSION, actionId: `freeze-action-${randomUUID()}`, revision: transitionRevision, action: "freeze", outcome: "rejected", authorizedBySessionId: input.managerSessionId, acceptanceRevision: input.expectedAcceptanceRevision, designRevision: input.expectedDesignRevision, resourceRevision: fingerprint.resourceRevision, freezeRevision: null, fingerprint, reason: reason.slice(0, 4_096), occurredAt: timestamp };
        run.freezeTransitions.push(transition); run.updatedAt = timestamp; state.revision += 1;
        return { title: "Boss freeze rejected", message: `${formatRun(run, timestamp)}\n\nFreeze rejected: ${transition.reason}`, run: structuredClone(run), freezeTransition: structuredClone(transition) };
      };
      if (run.state !== "active" && run.state !== "paused") return rejection(`run state ${run.state} is not freezable`);
      if (!run.resource || run.resource.leaseState !== "active" || run.resource.existence !== "verified") return rejection("an active verified canonical resource is required");
      if (run.acceptanceRevision === null || run.designRevision === null) return rejection("acceptance/design revisions are unavailable");
      if (input.expectedAcceptanceRevision !== run.acceptanceRevision || input.expectedDesignRevision !== run.designRevision) return rejection(`expected acceptance/design ${input.expectedAcceptanceRevision}/${input.expectedDesignRevision} is superseded by ${run.acceptanceRevision}/${run.designRevision}`);
      if (fingerprint.resourceId !== run.resource.resourceId || fingerprint.resourceRevision !== run.resource.revision || fingerprint.cwd !== run.resource.path || fingerprint.gitAdminDirectory !== run.resource.gitAdminDirectory || fingerprint.gitCommonDirectory !== run.resource.gitCommonDirectory || fingerprint.branch !== run.resource.branch || fingerprint.baseSha !== run.resource.baseSha) return rejection("candidate fingerprint is not bound to the exact current canonical resource revision and identity");
      if (run.currentFreeze) {
        const current = run.currentFreeze;
        if (current.acceptanceRevision === run.acceptanceRevision && current.designRevision === run.designRevision && current.resourceRevision === run.resource.revision && current.fingerprint.aggregateSha256 === fingerprint.aggregateSha256) {
          return { title: "Boss candidate already frozen", message: formatRun(run, timestamp), run: structuredClone(run), freezeTransition: structuredClone(run.freezeTransitions[current.transitionRevision - 1]) };
        }
        return rejection("a current freeze already exists and must be explicitly unfrozen");
      }
      const freezeRevision = run.freezeTransitions.filter((transition) => transition.action === "freeze" && transition.outcome === "accepted").length + 1;
      const transition: TrustedLocalBossFreezeTransition = { version: TRUSTED_LOCAL_BOSS_FREEZE_TRANSITION_VERSION, actionId: `freeze-action-${randomUUID()}`, revision: transitionRevision, action: "freeze", outcome: "accepted", authorizedBySessionId: input.managerSessionId, acceptanceRevision: run.acceptanceRevision, designRevision: run.designRevision, resourceRevision: run.resource.revision, freezeRevision, fingerprint, reason: null, occurredAt: timestamp };
      run.freezeTransitions.push(transition);
      run.currentFreeze = { version: TRUSTED_LOCAL_BOSS_FREEZE_VERSION, freezeRevision, transitionRevision, acceptanceRevision: run.acceptanceRevision, designRevision: run.designRevision, resourceRevision: run.resource.revision, fingerprint, authorizedBySessionId: input.managerSessionId, authorizedAt: timestamp };
      run.updatedAt = timestamp; state.revision += 1;
      return { title: "Boss candidate frozen", message: formatRun(run, timestamp), run: structuredClone(run), freezeTransition: structuredClone(transition) };
    });
  }

  async authorizeUnfreeze(input: {
    bossRunId: string;
    managerSessionId: string;
    expectedFreezeRevision: number;
    expectedFingerprintSha256: string;
    fingerprint: BossCandidateFingerprint;
  }): Promise<TrustedLocalBossResult> {
    return this.mutate((state, timestamp) => {
      const run = state.runs.find((candidate) => candidate.bossRunId === input.bossRunId || candidate.handle === input.bossRunId);
      if (!run) throw new Error("No matching trusted-local Boss run exists.");
      assertOwningSession(run, input.managerSessionId);
      const fingerprint = parseCandidateFingerprint(structuredClone(input.fingerprint));
      const transitionRevision = run.freezeTransitions.length + 1;
      const current = run.currentFreeze;
      const acceptanceRevision = current?.acceptanceRevision ?? run.acceptanceRevision ?? 1;
      const designRevision = current?.designRevision ?? run.designRevision ?? 1;
      const resourceRevision = current?.resourceRevision ?? fingerprint.resourceRevision;
      const rejection = (reason: string): TrustedLocalBossResult => {
        const transition: TrustedLocalBossFreezeTransition = { version: TRUSTED_LOCAL_BOSS_FREEZE_TRANSITION_VERSION, actionId: `freeze-action-${randomUUID()}`, revision: transitionRevision, action: "unfreeze", outcome: "rejected", authorizedBySessionId: input.managerSessionId, acceptanceRevision, designRevision, resourceRevision, freezeRevision: input.expectedFreezeRevision, fingerprint, reason: reason.slice(0, 4_096), occurredAt: timestamp };
        run.freezeTransitions.push(transition); run.updatedAt = timestamp; state.revision += 1;
        return { title: "Boss unfreeze rejected", message: `${formatRun(run, timestamp)}\n\nUnfreeze rejected: ${transition.reason}`, run: structuredClone(run), freezeTransition: structuredClone(transition) };
      };
      if (!current) return rejection("no current Controller-authorized freeze exists");
      if (input.expectedFreezeRevision !== current.freezeRevision || input.expectedFingerprintSha256 !== current.fingerprint.aggregateSha256) return rejection("expected freeze revision or fingerprint is stale");
      if (fingerprint.aggregateSha256 !== current.fingerprint.aggregateSha256) return rejection("candidate moved after freeze; stale freeze cannot be silently refreshed");
      const transition: TrustedLocalBossFreezeTransition = { version: TRUSTED_LOCAL_BOSS_FREEZE_TRANSITION_VERSION, actionId: `freeze-action-${randomUUID()}`, revision: transitionRevision, action: "unfreeze", outcome: "accepted", authorizedBySessionId: input.managerSessionId, acceptanceRevision: current.acceptanceRevision, designRevision: current.designRevision, resourceRevision: current.resourceRevision, freezeRevision: current.freezeRevision, fingerprint, reason: null, occurredAt: timestamp };
      run.freezeTransitions.push(transition); run.currentFreeze = null; run.updatedAt = timestamp; state.revision += 1;
      return { title: "Boss candidate unfrozen", message: formatRun(run, timestamp), run: structuredClone(run), freezeTransition: structuredClone(transition) };
    });
  }

  async beginPauseControl(input: {
    bossRunId: string;
    managerSessionId: string;
    action: "pause" | "resume";
    targets: TrustedLocalBossPauseTarget[];
    intentionallyUnfrozenManagerWorkerId: string | null;
    timers: TrustedLocalBossPausedTimer[];
  }): Promise<TrustedLocalBossPauseTransition> {
    return this.mutate((state, timestamp) => {
      const run = state.runs.find((candidate) => candidate.bossRunId === input.bossRunId || candidate.handle === input.bossRunId);
      if (!run) throw new Error("No matching trusted-local Boss run exists.");
      assertOwningSession(run, input.managerSessionId);
      if (run.pauseTransitions.at(-1)?.phase === "applying") throw new Error("Trusted-local Boss pause control already has an unreconciled applying transition");
      if (input.action === "pause" && (run.state !== "active" || run.currentPause)) throw new Error(`Cannot pause Boss run from ${run.state}.`);
      if (input.action === "resume" && (run.state !== "paused" || !run.currentPause)) throw new Error(`Cannot resume Boss run from ${run.state}.`);
      const targets = input.targets.map(parsePauseTarget);
      const timers = input.timers.map(parsePausedTimer);
      if (input.action === "resume" && (JSON.stringify(targets) !== JSON.stringify(run.currentPause!.targets) || JSON.stringify(timers) !== JSON.stringify(run.currentPause!.timers))) throw new Error("Trusted-local Boss resume must use the exact current pause identities and suspended timers");
      const pauseRevision = input.action === "pause" ? run.pauseTransitions.filter((transition) => transition.action === "pause" && transition.phase === "accepted").length + 1 : run.currentPause!.pauseRevision;
      const transition: TrustedLocalBossPauseTransition = { version: TRUSTED_LOCAL_BOSS_PAUSE_TRANSITION_VERSION, actionId: `pause-action-${randomUUID()}`, revision: run.pauseTransitions.length + 1, action: input.action, phase: "applying", authorizedBySessionId: input.managerSessionId, pauseRevision, targets, intentionallyUnfrozenManagerWorkerId: input.intentionallyUnfrozenManagerWorkerId, timers, settledTargets: [], reason: null, occurredAt: timestamp, completedAt: null };
      run.pauseTransitions.push(transition); run.updatedAt = timestamp; state.revision += 1;
      return structuredClone(transition);
    });
  }

  async applyingPauseControls(): Promise<Array<{ run: TrustedLocalBossRun; transition: TrustedLocalBossPauseTransition }>> {
    const state = await this.readState();
    return state.runs.flatMap((run) => {
      const transition = run.pauseTransitions.at(-1);
      return transition?.phase === "applying" ? [{ run: structuredClone(run), transition: structuredClone(transition) }] : [];
    });
  }

  async acceptedPauseControls(): Promise<TrustedLocalBossRun[]> {
    const state = await this.readState();
    return state.runs.filter((run) => run.currentPause && !run.currentPauseDegradation).map((run) => structuredClone(run));
  }

  /** Exact WorkerStore incarnations whose lifecycle budgets are fenced by a durable pause intent. */
  async pauseProtectedWorkerKeys(): Promise<string[]> {
    const state = await this.readState();
    const keys = new Set<string>();
    for (const run of state.runs) {
      for (const target of run.currentPause?.targets ?? []) keys.add(`${target.workerId}\0${target.workerIncarnationId}`);
      const applying = run.pauseTransitions.at(-1);
      if (applying?.phase === "applying") {
        for (const target of applying.targets) keys.add(`${target.workerId}\0${target.workerIncarnationId}`);
      }
    }
    return [...keys];
  }

  async recordPauseDegradation(bossRunId: string, pauseRevision: number, transitionRevision: number, detail: string): Promise<TrustedLocalBossRun> {
    return this.mutate((state, timestamp) => {
      const run = state.runs.find((candidate) => candidate.bossRunId === bossRunId);
      if (!run?.currentPause || run.currentPause.pauseRevision !== pauseRevision || run.currentPause.transitionRevision !== transitionRevision) throw new Error("Trusted-local Boss pause degradation does not match the exact current accepted pause");
      if (run.currentPauseDegradation) return structuredClone(run);
      const entry: TrustedLocalBossPauseReconciliation = { version: TRUSTED_LOCAL_BOSS_PAUSE_RECONCILIATION_VERSION, reconciliationId: `pause-reconciliation-${randomUUID()}`, revision: run.pauseReconciliations.length + 1, pauseRevision, transitionRevision, outcome: "degraded", detail: detail.slice(0, 4_096) || "Accepted Boss pause enforcement became unverifiable", observedAt: timestamp };
      run.pauseReconciliations.push(entry); run.currentPauseDegradation = entry; run.updatedAt = timestamp; state.revision += 1;
      return structuredClone(run);
    });
  }

  async finishPauseControl(bossRunId: string, actionId: string, error?: unknown, settledTargets: TrustedLocalBossPauseSettledTarget[] = []): Promise<TrustedLocalBossResult> {
    return this.mutate((state, timestamp) => {
      const run = state.runs.find((candidate) => candidate.bossRunId === bossRunId);
      if (!run) throw new Error(`Trusted-local Boss run not found: ${bossRunId}`);
      const transition = run.pauseTransitions.at(-1);
      if (!transition || transition.actionId !== actionId || transition.phase !== "applying") throw new Error("Trusted-local Boss pause control completion does not match the exact applying transition");
      const parsedSettledTargets = settledTargets.map(parsePauseSettledTarget);
      const transitionTargetKeys = new Set(transition.targets.map((target) => `${target.workerId}\0${target.workerIncarnationId}`));
      if (new Set(parsedSettledTargets.map((target) => `${target.workerId}\0${target.workerIncarnationId}`)).size !== parsedSettledTargets.length
        || parsedSettledTargets.some((target) => !transitionTargetKeys.has(`${target.workerId}\0${target.workerIncarnationId}`))
        || parsedSettledTargets.length > 0 && (transition.action !== "resume" || error !== undefined)) throw new Error("Trusted-local Boss pause completion contains invalid settled targets");
      transition.completedAt = timestamp;
      transition.settledTargets = parsedSettledTargets;
      if (error !== undefined) {
        transition.phase = "failed";
        transition.reason = (error instanceof Error ? error.message : String(error)).slice(0, 4_096) || "Boss cgroup pause control failed";
      } else {
        transition.phase = "accepted";
        if (transition.action === "pause") {
          run.currentPause = { version: TRUSTED_LOCAL_BOSS_PAUSE_VERSION, pauseRevision: transition.pauseRevision, transitionRevision: transition.revision, targets: transition.targets, intentionallyUnfrozenManagerWorkerId: transition.intentionallyUnfrozenManagerWorkerId, timers: transition.timers, authorizedBySessionId: transition.authorizedBySessionId, pausedAt: timestamp };
          run.state = "paused";
        } else {
          run.currentPause = null;
          run.currentPauseDegradation = null;
          run.state = "active";
        }
      }
      run.updatedAt = timestamp; state.revision += 1;
      return { title: `Boss trusted-local run ${transition.phase === "accepted" ? transition.action === "pause" ? "paused" : "resumed" : `${transition.action} failed`}`, message: formatRun(run, timestamp), run: structuredClone(run), pauseTransition: structuredClone(transition) };
    });
  }

  async protectedResourcePaths(): Promise<string[]> {
    const state = await this.readState();
    return [...new Set(state.runs
      .map((run) => run.resource)
      .filter((resource): resource is TrustedLocalBossResource => Boolean(resource && resource.existence === "verified"))
      .map((resource) => resource.path))].sort();
  }

  private async recordAssignmentStarted(bossRunId: string, role: TrustedLocalBossAssignmentRole, worker: WorkerRecord): Promise<TrustedLocalBossRun> {
    return this.mutate((state, timestamp) => {
      const run = state.runs.find((candidate) => candidate.bossRunId === bossRunId);
      if (!run) throw new Error(`Trusted-local Boss run not found: ${bossRunId}`);
      if (TERMINAL_RUN_STATES.has(run.state)) throw new Error(`Trusted-local Boss ${role} assignment cannot start after run ${run.state}`);
      if (!worker.owned || worker.bossRunId !== run.bossRunId || worker.managerSessionId !== run.managerSessionId || worker.id !== expectedWorkerId(run, role)) {
        throw new Error(`Trusted-local Boss ${role} worker identity, ownership, or run binding does not match ${bossRunId}`);
      }
      const assignment = assignmentForRole(run, role);
      const incarnation = workerIncarnation(worker);
      if (assignment.state === "assigned" && assignment.workerId === worker.id && assignment.workerIncarnationId === incarnation) return structuredClone(run);
      if (assignment.state !== "requested") throw new Error(`Trusted-local Boss ${role} assignment is already ${assignment.state}`);
      assignment.state = "assigned";
      assignment.workerId = worker.id;
      assignment.workerIncarnationId = incarnation;
      assignment.workerBoundAt = timestamp;
      assignment.updatedAt = timestamp;
      while (run.deliveries.length >= 256) pruneOldestDeliveryPair(run);
      const deliveryId = `delivery-${randomUUID()}`;
      run.deliveries.push({ deliveryId, assignmentId: assignment.assignmentId, assignmentRevision: assignment.revision, kind: "launch-mandate", state: "delivered", targetWorkerId: worker.id, attemptedAt: timestamp, completedAt: timestamp });
      run.assignmentResults.push({ resultId: `result-${randomUUID()}`, deliveryId, assignmentId: assignment.assignmentId, assignmentRevision: assignment.revision, outcome: "accepted", observedAt: timestamp, detail: `${role} launch mandate accepted by ordinary agent_fleet readiness` });
      run.updatedAt = timestamp;
      const activityBaseline = authenticatedIntercomActivityTimestamp(worker);
      run.lifecycle.push({ observationId: `observation-${randomUUID()}`, assignmentId: assignment.assignmentId, workerId: worker.id, workerIncarnationId: incarnation, workerState: worker.state, observedAt: timestamp, ...(activityBaseline ? { authenticatedIntercomBaselineAt: activityBaseline } : {}), detail: `${role} launch recorded from ordinary agent_fleet state` });
      if (run.lifecycle.length > 256) run.lifecycle.splice(0, run.lifecycle.length - 256);
      state.revision += 1;
      return structuredClone(run);
    });
  }

  async recoverRequestedWorkerBindings(workers: readonly WorkerRecord[]): Promise<boolean> {
    const state = await this.readState();
    const recoveries = state.runs
      .filter((run) => run.state === "active" || run.state === "paused")
      .flatMap((run) => run.assignments
      .filter((assignment) => assignment.state === "requested")
      .map((assignment) => ({ run, assignment, worker: workers.find((candidate) => candidate.id === expectedWorkerId(run, assignment.role)
        && candidate.owned
        && candidate.bossRunId === run.bossRunId
        && candidate.managerSessionId === run.managerSessionId
        && !isTerminalWorkerState(candidate.state)) }))
      .filter((entry): entry is { run: TrustedLocalBossRun; assignment: TrustedLocalBossAssignment; worker: WorkerRecord } => Boolean(entry.worker)));
    let changed = false;
    for (const recovery of recoveries) {
      const beforeRevision = recovery.assignment.revision;
      const bound = await this.recordAssignmentStarted(recovery.run.bossRunId, recovery.assignment.role, recovery.worker);
      const assignment = assignmentForRole(bound, recovery.assignment.role);
      if (assignment.state === "assigned" && assignment.revision === beforeRevision) changed = true;
    }
    return changed;
  }
  private async recordAssignmentFailed(bossRunId: string, role: TrustedLocalBossAssignmentRole, error: unknown): Promise<TrustedLocalBossRun> {
    return this.mutate((state, timestamp) => { const run = state.runs.find((candidate) => candidate.bossRunId === bossRunId); if (!run) throw new Error(`Trusted-local Boss run not found: ${bossRunId}`); const assignment = assignmentForRole(run, role); if (assignment.state === "cancelled" || assignment.state === "failed" || TERMINAL_RUN_STATES.has(run.state)) return structuredClone(run); const message = error instanceof Error ? error.message : String(error); assignment.state = "failed"; assignment.lastError = message.slice(0, 4_096) || `${role} launch failed`; assignment.updatedAt = timestamp; if (role === "manager") run.state = "failed"; run.updatedAt = timestamp; state.revision += 1; return structuredClone(run); });
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

  async recordProofDelivery(bossRunId: string, proofPacketId: string, fingerprintValue: BossCandidateFingerprint, error?: unknown): Promise<TrustedLocalBossRun> {
    return this.mutate((state, timestamp) => {
      const run = state.runs.find((candidate) => candidate.bossRunId === bossRunId); if (!run) throw new Error(`Trusted-local Boss run not found: ${bossRunId}`);
      const proof = run.proofPackets.find((candidate) => candidate.proofPacketId === proofPacketId); if (!proof) throw new Error("Trusted-local Boss proof packet is unavailable for delivery");
      const { freeze } = assertExactCurrentFreeze(run, fingerprintValue, "proof delivery");
      if (proof.freezeRevision !== freeze.freezeRevision || proof.acceptanceRevision !== freeze.acceptanceRevision || proof.designRevision !== freeze.designRevision || proof.resourceRevision !== freeze.resourceRevision || proof.fingerprintSha256 !== freeze.fingerprint.aggregateSha256) throw new Error("Trusted-local Boss proof delivery requires the exact current freeze and fingerprint revisions.");
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
      if (typeof worker.bossRunId !== "string" || !worker.owned) continue;
      const run = state.runs.find((candidate) => candidate.bossRunId === worker.bossRunId);
      if (!run) { orphans.push({ worker: structuredClone(worker), bossRunId: worker.bossRunId, managerSessionId: worker.managerSessionId, assignmentRole: null }); continue; }
      if (worker.managerSessionId !== run.managerSessionId || !worker.owned) continue;
      const represented = worker.managerSessionId === run.managerSessionId && run.assignments.some((assignment) => assignment.state === "assigned" && assignment.workerId === worker.id && assignment.workerIncarnationId === workerIncarnation(worker));
      if (represented) continue;
      const assignedIdentityConflict = worker.managerSessionId === run.managerSessionId && run.assignments.some((assignment) => assignment.state === "assigned" && assignment.workerId === worker.id && assignment.workerIncarnationId !== workerIncarnation(worker));
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
      if (role === "manager" && !TERMINAL_RUN_STATES.has(run.state)) run.state = "failed";
      run.updatedAt = timestamp; state.revision += 1;
    });
  }

  async synchronizeWorkers(workers: readonly WorkerRecord[]): Promise<boolean> {
    const snapshot = await this.readState();
    if (!snapshot.runs.some((run) => run.assignments.some((assignment) => assignment.state === "assigned") || run.cancellation?.state === "pending")) return false;
    return this.mutate((state, timestamp) => {
      let changed = false;
      for (const run of state.runs) {
        const applyingPause = run.pauseTransitions.at(-1)?.phase === "applying" ? run.pauseTransitions.at(-1)! : null;
        const acceptedResume = !run.currentPause && run.pauseTransitions.at(-1)?.action === "resume" && run.pauseTransitions.at(-1)?.phase === "accepted"
          ? run.pauseTransitions.at(-1)!
          : null;
        const acceptedDegradedResumeTargets = acceptedResume
          ? new Set(acceptedResume.settledTargets.map((target) => `${target.workerId}\0${target.workerIncarnationId}`))
          : new Set<string>();
        const pauseProtectedKeys = new Set([...(run.currentPause?.targets ?? []), ...(applyingPause?.targets ?? [])]
          .map((target) => `${target.workerId}\0${target.workerIncarnationId}`));
        for (const assignment of run.assignments.filter((candidate) => candidate.state === "assigned" && candidate.workerId && candidate.workerIncarnationId)) {
          const worker = workers.find((candidate) => candidate.id === assignment.workerId && workerIncarnation(candidate) === assignment.workerIncarnationId && candidate.owned && candidate.bossRunId === run.bossRunId && candidate.managerSessionId === run.managerSessionId);
          const workerState: WorkerState = worker?.state ?? "lost";
          const detail = worker ? worker.lastError ?? worker.stopReason ?? worker.stateReason : `${assignment.role} exact WorkerStore incarnation is missing`;
          const previous = [...run.lifecycle].reverse().find((entry) => entry.assignmentId === assignment.assignmentId);
          const currentActivity = worker ? authenticatedIntercomActivityTimestamp(worker) : undefined;
          const activityBaseline = previous?.authenticatedIntercomBaselineAt;
          const activityObservedAt = currentActivity
            && (!activityBaseline || Date.parse(currentActivity) > Date.parse(activityBaseline))
            && (!previous?.authenticatedIntercomActivityAt || Date.parse(currentActivity) > Date.parse(previous.authenticatedIntercomActivityAt))
            ? currentActivity
            : previous?.authenticatedIntercomActivityAt;
          if (previous?.workerState !== workerState || previous.detail !== detail || previous?.authenticatedIntercomActivityAt !== activityObservedAt) {
            run.lifecycle.push({ observationId: `observation-${randomUUID()}`, assignmentId: assignment.assignmentId, workerId: assignment.workerId!, workerIncarnationId: assignment.workerIncarnationId!, workerState, observedAt: timestamp, ...(activityBaseline ? { authenticatedIntercomBaselineAt: activityBaseline } : {}), ...(activityObservedAt ? { authenticatedIntercomActivityAt: activityObservedAt } : {}), ...(detail ? { detail: detail.slice(0, 4_096) } : {}) });
            if (run.lifecycle.length > 256) run.lifecycle.splice(0, run.lifecycle.length - 256);
            run.updatedAt = timestamp;
            changed = true;
          }
          const assignmentKey = `${assignment.workerId}\0${assignment.workerIncarnationId}`;
          const pauseProtected = pauseProtectedKeys.has(assignmentKey);
          const settledByAcceptedDegradedResume = acceptedDegradedResumeTargets.has(assignmentKey);
          if (!pauseProtected && !settledByAcceptedDegradedResume && !TERMINAL_RUN_STATES.has(run.state) && (workerState === "failed" || workerState === "lost" || workerState === "stopped")) {
            assignment.state = "failed";
            assignment.lastError = (detail ?? `${assignment.role} worker entered ${workerState}`).slice(0, 4_096);
            assignment.updatedAt = timestamp;
            // A Controller-authorized pause must remain resumable even when the
            // intentionally-unfrozen Manager or an already-terminal non-target
            // dies. Record the exact assignment failure now, then project the
            // run failure only after the pause transition has cleared.
            if (!run.currentPause && !applyingPause) run.state = "failed";
            changed = true;
          }
        }
        if (!run.currentPause && !applyingPause && !TERMINAL_RUN_STATES.has(run.state) && run.assignments.some((assignment) => assignment.state === "failed" && assignment.workerId && assignment.workerIncarnationId)) {
          run.state = "failed";
          run.updatedAt = timestamp;
          changed = true;
        }
        if (run.state === "cancelled" && run.cancellation?.state === "pending") {
          const bound = run.assignments.filter((assignment) => assignment.state === "assigned" && assignment.workerId && assignment.workerIncarnationId);
          const allSettled = bound.every((assignment) => {
            const worker = workers.find((candidate) => candidate.id === assignment.workerId && workerIncarnation(candidate) === assignment.workerIncarnationId && candidate.bossRunId === run.bossRunId && candidate.managerSessionId === run.managerSessionId);
            if (worker) return isTerminalWorkerState(worker.state);
            const conflicting = workers.some((candidate) => candidate.id === assignment.workerId && candidate.bossRunId === run.bossRunId && candidate.managerSessionId === run.managerSessionId && workerIncarnation(candidate) !== assignment.workerIncarnationId);
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

  async execute(request: BossCommandRequest, managerSessionId: string, fingerprintValue?: BossCandidateFingerprint): Promise<TrustedLocalBossResult> {
    return this.mutate((state, timestamp) => {
      const requestedId = "bossRunId" in request ? request.bossRunId : undefined;
      const selected = requestedId ? state.runs.find((run) => run.bossRunId === requestedId || run.handle === requestedId) : undefined;
      if (request.action === "status") {
        if (!requestedId) {
          const owned = state.runs
            .filter((run) => run.managerSessionId === managerSessionId)
            .map((run) => structuredClone(run))
            .sort(compareRunsForOwnedSummary);
          return { title: "Boss trusted-local runs", message: formatRunList(owned, timestamp), runs: owned };
        }
        if (!selected) throw new Error("No matching trusted-local Boss run exists.");
        assertOwningSession(selected, managerSessionId);
        return { title: "Boss trusted-local status", message: formatRun(selected, timestamp), run: structuredClone(selected), communication: runCommunication(selected, timestamp), pendingDecision: runPendingDecision(selected, timestamp) };
      }
      if (request.action === "create") {
        if (request.goal.length > MAX_GOAL_LENGTH) throw new Error(`Trusted-local Boss goal exceeds ${MAX_GOAL_LENGTH} characters.`);
        const assignment = (role: "manager" | "worker" | "scout", task: string): TrustedLocalBossAssignment => ({ assignmentId: `assignment-${randomUUID()}`, role, task, revision: 1, resourceRevision: null, state: "requested", workerId: null, workerIncarnationId: null, createdAt: timestamp, updatedAt: timestamp });
        const assignments = [assignment("manager", `Manage the trusted-local Boss goal: ${request.goal}`), assignment("worker", `Implement the highest-priority bounded work for: ${request.goal}`), assignment("scout", `Scout risks, dependencies, and verification gaps for: ${request.goal}`)];
        const bossRunId = `boss-${randomUUID()}`;
        const handle = deterministicBossRunHandle(bossRunId, this.handlePrefix);
        if (state.runs.some((candidate) => candidate.handle === handle)) throw new Error("Trusted-local Boss deterministic handle collision; no run was created");
        const run: TrustedLocalBossRun = { version: TRUSTED_LOCAL_BOSS_RUN_VERSION, bossRunId, handle, goal: request.goal, state: "active", managerSessionId, resource: null, acceptanceRevision: null, designRevision: null, freezeTransitions: [], currentFreeze: null, pauseTransitions: [], currentPause: null, pauseReconciliations: [], currentPauseDegradation: null, dynamicGrowthGrants: [], dynamicAssignments: [], assignments, deliveries: [], assignmentResults: [], lifecycle: [], proofPackets: [], decisions: [], cancellation: null, createdAt: timestamp, updatedAt: timestamp };
        state.runs.push(run); state.revision += 1; return { title: "Boss trusted-local run created", message: formatRun(run, timestamp), run: structuredClone(run) };
      }
      if (!selected) throw new Error("No matching trusted-local Boss run exists.");
      assertOwningSession(selected, managerSessionId);
      if (request.action === "freeze" || request.action === "unfreeze") throw new Error(`Trusted-local Boss ${request.action} requires an externally observed canonical candidate fingerprint.`);
      if (request.action === "proof") {
        if (TERMINAL_RUN_STATES.has(selected.state)) throw new Error(`Cannot create a proof packet for ${selected.state} Boss run.`);
        let reviewer = selected.assignments.find((assignment) => assignment.role === "adversary");
        if (!reviewer) {
          reviewer = { assignmentId: `assignment-${randomUUID()}`, role: "adversary", task: `Adversarially review trusted-local Boss run ${selected.bossRunId} against an exact advisory proof revision.`, revision: 1, resourceRevision: selected.resource?.revision ?? null, state: "requested", workerId: null, workerIncarnationId: null, createdAt: timestamp, updatedAt: timestamp };
          selected.assignments.push(reviewer);
          selected.updatedAt = timestamp;
          state.revision += 1;
          return { title: "Boss adversary staffing requested", message: `${formatRun(selected, timestamp)}\n\nThe adversary must be assigned before an exact proof revision can be generated and delivered.`, run: structuredClone(selected) };
        }
        if (reviewer.state === "failed") {
          reviewer.state = "requested"; reviewer.revision += 1; reviewer.workerId = null; reviewer.workerIncarnationId = null; delete reviewer.lastError; reviewer.updatedAt = timestamp; selected.updatedAt = timestamp; state.revision += 1;
          return { title: "Boss adversary staffing retry requested", message: `${formatRun(selected, timestamp)}\n\nThe failed adversary assignment was advanced to a new requested revision for ordinary fleet retry.`, run: structuredClone(selected) };
        }
        if (reviewer.state !== "assigned" || !reviewer.workerId) return { title: "Boss adversary staffing pending", message: `${formatRun(selected, timestamp)}\n\nThe adversary must be assigned before an exact proof revision can be generated and delivered.`, run: structuredClone(selected) };
        const { freeze } = assertExactCurrentFreeze(selected, fingerprintValue, "proof creation");
        const latestProof = selected.proofPackets.at(-1);
        if (latestProof && latestProof.snapshotSha256 === proofDigest(selected, reviewer)) {
          const latestDelivery = selected.deliveries.find((delivery) => delivery.kind === "proof-review" && delivery.proofPacketId === latestProof.proofPacketId);
          if (!latestDelivery || latestDelivery.state === "failed") return { title: "Advisory proof delivery retry", message: `${formatRun(selected, timestamp)}\n\nProof revision ${latestProof.revision} remains current and requires exact local review delivery retry.`, run: structuredClone(selected) };
        }
        if (selected.proofPackets.length >= MAX_PROOF_PACKETS) throw new Error(`Trusted-local Boss proof packet limit ${MAX_PROOF_PACKETS} reached.`);
        while (selected.deliveries.length >= 256) pruneOldestDeliveryPair(selected);
        const manager = assignmentForRole(selected, "manager");
        const proofPacketId = `proof-${randomUUID()}`;
        const packet: TrustedLocalBossProofPacket = { proofPacketId, revision: selected.proofPackets.length + 1, bossRunId: selected.bossRunId, runState: selected.state, managerAssignmentId: manager.assignmentId, reviewerAssignmentId: reviewer.assignmentId, lifecycleCount: selected.lifecycle.length, freezeRevision: freeze.freezeRevision, acceptanceRevision: freeze.acceptanceRevision, designRevision: freeze.designRevision, resourceRevision: freeze.resourceRevision, fingerprintSha256: freeze.fingerprint.aggregateSha256, generatedAt: timestamp, snapshotSha256: proofDigest(selected, reviewer) };
        selected.proofPackets.push(packet); selected.updatedAt = timestamp; state.revision += 1;
        return { title: "Advisory proof packet", message: `${formatRun(selected, timestamp)}\n\nProof revision ${packet.revision} is bound to sha256:${packet.snapshotSha256} and awaits exact local review delivery. No protected attestation is claimed.`, run: structuredClone(selected) };
      }
      if (request.action === "approve" || request.action === "reject") {
        if (!request.note) throw new Error(`Trusted-local ${request.action} requires an explicit review note.`);
        const outcome = request.action === "approve" ? "approved" : "rejected";
        const existingDecision = selected.decisions.at(-1);
        if (selected.state === outcome && existingDecision?.outcome === outcome) {
          return { title: `Boss trusted-local ${outcome} cleanup retry`, message: `${formatRun(selected, timestamp)}\n\nThe existing decision is unchanged; exact participant shutdown and canonical resource cleanup may be retried.`, run: structuredClone(selected) };
        }
        if (selected.state !== "active" && selected.state !== "paused") throw new Error(`Cannot ${request.action} Boss run from ${selected.state}.`);
        const proof = selected.proofPackets.at(-1); if (!proof) throw new Error(`Trusted-local ${request.action} requires an advisory proof packet.`);
        const { freeze } = assertExactCurrentFreeze(selected, fingerprintValue, request.action);
        if (proof.freezeRevision !== freeze.freezeRevision || proof.acceptanceRevision !== freeze.acceptanceRevision || proof.designRevision !== freeze.designRevision || proof.resourceRevision !== freeze.resourceRevision || proof.fingerprintSha256 !== freeze.fingerprint.aggregateSha256) throw new Error(`Trusted-local ${request.action} requires a proof bound to the exact current freeze and fingerprint revisions.`);
        const reviewer = assignmentForRole(selected, "adversary"); if (reviewer.state !== "assigned" || !reviewer.workerId) throw new Error(`Trusted-local ${request.action} requires an assigned adversary reviewer.`);
        const proofDelivery = selected.deliveries.find((delivery) => delivery.kind === "proof-review" && delivery.proofPacketId === proof.proofPacketId);
        const proofResult = proofDelivery ? selected.assignmentResults.find((result) => result.deliveryId === proofDelivery.deliveryId) : undefined;
        if (!proofDelivery || proofDelivery.state !== "delivered" || proofResult?.outcome !== "accepted") throw new Error(`Trusted-local ${request.action} requires successful delivery of the exact latest proof.`);
        if (proof.runState !== selected.state || proof.snapshotSha256 !== proofDigest(selected, reviewer)) throw new Error(`Trusted-local ${request.action} requires a fresh proof of the exact current run state.`);
        if (selected.decisions.length) throw new Error("Trusted-local Boss run already has a review decision.");
        selected.decisions.push({ decisionId: `decision-${randomUUID()}`, proofPacketId: proof.proofPacketId, proofRevision: proof.revision, reviewerAssignmentId: reviewer.assignmentId, reviewerWorkerId: reviewer.workerId, outcome, note: request.note.slice(0, 4_096), decidedBySessionId: managerSessionId, decidedAt: timestamp });
        selected.state = outcome; selected.updatedAt = timestamp; state.revision += 1;
        return { title: `Boss trusted-local run ${outcome}`, message: formatRun(selected, timestamp), run: structuredClone(selected) };
      }
      if (request.action === "pause" || request.action === "resume") throw new Error(`Trusted-local Boss ${request.action} requires externally verified systemd cgroup control.`);
      const nextState = "cancelled" as const;
      if (request.action === "cancel" && selected.state === "cancelled" && selected.cancellation?.state === "pending") return { title: "Boss trusted-local cancellation pending", message: formatRun(selected, timestamp), run: structuredClone(selected) };
      if (request.action === "cancel" && selected.state === "cancelled" && selected.cancellation?.state === "failed") {
        selected.cancellation = { actionId: `cancel-${randomUUID()}`, state: "pending", requestedAt: timestamp };
        selected.updatedAt = timestamp;
        state.revision += 1;
        return { title: "Boss trusted-local cancellation retry requested", message: formatRun(selected, timestamp), run: structuredClone(selected) };
      }
      if (request.action === "cancel" && TERMINAL_RUN_STATES.has(selected.state)) throw new Error(`Boss run is already ${selected.state}.`);
      selected.state = nextState; selected.updatedAt = timestamp;
      if (nextState === "cancelled") { selected.cancellation = { actionId: `cancel-${randomUUID()}`, state: "pending", requestedAt: timestamp }; for (const assignment of selected.assignments) { if (assignment.state === "requested") { assignment.state = "cancelled"; assignment.updatedAt = timestamp; } } }
      state.revision += 1;
      return { title: "Boss trusted-local run cancellation requested", message: formatRun(selected, timestamp), run: structuredClone(selected) };
    });
  }
}

import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BOSS_APPROVAL_VERSION,
  BOSS_ASSIGNMENT_VERSION,
  BOSS_AUDIT_ENTRY_VERSION,
  BOSS_AUTHORITY_PROJECTION_VERSION,
  BOSS_CONTROLLER_STORE_VERSION,
  BOSS_EVIDENCE_REF_VERSION,
  BOSS_GOAL_REVISION_VERSION,
  BOSS_OUTBOX_ITEM_VERSION,
  BOSS_PARTICIPANT_VERSION,
  BOSS_PROOF_MANIFEST_VERSION,
  BOSS_REQUIRED_FEATURE,
  BOSS_RUN_VERSION,
  BOSS_WATCHDOG_VERSION,
  BossSchemaVersionError,
  BossValidationError,
  computeBossAuditEntryDigest,
  detachedBossSnapshot,
  parseBossApprovalV1,
  parseBossAssignmentV1,
  parseBossAuditEntryV1,
  parseBossAuthorityTransitionProjectionV1,
  parseBossControllerState,
  parseBossEvidenceRefV1,
  parseBossGoalRevisionV1,
  parseBossOutboxItemV1,
  parseBossParticipantV1,
  parseBossProofManifestV1,
  parseBossRunV1,
  parseBossWatchdogV1,
  sha256BossValue,
  type BossApprovalV1,
  type BossAssignmentV1,
  type BossAuditEntryV1,
  type BossAuthorityTransitionProjectionV1,
  type BossControllerStateV1,
  type BossEvidenceRefV1,
  type BossOutboxItemV1,
  type BossParticipantV1,
  type BossProofManifestV1,
  type BossWatchdogV1,
} from "../src/boss-types.ts";
import {
  BOSS_STORE_FAULT_POINTS,
  BOSS_STORE_MIGRATIONS,
  BossStore,
  BossStoreCommitError,
  BossStoreConflictError,
  BossStoreCorruptError,
  BossStorePoisonedError,
  BossStoreUnsupportedError,
  type BossStoreFaultPoint,
} from "../src/boss-store.ts";
import { acquireKernelFileLock } from "../src/file-lock.ts";

const CREATED = "2026-01-02T03:04:05.000Z";
const LATER = "2026-01-02T03:04:06.000Z";
const LATEST = "2026-01-02T03:04:07.000Z";
const DIGEST = "a".repeat(64);
const OTHER_DIGEST = "b".repeat(64);
const REVISION = "c".repeat(40);
const OTHER_REVISION = "d".repeat(40);

function authorityTransition(overrides: Partial<BossAuthorityTransitionProjectionV1> = {}): BossAuthorityTransitionProjectionV1 {
  return {
    version: BOSS_AUTHORITY_PROJECTION_VERSION,
    authorityTransitionId: "authority-controller-1",
    bossRunId: "boss-run-1",
    operation: "controller_takeover",
    targetKind: "controller",
    targetId: "controller-1",
    idempotencyKey: "authority-controller-key-1",
    expectedBrokerRevision: 0,
    brokerRevision: 1,
    priorControllerGeneration: 0,
    resultingControllerGeneration: 1,
    priorBindingEpoch: null,
    resultingBindingEpoch: null,
    brokerState: "committed",
    projectionState: "reconciled",
    prepareTokenDigest: DIGEST,
    createdAt: CREATED,
    preparedAt: CREATED,
    committedAt: CREATED,
    reconciledAt: CREATED,
    abortedAt: null,
    abortReason: null,
    ...overrides,
  };
}

function auditEntry(
  overrides: Partial<Omit<BossAuditEntryV1, "entryDigest">> = {},
): BossAuditEntryV1 {
  const unsigned: Omit<BossAuditEntryV1, "entryDigest"> = {
    version: BOSS_AUDIT_ENTRY_VERSION,
    auditEntryId: "audit-1",
    bossRunId: "boss-run-1",
    sequence: 1,
    actorType: "system",
    actorId: null,
    entityType: "store",
    entityId: "boss-store-1",
    action: "store.created",
    outcome: "success",
    detailsDigest: DIGEST,
    previousEntryDigest: null,
    occurredAt: CREATED,
    ...overrides,
  };
  return { ...unsigned, entryDigest: computeBossAuditEntryDigest(unsigned) };
}

function appendAudit(
  state: BossControllerStateV1,
  id: string,
  overrides: Partial<Omit<BossAuditEntryV1, "entryDigest" | "auditEntryId" | "sequence" | "previousEntryDigest">> = {},
): void {
  const previous = state.audit.at(-1)!;
  state.audit.push(auditEntry({
    auditEntryId: id,
    sequence: previous.sequence + 1,
    previousEntryDigest: previous.entryDigest,
    action: "store.updated",
    occurredAt: LATER,
    ...overrides,
  }));
}

function baseState(overrides: Partial<BossControllerStateV1> = {}): BossControllerStateV1 {
  return {
    version: BOSS_CONTROLLER_STORE_VERSION,
    requiredFeatures: [BOSS_REQUIRED_FEATURE],
    storeId: "boss-store-1",
    revision: 1,
    controllerGeneration: 1,
    controllerAuthorityTransitionId: "authority-controller-1",
    run: {
      version: BOSS_RUN_VERSION,
      bossRunId: "boss-run-1",
      controllerPrincipalId: "controller-1",
      currentGoalRevisionId: "goal-revision-1",
      state: "paused",
      bossBindingEpoch: 0,
      bossAuthorityTransitionId: null,
      createdAt: CREATED,
      updatedAt: CREATED,
    },
    goalRevisions: [{
      version: BOSS_GOAL_REVISION_VERSION,
      goalRevisionId: "goal-revision-1",
      bossRunId: "boss-run-1",
      revision: 1,
      parentGoalRevisionId: null,
      objective: "Build the fail-closed Controller foundation",
      acceptanceCriteria: ["State remains dormant", "Corruption fails closed"],
      createdByParticipantId: "boss-1",
      state: "current",
      createdAt: CREATED,
    }],
    participants: [{
      version: BOSS_PARTICIPANT_VERSION,
      participantId: "boss-1",
      bossRunId: "boss-run-1",
      role: "boss",
      communicationProfile: "boss",
      bindingEpoch: 0,
      bindingState: "pending",
      sessionId: null,
      authorityTransitionId: null,
      assignedManagerParticipantId: null,
      state: "paused",
      reason: null,
      createdAt: CREATED,
      updatedAt: CREATED,
    }],
    assignments: [],
    approvals: [],
    proofManifests: [],
    evidenceRefs: [],
    outbox: [],
    watchdogs: [],
    authorityTransitions: [authorityTransition()],
    audit: [auditEntry()],
    createdAt: CREATED,
    updatedAt: CREATED,
    ...overrides,
  };
}

function participantTransition(participantId: string, suffix: string): BossAuthorityTransitionProjectionV1 {
  return authorityTransition({
    authorityTransitionId: `authority-${suffix}-1`,
    operation: "bind_participant",
    targetKind: "participant",
    targetId: participantId,
    idempotencyKey: `authority-${suffix}-key-1`,
    brokerRevision: 2,
    priorControllerGeneration: null,
    resultingControllerGeneration: null,
    priorBindingEpoch: 0,
    resultingBindingEpoch: 1,
  });
}

function activeParticipant(
  participantId: string,
  role: "manager" | "worker" | "scout" | "adversary",
  suffix: string,
  assignedManagerParticipantId: string | null = null,
): BossParticipantV1 {
  return {
    version: BOSS_PARTICIPANT_VERSION,
    participantId,
    bossRunId: "boss-run-1",
    role,
    communicationProfile: role,
    bindingEpoch: 1,
    bindingState: "active",
    sessionId: `session-${suffix}-1`,
    authorityTransitionId: `authority-${suffix}-1`,
    assignedManagerParticipantId,
    state: "ready",
    reason: null,
    createdAt: CREATED,
    updatedAt: CREATED,
  };
}

function assignmentFixture(): { state: BossControllerStateV1; assignment: BossAssignmentV1; watchdog: BossWatchdogV1 } {
  const state = baseState();
  const manager = activeParticipant("manager-1", "manager", "manager");
  const worker = activeParticipant("worker-1", "worker", "worker", "manager-1");
  state.participants.push(manager, worker);
  state.authorityTransitions.push(participantTransition(manager.participantId, "manager"), participantTransition(worker.participantId, "worker"));
  const assignment: BossAssignmentV1 = {
    version: BOSS_ASSIGNMENT_VERSION,
    assignmentId: "assignment-1",
    bossRunId: "boss-run-1",
    goalRevisionId: "goal-revision-1",
    managerParticipantId: "manager-1",
    assigneeParticipantId: "worker-1",
    idempotencyKey: "assignment-key-1",
    title: "Implement the store",
    state: "created",
    attempt: 1,
    watchdogGeneration: 1,
    sourceWriter: true,
    createdAt: CREATED,
    updatedAt: CREATED,
    acceptedAt: null,
    submittedAt: null,
    terminalAt: null,
    resultMessageId: null,
  };
  const watchdog: BossWatchdogV1 = {
    version: BOSS_WATCHDOG_VERSION,
    watchdogId: "watchdog-1",
    bossRunId: "boss-run-1",
    assignmentId: "assignment-1",
    generation: 1,
    kind: "response",
    state: "armed",
    dueAt: LATER,
    lastProgressAt: null,
    firedAt: null,
    controllerGeneration: 1,
    authorityTransitionId: "authority-controller-1",
    createdAt: CREATED,
    updatedAt: CREATED,
  };
  state.assignments.push(assignment);
  state.watchdogs.push(watchdog);
  return { state, assignment, watchdog };
}

function proofFixture(): { proof: BossProofManifestV1; evidence: BossEvidenceRefV1; approval: BossApprovalV1 } {
  const evidence: BossEvidenceRefV1 = {
    version: BOSS_EVIDENCE_REF_VERSION,
    evidenceRefId: "evidence-1",
    bossRunId: "boss-run-1",
    proofManifestId: "proof-1",
    producerParticipantId: "worker-1",
    kind: "command",
    sha256: DIGEST,
    storageRef: `sha256:${DIGEST}`,
    mediaType: "text/plain",
    sizeBytes: 12,
    redacted: true,
    userTestPath: "/tmp/result.txt",
    sourceRevision: REVISION,
    baseRevision: OTHER_REVISION,
    integrationRevision: REVISION,
    profileDigest: DIGEST,
    configDigest: OTHER_DIGEST,
    capturedAt: CREATED,
  };
  const proof: BossProofManifestV1 = {
    version: BOSS_PROOF_MANIFEST_VERSION,
    proofManifestId: "proof-1",
    bossRunId: "boss-run-1",
    goalRevisionId: "goal-revision-1",
    producerParticipantId: "worker-1",
    proofClass: "cli",
    state: "submitted",
    evidenceRefIds: ["evidence-1"],
    sourceRevision: REVISION,
    baseRevision: OTHER_REVISION,
    integrationRevision: REVISION,
    profileDigest: DIGEST,
    configDigest: OTHER_DIGEST,
    createdAt: CREATED,
    submittedAt: LATER,
    invalidatedAt: null,
    invalidationReason: null,
  };
  const approval: BossApprovalV1 = {
    version: BOSS_APPROVAL_VERSION,
    approvalId: "approval-1",
    bossRunId: "boss-run-1",
    goalRevisionId: "goal-revision-1",
    proofManifestId: "proof-1",
    state: "pending",
    decidedByParticipantId: null,
    reason: null,
    createdAt: LATER,
    decidedAt: null,
  };
  return { proof, evidence, approval };
}

function outboxFixture(): BossOutboxItemV1 {
  return {
    version: BOSS_OUTBOX_ITEM_VERSION,
    outboxItemId: "outbox-1",
    bossRunId: "boss-run-1",
    topic: "boss.assignment.created",
    entityType: "assignment",
    entityId: "assignment-1",
    messageId: "message-1",
    idempotencyKey: "outbox-key-1",
    payloadDigest: DIGEST,
    state: "pending",
    attempt: 0,
    controllerGeneration: 1,
    authorityTransitionId: "authority-controller-1",
    availableAt: CREATED,
    claimedAt: null,
    dispatchedAt: null,
    acknowledgedAt: null,
    lastError: null,
    createdAt: CREATED,
    updatedAt: CREATED,
  };
}

test("exact schemas accept a valid dormant Controller snapshot", () => {
  const state = parseBossControllerState(baseState());
  assert.equal(state.run.state, "paused");
  assert.equal(state.controllerGeneration, 1);
  assert.equal(state.authorityTransitions[0].operation, "controller_takeover");
  assert.equal(BOSS_STORE_MIGRATIONS.length, 0, "the explicit migration registry starts empty because no legacy Controller schema exists");
});

test("parsers reject proxies, accessors, inherited objects, symbols, and sparse or decorated arrays", () => {
  const state = baseState();
  assert.throws(() => parseBossControllerState(new Proxy(state, {})), /non-proxy plain object/);

  const nestedProxy = detachedBossSnapshot(state);
  nestedProxy.run = new Proxy(nestedProxy.run, {});
  assert.throws(() => parseBossControllerState(nestedProxy), /non-proxy plain object/);

  const accessor = detachedBossSnapshot(state) as unknown as Record<string, unknown>;
  delete accessor.storeId;
  Object.defineProperty(accessor, "storeId", { enumerable: true, get: () => "boss-store-1" });
  assert.throws(() => parseBossControllerState(accessor), /enumerable own data property/);

  const inherited = Object.create(state) as unknown;
  assert.throws(() => parseBossControllerState(inherited), /custom or inherited prototype/);

  const symbol = detachedBossSnapshot(state) as unknown as Record<PropertyKey, unknown>;
  symbol[Symbol("hidden")] = true;
  assert.throws(() => parseBossControllerState(symbol), /symbol properties/);

  const sparse = detachedBossSnapshot(state);
  sparse.assignments = Array(1) as BossAssignmentV1[];
  assert.throws(() => parseBossControllerState(sparse), /sparse array holes/);

  const decorated = detachedBossSnapshot(state);
  Object.defineProperty(decorated.assignments, "named", { enumerable: true, value: true });
  assert.throws(() => parseBossControllerState(decorated), /non-index properties/);
});

test("every entity refuses arbitrary own keys including prototype-shaped names", () => {
  const assignment = assignmentFixture();
  const proof = proofFixture();
  const parsers: Array<[unknown, (value: unknown) => unknown]> = [
    [baseState(), parseBossControllerState],
    [baseState().run, parseBossRunV1],
    [baseState().goalRevisions[0], parseBossGoalRevisionV1],
    [baseState().participants[0], parseBossParticipantV1],
    [assignment.assignment, parseBossAssignmentV1],
    [proof.approval, parseBossApprovalV1],
    [proof.proof, parseBossProofManifestV1],
    [proof.evidence, parseBossEvidenceRefV1],
    [outboxFixture(), parseBossOutboxItemV1],
    [assignment.watchdog, parseBossWatchdogV1],
    [authorityTransition(), parseBossAuthorityTransitionProjectionV1],
    [baseState().audit[0], parseBossAuditEntryV1],
  ];
  for (const [fixture, parser] of parsers) {
    for (const key of ["unexpected", "__proto__", "constructor", "toString"]) {
      const candidate = detachedBossSnapshot(fixture) as Record<string, unknown>;
      Object.defineProperty(candidate, key, { enumerable: true, configurable: true, writable: true, value: "injected" });
      assert.throws(() => parser(candidate), /is not supported/, `${key} should be rejected`);
    }
  }
});

test("versions, identifiers, timestamps, digests, media types, and redaction are strict", () => {
  const newer = detachedBossSnapshot(baseState()) as unknown as { version: string };
  newer.version = "orc.boss-controller-store.v2";
  assert.throws(() => parseBossControllerState(newer), (error: unknown) => error instanceof BossSchemaVersionError && error.direction === "newer");

  const foreign = detachedBossSnapshot(baseState());
  (foreign.run as unknown as { version: string }).version = "foreign.run.v1";
  assert.throws(() => parseBossControllerState(foreign), BossSchemaVersionError);

  const badId = detachedBossSnapshot(baseState());
  badId.storeId = "../escape";
  assert.throws(() => parseBossControllerState(badId), /ASCII identifier/);

  const badTime = detachedBossSnapshot(baseState());
  badTime.updatedAt = "2026-01-02T03:04:05Z";
  assert.throws(() => parseBossControllerState(badTime), /canonical UTC/);

  const evidence = proofFixture().evidence;
  assert.throws(() => parseBossEvidenceRefV1({ ...evidence, sha256: DIGEST.toUpperCase() }), /lowercase SHA-256/);
  assert.throws(() => parseBossEvidenceRefV1({ ...evidence, storageRef: `sha256:${OTHER_DIGEST}` }), /content-addressed/);
  assert.throws(() => parseBossEvidenceRefV1({ ...evidence, mediaType: "Text/Plain" }), /lowercase media type/);
  assert.throws(() => parseBossEvidenceRefV1({ ...evidence, redacted: false }), /redacted before persistence/);
});

test("cross-entity invariants enforce assignment edges, watchdog generations, and one source writer", () => {
  const { state, assignment, watchdog } = assignmentFixture();
  assert.equal(parseBossControllerState(state).assignments.length, 1);

  const wrongManager = detachedBossSnapshot(state);
  wrongManager.assignments[0].managerParticipantId = "boss-1";
  assert.throws(() => parseBossControllerState(wrongManager), /Manager-to-assigned Worker/);

  const missingWatchdog = detachedBossSnapshot(state);
  missingWatchdog.watchdogs = [];
  assert.throws(() => parseBossControllerState(missingWatchdog), /exactly one current watchdog/);

  const twoWriters = detachedBossSnapshot(state);
  twoWriters.assignments.push({ ...assignment, assignmentId: "assignment-2", idempotencyKey: "assignment-key-2" });
  twoWriters.watchdogs.push({ ...watchdog, watchdogId: "watchdog-2", assignmentId: "assignment-2" });
  assert.throws(() => parseBossControllerState(twoWriters), /one nonterminal source-writing assignment/);
});

test("proof, evidence, and approval remain revision-bound and content-addressed", () => {
  const { state } = assignmentFixture();
  const { proof, evidence, approval } = proofFixture();
  state.proofManifests.push(proof);
  state.evidenceRefs.push(evidence);
  state.approvals.push(approval);
  assert.equal(parseBossControllerState(state).proofManifests[0].evidenceRefIds[0], "evidence-1");

  const stale = detachedBossSnapshot(state);
  stale.evidenceRefs[0].integrationRevision = OTHER_REVISION;
  assert.throws(() => parseBossControllerState(stale), /revision\/config\/producer binding/);

  const fabricatedApproval = detachedBossSnapshot(state);
  fabricatedApproval.approvals[0].state = "approved";
  fabricatedApproval.approvals[0].decidedByParticipantId = "worker-1";
  fabricatedApproval.approvals[0].decidedAt = LATEST;
  assert.throws(() => parseBossControllerState(fabricatedApproval), /Boss participant/);
});

test("create/read/query return detached snapshots and persist mode 0600", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "boss-store-detached-"));
  context.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })); });
  const path = join(root, "controller.json");
  const store = new BossStore(path, { now: () => LATER });
  const created = await store.create(baseState());
  created.run.state = "cancelled";
  created.goalRevisions[0].objective = "mutated caller copy";
  assert.equal((await store.read()).run.state, "paused");
  assert.equal((await store.query("goalRevisions", "goal-revision-1"))[0].objective, "Build the fail-closed Controller foundation");
  const queried = await store.query("participants");
  queried[0].state = "stopped";
  assert.equal((await store.query("participants"))[0].state, "paused");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await assert.rejects(store.query("participants", "../bad"), /ASCII identifier/);
});

test("CAS and transactions serialize revisions, require append-only audit, and reject stale callers", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "boss-store-cas-"));
  context.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })); });
  const path = join(root, "controller.json");
  const store = new BossStore(path, { now: () => LATER });
  await store.create(baseState());

  await assert.rejects(store.transaction(1, (draft) => { draft.run.updatedAt = LATER; }), /append at least one audit/);
  assert.equal((await store.read()).revision, 1);

  const revision2 = await store.transaction(1, (draft) => {
    draft.run.updatedAt = LATER;
    appendAudit(draft, "audit-2");
  });
  assert.equal(revision2.revision, 2);
  await assert.rejects(store.transaction(1, () => undefined), BossStoreConflictError);

  const replacement = detachedBossSnapshot(revision2);
  replacement.revision = 3;
  replacement.updatedAt = LATEST;
  replacement.run.updatedAt = LATEST;
  appendAudit(replacement, "audit-3", { occurredAt: LATEST });
  const revision3 = await store.compareAndSwap(2, replacement);
  assert.equal(revision3.revision, 3);

  const rewrittenAudit = detachedBossSnapshot(revision3);
  rewrittenAudit.revision = 4;
  rewrittenAudit.updatedAt = LATEST;
  rewrittenAudit.audit[0] = auditEntry({ detailsDigest: OTHER_DIGEST });
  appendAudit(rewrittenAudit, "audit-4", { occurredAt: LATEST });
  await assert.rejects(store.compareAndSwap(3, rewrittenAudit), /audit hash chain|append-only/);
});

test("controllerGeneration changes only through a newly committed reconciled takeover", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "boss-store-generation-"));
  context.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })); });
  const store = new BossStore(join(root, "controller.json"), { now: () => LATER });
  await store.create(baseState());

  await assert.rejects(store.transaction(1, (draft) => {
    draft.controllerGeneration = 2;
    appendAudit(draft, "audit-invalid-generation");
  }), /current generation|matching newly committed|Controller takeover/);
  assert.equal((await store.read()).controllerGeneration, 1);

  const revision2 = await store.transaction(1, (draft) => {
    draft.controllerGeneration = 2;
    draft.controllerAuthorityTransitionId = "authority-controller-2";
    draft.authorityTransitions.push(authorityTransition({
      authorityTransitionId: "authority-controller-2",
      idempotencyKey: "authority-controller-key-2",
      expectedBrokerRevision: 1,
      brokerRevision: 2,
      priorControllerGeneration: 1,
      resultingControllerGeneration: 2,
      createdAt: LATER,
      preparedAt: LATER,
      committedAt: LATER,
      reconciledAt: LATER,
    }));
    appendAudit(draft, "audit-controller-2", {
      entityType: "authority_transition",
      entityId: "authority-controller-2",
      action: "authority.reconciled",
    });
  });
  assert.equal(revision2.controllerGeneration, 2);
  assert.equal(revision2.controllerAuthorityTransitionId, "authority-controller-2");

  await assert.rejects(store.transaction(2, (draft) => {
    draft.controllerGeneration = 4;
    appendAudit(draft, "audit-generation-skip");
  }), /current generation|advance exactly once/);
});

test("terminal authority projections and approved evidence content cannot be substituted", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "boss-store-content-binding-"));
  context.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })); });
  const store = new BossStore(join(root, "controller.json"), { now: () => LATER });
  await store.create(baseState());

  await assert.rejects(store.transaction(1, (draft) => {
    draft.authorityTransitions[0].prepareTokenDigest = OTHER_DIGEST;
    appendAudit(draft, "audit-authority-substitution", { entityType: "authority_transition", entityId: "authority-controller-1", action: "authority.reconciled" });
  }), /terminal authority projection is immutable|immutable once populated/);

  const withProof = await store.transaction(1, (draft) => {
    draft.evidenceRefs.push({
      version: BOSS_EVIDENCE_REF_VERSION, evidenceRefId: "evidence-1", bossRunId: "boss-run-1", proofManifestId: "proof-1", producerParticipantId: "boss-1",
      kind: "artifact", sha256: DIGEST, storageRef: `sha256:${DIGEST}`, mediaType: "text/plain", sizeBytes: 7, redacted: true, userTestPath: "/tmp/proof",
      sourceRevision: REVISION, baseRevision: REVISION, integrationRevision: REVISION, profileDigest: DIGEST, configDigest: DIGEST, capturedAt: LATER,
    });
    draft.proofManifests.push({
      version: BOSS_PROOF_MANIFEST_VERSION, proofManifestId: "proof-1", bossRunId: "boss-run-1", goalRevisionId: "goal-revision-1", producerParticipantId: "boss-1",
      proofClass: "cli", state: "submitted", evidenceRefIds: ["evidence-1"], sourceRevision: REVISION, baseRevision: REVISION, integrationRevision: REVISION,
      profileDigest: DIGEST, configDigest: DIGEST, createdAt: CREATED, submittedAt: LATER, invalidatedAt: null, invalidationReason: null,
    });
    draft.approvals.push({
      version: BOSS_APPROVAL_VERSION, approvalId: "approval-1", bossRunId: "boss-run-1", goalRevisionId: "goal-revision-1", proofManifestId: "proof-1",
      state: "approved", decidedByParticipantId: "boss-1", reason: "verified", createdAt: CREATED, decidedAt: LATER,
    });
    appendAudit(draft, "audit-proof-added", { entityType: "proof_manifest", entityId: "proof-1", action: "proof.changed" });
  });
  assert.equal(withProof.revision, 2);
  await assert.rejects(store.transaction(2, (draft) => {
    draft.evidenceRefs[0].sha256 = OTHER_DIGEST;
    draft.evidenceRefs[0].storageRef = `sha256:${OTHER_DIGEST}`;
    draft.evidenceRefs[0].sizeBytes = 99;
    appendAudit(draft, "audit-evidence-substitution", { entityType: "proof_manifest", entityId: "proof-1", action: "proof.changed" });
  }), /captured evidence is immutable/);
});

test("two store instances reclaim one dead lock without ABA and only one same-revision transaction commits", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "boss-store-lock-"));
  context.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })); });
  const path = join(root, "controller.json");
  const first = new BossStore(path, { now: () => LATER, lockPollMs: 2 });
  const second = new BossStore(path, { now: () => LATER, lockPollMs: 2 });
  await first.create(baseState());
  await writeFile(`${path}.lock`, `${JSON.stringify({ version: "orc.boss-store-lock.v1", pid: 2_147_483_647, token: "dead-owner", createdAt: CREATED })}\n`);
  const results = await Promise.allSettled([
    first.transaction(1, async (draft) => { await new Promise((resolve) => setTimeout(resolve, 25)); appendAudit(draft, "audit-first"); }),
    second.transaction(1, (draft) => { appendAudit(draft, "audit-second"); }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected" && result.reason instanceof BossStoreConflictError).length, 1);
  assert.equal((await first.read()).revision, 2);
  await access(`${path}.lock.reclaim`);
});

test("the mutation guard serializes lock creation and normal release", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "boss-store-lock-guard-"));
  context.after(async () => { await rm(root, { recursive: true, force: true }); });
  const path = join(root, "controller.json");
  const guardPath = `${path}.lock.reclaim`;
  const store = new BossStore(path, { now: () => LATER, lockPollMs: 2, lockTimeoutMs: 2_000 });

  const releaseCreationGuard = await acquireKernelFileLock(guardPath, 1_000);
  const creating = store.create(baseState());
  await new Promise((resolve) => setTimeout(resolve, 40));
  await assert.rejects(access(path), { code: "ENOENT" });
  await releaseCreationGuard();
  await creating;

  let entered!: () => void;
  const callbackEntered = new Promise<void>((resolve) => { entered = resolve; });
  let settled = false;
  let releaseExternalGuard!: () => Promise<void>;
  const transaction = store.transaction(1, async (draft) => {
    appendAudit(draft, "audit-guarded-release");
    releaseExternalGuard = await acquireKernelFileLock(guardPath, 1_000);
    entered();
  }).finally(() => { settled = true; });
  await callbackEntered;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(settled, false);
  await access(`${path}.lock`);
  await releaseExternalGuard();
  await transaction;
  await assert.rejects(access(`${path}.lock`), { code: "ENOENT" });
});

test("owned lock release outwaits the normal acquisition timeout", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "boss-store-lock-release-"));
  context.after(async () => { await rm(root, { recursive: true, force: true }); });
  const path = join(root, "controller.json");
  const guardPath = `${path}.lock.reclaim`;
  const store = new BossStore(path, { now: () => LATER, lockPollMs: 2, lockTimeoutMs: 25 });
  await store.create(baseState());

  let entered!: () => void;
  const callbackEntered = new Promise<void>((resolve) => { entered = resolve; });
  let releaseExternalGuard!: () => Promise<void>;
  let settled = false;
  const transaction = store.transaction(1, async (draft) => {
    appendAudit(draft, "audit-delayed-release");
    releaseExternalGuard = await acquireKernelFileLock(guardPath, 1_000);
    entered();
  }).finally(() => { settled = true; });
  await callbackEntered;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(settled, false);
  await access(`${path}.lock`);
  await releaseExternalGuard();
  await transaction;
  await assert.rejects(access(`${path}.lock`), { code: "ENOENT" });
});

test("corrupt state is copied to deterministic quarantine, preserved, and poisoned read-only", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "boss-store-corrupt-"));
  context.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })); });
  const path = join(root, "controller.json");
  const corrupt = Buffer.from("{ definitely-not-json\n", "utf8");
  await writeFile(path, corrupt);
  const store = new BossStore(path, { now: () => LATER });
  let quarantinePath = "";
  await assert.rejects(store.read(), (error: unknown) => {
    assert.ok(error instanceof BossStoreCorruptError);
    quarantinePath = error.quarantinePath;
    return true;
  });
  assert.deepEqual(await readFile(path), corrupt, "the corrupt authority file is never replaced with empty state");
  assert.deepEqual(await readFile(quarantinePath), corrupt);
  await access(`${path}.poison`);
  await assert.rejects(new BossStore(path).read(), BossStorePoisonedError);
});

test("unknown newer and unsupported-feature states are preserved without quarantine or downgrade", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "boss-store-version-"));
  context.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })); });
  const path = join(root, "controller.json");
  const newer = detachedBossSnapshot(baseState()) as unknown as { version: string };
  newer.version = "orc.boss-controller-store.v2";
  const newerBytes = Buffer.from(`${JSON.stringify(newer)}\n`);
  await writeFile(path, newerBytes);
  await assert.rejects(new BossStore(path).read(), BossStoreUnsupportedError);
  assert.deepEqual(await readFile(path), newerBytes);
  await assert.rejects(access(`${path}.poison`), { code: "ENOENT" });

  const featureState = detachedBossSnapshot(baseState()) as unknown as { requiredFeatures: string[] };
  featureState.requiredFeatures = [BOSS_REQUIRED_FEATURE, "boss-run-v2"];
  const featureBytes = Buffer.from(`${JSON.stringify(featureState)}\n`);
  await writeFile(path, featureBytes);
  await assert.rejects(new BossStore(path).read(), BossStoreUnsupportedError);
  assert.deepEqual(await readFile(path), featureBytes);
  await assert.rejects(access(`${path}.poison`), { code: "ENOENT" });
});

test("all atomic crash points reconcile to exactly the old or new revision", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "boss-store-crash-matrix-"));
  context.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })); });
  const afterRename = new Set<BossStoreFaultPoint>(["after_rename", "after_directory_fsync"]);
  for (const point of BOSS_STORE_FAULT_POINTS) {
    const path = join(root, `${point}.json`);
    let injected = false;
    const store = new BossStore(path, {
      now: () => LATER,
      faultInjector(current) {
        if (!injected && current === point) {
          injected = true;
          throw new Error(`simulated crash at ${point}`);
        }
      },
    });
    if (afterRename.has(point)) {
      assert.equal((await store.create(baseState())).revision, 1);
      assert.equal((await store.read()).revision, 1);
    } else {
      await assert.rejects(store.create(baseState()), BossStoreCommitError);
      await assert.rejects(access(path), { code: "ENOENT" });
    }
    const leftovers = (await readdir(root)).filter((name) => name.startsWith(`.${point}.json.tmp.`));
    assert.deepEqual(leftovers, [], `${point} must not leave an ambiguous temp file in-process`);
  }
});

test("stale temp files reconcile under lock and cannot shadow the authoritative state", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "boss-store-temp-reconcile-"));
  context.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })); });
  const path = join(root, "controller.json");
  const store = new BossStore(path, { now: () => LATER });
  await store.create(baseState());
  const stale = join(root, ".controller.json.tmp.999.dead");
  await writeFile(stale, "uncommitted");
  await store.transaction(1, (draft) => appendAudit(draft, "audit-temp-reconcile"));
  await assert.rejects(access(stale), { code: "ENOENT" });
  assert.equal((await store.read()).revision, 2);
});

test("a persistence result matching neither old nor new is durably poisoned", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "boss-store-poison-"));
  context.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })); });
  const path = join(root, "controller.json");
  let injected = false;
  const store = new BossStore(path, {
    now: () => LATER,
    async faultInjector(point) {
      if (!injected && point === "after_rename") {
        injected = true;
        await writeFile(path, "ambiguous external bytes\n");
        throw new Error("simulated torn external overwrite");
      }
    },
  });
  await assert.rejects(store.create(baseState()), BossStorePoisonedError);
  await access(`${path}.poison`);
  await assert.rejects(new BossStore(path).read(), BossStorePoisonedError);
  assert.equal(await readFile(path, "utf8"), "ambiguous external bytes\n");
});

test("audit digests bind every exact field and reject mutation", () => {
  const entry = auditEntry();
  assert.equal(parseBossAuditEntryV1(entry).entryDigest, entry.entryDigest);
  assert.equal(entry.entryDigest, sha256BossValue("orc-boss-audit-entry-v1", (({ entryDigest: _, ...rest }) => rest)(entry)));
  assert.throws(() => parseBossAuditEntryV1({ ...entry, outcome: "failed" }), /canonical audit entry/);
});

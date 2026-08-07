import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { parseBossCommand, type BossCommandRequest } from "../src/boss-command.ts";
import { preserveProvisionedBossResource } from "../src/boss-resource.ts";
import { TRUSTED_LOCAL_BOSS_AUTHENTICATED_COMMUNICATION_DEADLINE_MS, TRUSTED_LOCAL_BOSS_WARNING, TrustedLocalBossStore, deterministicBossRunHandle, type TrustedLocalBossResource, type TrustedLocalBossResult } from "../src/boss-trusted-local.ts";
import type { BossCandidateFingerprint } from "../src/boss-candidate-fingerprint.ts";
import type { WorkerRecord } from "../src/types.ts";

const testRunOwners = new Map<string, string>();

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "boss-trusted-local-"));
  let tick = 0;
  const store = new TrustedLocalBossStore(join(dir, "runs.json"), () => new Date(1_700_000_000_000 + tick++));
  const execute = store.execute.bind(store);
  store.execute = async (request: BossCommandRequest, managerSessionId: string, fingerprint?: BossCandidateFingerprint): Promise<TrustedLocalBossResult> => {
    const result = await execute(request, managerSessionId, fingerprint);
    if (result.run) testRunOwners.set(result.run.bossRunId, result.run.managerSessionId);
    for (const run of result.runs ?? []) testRunOwners.set(run.bossRunId, run.managerSessionId);
    return result;
  };
  return { dir, store };
}

function canonicalResource(bossRunId: string): TrustedLocalBossResource {
  return {
    version: "orc.boss-resource.v1",
    resourceId: "resource-11111111-1111-4111-8111-111111111111",
    revision: 1,
    kind: "linked-worktree",
    path: "/tmp/boss-freeze-worktree",
    gitAdminDirectory: "/tmp/repo/.git/worktrees/boss-freeze-worktree",
    gitCommonDirectory: "/tmp/repo/.git",
    branch: "boss/run-test",
    baseSha: "1".repeat(40),
    headSha: "2".repeat(40),
    existence: "verified",
    leaseState: "active",
    leaseOwnerBossRunId: bossRunId,
    leaseAcquiredAt: "2023-11-14T22:13:20.000Z",
    leaseExpiresAt: "2023-11-14T23:13:20.000Z",
    capabilities: [{ capability: "worktree-identity", requested: "read", availability: "verified", evidence: "test fixture" }],
  };
}

function candidateFingerprint(resource: TrustedLocalBossResource, headSha = resource.headSha): BossCandidateFingerprint {
  const payload = {
    version: "orc.boss-candidate-fingerprint.v1" as const,
    resourceId: resource.resourceId,
    resourceRevision: resource.revision,
    cwd: resource.path,
    gitAdminDirectory: resource.gitAdminDirectory,
    gitCommonDirectory: resource.gitCommonDirectory,
    branch: resource.branch,
    baseSha: resource.baseSha,
    headSha,
    trackedDirtyBytes: 0,
    trackedDirtySha256: "b".repeat(64),
    untrackedBytes: 0,
    untrackedManifest: [],
  };
  return { ...payload, aggregateSha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex") };
}

async function createFrozenRun(store: TrustedLocalBossStore, managerSessionId: string, goal: string) {
  const bossRunId = `boss-${randomUUID()}`;
  const resource = canonicalResource(bossRunId);
  const fingerprint = candidateFingerprint(resource);
  const created = await store.createProvisionedRun({ bossRunId, goal, managerSessionId, resource });
  testRunOwners.set(bossRunId, managerSessionId);
  await store.authorizeFreeze({ bossRunId, managerSessionId, expectedAcceptanceRevision: 1, expectedDesignRevision: 1, fingerprint });
  return { created, fingerprint };
}

function managerWorker(bossRunId: string, state: WorkerRecord["state"] = "ready"): WorkerRecord {
  return {
    id: `boss-manager-${bossRunId.slice(-12)}`,
    runId: "worker-incarnation-test",
    workerIncarnationId: "worker-incarnation-test",
    workerGeneration: 1,
    bossRunId,
    harness: "pi",
    backend: "systemd",
    role: "manager",
    task: "manage the run",
    cwd: "/tmp",
    state,
    owned: true,
    managerSessionId: testRunOwners.get(bossRunId) ?? "manager-session-1",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    leaseExpiresAt: 1_700_000_060_000,
  };
}

test("trusted-local Boss creates and reports an explicitly advisory run", async () => {
  const { dir, store } = await fixture();
  try {
    const created = await store.execute(parseBossCommand("create ship the useful workflow"), "manager-session-1");
    assert.equal(created.run?.state, "active");
    assert.match(created.run?.bossRunId ?? "", /^boss-[0-9a-f-]{36}$/);
    assert.equal(created.run?.handle, deterministicBossRunHandle(created.run!.bossRunId));
    assert.match(created.message, new RegExp(TRUSTED_LOCAL_BOSS_WARNING.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(created.message, /evidence is advisory, not tamper-proof/);

    const status = await store.execute(parseBossCommand("status"), "manager-session-1");
    assert.deepEqual(status.runs?.map((run) => run.bossRunId), [created.run?.bossRunId]);
    assert.match(status.message, /Use \/boss status <handle-or-exact-run-id> for details/);

    const disk = JSON.parse(await readFile(join(dir, "runs.json"), "utf8"));
    assert.equal(disk.revision, 1);
    assert.equal(disk.version, "orc.boss-trusted-local.v7");
    assert.equal(disk.runs[0].version, "orc.boss-trusted-local.v5");
    assert.equal(disk.runs[0].resource, null);
    assert.equal(disk.currentRunId, undefined);
    assert.equal(disk.runs[0].assignments[0].role, "manager");
    assert.equal(disk.runs[0].assignments[0].state, "requested");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trusted-local Boss authorizes exact Controller freeze and unfreeze transitions", async () => {
  const { dir, store } = await fixture();
  const bossRunId = "boss-11111111-1111-4111-8111-111111111111";
  try {
    const resource = canonicalResource(bossRunId);
    const fingerprint = candidateFingerprint(resource);
    const created = await store.createProvisionedRun({ bossRunId, goal: "freeze exact candidate", managerSessionId: "controller-freeze", resource });
    assert.equal(created.run?.acceptanceRevision, 1);
    assert.equal(created.run?.designRevision, 1);

    await assert.rejects(store.authorizeFreeze({ bossRunId, managerSessionId: "foreign-controller", expectedAcceptanceRevision: 1, expectedDesignRevision: 1, fingerprint }), /owning Controller/);
    const stale = await store.authorizeFreeze({ bossRunId, managerSessionId: "controller-freeze", expectedAcceptanceRevision: 2, expectedDesignRevision: 1, fingerprint });
    assert.equal(stale.freezeTransition?.outcome, "rejected");
    assert.match(stale.freezeTransition?.reason ?? "", /superseded/);
    assert.equal(stale.run?.currentFreeze, null);

    const frozen = await store.authorizeFreeze({ bossRunId, managerSessionId: "controller-freeze", expectedAcceptanceRevision: 1, expectedDesignRevision: 1, fingerprint });
    assert.equal(frozen.freezeTransition?.outcome, "accepted");
    assert.equal(frozen.run?.currentFreeze?.freezeRevision, 1);
    assert.match(frozen.message, /not process suspension/);
    const repeated = await store.authorizeFreeze({ bossRunId, managerSessionId: "controller-freeze", expectedAcceptanceRevision: 1, expectedDesignRevision: 1, fingerprint });
    assert.equal(repeated.run?.freezeTransitions.length, 2, "an identical current freeze is idempotent");

    const paused = await store.execute(parseBossCommand(`pause ${bossRunId}`), "controller-freeze");
    assert.equal(paused.run?.currentFreeze?.freezeRevision, 1, "pause does not authorize or retire freeze");
    const moved = await store.authorizeUnfreeze({ bossRunId, managerSessionId: "controller-freeze", expectedFreezeRevision: 1, expectedFingerprintSha256: fingerprint.aggregateSha256, fingerprint: candidateFingerprint(resource, "3".repeat(40)) });
    assert.equal(moved.freezeTransition?.outcome, "rejected");
    assert.match(moved.freezeTransition?.reason ?? "", /moved/);
    assert.equal(moved.run?.currentFreeze?.freezeRevision, 1);

    const unfrozen = await store.authorizeUnfreeze({ bossRunId, managerSessionId: "controller-freeze", expectedFreezeRevision: 1, expectedFingerprintSha256: fingerprint.aggregateSha256, fingerprint });
    assert.equal(unfrozen.freezeTransition?.outcome, "accepted");
    assert.equal(unfrozen.run?.currentFreeze, null);
    assert.deepEqual(unfrozen.run?.freezeTransitions.map((transition) => transition.revision), [1, 2, 3, 4]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trusted-local Boss accepts stable handles as aliases while retaining exact ids", async () => {
  const { dir, store } = await fixture();
  try {
    store.setHandlePrefix("orc");
    const created = await store.execute(parseBossCommand("create alias-addressable run"), "manager-alias");
    const handle = created.run!.handle;
    assert.match(handle, /^orc-[a-z2-7]{10}$/);
    assert.equal((await store.execute(parseBossCommand(`status ${handle}`), "manager-alias")).run?.bossRunId, created.run!.bossRunId);
    assert.equal((await store.execute(parseBossCommand(`pause ${handle}`), "manager-alias")).run?.state, "paused");
    store.setHandlePrefix("changed");
    assert.equal((await store.execute(parseBossCommand(`status ${handle}`), "manager-alias")).run?.handle, handle, "stored handles do not change with later configuration");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trusted-local Boss supports pause, resume, proof snapshot, and cancel", async () => {
  const { dir, store } = await fixture();
  try {
    const created = await store.execute(parseBossCommand("create coordinate agents"), "manager-session-2");
    const id = created.run!.bossRunId;
    assert.equal((await store.execute(parseBossCommand(`pause ${id}`), "manager-session-2")).run?.state, "paused");
    assert.equal((await store.execute(parseBossCommand(`resume ${id}`), "manager-session-2")).run?.state, "active");
    const proof = await store.execute(parseBossCommand(`proof ${id}`), "manager-session-2");
    assert.match(proof.message, /adversary must be assigned/i);
    assert.equal(proof.run?.proofPackets.length, 0);
    assert.equal((await store.execute(parseBossCommand(`cancel ${id}`), "manager-session-2")).run?.state, "cancelled");
    const status = await store.execute(parseBossCommand(`status ${id}`), "manager-session-2");
    assert.equal(status.run?.state, "cancelled");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trusted-local Boss permits concurrent open runs and rejects premature approvals", async () => {
  const { dir, store } = await fixture();
  try {
    const created = await store.execute(parseBossCommand("create first goal"), "manager-session-3");
    const second = await store.execute(parseBossCommand("create second goal"), "manager-session-3");
    assert.notEqual(second.run?.bossRunId, created.run?.bossRunId);
    const owned = await store.execute(parseBossCommand("status"), "manager-session-3");
    assert.deepEqual(owned.runs?.map((run) => run.goal), ["second goal", "first goal"]);
    assert.ok(owned.message.indexOf("second goal") < owned.message.indexOf("first goal"));
    await assert.rejects(store.execute(parseBossCommand(`approve ${created.run!.bossRunId} looks good`), "manager-session-3"), /proof packet/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trusted-local Boss owned status payload uses bossRunId as the deterministic timestamp tie-breaker", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boss-trusted-local-summary-tie-"));
  const store = new TrustedLocalBossStore(join(dir, "runs.json"), () => new Date(1_700_000_000_000));
  try {
    const first = await store.execute(parseBossCommand("create equal timestamp first"), "controller-tie");
    const second = await store.execute(parseBossCommand("create equal timestamp second"), "controller-tie");
    const expectedIds = [first.run!.bossRunId, second.run!.bossRunId].sort((left, right) => left.localeCompare(right));
    const owned = await store.execute(parseBossCommand("status"), "controller-tie");
    assert.deepEqual(owned.runs?.map((run) => run.bossRunId), expectedIds);
    assert.ok(owned.message.indexOf(expectedIds[0]) < owned.message.indexOf(expectedIds[1]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trusted-local Boss serializes concurrent creates across Controllers and lists only owned runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boss-trusted-local-concurrent-"));
  const path = join(dir, "runs.json");
  let tick = 0;
  const now = () => new Date(1_700_000_000_000 + tick++);
  const firstStore = new TrustedLocalBossStore(path, now);
  const secondStore = new TrustedLocalBossStore(path, now);
  try {
    const created = await Promise.all([
      firstStore.execute(parseBossCommand("create controller alpha first"), "controller-alpha"),
      secondStore.execute(parseBossCommand("create controller beta first"), "controller-beta"),
      firstStore.execute(parseBossCommand("create controller alpha second"), "controller-alpha"),
    ]);
    assert.equal(new Set(created.map((result) => result.run?.bossRunId)).size, 3);

    const alpha = await secondStore.execute(parseBossCommand("status"), "controller-alpha");
    const beta = await firstStore.execute(parseBossCommand("status"), "controller-beta");
    assert.deepEqual(alpha.runs?.map((run) => run.goal).sort(), ["controller alpha first", "controller alpha second"]);
    assert.deepEqual(beta.runs?.map((run) => run.goal), ["controller beta first"]);
    assert.doesNotMatch(alpha.message, /controller beta first/);
    assert.doesNotMatch(beta.message, /controller alpha/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trusted-local Boss denies cross-Controller detail and mutations before disclosure", async () => {
  const { dir, store } = await fixture();
  try {
    const created = await store.execute(parseBossCommand("create controller private goal"), "controller-owner");
    const id = created.run!.bossRunId;
    await assert.rejects(
      store.execute(parseBossCommand(`status ${id}`), "controller-foreign"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /owning Controller session/);
        assert.doesNotMatch(error.message, /controller private goal|active/, "ownership denial must occur before goal/state formatting");
        return true;
      },
    );
    await assert.rejects(store.execute(parseBossCommand(`pause ${id}`), "controller-foreign"), /owning Controller session/);
    await assert.rejects(store.execute(parseBossCommand(`cancel ${id}`), "controller-foreign"), /owning Controller session/);
    const unchanged = await store.execute(parseBossCommand(`status ${id}`), "controller-owner");
    assert.equal(unchanged.run?.state, "active");
    assert.equal(unchanged.run?.cancellation, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trusted-local Boss terminal actions do not disturb sibling runs", async () => {
  const { dir, store } = await fixture();
  try {
    const first = await store.execute(parseBossCommand("create cancel only this run"), "controller-owner");
    const second = await store.execute(parseBossCommand("create keep sibling active"), "controller-owner");
    await store.execute(parseBossCommand(`cancel ${first.run!.bossRunId}`), "controller-owner");
    const sibling = await store.execute(parseBossCommand(`status ${second.run!.bossRunId}`), "controller-owner");
    assert.equal(sibling.run?.state, "active");
    assert.equal(sibling.run?.cancellation, null);
    const owned = await store.execute(parseBossCommand("status"), "controller-owner");
    assert.deepEqual(owned.runs?.map((run) => [run.goal, run.state]), [
      ["keep sibling active", "active"],
      ["cancel only this run", "cancelled"],
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trusted-local Boss reads v1 state and migrates it on the next write", async () => {
  const { dir, store } = await fixture();
  const path = join(dir, "runs.json");
  try {
    const created = await store.execute(parseBossCommand("create legacy compatible run"), "controller-legacy");
    const current = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({
      version: "orc.boss-trusted-local.v1",
      revision: current.revision,
      currentRunId: created.run!.bossRunId,
      runs: current.runs,
    }));

    const reopened = new TrustedLocalBossStore(path);
    assert.equal((await reopened.execute(parseBossCommand(`status ${created.run!.bossRunId}`), "controller-legacy")).run?.goal, "legacy compatible run");
    assert.equal(JSON.parse(await readFile(path, "utf8")).version, "orc.boss-trusted-local.v1", "read-only status keeps the compatible v1 file intact");
    await reopened.execute(parseBossCommand("create migrated sibling run"), "controller-legacy");
    const migrated = JSON.parse(await readFile(path, "utf8"));
    assert.equal(migrated.version, "orc.boss-trusted-local.v7");
    assert.equal(migrated.currentRunId, undefined);
    assert.equal(migrated.runs[0].version, "orc.boss-trusted-local.v5");
    assert.equal(migrated.runs[0].resource, null);
    assert.equal(migrated.runs.length, 2);
    assert.deepEqual((await readdir(dir)).filter((entry) => entry.includes(".tmp-")), [], "atomic rename leaves no partial migration file");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trusted-local Boss reads v3 activity state and upgrades it without inventing a bind timestamp", async () => {
  const { dir, store } = await fixture();
  const path = join(dir, "runs.json");
  try {
    const created = await store.execute(parseBossCommand("create migrate pre-bind-anchor state"), "controller-v3-migration");
    await store.recordManagerStarted(created.run!.bossRunId, { ...managerWorker(created.run!.bossRunId), managerSessionId: "controller-v3-migration" });
    const legacy = JSON.parse(await readFile(path, "utf8"));
    legacy.version = "orc.boss-trusted-local.v3";
    delete legacy.runs[0].assignments[0].workerBoundAt;
    await writeFile(path, JSON.stringify(legacy));

    const reopened = new TrustedLocalBossStore(path);
    const status = await reopened.execute(parseBossCommand(`status ${created.run!.bossRunId}`), "controller-v3-migration");
    const legacyCommunication = status.communication?.find((entry) => entry.role === "manager");
    assert.equal(legacyCommunication?.authenticatedCommunicationDeadlineAt, null);
    assert.equal(legacyCommunication?.communicationStatus, "deadline_unavailable", "legacy state does not invent a mutable deadline anchor");
    assert.equal(JSON.parse(await readFile(path, "utf8")).version, "orc.boss-trusted-local.v3", "read-only status preserves compatible legacy state");
    await reopened.recordControlDelivery(created.run!.bossRunId, "manager", "pause-notice");
    const afterControl = await reopened.execute(parseBossCommand(`status ${created.run!.bossRunId}`), "controller-v3-migration");
    assert.equal(afterControl.communication?.find((entry) => entry.role === "manager")?.communicationStatus, "deadline_unavailable", "Controller controls cannot mint or reset a legacy deadline");
    const migrated = JSON.parse(await readFile(path, "utf8"));
    assert.equal(migrated.version, "orc.boss-trusted-local.v7");
    assert.equal(migrated.runs[0].version, "orc.boss-trusted-local.v5");
    assert.equal(migrated.runs[0].resource, null, "migration does not invent a canonical resource");
    assert.equal(migrated.runs[0].acceptanceRevision, null, "migration does not invent an acceptance revision");
    assert.equal(migrated.runs[0].currentFreeze, null, "migration does not invent a freeze");
    assert.equal(migrated.runs[0].assignments[0].workerBoundAt, undefined, "migration does not invent a historical bind timestamp");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trusted-local Boss migrates v6/v4 proof packets with explicit unavailable bindings", async () => {
  const { dir, store } = await fixture();
  const path = join(dir, "runs.json");
  try {
    const { created, fingerprint } = await createFrozenRun(store, "controller-v4-proof-migration", "preserve legacy proof honestly");
    const bossRunId = created.run!.bossRunId;
    await store.recordManagerStarted(bossRunId, managerWorker(bossRunId));
    await store.execute(parseBossCommand(`proof ${bossRunId}`), "controller-v4-proof-migration");
    const reviewer = { ...managerWorker(bossRunId), id: `boss-adversary-${bossRunId.slice(-12)}`, runId: "legacy-reviewer", workerIncarnationId: "legacy-reviewer", role: "challenger" };
    await store.recordReviewerStarted(bossRunId, reviewer);
    await store.execute(parseBossCommand(`proof ${bossRunId}`), "controller-v4-proof-migration", fingerprint);

    const legacy = JSON.parse(await readFile(path, "utf8"));
    legacy.version = "orc.boss-trusted-local.v6";
    legacy.runs[0].version = "orc.boss-trusted-local.v4";
    for (const field of ["freezeRevision", "acceptanceRevision", "designRevision", "resourceRevision", "fingerprintSha256"]) delete legacy.runs[0].proofPackets[0][field];
    await writeFile(path, JSON.stringify(legacy));

    const reopened = new TrustedLocalBossStore(path);
    const status = await reopened.execute(parseBossCommand(`status ${bossRunId}`), "controller-v4-proof-migration");
    assert.deepEqual(
      [status.run!.proofPackets[0].freezeRevision, status.run!.proofPackets[0].acceptanceRevision, status.run!.proofPackets[0].designRevision, status.run!.proofPackets[0].resourceRevision, status.run!.proofPackets[0].fingerprintSha256],
      [null, null, null, null, null],
      "migration must not invent bindings for pre-binding proof evidence",
    );
    await assert.rejects(reopened.recordProofDelivery(bossRunId, status.run!.proofPackets[0].proofPacketId, fingerprint), /exact current freeze and fingerprint revisions/);
    await reopened.execute(parseBossCommand(`pause ${bossRunId}`), "controller-v4-proof-migration");
    const migrated = JSON.parse(await readFile(path, "utf8"));
    assert.equal(migrated.version, "orc.boss-trusted-local.v7");
    assert.equal(migrated.runs[0].version, "orc.boss-trusted-local.v5");
    assert.equal(migrated.runs[0].proofPackets[0].fingerprintSha256, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trusted-local Boss refuses future schemas and freeze projections not derived from the audit ledger", async () => {
  const first = await fixture();
  try {
    await first.store.execute(parseBossCommand("create reject future schema"), "controller-schema-gate");
    const path = join(first.dir, "runs.json");
    const future = JSON.parse(await readFile(path, "utf8"));
    future.version = "orc.boss-trusted-local.v999";
    await writeFile(path, JSON.stringify(future));
    await assert.rejects(new TrustedLocalBossStore(path).execute(parseBossCommand("status"), "controller-schema-gate"), /invalid metadata/);
  } finally {
    await rm(first.dir, { recursive: true, force: true });
  }

  const second = await fixture();
  try {
    const { created } = await createFrozenRun(second.store, "controller-ledger-gate", "derive freeze from ledger");
    const path = join(second.dir, "runs.json");
    const malformed = JSON.parse(await readFile(path, "utf8"));
    malformed.runs[0].currentFreeze.authorizedBySessionId = "participant-self-declaration";
    await writeFile(path, JSON.stringify(malformed));
    await assert.rejects(new TrustedLocalBossStore(path).execute(parseBossCommand(`status ${created.run!.bossRunId}`), "controller-ledger-gate"), /not derived from accepted Controller transitions/);
  } finally {
    await rm(second.dir, { recursive: true, force: true });
  }
});

test("trusted-local Boss assigns deterministic handles while migrating v2 run records", async () => {
  const { dir, store } = await fixture();
  const path = join(dir, "runs.json");
  try {
    const created = await store.execute(parseBossCommand("create pre-handle run"), "controller-handle-migration");
    const legacy = JSON.parse(await readFile(path, "utf8"));
    legacy.version = "orc.boss-trusted-local.v2";
    legacy.runs[0].version = "orc.boss-trusted-local.v1";
    delete legacy.runs[0].handle;
    delete legacy.runs[0].resource;
    delete legacy.runs[0].acceptanceRevision;
    delete legacy.runs[0].designRevision;
    delete legacy.runs[0].freezeTransitions;
    delete legacy.runs[0].currentFreeze;
    for (const assignment of legacy.runs[0].assignments) delete assignment.resourceRevision;
    await writeFile(path, JSON.stringify(legacy));

    const reopened = new TrustedLocalBossStore(path, undefined, "legacy");
    const migratedHandle = deterministicBossRunHandle(created.run!.bossRunId, "legacy");
    assert.equal((await reopened.execute(parseBossCommand(`status ${migratedHandle}`), "controller-handle-migration")).run?.handle, migratedHandle);
    await reopened.execute(parseBossCommand("create migration writer"), "controller-handle-migration");
    const migrated = JSON.parse(await readFile(path, "utf8"));
    assert.equal(migrated.version, "orc.boss-trusted-local.v7");
    assert.equal(migrated.runs[0].version, "orc.boss-trusted-local.v5");
    assert.equal(migrated.runs[0].resource, null);
    assert.equal(migrated.runs[0].assignments[0].resourceRevision, null);
    assert.equal(migrated.runs[0].handle, migratedHandle);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trusted-local Boss records Manager staffing and lifecycle changes from ordinary fleet state", async () => {
  const { dir, store } = await fixture();
  try {
    const created = await store.execute(parseBossCommand("create staff and supervise"), "manager-session-5");
    const worker = { ...managerWorker(created.run!.bossRunId), managerSessionId: created.run!.managerSessionId };
    const staffed = await store.recordManagerStarted(created.run!.bossRunId, worker);
    assert.equal(staffed.assignments[0].state, "assigned");
    assert.equal(staffed.assignments[0].workerId, worker.id);
    assert.equal(staffed.lifecycle.at(-1)?.workerState, "ready");

    worker.state = "working";
    assert.equal(await store.synchronizeWorkers([worker]), true);
    assert.equal(await store.synchronizeWorkers([worker]), false, "unchanged fleet state must not duplicate lifecycle observations");
    const status = await store.execute(parseBossCommand(`status ${created.run!.bossRunId}`), "manager-session-5");
    assert.match(status.message, new RegExp(`manager revision 1: assigned; worker=${worker.id}`));
    assert.match(status.message, /assignment delivery: launch-mandate delivered/);
    assert.match(status.message, new RegExp(`${worker.id} working`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trusted-local Boss separates transport, acknowledgement, communication, and substantive checkpoints", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boss-trusted-local-communication-"));
  let now = 1_700_000_000_000;
  const store = new TrustedLocalBossStore(join(dir, "runs.json"), () => new Date(now));
  try {
    const created = await store.execute(parseBossCommand("create report honest communication evidence"), "manager-activity");
    const worker: WorkerRecord = {
      ...managerWorker(created.run!.bossRunId),
      managerSessionId: "manager-activity",
      createdAt: now,
      updatedAt: now,
      lastWorkerActivityAt: now,
    };
    await store.recordManagerStarted(created.run!.bossRunId, worker);
    assert.equal(await store.synchronizeWorkers([worker]), true, "first fleet synchronization records the ordinary lifecycle detail change");

    const pending = await store.execute(parseBossCommand(`status ${created.run!.bossRunId}`), "manager-activity");
    const pendingManager = pending.communication?.find((entry) => entry.role === "manager");
    assert.equal(pendingManager?.workerState, "ready");
    assert.equal(pendingManager?.transportProcessReadiness, "observed");
    assert.equal(pendingManager?.assignmentAcknowledgementEvidence, "unavailable");
    assert.equal(pendingManager?.assignmentAcknowledgedAt, null);
    assert.equal(pendingManager?.authenticatedCommunicationEvidence, "none_observed", "the launch-time worker timestamp is only a baseline");
    assert.equal(pendingManager?.substantiveCheckpointEvidence, "unavailable");
    assert.equal(pendingManager?.substantiveCheckpointObservedAt, null);
    assert.equal(pendingManager?.communicationStatus, "awaiting_authenticated_communication");
    assert.match(pending.message, /process\/transport state only; it does not prove productive task activity/);
    assert.match(pending.message, /assignment-acknowledgement=unavailable/);
    assert.match(pending.message, /substantive-checkpoint=unavailable/);
    const originalDeadline = pendingManager?.authenticatedCommunicationDeadlineAt;
    now += 60_000;
    await store.recordControlDelivery(created.run!.bossRunId, "manager", "pause-notice");
    await store.recordControlDelivery(created.run!.bossRunId, "manager", "resume-notice");
    const afterControls = await store.execute(parseBossCommand(`status ${created.run!.bossRunId}`), "manager-activity");
    assert.equal(afterControls.communication?.find((entry) => entry.role === "manager")?.authenticatedCommunicationDeadlineAt, originalDeadline, "Controller-side controls cannot reset the worker communication deadline");

    now += TRUSTED_LOCAL_BOSS_AUTHENTICATED_COMMUNICATION_DEADLINE_MS - 60_000;
    const stale = await store.execute(parseBossCommand(`status ${created.run!.bossRunId}`), "manager-activity");
    assert.equal(stale.communication?.find((entry) => entry.role === "manager")?.communicationStatus, "authenticated_communication_stale");
    assert.match(stale.message, /communication-status=authenticated-communication-stale/);

    // Manual renew/adopt paths advance only the general lease timestamp.
    worker.lastWorkerActivityAt = now + 1;
    assert.equal(await store.synchronizeWorkers([worker]), false);
    const stillStale = await store.execute(parseBossCommand(`status ${created.run!.bossRunId}`), "manager-activity");
    assert.equal(stillStale.communication?.find((entry) => entry.role === "manager")?.communicationStatus, "authenticated_communication_stale");

    worker.lastAuthenticatedIntercomActivityAt = now + 2;
    assert.equal(await store.synchronizeWorkers([worker]), true);
    const active = await store.execute(parseBossCommand(`status ${created.run!.bossRunId}`), "manager-activity");
    const activeManager = active.communication?.find((entry) => entry.role === "manager");
    assert.equal(activeManager?.authenticatedCommunicationEvidence, "authenticated_intercom");
    assert.equal(activeManager?.authenticatedCommunicationObservedAt, new Date(now + 2).toISOString());
    assert.equal(activeManager?.communicationStatus, "authenticated_communication_observed");
    assert.equal(activeManager?.assignmentAcknowledgementEvidence, "unavailable", "authenticated traffic is not inferred to acknowledge an assignment");
    assert.equal(activeManager?.substantiveCheckpointEvidence, "unavailable", "authenticated traffic is not inferred to be substantive");
    assert.match(active.message, /authenticated worker Intercom traffic proves communication only/);

    const summary = await store.execute(parseBossCommand("status"), "manager-activity");
    assert.match(summary.message, /communication=authenticated_communication_observed,not_assigned/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trusted-local Boss revisions Worker and Scout assignments with ordinary delivery results and controls", async () => {
  const { dir, store } = await fixture();
  try {
    const created = await store.execute(parseBossCommand("create staff the delivery ledger"), "manager-session-staff");
    const worker = { ...managerWorker(created.run!.bossRunId), id: `boss-worker-${created.run!.bossRunId.slice(-12)}`, runId: "worker-role-incarnation", workerIncarnationId: "worker-role-incarnation", role: "worker" };
    const scout = { ...managerWorker(created.run!.bossRunId), id: `boss-scout-${created.run!.bossRunId.slice(-12)}`, runId: "scout-role-incarnation", workerIncarnationId: "scout-role-incarnation", role: "scout" };
    await store.recordAssignmentStartedForRole(created.run!.bossRunId, "worker", worker);
    const staffed = await store.recordAssignmentStartedForRole(created.run!.bossRunId, "scout", scout);
    assert.equal(staffed.deliveries.length, 2);
    assert.deepEqual(staffed.assignmentResults.map((result) => result.outcome), ["accepted", "accepted"]);
    assert.deepEqual(staffed.assignments.filter((assignment) => assignment.role === "worker" || assignment.role === "scout").map((assignment) => assignment.revision), [1, 1]);

    await store.recordControlDelivery(created.run!.bossRunId, "worker", "pause-notice");
    const controlled = await store.recordControlDelivery(created.run!.bossRunId, "scout", "pause-notice", new Error("local relay unavailable"));
    assert.equal(controlled.assignments.find((assignment) => assignment.role === "worker")?.revision, 2);
    assert.equal(controlled.assignments.find((assignment) => assignment.role === "scout")?.revision, 2);
    assert.equal(controlled.deliveries.at(-1)?.state, "failed");
    assert.equal(controlled.assignmentResults.at(-1)?.outcome, "failed");
    assert.match(controlled.assignmentResults.at(-1)?.detail ?? "", /local relay unavailable/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trusted-local Boss fails the run when Manager launch or lifecycle fails", async () => {
  const first = await fixture();
  try {
    const created = await first.store.execute(parseBossCommand("create fail launch safely"), "manager-session-6");
    const failed = await first.store.recordManagerFailed(created.run!.bossRunId, new Error("no launch profile"));
    assert.equal(failed.state, "failed");
    assert.equal(failed.assignments[0].state, "failed");
    assert.match(failed.assignments[0].lastError ?? "", /no launch profile/);
    const replacement = await first.store.execute(parseBossCommand("create retry after terminal failure"), "manager-session-6");
    assert.equal(replacement.run?.state, "active");
  } finally {
    await rm(first.dir, { recursive: true, force: true });
  }

  const second = await fixture();
  try {
    const created = await second.store.execute(parseBossCommand("create observe failure"), "manager-session-7");
    const worker = { ...managerWorker(created.run!.bossRunId), managerSessionId: created.run!.managerSessionId };
    await second.store.recordManagerStarted(created.run!.bossRunId, worker);
    worker.state = "failed";
    worker.lastError = "worker process exited";
    await second.store.synchronizeWorkers([worker]);
    const status = await second.store.execute(parseBossCommand(`status ${created.run!.bossRunId}`), "manager-session-7");
    assert.equal(status.run?.state, "failed");
    assert.equal(status.run?.assignments[0].state, "failed");
    assert.match(status.message, /worker process exited/);
  } finally {
    await rm(second.dir, { recursive: true, force: true });
  }
});

test("trusted-local Boss stales proof creation, delivery, and decision when the frozen candidate moves", async () => {
  const { dir, store } = await fixture();
  try {
    const { created, fingerprint } = await createFrozenRun(store, "controller-stale-proof", "reject moving evidence");
    const bossRunId = created.run!.bossRunId;
    await store.recordManagerStarted(bossRunId, managerWorker(bossRunId));
    await store.execute(parseBossCommand(`proof ${bossRunId}`), "controller-stale-proof");
    const reviewer = { ...managerWorker(bossRunId), id: `boss-adversary-${bossRunId.slice(-12)}`, runId: "stale-reviewer", workerIncarnationId: "stale-reviewer", role: "challenger" };
    await store.recordReviewerStarted(bossRunId, reviewer);
    const moved = candidateFingerprint(created.run!.resource!, "3".repeat(40));
    await assert.rejects(store.execute(parseBossCommand(`proof ${bossRunId}`), "controller-stale-proof", moved), /stale freeze/);
    const proof = await store.execute(parseBossCommand(`proof ${bossRunId}`), "controller-stale-proof", fingerprint);
    const packet = proof.run!.proofPackets.at(-1)!;
    assert.equal(packet.freezeRevision, 1);
    assert.equal(packet.fingerprintSha256, fingerprint.aggregateSha256);
    assert.equal(packet.acceptanceRevision, 1);
    assert.equal(packet.designRevision, 1);
    assert.equal(packet.resourceRevision, 1);
    await assert.rejects(store.recordProofDelivery(bossRunId, packet.proofPacketId, moved), /stale freeze/);
    await store.recordProofDelivery(bossRunId, packet.proofPacketId, fingerprint);
    await assert.rejects(store.execute(parseBossCommand(`approve ${bossRunId} moved candidate`), "controller-stale-proof", moved), /stale freeze/);
    assert.equal((await store.execute(parseBossCommand(`approve ${bossRunId} exact candidate`), "controller-stale-proof", fingerprint)).run?.state, "approved");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trusted-local Boss stales frozen evidence when resource, acceptance, or design revisions advance", async () => {
  const staffReviewer = async (store: TrustedLocalBossStore, bossRunId: string, controller: string) => {
    await store.recordManagerStarted(bossRunId, managerWorker(bossRunId));
    await store.execute(parseBossCommand(`proof ${bossRunId}`), controller);
    await store.recordReviewerStarted(bossRunId, { ...managerWorker(bossRunId), id: `boss-adversary-${bossRunId.slice(-12)}`, runId: `reviewer-${controller}`, workerIncarnationId: `reviewer-${controller}`, role: "challenger" });
  };

  const resourceCase = await fixture();
  try {
    const controller = "controller-resource-stale";
    const { created, fingerprint } = await createFrozenRun(resourceCase.store, controller, "stale on resource revision");
    await staffReviewer(resourceCase.store, created.run!.bossRunId, controller);
    const advanced = { ...created.run!.resource!, revision: 2, leaseExpiresAt: "2023-11-15T00:13:20.000Z" };
    await resourceCase.store.recordResourceTransition(created.run!.bossRunId, 1, advanced);
    await assert.rejects(resourceCase.store.execute(parseBossCommand(`proof ${created.run!.bossRunId}`), controller, fingerprint), /stale freeze/);
  } finally {
    await rm(resourceCase.dir, { recursive: true, force: true });
  }

  for (const revisionField of ["acceptanceRevision", "designRevision"] as const) {
    const revisionCase = await fixture();
    try {
      const controller = `controller-${revisionField}-stale`;
      const { created, fingerprint } = await createFrozenRun(revisionCase.store, controller, `stale on ${revisionField}`);
      await staffReviewer(revisionCase.store, created.run!.bossRunId, controller);
      const path = join(revisionCase.dir, "runs.json");
      const state = JSON.parse(await readFile(path, "utf8"));
      state.runs[0][revisionField] = 2;
      state.revision += 1;
      await writeFile(path, JSON.stringify(state));
      const reopened = new TrustedLocalBossStore(path);
      await assert.rejects(reopened.execute(parseBossCommand(`proof ${created.run!.bossRunId}`), controller, fingerprint), /stale freeze/);
    } finally {
      await rm(revisionCase.dir, { recursive: true, force: true });
    }
  }
});

test("trusted-local Boss preservation release never removes a frozen candidate", () => {
  const resource = canonicalResource("boss-22222222-2222-4222-8222-222222222222");
  const preserved = preserveProvisionedBossResource(resource, "authorized freeze remains current");
  assert.equal(preserved.removed, false);
  assert.equal(preserved.dirty, true);
  assert.equal(preserved.resource.revision, 2);
  assert.equal(preserved.resource.leaseState, "released");
  assert.equal(preserved.resource.existence, "verified");
  assert.match(preserved.dirtyStatus ?? "", /freeze remains current/);
});

test("trusted-local Boss binds advisory proof revisions to an assigned adversary decision", async () => {
  const { dir, store } = await fixture();
  try {
    const { created, fingerprint } = await createFrozenRun(store, "manager-session-8", "prove and review");
    await store.recordManagerStarted(created.run!.bossRunId, managerWorker(created.run!.bossRunId));
    const staffing = await store.execute(parseBossCommand(`proof ${created.run!.bossRunId}`), "manager-session-8");
    const reviewer = staffing.run!.assignments.find((assignment) => assignment.role === "adversary")!;
    assert.equal(reviewer.state, "requested");
    assert.equal(staffing.run!.proofPackets.length, 0);
    await assert.rejects(store.execute(parseBossCommand(`approve ${created.run!.bossRunId} premature`), "manager-session-8"), /proof packet/);

    const reviewerWorker = { ...managerWorker(created.run!.bossRunId), id: `boss-adversary-${created.run!.bossRunId.slice(-12)}`, runId: "reviewer-incarnation-test", workerIncarnationId: "reviewer-incarnation-test", role: "challenger" };
    await store.recordReviewerStarted(created.run!.bossRunId, reviewerWorker);
    const proof = await store.execute(parseBossCommand(`proof ${created.run!.bossRunId}`), "manager-session-8", fingerprint);
    assert.equal(proof.run!.proofPackets.at(-1)?.revision, 1);
    assert.match(proof.run!.proofPackets.at(-1)?.snapshotSha256 ?? "", /^[0-9a-f]{64}$/);
    assert.notEqual(proof.run!.deliveries.at(-1)?.kind, "proof-review", "proof creation must not claim delivery before the relay outcome");
    const proofPacketId = proof.run!.proofPackets.at(-1)!.proofPacketId;
    const delivered = await store.recordProofDelivery(created.run!.bossRunId, proofPacketId, fingerprint);
    assert.equal(delivered.deliveries.at(-1)?.kind, "proof-review");
    assert.equal(delivered.deliveries.at(-1)?.proofPacketId, proofPacketId);
    const approved = await store.execute(parseBossCommand(`approve ${created.run!.bossRunId} exact revision reviewed`), "manager-session-8", fingerprint);
    assert.equal(approved.run?.state, "approved");
    assert.equal(approved.run?.decisions[0].proofRevision, 1);
    assert.equal(approved.run?.decisions[0].reviewerWorkerId, reviewerWorker.id);
    assert.match(approved.message, /latest decision: approved on proof revision 1/);
    const cleanupRetry = await store.execute(parseBossCommand(`approve ${created.run!.bossRunId} retry exact terminal cleanup`), "manager-session-8", fingerprint);
    assert.equal(cleanupRetry.run?.state, "approved");
    assert.equal(cleanupRetry.run?.decisions.length, 1, "cleanup retry must not create a second decision");
    assert.match(cleanupRetry.title, /cleanup retry/);
    assert.match(cleanupRetry.message, /participant shutdown and canonical resource cleanup may be retried/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

 test("trusted-local Boss fences session races and preserves terminal lifecycle", async () => {
  const { dir, store } = await fixture();
  try {
    const created = await store.execute(parseBossCommand("create fence the owner"), "manager-session-owner");
    await assert.rejects(store.execute(parseBossCommand(`cancel ${created.run!.bossRunId}`), "manager-session-foreign"), /owning Controller session/);
    const cancelled = await store.execute(parseBossCommand(`cancel ${created.run!.bossRunId}`), "manager-session-owner");
    assert.equal(cancelled.run?.state, "cancelled");
    await assert.rejects(store.recordManagerStarted(created.run!.bossRunId, managerWorker(created.run!.bossRunId)), /cannot start after run cancelled/);
    const unchanged = await store.recordManagerFailed(created.run!.bossRunId, new Error("late launch completion"));
    assert.equal(unchanged.state, "cancelled");
    assert.equal(unchanged.assignments[0].state, "cancelled");

    const { created: failedRun, fingerprint } = await createFrozenRun(store, "manager-session-owner", "stale proof terminal fence");
    await store.recordManagerStarted(failedRun.run!.bossRunId, managerWorker(failedRun.run!.bossRunId));
    await store.execute(parseBossCommand(`proof ${failedRun.run!.bossRunId}`), "manager-session-owner");
    const reviewerWorker = { ...managerWorker(failedRun.run!.bossRunId), id: `boss-adversary-${failedRun.run!.bossRunId.slice(-12)}`, runId: "terminal-reviewer-incarnation", workerIncarnationId: "terminal-reviewer-incarnation", role: "challenger" };
    await store.recordReviewerStarted(failedRun.run!.bossRunId, reviewerWorker);
    const terminalProof = await store.execute(parseBossCommand(`proof ${failedRun.run!.bossRunId}`), "manager-session-owner", fingerprint);
    await store.recordProofDelivery(failedRun.run!.bossRunId, terminalProof.run!.proofPackets.at(-1)!.proofPacketId, fingerprint);
    await store.recordManagerFailed(failedRun.run!.bossRunId, new Error("manager died after proof"));
    await assert.rejects(store.recordAssignmentStartedForRole(failedRun.run!.bossRunId, "worker", { ...managerWorker(failedRun.run!.bossRunId), id: "late-worker", runId: "late-worker-incarnation", workerIncarnationId: "late-worker-incarnation", role: "worker" }), /cannot start after run failed/);
    await assert.rejects(store.recordAssignmentStartedForRole(failedRun.run!.bossRunId, "scout", { ...managerWorker(failedRun.run!.bossRunId), id: "late-scout", runId: "late-scout-incarnation", workerIncarnationId: "late-scout-incarnation", role: "scout" }), /cannot start after run failed/);
    await assert.rejects(store.recordReviewerStarted(failedRun.run!.bossRunId, { ...managerWorker(failedRun.run!.bossRunId), id: "late-adversary", runId: "late-adversary-incarnation", workerIncarnationId: "late-adversary-incarnation", role: "challenger" }), /cannot start after run failed/);
    await assert.rejects(store.execute(parseBossCommand(`approve ${failedRun.run!.bossRunId} stale proof`), "manager-session-owner"), /Cannot approve Boss run from failed/);
    const terminal = await store.execute(parseBossCommand(`status ${failedRun.run!.bossRunId}`), "manager-session-owner");
    assert.equal(terminal.run?.state, "failed");
    assert.equal(terminal.run?.deliveries.filter((delivery) => delivery.targetWorkerId.startsWith("late-")).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

 test("trusted-local Boss rejects writer/parser bound violations without corrupting state", async () => {
  const { dir, store } = await fixture();
  try {
    await assert.rejects(store.execute({ action: "create", goal: "x".repeat(10_001) }, "manager-session-bounds"), /exceeds 10000/);
    const { created, fingerprint } = await createFrozenRun(store, "manager-session-bounds", "bounded proof ledger");
    await store.recordManagerStarted(created.run!.bossRunId, managerWorker(created.run!.bossRunId));
    await store.execute(parseBossCommand(`proof ${created.run!.bossRunId}`), "manager-session-bounds");
    const reviewerWorker = { ...managerWorker(created.run!.bossRunId), id: `boss-adversary-${created.run!.bossRunId.slice(-12)}`, runId: "bounds-reviewer-incarnation", workerIncarnationId: "bounds-reviewer-incarnation", role: "challenger" };
    await store.recordReviewerStarted(created.run!.bossRunId, reviewerWorker);
    for (let index = 0; index < 64; index += 1) {
      const proof = await store.execute(parseBossCommand(`proof ${created.run!.bossRunId}`), "manager-session-bounds", fingerprint);
      await store.recordProofDelivery(created.run!.bossRunId, proof.run!.proofPackets.at(-1)!.proofPacketId, fingerprint);
    }
    await assert.rejects(store.execute(parseBossCommand(`proof ${created.run!.bossRunId}`), "manager-session-bounds", fingerprint), /limit 64 reached/);
    const status = await store.execute(parseBossCommand(`status ${created.run!.bossRunId}`), "manager-session-bounds");
    assert.equal(status.run?.proofPackets.length, 64);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

 test("trusted-local Boss retries transient adversary staffing failure with a new assignment revision", async () => {
  const { dir, store } = await fixture();
  try {
    const { created, fingerprint } = await createFrozenRun(store, "manager-session-reviewer-retry", "retry transient reviewer launch");
    await store.recordManagerStarted(created.run!.bossRunId, managerWorker(created.run!.bossRunId));
    await store.execute(parseBossCommand(`proof ${created.run!.bossRunId}`), "manager-session-reviewer-retry");
    const failed = await store.recordReviewerFailed(created.run!.bossRunId, new Error("temporary launch profile outage"));
    assert.equal(failed.assignments.find((assignment) => assignment.role === "adversary")?.state, "failed");
    const retry = await store.execute(parseBossCommand(`proof ${created.run!.bossRunId}`), "manager-session-reviewer-retry");
    const retriedAssignment = retry.run!.assignments.find((assignment) => assignment.role === "adversary")!;
    assert.equal(retriedAssignment.state, "requested");
    assert.equal(retriedAssignment.revision, 2);
    assert.equal(retriedAssignment.lastError, undefined);
    const reviewer = { ...managerWorker(created.run!.bossRunId), id: `boss-adversary-${created.run!.bossRunId.slice(-12)}`, runId: "retry-reviewer-incarnation", workerIncarnationId: "retry-reviewer-incarnation", role: "challenger" };
    await store.recordReviewerStarted(created.run!.bossRunId, reviewer);
    const proof = await store.execute(parseBossCommand(`proof ${created.run!.bossRunId}`), "manager-session-reviewer-retry", fingerprint);
    await store.recordProofDelivery(created.run!.bossRunId, proof.run!.proofPackets.at(-1)!.proofPacketId, fingerprint);
    assert.equal((await store.execute(parseBossCommand(`approve ${created.run!.bossRunId} retry reviewed`), "manager-session-reviewer-retry", fingerprint)).run?.state, "approved");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trusted-local Boss keeps proof delivery live at ledger capacity and retries the same revision", async () => {
  const { dir, store } = await fixture();
  try {
    const { created, fingerprint } = await createFrozenRun(store, "manager-session-proof-cap", "fill bounded delivery ledger");
    await store.recordManagerStarted(created.run!.bossRunId, managerWorker(created.run!.bossRunId));
    await store.execute(parseBossCommand(`proof ${created.run!.bossRunId}`), "manager-session-proof-cap");
    const reviewer = { ...managerWorker(created.run!.bossRunId), id: `boss-adversary-${created.run!.bossRunId.slice(-12)}`, runId: "cap-reviewer-incarnation", workerIncarnationId: "cap-reviewer-incarnation", role: "challenger" };
    await store.recordReviewerStarted(created.run!.bossRunId, reviewer);
    for (let index = 0; index < 254; index += 1) await store.recordControlDelivery(created.run!.bossRunId, "manager", index % 2 === 0 ? "pause-notice" : "resume-notice");
    const full = await store.execute(parseBossCommand(`status ${created.run!.bossRunId}`), "manager-session-proof-cap");
    assert.equal(full.run?.deliveries.length, 256);
    const proof = await store.execute(parseBossCommand(`proof ${created.run!.bossRunId}`), "manager-session-proof-cap", fingerprint);
    const packet = proof.run!.proofPackets.at(-1)!;
    assert.equal(proof.run?.deliveries.length, 255, "proof creation reserves capacity for its required delivery/result");
    await store.recordProofDelivery(created.run!.bossRunId, packet.proofPacketId, fingerprint, new Error("relay unavailable"));
    const retry = await store.execute(parseBossCommand(`proof ${created.run!.bossRunId}`), "manager-session-proof-cap", fingerprint);
    assert.equal(retry.run?.proofPackets.at(-1)?.proofPacketId, packet.proofPacketId, "failed delivery retries the same exact proof revision");
    const delivered = await store.recordProofDelivery(created.run!.bossRunId, packet.proofPacketId, fingerprint);
    assert.equal(delivered.deliveries.length, 256);
    assert.equal(delivered.deliveries.at(-1)?.state, "delivered");
    assert.equal((await store.execute(parseBossCommand(`approve ${created.run!.bossRunId} cap-safe review`), "manager-session-proof-cap", fingerprint)).run?.state, "approved");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trusted-local Boss keeps late reviewer assignment live at lifecycle capacity", async () => {
  const { dir, store } = await fixture();
  try {
    const { created, fingerprint } = await createFrozenRun(store, "manager-session-lifecycle-cap", "retain bounded lifecycle liveness");
    const manager = { ...managerWorker(created.run!.bossRunId), managerSessionId: created.run!.managerSessionId };
    await store.recordManagerStarted(created.run!.bossRunId, manager);
    for (let index = 0; index < 255; index += 1) {
      manager.state = index % 2 === 0 ? "working" : "ready";
      assert.equal(await store.synchronizeWorkers([manager]), true);
    }
    const full = await store.execute(parseBossCommand(`status ${created.run!.bossRunId}`), "manager-session-lifecycle-cap");
    assert.equal(full.run?.lifecycle.length, 256);
    const managerCommunication = full.communication?.find((entry) => entry.role === "manager");
    assert.equal(managerCommunication?.communicationStatus, "awaiting_authenticated_communication", "lifecycle pruning cannot erase the assignment's durable communication deadline anchor");
    assert.ok(managerCommunication?.authenticatedCommunicationDeadlineAt);
    await store.execute(parseBossCommand(`proof ${created.run!.bossRunId}`), "manager-session-lifecycle-cap");
    const reviewer = { ...managerWorker(created.run!.bossRunId), id: `boss-adversary-${created.run!.bossRunId.slice(-12)}`, runId: "lifecycle-cap-reviewer-incarnation", workerIncarnationId: "lifecycle-cap-reviewer-incarnation", role: "challenger" };
    const staffed = await store.recordReviewerStarted(created.run!.bossRunId, reviewer);
    assert.equal(staffed.assignments.find((assignment) => assignment.role === "adversary")?.state, "assigned");
    assert.equal(staffed.lifecycle.length, 256);
    assert.equal(staffed.lifecycle.at(-1)?.workerId, reviewer.id);
    const proof = await store.execute(parseBossCommand(`proof ${created.run!.bossRunId}`), "manager-session-lifecycle-cap", fingerprint);
    await store.recordProofDelivery(created.run!.bossRunId, proof.run!.proofPackets.at(-1)!.proofPacketId, fingerprint);
    assert.equal((await store.execute(parseBossCommand(`approve ${created.run!.bossRunId} lifecycle cap reviewed`), "manager-session-lifecycle-cap", fingerprint)).run?.state, "approved");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trusted-local Boss durably recovers the spawn-to-assignment binding gap across store instances", async () => {
  const dir = await mkdtemp(join(tmpdir(), "boss-binding-recovery-"));
  const path = join(dir, "runs.json");
  const first = new TrustedLocalBossStore(path);
  const second = new TrustedLocalBossStore(path);
  try {
    const created = await first.execute(parseBossCommand("create recover durable binding"), "controller-binding-owner");
    const suffix = created.run!.bossRunId.slice(-12);
    const worker = {
      ...managerWorker(created.run!.bossRunId, "ready"),
      id: `boss-manager-${suffix}`,
      managerSessionId: created.run!.managerSessionId,
      runId: "durable-binding-incarnation",
      workerIncarnationId: "durable-binding-incarnation",
    };
    const foreignOwned = { ...worker, managerSessionId: "foreign-controller" };
    await assert.rejects(first.recordManagerStarted(created.run!.bossRunId, foreignOwned), /identity, ownership, or run binding/);
    await assert.rejects(first.recordManagerStarted(created.run!.bossRunId, { ...worker, owned: false }), /identity, ownership, or run binding/);
    await assert.rejects(first.recordManagerStarted(created.run!.bossRunId, { ...worker, id: `boss-worker-${suffix}` }), /identity, ownership, or run binding/);
    assert.equal(await first.recoverRequestedWorkerBindings([foreignOwned]), false);
    assert.equal((await first.findOrphanedWorkers([foreignOwned])).length, 0, "foreign Controller ownership is never contained or rebound by this run");
    assert.equal(await first.synchronizeWorkers([foreignOwned]), false, "foreign ownership cannot wedge requested-run synchronization");
    const unowned = { ...worker, owned: false };
    assert.equal(await first.recoverRequestedWorkerBindings([unowned]), false);
    assert.equal((await first.findOrphanedWorkers([unowned])).length, 0, "unowned records are outside Boss containment authority");
    assert.equal(await first.synchronizeWorkers([unowned]), false, "unowned records cannot wedge requested-run synchronization");

    const recovered = await Promise.all([
      first.recoverRequestedWorkerBindings([worker]),
      second.recoverRequestedWorkerBindings([worker]),
    ]);
    assert.equal(recovered.some(Boolean), true);
    const status = await first.execute(parseBossCommand(`status ${created.run!.bossRunId}`), "controller-binding-owner");
    assert.equal(status.run?.assignments[0].state, "assigned");
    assert.equal(status.run?.assignments[0].workerIncarnationId, "durable-binding-incarnation");
    assert.equal(status.run?.deliveries.filter((delivery) => delivery.kind === "launch-mandate").length, 1);
    assert.equal(status.run?.lifecycle.filter((entry) => entry.workerIncarnationId === "durable-binding-incarnation").length, 1);
    assert.equal((await first.findOrphanedWorkers([worker])).length, 0);
    assert.equal(await first.recoverRequestedWorkerBindings([worker]), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trusted-local Boss recovery skips terminal runs so orphan containment remains available", async () => {
  const { dir, store } = await fixture();
  try {
    const created = await store.execute(parseBossCommand("create fail before worker binding"), "controller-terminal-recovery");
    await store.recordManagerFailed(created.run!.bossRunId, new Error("manager launch failed"));
    const taggedWorker = {
      ...managerWorker(created.run!.bossRunId, "ready"),
      id: `boss-worker-${created.run!.bossRunId.slice(-12)}`,
      role: "worker",
      runId: "terminal-requested-worker-incarnation",
      workerIncarnationId: "terminal-requested-worker-incarnation",
    };
    assert.equal(await store.recoverRequestedWorkerBindings([taggedWorker]), false);
    const orphans = await store.findOrphanedWorkers([taggedWorker]);
    assert.equal(orphans.length, 1);
    assert.equal(orphans[0].assignmentRole, "worker");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trusted-local Boss identifies restart-visible uncorrelated Boss workers", async () => {
  const { dir, store } = await fixture();
  try {
    const missingRunWorker = managerWorker("boss-00000000-0000-4000-8000-000000000000", "working");
    const missingRun = await store.findOrphanedWorkers([missingRunWorker]);
    assert.equal(missingRun.length, 1, "Boss-bound workers remain orphans even after their run record is lost");
    assert.equal(missingRun[0].bossRunId, missingRunWorker.bossRunId);
    assert.equal(missingRun[0].managerSessionId, missingRunWorker.managerSessionId);
    assert.equal(missingRun[0].assignmentRole, null);

    const created = await store.execute(parseBossCommand("create contain restart orphan"), "manager-session-orphan");
    await store.execute(parseBossCommand(`proof ${created.run!.bossRunId}`), "manager-session-orphan");
    const orphan = { ...managerWorker(created.run!.bossRunId, "working"), id: `boss-adversary-${created.run!.bossRunId.slice(-12)}`, runId: "orphan-incarnation", workerIncarnationId: "orphan-incarnation", role: "challenger" };
    const found = await store.findOrphanedWorkers([orphan]);
    assert.equal(found.length, 1);
    assert.equal(found[0].assignmentRole, "adversary");
    assert.equal(found[0].managerSessionId, "manager-session-orphan");
    await store.recordOrphanedWorkerContained(created.run!.bossRunId, found[0].assignmentRole, "restart contained exact orphan");
    const status = await store.execute(parseBossCommand(`status ${created.run!.bossRunId}`), "manager-session-orphan");
    assert.equal(status.run?.assignments.find((assignment) => assignment.role === "adversary")?.state, "failed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trusted-local Boss projects missing workers and recovers pending cancellation", async () => {
  const first = await fixture();
  try {
    const created = await first.store.execute(parseBossCommand("create detect missing manager"), "manager-session-missing");
    await first.store.recordManagerStarted(created.run!.bossRunId, managerWorker(created.run!.bossRunId));
    assert.equal(await first.store.synchronizeWorkers([]), true);
    const failed = await first.store.execute(parseBossCommand(`status ${created.run!.bossRunId}`), "manager-session-missing");
    assert.equal(failed.run?.state, "failed");
    assert.equal(failed.run?.assignments[0].state, "failed");
    assert.equal(failed.run?.lifecycle.at(-1)?.workerState, "lost");
  } finally {
    await rm(first.dir, { recursive: true, force: true });
  }

  const second = await fixture();
  try {
    const created = await second.store.execute(parseBossCommand("create recover cancellation"), "manager-session-cancel-recovery");
    const worker = { ...managerWorker(created.run!.bossRunId, "stopped"), managerSessionId: created.run!.managerSessionId };
    await second.store.recordManagerStarted(created.run!.bossRunId, { ...worker, state: "ready" });
    await second.store.execute(parseBossCommand(`cancel ${created.run!.bossRunId}`), "manager-session-cancel-recovery");
    assert.equal(await second.store.synchronizeWorkers([worker]), true);
    const recovered = await second.store.execute(parseBossCommand(`status ${created.run!.bossRunId}`), "manager-session-cancel-recovery");
    assert.equal(recovered.run?.cancellation?.state, "succeeded");
    assert.equal(recovered.run?.assignments[0].state, "cancelled");
  } finally {
    await rm(second.dir, { recursive: true, force: true });
  }

  const third = await fixture();
  try {
    const created = await third.store.execute(parseBossCommand("create preserve cancellation identity conflict"), "manager-session-cancel-conflict");
    const exact = { ...managerWorker(created.run!.bossRunId, "ready"), managerSessionId: created.run!.managerSessionId };
    await third.store.recordManagerStarted(created.run!.bossRunId, exact);
    await third.store.execute(parseBossCommand(`cancel ${created.run!.bossRunId}`), "manager-session-cancel-conflict");
    await third.store.recordCancellationResult(created.run!.bossRunId, new Error("initial stop failed"));
    const conflicting = { ...exact, runId: "conflicting-incarnation", workerIncarnationId: "conflicting-incarnation", state: "working" as const };
    assert.equal((await third.store.findOrphanedWorkers([conflicting])).length, 0, "same-ID assigned-incarnation conflict must not be erased as an orphan");
    await third.store.execute(parseBossCommand(`cancel ${created.run!.bossRunId}`), "manager-session-cancel-conflict");
    await third.store.synchronizeWorkers([conflicting]);
    const pending = await third.store.execute(parseBossCommand(`status ${created.run!.bossRunId}`), "manager-session-cancel-conflict");
    assert.equal(pending.run?.cancellation?.state, "pending");
    assert.equal(pending.run?.assignments[0].state, "assigned");
  } finally {
    await rm(third.dir, { recursive: true, force: true });
  }
});

test("trusted-local Boss records durable Manager cancellation outcomes", async () => {
  const { dir, store } = await fixture();
  try {
    const created = await store.execute(parseBossCommand("create cancel exactly"), "manager-session-9");
    await store.recordManagerStarted(created.run!.bossRunId, managerWorker(created.run!.bossRunId));
    await store.recordAssignmentStartedForRole(created.run!.bossRunId, "worker", { ...managerWorker(created.run!.bossRunId), id: `boss-worker-${created.run!.bossRunId.slice(-12)}`, runId: "cancel-worker-incarnation", workerIncarnationId: "cancel-worker-incarnation", role: "worker" });
    const requested = await store.execute(parseBossCommand(`cancel ${created.run!.bossRunId}`), "manager-session-9");
    assert.equal(requested.run?.cancellation?.state, "pending");
    assert.equal(requested.run?.assignments[0].state, "assigned", "assignment remains bound until the stop outcome is recorded");
    const completed = await store.recordCancellationResult(created.run!.bossRunId);
    assert.equal(completed.cancellation?.state, "succeeded");
    assert.equal(completed.assignments.find((assignment) => assignment.role === "manager")?.state, "cancelled");
    assert.equal(completed.assignments.find((assignment) => assignment.role === "worker")?.state, "cancelled");

    const second = await store.execute(parseBossCommand("create cancellation failure"), "manager-session-9");
    await store.recordManagerStarted(second.run!.bossRunId, managerWorker(second.run!.bossRunId));
    await store.execute(parseBossCommand(`cancel ${second.run!.bossRunId}`), "manager-session-9");
    const failed = await store.recordCancellationResult(second.run!.bossRunId, new Error("systemd stop refused"));
    assert.equal(failed.cancellation?.state, "failed");
    assert.equal(failed.assignments[0].state, "assigned", "failed stop must not claim the Manager was cancelled");
    assert.match(failed.cancellation?.error ?? "", /systemd stop refused/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trusted-local Boss rejects malformed persisted state", async () => {
  const { dir, store } = await fixture();
  try {
    await store.execute(parseBossCommand("create valid goal"), "manager-session-4");
    const path = join(dir, "runs.json");
    const state = JSON.parse(await readFile(path, "utf8"));
    state.runs[0].unexpected = true;
    await import("node:fs/promises").then(({ writeFile }) => writeFile(path, JSON.stringify(state)));
    await assert.rejects(store.execute(parseBossCommand("status"), "manager-session-4"), /invalid run record/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

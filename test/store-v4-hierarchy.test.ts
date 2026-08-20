import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkerStore, WorkerStoreCorruptError } from "../src/store.ts";

function storedWorker(id: string, incarnation: string, hierarchy: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    id,
    workerIncarnationId: incarnation,
    workerGeneration: 1,
    harness: "pi",
    backend: "systemd",
    role: "manager",
    task: `task-${id}`,
    cwd: "/tmp",
    state: "ready",
    owned: true,
    managerOwner: { context: "pi", principalId: "controller", sessionId: "controller", bindingEpoch: 0 },
    createdAt: 1,
    updatedAt: 2,
    leaseExpiresAt: 3,
    hierarchy,
    ...extra,
  };
}

const grant = {
  version: 1,
  grantId: "grant-root",
  issuedAt: 1,
  roles: ["manager", "scout"],
  harnesses: ["codex", "pi"],
  permissionProfiles: ["review-readonly"],
  profiles: ["pi-peer"],
  cwdRoots: [{ path: "/tmp" }],
  modelPatterns: ["anthropic/claude-*", "opus"],
  efforts: ["high", "medium"],
  maxLiveDirectChildren: 2,
  maxLiveDescendants: 4,
  maxDepth: 2,
  canSubdelegate: true,
};

test("v4 hierarchy and delegation authority survive strict read-mutate-read storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-v4-hierarchy-"));
  const path = join(root, "workers.json");
  try {
    const parent = storedWorker("parent", "inc-parent", { rootWorkerIncarnationId: "inc-parent", depth: 0 }, { delegationGrant: grant });
    const child = storedWorker("child", "inc-child", { rootWorkerIncarnationId: "inc-parent", parentWorkerIncarnationId: "inc-parent", depth: 1, grantId: "grant-root" });
    await writeFile(path, JSON.stringify({ version: 4, generation: 1, workers: [parent, child], workerGenerations: [{ workerId: "child", generation: 1 }, { workerId: "parent", generation: 1 }] }));

    const store = new WorkerStore(path);
    const before = await store.read();
    assert.deepEqual(before.workers[0].delegationGrant, grant);
    assert.deepEqual(before.workers[1].hierarchy, child.hierarchy);
    await store.mutate((state) => { state.workers[0].updatedAt = 4; });
    const after = await new WorkerStore(path).read();
    assert.deepEqual(after.workers[0].delegationGrant, grant);
    assert.deepEqual(after.workers[1].hierarchy, child.hierarchy);
    assert.equal(JSON.parse(await readFile(path, "utf8")).version, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v3 migration creates non-delegating depth-zero roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-v3-to-v4-"));
  const path = join(root, "workers.json");
  try {
    const { hierarchy: _hierarchy, ...legacy } = storedWorker("legacy", "inc-legacy", {});
    await writeFile(path, JSON.stringify({ version: 3, generation: 1, workers: [legacy], workerGenerations: [{ workerId: "legacy", generation: 1 }] }));
    const migrated = await new WorkerStore(path).migrate();
    assert.equal(migrated.version, 4);
    assert.deepEqual(migrated.workers[0].hierarchy, { rootWorkerIncarnationId: "inc-legacy", depth: 0 });
    assert.equal(migrated.workers[0].delegationGrant, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v4 strict validation rejects malformed grants and inconsistent ancestry", async () => {
  const root = await mkdtemp(join(tmpdir(), "worker-store-v4-invalid-"));
  try {
    const cases = [
      storedWorker("unknown", "inc-unknown", { rootWorkerIncarnationId: "inc-unknown", depth: 0, surprise: true }),
      storedWorker("pattern", "inc-pattern", { rootWorkerIncarnationId: "inc-pattern", depth: 0 }, {
        delegationGrant: { ...grant, grantId: "grant-pattern", modelPatterns: ["anthropic/*/opus"] },
      }),
      storedWorker("duplicate", "inc-duplicate", { rootWorkerIncarnationId: "inc-duplicate", depth: 0 }, {
        delegationGrant: { ...grant, grantId: "grant-duplicate", roles: ["scout", "scout"] },
      }),
      storedWorker("orphan", "inc-orphan", {
        rootWorkerIncarnationId: "inc-missing",
        parentWorkerIncarnationId: "inc-missing",
        depth: 1,
        grantId: "grant-missing",
      }),
    ];
    for (const [index, worker] of cases.entries()) {
      const path = join(root, `workers-${index}.json`);
      await writeFile(path, JSON.stringify({ version: 4, generation: 1, workers: [worker], workerGenerations: [{ workerId: worker.id, generation: 1 }] }));
      await assert.rejects(new WorkerStore(path).read(), WorkerStoreCorruptError);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

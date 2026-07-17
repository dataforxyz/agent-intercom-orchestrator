import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { adoptRemoteSubtree, inspectRemoteTree, issueDelegatedEnrollmentFile, issueRemoteEnrollmentFile, revokeRemoteSubtree } from "../src/intercom-access.ts";

function frame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message));
  const output = Buffer.alloc(payload.length + 4);
  output.writeUInt32BE(payload.length, 0);
  payload.copy(output, 4);
  return output;
}

async function fakeBroker(socketPath: string, policyHash = "f3b00e503631bc91123aedfbcf1df72cc9913e1893c09728b2c598f3dcdfdfe0") {
  await mkdir(dirname(socketPath), { recursive: true });
  const requests: any[] = [];
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32BE(0);
      if (buffer.length < length + 4) return;
      const request = JSON.parse(buffer.subarray(4, length + 4).toString());
      requests.push(request);
      if (request.type === "health") {
        socket.end(frame({
          type: "health_ok",
          requestId: request.requestId,
          protocol: "pi-intercom",
          version: 3,
          remoteAccess: {
            feature: "remote-access-v1",
            policySemanticsVersion: 2,
            policySemanticsHash: policyHash,
          },
        }));
      } else if (request.action === "issue_child_enrollment") {
        socket.end(frame({
          type: "access_control_result",
          requestId: request.requestId,
          action: "issue_child_enrollment",
          enrollmentToken: "delegated-one-use-secret",
          expiresAt: 2_000_000_000_000,
          parentSessionId: request.access.sessionId,
        }));
      } else if (request.action === "inspect_tree") {
        socket.end(frame({
          type: "access_control_result",
          requestId: request.requestId,
          action: "inspect_tree",
          principals: [{ id: request.principalId || request.access.sessionId, name: "remote", connected: true }],
        }));
      } else if (request.action === "adopt_subtree") {
        socket.end(frame({
          type: "access_control_result",
          requestId: request.requestId,
          action: "adopt_subtree",
          principals: [{ id: request.principalId, parentSessionId: request.newParentSessionId, generation: 2, connected: false }],
        }));
      } else if (request.action === "revoke_subtree") {
        socket.end(frame({
          type: "access_control_result",
          requestId: request.requestId,
          action: "revoke_subtree",
          changedPrincipalIds: [request.principalId, "child-principal"],
        }));
      } else {
        socket.end(frame({
          type: "access_control_result",
          requestId: request.requestId,
          action: "issue_enrollment",
          enrollmentToken: "one-use-secret-never-returned",
          expiresAt: 2_000_000_000_000,
        }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return { server, requests };
}

test("enrollment CLI support writes the one-use secret only to a private file", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-intercom-access-cli-"));
  const agentDir = join(root, "agent");
  const intercomDir = join(agentDir, "intercom");
  const outputPath = join(root, "transfer", "credential.json");
  await mkdir(intercomDir, { recursive: true });
  await writeFile(join(intercomDir, "broker-admin.json"), JSON.stringify({ version: 1, adminToken: "a".repeat(43) }), { mode: 0o600 });
  const broker = await fakeBroker(join(intercomDir, "broker.sock"));
  try {
    const result = await issueRemoteEnrollmentFile({
      agentDir,
      parentSessionId: "local-root",
      name: "ika/manager",
      remoteHostId: "ika-dev-v3",
      outputPath,
    });
    assert.deepEqual(result, { path: outputPath, expiresAt: 2_000_000_000_000 });
    assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), {
      version: 1,
      enrollmentToken: "one-use-secret-never-returned",
    });
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
    assert.equal(JSON.stringify(result).includes("one-use-secret"), false);
    assert.equal(broker.requests[1].adminToken, "a".repeat(43));
    assert.equal(broker.requests[1].enrollment.parentSessionId, "local-root");
  } finally {
    broker.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("delegated enrollment authenticates with a private parent credential and writes only the child token", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-intercom-delegate-cli-"));
  const agentDir = join(root, "agent");
  const intercomDir = join(agentDir, "intercom");
  const parentCredential = join(root, "parent.json");
  const childCredential = join(root, "child.json");
  await mkdir(intercomDir, { recursive: true });
  await writeFile(parentCredential, JSON.stringify({ version: 1, sessionCredential: "parent-secret", sessionId: "parent-id", generation: 2 }), { mode: 0o600 });
  const broker = await fakeBroker(join(intercomDir, "broker.sock"));
  try {
    const result = await issueDelegatedEnrollmentFile({
      agentDir,
      credentialPath: parentCredential,
      name: "ika/lead",
      outputPath: childCredential,
      canDelegate: true,
      maxDepth: 3,
      maxChildren: 2,
    });
    assert.equal(JSON.stringify(result).includes("delegated-one-use-secret"), false);
    assert.deepEqual(JSON.parse(await readFile(childCredential, "utf8")), { version: 1, enrollmentToken: "delegated-one-use-secret" });
    assert.equal(broker.requests[1].access.sessionCredential, "parent-secret");
    assert.equal(broker.requests[1].enrollment.canDelegate, true);
    assert.equal(broker.requests[1].enrollment.maxDepth, 3);
  } finally {
    broker.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("tree inspection returns metadata without exposing parent credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-intercom-inspect-cli-"));
  const agentDir = join(root, "agent");
  const intercomDir = join(agentDir, "intercom");
  const credentialPath = join(root, "parent.json");
  await mkdir(intercomDir, { recursive: true });
  await writeFile(credentialPath, JSON.stringify({ version: 1, sessionCredential: "parent-secret", sessionId: "parent-id", generation: 1 }), { mode: 0o600 });
  const broker = await fakeBroker(join(intercomDir, "broker.sock"));
  try {
    const result = await inspectRemoteTree({ agentDir, credentialPath });
    assert.deepEqual(result.principals, [{ id: "parent-id", name: "remote", connected: true }]);
    assert.equal(JSON.stringify(result).includes("parent-secret"), false);
  } finally {
    broker.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("adoption returns fenced metadata without credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-intercom-adopt-cli-"));
  const agentDir = join(root, "agent");
  const intercomDir = join(agentDir, "intercom");
  await mkdir(intercomDir, { recursive: true });
  await writeFile(join(intercomDir, "broker-admin.json"), JSON.stringify({ version: 1, adminToken: "a".repeat(43) }), { mode: 0o600 });
  const broker = await fakeBroker(join(intercomDir, "broker.sock"));
  try {
    assert.deepEqual(await adoptRemoteSubtree({ agentDir, principalId: "child", newParentSessionId: "new-parent" }), {
      principals: [{ id: "child", parentSessionId: "new-parent", generation: 2, connected: false }],
    });
    assert.equal(broker.requests[1].action, "adopt_subtree");
  } finally {
    broker.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("revocation returns only affected identities and sends no credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-intercom-revoke-cli-"));
  const agentDir = join(root, "agent");
  const intercomDir = join(agentDir, "intercom");
  await mkdir(intercomDir, { recursive: true });
  await writeFile(join(intercomDir, "broker-admin.json"), JSON.stringify({ version: 1, adminToken: "a".repeat(43) }), { mode: 0o600 });
  const broker = await fakeBroker(join(intercomDir, "broker.sock"));
  try {
    assert.deepEqual(await revokeRemoteSubtree({ agentDir, principalId: "remote-principal" }), {
      changedPrincipalIds: ["remote-principal", "child-principal"],
    });
    assert.equal(broker.requests[1].action, "revoke_subtree");
    assert.equal(broker.requests[1].principalId, "remote-principal");
  } finally {
    broker.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("enrollment fails closed when the broker policy hash differs", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-intercom-access-cli-"));
  const agentDir = join(root, "agent");
  const intercomDir = join(agentDir, "intercom");
  const outputPath = join(root, "credential.json");
  await mkdir(intercomDir, { recursive: true });
  await writeFile(join(intercomDir, "broker-admin.json"), JSON.stringify({ version: 1, adminToken: "a".repeat(43) }), { mode: 0o600 });
  const broker = await fakeBroker(join(intercomDir, "broker.sock"), "incompatible");
  try {
    await assert.rejects(
      issueRemoteEnrollmentFile({ agentDir, parentSessionId: "root", name: "remote", remoteHostId: "host", outputPath }),
      /required remote-access policy contract/,
    );
    await assert.rejects(readFile(outputPath));
  } finally {
    broker.server.close();
    await rm(root, { recursive: true, force: true });
  }
});

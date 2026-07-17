import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { issueRemoteEnrollmentFile } from "../src/intercom-access.ts";

function frame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message));
  const output = Buffer.alloc(payload.length + 4);
  output.writeUInt32BE(payload.length, 0);
  payload.copy(output, 4);
  return output;
}

async function fakeBroker(socketPath: string, policyHash = "78178a5fd57c353342642968d3a27262ed02cb236927723675d875959413dce3") {
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
            policySemanticsVersion: 1,
            policySemanticsHash: policyHash,
          },
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

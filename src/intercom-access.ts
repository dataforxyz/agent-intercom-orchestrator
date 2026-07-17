import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { POLICY_SEMANTICS_HASH, POLICY_SEMANTICS_VERSION } from "@dataforxyz/agent-intercom-core";

const MAX_FRAME_BYTES = 2 * 1024 * 1024;

export interface IssueRemoteEnrollmentOptions {
  parentSessionId: string;
  name: string;
  remoteHostId: string;
  outputPath: string;
  agentDir?: string;
  ttlMs?: number;
  expiresAt?: number;
}

export interface IssuedRemoteEnrollmentFile {
  path: string;
  expiresAt: number;
}

function agentDirectory(configured?: string): string {
  const value = configured ?? process.env.PI_CODING_AGENT_DIR;
  if (!value?.trim()) return join(homedir(), ".pi", "agent");
  return isAbsolute(value) ? value : resolve(value);
}

function encodeMessage(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  if (payload.length > MAX_FRAME_BYTES) throw new Error("Intercom access request is too large");
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function exchange(socketPath: string, request: unknown, timeoutMs = 3000): Promise<any> {
  return new Promise((resolveResponse, reject) => {
    const socket = net.connect(socketPath);
    let buffer = Buffer.alloc(0);
    const timeout = setTimeout(() => finish(new Error("Intercom access request timed out")), timeoutMs);
    const finish = (error?: Error, response?: unknown) => {
      clearTimeout(timeout);
      socket.removeAllListeners();
      socket.destroy();
      if (error) reject(error);
      else resolveResponse(response);
    };
    socket.once("connect", () => socket.write(encodeMessage(request)));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) return finish(new Error("Intercom access response is too large"));
      if (buffer.length < length + 4) return;
      try {
        finish(undefined, JSON.parse(buffer.subarray(4, length + 4).toString("utf8")));
      } catch {
        finish(new Error("Invalid Intercom access response"));
      }
    });
    socket.once("error", () => finish(new Error("Could not connect to the local Intercom broker")));
    socket.once("close", () => {
      if (buffer.length < 4) finish(new Error("Intercom broker closed the access request"));
    });
  });
}

function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  const descriptor = openSync(temporary, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`Invalid ${label}`);
  return normalized;
}

export async function issueRemoteEnrollmentFile(options: IssueRemoteEnrollmentOptions): Promise<IssuedRemoteEnrollmentFile> {
  const agentDir = agentDirectory(options.agentDir);
  const intercomDir = join(agentDir, "intercom");
  const socketPath = join(intercomDir, "broker.sock");
  const adminPath = join(intercomDir, "broker-admin.json");
  const admin = JSON.parse(readFileSync(adminPath, "utf8")) as Record<string, unknown>;
  if (admin.version !== 1 || typeof admin.adminToken !== "string" || admin.adminToken.length < 32) {
    throw new Error("Invalid local Intercom broker admin credential");
  }

  const healthRequestId = randomUUID();
  const health = await exchange(socketPath, { type: "health", requestId: healthRequestId });
  const contract = health?.remoteAccess;
  if (
    health?.type !== "health_ok"
    || health.requestId !== healthRequestId
    || typeof contract !== "object"
    || contract === null
    || contract.feature !== "remote-access-v1"
    || contract.policySemanticsVersion !== POLICY_SEMANTICS_VERSION
    || contract.policySemanticsHash !== POLICY_SEMANTICS_HASH
  ) {
    throw new Error("Local Intercom broker does not provide the required remote-access policy contract");
  }

  const requestId = randomUUID();
  const parentSessionId = requireText(options.parentSessionId, "parent session ID");
  const response = await exchange(socketPath, {
    type: "access_control",
    requestId,
    adminToken: admin.adminToken,
    action: "issue_enrollment",
    enrollment: {
      name: requireText(options.name, "remote principal name"),
      parentSessionId,
      rootSessionId: parentSessionId,
      remoteHostId: requireText(options.remoteHostId, "remote host ID"),
      ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
      ...(options.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
    },
  });
  if (
    response?.type !== "access_control_result"
    || response.requestId !== requestId
    || response.action !== "issue_enrollment"
    || typeof response.enrollmentToken !== "string"
    || typeof response.expiresAt !== "number"
  ) {
    throw new Error(response?.type === "error" ? `Intercom enrollment was denied: ${String(response.code ?? "unknown")}` : "Invalid Intercom enrollment response");
  }
  const outputPath = resolve(options.outputPath);
  writePrivateJson(outputPath, { version: 1, enrollmentToken: response.enrollmentToken });
  return { path: outputPath, expiresAt: response.expiresAt };
}

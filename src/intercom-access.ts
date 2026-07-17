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
  canDelegate?: boolean;
  maxDepth?: number;
  maxChildren?: number;
}

export interface IssueDelegatedEnrollmentOptions {
  credentialPath: string;
  name: string;
  outputPath: string;
  agentDir?: string;
  ttlMs?: number;
  expiresAt?: number;
  canDelegate?: boolean;
  maxDepth?: number;
  maxChildren?: number;
}

export interface IssuedRemoteEnrollmentFile {
  path: string;
  expiresAt: number;
}

export interface AdoptRemoteSubtreeOptions {
  principalId: string;
  newParentSessionId: string;
  agentDir?: string;
}

export interface AdoptedRemoteSubtree {
  principals: Array<Record<string, unknown>>;
}

export interface RevokeRemoteSubtreeOptions {
  principalId: string;
  agentDir?: string;
}

export interface RevokedRemoteSubtree {
  changedPrincipalIds: string[];
}

export interface InspectRemoteTreeOptions {
  principalId?: string;
  credentialPath?: string;
  agentDir?: string;
}

export interface RemoteTreeInspection {
  principals: Array<Record<string, unknown>>;
}

export interface RemoteAccessHealth {
  protocol: string;
  version: number;
  feature: "remote-access-v1";
  policySemanticsVersion: number;
  policySemanticsHash: string;
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

export async function checkRemoteAccessHealth(configuredAgentDir?: string): Promise<RemoteAccessHealth> {
  const agentDir = agentDirectory(configuredAgentDir);
  const socketPath = join(agentDir, "intercom", "broker.sock");
  const healthRequestId = randomUUID();
  const health = await exchange(socketPath, { type: "health", requestId: healthRequestId });
  const contract = health?.remoteAccess;
  if (
    health?.type !== "health_ok"
    || health.requestId !== healthRequestId
    || health.protocol !== "pi-intercom"
    || health.version !== 3
    || typeof contract !== "object"
    || contract === null
    || contract.feature !== "remote-access-v1"
    || contract.policySemanticsVersion !== POLICY_SEMANTICS_VERSION
    || contract.policySemanticsHash !== POLICY_SEMANTICS_HASH
  ) {
    throw new Error("Local Intercom broker does not provide the required remote-access policy contract");
  }
  return {
    protocol: health.protocol,
    version: health.version,
    feature: contract.feature,
    policySemanticsVersion: contract.policySemanticsVersion,
    policySemanticsHash: contract.policySemanticsHash,
  };
}

async function authenticatedAccessContext(configuredAgentDir?: string): Promise<{ socketPath: string; adminToken: string }> {
  const agentDir = agentDirectory(configuredAgentDir);
  const intercomDir = join(agentDir, "intercom");
  const socketPath = join(intercomDir, "broker.sock");
  await checkRemoteAccessHealth(agentDir);
  const adminPath = join(intercomDir, "broker-admin.json");
  const admin = JSON.parse(readFileSync(adminPath, "utf8")) as Record<string, unknown>;
  if (admin.version !== 1 || typeof admin.adminToken !== "string" || admin.adminToken.length < 32) {
    throw new Error("Invalid local Intercom broker admin credential");
  }
  return { socketPath, adminToken: admin.adminToken };
}

export async function issueRemoteEnrollmentFile(options: IssueRemoteEnrollmentOptions): Promise<IssuedRemoteEnrollmentFile> {
  const { socketPath, adminToken } = await authenticatedAccessContext(options.agentDir);
  const requestId = randomUUID();
  const parentSessionId = requireText(options.parentSessionId, "parent session ID");
  const response = await exchange(socketPath, {
    type: "access_control",
    requestId,
    adminToken,
    action: "issue_enrollment",
    enrollment: {
      name: requireText(options.name, "remote principal name"),
      parentSessionId,
      rootSessionId: parentSessionId,
      remoteHostId: requireText(options.remoteHostId, "remote host ID"),
      ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
      ...(options.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
      ...(options.canDelegate !== undefined ? { canDelegate: options.canDelegate } : {}),
      ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
      ...(options.maxChildren !== undefined ? { maxChildren: options.maxChildren } : {}),
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

export async function issueDelegatedEnrollmentFile(options: IssueDelegatedEnrollmentOptions): Promise<IssuedRemoteEnrollmentFile> {
  const agentDir = agentDirectory(options.agentDir);
  await checkRemoteAccessHealth(agentDir);
  const socketPath = join(agentDir, "intercom", "broker.sock");
  const credential = JSON.parse(readFileSync(resolve(options.credentialPath), "utf8")) as Record<string, unknown>;
  if (
    credential.version !== 1
    || typeof credential.sessionCredential !== "string"
    || typeof credential.sessionId !== "string"
    || typeof credential.generation !== "number"
    || !Number.isSafeInteger(credential.generation)
  ) {
    throw new Error("Invalid parent Intercom session credential");
  }
  const requestId = randomUUID();
  const response = await exchange(socketPath, {
    type: "access_control",
    requestId,
    action: "issue_child_enrollment",
    access: {
      sessionCredential: credential.sessionCredential,
      sessionId: credential.sessionId,
      generation: credential.generation,
    },
    enrollment: {
      name: requireText(options.name, "child principal name"),
      ...(options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {}),
      ...(options.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
      ...(options.canDelegate !== undefined ? { canDelegate: options.canDelegate } : {}),
      ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
      ...(options.maxChildren !== undefined ? { maxChildren: options.maxChildren } : {}),
    },
  });
  if (
    response?.type !== "access_control_result"
    || response.requestId !== requestId
    || response.action !== "issue_child_enrollment"
    || typeof response.enrollmentToken !== "string"
    || typeof response.expiresAt !== "number"
  ) {
    throw new Error(response?.type === "error" ? `Intercom child enrollment was denied: ${String(response.code ?? "unknown")}` : "Invalid Intercom child enrollment response");
  }
  const outputPath = resolve(options.outputPath);
  writePrivateJson(outputPath, { version: 1, enrollmentToken: response.enrollmentToken });
  return { path: outputPath, expiresAt: response.expiresAt };
}

export async function inspectRemoteTree(options: InspectRemoteTreeOptions = {}): Promise<RemoteTreeInspection> {
  const agentDir = agentDirectory(options.agentDir);
  await checkRemoteAccessHealth(agentDir);
  const socketPath = join(agentDir, "intercom", "broker.sock");
  const requestId = randomUUID();
  let request: Record<string, unknown>;
  if (options.credentialPath) {
    const credential = JSON.parse(readFileSync(resolve(options.credentialPath), "utf8")) as Record<string, unknown>;
    if (
      credential.version !== 1
      || typeof credential.sessionCredential !== "string"
      || typeof credential.sessionId !== "string"
      || typeof credential.generation !== "number"
      || !Number.isSafeInteger(credential.generation)
    ) throw new Error("Invalid Intercom session credential");
    request = {
      type: "access_control",
      requestId,
      action: "inspect_tree",
      access: {
        sessionCredential: credential.sessionCredential,
        sessionId: credential.sessionId,
        generation: credential.generation,
      },
      ...(options.principalId ? { principalId: options.principalId } : {}),
    };
  } else {
    if (!options.principalId) throw new Error("Local tree inspection requires a principal ID");
    const admin = JSON.parse(readFileSync(join(agentDir, "intercom", "broker-admin.json"), "utf8")) as Record<string, unknown>;
    if (admin.version !== 1 || typeof admin.adminToken !== "string") throw new Error("Invalid local Intercom broker admin credential");
    request = { type: "access_control", requestId, action: "inspect_tree", adminToken: admin.adminToken, principalId: options.principalId };
  }
  const response = await exchange(socketPath, request);
  if (
    response?.type !== "access_control_result"
    || response.requestId !== requestId
    || response.action !== "inspect_tree"
    || !Array.isArray(response.principals)
  ) {
    throw new Error(response?.type === "error" ? `Intercom tree inspection was denied: ${String(response.code ?? "unknown")}` : "Invalid Intercom tree inspection response");
  }
  return { principals: response.principals };
}

export async function adoptRemoteSubtree(options: AdoptRemoteSubtreeOptions): Promise<AdoptedRemoteSubtree> {
  const { socketPath, adminToken } = await authenticatedAccessContext(options.agentDir);
  const requestId = randomUUID();
  const response = await exchange(socketPath, {
    type: "access_control",
    requestId,
    adminToken,
    action: "adopt_subtree",
    principalId: requireText(options.principalId, "adopted principal ID"),
    newParentSessionId: requireText(options.newParentSessionId, "new parent session ID"),
  });
  if (
    response?.type !== "access_control_result"
    || response.requestId !== requestId
    || response.action !== "adopt_subtree"
    || !Array.isArray(response.principals)
  ) {
    throw new Error(response?.type === "error" ? `Intercom adoption was denied: ${String(response.code ?? "unknown")}` : "Invalid Intercom adoption response");
  }
  return { principals: response.principals };
}

export async function revokeRemoteSubtree(options: RevokeRemoteSubtreeOptions): Promise<RevokedRemoteSubtree> {
  const { socketPath, adminToken } = await authenticatedAccessContext(options.agentDir);
  const principalId = requireText(options.principalId, "remote principal ID");
  const requestId = randomUUID();
  const response = await exchange(socketPath, {
    type: "access_control",
    requestId,
    adminToken,
    action: "revoke_subtree",
    principalId,
  });
  if (
    response?.type !== "access_control_result"
    || response.requestId !== requestId
    || response.action !== "revoke_subtree"
    || !Array.isArray(response.changedPrincipalIds)
    || !response.changedPrincipalIds.every((id: unknown) => typeof id === "string")
  ) {
    throw new Error(response?.type === "error" ? `Intercom revocation was denied: ${String(response.code ?? "unknown")}` : "Invalid Intercom revocation response");
  }
  return { changedPrincipalIds: response.changedPrincipalIds };
}

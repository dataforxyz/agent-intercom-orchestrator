import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REQUEST_EVENT = "subagents:rpc:v1:request";
const REPLY_PREFIX = "subagents:rpc:v1:reply:";

export interface SubagentRpcReply {
  version: 1;
  requestId: string;
  method?: string;
  success: boolean;
  data?: unknown;
  error?: { code?: string; message?: string };
}

export async function callSubagentRpc(
  pi: ExtensionAPI,
  method: "ping" | "spawn" | "status" | "interrupt" | "stop",
  params?: unknown,
  timeoutMs = 5000,
): Promise<unknown> {
  const requestId = randomUUID();
  const replyEvent = `${REPLY_PREFIX}${requestId}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe: (() => void) | void;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      unsubscribe?.();
      fn();
    };
    const timeout = setTimeout(() => {
      finish(() => reject(new Error(`pi-subagents RPC ${method} timed out; is pi-subagents installed and loaded?`)));
    }, timeoutMs);
    unsubscribe = pi.events.on(replyEvent, (payload) => {
      const reply = payload as SubagentRpcReply;
      finish(() => {
        if (!reply?.success) {
          reject(new Error(reply?.error?.message || `pi-subagents RPC ${method} failed`));
          return;
        }
        resolve(reply.data);
      });
    });
    pi.events.emit(REQUEST_EVENT, {
      version: 1,
      requestId,
      method,
      ...(params === undefined ? {} : { params }),
      source: { extension: "agent-intercom-orchestrator" },
    });
  });
}

export function findRunId(value: unknown): string | undefined {
  const seen = new Set<unknown>();
  const visit = (input: unknown, depth: number): string | undefined => {
    if (depth > 8 || !input || typeof input !== "object" || seen.has(input)) return undefined;
    seen.add(input);
    const record = input as Record<string, unknown>;
    for (const key of ["runId", "asyncId", "id"]) {
      if (typeof record[key] === "string" && record[key]) return record[key] as string;
    }
    for (const child of Object.values(record)) {
      const result = visit(child, depth + 1);
      if (result) return result;
    }
    return undefined;
  };
  return visit(value, 0);
}

#!/usr/bin/env -S node --experimental-strip-types
import { spawn } from "node:child_process";

async function readStdin() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

function executeCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = options.timeout
      ? setTimeout(() => child.kill("SIGKILL"), options.timeout)
      : undefined;
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1, killed: signal !== null });
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr: `${stderr}${error.message}`, code: 1, killed: false });
    });
  });
}

try {
  const request = JSON.parse(await readStdin());
  if (!request || typeof request !== "object" || !request.params || typeof request.params !== "object") {
    throw new Error("Expected JSON request with params");
  }
  const managerSessionId = typeof request.managerSessionId === "string" && request.managerSessionId.trim()
    ? request.managerSessionId.trim()
    : `agent-fleet-cli-${process.pid}`;
  const cwd = typeof request.cwd === "string" && request.cwd.trim() ? request.cwd : process.cwd();
  const lifecycle = new Map();
  const tools = new Map();
  const pi = {
    on(name, handler) { lifecycle.set(name, handler); },
    events: { on() { return () => {}; }, emit() {} },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand() {},
    exec: executeCommand,
  };
  const ctx = {
    cwd,
    mode: "rpc",
    hasUI: false,
    sessionManager: {
      getSessionId: () => managerSessionId,
      getSessionFile: () => undefined,
    },
    ui: {
      setStatus() {},
      notify() {},
    },
  };
  const { default: extension } = await import("./index.ts");
  extension(pi);
  const tool = tools.get("agent_fleet");
  if (!tool) throw new Error("agent_fleet is unavailable; check orchestrator installation and disable flags");
  await lifecycle.get("session_start")?.({}, ctx);
  const result = await tool.execute(`cli-${Date.now()}`, request.params, new AbortController().signal, () => {}, ctx);
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
}

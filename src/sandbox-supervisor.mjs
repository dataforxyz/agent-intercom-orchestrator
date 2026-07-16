#!/usr/bin/env node
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";

const separator = process.argv.indexOf("--");
const commandArgs = separator >= 0 ? process.argv.slice(separator + 1) : process.argv.slice(2);
const [command, ...args] = commandArgs;
if (!command) {
  process.stderr.write("sandbox-supervisor requires a command after --\n");
  process.exit(2);
}

const sourceSocket = process.env.AGENT_INTERCOM_BROKER_SOURCE;
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!sourceSocket || !agentDir) {
  process.stderr.write("sandbox-supervisor requires AGENT_INTERCOM_BROKER_SOURCE and PI_CODING_AGENT_DIR\n");
  process.exit(2);
}
const targetSocket = join(agentDir, "intercom", "broker.sock");
mkdirSync(dirname(targetSocket), { recursive: true, mode: 0o700 });
rmSync(targetSocket, { force: true });

const sockets = new Set();
const server = net.createServer((downstream) => {
  const upstream = net.createConnection(sourceSocket);
  sockets.add(downstream);
  sockets.add(upstream);
  downstream.pipe(upstream);
  upstream.pipe(downstream);
  const close = () => {
    sockets.delete(downstream);
    sockets.delete(upstream);
    downstream.destroy();
    upstream.destroy();
  };
  downstream.on("error", close);
  upstream.on("error", close);
  downstream.on("close", close);
  upstream.on("close", close);
});
server.on("error", (error) => {
  process.stderr.write(`Intercom socket proxy failed: ${error.message}\n`);
  process.exit(1);
});
server.listen(targetSocket, () => {
  chmodSync(targetSocket, 0o600);
  let maskPaths = [];
  try {
    const configured = JSON.parse(process.env.AGENT_INTERCOM_MASK_PATHS ?? "[]");
    if (Array.isArray(configured)) maskPaths = configured.map((path) => String(path).trim()).filter(Boolean);
  } catch {
    maskPaths = (process.env.AGENT_INTERCOM_MASK_PATHS ?? "").split("\n").map((path) => path.trim()).filter(Boolean);
  }
  const childCommand = maskPaths.length ? "/usr/bin/bwrap" : command;
  const childArgs = maskPaths.length
    ? [
        "--bind", "/", "/",
        "--dev-bind", "/dev", "/dev",
        "--tmpfs", `/proc/${process.pid}`, "--die-with-parent",
        ...maskPaths.flatMap((path) => ["--tmpfs", path]),
        "--", command, ...args,
      ]
    : args;
  const child = spawn(childCommand, childArgs, {
    cwd: process.cwd(),
    env: { ...process.env, AGENT_INTERCOM_SANDBOX_SUPERVISOR_PID: String(process.pid) },
    stdio: "inherit",
  });
  let stopping = false;
  const stop = (signal = "SIGTERM") => {
    if (stopping) return;
    stopping = true;
    child.kill(signal);
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    timer.unref?.();
  };
  process.on("SIGTERM", () => stop());
  process.on("SIGINT", () => stop("SIGINT"));
  child.on("error", (error) => {
    process.stderr.write(`Could not start sandboxed harness: ${error.message}\n`);
    process.exitCode = 127;
    server.close();
  });
  child.on("exit", (code, signal) => {
    process.exitCode = stopping ? 0 : (code ?? (signal === "SIGINT" ? 130 : signal ? 1 : 0));
    server.close();
  });
});

server.on("close", () => {
  for (const socket of sockets) socket.destroy();
  rmSync(targetSocket, { force: true });
  process.exit(process.exitCode ?? 0);
});

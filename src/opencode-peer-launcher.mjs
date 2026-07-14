#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const separator = process.argv.indexOf("--");
const commandArgs = separator >= 0 ? process.argv.slice(separator + 1) : process.argv.slice(2);
const [command, ...bootstrapArgs] = commandArgs;
if (!command) {
  process.stderr.write("opencode-peer-launcher requires an OpenCode command after --\n");
  process.exit(2);
}

async function reservePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const address = socket.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => socket.close(resolve));
  if (!port) throw new Error("Could not reserve an OpenCode server port");
  return port;
}

async function waitForPort(port, child, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`OpenCode server exited with ${child.exitCode}`);
    const connected = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
      socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
    });
    if (connected) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for OpenCode server on port ${port}`);
}

const port = await reservePort();
const url = `http://127.0.0.1:${port}`;
const childEnv = { ...process.env, OPENCODE_SERVER_PASSWORD: randomBytes(24).toString("hex") };
const server = spawn(command, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: process.cwd(),
  env: childEnv,
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.pipe(process.stdout);
server.stderr.pipe(process.stderr);

let bootstrap;
let stopping = false;
function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  bootstrap?.kill(signal);
  server.kill(signal);
  const timer = setTimeout(() => {
    bootstrap?.kill("SIGKILL");
    server.kill("SIGKILL");
  }, 3000);
  timer.unref?.();
}
process.on("SIGTERM", () => stop());
process.on("SIGINT", () => stop("SIGINT"));

try {
  await waitForPort(port, server);
  bootstrap = spawn(command, ["run", "--pure", "--attach", url, "--auto", "--format", "json", ...bootstrapArgs], {
    cwd: process.cwd(),
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (process.env.AGENT_INTERCOM_OPENCODE_BOOTSTRAP_LOG === "1") bootstrap.stdout.pipe(process.stdout);
  else bootstrap.stdout.resume();
  bootstrap.stderr.pipe(process.stderr);
  const bootstrapCode = await new Promise((resolve, reject) => {
    bootstrap.once("error", reject);
    bootstrap.once("exit", (code) => resolve(code ?? 1));
  });
  if (stopping) process.exit(0);
  if (bootstrapCode !== 0) throw new Error(`OpenCode bootstrap run exited with ${bootstrapCode}`);
  process.stderr.write(`OpenCode peer ready at ${url}\n`);
  const serverCode = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("exit", (code, signal) => resolve(stopping ? 0 : (code ?? (signal === "SIGINT" ? 130 : 1))));
  });
  process.exit(serverCode);
} catch (error) {
  const orderlyStop = stopping;
  stop();
  if (!orderlyStop) process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(orderlyStop ? 0 : 1);
}

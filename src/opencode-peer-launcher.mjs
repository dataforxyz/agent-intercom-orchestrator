#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import net from "node:net";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const separator = process.argv.indexOf("--");
const commandArgs = separator >= 0 ? process.argv.slice(separator + 1) : process.argv.slice(2);
const [command, ...bootstrapArgs] = commandArgs;
if (!command) {
  process.stderr.write("opencode-peer-launcher requires an OpenCode command after --\n");
  process.exit(2);
}

const healthPath = process.env.AGENT_INTERCOM_OPENCODE_HEALTH_PATH?.trim();
const statePath = process.env.AGENT_INTERCOM_OPENCODE_STATE_PATH?.trim();
const runId = process.env.AGENT_INTERCOM_RUN_ID?.trim();
const workerId = process.env.AGENT_INTERCOM_WORKER_ID?.trim();

async function readJson(path) {
  if (!path) return undefined;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function writeJsonAtomic(path, value) {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
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
  let childError;
  child.on("error", (error) => { childError = error; });
  while (Date.now() < deadline) {
    if (childError) throw childError;
    if (child.exitCode !== null) throw new Error(`OpenCode server exited with ${child.exitCode}`);
    const connected = await new Promise((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
      socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
    });
    if (connected) {
      await delay(50);
      if (childError) throw childError;
      if (child.exitCode !== null) throw new Error(`OpenCode server exited with ${child.exitCode}`);
      return;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for OpenCode server on port ${port}`);
}

async function waitForHealth(server, timeoutMs = 45000) {
  if (!healthPath) return undefined;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`OpenCode server exited with ${server.exitCode} before readiness`);
    const health = await readJson(healthPath);
    if (health?.runId === runId && health.ready === true && health.connected === true && health.openCodeSessionId) return health;
    if (health?.runId === runId && health.error) throw new Error(`OpenCode plugin readiness failed: ${health.error}`);
    await delay(100);
  }
  throw new Error(`Timed out waiting for OpenCode Intercom readiness at ${healthPath}`);
}

const priorState = await readJson(statePath);
const resumableSessionId = priorState && priorState.workerId === workerId && typeof priorState.sessionId === "string"
  ? priorState.sessionId
  : undefined;
const childEnv = {
  ...process.env,
  OPENCODE_SERVER_PASSWORD: randomBytes(24).toString("hex"),
  ...(resumableSessionId ? { OPENCODE_INTERCOM_TARGET_SESSION: resumableSessionId } : {}),
};

let server;
let startingServer;
let port;
let url;
let bootstrap;
let stopping = false;
function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  bootstrap?.kill(signal);
  startingServer?.kill(signal);
  server?.kill(signal);
  const timer = setTimeout(() => {
    bootstrap?.kill("SIGKILL");
    startingServer?.kill("SIGKILL");
    server?.kill("SIGKILL");
  }, 3000);
  timer.unref?.();
}
process.on("SIGTERM", () => stop());
process.on("SIGINT", () => stop("SIGINT"));

async function startServer(maxAttempts = 4) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (stopping) throw new Error("OpenCode peer is stopping");
    const candidatePort = await reservePort();
    const candidateUrl = `http://127.0.0.1:${candidatePort}`;
    const candidate = spawn(command, ["serve", "--hostname", "127.0.0.1", "--port", String(candidatePort)], {
      cwd: process.cwd(),
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    startingServer = candidate;
    candidate.stdout.pipe(process.stdout);
    candidate.stderr.pipe(process.stderr);
    try {
      await waitForPort(candidatePort, candidate);
      startingServer = undefined;
      return { server: candidate, port: candidatePort, url: candidateUrl };
    } catch (error) {
      startingServer = undefined;
      candidate.kill("SIGTERM");
      if (stopping || attempt === maxAttempts || candidate.exitCode === null) throw error;
      process.stderr.write(`OpenCode server could not bind/start on port ${candidatePort}; retrying with a new port (${attempt}/${maxAttempts}).\n`);
      await delay(50);
    }
  }
  throw new Error("Could not start the OpenCode server");
}

async function runBootstrap(sessionId) {
  const resumeArgs = sessionId ? ["--session", sessionId] : [];
  bootstrap = spawn(command, ["run", "--pure", "--attach", url, "--auto", "--format", "json", ...resumeArgs, ...bootstrapArgs], {
    cwd: process.cwd(),
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let detectedSessionId;
  let buffer = "";
  bootstrap.stdout.on("data", (chunk) => {
    if (process.env.AGENT_INTERCOM_OPENCODE_BOOTSTRAP_LOG === "1") process.stdout.write(chunk);
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        if (typeof event.sessionID === "string" && event.sessionID) detectedSessionId = event.sessionID;
      } catch {
        // Ignore non-JSON bootstrap output.
      }
    }
  });
  bootstrap.stderr.pipe(process.stderr);
  const code = await new Promise((resolve, reject) => {
    bootstrap.once("error", reject);
    bootstrap.once("exit", (exitCode) => resolve(exitCode ?? 1));
  });
  return { code, sessionId: detectedSessionId };
}

try {
  ({ server, port, url } = await startServer());
  let bootstrapResult = await runBootstrap(resumableSessionId);
  if (bootstrapResult.code !== 0 && resumableSessionId && !stopping) {
    process.stderr.write(`Could not resume OpenCode session ${resumableSessionId}; creating a fresh session.\n`);
    bootstrapResult = await runBootstrap(undefined);
  }
  if (stopping) process.exit(0);
  if (bootstrapResult.code !== 0) throw new Error(`OpenCode bootstrap run exited with ${bootstrapResult.code}`);
  const health = await waitForHealth(server);
  const sessionId = health?.openCodeSessionId || bootstrapResult.sessionId || resumableSessionId;
  if (!sessionId) throw new Error("OpenCode bootstrap completed without a discoverable session ID");
  await writeJsonAtomic(statePath, {
    version: 1,
    workerId,
    sessionId,
    directory: process.cwd(),
    updatedAt: Date.now(),
  });
  process.stderr.write(`OpenCode peer ready at ${url} session=${sessionId}${resumableSessionId === sessionId ? " resumed" : ""}\n`);
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

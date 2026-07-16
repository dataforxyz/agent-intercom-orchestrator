#!/usr/bin/env node
import { spawn } from "node:child_process";

const separator = process.argv.indexOf("--");
const commandArgs = separator >= 0 ? process.argv.slice(separator + 1) : process.argv.slice(2);
const [command, ...args] = commandArgs;
if (!command) {
  process.stderr.write("pi-peer-launcher requires a command after --\n");
  process.exit(2);
}

const child = spawn(command, args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});
if (process.env.AGENT_INTERCOM_PI_RPC_LOG === "1") child.stdout.pipe(process.stdout);
else child.stdout.resume();
child.stderr.pipe(process.stderr);

let stopping = false;
function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  child.kill(signal);
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
  timer.unref?.();
}

process.on("SIGTERM", () => stop());
process.on("SIGINT", () => stop("SIGINT"));
if (process.env.AGENT_INTERCOM_LAUNCHER_READY === "1") process.stderr.write("pi-peer-launcher-ready\n");
child.on("error", (error) => {
  process.stderr.write(`Could not start Pi coworker: ${error.message}\n`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  process.exit(stopping ? 0 : (code ?? (signal === "SIGINT" ? 130 : signal ? 1 : 0)));
});

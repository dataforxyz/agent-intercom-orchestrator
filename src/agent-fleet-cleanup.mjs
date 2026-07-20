#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("./agent-fleet-cli.mjs", import.meta.url));
const child = spawn(process.execPath, ["--experimental-strip-types", cli], {
  cwd: process.env.HOME || process.cwd(),
  env: { ...process.env, AGENT_INTERCOM_AUTOMATIC_CLEANUP: "1" },
  stdio: ["pipe", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += chunk; });
child.stderr.on("data", (chunk) => { stderr += chunk; });
child.stdin.end(`${JSON.stringify({
  managerSessionId: `agent-fleet-cleanup-${process.pid}`,
  cwd: process.env.HOME || process.cwd(),
  params: { action: "cleanup", execute: true },
})}\n`);
child.on("close", (code, signal) => {
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  if (signal) process.stderr.write(`cleanup CLI terminated by ${signal}\n`);
  process.exitCode = code ?? 1;
});
child.on("error", (error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

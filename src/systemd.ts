import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename } from "node:path";
import type { CommandRunner, LaunchProfile, UnitStatus } from "./types.ts";
import { expandHome, resolveProfileCommand } from "./config.ts";

export function sanitizeUnitPart(value: string, fallback = "worker"): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return sanitized || fallback;
}

export function makeUnitName(workerId: string, runId: string): string {
  return `agent-intercom-worker-${sanitizeUnitPart(workerId)}-${sanitizeUnitPart(runId).slice(0, 12)}.service`;
}

function parseSystemctlShow(stdout: string): Record<string, string> {
  return Object.fromEntries(
    stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf("=");
        return index < 0 ? [line, ""] : [line.slice(0, index), line.slice(index + 1)];
      }),
  );
}

export async function systemdAvailable(runner: CommandRunner): Promise<boolean> {
  const result = await runner.exec("systemctl", ["--user", "show-environment"], { timeout: 5000 });
  return result.code === 0;
}

export async function resolveLaunchCommand(profile: LaunchProfile): Promise<string> {
  const expanded = expandHome(profile.command);
  const resolved = resolveProfileCommand(expanded);
  if (!resolved) throw new Error(`Profile command not found or not executable: ${profile.command}`);
  await access(resolved, fsConstants.X_OK);
  return resolved;
}

export interface LaunchUnitInput {
  unit: string;
  profile: LaunchProfile;
  args: string[];
  cwd: string;
  maxRuntime: string;
  stopTimeoutSeconds: number;
  environment?: Record<string, string>;
}

export async function launchUnit(runner: CommandRunner, input: LaunchUnitInput): Promise<void> {
  const executable = await resolveLaunchCommand(input.profile);
  const unitBase = input.unit.endsWith(".service") ? input.unit.slice(0, -8) : input.unit;
  const environment: Record<string, string> = {
    ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
    ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
    ...(process.env.PI_CODING_AGENT_DIR ? { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR } : {}),
    ...(input.profile.env ?? {}),
    ...(input.environment ?? {}),
  };
  const args = [
    "--user",
    `--unit=${unitBase}`,
    "--collect",
    `--working-directory=${input.cwd}`,
    "--property=KillMode=control-group",
    `--property=TimeoutStopSec=${Math.max(1, Math.floor(input.stopTimeoutSeconds))}s`,
    `--property=RuntimeMaxSec=${input.maxRuntime}`,
    "--property=StandardOutput=journal",
    "--property=StandardError=journal",
  ];
  for (const [key, value] of Object.entries(environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("\0")) continue;
    args.push(`--setenv=${key}=${value}`);
  }
  args.push(executable, ...input.args);
  const result = await runner.exec("systemd-run", args, { timeout: 15000 });
  if (result.code !== 0) {
    throw new Error(`Could not start ${input.unit}: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`);
  }
}

export async function getUnitStatus(runner: CommandRunner, unit: string): Promise<UnitStatus> {
  const result = await runner.exec(
    "systemctl",
    [
      "--user",
      "show",
      unit,
      "--no-pager",
      "--property=LoadState,ActiveState,SubState,MainPID,Result,ExecMainStatus",
    ],
    { timeout: 5000 },
  );
  if (result.code !== 0) return { exists: false };
  const values = parseSystemctlShow(result.stdout);
  if (values.LoadState === "not-found") return { exists: false };
  const mainPid = Number(values.MainPID);
  const execMainStatus = Number(values.ExecMainStatus);
  return {
    exists: true,
    activeState: values.ActiveState,
    subState: values.SubState,
    ...(Number.isInteger(mainPid) && mainPid > 0 ? { mainPid } : {}),
    ...(values.Result ? { result: values.Result } : {}),
    ...(Number.isInteger(execMainStatus) ? { execMainStatus } : {}),
  };
}

export async function stopUnit(runner: CommandRunner, unit: string): Promise<void> {
  const result = await runner.exec("systemctl", ["--user", "stop", unit], { timeout: 15000 });
  if (result.code !== 0 && !/not loaded|not found/i.test(`${result.stdout}\n${result.stderr}`)) {
    throw new Error(`Could not stop ${unit}: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`);
  }
}

export async function readUnitLogs(runner: CommandRunner, unit: string, lines = 80): Promise<string> {
  const result = await runner.exec(
    "journalctl",
    ["--user", "--unit", unit, "--no-pager", "-n", String(Math.max(1, Math.min(Math.floor(lines), 500)))],
    { timeout: 10000 },
  );
  if (result.code !== 0) {
    throw new Error(`Could not read logs for ${unit}: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`);
  }
  return result.stdout.trim() || `(no journal output for ${basename(unit)})`;
}

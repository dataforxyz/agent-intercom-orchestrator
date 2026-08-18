import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { CommandRunner, LaunchProfile, ManagerOwnerKind, UnitStatus } from "./types.ts";
import { expandHome, resolveProfileCommand } from "./config.ts";

let workerUnitMutationGeneration = 0;

export function getWorkerUnitMutationGeneration(): number {
  return workerUnitMutationGeneration;
}

function markWorkerUnitMutation(): void {
  workerUnitMutationGeneration += 1;
}

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

export function parseDurationToSeconds(value: string): number {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "infinity") return Number.POSITIVE_INFINITY;
  const units: Record<string, number> = {
    us: 0.000001,
    ms: 0.001,
    s: 1,
    min: 60,
    h: 3600,
    d: 86400,
    w: 604800,
    month: 2629800,
    year: 31557600,
  };
  const pattern = /(\d+(?:\.\d+)?)\s*(us|ms|s|min|h|d|w|month|year)/gy;
  let total = 0;
  let offset = 0;
  while (offset < trimmed.length) {
    while (/\s/.test(trimmed[offset] || "")) offset += 1;
    pattern.lastIndex = offset;
    const match = pattern.exec(trimmed);
    if (!match) throw new Error(`Invalid systemd duration: ${value}`);
    total += Number(match[1]) * units[match[2]];
    offset = pattern.lastIndex;
  }
  if (!Number.isFinite(total) || total <= 0) throw new Error(`Invalid systemd duration: ${value}`);
  return total;
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

export type SystemdJob = {
  id: number;
  unit: string;
  type: string;
  state: "running" | "waiting";
  raw: string;
};

export function parseSystemctlListJobs(stdout: string): SystemdJob[] {
  const jobs: SystemdJob[] = [];
  const ids = new Set<number>();
  for (const rawLine of stdout.split("\n")) {
    const raw = rawLine.trim();
    if (!raw) continue;
    const fields = raw.split(/\s+/);
    if (fields.length !== 4) throw new Error(`malformed list-jobs record with ${fields.length} fields`);
    const [idText, unit, type, state] = fields;
    if (!/^[1-9]\d*$/.test(idText) || !unit || !/^[a-z][a-z-]*$/i.test(type)
      || (state !== "running" && state !== "waiting")) {
      throw new Error("malformed list-jobs record");
    }
    const id = Number(idText);
    if (!Number.isSafeInteger(id) || ids.has(id)) throw new Error("invalid or duplicate list-jobs id");
    ids.add(id);
    jobs.push({ id, unit, type, state, raw });
  }
  return jobs;
}

export type UserManagerHealth = {
  responsive: boolean;
  parsed?: boolean;
  settled?: boolean;
  jobCount?: number;
  jobs?: string[];
  jobRecords?: SystemdJob[];
  persistentJobs?: string[];
  overJobCap?: boolean;
  error?: string;
};

export function workerSubmissionRejection(health: UserManagerHealth): string | undefined {
  if (!health.responsive) {
    return `systemd user manager is not responsive; refusing worker submission: ${health.error ?? "unknown liveness failure"}`;
  }
  if (health.parsed === false) {
    return `systemd user manager job state is ambiguous; refusing worker submission: ${health.error ?? "could not parse list-jobs"}`;
  }
  if (health.overJobCap || (health.jobCount ?? 0) > 32) {
    return `systemd user manager has ${health.jobCount} queued jobs; refusing worker submission until the backlog drops below 33`;
  }
  return undefined;
}

export async function getUserManagerHealth(
  runner: CommandRunner,
  options: { settleMs?: number } = {},
): Promise<UserManagerHealth> {
  const readJobs = async (): Promise<{ responsive: boolean; jobs?: SystemdJob[]; error?: string }> => {
    const result = await runner.exec(
      "systemctl",
      ["--user", "list-jobs", "--no-legend", "--no-pager", "--plain"],
      { timeout: 5000 },
    );
    if (result.killed) return { responsive: false, error: "systemctl list-jobs timed out" };
    if (result.code !== 0) return { responsive: false, error: result.stderr.trim() || result.stdout.trim() || `systemctl list-jobs exited ${result.code}` };
    try {
      return { responsive: true, jobs: parseSystemctlListJobs(result.stdout) };
    } catch (error) {
      return { responsive: true, error: `could not parse systemctl list-jobs: ${error instanceof Error ? error.message : String(error)}` };
    }
  };
  const first = await readJobs();
  if (!first.jobs) return { responsive: first.responsive, parsed: false, error: first.error };
  if (first.jobs.length === 0) return { responsive: true, parsed: true, settled: true, jobCount: 0, jobs: [], jobRecords: [], overJobCap: false };
  if (first.jobs.length > 32) {
    return { responsive: true, parsed: true, settled: false, jobCount: first.jobs.length, jobs: first.jobs.map((job) => job.raw), jobRecords: first.jobs, overJobCap: true };
  }
  await delay(options.settleMs ?? 250);
  const second = await readJobs();
  if (!second.jobs) {
    return { responsive: second.responsive, parsed: false, error: second.error, jobCount: first.jobs.length, jobs: first.jobs.map((job) => job.raw), jobRecords: first.jobs };
  }
  const secondIds = new Set(second.jobs.map((job) => job.id));
  const persistentJobs = first.jobs.filter((job) => secondIds.has(job.id)).map((job) => job.raw);
  return {
    responsive: true,
    parsed: true,
    settled: persistentJobs.length === 0,
    jobCount: second.jobs.length,
    jobs: second.jobs.map((job) => job.raw),
    jobRecords: second.jobs,
    overJobCap: second.jobs.length > 32,
    ...(persistentJobs.length ? { persistentJobs } : {}),
  };
}

export async function systemdAvailable(runner: CommandRunner): Promise<boolean> {
  const result = await runner.exec("systemctl", ["--user", "show-environment"], { timeout: 5000 });
  if (result.killed || result.code !== 0) return false;
  return (await getUserManagerHealth(runner)).responsive;
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
  properties?: string[];
}

export async function launchUnit(runner: CommandRunner, input: LaunchUnitInput): Promise<void> {
  markWorkerUnitMutation();
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
    `--working-directory=${input.cwd}`,
    "--property=KillMode=control-group",
    `--property=TimeoutStopSec=${Math.max(1, Math.floor(input.stopTimeoutSeconds))}s`,
    `--property=RuntimeMaxSec=${input.maxRuntime}`,
    "--property=StandardOutput=journal",
    "--property=StandardError=journal",
  ];
  for (const property of input.properties ?? []) {
    if (!property.includes("=") || property.includes("\0") || property.includes("\n")) continue;
    args.push(`--property=${property}`);
  }
  if (input.profile.mode === "one-shot") args.push("--property=RemainAfterExit=yes");
  for (const [key, value] of Object.entries(environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("\0")) continue;
    args.push(`--setenv=${key}=${value}`);
  }
  args.push(executable, ...input.args);
  // Submission and readiness are separate phases. --no-block prevents a
  // wedged user manager from holding this process indefinitely; callers must
  // subsequently prove that the queued job completed and the unit is running.
  args.splice(1, 0, "--no-block");
  const result = await runner.exec("systemd-run", args, { timeout: 15000 });
  if (result.killed) {
    throw new Error(`Could not determine whether ${input.unit} was submitted: systemd-run timed out`);
  }
  if (result.code !== 0) {
    throw new Error(`Could not start ${input.unit}: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`);
  }
}

function parseWorkerUnitIdentity(environment: string | undefined, expectedUnit: string): UnitStatus["workerIdentity"] {
  if (!environment) return undefined;
  const field = (name: string): string | undefined => {
    const matches = [...environment.matchAll(new RegExp(`(?:^|\\s)"?${name}=([^"\\s]*)"?(?=\\s|$)`, "g"))];
    return matches.at(-1)?.[1];
  };
  const workerId = field("AGENT_INTERCOM_WORKER_ID");
  const workerIncarnationId = field("AGENT_INTERCOM_RUN_ID");
  const unit = field("AGENT_INTERCOM_SYSTEMD_UNIT");
  const managerSessionId = field("AGENT_INTERCOM_MANAGER_SESSION_ID");
  const managerContext = field("AGENT_INTERCOM_MANAGER_CONTEXT");
  if (!workerId || !workerIncarnationId || unit !== expectedUnit || !managerSessionId
    || (managerContext !== "pi" && managerContext !== "opencode" && managerContext !== "headless_cli")
    || field("AGENT_INTERCOM_OWNED") !== "1") return undefined;
  return { workerId, workerIncarnationId, unit, managerSessionId, managerContext: managerContext as ManagerOwnerKind, owned: true };
}

export async function getUnitStatus(runner: CommandRunner, unit: string): Promise<UnitStatus> {
  const result = await runner.exec(
    "systemctl",
    [
      "--user",
      "show",
      unit,
      "--no-pager",
      "--property=LoadState,ActiveState,SubState,MainPID,Result,ExecMainStatus,Job,FreezerState,ActiveEnterTimestampMonotonic,InactiveEnterTimestampMonotonic,ExecMainStartTimestampMonotonic,Environment",
    ],
    { timeout: 5000 },
  );
  const values = parseSystemctlShow(result.stdout);
  if (result.killed) {
    return { verified: false, exists: values.LoadState !== "not-found", error: "systemctl show timed out" };
  }
  if (result.code !== 0 && values.LoadState !== "not-found") {
    return {
      verified: false,
      exists: false,
      error: result.stderr.trim() || result.stdout.trim() || `systemctl show exited ${result.code}`,
    };
  }
  const numeric = (value: string | undefined): number | undefined => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  };
  const mainPid = numeric(values.MainPID);
  const execMainStatus = Number(values.ExecMainStatus);
  return {
    verified: true,
    exists: values.LoadState !== "not-found",
    activeState: values.ActiveState,
    subState: values.SubState,
    ...(mainPid ? { mainPid } : {}),
    ...(values.Result ? { result: values.Result } : {}),
    ...(Number.isInteger(execMainStatus) ? { execMainStatus } : {}),
    ...(values.Job ? { job: values.Job } : {}),
    ...(values.FreezerState ? { freezerState: values.FreezerState } : {}),
    ...(numeric(values.ActiveEnterTimestampMonotonic) ? { activeEnterTimestampMonotonic: numeric(values.ActiveEnterTimestampMonotonic) } : {}),
    ...(numeric(values.InactiveEnterTimestampMonotonic) ? { inactiveEnterTimestampMonotonic: numeric(values.InactiveEnterTimestampMonotonic) } : {}),
    ...(numeric(values.ExecMainStartTimestampMonotonic) ? { execMainStartTimestampMonotonic: numeric(values.ExecMainStartTimestampMonotonic) } : {}),
    ...(parseWorkerUnitIdentity(values.Environment, unit) ? { workerIdentity: parseWorkerUnitIdentity(values.Environment, unit) } : {}),
  };
}

export function formatUnitStatus(status: UnitStatus): string {
  const fields = [
    `verified=${status.verified !== false}`,
    `exists=${status.exists}`,
    `state=${status.activeState ?? "unknown"}/${status.subState ?? "unknown"}`,
    `pid=${status.mainPid ?? 0}`,
    `job=${status.job || "none"}`,
  ];
  if (status.result) fields.push(`result=${status.result}`);
  if (status.execMainStatus !== undefined) fields.push(`exit=${status.execMainStatus}`);
  if (status.error) fields.push(`error=${status.error}`);
  return fields.join(" ");
}

export async function waitForUnitRunning(
  runner: CommandRunner,
  unit: string,
  options: { timeoutMs?: number; intervalMs?: number; stableMs?: number } = {},
): Promise<UnitStatus> {
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  const stableMs = options.stableMs ?? 750;
  let runningSince: number | undefined;
  let runningPid: number | undefined;
  let last: UnitStatus = { verified: false, exists: false, error: "no status observed" };
  while (Date.now() < deadline) {
    last = await getUnitStatus(runner, unit);
    if (last.verified !== false && !last.job && last.exists && last.activeState === "active" && Boolean(last.mainPid)) {
      if (runningPid !== last.mainPid) {
        runningPid = last.mainPid;
        runningSince = Date.now();
      }
      if (Date.now() - runningSince! >= stableMs) return last;
    } else {
      runningPid = undefined;
      runningSince = undefined;
    }
    if (last.verified !== false && !last.job && last.exists
      && (last.activeState === "failed" || (last.result && last.result !== "success"))) {
      throw new Error(`Worker unit ${unit} failed before readiness (${formatUnitStatus(last)})`);
    }
    await delay(options.intervalMs ?? 100);
  }
  throw new Error(`Timed out waiting for worker unit ${unit} to run (${formatUnitStatus(last)})`);
}

const MAX_VISIBLE_CGROUP_PROCESSES = 64;
const MAX_VISIBLE_EXECUTABLE_LENGTH = 80;

function compactUnitProcessTree(stdout: string): { tree: string; pids: number[] } {
  const pids: number[] = [];
  const processes: Array<{ pid: number; executable: string }> = [];
  for (const match of stdout.matchAll(/[├└]─(\d+)\s+(\S+)/g)) {
    const pid = Number(match[1]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    pids.push(pid);
    const rawExecutable = match[2].replace(/^['"]|['"]$/g, "");
    const executable = (basename(rawExecutable) || "process").slice(0, MAX_VISIBLE_EXECUTABLE_LENGTH);
    processes.push({ pid, executable });
  }

  const uniquePids = [...new Set(pids)];
  const header = stdout.split("\n", 1)[0]?.trim();
  const visible = processes.slice(0, MAX_VISIBLE_CGROUP_PROCESSES);
  const omitted = processes.length - visible.length;
  const lines = header ? [header] : [];
  for (const [index, process] of visible.entries()) {
    const isLast = index === visible.length - 1 && omitted === 0;
    lines.push(`${isLast ? "└" : "├"}─${process.pid} ${process.executable}`);
  }
  if (omitted > 0) lines.push(`└─… ${omitted} more process${omitted === 1 ? "" : "es"} omitted (${processes.length} total)`);
  return { tree: lines.join("\n"), pids: uniquePids };
}

export async function readUnitProcessTree(runner: CommandRunner, unit: string): Promise<{ tree: string; pids: number[] }> {
  // Read the complete cgroup for authoritative PID ownership, but never return
  // complete argv strings to the manager. Agent launch arguments can contain
  // prompts, configuration, and multiline shell snapshots that waste context
  // and may expose sensitive diagnostics.
  const result = await runner.exec("systemd-cgls", ["--user-unit", unit, "--no-pager", "--full"], { timeout: 5000 });
  if (result.code !== 0) return { tree: "", pids: [] };
  return compactUnitProcessTree(result.stdout);
}

export async function verifyUnitAbsentAndEmpty(
  runner: CommandRunner,
  unit: string,
): Promise<{ absent: boolean; reason?: string }> {
  const status = await runner.exec(
    "systemctl",
    ["--user", "show", unit, "--no-pager", "--property=LoadState,ActiveState,SubState,MainPID"],
    { timeout: 5000 },
  );
  const values = parseSystemctlShow(status.stdout);
  if (values.LoadState !== "not-found") {
    if (status.code !== 0) {
      return { absent: false, reason: `could not verify unit state: ${status.stderr.trim() || `exit ${status.code}`}` };
    }
    return { absent: false, reason: `unit is still loaded (${values.ActiveState || "unknown"}/${values.SubState || "unknown"})` };
  }
  return verifyUnitCgroupEmpty(runner, unit);
}

export async function verifyUnitCgroupEmpty(
  runner: CommandRunner,
  unit: string,
): Promise<{ absent: boolean; reason?: string }> {
  const processes = await runner.exec("systemd-cgls", ["--user-unit", unit, "--no-pager", "--full"], { timeout: 5000 });
  if (processes.code === 0) {
    const pids = [...processes.stdout.matchAll(/[├└]─(\d+)\s/g)]
      .map((match) => Number(match[1]))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
    return pids.length
      ? { absent: false, reason: `unit cgroup still owns processes: ${[...new Set(pids)].join(", ")}` }
      : { absent: true };
  }
  const diagnostic = `${processes.stdout}\n${processes.stderr}`;
  if (/not found|not loaded|no such (?:file|process|unit)|does not exist/i.test(diagnostic)) return { absent: true };
  return { absent: false, reason: `could not verify unit cgroup absence: ${processes.stderr.trim() || `exit ${processes.code}`}` };
}

export async function stopUnit(
  runner: CommandRunner,
  unit: string,
  options: { timeoutMs?: number; intervalMs?: number; stableMs?: number } = {},
): Promise<void> {
  markWorkerUnitMutation();
  try {
    const result = await runner.exec("systemctl", ["--user", "stop", "--no-block", unit], { timeout: 15000 });
    const missing = /not loaded|not found/i.test(`${result.stdout}\n${result.stderr}`);
    if (!result.killed && result.code !== 0 && !missing) {
      throw new Error(`Could not stop ${unit}: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`);
    }

    const deadline = Date.now() + (options.timeoutMs ?? 20_000);
    const stableMs = options.stableMs ?? 750;
    let conclusiveSince: number | undefined;
    let last: UnitStatus = { verified: false, exists: false, error: result.killed ? "systemctl stop timed out" : undefined };
    while (Date.now() < deadline) {
      last = await getUnitStatus(runner, unit);
      const conclusive = last.verified !== false && !last.job
        && (!last.exists || last.activeState === "inactive" || last.activeState === "failed");
      if (conclusive) {
        conclusiveSince ??= Date.now();
        if (Date.now() - conclusiveSince >= stableMs) break;
      } else {
        conclusiveSince = undefined;
      }
      await delay(options.intervalMs ?? 100);
    }
    if (last.verified === false || last.job
      || (last.exists && last.activeState !== "inactive" && last.activeState !== "failed")) {
      throw new Error(`Could not conclusively stop ${unit} (${formatUnitStatus(last)})`);
    }

    let remaining = await readUnitProcessTree(runner, unit);
    if (remaining.pids.length) {
      const killed = await runner.exec("systemctl", ["--user", "kill", "--kill-whom=all", "--signal=SIGKILL", unit], { timeout: 5000 });
      if (killed.killed) throw new Error(`Could not determine whether ${unit} descendants were killed: systemctl timed out`);
      remaining = await readUnitProcessTree(runner, unit);
    }
    if (remaining.pids.length) {
      throw new Error(`Worker unit ${unit} still owns processes after stop: ${remaining.pids.join(", ")}`);
    }
  } finally {
    await runner.exec("systemctl", ["--user", "reset-failed", unit], { timeout: 5000 }).catch(() => undefined);
  }
}

export async function listWorkerUnits(runner: CommandRunner): Promise<string[]> {
  const result = await runner.exec(
    "systemctl",
    ["--user", "list-units", "agent-intercom-worker-*", "--all", "--no-legend", "--no-pager", "--plain"],
    { timeout: 10000 },
  );
  if (result.code !== 0) return [];
  return result.stdout.split("\n").map((line) => line.trim().split(/\s+/, 1)[0]).filter(Boolean);
}

export async function listWorkerUnitsForVerification(
  runner: CommandRunner,
): Promise<{ verified: boolean; units: string[]; reason?: string }> {
  const result = await runner.exec(
    "systemctl",
    ["--user", "list-units", "agent-intercom-worker-*", "--all", "--no-legend", "--no-pager", "--plain"],
    { timeout: 10000 },
  );
  if (result.code !== 0) {
    return { verified: false, units: [], reason: result.stderr.trim() || `exit ${result.code}` };
  }
  return {
    verified: true,
    units: result.stdout.split("\n").map((line) => line.trim().split(/\s+/, 1)[0]).filter(Boolean),
  };
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

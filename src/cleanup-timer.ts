import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CommandRunner, OrchestratorConfig } from "./types.ts";

export const CLEANUP_SERVICE = "agent-intercom-fleet-cleanup.service";
export const CLEANUP_TIMER = "agent-intercom-fleet-cleanup.timer";

function quoteSystemd(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

async function writeIfChanged(path: string, content: string): Promise<boolean> {
  try {
    if (await readFile(path, "utf8") === content) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, { mode: 0o644 });
  await rename(temporary, path);
  return true;
}

export function cleanupUnitContents(input: {
  nodePath: string;
  cleanupScriptPath: string;
  intervalMinutes: number;
  agentDir?: string;
}): { service: string; timer: string } {
  const environment = [
    `Environment=${quoteSystemd("AGENT_INTERCOM_DISABLE_CLEANUP_TIMER=1")}`,
    ...(input.agentDir ? [`Environment=${quoteSystemd(`PI_CODING_AGENT_DIR=${input.agentDir}`)}`] : []),
  ];
  const service = [
    "[Unit]",
    "Description=Stop expired Agent Intercom worker cgroups",
    "After=default.target",
    "",
    "[Service]",
    "Type=oneshot",
    ...environment,
    `ExecStart=${quoteSystemd(input.nodePath)} ${quoteSystemd(input.cleanupScriptPath)}`,
    "Nice=10",
    "IOSchedulingClass=idle",
    "",
  ].filter((line, index, lines) => line || lines[index - 1] !== "").join("\n");
  const timer = [
    "[Unit]",
    "Description=Periodically clean expired Agent Intercom workers",
    "",
    "[Timer]",
    "OnBootSec=5min",
    `OnUnitActiveSec=${Math.max(1, input.intervalMinutes)}min`,
    "Persistent=true",
    `Unit=${CLEANUP_SERVICE}`,
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
  return { service, timer };
}

export async function ensureCleanupTimer(input: {
  runner: CommandRunner;
  config: OrchestratorConfig;
  cleanupScriptPath: string;
  agentDir: string;
  userConfigDir?: string;
}): Promise<{ enabled: boolean; changed: boolean }> {
  const { runner, config } = input;
  if (!config.cleanupTimerEnabled) {
    await runner.exec("systemctl", ["--user", "disable", "--now", CLEANUP_TIMER], { timeout: 10000 }).catch(() => undefined);
    return { enabled: false, changed: false };
  }
  const home = process.env.HOME;
  if (!input.userConfigDir && !home) throw new Error("HOME is required to configure the systemd user cleanup timer");
  const root = input.userConfigDir ?? join(home!, ".config", "systemd", "user");
  const contents = cleanupUnitContents({
    nodePath: process.execPath,
    cleanupScriptPath: input.cleanupScriptPath,
    intervalMinutes: config.cleanupTimerMinutes,
    ...(process.env.PI_CODING_AGENT_DIR ? { agentDir: input.agentDir } : {}),
  });
  const serviceChanged = await writeIfChanged(join(root, CLEANUP_SERVICE), contents.service);
  const timerChanged = await writeIfChanged(join(root, CLEANUP_TIMER), contents.timer);
  const changed = serviceChanged || timerChanged;
  if (changed) {
    const reload = await runner.exec("systemctl", ["--user", "daemon-reload"], { timeout: 10000 });
    if (reload.code !== 0) throw new Error(`Could not reload systemd user units: ${reload.stderr.trim() || reload.stdout.trim()}`);
  }
  const enable = await runner.exec("systemctl", ["--user", "enable", "--now", CLEANUP_TIMER], { timeout: 15000 });
  if (enable.code !== 0) throw new Error(`Could not enable ${CLEANUP_TIMER}: ${enable.stderr.trim() || enable.stdout.trim()}`);
  return { enabled: true, changed };
}

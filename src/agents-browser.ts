import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { WorkerState } from "./types.ts";
import { isLiveState } from "./workers.ts";

type Worker = {
  id: string;
  harness: string;
  role: string;
  state: string;
  task?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  permissionProfile?: string;
  intercomTarget?: string;
  unit?: string;
  mainPid?: number;
  managerSessionId?: string;
  managerOwner?: { sessionId?: string };
  updatedAt?: number;
  idleDeadlineAt?: number;
  lastError?: string;
};

type WorkerFile = { workers?: Worker[] };
type RegistryDiagnostic = { degraded?: boolean; reason?: string; untrackedLiveUnits?: string[] };

const ORCHESTRATOR_DIR = join(getAgentDir(), "intercom", "orchestrator");
const STATE_PATH = join(ORCHESTRATOR_DIR, "workers.json");
const REGISTRY_DIAGNOSTIC_PATH = join(ORCHESTRATOR_DIR, "worker-registry-diagnostic.json");

function isWorkerLive(worker: Worker): boolean {
  return isLiveState(worker.state as WorkerState);
}

async function readRegistryDiagnostic(): Promise<RegistryDiagnostic | undefined> {
  try {
    const parsed = JSON.parse(await readFile(REGISTRY_DIAGNOSTIC_PATH, "utf8")) as RegistryDiagnostic;
    return parsed.degraded ? parsed : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readWorkers(): Promise<Worker[]> {
  try {
    const parsed = JSON.parse(await readFile(STATE_PATH, "utf8")) as WorkerFile;
    return [...(parsed.workers ?? [])].sort((a, b) => {
      const liveDifference = Number(isWorkerLive(b)) - Number(isWorkerLive(a));
      return liveDifference || (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.id.localeCompare(b.id);
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function time(value?: number): string {
  return value ? new Date(value).toLocaleString() : "—";
}

function shortDirectory(path?: string): string {
  if (!path) return "—";
  const name = basename(path);
  return name || path;
}

function workerManagerSession(worker: Worker): string | undefined {
  return worker.managerOwner?.sessionId ?? worker.managerSessionId;
}

export default function agentsBrowser(pi: ExtensionAPI) {
  pi.registerCommand("agents", {
    description: "Browse coworkers; use /agents history for retained history or /agents all for every manager",
    handler: async (args, ctx) => {
      let [workers, registryDiagnostic] = await Promise.all([readWorkers(), readRegistryDiagnostic()]);
      const view = args.trim().toLowerCase();
      const crossManager = view === "all";
      const managerSession = ctx.sessionManager.getSessionId() || ctx.sessionManager.getSessionFile();
      const scopedWorkers = () => crossManager
        ? workers
        : workers.filter((worker) => workerManagerSession(worker) === managerSession);
      let showAll = view === "all" || view === "history";

      if (ctx.mode !== "tui") {
        const scoped = scopedWorkers();
        const visible = showAll ? scoped : scoped.filter(isWorkerLive);
        const degraded = registryDiagnostic
          ? `DEGRADED worker registry: ${registryDiagnostic.reason ?? "unresolved divergence"}\nVerified live but untracked units:\n${(registryDiagnostic.untrackedLiveUnits ?? []).map((unit) => `- ${unit}`).join("\n") || "- unavailable"}\nUnsafe worker mutations are blocked.`
          : undefined;
        const text = degraded ?? (visible.length
          ? visible.map((worker) => `${worker.id} [${worker.harness}/${worker.role}] ${worker.state}`).join("\n")
          : "No matching coworkers.");
        ctx.ui.notify(text, "info");
        return;
      }

      let selected = 0;
      let expanded = false;
      let refreshing = false;
      let refreshError: string | undefined;

      await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
        const visibleWorkers = () => {
          const scoped = scopedWorkers();
          return showAll ? scoped : scoped.filter(isWorkerLive);
        };
        const clampSelection = () => {
          const visible = visibleWorkers();
          selected = Math.max(0, Math.min(selected, Math.max(0, visible.length - 1)));
        };
        const refresh = async () => {
          if (refreshing) return;
          refreshing = true;
          refreshError = undefined;
          tui.requestRender();
          try {
            [workers, registryDiagnostic] = await Promise.all([readWorkers(), readRegistryDiagnostic()]);
            clampSelection();
          } catch (error) {
            refreshError = error instanceof Error ? error.message : String(error);
          } finally {
            refreshing = false;
            tui.requestRender();
          }
        };

        return {
          render(width: number): string[] {
            const inner = Math.max(20, width - 4);
            const visible = visibleWorkers();
            clampSelection();
            const scoped = scopedWorkers();
            const liveCount = scoped.filter(isWorkerLive).length;
            const border = theme.fg("border", "─".repeat(Math.max(1, width)));
            const lines: string[] = [border];
            const mode = showAll ? "all retained" : "live only";
            const scope = crossManager ? "all managers" : "this Pi";
            lines.push(truncateToWidth(`  ${theme.fg("accent", theme.bold("Agents"))}  ${theme.fg("muted", `${liveCount} live · ${scoped.length} total · ${scope} · ${mode}`)}`, width));
            lines.push(border);

            if (registryDiagnostic) {
              lines.push(truncateToWidth(`  ${theme.fg("error", theme.bold("DEGRADED worker registry"))}`, width));
              for (const reasonLine of wrapTextWithAnsi(registryDiagnostic.reason ?? "unresolved divergence", inner - 2).slice(0, 3)) {
                lines.push(truncateToWidth(`  ${theme.fg("warning", reasonLine)}`, width));
              }
              const units = registryDiagnostic.untrackedLiveUnits ?? [];
              lines.push(truncateToWidth(`  ${theme.fg("error", `${units.length} verified live but untracked unit${units.length === 1 ? "" : "s"}; mutations blocked`)}`, width));
              for (const unit of units.slice(0, 4)) lines.push(truncateToWidth(`  ${theme.fg("warning", `• ${unit}`)}`, width));
              lines.push(border);
            }

            if (visible.length === 0) {
              lines.push(truncateToWidth(`  ${theme.fg("muted", "No matching coworkers.")}`, width));
              lines.push("");
            } else {
              const maxRows = 8;
              const start = Math.max(0, Math.min(selected - Math.floor(maxRows / 2), Math.max(0, visible.length - maxRows)));
              const end = Math.min(visible.length, start + maxRows);
              for (let index = start; index < end; index += 1) {
                const worker = visible[index]!;
                const active = index === selected;
                const prefix = active ? theme.fg("accent", "›") : " ";
                const stateColor = worker.state === "failed" || worker.state === "lost"
                  ? "error"
                  : isWorkerLive(worker)
                    ? "success"
                    : "muted";
                const row = `${prefix} ${theme.fg("accent", worker.id)}  ${theme.fg("warning", worker.harness)}/${theme.fg("muted", worker.role)}  ${theme.fg(stateColor, worker.state)}`;
                const styled = active ? theme.bold(row) : row;
                lines.push(truncateToWidth(` ${styled}`, width));
              }
              if (visible.length > maxRows) lines.push(truncateToWidth(`  ${theme.fg("dim", `${selected + 1}/${visible.length}`)}`, width));

              const worker = visible[selected]!;
              lines.push(border);
              const stateColor = worker.state === "failed" || worker.state === "lost"
                ? "error"
                : isWorkerLive(worker)
                  ? "success"
                  : "muted";
              lines.push(truncateToWidth(`  ${theme.fg("accent", theme.bold(worker.id))}  ${theme.fg(stateColor, worker.state)}`, width));
              const identity = [
                `${theme.fg("dim", "harness")} ${theme.fg("warning", worker.harness)}`,
                `${theme.fg("dim", "role")} ${theme.fg("accent", worker.role)}`,
                worker.model ? `${theme.fg("dim", "model")} ${theme.fg("text", worker.model)}${worker.effort ? theme.fg("warning", `/${worker.effort}`) : ""}` : worker.effort ? `${theme.fg("dim", "effort")} ${theme.fg("warning", worker.effort)}` : undefined,
                worker.permissionProfile ? `${theme.fg("dim", "permission")} ${theme.fg("muted", worker.permissionProfile)}` : undefined,
              ].filter(Boolean).join(theme.fg("dim", "  ·  "));
              lines.push(truncateToWidth(`  ${identity}`, width));
              lines.push(truncateToWidth(`  ${theme.fg("dim", "cwd")}  ${theme.fg("text", expanded ? worker.cwd ?? "—" : shortDirectory(worker.cwd))}`, width));

              if (worker.task) {
                const taskLimit = expanded ? 5 : 1;
                const taskLines = wrapTextWithAnsi(worker.task, inner - 6).slice(0, taskLimit);
                for (let index = 0; index < taskLines.length; index += 1) {
                  const label = index === 0 ? `${theme.fg("dim", "task")}  ` : "      ";
                  lines.push(truncateToWidth(`  ${label}${theme.fg("text", taskLines[index]!)}`, width));
                }
                if (!expanded && wrapTextWithAnsi(worker.task, inner - 6).length > 1) {
                  lines[lines.length - 1] = truncateToWidth(`${lines[lines.length - 1]} ${theme.fg("dim", "…")}`, width);
                }
              }

              if (expanded) {
                if (worker.intercomTarget) lines.push(truncateToWidth(`  ${theme.fg("dim", "intercom")}  ${theme.fg("accent", worker.intercomTarget)}`, width));
                if (worker.unit) lines.push(truncateToWidth(`  ${theme.fg("dim", "unit")}  ${worker.unit}${worker.mainPid ? ` · ${theme.fg("dim", "pid")} ${worker.mainPid}` : ""}`, width));
                lines.push(truncateToWidth(`  ${theme.fg("dim", "updated")}  ${time(worker.updatedAt)}  ${theme.fg("dim", "· idle deadline")}  ${time(worker.idleDeadlineAt)}`, width));
                const ownerSession = workerManagerSession(worker);
                if (ownerSession) lines.push(truncateToWidth(`  ${theme.fg("dim", "manager")}  ${ownerSession}`, width));
              }
              if (worker.lastError) lines.push(truncateToWidth(`  ${theme.fg("error", `error  ${worker.lastError}`)}`, width));
              lines.push(truncateToWidth(`  ${theme.fg("dim", `enter ${expanded ? "collapse" : "expand details"}`)}`, width));
            }

            if (refreshError) lines.push(truncateToWidth(`  ${theme.fg("error", `refresh failed: ${refreshError}`)}`, width));
            lines.push(border);
            lines.push(truncateToWidth(`  ${theme.fg("dim", `↑↓ select · enter ${expanded ? "collapse" : "expand"} · r refresh${refreshing ? "ing…" : ""} · a ${showAll ? "live only" : "show all"} · esc close · read-only`)}`, width));
            lines.push(border);
            return lines.map((line) => theme.bg("customMessageBg", truncateToWidth(line, width, "", true)));
          },
          handleInput(data: string): void {
            const visible = visibleWorkers();
            if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
              done();
              return;
            }
            if (matchesKey(data, Key.up)) {
              selected = Math.max(0, selected - 1);
              expanded = false;
            } else if (matchesKey(data, Key.down)) {
              selected = Math.min(Math.max(0, visible.length - 1), selected + 1);
              expanded = false;
            } else if (matchesKey(data, Key.enter) && visible.length > 0) {
              expanded = !expanded;
            } else if (data === "a") {
              showAll = !showAll;
              expanded = false;
              clampSelection();
            } else if (data === "r") {
              void refresh();
              return;
            }
            tui.requestRender();
          },
          invalidate(): void {},
        };
      }, {
        overlay: true,
        overlayOptions: {
          width: "90%",
          minWidth: 64,
          maxHeight: "90%",
          anchor: "center",
          margin: 1,
        },
      });
    },
  });
}

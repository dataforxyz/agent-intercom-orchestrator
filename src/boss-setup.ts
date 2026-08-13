import { constants as fsConstants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { BOSS_ONBOARDING_VERSION, isBossOnboardingComplete, readConfig, writeConfigDefaults } from "./config.ts";
import { TRUSTED_LOCAL_BOSS_PARTICIPANT_HARNESS, TRUSTED_LOCAL_BOSS_PARTICIPANT_PROFILE } from "./boss-team-environment.ts";
import type { BossBaselineRole, BossRolePreference, Effort, OrchestratorConfig } from "./types.ts";

export const BOSS_SETUP_SCHEMA_VERSION = "orc.boss-setup-report.v1" as const;
export const BOSS_SETUP_WARNING = "TRUSTED LOCAL MODE — same-user agents and local files are trusted; evidence is advisory, not tamper-proof.";

export type BossResourceId = "intercom-pi" | "orchestrator" | "ralph" | "return-on";
export type BossResourceStatus = "ready" | "warning" | "blocked";

interface BossResourceDefinition {
  id: BossResourceId;
  packageName: string;
  source: string;
  repositoryPath: string;
  legacyPackageNames?: readonly string[];
  legacyRepositoryPaths?: readonly string[];
  extensionPath: string;
  unpublished?: boolean;
}

const REQUIRED_RESOURCES: readonly BossResourceDefinition[] = [
  { id: "intercom-pi", packageName: "@dataforxyz/agent-intercom-pi", source: "git:github.com/dataforxyz/agent-intercom-pi", repositoryPath: "dataforxyz/agent-intercom-pi", extensionPath: "index.ts" },
  { id: "orchestrator", packageName: "@dataforxyz/orcboss", source: "git:github.com/dataforxyz/orcboss", repositoryPath: "dataforxyz/orcboss", legacyPackageNames: ["@dataforxyz/agent-intercom-orchestrator"], legacyRepositoryPaths: ["dataforxyz/agent-intercom-orchestrator"], extensionPath: "src/index.ts" },
  { id: "ralph", packageName: "pi-extensions", source: "git:github.com/dataforxyz/pi-extensions", repositoryPath: "dataforxyz/pi-extensions", extensionPath: "pi-ralph-wiggum/index.ts" },
  { id: "return-on", packageName: "pi-return-on", source: "git:github.com/dataforxyz/pi-return-on", repositoryPath: "dataforxyz/pi-return-on", extensionPath: "src/index.ts", unpublished: true },
] as const;

export interface BossPackageSetting {
  index: number;
  source: string;
  objectEntry: boolean;
  extensions?: string[];
}

export interface BossResourceInventory {
  id: BossResourceId;
  packageName: string;
  expectedSource: string;
  configured: BossPackageSetting[];
  root?: string;
  manifestVersion?: string;
  extensionPath: string;
  extensionExists: boolean;
  enabledForController: boolean;
  git?: { root: string; dirty: boolean; branch?: string; revision?: string };
  pinned: boolean;
  unpublished: boolean;
  status: BossResourceStatus;
  diagnostics: string[];
  remediation?: string;
}

export interface BossSetupReport {
  version: typeof BOSS_SETUP_SCHEMA_VERSION;
  warning: typeof BOSS_SETUP_WARNING;
  agentDir: string;
  settingsPath: string;
  status: BossResourceStatus;
  resources: BossResourceInventory[];
  changes: Array<{ action: "install"; resource: BossResourceId; command: string }>;
  blockers: string[];
}

export interface BossOnboardingInput {
  roles: Record<BossBaselineRole, Required<BossRolePreference>>;
  handlePrefix: string;
}

export interface BossSetupApplyResult {
  report: BossSetupReport;
  configPath: string;
  installed: BossResourceId[];
  onboardingChanged: boolean;
}

export const BOSS_READINESS_SCHEMA_VERSION = "orc.boss-readiness-report.v1" as const;

export interface BossReadinessCheck {
  id: "required-stack" | "host" | "intercom" | "onboarding" | "models" | "state";
  status: BossResourceStatus;
  summary: string;
  diagnostics: string[];
  remediation?: string;
}

export interface BossReadinessReport {
  version: typeof BOSS_READINESS_SCHEMA_VERSION;
  warning: typeof BOSS_SETUP_WARNING;
  status: BossResourceStatus;
  checks: BossReadinessCheck[];
  setup: BossSetupReport;
  blockers: string[];
}

export interface BossReadinessInput {
  agentDir: string;
  config: OrchestratorConfig;
  host: { systemdAvailable: boolean; userManagerResponsive: boolean; detail?: string };
  intercom: { controllerRegistered: boolean; detail?: string };
  statePaths: string[];
  availablePiModels?: string[];
  setup?: BossSetupReport;
}

const BOSS_ROLES: BossBaselineRole[] = ["manager", "worker", "scout", "adversary"];
const EFFORTS = new Set<Effort>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const BOSS_HANDLE_PREFIX = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

async function json(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return plainRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

export function parseBossPackageSettings(value: unknown): BossPackageSetting[] {
  if (!plainRecord(value) || !Array.isArray(value.packages)) return [];
  return value.packages.flatMap((entry, index): BossPackageSetting[] => {
    if (typeof entry === "string") return [{ index, source: entry, objectEntry: false }];
    if (!plainRecord(entry) || typeof entry.source !== "string") return [];
    const extensions = Array.isArray(entry.extensions)
      ? entry.extensions.filter((item): item is string => typeof item === "string")
      : undefined;
    return [{ index, source: entry.source, objectEntry: true, ...(extensions ? { extensions } : {}) }];
  });
}

function normalizedSource(source: string): string {
  return source.replace(/^git\+https:\/\/github\.com\//, "git:github.com/").replace(/\.git(?=[@#]|$)/, "");
}

function sourceRepository(source: string): string | undefined {
  const match = /^git:github\.com\/([^@#]+?)(?:\.git)?(?:[@#].*)?$/.exec(normalizedSource(source));
  return match?.[1];
}

function sourceMatches(entry: BossPackageSetting, definition: BossResourceDefinition): boolean {
  const repository = sourceRepository(entry.source);
  if (repository === definition.repositoryPath || definition.legacyRepositoryPaths?.includes(repository ?? "")) return true;
  return [definition.packageName, ...(definition.legacyPackageNames ?? [])].some((name) => entry.source.includes(name));
}

function sourcePinned(source: string): boolean {
  const normalized = normalizedSource(source);
  if (/^git:github\.com\/[^@#]+(?:@|#).+$/.test(normalized)) return true;
  return /^npm:(?:@[^/]+\/)?[^@]+@.+$/.test(source);
}

function configuredRoot(agentDir: string, source: string): string | undefined {
  const repository = sourceRepository(source);
  if (repository) return join(agentDir, "git", "github.com", repository);
  const npm = /^npm:(?:@([^/]+)\/)?([^@]+)(?:@.*)?$/.exec(source);
  if (npm) return join(agentDir, "npm", "node_modules", ...(npm[1] ? [`@${npm[1]}`] : []), npm[2]);
  return undefined;
}

function gitValue(root: string, args: string[]): string | undefined {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

async function inspectResource(agentDir: string, settings: BossPackageSetting[], definition: BossResourceDefinition): Promise<BossResourceInventory> {
  const configured = settings.filter((entry) => sourceMatches(entry, definition));
  const diagnostics: string[] = [];
  if (configured.length === 0) diagnostics.push("Required global Pi package source is not configured.");
  if (configured.length > 1) diagnostics.push("Multiple matching global package sources are configured; choose one explicitly.");
  const chosen = configured.length === 1 ? configured[0] : undefined;
  const candidateRoot = chosen ? configuredRoot(agentDir, chosen.source) : undefined;
  const root = candidateRoot && await exists(candidateRoot) ? await realpath(candidateRoot) : undefined;
  if (chosen && !root) diagnostics.push(`Configured package root is missing: ${candidateRoot}`);
  const manifest = root ? await json(join(root, "package.json")) : undefined;
  if (root && manifest?.name !== definition.packageName) diagnostics.push(`Manifest identity mismatch: expected ${definition.packageName}, found ${String(manifest?.name ?? "missing")}.`);
  const extensionPath = root ? join(root, definition.extensionPath) : definition.extensionPath;
  const extensionExists = Boolean(root && await exists(extensionPath));
  if (root && !extensionExists) diagnostics.push(`Required extension entrypoint is missing: ${extensionPath}`);
  const enabledForController = Boolean(chosen && (!chosen.extensions || chosen.extensions.includes(definition.extensionPath) || chosen.extensions.includes(`./${definition.extensionPath}`)));
  if (chosen?.extensions && !enabledForController) diagnostics.push(`Package filter does not enable ${definition.extensionPath} for the Controller.`);
  const gitRoot = root ? gitValue(root, ["rev-parse", "--show-toplevel"]) : undefined;
  const dirty = gitRoot ? Boolean(gitValue(gitRoot, ["status", "--porcelain"])) : false;
  if (dirty) diagnostics.push(`Recognized Git checkout is dirty and must not be reset or replaced: ${gitRoot}`);
  const pinned = configured.some((entry) => sourcePinned(entry.source));
  if (pinned) diagnostics.push("Package source is explicitly pinned; setup will not move the pin.");
  const blocking = configured.length !== 1 || !root || manifest?.name !== definition.packageName || !extensionExists || !enabledForController || dirty || pinned;
  const status: BossResourceStatus = blocking ? "blocked" : "ready";
  const remediation = configured.length === 0
    ? `pi install ${definition.source}`
    : dirty
      ? `Commit, stash, or separately preserve changes in ${gitRoot}; do not run broad Pi update commands until resolved.`
      : pinned
        ? `Review and explicitly change the pin in ${join(agentDir, "settings.json")} if an update is intended.`
        : diagnostics.length
          ? `Repair the displayed global package entry without replacing object filters or unrelated settings.`
          : undefined;
  return {
    id: definition.id,
    packageName: definition.packageName,
    expectedSource: definition.source,
    configured,
    ...(root ? { root } : {}),
    ...(typeof manifest?.version === "string" ? { manifestVersion: manifest.version } : {}),
    extensionPath,
    extensionExists,
    enabledForController,
    ...(gitRoot ? { git: { root: gitRoot, dirty, ...(gitValue(gitRoot, ["branch", "--show-current"]) ? { branch: gitValue(gitRoot, ["branch", "--show-current"]) } : {}), ...(gitValue(gitRoot, ["rev-parse", "HEAD"]) ? { revision: gitValue(gitRoot, ["rev-parse", "HEAD"]) } : {}) } } : {}),
    pinned,
    unpublished: Boolean(definition.unpublished),
    status,
    diagnostics,
    ...(remediation ? { remediation } : {}),
  };
}

export function validateBossOnboardingInput(input: BossOnboardingInput): string[] {
  const errors: string[] = [];
  if (!BOSS_HANDLE_PREFIX.test(input.handlePrefix)) errors.push("handlePrefix must be 1-32 lowercase letters, numbers, or dashes and cannot begin or end with a dash.");
  for (const role of BOSS_ROLES) {
    const preference = input.roles[role];
    if (!preference || typeof preference.model !== "string" || !preference.model.trim() || preference.model.includes("*")) {
      errors.push(`${role}.model must be one explicit non-wildcard model identifier.`);
    }
    if (!preference || !EFFORTS.has(preference.effort)) errors.push(`${role}.effort is unsupported.`);
  }
  return errors;
}

export async function inspectBossSetup(options: { agentDir: string }): Promise<BossSetupReport> {
  const agentDir = resolve(options.agentDir);
  const settingsPath = join(agentDir, "settings.json");
  const settingsValue = await json(settingsPath);
  const settings = parseBossPackageSettings(settingsValue);
  const resources = await Promise.all(REQUIRED_RESOURCES.map((definition) => inspectResource(agentDir, settings, definition)));
  const changes = resources.flatMap((resource) => resource.configured.length === 0
    ? [{ action: "install" as const, resource: resource.id, command: `pi install ${resource.expectedSource}` }]
    : []);
  const blockers = resources.flatMap((resource) => resource.status === "blocked" && resource.configured.length > 0
    ? resource.diagnostics.map((diagnostic) => `${resource.id}: ${diagnostic}`)
    : []);
  return {
    version: BOSS_SETUP_SCHEMA_VERSION,
    warning: BOSS_SETUP_WARNING,
    agentDir,
    settingsPath,
    status: resources.every((resource) => resource.status === "ready") ? "ready" : "blocked",
    resources,
    changes,
    blockers,
  };
}

async function nearestWritablePath(path: string): Promise<string | undefined> {
  let candidate = resolve(path);
  while (true) {
    try {
      await access(candidate, fsConstants.W_OK);
      return candidate;
    } catch {
      try {
        await access(candidate, fsConstants.F_OK);
        return undefined;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
      }
      const parent = dirname(candidate);
      if (parent === candidate) return undefined;
      candidate = parent;
    }
  }
}

export async function inspectTrustedLocalBossReadiness(options: BossReadinessInput): Promise<BossReadinessReport> {
  const setup = options.setup ?? await inspectBossSetup({ agentDir: options.agentDir });
  const checks: BossReadinessCheck[] = [];
  checks.push({
    id: "required-stack",
    status: setup.status,
    summary: setup.status === "ready" ? "All four required global Pi resources are recognized and enabled." : "The required global Pi stack is incomplete or unsafe.",
    diagnostics: setup.resources.flatMap((resource) => resource.diagnostics.map((item) => `${resource.id}: ${item}`)),
    ...(setup.status === "blocked" ? { remediation: "Run `agent-intercom-boss-setup --plan`, resolve blockers, then explicitly apply the reviewed plan." } : {}),
  });
  const hostReady = options.host.systemdAvailable && options.host.userManagerResponsive;
  checks.push({
    id: "host",
    status: hostReady ? "ready" : "blocked",
    summary: hostReady ? "The systemd user manager can supervise Boss participants." : "The systemd user manager is unavailable or unresponsive.",
    diagnostics: options.host.detail ? [options.host.detail] : [],
    ...(!hostReady ? { remediation: "Restore a responsive systemd user manager before creating a Boss run." } : {}),
  });
  checks.push({
    id: "intercom",
    status: options.intercom.controllerRegistered ? "ready" : "blocked",
    summary: options.intercom.controllerRegistered ? "The Controller has an active Agent Intercom identity and event bridge." : "The Controller is not registered with the Agent Intercom runtime.",
    diagnostics: options.intercom.detail ? [options.intercom.detail] : [],
    ...(!options.intercom.controllerRegistered ? { remediation: "Load Agent Intercom Pi globally and restart or reload the interactive Pi Controller." } : {}),
  });

  const roleInput = Object.fromEntries(BOSS_ROLES.map((role) => [role, options.config.boss.roles[role]])) as BossOnboardingInput["roles"];
  const onboardingErrors = validateBossOnboardingInput({ roles: roleInput, handlePrefix: options.config.boss.handlePrefix });
  const participantProfile = options.config.profiles[TRUSTED_LOCAL_BOSS_PARTICIPANT_PROFILE];
  if (!participantProfile) onboardingErrors.push(`Required Boss participant profile '${TRUSTED_LOCAL_BOSS_PARTICIPANT_PROFILE}' is unavailable.`);
  else {
    if (participantProfile.harness !== TRUSTED_LOCAL_BOSS_PARTICIPANT_HARNESS) onboardingErrors.push(`Boss participant profile '${TRUSTED_LOCAL_BOSS_PARTICIPANT_PROFILE}' must launch ${TRUSTED_LOCAL_BOSS_PARTICIPANT_HARNESS}, not ${participantProfile.harness}.`);
    if ((participantProfile.mode ?? "persistent") !== "persistent") onboardingErrors.push(`Boss participant profile '${TRUSTED_LOCAL_BOSS_PARTICIPANT_PROFILE}' must use persistent mode.`);
    if (participantProfile.spawnable === false) onboardingErrors.push(`Boss participant profile '${TRUSTED_LOCAL_BOSS_PARTICIPANT_PROFILE}' must be spawnable.`);
  }
  const onboardingReady = isBossOnboardingComplete(options.config) && onboardingErrors.length === 0;
  const configuredTopology = [
    `topology: Manager, Worker, Scout, and Adversary launch as independent Pi peers pinned to profile=${TRUSTED_LOCAL_BOSS_PARTICIPANT_PROFILE}; native Codex/Claude/OpenCode subagent topology and per-run model overrides are unavailable`,
    ...BOSS_ROLES.map((role) => {
      const preference = options.config.boss.roles[role];
      return `${role}: harness=${TRUSTED_LOCAL_BOSS_PARTICIPANT_HARNESS}; profile=${TRUSTED_LOCAL_BOSS_PARTICIPANT_PROFILE}; model=${preference?.model ?? "unavailable"}; effort=${preference?.effort ?? "unavailable"}`;
    }),
  ];
  checks.push({
    id: "onboarding",
    status: onboardingReady ? "ready" : "blocked",
    summary: onboardingReady ? "Versioned Boss onboarding and all role preferences are complete." : "Boss onboarding or explicit role preferences are incomplete.",
    diagnostics: [...configuredTopology, ...(!isBossOnboardingComplete(options.config) ? [`Expected onboarding ${BOSS_ONBOARDING_VERSION}.`] : []), ...onboardingErrors],
    ...(!onboardingReady ? { remediation: "Run the direct-user Boss setup preview and apply explicit Manager, Worker, Scout, and Adversary model/effort choices." } : {}),
  });

  const availableModels = options.availablePiModels;
  const configuredModels = BOSS_ROLES.map((role) => options.config.boss.roles[role]?.model).filter((model): model is string => Boolean(model));
  const missingModels = availableModels?.length ? configuredModels.filter((model) => !availableModels.includes(model)) : [];
  const modelStatus: BossResourceStatus = missingModels.length ? "blocked" : availableModels?.length ? "ready" : "warning";
  checks.push({
    id: "models",
    status: modelStatus,
    summary: missingModels.length
      ? "One or more configured Boss role models are absent from Pi's current model catalog."
      : availableModels?.length
        ? "Every configured Boss role model appears in Pi's current model catalog."
        : "Explicit role models are configured, but Pi's model catalog could not be enumerated.",
    diagnostics: missingModels.map((model) => `Unavailable configured model: ${model}`),
    ...(missingModels.length ? { remediation: "Choose installed/authenticated Pi models in Boss setup, or restore the configured provider before creating a run." } : {}),
  });

  const unwritable: string[] = [];
  for (const path of [...new Set(options.statePaths.map((path) => resolve(path)))]) {
    if (!await nearestWritablePath(path)) unwritable.push(path);
  }
  checks.push({
    id: "state",
    status: unwritable.length ? "blocked" : "ready",
    summary: unwritable.length ? "One or more Boss state roots are unwritable or have no writable existing ancestor." : "Boss, worker, Ralph, and Return On state roots are writable or have writable existing ancestors.",
    diagnostics: unwritable.map((path) => `State path is unwritable or has no writable existing ancestor: ${path}`),
    ...(unwritable.length ? { remediation: "Repair ownership/permissions or select writable PI_CODING_AGENT_DIR and XDG_RUNTIME_DIR locations." } : {}),
  });

  const blockers = checks.flatMap((check) => check.status === "blocked"
    ? [check.summary, ...check.diagnostics].map((item) => `${check.id}: ${item}`)
    : []);
  const status: BossResourceStatus = blockers.length ? "blocked" : checks.some((check) => check.status === "warning") ? "warning" : "ready";
  return { version: BOSS_READINESS_SCHEMA_VERSION, warning: BOSS_SETUP_WARNING, status, checks, setup, blockers };
}

export function formatBossReadinessReport(report: BossReadinessReport): string {
  const lines = [report.warning, "", `Orc Boss trusted-local readiness: ${report.status}`];
  for (const check of report.checks) {
    lines.push(`- ${check.id}: ${check.status} — ${check.summary}`);
    for (const diagnostic of check.diagnostics) lines.push(`  ${diagnostic}`);
    if (check.remediation) lines.push(`  remediation: ${check.remediation}`);
  }
  if (report.status !== "blocked") lines.push("", "Create is permitted. Warnings remain advisory and do not imply tamper-proof authority.");
  else lines.push("", "Create is blocked before run state or workers are created.");
  return lines.join("\n");
}

export async function applyBossSetup(options: {
  agentDir: string;
  onboarding: BossOnboardingInput;
  install?: (source: string, resource: BossResourceId) => Promise<void>;
  now?: () => Date;
}): Promise<BossSetupApplyResult> {
  const validation = validateBossOnboardingInput(options.onboarding);
  if (validation.length) throw new Error(`BOSS_SETUP_INVALID_ONBOARDING:\n${validation.map((item) => `- ${item}`).join("\n")}`);
  const before = await inspectBossSetup({ agentDir: options.agentDir });
  if (before.blockers.length) throw new Error(`BOSS_SETUP_BLOCKED:\n${before.blockers.map((item) => `- ${item}`).join("\n")}`);
  const install = options.install ?? (async (source: string) => {
    const result = spawnSync("pi", ["install", source], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (result.status !== 0) throw new Error(`pi install ${source} failed: ${(result.stderr || result.stdout || `exit ${result.status}`).trim()}`);
  });
  const installed: BossResourceId[] = [];
  for (const change of before.changes) {
    await install(before.resources.find((resource) => resource.id === change.resource)!.expectedSource, change.resource);
    installed.push(change.resource);
  }
  const report = await inspectBossSetup({ agentDir: options.agentDir });
  if (report.status !== "ready") {
    throw new Error(`BOSS_SETUP_POST_APPLY_VERIFICATION_FAILED:\n${report.resources.flatMap((resource) => resource.diagnostics.map((item) => `- ${resource.id}: ${item}`)).join("\n")}`);
  }
  const configPath = join(resolve(options.agentDir), "intercom", "orchestrator", "config.json");
  const config = await readConfig(configPath);
  const onboardingChanged = JSON.stringify(config.boss.roles) !== JSON.stringify(options.onboarding.roles)
    || config.boss.handlePrefix !== options.onboarding.handlePrefix
    || config.boss.onboarding?.version !== BOSS_ONBOARDING_VERSION;
  if (onboardingChanged) {
    config.boss.roles = structuredClone(options.onboarding.roles);
    config.boss.handlePrefix = options.onboarding.handlePrefix;
    config.boss.onboarding = { version: BOSS_ONBOARDING_VERSION, completedAt: (options.now ?? (() => new Date()))().toISOString() };
    await writeConfigDefaults(configPath, config);
  }
  return { report, configPath, installed, onboardingChanged };
}

export function formatBossSetupReport(report: BossSetupReport, mode: "check" | "plan" = "plan"): string {
  const lines = [report.warning, "", `Orc Boss setup ${mode}: ${report.status}`];
  for (const resource of report.resources) {
    lines.push(`- ${resource.id}: ${resource.status}; source=${resource.configured.map((entry) => entry.source).join(", ") || "missing"}; root=${resource.root ?? "missing"}`);
    for (const diagnostic of resource.diagnostics) lines.push(`  ${diagnostic}`);
    if (resource.remediation) lines.push(`  remediation: ${resource.remediation}`);
  }
  if (mode === "plan") {
    lines.push("", report.changes.length ? "Proposed changes (preview only):" : "No automatic install changes are proposed.");
    for (const change of report.changes) lines.push(`- ${change.command}`);
    if (report.blockers.length) lines.push("Blocked changes require direct user resolution; no settings were modified.");
  }
  return lines.join("\n");
}

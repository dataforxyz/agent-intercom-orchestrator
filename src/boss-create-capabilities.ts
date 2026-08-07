import { constants } from "node:fs";
import { access, lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import type { BossCreateRequirements } from "./boss-command.ts";
import type { PermissionProfile } from "./types.ts";

export type BossCreateCapability = "worktree" | "edit" | "tests" | "git-transport";
export type BossCreateCapabilityAvailability = "available" | "unavailable";

export interface BossCreateCapabilityFinding {
  capability: BossCreateCapability;
  requested: "read" | "write" | "required";
  availability: BossCreateCapabilityAvailability;
  evidence: string;
}

export interface BossCreateCapabilityReport {
  status: "ready" | "blocked";
  cwd: string;
  requirements: BossCreateRequirements;
  findings: BossCreateCapabilityFinding[];
}

async function isDirectory(path: string): Promise<boolean> {
  return lstat(path).then((entry) => entry.isDirectory(), () => false);
}

async function canAccess(path: string, mode: number): Promise<boolean> {
  return access(path, mode).then(() => true, () => false);
}

async function linkedWorktreeRoot(cwd: string): Promise<string | undefined> {
  let candidate = resolve(cwd);
  const filesystemRoot = parse(candidate).root;
  while (true) {
    const dotGit = join(candidate, ".git");
    const entry = await lstat(dotGit).catch(() => undefined);
    if (entry?.isFile()) {
      const marker = await readFile(dotGit, "utf8").catch(() => "");
      const match = /^gitdir: ([^\r\n]+)\r?$/m.exec(marker);
      if (!match) return undefined;
      const gitDirectory = isAbsolute(match[1]) ? match[1] : resolve(candidate, match[1]);
      if (!await isDirectory(gitDirectory)) return undefined;
      const commonDirectory = await readFile(join(gitDirectory, "commondir"), "utf8").catch(() => "");
      if (!commonDirectory.trim()) return undefined;
      const resolvedCommonDirectory = isAbsolute(commonDirectory.trim())
        ? commonDirectory.trim()
        : resolve(gitDirectory, commonDirectory.trim());
      return await isDirectory(resolvedCommonDirectory) ? candidate : undefined;
    }
    if (entry?.isDirectory()) return undefined;
    if (candidate === filesystemRoot) return undefined;
    candidate = dirname(candidate);
  }
}

function toolConfigured(profile: PermissionProfile, tool: string): boolean {
  return profile.piTools === undefined || profile.piTools.includes(tool);
}

export async function inspectBossCreateCapabilities(input: {
  cwd: string;
  requirements: BossCreateRequirements;
  workerPermissionProfileName: string;
  workerPermissionProfile: PermissionProfile;
}): Promise<BossCreateCapabilityReport> {
  const cwd = resolve(input.cwd);
  const findings: BossCreateCapabilityFinding[] = [];
  const workspaceReadable = await canAccess(cwd, constants.R_OK);
  const workspaceWritable = await canAccess(cwd, constants.W_OK);
  const policyReadable = input.workerPermissionProfile.workspace === "host"
    || input.workerPermissionProfile.workspace === "read-only"
    || input.workerPermissionProfile.workspace === "read-write";
  const policyWritable = input.workerPermissionProfile.workspace === "host" || input.workerPermissionProfile.workspace === "read-write";

  if (input.requirements.worktree) {
    const root = await linkedWorktreeRoot(cwd);
    const requested = input.requirements.worktree;
    const available = Boolean(root)
      && workspaceReadable
      && policyReadable
      && (requested === "read" || (workspaceWritable && policyWritable));
    findings.push({
      capability: "worktree",
      requested,
      availability: available ? "available" : "unavailable",
      evidence: !root
        ? "cwd is not inside a verifiable linked Git worktree; Boss does not provision worktrees"
        : requested === "write" && !policyWritable
          ? `linked worktree ${root} is read-only under effective Worker profile ${input.workerPermissionProfileName}`
          : requested === "write" && !workspaceWritable
            ? `linked worktree ${root} failed the effective filesystem write-access probe`
            : !workspaceReadable || !policyReadable
              ? `linked worktree ${root} failed the effective read-access probe`
              : `linked worktree ${root} passed the requested ${requested} access probe under ${input.workerPermissionProfileName}`,
    });
  }

  if (input.requirements.edit) {
    const toolsAvailable = toolConfigured(input.workerPermissionProfile, "edit") && toolConfigured(input.workerPermissionProfile, "write");
    const available = workspaceWritable && policyWritable && toolsAvailable;
    findings.push({
      capability: "edit",
      requested: "required",
      availability: available ? "available" : "unavailable",
      evidence: available
        ? `cwd passed the filesystem write-access probe and ${input.workerPermissionProfileName} enforces workspace write plus Pi edit/write tools; no source edit is claimed`
        : !policyWritable
          ? `${input.workerPermissionProfileName} makes the exact Worker workspace read-only`
          : !workspaceWritable
            ? "cwd failed the effective filesystem write-access probe"
            : `${input.workerPermissionProfileName} does not expose both Pi edit and write tools`,
    });
  }

  if (input.requirements.tests) {
    findings.push({
      capability: "tests",
      requested: "required",
      availability: "unavailable",
      evidence: toolConfigured(input.workerPermissionProfile, "bash")
        ? `${input.workerPermissionProfileName} exposes a shell, but no project-specific test command or toolchain was effectively probed at create time`
        : `${input.workerPermissionProfileName} does not expose a shell and no project-specific test command was probed`,
    });
  }

  if (input.requirements.gitTransport) {
    findings.push({
      capability: "git-transport",
      requested: input.requirements.gitTransport,
      availability: "unavailable",
      evidence: `${input.workerPermissionProfileName} uses Git policy ${input.workerPermissionProfile.git}; remote reachability, credentials, and ${input.requirements.gitTransport} transport authority were not effectively probed at create time`,
    });
  }

  return {
    status: findings.some((finding) => finding.availability === "unavailable") ? "blocked" : "ready",
    cwd,
    requirements: { ...input.requirements },
    findings,
  };
}

export function formatBossCreateCapabilityReport(report: BossCreateCapabilityReport): string {
  const findings = report.findings.map((finding) => `- ${finding.capability}: requested=${finding.requested}; availability=${finding.availability} — ${finding.evidence}`);
  return [
    `Boss create capability report: ${report.status}`,
    `cwd: ${report.cwd}`,
    ...findings,
    report.status === "blocked"
      ? "No Boss run was created because at least one explicitly requested capability is unavailable."
      : "Availability describes the bounded create-time probes only; it is not proof that implementation or validation succeeded.",
  ].join("\n");
}

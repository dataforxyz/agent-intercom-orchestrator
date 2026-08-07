import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { BossCreateRequirements } from "./boss-command.ts";
import type { PermissionProfile } from "./types.ts";

const execFileAsync = promisify(execFile);

export type BossCreateCapability = "worktree-identity" | "worktree-read" | "worktree-write" | "edit" | "tests" | "git-transport";
export type BossCreateCapabilityAvailability = "verified" | "configured" | "gap";

export interface BossCreateCapabilityFinding {
  capability: BossCreateCapability;
  requested: "read" | "write" | "required";
  availability: BossCreateCapabilityAvailability;
  evidence: string;
}

export interface BossCreateCapabilityReport {
  status: "ready" | "blocked";
  cwd: string;
  requested: BossCreateRequirements;
  probes: BossCreateCapabilityFinding[];
  gaps: BossCreateCapabilityFinding[];
}

interface LinkedWorktreeEvidence {
  root: string;
  adminDirectory: string;
  commonDirectory: string;
}

async function gitOutput(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await execFileAsync("/usr/bin/git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    });
    return result.stdout.trim();
  } catch {
    return undefined;
  }
}

async function verifyLinkedWorktree(cwd: string): Promise<LinkedWorktreeEvidence | undefined> {
  const inside = await gitOutput(cwd, ["rev-parse", "--is-inside-work-tree"]);
  const rootOutput = await gitOutput(cwd, ["rev-parse", "--show-toplevel"]);
  if (inside !== "true" || !rootOutput || !isAbsolute(rootOutput)) return undefined;
  const root = resolve(rootOutput);
  const adminOutput = await gitOutput(root, ["rev-parse", "--absolute-git-dir"]);
  const commonOutput = await gitOutput(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!adminOutput || !commonOutput || !isAbsolute(adminOutput) || !isAbsolute(commonOutput)) return undefined;
  const adminDirectory = resolve(adminOutput);
  const commonDirectory = resolve(commonOutput);
  if (adminDirectory === commonDirectory) return undefined;
  const adminRelationship = relative(commonDirectory, adminDirectory).split(sep);
  if (adminRelationship.length !== 2 || adminRelationship[0] !== "worktrees" || !adminRelationship[1]) return undefined;
  const worktreeList = await gitOutput(root, ["worktree", "list", "--porcelain"]);
  if (!worktreeList) return undefined;
  const listedRoots = worktreeList.split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => resolve(line.slice("worktree ".length)));
  if (!listedRoots.includes(root)) return undefined;
  return { root, adminDirectory, commonDirectory };
}

function toolConfigured(profile: PermissionProfile, tool: string): boolean {
  return profile.piTools === undefined || profile.piTools.includes(tool);
}

function expandProfilePath(path: string): string | undefined {
  const expanded = path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
  return isAbsolute(expanded) ? resolve(expanded) : undefined;
}

function pathsIntersect(left: string, right: string): boolean {
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  return leftToRight === "" || (!leftToRight.startsWith(`..${sep}`) && leftToRight !== ".." && !isAbsolute(leftToRight))
    || (!rightToLeft.startsWith(`..${sep}`) && rightToLeft !== ".." && !isAbsolute(rightToLeft));
}

function profileBoundaryGap(profile: PermissionProfile, target: string): string | undefined {
  if (profile.hardened !== true) {
    return "Boss participants require a hardened permission profile, but this profile is not hardened";
  }
  const environmentWorkspacePolicy = profile.environment?.AGENT_INTERCOM_WORKSPACE_POLICY;
  if (environmentWorkspacePolicy !== undefined && environmentWorkspacePolicy !== profile.workspace) {
    return `profile environment overrides AGENT_INTERCOM_WORKSPACE_POLICY=${environmentWorkspacePolicy} instead of declared workspace=${profile.workspace}`;
  }
  if (profile.systemdProperties && Object.keys(profile.systemdProperties).length) {
    return "custom systemdProperties can change the Worker filesystem boundary and are not modeled by this create-time probe";
  }
  for (const [field, paths] of [["inaccessiblePaths", profile.inaccessiblePaths], ["writablePaths", profile.writablePaths]] as const) {
    for (const configuredPath of paths ?? []) {
      const expanded = expandProfilePath(configuredPath);
      if (!expanded) return `${field} contains a relative path that this create-time probe cannot model`;
      if (pathsIntersect(expanded, target)) return `${field} entry ${configuredPath} intersects ${target}`;
    }
  }
  return undefined;
}

function configuredWorkspaceAccess(input: {
  capability: "worktree-read" | "worktree-write" | "edit";
  requested: "read" | "write" | "required";
  target: string;
  workerPermissionProfileName: string;
  workerPermissionProfile: PermissionProfile;
}): BossCreateCapabilityFinding {
  const boundaryGap = profileBoundaryGap(input.workerPermissionProfile, input.target);
  if (boundaryGap) {
    return {
      capability: input.capability,
      requested: input.requested,
      availability: "gap",
      evidence: `${input.workerPermissionProfileName} cannot establish configured access: ${boundaryGap}`,
    };
  }
  const writeRequested = input.capability !== "worktree-read";
  const workspaceConfigured = writeRequested
    ? input.workerPermissionProfile.workspace === "host" || input.workerPermissionProfile.workspace === "read-write"
    : input.workerPermissionProfile.workspace === "host" || input.workerPermissionProfile.workspace === "read-only" || input.workerPermissionProfile.workspace === "read-write";
  const toolsConfigured = input.capability !== "edit"
    || toolConfigured(input.workerPermissionProfile, "edit") && toolConfigured(input.workerPermissionProfile, "write");
  if (!workspaceConfigured || !toolsConfigured) {
    return {
      capability: input.capability,
      requested: input.requested,
      availability: "gap",
      evidence: !workspaceConfigured
        ? `${input.workerPermissionProfileName} declares workspace=${input.workerPermissionProfile.workspace}, which does not configure requested ${writeRequested ? "write" : "read"} access`
        : `${input.workerPermissionProfileName} does not configure both Pi edit and write tools`,
    };
  }
  return {
    capability: input.capability,
    requested: input.requested,
    availability: "configured",
    evidence: `${input.workerPermissionProfileName} unambiguously configures ${writeRequested ? "write" : "read"} access for ${input.target}; this is policy configuration, not verified effective Worker access`,
  };
}

export async function inspectBossCreateCapabilities(input: {
  cwd: string;
  requirements: BossCreateRequirements;
  workerPermissionProfileName: string;
  workerPermissionProfile: PermissionProfile;
}): Promise<BossCreateCapabilityReport> {
  const cwd = resolve(input.cwd);
  const findings: BossCreateCapabilityFinding[] = [];
  let worktree: LinkedWorktreeEvidence | undefined;
  if (input.requirements.worktree) {
    worktree = await verifyLinkedWorktree(cwd);
    findings.push({
      capability: "worktree-identity",
      requested: "required",
      availability: worktree ? "verified" : "gap",
      evidence: worktree
        ? `/usr/bin/git verified linked worktree ${worktree.root}, admin ${worktree.adminDirectory}, and common directory ${worktree.commonDirectory}`
        : "/usr/bin/git could not verify cwd as an exact listed linked worktree with a valid common/admin relationship; Boss does not provision worktrees",
    });
    const capability = input.requirements.worktree === "read" ? "worktree-read" : "worktree-write";
    findings.push(worktree && input.requirements.worktree === "write" && cwd !== worktree.root
      ? {
        capability,
        requested: input.requirements.worktree,
        availability: "gap",
        evidence: `assigned cwd ${cwd} is nested below linked worktree root ${worktree.root}; the Worker unit makes only the assigned cwd writable, so whole-worktree write access is not configured`,
      }
      : worktree
        ? configuredWorkspaceAccess({
          capability,
          requested: input.requirements.worktree,
          target: worktree.root,
          workerPermissionProfileName: input.workerPermissionProfileName,
          workerPermissionProfile: input.workerPermissionProfile,
        })
        : {
        capability,
        requested: input.requirements.worktree,
        availability: "gap",
        evidence: "whole-worktree access cannot be assessed because linked worktree identity was not verified",
      });
  }

  if (input.requirements.edit) {
    findings.push(configuredWorkspaceAccess({
      capability: "edit",
      requested: "required",
      target: cwd,
      workerPermissionProfileName: input.workerPermissionProfileName,
      workerPermissionProfile: input.workerPermissionProfile,
    }));
  }

  if (input.requirements.tests) {
    findings.push({
      capability: "tests",
      requested: "required",
      availability: "gap",
      evidence: toolConfigured(input.workerPermissionProfile, "bash")
        ? `${input.workerPermissionProfileName} configures a shell, but no project-specific test command or toolchain was concretely probed at create time`
        : `${input.workerPermissionProfileName} does not configure a shell and no project-specific test command was probed`,
    });
  }

  if (input.requirements.gitTransport) {
    findings.push({
      capability: "git-transport",
      requested: input.requirements.gitTransport,
      availability: "gap",
      evidence: `${input.workerPermissionProfileName} declares Git policy ${input.workerPermissionProfile.git}, but read-only Git inspection is not transport and remote reachability, credentials, and ${input.requirements.gitTransport} authority were not concretely probed`,
    });
  }

  const gaps = findings.filter((finding) => finding.availability === "gap");
  return {
    status: gaps.length ? "blocked" : "ready",
    cwd,
    requested: { ...input.requirements },
    probes: findings,
    gaps,
  };
}

export function formatBossCreateCapabilityReport(report: BossCreateCapabilityReport): string {
  const findings = report.probes.map((finding) => `- ${finding.capability}: requested=${finding.requested}; availability=${finding.availability} — ${finding.evidence}`);
  return [
    `Boss create capability report: ${report.status}`,
    `cwd: ${report.cwd}`,
    ...findings,
    report.status === "blocked"
      ? "No Boss run was created because at least one explicitly requested capability has a gap."
      : "Verified evidence is limited to linked-worktree identity; configured access is policy evidence, not proof of effective Worker access or completed work.",
  ].join("\n");
}

import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import type { BossCreateNeed } from "./boss-command.ts";
import type { PermissionProfile } from "./types.ts";

export type BossCreateCapabilityStatus = "verified" | "configured" | "gap";

export interface BossCreateCapabilityFinding {
  need: BossCreateNeed;
  status: BossCreateCapabilityStatus;
  evidence: string;
}

export interface BossCreateCapabilityReport {
  status: "ready" | "blocked";
  cwd: string;
  findings: BossCreateCapabilityFinding[];
}

async function isDirectory(path: string): Promise<boolean> {
  return lstat(path).then((entry) => entry.isDirectory(), () => false);
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
  needs: readonly BossCreateNeed[];
  workerPermissionProfileName: string;
  workerPermissionProfile: PermissionProfile;
}): Promise<BossCreateCapabilityReport> {
  const cwd = resolve(input.cwd);
  const findings: BossCreateCapabilityFinding[] = [];
  for (const need of input.needs) {
    if (need === "worktree") {
      const root = await linkedWorktreeRoot(cwd);
      findings.push(root
        ? { need, status: "verified", evidence: `linked Git worktree detected at ${root}` }
        : { need, status: "gap", evidence: "the requested cwd is not inside a verifiable linked Git worktree; Boss does not provision worktrees" });
      continue;
    }
    if (need === "edit") {
      const writable = input.workerPermissionProfile.workspace === "host" || input.workerPermissionProfile.workspace === "read-write";
      const editingTools = toolConfigured(input.workerPermissionProfile, "edit") && toolConfigured(input.workerPermissionProfile, "write");
      findings.push(writable && editingTools
        ? { need, status: "configured", evidence: `${input.workerPermissionProfileName} grants the Worker workspace write policy and Pi edit/write tools; a successful launch still does not prove a particular edit` }
        : { need, status: "gap", evidence: `${input.workerPermissionProfileName} does not configure both workspace writes and Pi edit/write tools` });
      continue;
    }
    if (need === "test") {
      const shell = toolConfigured(input.workerPermissionProfile, "bash");
      findings.push(shell
        ? { need, status: "configured", evidence: `${input.workerPermissionProfileName} grants the Worker a shell for test execution; project-specific commands and toolchains are not claimed as preflight-verified` }
        : { need, status: "gap", evidence: `${input.workerPermissionProfileName} does not configure the Worker shell needed to run tests` });
      continue;
    }
    findings.push({
      need,
      status: "gap",
      evidence: `${input.workerPermissionProfileName} uses Git policy ${input.workerPermissionProfile.git}; Boss does not verify remote reachability, credentials, or write authority at create time`,
    });
  }
  return { status: findings.some((finding) => finding.status === "gap") ? "blocked" : "ready", cwd, findings };
}

export function formatBossCreateCapabilityReport(report: BossCreateCapabilityReport): string {
  const findings = report.findings.map((finding) => `- ${finding.need}: ${finding.status} — ${finding.evidence}`);
  return [
    `Boss create capability report: ${report.status}`,
    `cwd: ${report.cwd}`,
    ...findings,
    report.status === "blocked"
      ? "No Boss run was created because at least one explicitly requested capability has a gap."
      : "Configured findings describe enforced launch policy, not proof that project-specific work or tests succeeded.",
  ].join("\n");
}

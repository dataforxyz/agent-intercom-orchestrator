import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { TrustedLocalBossResource } from "./boss-trusted-local.ts";

const execFileAsync = promisify(execFile);
const GIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const utf8 = new TextDecoder("utf-8", { fatal: true });

export const BOSS_CANDIDATE_FINGERPRINT_VERSION = "orc.boss-candidate-fingerprint.v1" as const;
export const DEFAULT_BOSS_CANDIDATE_MAX_TRACKED_DIFF_BYTES = 16 * 1024 * 1024;
export const DEFAULT_BOSS_CANDIDATE_MAX_UNTRACKED_FILES = 4_096;
export const DEFAULT_BOSS_CANDIDATE_MAX_UNTRACKED_FILE_BYTES = 64 * 1024 * 1024;
export const DEFAULT_BOSS_CANDIDATE_MAX_UNTRACKED_TOTAL_BYTES = 256 * 1024 * 1024;

export interface BossCandidateUntrackedEntry {
  path: string;
  type: "file" | "symlink";
  size: number;
  sha256: string;
}

export interface BossCandidateFingerprint {
  version: typeof BOSS_CANDIDATE_FINGERPRINT_VERSION;
  resourceId: string;
  resourceRevision: number;
  cwd: string;
  gitAdminDirectory: string;
  gitCommonDirectory: string;
  branch: string;
  baseSha: string;
  headSha: string;
  trackedDirtyBytes: number;
  trackedDirtySha256: string;
  untrackedBytes: number;
  untrackedManifest: BossCandidateUntrackedEntry[];
  aggregateSha256: string;
}

export interface BossCandidateFingerprintOptions {
  maxTrackedDiffBytes?: number;
  maxUntrackedFiles?: number;
  maxUntrackedFileBytes?: number;
  maxUntrackedTotalBytes?: number;
  /** Test/embedding seam invoked between the two required observations. */
  betweenObservations?: () => void | Promise<void>;
}

interface CandidateSnapshot extends Omit<BossCandidateFingerprint, "version" | "resourceId" | "resourceRevision" | "baseSha" | "aggregateSha256"> {}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function positiveBound(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) throw new Error(`Boss candidate ${name} must be a positive safe integer`);
  return selected;
}

async function canonical(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error("Boss candidate path must be absolute");
  return resolve(await realpath(path));
}

async function gitText(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("/usr/bin/git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
    env: { ...process.env, GIT_EXTERNAL_DIFF: "", GIT_PAGER: "cat" },
  });
  return result.stdout.trim();
}

async function gitBuffer(cwd: string, args: string[], maxBuffer: number): Promise<Buffer> {
  try {
    const result = await execFileAsync("/usr/bin/git", ["-C", cwd, ...args], {
      encoding: "buffer",
      maxBuffer,
      timeout: 30_000,
      env: { ...process.env, GIT_EXTERNAL_DIFF: "", GIT_PAGER: "cat" },
    });
    return result.stdout;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new Error("Boss candidate Git observation exceeded its configured byte bound");
    }
    throw error;
  }
}

function decodeGitPath(value: Buffer): string {
  let path: string;
  try {
    path = utf8.decode(value);
  } catch {
    throw new Error("Boss candidate contains a non-UTF-8 untracked path");
  }
  if (!path || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..") || CONTROL_CHARACTER.test(path)) {
    throw new Error("Boss candidate contains an unsafe untracked path");
  }
  return path;
}

async function gitPathIgnored(cwd: string, path: string): Promise<boolean> {
  try {
    await execFileAsync("/usr/bin/git", ["-C", cwd, "check-ignore", "--quiet", "--", path], {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      timeout: 10_000,
      env: { ...process.env, GIT_PAGER: "cat" },
    });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException & { code?: number }).code === 1) return false;
    throw error;
  }
}

async function rejectUnsupportedTreeEntries(cwd: string, maxEntries: number): Promise<void> {
  const pending = [cwd];
  let observed = 0;
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (directory === cwd && entry.name === ".git") continue;
      const absolutePath = joinPath(directory, entry.name);
      const relativePath = relative(cwd, absolutePath).split(sep).join("/");
      if (!relativePath || relativePath.split("/").some((part) => !part || part === "." || part === "..") || CONTROL_CHARACTER.test(relativePath)) {
        throw new Error("Boss candidate contains an unsafe filesystem path");
      }
      if (await gitPathIgnored(cwd, relativePath)) continue;
      observed += 1;
      if (observed > maxEntries) throw new Error("Boss candidate filesystem inventory exceeds its configured entry bound");
      if (entry.isDirectory()) pending.push(absolutePath);
      else if (!entry.isFile() && !entry.isSymbolicLink()) throw new Error(`Boss candidate path has unsupported file type: ${relativePath}`);
    }
  }
}

function joinPath(parent: string, child: string): string {
  return resolve(parent, child);
}

async function observeUntracked(input: {
  cwd: string;
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}): Promise<{ entries: BossCandidateUntrackedEntry[]; totalBytes: number }> {
  await rejectUnsupportedTreeEntries(input.cwd, Math.max(input.maxFiles * 4, 1_024));
  const listed = await gitBuffer(input.cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--"], 4 * 1024 * 1024);
  const rawPaths = listed.length === 0 ? [] : listed.subarray(0, -1).toString("binary").split("\0").map((path) => Buffer.from(path, "binary"));
  if (listed.length > 0 && listed[listed.length - 1] !== 0) throw new Error("Boss candidate untracked inventory is not NUL terminated");
  if (rawPaths.length > input.maxFiles) throw new Error(`Boss candidate untracked file count exceeds ${input.maxFiles}`);
  const decoded = rawPaths.map(decodeGitPath);
  const sorted = [...decoded].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  if (new Set(sorted).size !== sorted.length) throw new Error("Boss candidate contains duplicate untracked paths");

  let totalBytes = 0;
  const entries: BossCandidateUntrackedEntry[] = [];
  for (const path of sorted) {
    const absolute = resolve(input.cwd, path);
    const escaped = relative(input.cwd, absolute);
    if (!escaped || escaped === ".." || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) throw new Error("Boss candidate untracked path escaped the canonical cwd");
    const before = await lstat(absolute);
    if (before.isSymbolicLink()) {
      const target = await readlink(absolute, { encoding: "buffer" });
      const after = await lstat(absolute);
      if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.size !== after.size) throw new Error("Boss candidate changed during untracked symlink observation");
      totalBytes += target.byteLength;
      if (target.byteLength > input.maxFileBytes || totalBytes > input.maxTotalBytes) throw new Error("Boss candidate untracked content exceeds configured byte bounds");
      entries.push({ path, type: "symlink", size: target.byteLength, sha256: sha256(target) });
      continue;
    }
    if (!before.isFile()) throw new Error(`Boss candidate untracked path has unsupported file type: ${path}`);
    if (before.size > input.maxFileBytes || totalBytes + before.size > input.maxTotalBytes) throw new Error("Boss candidate untracked content exceeds configured byte bounds");
    const content = await readFile(absolute);
    const after = await lstat(absolute);
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.size !== after.size || content.byteLength !== before.size) throw new Error("Boss candidate changed during untracked file observation");
    totalBytes += content.byteLength;
    entries.push({ path, type: "file", size: content.byteLength, sha256: sha256(content) });
  }
  return { entries, totalBytes };
}

async function observeSnapshot(resource: TrustedLocalBossResource, bounds: Required<Omit<BossCandidateFingerprintOptions, "betweenObservations">>): Promise<CandidateSnapshot> {
  const cwd = await canonical(resource.path);
  const topLevel = await canonical(await gitText(cwd, ["rev-parse", "--show-toplevel"]));
  const gitAdminDirectory = await canonical(await gitText(cwd, ["rev-parse", "--absolute-git-dir"]));
  const gitCommonDirectory = await canonical(await gitText(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const branch = await gitText(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const headSha = await gitText(cwd, ["rev-parse", "HEAD"]);
  if (cwd !== resource.path || topLevel !== resource.path || gitAdminDirectory !== resource.gitAdminDirectory || gitCommonDirectory !== resource.gitCommonDirectory || branch !== resource.branch) {
    throw new Error("Boss candidate canonical resource identity drifted");
  }
  if (!GIT_SHA.test(headSha)) throw new Error("Boss candidate HEAD is invalid");
  const tracked = await gitBuffer(cwd, ["diff", "--binary", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", "HEAD", "--"], bounds.maxTrackedDiffBytes + 1);
  if (tracked.byteLength > bounds.maxTrackedDiffBytes) throw new Error(`Boss candidate tracked diff exceeds ${bounds.maxTrackedDiffBytes} bytes`);
  const untracked = await observeUntracked({ cwd, maxFiles: bounds.maxUntrackedFiles, maxFileBytes: bounds.maxUntrackedFileBytes, maxTotalBytes: bounds.maxUntrackedTotalBytes });
  return {
    cwd,
    gitAdminDirectory,
    gitCommonDirectory,
    branch,
    headSha,
    trackedDirtyBytes: tracked.byteLength,
    trackedDirtySha256: sha256(tracked),
    untrackedBytes: untracked.totalBytes,
    untrackedManifest: untracked.entries,
  };
}

export async function observeBossCandidateFingerprint(resource: TrustedLocalBossResource, options: BossCandidateFingerprintOptions = {}): Promise<BossCandidateFingerprint> {
  if (resource.leaseState !== "active" || resource.existence !== "verified") throw new Error("Boss candidate fingerprint requires an active verified canonical resource");
  const bounds = {
    maxTrackedDiffBytes: positiveBound(options.maxTrackedDiffBytes, DEFAULT_BOSS_CANDIDATE_MAX_TRACKED_DIFF_BYTES, "tracked diff bound"),
    maxUntrackedFiles: positiveBound(options.maxUntrackedFiles, DEFAULT_BOSS_CANDIDATE_MAX_UNTRACKED_FILES, "untracked file-count bound"),
    maxUntrackedFileBytes: positiveBound(options.maxUntrackedFileBytes, DEFAULT_BOSS_CANDIDATE_MAX_UNTRACKED_FILE_BYTES, "untracked per-file bound"),
    maxUntrackedTotalBytes: positiveBound(options.maxUntrackedTotalBytes, DEFAULT_BOSS_CANDIDATE_MAX_UNTRACKED_TOTAL_BYTES, "untracked total bound"),
  };
  const first = await observeSnapshot(resource, bounds);
  await options.betweenObservations?.();
  const second = await observeSnapshot(resource, bounds);
  if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error("Boss candidate changed during the fingerprint observation window");
  const canonicalPayload = {
    version: BOSS_CANDIDATE_FINGERPRINT_VERSION,
    resourceId: resource.resourceId,
    resourceRevision: resource.revision,
    cwd: second.cwd,
    gitAdminDirectory: second.gitAdminDirectory,
    gitCommonDirectory: second.gitCommonDirectory,
    branch: second.branch,
    baseSha: resource.baseSha,
    headSha: second.headSha,
    trackedDirtyBytes: second.trackedDirtyBytes,
    trackedDirtySha256: second.trackedDirtySha256,
    untrackedBytes: second.untrackedBytes,
    untrackedManifest: second.untrackedManifest,
  };
  return { ...canonicalPayload, aggregateSha256: sha256(JSON.stringify(canonicalPayload)) };
}

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const FLOCK_PATH = "/usr/bin/flock";
const SHELL_PATH = "/bin/sh";
const CAT_PATH = "/usr/bin/cat";

export class KernelFileLockError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "KernelFileLockError";
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

/**
 * Acquire a Linux advisory lock through util-linux flock. The on-disk file may
 * survive a crash, but the kernel lock cannot: the helper owns it only while
 * this process keeps the helper's stdin pipe open. Parent exit closes the last
 * writer, `cat` observes EOF, and flock exits.
 */
export async function acquireKernelFileLock(path: string, timeoutMs?: number): Promise<() => Promise<void>> {
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new KernelFileLockError("Kernel file lock timeout must be positive");
  const child = spawn(FLOCK_PATH, [
    "--exclusive",
    ...(timeoutMs === undefined ? [] : ["--wait", (timeoutMs / 1_000).toFixed(3)]),
    path,
    SHELL_PATH,
    "-c", `printf 'READY\\n'; exec ${CAT_PATH}`,
  ], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = waitForExit(child);
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { if (stderr.length < 4_096) stderr += chunk; });

  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    const fail = (error: Error): void => {
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      child.stdin.destroy();
      reject(error);
    };
    const onError = (error: Error): void => fail(new KernelFileLockError(`Could not start ${FLOCK_PATH} for ${path}`, { cause: error }));
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => fail(new KernelFileLockError(`Could not acquire kernel file lock ${path} (code=${String(code)}, signal=${String(signal)}${stderr ? `: ${stderr.trim()}` : ""})`));
    const onData = (chunk: Buffer): void => {
      stdout += chunk.toString("utf8");
      if (stdout === "READY\n") {
        child.stdout.off("data", onData);
        child.off("error", onError);
        child.off("exit", onExit);
        child.stdout.resume();
        resolve();
      } else if (stdout.length > 6 || !"READY\n".startsWith(stdout)) {
        fail(new KernelFileLockError(`Invalid kernel file lock handshake for ${path}`));
      }
    };
    child.once("error", onError);
    child.once("exit", onExit);
    child.stdout.on("data", onData);
  });

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    child.stdin.end();
    const result = await exited;
    if (result.code !== 0 || result.signal !== null) {
      throw new KernelFileLockError(`Kernel file lock helper for ${path} exited abnormally (code=${String(result.code)}, signal=${String(result.signal)})`);
    }
  };
}

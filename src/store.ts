import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { dirname } from "node:path";
import type { WorkerRecord, WorkerStateFile } from "./types.ts";

const EMPTY_STATE: WorkerStateFile = { version: 1, workers: [] };

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function normalizeState(value: unknown): WorkerStateFile {
  if (!value || typeof value !== "object") return structuredClone(EMPTY_STATE);
  const input = value as { version?: unknown; workers?: unknown; runtimeCleanupClaims?: unknown };
  if (input.version !== 1 || !Array.isArray(input.workers)) return structuredClone(EMPTY_STATE);
  return {
    version: 1,
    workers: input.workers as WorkerRecord[],
    ...(Array.isArray(input.runtimeCleanupClaims) ? { runtimeCleanupClaims: input.runtimeCleanupClaims as WorkerStateFile["runtimeCleanupClaims"] } : {}),
  };
}

export class WorkerStore {
  private queue: Promise<unknown> = Promise.resolve();
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async read(): Promise<WorkerStateFile> {
    try {
      return normalizeState(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(EMPTY_STATE);
      throw new Error(`Could not read worker state ${this.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async write(state: WorkerStateFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temp, this.path);
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const lockPath = `${this.path}.lock`;
    const ownerPath = `${lockPath}/owner.json`;
    for (let attempt = 0; attempt < 500; attempt += 1) {
      try {
        await mkdir(lockPath, { recursive: false, mode: 0o700 });
        try {
          await writeFile(ownerPath, `${JSON.stringify({ pid: process.pid, createdAt: Date.now() })}\n`, { encoding: "utf8", mode: 0o600 });
        } catch (error) {
          await rm(lockPath, { recursive: true, force: true });
          throw error;
        }
        return async () => { await rm(lockPath, { recursive: true, force: true }); };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          let ownerPid: number | undefined;
          try {
            const owner = JSON.parse(await readFile(ownerPath, "utf8")) as { pid?: unknown };
            if (typeof owner.pid === "number") ownerPid = owner.pid;
          } catch {
            // A creator may not have written owner.json yet; use age as the fallback.
          }
          if (ownerPid !== undefined) {
            if (!isProcessAlive(ownerPid)) {
              await rm(lockPath, { recursive: true, force: true });
              continue;
            }
          } else {
            const lockStat = await stat(lockPath);
            if (Date.now() - lockStat.mtimeMs > 120_000) {
              await rm(lockPath, { recursive: true, force: true });
              continue;
            }
          }
        } catch {
          continue;
        }
        await delay(20);
      }
    }
    throw new Error(`Timed out waiting for worker state lock ${lockPath}`);
  }

  async mutate<T>(fn: (state: WorkerStateFile) => T | Promise<T>): Promise<T> {
    const operation = this.queue.catch(() => undefined).then(async () => {
      let release: (() => Promise<void>) | undefined;
      try {
        release = await this.acquireLock();
        const state = await this.read();
        const value = await fn(state);
        await this.write(state);
        return value;
      } finally {
        await release?.();
      }
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async mutateConditionally<T>(
    fn: (state: WorkerStateFile) => { value: T; changed: boolean } | Promise<{ value: T; changed: boolean }>,
  ): Promise<T> {
    const operation = this.queue.catch(() => undefined).then(async () => {
      let release: (() => Promise<void>) | undefined;
      try {
        release = await this.acquireLock();
        const state = await this.read();
        const result = await fn(state);
        if (result.changed) await this.write(state);
        return result.value;
      } finally {
        await release?.();
      }
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async transaction<T>(
    fn: (state: WorkerStateFile, persist: () => Promise<void>) => T | Promise<T>,
  ): Promise<T> {
    const operation = this.queue.catch(() => undefined).then(async () => {
      let release: (() => Promise<void>) | undefined;
      try {
        release = await this.acquireLock();
        const state = await this.read();
        return await fn(state, () => this.write(state));
      } finally {
        await release?.();
      }
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async upsert(worker: WorkerRecord): Promise<void> {
    await this.mutate((state) => {
      const index = state.workers.findIndex((candidate) => candidate.id === worker.id);
      if (index >= 0) state.workers[index] = worker;
      else state.workers.push(worker);
    });
  }

  async remove(id: string): Promise<boolean> {
    return this.mutate((state) => {
      const before = state.workers.length;
      state.workers = state.workers.filter((worker) => worker.id !== id);
      return state.workers.length !== before;
    });
  }
}

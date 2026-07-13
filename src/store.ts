import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { WorkerRecord, WorkerStateFile } from "./types.ts";

const EMPTY_STATE: WorkerStateFile = { version: 1, workers: [] };

function normalizeState(value: unknown): WorkerStateFile {
  if (!value || typeof value !== "object") return structuredClone(EMPTY_STATE);
  const input = value as { version?: unknown; workers?: unknown };
  if (input.version !== 1 || !Array.isArray(input.workers)) return structuredClone(EMPTY_STATE);
  return { version: 1, workers: input.workers as WorkerRecord[] };
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

  async mutate<T>(fn: (state: WorkerStateFile) => T | Promise<T>): Promise<T> {
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    this.queue = this.queue.catch(() => undefined).then(async () => {
      try {
        const state = await this.read();
        const value = await fn(state);
        await this.write(state);
        resolveResult(value);
      } catch (error) {
        rejectResult(error);
      }
    });
    await this.queue;
    return result;
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

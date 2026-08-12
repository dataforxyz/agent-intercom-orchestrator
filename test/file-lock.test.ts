import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireKernelFileLock } from "../src/file-lock.ts";

function waitForLine(stream: NodeJS.ReadableStream, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const onData = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      if (output.includes("\n")) {
        cleanup();
        if (output === `${expected}\n`) resolve();
        else reject(new Error(`Unexpected child output: ${JSON.stringify(output)}`));
      }
    };
    const onEnd = (): void => { cleanup(); reject(new Error("Child output ended before readiness")); };
    const cleanup = (): void => {
      stream.off("data", onData);
      stream.off("end", onEnd);
    };
    stream.on("data", onData);
    stream.once("end", onEnd);
  });
}

test("kernel mutation lock can wait without a timeout for correctness-critical release", async () => {
  const root = await mkdtemp(join(tmpdir(), "kernel-file-lock-unbounded-"));
  const path = join(root, "store.lock.reclaim");
  try {
    const releaseHolder = await acquireKernelFileLock(path, 1_000);
    let acquired = false;
    const waiting = acquireKernelFileLock(path).then((release) => {
      acquired = true;
      return release;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(acquired, false);
    await releaseHolder();
    const releaseWaiting = await waiting;
    assert.equal(acquired, true);
    await releaseWaiting();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("kernel mutation lock survives a stale on-disk file and releases after holder SIGKILL", async () => {
  const root = await mkdtemp(join(tmpdir(), "kernel-file-lock-"));
  const path = join(root, "store.lock.reclaim");
  try {
    const moduleUrl = new URL("../src/file-lock.ts", import.meta.url).href;
    const script = `import { acquireKernelFileLock } from ${JSON.stringify(moduleUrl)}; await acquireKernelFileLock(process.argv[1], 2000); console.log("READY"); setInterval(() => {}, 1000);`;
    const holder = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script, path], { stdio: ["ignore", "pipe", "pipe"] });
    await waitForLine(holder.stdout, "READY");
    holder.kill("SIGKILL");
    await new Promise<void>((resolve) => holder.once("exit", () => resolve()));

    await access(path);
    const release = await acquireKernelFileLock(path, 2_000);
    await release();
    await access(path);
    assert.equal(holder.signalCode, "SIGKILL");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

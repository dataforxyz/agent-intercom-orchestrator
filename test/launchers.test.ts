import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("../src/", import.meta.url);

function exitCode(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}

test("Pi peer launcher treats manager SIGTERM as an orderly exit", async () => {
  const launcher = new URL("pi-peer-launcher.mjs", root);
  const child = spawn(process.execPath, [launcher.pathname, "--", process.execPath, "--eval", "setInterval(() => {}, 1000)"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  const exited = exitCode(child);
  await new Promise((resolve) => setTimeout(resolve, 150));
  child.kill("SIGTERM");
  assert.equal(await exited, 0);
});

test("OpenCode peer launcher keeps a private server alive and exits cleanly on manager SIGTERM", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-intercom-opencode-launcher-test-"));
  try {
    const fake = join(dir, "fake-opencode.mjs");
    await writeFile(fake, `#!/usr/bin/env node\nimport net from "node:net";\nconst mode=process.argv[2];\nif(mode==="run") process.exit(0);\nconst i=process.argv.indexOf("--port");\nconst server=net.createServer();\nserver.listen(Number(process.argv[i+1]),"127.0.0.1");\nprocess.on("SIGTERM",()=>server.close(()=>process.exit(143)));\n`);
    await chmod(fake, 0o755);
    const launcher = new URL("opencode-peer-launcher.mjs", root);
    const child = spawn(process.execPath, [launcher.pathname, "--", fake], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    const deadline = Date.now() + 5000;
    while (!stderr.includes("OpenCode peer ready") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.match(stderr, /OpenCode peer ready/);
    const exited = exitCode(child);
    child.kill("SIGTERM");
    assert.equal(await exited, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

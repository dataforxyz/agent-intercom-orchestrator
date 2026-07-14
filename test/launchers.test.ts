import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  await new Promise((resolve) => setTimeout(resolve, 300));
  child.kill("SIGTERM");
  assert.equal(await exited, 0);
});

test("OpenCode peer launcher waits for health, persists its session, and resumes it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-intercom-opencode-launcher-test-"));
  try {
    const fake = join(dir, "fake-opencode.mjs");
    const healthPath = join(dir, "health.json");
    const statePath = join(dir, "state.json");
    const tracePath = join(dir, "trace.jsonl");
    await writeFile(fake, `#!/usr/bin/env node\nimport fs from "node:fs";\nimport net from "node:net";\nconst mode=process.argv[2];\nif(mode==="run"){const i=process.argv.indexOf("--session");const sessionID=i>=0?process.argv[i+1]:"ses_test";fs.appendFileSync(process.env.TRACE_PATH,JSON.stringify(process.argv.slice(2))+"\\n");fs.writeFileSync(process.env.AGENT_INTERCOM_OPENCODE_HEALTH_PATH,JSON.stringify({version:1,runId:process.env.AGENT_INTERCOM_RUN_ID,ready:true,connected:true,openCodeSessionId:sessionID,status:"idle"}));console.log(JSON.stringify({type:"text",sessionID}));process.exit(0);}\nconst i=process.argv.indexOf("--port");\nconst server=net.createServer();\nserver.listen(Number(process.argv[i+1]),"127.0.0.1");\nprocess.on("SIGTERM",()=>server.close(()=>process.exit(143)));\n`);
    await chmod(fake, 0o755);
    const launcher = new URL("opencode-peer-launcher.mjs", root);
    const run = async (runId: string) => {
      const child = spawn(process.execPath, [launcher.pathname, "--", fake], {
        stdio: ["ignore", "ignore", "pipe"],
        env: {
          ...process.env,
          TRACE_PATH: tracePath,
          AGENT_INTERCOM_RUN_ID: runId,
          AGENT_INTERCOM_WORKER_ID: "worker-test",
          AGENT_INTERCOM_OPENCODE_HEALTH_PATH: healthPath,
          AGENT_INTERCOM_OPENCODE_STATE_PATH: statePath,
        },
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
      return stderr;
    };

    await run("run-1");
    const persisted = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(persisted.sessionId, "ses_test");
    const secondLog = await run("run-2");
    assert.match(secondLog, /session=ses_test resumed/);
    const traces = (await readFile(tracePath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(traces[1].includes("--session"), true);
    assert.equal(traces[1][traces[1].indexOf("--session") + 1], "ses_test");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

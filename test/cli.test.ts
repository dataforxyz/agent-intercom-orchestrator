import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("agent-intercom-fleet CLI hosts the same agent_fleet tool for non-Pi managers", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "agent-intercom-fleet-cli-"));
  try {
    const cli = new URL("../src/agent-fleet-cli.mjs", import.meta.url);
    const child = spawn(process.execPath, ["--experimental-strip-types", cli.pathname], {
      cwd: process.cwd(),
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, AGENT_INTERCOM_ORCHESTRATOR_DISABLED: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.end(JSON.stringify({
      managerSessionId: "opencode-manager-test",
      cwd: process.cwd(),
      params: { action: "capabilities" },
    }));
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(code, 0, stderr);
    const response = JSON.parse(stdout);
    assert.equal(response.ok, true);
    assert.match(response.result.content[0].text, /opencode: modes=persistent,one-shot/);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

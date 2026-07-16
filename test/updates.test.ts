import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { formatAdapterVersions, formatUpdatePlan, inspectAdapterFamily } from "../src/updates.ts";

async function packageRoot(root: string, name: string, version = "0.9.3"): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name, version }));
}

test("adapter inspection preserves Pi and npm-global update sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-intercom-updates-"));
  const agentDir = join(root, "agent");
  const globalRoot = join(root, "global", "node_modules");
  try {
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [
      "git:github.com/dataforxyz/agent-intercom-pi",
      "npm:@dataforxyz/agent-intercom-orchestrator",
    ] }));
    await packageRoot(join(agentDir, "git", "github.com", "dataforxyz", "agent-intercom-pi"), "@dataforxyz/agent-intercom-pi");
    const orchestratorRoot = join(agentDir, "npm", "node_modules", "@dataforxyz", "agent-intercom-orchestrator");
    await packageRoot(orchestratorRoot, "@dataforxyz/agent-intercom-orchestrator");
    for (const id of ["codex", "claude", "opencode"]) {
      await packageRoot(join(globalRoot, "@dataforxyz", `agent-intercom-${id}`), `@dataforxyz/agent-intercom-${id}`);
    }

    const adapters = await inspectAdapterFamily({ agentDir, currentPackageRoot: orchestratorRoot, globalNpmRoot: globalRoot, latest: async () => "0.9.4" });
    assert.equal(adapters.length, 5);
    assert.equal(adapters.find((entry) => entry.id === "pi")?.source, "pi-git");
    assert.match(adapters.find((entry) => entry.id === "pi")?.update?.display ?? "", /^pi update --extension git:/);
    assert.equal(adapters.find((entry) => entry.id === "orchestrator")?.source, "pi-npm");
    assert.match(adapters.find((entry) => entry.id === "codex")?.update?.display ?? "", /^npm install -g/);
    assert.ok(adapters.every((entry) => entry.status === "outdated"));
    assert.match(formatAdapterVersions(adapters), /codex: installed=0.9.3 latest=0.9.4/);
    assert.match(formatUpdatePlan(adapters), /agent-intercom-claude@0\.9\.4/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pinned Pi package sources are reported instead of silently replaced", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-intercom-pinned-"));
  try {
    await writeFile(join(root, "settings.json"), JSON.stringify({ packages: ["git:github.com/dataforxyz/agent-intercom-pi@v0.9.3"] }));
    await packageRoot(join(root, "git", "github.com", "dataforxyz", "agent-intercom-pi"), "@dataforxyz/agent-intercom-pi");
    const adapters = await inspectAdapterFamily({ agentDir: root, currentPackageRoot: join(root, "missing"), globalNpmRoot: join(root, "global"), latest: async () => "0.9.4" });
    const pi = adapters.find((entry) => entry.id === "pi")!;
    assert.equal(pi.update, undefined);
    assert.match(pi.blockedReason ?? "", /pinned/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

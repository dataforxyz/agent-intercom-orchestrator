import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { resolvePiRuntime } from "../src/pi-runtime.ts";
import { detectHarnessVersions, formatAdapterVersions, formatHarnessVersions, formatUpdatePlan, inspectAdapterFamily } from "../src/updates.ts";

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
      "npm:@dataforxyz/orcboss",
    ] }));
    await packageRoot(join(agentDir, "git", "github.com", "dataforxyz", "agent-intercom-pi"), "@dataforxyz/agent-intercom-pi");
    const orchestratorRoot = join(agentDir, "npm", "node_modules", "@dataforxyz", "orcboss");
    await packageRoot(orchestratorRoot, "@dataforxyz/orcboss");
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

test("adapter inspection recognizes package-owned MCP binaries when profile commands are wrappers", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-intercom-linked-adapter-"));
  try {
    const packageDir = join(root, "agent-intercom-claude");
    const binary = join(packageDir, "dist", "claude-server.mjs");
    const binDir = join(root, "bin");
    await packageRoot(packageDir, "@dataforxyz/agent-intercom-claude", "0.11.0");
    await mkdir(join(packageDir, "dist"), { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(binary, "// adapter\n");
    const linkedBinary = join(binDir, "claude-intercom-mcp");
    await symlink(binary, linkedBinary);
    const adapters = await inspectAdapterFamily({
      agentDir: join(root, "agent"),
      currentPackageRoot: join(root, "orchestrator"),
      globalNpmRoot: join(root, "global"),
      commandPaths: { cci: join(root, "wrapper", "cci"), "claude-intercom-mcp": linkedBinary },
      latest: async (name) => name === "@dataforxyz/agent-intercom-claude" ? "0.10.0" : undefined,
    });
    const claude = adapters.find((entry) => entry.id === "claude")!;
    assert.equal(claude.current, "0.11.0");
    assert.equal(claude.source, "local");
    assert.equal(claude.status, "ahead");
    assert.equal(claude.update, undefined);
    assert.match(claude.blockedReason ?? "", /not safely updateable/);
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

test("harness diagnostics use the verified manager Pi version without invoking its wrapper", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-intercom-manager-version-"));
  try {
    const managerMarker = join(root, "manager-invoked");
    const wrapperMarker = join(root, "wrapper-invoked");
    const managerEntry = join(root, "pi package", "dist", "cli.js");
    const managerExecutable = join(root, "node");
    const wrapper = join(root, "pi");
    await mkdir(join(root, "pi package", "dist"), { recursive: true });
    await writeFile(join(root, "pi package", "package.json"), JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: "1.2.3",
      bin: { pi: "dist/cli.js" },
    }));
    await writeFile(managerEntry, "// manager Pi entry\n");
    await writeFile(managerExecutable, `#!/bin/sh\nprintf invoked > '${managerMarker}'\nexit 1\n`);
    await writeFile(wrapper, `#!/bin/sh\nprintf invoked > '${wrapperMarker}'\nexit 1\n`);
    await Promise.all([chmod(managerExecutable, 0o755), chmod(wrapper, 0o755)]);

    const profile = structuredClone(DEFAULT_CONFIG.profiles["pi-peer"]);
    const runtime = await resolvePiRuntime({
      profileName: "pi-peer",
      profile,
      configuredExecutable: wrapper,
      builtInProfile: profile,
      managerEntry,
      managerExecutable,
    });

    const harnesses = detectHarnessVersions({ pi: runtime });
    assert.deepEqual(harnesses[0], {
      harness: "pi",
      command: managerExecutable,
      args: [managerEntry],
      source: "manager-runtime",
      version: "1.2.3",
    });
    await Promise.all([
      assert.rejects(access(managerMarker), { code: "ENOENT" }),
      assert.rejects(access(wrapperMarker), { code: "ENOENT" }),
    ]);
    assert.ok(formatHarnessVersions(harnesses).includes(
      `- pi: version=1.2.3 command=${managerExecutable} '${managerEntry}' source=manager-runtime`,
    ));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("custom default Pi runtime diagnostics preserve the profile command fallback", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-intercom-profile-version-"));
  try {
    const wrapper = join(root, "custom-pi");
    await writeFile(wrapper, "#!/bin/sh\nprintf 'custom-pi 4.5.6\\n'\n");
    await chmod(wrapper, 0o755);

    const builtIn = structuredClone(DEFAULT_CONFIG.profiles["pi-peer"]);
    const profile = { ...builtIn, command: wrapper };
    const runtime = await resolvePiRuntime({
      profileName: "custom-pi",
      profile,
      configuredExecutable: wrapper,
      builtInProfile: builtIn,
    });
    const pi = detectHarnessVersions({ pi: runtime })[0];
    assert.deepEqual(pi, {
      harness: "pi",
      command: wrapper,
      args: [],
      source: "profile",
      version: "custom-pi 4.5.6",
    });
    assert.match(formatHarnessVersions([pi]), /version=custom-pi 4\.5\.6 .* source=profile/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { supportsHardenedUserUnits } from "./systemd-support.ts";
import {
  applyPiPermissionArgs,
  blockedToolReason,
  buildPermissionEnvironment,
  buildPermissionUnitProperties,
  isReadOnlyTeaInvocation,
} from "../src/permissions.ts";

test("built-in roles choose conservative permission profiles", () => {
  assert.equal(DEFAULT_CONFIG.roles.advisor.permissionProfile, "review-readonly");
  assert.equal(DEFAULT_CONFIG.roles.researcher.permissionProfile, "review-readonly");
  assert.equal(DEFAULT_CONFIG.roles.challenger.permissionProfile, "review-readonly");
  assert.equal(DEFAULT_CONFIG.roles.builder.permissionProfile, "builder-restricted");
});

test("permission profiles compile to Pi tool allowlists and systemd properties", () => {
  const reviewer = DEFAULT_CONFIG.permissionProfiles["review-readonly"];
  const builder = DEFAULT_CONFIG.permissionProfiles["builder-restricted"];
  assert.ok(reviewer && builder);

  const args = applyPiPermissionArgs(["--mode", "rpc"], reviewer);
  assert.deepEqual(args.slice(-2), ["--tools", reviewer.piTools?.join(",")]);
  assert.equal(args.at(-1)?.includes("bash"), false);

  const reviewerProperties = buildPermissionUnitProperties(reviewer, "/repo with spaces");
  assert.ok(reviewerProperties.includes("PrivateUsers=self"));
  assert.ok(reviewerProperties.includes("PrivatePIDs=yes"));
  assert.ok(reviewerProperties.includes("NoNewPrivileges=yes"));
  assert.ok(reviewerProperties.includes("ProtectSystem=strict"));
  assert.ok(reviewerProperties.includes("ProtectHome=read-only"));
  assert.ok(reviewerProperties.includes('ReadOnlyPaths="/repo with spaces"'));
  assert.ok(reviewerProperties.some((property) => property.includes("/.ssh")));
  assert.ok(reviewerProperties.some((property) => property.includes("/.config/tea")));
  assert.ok(reviewerProperties.some((property) => property.includes("/bus")));
  assert.ok(reviewerProperties.some((property) => property.includes("/systemd")));
  assert.ok(reviewerProperties.some((property) => property.includes("system_bus_socket")));

  const builderProperties = buildPermissionUnitProperties(builder, "/repo", ["/repo/.git", "/shared/.git/worktrees/repo", "/shared/.git"], ["/home/example/.local/state/worker"], ["/home/example/.pi/agent/settings.json"]);
  assert.ok(builderProperties.includes('ReadWritePaths="/repo"'));
  assert.ok(builderProperties.some((property) => property.startsWith("ReadWritePaths=") && property.includes("/.local/state/worker")));
  assert.ok(builderProperties.includes('ReadOnlyPaths="-/home/example/.pi/agent/settings.json"'));
  assert.ok(builderProperties.includes('ReadOnlyPaths="-/shared/.git/worktrees/repo"'));
  assert.ok(builderProperties.includes('ReadOnlyPaths="-/shared/.git"'));
  assert.equal(builderProperties.some((property) => property === 'ReadOnlyPaths="/repo"'), false);
});

test("restricted permission environment disables common Git credential paths", () => {
  const builder = DEFAULT_CONFIG.permissionProfiles["builder-restricted"];
  assert.ok(builder);
  const environment = buildPermissionEnvironment("builder-restricted", builder);
  assert.equal(environment.AGENT_INTERCOM_PERMISSION_PROFILE, "builder-restricted");
  assert.equal(environment.AGENT_INTERCOM_GIT_POLICY, "read-only");
  assert.equal(environment.GIT_TERMINAL_PROMPT, "0");
  assert.equal(environment.GIT_OPTIONAL_LOCKS, "0");
  assert.equal(environment.SSH_AUTH_SOCK, "");
  assert.equal(environment.GH_TOKEN, "");
  assert.equal(environment.TEA_TOKEN, "");
  assert.equal(environment.TEA_TRACE, "");
  assert.equal(environment.GITEA_TOKEN, "");
  assert.equal(environment.GITEA_SERVER_PASSWORD, "");
  assert.equal(environment.GITEA_SERVER_TOKEN, "");
  assert.equal(environment.FORGEJO_TOKEN, "");
});

test("read-only Git policy allows inspection and blocks mutations or remote writes", () => {
  assert.equal(blockedToolReason("bash", { command: "git status --short && git diff" }, "read-write", "read-only"), undefined);
  assert.equal(blockedToolReason("bash", { command: "git branch --show-current" }, "read-write", "read-only"), undefined);
  assert.match(blockedToolReason("bash", { command: "git branch new-feature" }, "read-write", "read-only") ?? "", /git branch/);
  assert.match(blockedToolReason("bash", { command: "git push origin main" }, "read-write", "read-only") ?? "", /git push/);
  assert.match(blockedToolReason("bash", { command: "cd repo && /usr/bin/git reset --hard HEAD~1" }, "read-write", "read-only") ?? "", /git reset/);
  assert.match(blockedToolReason("bash", { command: "git -C repo push origin main" }, "read-write", "read-only") ?? "", /git push/);
  assert.match(blockedToolReason("bash", { command: "gh pr merge 42" }, "read-write", "read-only") ?? "", /GitHub write/);
  assert.equal(blockedToolReason("bash", { command: "tea issues list --state all" }, "read-write", "read-only"), undefined);
  assert.equal(blockedToolReason("bash", { command: "/usr/bin/tea api --method GET /user" }, "read-write", "read-only"), undefined);
  assert.match(blockedToolReason("bash", { command: "/usr/bin/tea issues create --title nope" }, "read-write", "read-only") ?? "", /Forgejo write/);
  assert.match(blockedToolReason("bash", { command: "tea api /repos/o/r/issues -X POST -f title=nope" }, "read-write", "read-only") ?? "", /Forgejo write/);
  assert.match(blockedToolReason("edit", { path: "src/a.ts" }, "read-only", "read-only") ?? "", /read-only workspace/);
  assert.equal(blockedToolReason("bash", { command: "git push origin main" }, "read-write", "full"), undefined);
});

test("cross-harness Git guard allows inspection and blocks mutation", () => {
  const guard = fileURLToPath(new URL("../src/guard-bin/git", import.meta.url));
  const environment = {
    ...process.env,
    AGENT_INTERCOM_REAL_GIT: "/bin/echo",
    AGENT_INTERCOM_GIT_POLICY: "read-only",
    AGENT_INTERCOM_PERMISSION_PROFILE: "builder-restricted",
  };
  const allowed = spawnSync(guard, ["-C", "/repo", "status", "--short"], { env: environment, encoding: "utf8" });
  assert.equal(allowed.status, 0);
  assert.match(allowed.stdout, /-C \/repo status --short/);
  const blocked = spawnSync(guard, ["push", "origin", "main"], { env: environment, encoding: "utf8" });
  assert.equal(blocked.status, 126);
  assert.match(blocked.stderr, /git push blocked/);
  const branchBlocked = spawnSync(guard, ["branch", "new-feature"], { env: environment, encoding: "utf8" });
  assert.equal(branchBlocked.status, 126);
  const overrideBlocked = spawnSync(guard, ["push", "origin", "main"], { env: { ...environment, AGENT_INTERCOM_GIT_POLICY: "full" }, encoding: "utf8" });
  assert.equal(overrideBlocked.status, 126);

  const ghGuard = fileURLToPath(new URL("../src/guard-bin/gh", import.meta.url));
  const ghEnvironment = { ...environment, AGENT_INTERCOM_REAL_GH: "/bin/echo" };
  const ghAllowed = spawnSync(ghGuard, ["pr", "view", "42"], { env: ghEnvironment, encoding: "utf8" });
  assert.equal(ghAllowed.status, 0);
  const ghBlocked = spawnSync(ghGuard, ["pr", "merge", "42"], { env: ghEnvironment, encoding: "utf8" });
  assert.equal(ghBlocked.status, 126);
  assert.match(ghBlocked.stderr, /gh pr merge blocked/);
});

test("Tea policy is allowlist-based and rejects ambiguous or write-shaped invocations", () => {
  assert.equal(isReadOnlyTeaInvocation(["--version"]), true);
  assert.equal(isReadOnlyTeaInvocation(["issues", "list", "--state", "all"]), true);
  assert.equal(isReadOnlyTeaInvocation(["actions", "runs", "view", "42"]), true);
  assert.equal(isReadOnlyTeaInvocation(["wiki", "view", "Home"]), true);
  assert.equal(isReadOnlyTeaInvocation(["api", "/user"]), true);
  assert.equal(isReadOnlyTeaInvocation(["api", "--method", "GET", "/user"]), true);
  assert.equal(isReadOnlyTeaInvocation(["issues", "create", "--title", "nope"]), false);
  assert.equal(isReadOnlyTeaInvocation(["comments", "42", "body"]), false);
  assert.equal(isReadOnlyTeaInvocation(["notifications", "read"]), false);
  assert.equal(isReadOnlyTeaInvocation(["logins", "default", "prod"]), false);
  assert.equal(isReadOnlyTeaInvocation(["labels", "list", "--save"]), false);
  assert.equal(isReadOnlyTeaInvocation(["labels", "list", "--save=true"]), false);
  assert.equal(isReadOnlyTeaInvocation(["labels", "list", "--save=false"]), false);
  assert.equal(isReadOnlyTeaInvocation(["labels", "list", "-s=true"]), false);
  assert.equal(isReadOnlyTeaInvocation(["labels", "list", "-sfoo"]), false);
  assert.equal(isReadOnlyTeaInvocation(["--debug", "issues", "list"]), false);
  assert.equal(isReadOnlyTeaInvocation(["issues", "--repo", "owner/repo", "list"]), false);
  assert.equal(isReadOnlyTeaInvocation(["api", "/issues", "-XPOST"]), false);
  assert.equal(isReadOnlyTeaInvocation(["api", "-X=DELETE", "/issues/1"]), false);
  assert.equal(isReadOnlyTeaInvocation(["api", "/issues", "--method=PATCH"]), false);
  assert.equal(isReadOnlyTeaInvocation(["api", "/issues", "-f", "title=nope"]), false);
  assert.equal(isReadOnlyTeaInvocation(["api", "/issues", "-H", "X-HTTP-Method-Override: DELETE"]), false);
});

test("cross-harness Tea guard allows inspection and cannot be disabled by worker environment", (t) => {
  const realTea = "/usr/bin/tea";
  if (!existsSync(realTea)) {
    t.skip("real Tea executable is absent");
    return;
  }
  const guard = fileURLToPath(new URL("../src/guard-bin/tea", import.meta.url));
  const isolatedConfig = mkdtempSync(join(tmpdir(), "agent-intercom-tea-config-"));
  const environment = {
    ...process.env,
    XDG_CONFIG_HOME: isolatedConfig,
    AGENT_INTERCOM_REAL_TEA: realTea,
    AGENT_INTERCOM_GIT_POLICY: "full",
    AGENT_INTERCOM_PERMISSION_PROFILE: "trusted",
  };
  try {
    for (const args of [
      ["--version"],
      ["issues", "list", "--help"],
      ["actions", "runs", "view", "--help"],
      ["logins", "list"],
      ["api", "--help"],
    ]) {
      const allowed = spawnSync(guard, args, { env: environment, encoding: "utf8" });
      assert.equal(allowed.status, 0, `${args.join(" ")}: ${allowed.stderr}`);
    }
    for (const args of [
      ["issues", "create", "--title", "nope"],
      ["pulls", "merge", "42"],
      ["repos", "delete", "owner/repo"],
      ["comments", "42", "body"],
      ["notifications", "read"],
      ["labels", "list", "--save=true"],
      ["labels", "list", "--save=false"],
      ["labels", "list", "-s=true"],
      ["labels", "list", "-sfoo"],
      ["logout", "prod"],
      ["api", "/issues", "-X", "POST", "-f", "title=nope"],
      ["api", "-XDELETE", "/issues/1"],
      ["--debug", "issues", "list"],
      ["issues", "--repo", "owner/repo", "list"],
    ]) {
      const blocked = spawnSync(guard, args, { env: environment, encoding: "utf8" });
      assert.equal(blocked.status, 126, `${args.join(" ")}: ${blocked.stdout}${blocked.stderr}`);
      assert.match(blocked.stderr, /blocked by Agent Intercom/);
    }

    const marker = join(isolatedConfig, "environment-bypass-marker");
    const shellOverride = spawnSync(guard, ["-c", `touch ${marker}`, "-h"], {
      env: { ...environment, AGENT_INTERCOM_REAL_TEA: "/bin/sh" },
      encoding: "utf8",
    });
    assert.equal(shellOverride.status, 127);
    assert.equal(existsSync(marker), false);

    const writableBin = join(isolatedConfig, "bin");
    const writableTea = join(writableBin, "tea");
    mkdirSync(writableBin);
    writeFileSync(writableTea, `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(writableTea, 0o555);
    const writableOverride = spawnSync(guard, ["--version"], {
      env: { ...environment, AGENT_INTERCOM_REAL_TEA: writableTea },
      encoding: "utf8",
    });
    assert.equal(writableOverride.status, 127);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(isolatedConfig, { recursive: true, force: true });
  }
});

test("Tea guard is executable and explicitly included in package files", () => {
  const guard = fileURLToPath(new URL("../src/guard-bin/tea", import.meta.url));
  assert.notEqual(statSync(guard).mode & 0o111, 0);
  const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
  assert.ok(packageJson.files.includes("src/guard-bin/tea"));
});

test("hardened systemd profile makes host Tea configuration inaccessible", (t) => {
  const teaConfig = join(homedir(), ".config", "tea", "config.yml");
  if (process.platform !== "linux" || spawnSync("systemctl", ["--user", "show-environment"]).status !== 0) {
    t.skip("systemd user manager is unavailable");
    return;
  }
  if (!existsSync(teaConfig)) {
    t.skip("host Tea configuration is absent");
    return;
  }
  const reviewer = DEFAULT_CONFIG.permissionProfiles["review-readonly"];
  assert.ok(reviewer);
  const properties = buildPermissionUnitProperties(reviewer, process.cwd());
  const result = spawnSync("systemd-run", [
    "--user", "--wait", "--pipe",
    ...properties.map((property) => `--property=${property}`),
    "/bin/sh", "-c", `! test -r ${JSON.stringify(teaConfig)} && ! cat ${JSON.stringify(teaConfig)} >/dev/null 2>&1`,
  ], { encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test("linked-worktree .git pointer and resolved metadata are immutable in a real hardened unit", (t) => {
  if (!supportsHardenedUserUnits()) {
    t.skip("systemd 257+ hardened user namespaces are unavailable");
    return;
  }
  const base = join(homedir(), ".cache", "agent-intercom-orchestrator-tests");
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "linked-worktree-"));
  const main = join(root, "main");
  const worktree = join(root, "worker");
  const git = (...args: string[]) => spawnSync("git", args, { encoding: "utf8" });
  try {
    mkdirSync(main);
    assert.equal(git("-C", main, "init", "-q").status, 0);
    assert.equal(git("-C", main, "config", "user.email", "proof@example.invalid").status, 0);
    assert.equal(git("-C", main, "config", "user.name", "Proof").status, 0);
    writeFileSync(join(main, "file.txt"), "before\n");
    assert.equal(git("-C", main, "add", "file.txt").status, 0);
    assert.equal(git("-C", main, "commit", "-qm", "initial").status, 0);
    assert.equal(git("-C", main, "worktree", "add", "-q", worktree).status, 0);
    const metadata = git("-C", worktree, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir").stdout.trim().split("\n");
    const builder = DEFAULT_CONFIG.permissionProfiles["builder-restricted"];
    assert.ok(builder);
    const properties = buildPermissionUnitProperties(builder, worktree, [join(worktree, ".git"), ...metadata]);
    const result = spawnSync("systemd-run", [
      "--user", "--wait", "--pipe", `--working-directory=${worktree}`,
      ...properties.map((property) => `--property=${property}`),
      "/bin/bash", "-c",
      "! rm .git && ! sh -c ': > .git' && ! mv .git .git.moved && /usr/bin/git status --short >/dev/null",
    ], { encoding: "utf8", timeout: 15_000 });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.equal(existsSync(join(worktree, ".git")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hardened systemd profile cannot delegate an unsandboxed unit to the user manager", (t) => {
  if (!supportsHardenedUserUnits()) {
    t.skip("systemd 257+ hardened user namespaces are unavailable");
    return;
  }
  const builder = DEFAULT_CONFIG.permissionProfiles["builder-restricted"];
  assert.ok(builder);
  const marker = join(tmpdir(), `agent-intercom-systemd-escape-${process.pid}`);
  const procMarker = join(tmpdir(), `agent-intercom-proc-root-escape-${process.pid}`);
  const managerPid = spawnSync("pgrep", ["-u", String(process.getuid?.() ?? ""), "-f", "/systemd --user"], { encoding: "utf8" }).stdout.trim().split("\n")[0];
  assert.match(managerPid, /^\d+$/, "could not identify the systemd user manager PID");
  const control = join(process.cwd(), `.agent-intercom-systemd-control-${process.pid}`);
  rmSync(marker, { force: true });
  rmSync(procMarker, { force: true });
  rmSync(control, { force: true });
  const properties = buildPermissionUnitProperties(builder, process.cwd());
  const result = spawnSync("systemd-run", [
    "--user",
    "--wait",
    "--pipe",
    ...properties.map((property) => `--property=${property}`),
    "/bin/sh",
    "-c",
    `/usr/bin/touch ${JSON.stringify(control)} && ! /usr/bin/touch /proc/${managerPid}/root${procMarker} && /usr/bin/systemd-run --user --wait /usr/bin/touch ${JSON.stringify(marker)}`,
  ], { encoding: "utf8", timeout: 15_000 });
  try {
    assert.notEqual(result.status, 0, `nested systemd-run unexpectedly succeeded: ${result.stdout}${result.stderr}`);
    assert.equal(existsSync(control), true, "outer sandbox did not run its allowed control command");
    assert.equal(existsSync(marker), false, "nested user unit escaped the hardened mount namespace");
    assert.equal(existsSync(procMarker), false, "worker escaped through the user manager's /proc root");
  } finally {
    rmSync(marker, { force: true });
    rmSync(procMarker, { force: true });
    rmSync(control, { force: true });
  }
});

test("nested bwrap and unshare sandboxes inherit the outer filesystem boundary", (t) => {
  if (!supportsHardenedUserUnits()) {
    t.skip("systemd 257+ hardened user namespaces are unavailable");
    return;
  }
  if (spawnSync("sh", ["-c", "command -v bwrap >/dev/null && command -v unshare >/dev/null"]).status !== 0) {
    t.skip("bwrap or unshare is unavailable");
    return;
  }
  const builder = DEFAULT_CONFIG.permissionProfiles["builder-restricted"];
  assert.ok(builder);
  const root = mkdtempSync(join(homedir(), ".cache", "agent-intercom-namespace-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside-proof");
  mkdirSync(workspace);
  const properties = buildPermissionUnitProperties(builder, workspace);
  const result = spawnSync("systemd-run", [
    "--user", "--wait", "--pipe", `--working-directory=${workspace}`,
    ...properties.map((property) => `--property=${property}`),
    "/bin/sh", "-c",
    `bwrap --ro-bind / / --bind ${JSON.stringify(workspace)} ${JSON.stringify(workspace)} --dev /dev --proc /proc /bin/sh -c '! touch ${JSON.stringify(outside)} && touch bwrap-ok' && unshare -Ur /bin/sh -c '! touch ${JSON.stringify(outside)} && touch unshare-ok'`,
  ], { encoding: "utf8", timeout: 15_000 });
  try {
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.equal(existsSync(outside), false);
    assert.equal(existsSync(join(workspace, "bwrap-ok")), true);
    assert.equal(existsSync(join(workspace, "unshare-ok")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("worker Pi keeps permission hook while orchestrator fleet registration is disabled", async () => {
  const previousDisabled = process.env.AGENT_INTERCOM_ORCHESTRATOR_DISABLED;
  const previousProfile = process.env.AGENT_INTERCOM_PERMISSION_PROFILE;
  const previousWorkspace = process.env.AGENT_INTERCOM_WORKSPACE_POLICY;
  const previousGit = process.env.AGENT_INTERCOM_GIT_POLICY;
  process.env.AGENT_INTERCOM_ORCHESTRATOR_DISABLED = "1";
  process.env.AGENT_INTERCOM_PERMISSION_PROFILE = "review-readonly";
  process.env.AGENT_INTERCOM_WORKSPACE_POLICY = "read-only";
  process.env.AGENT_INTERCOM_GIT_POLICY = "read-only";
  try {
    const events = new Map<string, (event: any) => any>();
    const registered: string[] = [];
    const pi: any = {
      on(name: string, handler: (event: any) => any) { events.set(name, handler); },
      registerTool(tool: any) { registered.push(`tool:${tool.name}`); },
      registerCommand(name: string) { registered.push(`command:${name}`); },
    };
    const extensionUrl = new URL(`../src/index.ts?permission-worker=${Date.now()}`, import.meta.url);
    const { default: extension } = await import(extensionUrl.href);
    extension(pi);
    assert.deepEqual(registered, []);
    assert.ok(events.has("tool_call"));
    assert.match(events.get("tool_call")?.({ toolName: "bash", input: { command: "git clean -fd" } })?.reason ?? "", /permission profile/);
  } finally {
    if (previousDisabled === undefined) delete process.env.AGENT_INTERCOM_ORCHESTRATOR_DISABLED;
    else process.env.AGENT_INTERCOM_ORCHESTRATOR_DISABLED = previousDisabled;
    if (previousProfile === undefined) delete process.env.AGENT_INTERCOM_PERMISSION_PROFILE;
    else process.env.AGENT_INTERCOM_PERMISSION_PROFILE = previousProfile;
    if (previousWorkspace === undefined) delete process.env.AGENT_INTERCOM_WORKSPACE_POLICY;
    else process.env.AGENT_INTERCOM_WORKSPACE_POLICY = previousWorkspace;
    if (previousGit === undefined) delete process.env.AGENT_INTERCOM_GIT_POLICY;
    else process.env.AGENT_INTERCOM_GIT_POLICY = previousGit;
  }
});

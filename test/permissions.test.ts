import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
  applyPiPermissionArgs,
  blockedToolReason,
  buildPermissionEnvironment,
  buildPermissionUnitProperties,
  harnessWritableStatePaths,
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
  assert.ok(reviewerProperties.includes("NoNewPrivileges=yes"));
  assert.ok(reviewerProperties.includes("ProtectSystem=strict"));
  assert.ok(reviewerProperties.includes("ProtectHome=read-only"));
  assert.ok(reviewerProperties.includes('ReadOnlyPaths="/repo with spaces"'));
  assert.ok(reviewerProperties.some((property) => property.includes("/.ssh")));

  const builderProperties = buildPermissionUnitProperties(builder, "/repo", ["/shared/.git/worktrees/repo", "/shared/.git"], harnessWritableStatePaths("pi"));
  assert.ok(builderProperties.includes('ReadWritePaths="/repo"'));
  assert.ok(builderProperties.some((property) => property.startsWith("ReadWritePaths=") && property.includes("/.pi/agent/sessions")));
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
});

test("read-only Git policy allows inspection and blocks mutations or remote writes", () => {
  assert.equal(blockedToolReason("bash", { command: "git status --short && git diff" }, "read-write", "read-only"), undefined);
  assert.equal(blockedToolReason("bash", { command: "git branch --show-current" }, "read-write", "read-only"), undefined);
  assert.match(blockedToolReason("bash", { command: "git branch new-feature" }, "read-write", "read-only") ?? "", /git branch/);
  assert.match(blockedToolReason("bash", { command: "git push origin main" }, "read-write", "read-only") ?? "", /git push/);
  assert.match(blockedToolReason("bash", { command: "cd repo && /usr/bin/git reset --hard HEAD~1" }, "read-write", "read-only") ?? "", /git reset/);
  assert.match(blockedToolReason("bash", { command: "git -C repo push origin main" }, "read-write", "read-only") ?? "", /git push/);
  assert.match(blockedToolReason("bash", { command: "gh pr merge 42" }, "read-write", "read-only") ?? "", /GitHub write/);
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

  const ghGuard = fileURLToPath(new URL("../src/guard-bin/gh", import.meta.url));
  const ghEnvironment = { ...environment, AGENT_INTERCOM_REAL_GH: "/bin/echo" };
  const ghAllowed = spawnSync(ghGuard, ["pr", "view", "42"], { env: ghEnvironment, encoding: "utf8" });
  assert.equal(ghAllowed.status, 0);
  const ghBlocked = spawnSync(ghGuard, ["pr", "merge", "42"], { env: ghEnvironment, encoding: "utf8" });
  assert.equal(ghBlocked.status, 126);
  assert.match(ghBlocked.stderr, /gh pr merge blocked/);
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

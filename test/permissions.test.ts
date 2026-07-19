import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
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
  credentialAgentPaths,
  isCloudControlInspection,
  isReadOnlyGhInvocation,
  isReadOnlyGlabInvocation,
  isReadOnlyNpmInvocation,
  isReadOnlyTeaInvocation,
  legacySessionIpcPaths,
  privilegedRuntimePaths,
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
  const currentUid = process.getuid?.();
  if (Number.isInteger(currentUid)) assert.ok(reviewerProperties.includes(`TemporaryFileSystem=/run/user/${currentUid}:rw`));
  assert.ok(reviewerProperties.includes('ReadOnlyPaths="/repo with spaces"'));
  assert.ok(reviewerProperties.some((property) => property.includes("/.ssh")));
  assert.ok(reviewerProperties.some((property) => property.includes("/.config/tea")));
  assert.ok(reviewerProperties.some((property) => property.includes("/.config/glab-cli")));
  assert.ok(reviewerProperties.some((property) => property.includes("/.Xauthority")));
  assert.ok(reviewerProperties.some((property) => property.includes("/.config/pulse")));
  assert.ok(reviewerProperties.some((property) => property.includes("/bus")));
  assert.ok(reviewerProperties.some((property) => property.includes("/systemd")));
  assert.ok(reviewerProperties.some((property) => property.includes("system_bus_socket")));
  assert.ok(reviewerProperties.includes('InaccessiblePaths="-/run/docker.sock"'));
  assert.ok(reviewerProperties.includes('InaccessiblePaths="-/var/run/docker.sock"'));
  assert.ok(reviewerProperties.includes('InaccessiblePaths="-/run/containerd/containerd.sock"'));
  assert.ok(reviewerProperties.includes('InaccessiblePaths="-/run/podman/podman.sock"'));
  assert.ok(reviewerProperties.includes('InaccessiblePaths="-/run/buildkit/buildkitd.sock"'));
  assert.ok(reviewerProperties.includes('InaccessiblePaths="-/run/crio/crio.sock"'));
  assert.ok(reviewerProperties.includes('InaccessiblePaths="-/run/libvirt"'));
  if (Number.isInteger(currentUid)) {
    assert.ok(reviewerProperties.includes(`InaccessiblePaths="-/run/user/${currentUid}/docker.sock"`));
    assert.ok(reviewerProperties.includes(`InaccessiblePaths="-/run/user/${currentUid}/podman"`));
    assert.ok(reviewerProperties.includes(`InaccessiblePaths="-/run/user/${currentUid}/libvirt"`));
  }

  const builderProperties = buildPermissionUnitProperties(builder, "/repo", ["/repo/.git", "/shared/.git/worktrees/repo", "/shared/.git"], ["/home/example/.local/state/worker"], ["/home/example/.pi/agent/settings.json"]);
  assert.ok(builderProperties.includes('ReadWritePaths="/repo"'));
  assert.ok(builderProperties.some((property) => property.startsWith("ReadWritePaths=") && property.includes("/.local/state/worker")));
  assert.ok(builderProperties.includes('ReadOnlyPaths="-/home/example/.pi/agent/settings.json"'));
  assert.ok(builderProperties.includes('ReadOnlyPaths="-/shared/.git/worktrees/repo"'));
  assert.ok(builderProperties.includes('ReadOnlyPaths="-/shared/.git"'));
  assert.equal(builderProperties.some((property) => property === 'ReadOnlyPaths="/repo"'), false);
});

test("glab project-local config masks apply only to real Git metadata directories", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-intercom-glab-metadata-"));
  try {
    const standardRepo = join(root, "standard");
    const standardGit = join(standardRepo, ".git");
    mkdirSync(standardGit, { recursive: true });
    const builder = DEFAULT_CONFIG.permissionProfiles["builder-restricted"];
    assert.ok(builder);
    const standardProperties = buildPermissionUnitProperties(builder, standardRepo, [standardGit]);
    assert.ok(standardProperties.includes(`InaccessiblePaths=${JSON.stringify(`-${join(standardGit, "glab-cli")}`)}`));

    const linkedRepo = join(root, "linked");
    const linkedPointer = join(linkedRepo, ".git");
    const linkedMetadata = join(root, "common", "worktrees", "linked");
    const commonMetadata = join(root, "common");
    mkdirSync(linkedRepo, { recursive: true });
    mkdirSync(linkedMetadata, { recursive: true });
    writeFileSync(linkedPointer, `gitdir: ${linkedMetadata}\n`);
    const linkedProperties = buildPermissionUnitProperties(builder, linkedRepo, [linkedPointer, linkedMetadata, commonMetadata]);
    assert.equal(linkedProperties.some((property) => property.includes(`${linkedPointer}/glab-cli`)), false);
    assert.ok(linkedProperties.includes(`InaccessiblePaths=${JSON.stringify(`-${join(linkedMetadata, "glab-cli")}`)}`));
    assert.ok(linkedProperties.includes(`InaccessiblePaths=${JSON.stringify(`-${join(commonMetadata, "glab-cli")}`)}`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("privileged runtime socket masks are optional and use the launched worker uid", () => {
  const paths = privilegedRuntimePaths(4242);
  assert.ok(paths.includes("/run/docker.sock"));
  assert.ok(paths.includes("/var/run/docker.sock"));
  assert.ok(paths.includes("/run/containerd/containerd.sock"));
  assert.ok(paths.includes("/run/podman/podman.sock"));
  assert.ok(paths.includes("/run/buildkit/buildkitd.sock"));
  assert.ok(paths.includes("/var/snap/lxd/common/lxd/unix.socket"));
  assert.ok(paths.includes("/var/lib/incus/unix.socket"));
  assert.ok(paths.includes("/run/crio/crio.sock"));
  assert.ok(paths.includes("/run/libvirt"));
  for (const path of [
    "/run/systemd/private",
    "/run/systemd/io.systemd.Login",
    "/run/systemd/io.systemd.Shutdown",
    "/run/systemd/io.systemd.FactoryReset",
    "/run/systemd/io.systemd.Hostname",
    "/run/systemd/io.systemd.sysext",
    "/run/systemd/io.systemd.BootControl",
    "/run/systemd/io.systemd.Repart",
    "/run/systemd/io.systemd.PCRLock",
    "/run/systemd/io.systemd.PCRExtend",
    "/run/systemd/io.systemd.MuteConsole",
    "/run/systemd/io.systemd.ManagedOOM",
    "/run/systemd/io.systemd.JournalAccess",
    "/run/udev/control",
    "/run/polkit",
    "/run/tailscale/tailscaled.sock",
  ]) {
    assert.ok(paths.includes(path), `missing host-control mask for ${path}`);
  }
  assert.ok(paths.includes("/run/user/4242/docker.sock"));
  assert.ok(paths.includes("/run/user/4242/podman"));
  assert.ok(paths.includes("/run/user/4242/buildkit"));
  assert.ok(paths.includes("/run/user/4242/libvirt"));
  assert.equal(paths.filter((path) => path.startsWith("/run/user/")).every((path) => path.startsWith("/run/user/4242/")), true);

  const reviewer = DEFAULT_CONFIG.permissionProfiles["review-readonly"];
  assert.ok(reviewer);
  const properties = buildPermissionUnitProperties(reviewer, "/repo");
  for (const path of [...privilegedRuntimePaths(process.getuid?.()), ...credentialAgentPaths(process.getuid?.()), ...legacySessionIpcPaths()]) {
    assert.ok(properties.includes(`InaccessiblePaths=${JSON.stringify(`-${path}`)}`), `missing optional mask for ${path}`);
  }
  for (const name of [".npmrc", ".yarnrc", ".yarnrc.yml", ".pnpmrc", "bunfig.toml", ".netrc"]) {
    assert.ok(properties.includes(`InaccessiblePaths=${JSON.stringify(`-/repo/${name}`)}`));
  }
});

test("legacy Hyprland IPC paths remain explicitly masked", () => {
  assert.deepEqual(legacySessionIpcPaths("/home/example"), [
    "/tmp/hypr",
    "/tmp/hyprland",
    "/home/example/.cache/hypr",
    "/home/example/.cache/hyprland",
  ]);
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
  assert.equal(environment.GPG_AGENT_INFO, "");
  assert.equal(environment.GH_TOKEN, "");
  assert.equal(environment.GH_ENTERPRISE_TOKEN, "");
  assert.equal(environment.GH_CONFIG_DIR, "");
  assert.equal(environment.GLAB_TOKEN, "");
  assert.equal(environment.GLAB_CONFIG_DIR, "");
  assert.equal(environment.GLAB_CONFIG_FILE, "");
  assert.equal(environment.GLAB_HOST, "");
  assert.equal(environment.GITLAB_TOKEN_FILE, "");
  assert.equal(environment.GITLAB_ACCESS_TOKEN, "");
  assert.equal(environment.GITLAB_PRIVATE_TOKEN, "");
  assert.equal(environment.GITLAB_OAUTH_TOKEN, "");
  assert.equal(environment.GITLAB_API_URL, "");
  assert.equal(environment.GITLAB_GRAPHQL_URL, "");
  assert.equal(environment.GITLAB_CLIENT_KEY, "");
  assert.equal(environment.CI_JOB_TOKEN, "");
  assert.equal(environment.CI_JOB_TOKEN_FILE, "");
  assert.equal(environment.CI_REGISTRY_PASSWORD, "");
  assert.equal(environment.TEA_TOKEN, "");
  assert.equal(environment.TEA_TRACE, "");
  assert.equal(environment.GITEA_TOKEN, "");
  assert.equal(environment.GITEA_SERVER_PASSWORD, "");
  assert.equal(environment.GITEA_SERVER_TOKEN, "");
  assert.equal(environment.FORGEJO_TOKEN, "");
  assert.equal(environment.CLOUDSDK_AUTH_ACCESS_TOKEN, "");
  assert.equal(environment.CLOUDFLARE_API_TOKEN, "");
  assert.equal(environment.CLOUDFLARED_TOKEN, "");
  assert.equal(environment.CF_PASSWORD, "");
  assert.equal(environment.NPM_TOKEN, "");
  assert.equal(environment.NODE_AUTH_TOKEN, "");
  assert.equal(environment.NPM_CONFIG_USERCONFIG, "/dev/null");
  for (const name of [
    "HYPRLAND_INSTANCE_SIGNATURE", "WAYLAND_DISPLAY", "WAYLAND_SOCKET", "DISPLAY", "XAUTHORITY",
    "SWAYSOCK", "I3SOCK", "NIRI_SOCKET", "ALACRITTY_SOCKET", "KITTY_LISTEN_ON",
    "WEZTERM_UNIX_SOCKET", "GHOSTTY_SOCKET", "TMUX", "ZELLIJ", "PIPEWIRE_REMOTE",
    "PIPEWIRE_RUNTIME_DIR", "PULSE_SERVER", "PULSE_COOKIE", "AT_SPI_BUS_ADDRESS",
    "IBUS_ADDRESS", "FCITX_DBUS_ADDRESS", "NOTIFY_SOCKET", "XDG_SESSION_PATH",
  ]) {
    assert.equal(environment[name], "", `session target ${name} was not scrubbed`);
  }
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
  assert.equal(blockedToolReason("bash", { command: "glab issue list --repo owner/repo" }, "read-write", "read-only"), undefined);
  assert.equal(blockedToolReason("bash", { command: "/usr/bin/glab mr diff 42" }, "read-write", "read-only"), undefined);
  assert.match(blockedToolReason("bash", { command: "/usr/bin/glab issue create --title nope" }, "read-write", "read-only") ?? "", /GitLab write/);
  assert.match(blockedToolReason("bash", { command: "glab api /projects/1 -X POST -F name=nope" }, "read-write", "read-only") ?? "", /GitLab write/);
  assert.equal(blockedToolReason("bash", { command: "gh repo view owner/repo" }, "read-write", "read-only"), undefined);
  assert.match(blockedToolReason("bash", { command: "gh -R https://evil.invalid/o/r issue list" }, "read-write", "read-only") ?? "", /GitHub write/);
  assert.equal(blockedToolReason("bash", { command: "npm run test" }, "read-write", "read-only"), undefined);
  assert.match(blockedToolReason("bash", { command: "npm login" }, "read-write", "read-only") ?? "", /npm registry write/);
  assert.equal(blockedToolReason("bash", { command: "gcloud --version" }, "read-write", "read-only"), undefined);
  assert.match(blockedToolReason("bash", { command: "gcloud projects list" }, "read-write", "read-only") ?? "", /gcloud control operation/);
  assert.match(blockedToolReason("edit", { path: "src/a.ts" }, "read-only", "read-only") ?? "", /read-only workspace/);
  assert.equal(blockedToolReason("bash", { command: "git push origin main" }, "read-write", "full"), undefined);
});

test("cross-harness Git guard allows inspection and blocks mutation", () => {
  const guard = fileURLToPath(new URL("../src/guard-bin/git", import.meta.url));
  const environment = {
    ...process.env,
    AGENT_INTERCOM_REAL_GIT: "/usr/bin/git",
    AGENT_INTERCOM_GIT_POLICY: "read-only",
    AGENT_INTERCOM_PERMISSION_PROFILE: "builder-restricted",
  };
  const allowed = spawnSync(guard, ["-C", process.cwd(), "status", "--short"], { env: environment, encoding: "utf8" });
  assert.equal(allowed.status, 0, allowed.stderr);
  const blocked = spawnSync(guard, ["push", "origin", "main"], { env: environment, encoding: "utf8" });
  assert.equal(blocked.status, 126);
  assert.match(blocked.stderr, /git push blocked/);
  const branchBlocked = spawnSync(guard, ["branch", "new-feature"], { env: environment, encoding: "utf8" });
  assert.equal(branchBlocked.status, 126);
  const overrideBlocked = spawnSync(guard, ["push", "origin", "main"], { env: { ...environment, AGENT_INTERCOM_GIT_POLICY: "full" }, encoding: "utf8" });
  assert.equal(overrideBlocked.status, 126);
  const executableOverride = spawnSync(guard, ["status"], { env: { ...environment, AGENT_INTERCOM_REAL_GIT: "/bin/sh" }, encoding: "utf8" });
  assert.equal(executableOverride.status, 127);

  const ghGuard = fileURLToPath(new URL("../src/guard-bin/gh", import.meta.url));
  const ghEnvironment = { ...environment, AGENT_INTERCOM_REAL_GH: "/usr/bin/gh" };
  const ghAllowed = spawnSync(ghGuard, ["pr", "view", "--help"], { env: ghEnvironment, encoding: "utf8" });
  assert.equal(ghAllowed.status, 0);
  const ghBlocked = spawnSync(ghGuard, ["pr", "merge", "42"], { env: ghEnvironment, encoding: "utf8" });
  assert.equal(ghBlocked.status, 126);
  assert.match(ghBlocked.stderr, /gh pr merge .*blocked/);
});

test("GitHub policy validates repository targets and API reads", () => {
  for (const args of [
    ["--version"], ["auth", "status"], ["repo", "view", "owner/repo"], ["-R", "owner/repo", "pr", "diff", "42"],
    ["issue", "list"], ["run", "view", "42"], ["workflow", "view", "ci.yml"], ["search", "issues", "guard"],
    ["api", "/repos/owner/repo"], ["api", "/user", "-XHEAD", "--include"],
  ]) assert.equal(isReadOnlyGhInvocation(args), true, args.join(" "));
  for (const args of [
    ["repo", "create", "nope"], ["pr", "merge", "42"], ["release", "download", "v1"], ["browse"], ["auth", "status", "--show-token"], ["auth", "status", "-t"],
    ["-R", "evil.invalid/owner/repo", "issue", "list"], ["--repo=https://evil.invalid/o/r", "issue", "list"],
    ["issue", "view", "https://evil.invalid/o/r/issues/1"], ["api", "graphql"], ["api", "https://evil.invalid/api/v3/user"],
    ["api", "/user", "-XPOST"], ["api", "/user", "-H", "Authorization: token"], ["api", "/user", "--hostname", "evil.invalid"],
  ]) assert.equal(isReadOnlyGhInvocation(args), false, args.join(" "));
});

test("cross-harness GitHub guard fails closed on targets, tokens, and executable overrides", (t) => {
  const guard = fileURLToPath(new URL("../src/guard-bin/gh", import.meta.url));
  const allowed = spawnSync(guard, ["repo", "view", "--help"], { encoding: "utf8", env: { ...process.env, AGENT_INTERCOM_REAL_GH: "/usr/bin/gh" } });
  assert.equal(allowed.status, 0, allowed.stderr);
  for (const args of [["pr", "merge", "42"], ["-R", "evil.invalid/o/r", "issue", "list"], ["api", "/user", "-XPOST"]]) {
    const blocked = spawnSync(guard, args, { encoding: "utf8", env: { ...process.env, GH_TOKEN: "SENTINEL", AGENT_INTERCOM_REAL_GH: "/usr/bin/gh" } });
    assert.equal(blocked.status, 126, `${args.join(" ")}: ${blocked.stderr}`);
  }
  const override = spawnSync(guard, ["--version"], { encoding: "utf8", env: { ...process.env, AGENT_INTERCOM_REAL_GH: "/bin/sh" } });
  assert.equal(override.status, 127);
  if (!supportsHardenedUserUnits()) {
    t.diagnostic("systemd fake-gh credential proof skipped: hardened user namespaces unavailable");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "agent-intercom-gh-env-proof-"));
  const fake = join(root, "gh");
  try {
    writeFileSync(fake, `#!/bin/sh\nprintf 'GH_TOKEN=%s\\nGH_HOST=%s\\nGH_CONFIG_DIR=%s\\n' "$GH_TOKEN" "$GH_HOST" "$GH_CONFIG_DIR"\n`);
    chmodSync(fake, 0o555);
    const result = spawnSync("systemd-run", ["--user", "--wait", "--pipe", "--property=ProtectSystem=strict", "--property=PrivateTmp=yes", `--property=BindReadOnlyPaths=${fake}:/usr/bin/gh`, "/usr/bin/env", "AGENT_INTERCOM_REAL_GH=/usr/bin/gh", "GH_TOKEN=GH_SENTINEL", "GH_HOST=evil.invalid", guard, "--version"], { encoding: "utf8", timeout: 15_000 });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.doesNotMatch(result.stdout, /GH_SENTINEL|evil\.invalid/);
    assert.match(result.stdout, /^GH_TOKEN=$/m);
    assert.match(result.stdout, /^GH_HOST=$/m);
    assert.match(result.stdout, /^GH_CONFIG_DIR=\/tmp\/agent-intercom-gh\./m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Tea guard strips command-level Forgejo credentials and server overrides", (t) => {
  if (!supportsHardenedUserUnits()) {
    t.skip("systemd 257+ hardened user namespaces are unavailable");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "agent-intercom-tea-env-proof-"));
  const fake = join(root, "tea");
  const guard = fileURLToPath(new URL("../src/guard-bin/tea", import.meta.url));
  try {
    writeFileSync(fake, `#!/bin/sh\nprintf 'TEA_TOKEN=%s\\nGITEA_SERVER_URL=%s\\nGITEA_SERVER_TOKEN=%s\\nFORGEJO_TOKEN=%s\\nXDG_CONFIG_HOME=%s\\n' "$TEA_TOKEN" "$GITEA_SERVER_URL" "$GITEA_SERVER_TOKEN" "$FORGEJO_TOKEN" "$XDG_CONFIG_HOME"\n`);
    chmodSync(fake, 0o555);
    const result = spawnSync("systemd-run", ["--user", "--wait", "--pipe", "--property=ProtectSystem=strict", "--property=PrivateTmp=yes", `--property=BindReadOnlyPaths=${fake}:/usr/bin/tea`, "/usr/bin/env", "AGENT_INTERCOM_REAL_TEA=/usr/bin/tea", "TEA_TOKEN=TEA_SENTINEL", "GITEA_SERVER_URL=https://evil.invalid", "GITEA_SERVER_TOKEN=TEA_SENTINEL", "FORGEJO_TOKEN=TEA_SENTINEL", guard, "--version"], { encoding: "utf8", timeout: 15_000 });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.doesNotMatch(result.stdout, /TEA_SENTINEL|evil\.invalid/);
    assert.match(result.stdout, /^TEA_TOKEN=$/m);
    assert.match(result.stdout, /^GITEA_SERVER_URL=$/m);
    assert.match(result.stdout, /^GITEA_SERVER_TOKEN=$/m);
    assert.match(result.stdout, /^FORGEJO_TOKEN=$/m);
    assert.match(result.stdout, /^XDG_CONFIG_HOME=\/tmp\/agent-intercom-tea\./m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
  assert.equal(isReadOnlyTeaInvocation(["issues", "list", "--repo", "owner/repo"]), true);
  assert.equal(isReadOnlyTeaInvocation(["issues", "--repo", "https://evil.invalid/o/r", "list"]), false);
  assert.equal(isReadOnlyTeaInvocation(["issues", "-r", "git@evil.invalid:o/r", "list"]), false);
  assert.equal(isReadOnlyTeaInvocation(["issues", "list", "https://evil.invalid/o/r/issues"]), false);
  assert.equal(isReadOnlyTeaInvocation(["api", "https://evil.invalid/api/v1/user"]), false);
  assert.equal(isReadOnlyTeaInvocation(["api", "/user", "--login", "prod"]), false);
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
      ["issues", "--repo", "https://evil.invalid/o/r", "list"],
      ["issues", "-r", "git@evil.invalid:o/r", "list"],
      ["issues", "list", "https://evil.invalid/o/r/issues"],
      ["api", "https://evil.invalid/api/v1/user"],
      ["api", "/user", "--login", "prod"],
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

test("glab policy is a strict inspection allowlist", () => {
  for (const args of [
    ["--version"],
    ["issue", "list"],
    ["issue", "show", "42"],
    ["-R", "owner/repo", "issue", "ls"],
    ["issue", "-R", "owner/repo", "view", "42"],
    ["-g", "owner/nested-group", "repo", "list"],
    ["mr", "approvers", "42"],
    ["mr", "diff", "42"],
    ["mr", "issues", "42"],
    ["mr", "ls"],
    ["mr", "show", "42"],
    ["repo", "contributors"],
    ["repo", "list"],
    ["repo", "search", "guard"],
    ["repo", "view", "owner/repo"],
    ["release", "ls"],
    ["release", "view", "v1.0.0"],
    ["pipeline", "list"],
    ["ci", "get", "--pipeline-id", "42"],
    ["ci", "status"],
    ["ci", "trace", "123"],
    ["ci", "config", "compile", ".gitlab-ci.yml"],
    ["api", "/version"],
    ["api", "/projects", "--method", "GET", "--paginate", "--output", "ndjson"],
    ["api", "-XHEAD", "/version", "--include", "--silent"],
  ]) assert.equal(isReadOnlyGlabInvocation(args), true, args.join(" "));

  for (const args of [
    ["auth", "login"],
    ["config", "set", "host", "evil.invalid"],
    ["alias", "set", "pwn", "api"],
    ["issue", "create", "--title", "nope"],
    ["-R", "https://evil.invalid/group/project", "issue", "list"],
    ["--repo=git@evil.invalid:group/project", "issue", "list"],
    ["issue", "view", "https://evil.invalid/group/project/-/issues/1"],
    ["repo", "view", "evil.invalid:443/group/project"],
    ["-g", "https://evil.invalid/group", "repo", "list"],
    ["issue", "view", "42\nhttps://evil.invalid"],
    ["-R", "owner/repo", "issue", "create", "--title", "nope"],
    ["issue", "--repo", "owner/repo", "create", "--title", "nope"],
    ["issue", "update", "42"],
    ["issue", "note", "42"],
    ["mr", "approve", "42"],
    ["mr", "create"],
    ["mr", "merge", "42"],
    ["mr", "rebase", "42"],
    ["repo", "clone", "owner/repo"],
    ["repo", "create", "nope"],
    ["repo", "fork", "owner/repo"],
    ["repo", "delete", "owner/repo"],
    ["release", "create", "v1"],
    ["release", "download", "v1"],
    ["release", "upload", "v1", "file"],
    ["ci", "run"],
    ["ci", "retry", "42"],
    ["ci", "trigger", "42"],
    ["ci", "view"],
    ["job", "artifact", "main", "build"],
    ["runner", "list"],
    ["token", "list"],
    ["issue", "view", "42", "--web"],
    ["mr", "view", "42", "-w"],
    ["repo", "view", "owner/repo", "--web=true"],
    ["ci", "get", "--with-variables"],
    ["issue", "--unknown", "list"],
    ["ci", "config", "--unknown", "compile"],
    ["unknown", "list"],
    ["api", "/projects", "-X", "POST"],
    ["api", "/projects", "--method=PATCH"],
    ["api", "/projects", "-XDELETE"],
    ["api", "/projects", "--field", "name=nope"],
    ["api", "/projects", "-Fname=nope"],
    ["api", "/projects", "--raw-field=x=y"],
    ["api", "/projects", "--form", "file=@secret"],
    ["api", "/projects", "--input", "body.json"],
    ["api", "/projects", "--header", "X-HTTP-Method-Override: DELETE"],
    ["api", "/projects", "-HAuthorization: secret"],
    ["api", "/projects", "--hostname", "evil.invalid"],
    ["api", "https://evil.invalid/api/v4/projects"],
    ["api", "graphql"],
    ["api", "/graphql?query=query%20%7BcurrentUser%7Bname%7D%7D"],
    ["api", "/graphql?query=mutation%20%7Bnoop%7D"],
    ["api", "/graph%71l?query=query"],
    ["api", "/projects/group%2Frepo"],
    ["api", "/projects?_method=DELETE"],
    ["api", "/projects?%5Fmethod=DELETE"],
    ["api", "/projects", "/users"],
    ["api", "/projects", "--output", "yaml"],
    ["api", "/projects", "-X", "GET", "--method", "HEAD"],
    ["-R", "owner/repo", "api", "/projects"],
  ]) assert.equal(isReadOnlyGlabInvocation(args), false, args.join(" "));
});

test("cross-harness glab guard allows inspection and rejects policy or executable overrides", (t) => {
  const realGlab = "/usr/bin/glab";
  if (!existsSync(realGlab)) {
    t.skip("real glab executable is absent");
    return;
  }
  const guard = fileURLToPath(new URL("../src/guard-bin/glab", import.meta.url));
  const isolatedConfig = mkdtempSync(join(tmpdir(), "agent-intercom-glab-config-"));
  const environment = {
    ...process.env,
    XDG_CONFIG_HOME: isolatedConfig,
    GLAB_CONFIG_DIR: "",
    AGENT_INTERCOM_REAL_GLAB: realGlab,
    AGENT_INTERCOM_GIT_POLICY: "full",
    AGENT_INTERCOM_PERMISSION_PROFILE: "trusted",
  };
  const temporaryConfigDirs = () => readdirSync("/tmp").filter((entry) => entry.startsWith("agent-intercom-glab.")).sort();
  const beforeTemporaryConfigs = temporaryConfigDirs();
  try {
    for (const args of [
      ["--version"],
      ["issue", "list", "--help"],
      ["-R", "owner/repo", "mr", "diff", "--help"],
      ["repo", "view", "--help"],
      ["release", "ls", "--help"],
      ["pipeline", "list", "--help"],
      ["api", "--help"],
    ]) {
      const allowed = spawnSync(guard, args, { env: environment, encoding: "utf8" });
      assert.equal(allowed.status, 0, `${args.join(" ")}: ${allowed.stdout}${allowed.stderr}`);
    }
    for (const args of [
      ["issue", "create", "--title", "nope"],
      ["-R", "https://evil.invalid/group/project", "issue", "list"],
      ["--repo=git@evil.invalid:group/project", "issue", "list"],
      ["issue", "view", "https://evil.invalid/group/project/-/issues/1"],
      ["repo", "view", "evil.invalid:443/group/project"],
      ["-g", "https://evil.invalid/group", "repo", "list"],
      ["-R", "owner/repo", "issue", "create", "--title", "nope"],
      ["issue", "--repo", "owner/repo", "create", "--title", "nope"],
      ["mr", "merge", "42"],
      ["repo", "delete", "owner/repo"],
      ["release", "create", "v1"],
      ["ci", "run"],
      ["issue", "view", "42", "--web"],
      ["ci", "get", "--with-variables"],
      ["ci", "config", "--unknown", "compile"],
      ["api", "/projects", "-XPOST"],
      ["api", "graphql", "-XGET"],
      ["api", "/projects", "-H", "X-HTTP-Method-Override: DELETE"],
      ["-R", "owner/repo", "api", "/projects"],
    ]) {
      const blocked = spawnSync(guard, args, { env: environment, encoding: "utf8" });
      assert.equal(blocked.status, 126, `${args.join(" ")}: ${blocked.stdout}${blocked.stderr}`);
      assert.match(blocked.stderr, /blocked by Agent Intercom/);
    }

    const marker = join(isolatedConfig, "environment-bypass-marker");
    const shellOverride = spawnSync(guard, ["-c", `touch ${marker}`, "-h"], {
      env: { ...environment, AGENT_INTERCOM_REAL_GLAB: "/bin/sh" },
      encoding: "utf8",
    });
    assert.equal(shellOverride.status, 127);
    assert.equal(existsSync(marker), false);

    const writableBin = join(isolatedConfig, "bin");
    const writableGlab = join(writableBin, "glab");
    mkdirSync(writableBin);
    writeFileSync(writableGlab, `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(writableGlab, 0o555);
    const writableOverride = spawnSync(guard, ["--version"], {
      env: { ...environment, AGENT_INTERCOM_REAL_GLAB: writableGlab },
      encoding: "utf8",
    });
    assert.equal(writableOverride.status, 127);
    assert.equal(existsSync(marker), false);
    assert.deepEqual(temporaryConfigDirs(), beforeTemporaryConfigs);
  } finally {
    rmSync(isolatedConfig, { recursive: true, force: true });
  }
});

test("glab guard strips command-level credentials and host overrides before execution", (t) => {
  if (!supportsHardenedUserUnits()) {
    t.skip("systemd 257+ hardened user namespaces are unavailable");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "agent-intercom-glab-env-proof-"));
  const fakeGlab = join(root, "glab");
  const guard = fileURLToPath(new URL("../src/guard-bin/glab", import.meta.url));
  try {
    writeFileSync(fakeGlab, `#!/bin/sh\nprintf 'GLAB_TOKEN=%s\\nGITLAB_TOKEN=%s\\nCI_JOB_TOKEN=%s\\nGLAB_CONFIG_DIR=%s\\nGLAB_HOST=%s\\nGLAB_DEBUG_HTTP_SET=%s\\nGLAB_ENABLE_CI_AUTOLOGIN_SET=%s\\nGLAB_IS_OAUTH2_SET=%s\\nGITLAB_CI_SET=%s\\nGITLAB_SKIP_TLS_VERIFY_SET=%s\\n' "$GLAB_TOKEN" "$GITLAB_TOKEN" "$CI_JOB_TOKEN" "$GLAB_CONFIG_DIR" "$GLAB_HOST" "\${GLAB_DEBUG_HTTP+x}" "\${GLAB_ENABLE_CI_AUTOLOGIN+x}" "\${GLAB_IS_OAUTH2+x}" "\${GITLAB_CI+x}" "\${GITLAB_SKIP_TLS_VERIFY+x}"\n`);
    chmodSync(fakeGlab, 0o555);
    const result = spawnSync("systemd-run", [
      "--user", "--wait", "--pipe",
      "--property=ProtectSystem=strict",
      "--property=PrivateTmp=yes",
      `--property=BindReadOnlyPaths=${fakeGlab}:/usr/bin/glab`,
      "/usr/bin/env",
      "AGENT_INTERCOM_REAL_GLAB=/usr/bin/glab",
      "GLAB_TOKEN=GLAB_SENTINEL_TOKEN",
      "GITLAB_TOKEN=GITLAB_SENTINEL_TOKEN",
      "CI_JOB_TOKEN=GITLAB_SENTINEL_TOKEN",
      "GLAB_HOST=evil.invalid",
      "GLAB_DEBUG_HTTP=not-a-boolean",
      "GLAB_ENABLE_CI_AUTOLOGIN=not-a-boolean",
      "GLAB_IS_OAUTH2=not-a-boolean",
      "GITLAB_CI=not-a-boolean",
      "GITLAB_SKIP_TLS_VERIFY=not-a-boolean",
      guard, "--version",
    ], { encoding: "utf8", timeout: 15_000 });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.doesNotMatch(result.stdout, /GLAB_SENTINEL_TOKEN|evil\.invalid/);
    assert.match(result.stdout, /^GLAB_TOKEN=$/m);
    assert.match(result.stdout, /^GITLAB_TOKEN=$/m);
    assert.match(result.stdout, /^CI_JOB_TOKEN=$/m);
    assert.match(result.stdout, /^GLAB_HOST=$/m);
    assert.match(result.stdout, /^GLAB_DEBUG_HTTP_SET=$/m);
    assert.match(result.stdout, /^GLAB_ENABLE_CI_AUTOLOGIN_SET=$/m);
    assert.match(result.stdout, /^GLAB_IS_OAUTH2_SET=$/m);
    assert.match(result.stdout, /^GITLAB_CI_SET=$/m);
    assert.match(result.stdout, /^GITLAB_SKIP_TLS_VERIFY_SET=$/m);
    assert.match(result.stdout, /^GLAB_CONFIG_DIR=\/tmp\/agent-intercom-glab\.[A-Za-z0-9]+$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("npm registry guard permits local development and blocks account or publish operations", () => {
  for (const args of [["--version"], ["install"], ["ci"], ["run", "test"], ["view", "typescript", "version"], ["config", "get", "registry"], ["dist-tag", "ls", "pkg"]]) {
    assert.equal(isReadOnlyNpmInvocation(args), true, args.join(" "));
  }
  for (const args of [["login"], ["adduser"], ["publish"], ["unpublish", "pkg"], ["token", "list"], ["owner", "add", "x", "pkg"], ["config", "set", "//registry.npmjs.org/:_authToken=x"], ["install", "--registry=https://evil.invalid"], ["view", "pkg", "--reg=https://evil.invalid"], ["view", "pkg", "--reg", "https://evil.invalid"], ["view", "pkg", "--regi", "https://evil.invalid"], ["view", "pkg", "-reg=https://evil.invalid"], ["view", "pkg", "-registry=https://evil.invalid"], ["view", "pkg", "-reg", "https://evil.invalid"], ["view", "pkg", "--userconfig", "/tmp/host.npmrc"], ["view", "pkg", "--userc=/tmp/host.npmrc"], ["view", "pkg", "-userconfig=/tmp/host.npmrc"], ["view", "pkg", "-userconfig", "/tmp/host.npmrc"], ["view", "pkg", "-globalconfig=/tmp/global.npmrc"], ["install", "--proxy=http://evil.invalid"], ["install", "-proxy=http://evil.invalid"], ["install", "--strict-ssl=false"], ["install", "-strict-ssl=false"], ["view", "pkg", "--prefix=/tmp/other"], ["view", "pkg", "--prefix", "/tmp/other"], ["view", "pkg", "-prefix=/tmp/other"], ["view", "pkg", "-prefix", "/tmp/other"], ["dist-tag", "add", "pkg@1", "latest"]]) {
    assert.equal(isReadOnlyNpmInvocation(args), false, args.join(" "));
  }
  const guard = fileURLToPath(new URL("../src/guard-bin/npm", import.meta.url));
  const version = spawnSync(guard, ["--version"], { encoding: "utf8", env: { ...process.env, AGENT_INTERCOM_REAL_NPM: "/usr/bin/npm" } });
  if (version.status !== 0) {
    assert.equal(version.status, 127, version.stderr);
    assert.match(version.stderr, /Refusing untrusted real npm path/);
  }
  for (const args of [["login"], ["publish"], ["token", "list"], ["config", "set", "registry", "https://evil.invalid"], ["install", "--registry=https://evil.invalid"], ["view", "pkg", "--reg=https://evil.invalid"], ["view", "pkg", "--reg", "https://evil.invalid"], ["view", "pkg", "-reg=https://evil.invalid"], ["view", "pkg", "-registry=https://evil.invalid"], ["view", "pkg", "-userconfig=/tmp/host.npmrc"], ["view", "pkg", "-globalconfig=/tmp/global.npmrc"], ["install", "--proxy=http://evil.invalid"], ["install", "-proxy=http://evil.invalid"], ["install", "-strict-ssl=false"], ["view", "pkg", "--prefix=/tmp/other"], ["view", "pkg", "--prefix", "/tmp/other"], ["view", "pkg", "-prefix=/tmp/other"], ["view", "pkg", "-prefix", "/tmp/other"]]) {
    const blocked = spawnSync(guard, args, { encoding: "utf8", env: { ...process.env, NPM_TOKEN: "NPM_SENTINEL", AGENT_INTERCOM_REAL_NPM: "/usr/bin/npm" } });
    assert.equal(blocked.status, 126, `${args.join(" ")}: ${blocked.stderr}`);
  }
  const override = spawnSync(guard, ["--version"], { encoding: "utf8", env: { ...process.env, AGENT_INTERCOM_REAL_NPM: "/bin/sh" } });
  assert.equal(override.status, 127);
});

test("npm and cloud guards strip command-level credential overrides", (t) => {
  if (!supportsHardenedUserUnits()) {
    t.skip("systemd 257+ hardened user namespaces are unavailable");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "agent-intercom-control-env-proof-"));
  try {
    const npmFake = join(root, "npm");
    writeFileSync(npmFake, `#!/bin/sh\nprintf 'NPM_TOKEN=%s\\nNODE_AUTH_TOKEN=%s\\nNPM_CONFIG_USERCONFIG=%s\\nNPM_CONFIG_REGISTRY=%s\\n' "$NPM_TOKEN" "$NODE_AUTH_TOKEN" "$NPM_CONFIG_USERCONFIG" "$NPM_CONFIG_REGISTRY"\n`);
    chmodSync(npmFake, 0o555);
    const npmGuard = fileURLToPath(new URL("../src/guard-bin/npm", import.meta.url));
    const npmResult = spawnSync("systemd-run", ["--user", "--wait", "--pipe", "--property=ProtectSystem=strict", "--property=PrivateTmp=yes", `--property=BindReadOnlyPaths=${npmFake}:/usr/bin/npm`, "/usr/bin/env", "AGENT_INTERCOM_REAL_NPM=/usr/bin/npm", "NPM_TOKEN=PACKAGE_SENTINEL", "NODE_AUTH_TOKEN=PACKAGE_SENTINEL", "NPM_CONFIG_USERCONFIG=/home/dxyz/.npmrc", "NPM_CONFIG_REGISTRY=https://evil.invalid", npmGuard, "--version"], { encoding: "utf8", timeout: 15_000 });
    assert.equal(npmResult.status, 0, `${npmResult.stdout}${npmResult.stderr}`);
    assert.doesNotMatch(npmResult.stdout, /PACKAGE_SENTINEL|evil\.invalid|\/home\/dxyz\/\.npmrc/);
    assert.match(npmResult.stdout, /^NPM_TOKEN=$/m);
    assert.match(npmResult.stdout, /^NODE_AUTH_TOKEN=$/m);
    assert.match(npmResult.stdout, /^NPM_CONFIG_USERCONFIG=\/tmp\/agent-intercom-npm\./m);
    assert.match(npmResult.stdout, /^NPM_CONFIG_REGISTRY=https:\/\/registry\.npmjs\.org\/$/m);

    const cloudFake = join(root, "gcloud");
    writeFileSync(cloudFake, `#!/bin/sh\nprintf 'GOOGLE_OAUTH_ACCESS_TOKEN=%s\\nCLOUDSDK_AUTH_ACCESS_TOKEN=%s\\nCLOUDFLARE_API_TOKEN=%s\\n' "$GOOGLE_OAUTH_ACCESS_TOKEN" "$CLOUDSDK_AUTH_ACCESS_TOKEN" "$CLOUDFLARE_API_TOKEN"\n`);
    chmodSync(cloudFake, 0o555);
    const cloudGuard = fileURLToPath(new URL("../src/guard-bin/gcloud", import.meta.url));
    const cloudResult = spawnSync("systemd-run", ["--user", "--wait", "--pipe", "--property=ProtectSystem=strict", `--property=BindReadOnlyPaths=${cloudFake}:/usr/bin/gcloud`, "/usr/bin/env", "AGENT_INTERCOM_REAL_GCLOUD=/usr/bin/gcloud", "GOOGLE_OAUTH_ACCESS_TOKEN=CLOUD_SENTINEL", "CLOUDSDK_AUTH_ACCESS_TOKEN=CLOUD_SENTINEL", "CLOUDFLARE_API_TOKEN=CLOUD_SENTINEL", cloudGuard, "--version"], { encoding: "utf8", timeout: 15_000 });
    assert.equal(cloudResult.status, 0, `${cloudResult.stdout}${cloudResult.stderr}`);
    assert.doesNotMatch(cloudResult.stdout, /CLOUD_SENTINEL/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cloud-control guards allow help/version only", () => {
  const allowed: Array<[string, string[]]> = [
    ["gcloud", ["version"]], ["wrangler", ["--version"]], ["cloudflared", ["--version"]], ["cf", ["version"]],
  ];
  for (const [command, args] of allowed) assert.equal(isCloudControlInspection(command, args), true, `${command} ${args.join(" ")}`);
  for (const [command, args] of [["gcloud", ["projects", "list"]], ["wrangler", ["deploy"]], ["cloudflared", ["tunnel", "run"]], ["cf", ["apps"]]] as Array<[string, string[]]>) {
    assert.equal(isCloudControlInspection(command, args), false, `${command} ${args.join(" ")}`);
    const guard = fileURLToPath(new URL(`../src/guard-bin/${command}`, import.meta.url));
    const blocked = spawnSync(guard, args, { encoding: "utf8" });
    assert.equal(blocked.status, 126, `${command}: ${blocked.stderr}`);
  }
  const gcloudGuard = fileURLToPath(new URL("../src/guard-bin/gcloud", import.meta.url));
  if (existsSync("/usr/bin/gcloud")) {
    const version = spawnSync(gcloudGuard, ["--version"], { encoding: "utf8", env: { ...process.env, AGENT_INTERCOM_REAL_GCLOUD: "/usr/bin/gcloud" } });
    assert.equal(version.status, 0, version.stderr);
  }
});

test("Node-based guards clear preload injection before policy code", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-intercom-node-options-proof-"));
  const marker = join(root, "preload-marker");
  const preload = join(root, "preload.cjs");
  const fakeDirname = join(root, "dirname");
  try {
    writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')\n`);
    writeFileSync(fakeDirname, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`);
    chmodSync(fakeDirname, 0o755);
    for (const [name, args, realEnv, realPath, expectedStatus] of [
      ["git", ["--version"], "AGENT_INTERCOM_REAL_GIT", "/usr/bin/git", 0],
      ["gh", ["--version"], "AGENT_INTERCOM_REAL_GH", "/usr/bin/gh", 0],
      ["npm", ["--version"], "AGENT_INTERCOM_REAL_NPM", "/usr/bin/npm", 0],
      ["gcloud", ["projects", "list"], "AGENT_INTERCOM_REAL_GCLOUD", "/usr/bin/gcloud", 126],
    ] as Array<[string, string[], string, string, number]>) {
      if (!existsSync(realPath)) continue;
      rmSync(marker, { force: true });
      const guard = fileURLToPath(new URL(`../src/guard-bin/${name}`, import.meta.url));
      const result = spawnSync(guard, args, { encoding: "utf8", env: { ...process.env, PATH: `${root}:${process.env.PATH}`, NODE_OPTIONS: `--require=${preload}`, NODE_PATH: root, [realEnv]: realPath } });
      assert.equal(result.status, expectedStatus, `${name}: ${result.stderr}`);
      assert.equal(existsSync(marker), false, `${name} executed NODE_OPTIONS preload`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("new credential guards are executable and packaged", () => {
  const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
  for (const name of ["npm", "gcloud", "wrangler", "cloudflared", "cf"]) {
    const guard = fileURLToPath(new URL(`../src/guard-bin/${name}`, import.meta.url));
    assert.notEqual(statSync(guard).mode & 0o111, 0, name);
    assert.ok(packageJson.files.includes(`src/guard-bin/${name}`), name);
  }
});

test("glab guard is executable and explicitly included in package files", () => {
  const guard = fileURLToPath(new URL("../src/guard-bin/glab", import.meta.url));
  assert.notEqual(statSync(guard).mode & 0o111, 0);
  const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
  assert.ok(packageJson.files.includes("src/guard-bin/glab"));
});

test("Tea guard is executable and explicitly included in package files", () => {
  const guard = fileURLToPath(new URL("../src/guard-bin/tea", import.meta.url));
  assert.notEqual(statSync(guard).mode & 0o111, 0);
  const packageJson = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
  assert.ok(packageJson.files.includes("src/guard-bin/tea"));
});

test("hardened systemd profile masks project-local package-manager credentials", (t) => {
  if (!supportsHardenedUserUnits()) {
    t.skip("systemd 257+ hardened user namespaces are unavailable");
    return;
  }
  const root = mkdtempSync(join(homedir(), ".agent-intercom-package-config-test-"));
  const npmrc = join(root, ".npmrc");
  try {
    writeFileSync(npmrc, "//registry.npmjs.org/:_authToken=PACKAGE_SENTINEL\n", { mode: 0o600 });
    assert.match(readFileSync(npmrc, "utf8"), /PACKAGE_SENTINEL/);
    const builder = DEFAULT_CONFIG.permissionProfiles["builder-restricted"];
    assert.ok(builder);
    const properties = buildPermissionUnitProperties(builder, root);
    const result = spawnSync("systemd-run", ["--user", "--wait", "--pipe", ...properties.map((property) => `--property=${property}`), "/bin/sh", "-c", `! test -r ${JSON.stringify(npmrc)} && ! cat ${JSON.stringify(npmrc)} >/dev/null 2>&1`], { encoding: "utf8", timeout: 15_000 });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hardened systemd profile blocks host SSH and GPG agent sockets", (t) => {
  if (!supportsHardenedUserUnits()) {
    t.skip("systemd 257+ hardened user namespaces are unavailable");
    return;
  }
  const uid = process.getuid?.();
  if (!Number.isInteger(uid)) {
    t.skip("numeric uid unavailable");
    return;
  }
  const candidates = credentialAgentPaths(uid).flatMap((path) => existsSync(path) && statSync(path).isSocket() ? [path] : []);
  const socket = candidates[0] ?? join(`/run/user/${uid}`, "gnupg", "S.gpg-agent.ssh");
  if (!existsSync(socket)) {
    t.skip("host SSH/GPG agent socket is absent");
    return;
  }
  const probe = "import socket,sys; s=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); s.close()";
  const host = spawnSync("python3", ["-c", probe, socket], { encoding: "utf8", timeout: 5_000 });
  if (host.status !== 0) {
    t.skip(`host agent socket is not connectable: ${host.stderr.trim()}`);
    return;
  }
  const reviewer = DEFAULT_CONFIG.permissionProfiles["review-readonly"];
  assert.ok(reviewer);
  const properties = buildPermissionUnitProperties(reviewer, process.cwd());
  const deniedProbe = "import socket,sys\ntry:\n s=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); s.close(); sys.exit(1)\nexcept OSError:\n sys.exit(0)";
  const result = spawnSync("systemd-run", ["--user", "--wait", "--pipe", ...properties.map((property) => `--property=${property}`), "python3", "-c", deniedProbe, socket], { encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test("hardened systemd profile uses a private runtime and preserves only the assigned worker bind", async (t) => {
  if (!supportsHardenedUserUnits()) {
    t.skip("systemd 257+ hardened user namespaces are unavailable");
    return;
  }
  const uid = process.getuid?.();
  if (!Number.isInteger(uid)) {
    t.skip("numeric uid unavailable");
    return;
  }
  const runtime = `/run/user/${uid}`;
  const root = mkdtempSync(join(homedir(), ".agent-intercom-session-runtime-"));
  const privateRuntime = join(root, "private-runtime");
  const targetRuntime = join(runtime, "agent-intercom-worker");
  const hostMarker = join(runtime, `agent-intercom-host-marker-${process.pid}`);
  const lateSocket = join(runtime, `agent-intercom-late-socket-${process.pid}.sock`);
  const ready = join(root, "ready");
  const go = join(root, "go");
  const server = createServer();
  const unit = `agent-intercom-session-runtime-test-${process.pid}.service`;
  try {
    mkdirSync(privateRuntime);
    writeFileSync(join(privateRuntime, "assigned"), "private\n");
    writeFileSync(hostMarker, "host\n");
    const builder = DEFAULT_CONFIG.permissionProfiles["builder-restricted"];
    assert.ok(builder);
    const properties = buildPermissionUnitProperties(builder, root, [], [], [], [], [`${privateRuntime}:${targetRuntime}`]);
    assert.ok(properties.includes(`TemporaryFileSystem=${runtime}:rw`));
    const script = [
      `! test -e ${JSON.stringify(hostMarker)}`,
      `test \"$(cat ${JSON.stringify(join(targetRuntime, "assigned"))})\" = private`,
      `touch ${JSON.stringify(ready)}`,
      `while ! test -e ${JSON.stringify(go)}; do sleep 0.05; done`,
      `! test -e ${JSON.stringify(lateSocket)}`,
      `printf 'worker\\n' > ${JSON.stringify(join(targetRuntime, "written"))}`,
    ].join(" && ");
    const child = spawn("systemd-run", [
      "--user", "--wait", "--pipe", `--unit=${unit.slice(0, -8)}`,
      ...properties.map((property) => `--property=${property}`),
      "/bin/sh", "-c", script,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const deadline = Date.now() + 5_000;
    while (!existsSync(ready) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    if (!existsSync(ready)) {
      child.kill("SIGKILL");
      assert.fail(`private runtime unit did not become ready: ${stderr}`);
    }
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(lateSocket, resolve);
    });
    writeFileSync(go, "go\n");
    const status = await Promise.race([
      new Promise<number | null>((resolve) => child.once("close", resolve)),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("private runtime unit timed out")), 15_000)),
    ]);
    assert.equal(status, 0, `${stdout}${stderr}`);
    assert.equal(readFileSync(join(privateRuntime, "written"), "utf8"), "worker\n");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve())).catch(() => undefined);
    spawnSync("systemctl", ["--user", "stop", unit], { stdio: "ignore", timeout: 5_000 });
    spawnSync("systemctl", ["--user", "reset-failed", unit], { stdio: "ignore", timeout: 5_000 });
    rmSync(hostMarker, { force: true });
    rmSync(lateSocket, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

test("hardened systemd profile blocks host Hyprland control IPC", (t) => {
  if (!supportsHardenedUserUnits()) {
    t.skip("systemd 257+ hardened user namespaces are unavailable");
    return;
  }
  const uid = process.getuid?.();
  const signature = process.env.HYPRLAND_INSTANCE_SIGNATURE;
  const hyprctl = spawnSync("sh", ["-c", "command -v hyprctl"], { encoding: "utf8" }).stdout.trim();
  if (!Number.isInteger(uid) || !signature || !hyprctl) {
    t.skip("active host Hyprland session is unavailable");
    return;
  }
  const runtime = `/run/user/${uid}`;
  const socket = join(runtime, "hypr", signature, ".socket.sock");
  if (!existsSync(socket)) {
    t.skip("host Hyprland command socket is absent");
    return;
  }
  const connectProbe = "import socket,sys; s=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); s.close()";
  const hostSocket = spawnSync("python3", ["-c", connectProbe, socket], { stdio: "ignore", timeout: 5_000 });
  const hostQuery = spawnSync(hyprctl, ["-j", "activeworkspace"], { stdio: "ignore", timeout: 5_000, env: { ...process.env, XDG_RUNTIME_DIR: runtime, HYPRLAND_INSTANCE_SIGNATURE: signature } });
  if (hostSocket.status !== 0 || hostQuery.status !== 0) {
    t.skip("host Hyprland IPC is not connectable for a non-vacuous proof");
    return;
  }

  const builder = DEFAULT_CONFIG.permissionProfiles["builder-restricted"];
  assert.ok(builder);
  const propertyArgs = buildPermissionUnitProperties(builder, process.cwd()).map((property) => `--property=${property}`);
  const deniedProbe = "import socket,sys\ntry:\n s=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); s.close(); sys.exit(3)\nexcept OSError as error:\n print(error.errno); sys.exit(0)";
  const deniedSocket = spawnSync("systemd-run", [
    "--user", "--wait", "--pipe", ...propertyArgs,
    "python3", "-c", deniedProbe, socket,
  ], { encoding: "utf8", timeout: 15_000 });
  assert.equal(deniedSocket.status, 0, `hardened Hyprland socket probe failed: ${deniedSocket.stderr}`);

  const deniedQuery = spawnSync("systemd-run", [
    "--user", "--wait", "--pipe", ...propertyArgs,
    `--setenv=XDG_RUNTIME_DIR=${runtime}`,
    `--setenv=HYPRLAND_INSTANCE_SIGNATURE=${signature}`,
    hyprctl, "-j", "activeworkspace",
  ], { stdio: "ignore", timeout: 15_000 });
  assert.notEqual(deniedQuery.status, 0, "hardened unit unexpectedly queried host Hyprland state");
});

test("hardened systemd profile blocks host Alacritty control IPC", (t) => {
  if (!supportsHardenedUserUnits()) {
    t.skip("systemd 257+ hardened user namespaces are unavailable");
    return;
  }
  const uid = process.getuid?.();
  const alacritty = spawnSync("sh", ["-c", "command -v alacritty"], { encoding: "utf8" }).stdout.trim();
  if (!Number.isInteger(uid) || !alacritty) {
    t.skip("Alacritty or numeric uid is unavailable");
    return;
  }
  const runtime = `/run/user/${uid}`;
  const candidates = [
    process.env.ALACRITTY_SOCKET,
    ...readdirSync(runtime).filter((name) => /^Alacritty-.*\.sock$/i.test(name)).map((name) => join(runtime, name)),
  ].filter((path): path is string => Boolean(path && path.startsWith(`${runtime}/`) && existsSync(path)));
  const socket = [...new Set(candidates)].find((path) => spawnSync(alacritty, ["msg", "--socket", path, "get-config"], { stdio: "ignore", timeout: 3_000 }).status === 0);
  if (!socket) {
    t.skip("no host Alacritty IPC socket answered a non-mutating get-config query");
    return;
  }

  const connectProbe = "import socket,sys; s=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); s.close()";
  assert.equal(spawnSync("python3", ["-c", connectProbe, socket], { stdio: "ignore", timeout: 5_000 }).status, 0, "host Alacritty AF_UNIX proof failed");
  const builder = DEFAULT_CONFIG.permissionProfiles["builder-restricted"];
  assert.ok(builder);
  const propertyArgs = buildPermissionUnitProperties(builder, process.cwd()).map((property) => `--property=${property}`);
  const deniedProbe = "import socket,sys\ntry:\n s=socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); s.close(); sys.exit(3)\nexcept OSError as error:\n print(error.errno); sys.exit(0)";
  const deniedSocket = spawnSync("systemd-run", [
    "--user", "--wait", "--pipe", ...propertyArgs,
    "python3", "-c", deniedProbe, socket,
  ], { encoding: "utf8", timeout: 15_000 });
  assert.equal(deniedSocket.status, 0, `hardened Alacritty socket probe failed: ${deniedSocket.stderr}`);

  const deniedQuery = spawnSync("systemd-run", [
    "--user", "--wait", "--pipe", ...propertyArgs,
    `--setenv=ALACRITTY_SOCKET=${socket}`,
    alacritty, "msg", "--socket", socket, "get-config",
  ], { stdio: "ignore", timeout: 15_000 });
  assert.notEqual(deniedQuery.status, 0, "hardened unit unexpectedly queried host Alacritty config");
});

test("hardened systemd profile makes host Google Cloud credentials inaccessible", (t) => {
  if (!supportsHardenedUserUnits()) {
    t.skip("systemd 257+ hardened user namespaces are unavailable");
    return;
  }
  const candidates = [
    join(homedir(), ".config", "gcloud", "credentials.db"),
    join(homedir(), ".config", "gcloud", "access_tokens.db"),
    join(homedir(), ".config", "gcloud", "application_default_credentials.json"),
  ];
  const credential = candidates.find((path) => existsSync(path));
  if (!credential) {
    t.skip("host Google Cloud credential files are absent");
    return;
  }
  assert.equal(spawnSync("/bin/sh", ["-c", `test -r ${JSON.stringify(credential)}`]).status, 0, "host Google credential proof must be non-vacuous");
  const reviewer = DEFAULT_CONFIG.permissionProfiles["review-readonly"];
  assert.ok(reviewer);
  const properties = buildPermissionUnitProperties(reviewer, process.cwd());
  const result = spawnSync("systemd-run", ["--user", "--wait", "--pipe", ...properties.map((property) => `--property=${property}`), "/bin/sh", "-c", `! test -r ${JSON.stringify(credential)} && ! head -c 1 ${JSON.stringify(credential)} >/dev/null 2>&1`], { encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test("hardened systemd profile makes host glab configuration inaccessible", (t) => {
  const glabConfig = join(homedir(), ".config", "glab-cli", "config.yml");
  if (!supportsHardenedUserUnits()) {
    t.skip("systemd 257+ hardened user namespaces are unavailable");
    return;
  }
  if (!existsSync(glabConfig)) {
    t.skip("host glab configuration is absent");
    return;
  }
  assert.equal(spawnSync("/bin/sh", ["-c", `test -r ${JSON.stringify(glabConfig)}`]).status, 0, "host glab config proof must be non-vacuous");
  const reviewer = DEFAULT_CONFIG.permissionProfiles["review-readonly"];
  assert.ok(reviewer);
  const properties = buildPermissionUnitProperties(reviewer, process.cwd());
  const result = spawnSync("systemd-run", [
    "--user", "--wait", "--pipe",
    ...properties.map((property) => `--property=${property}`),
    "/bin/sh", "-c", `! test -r ${JSON.stringify(glabConfig)} && ! cat ${JSON.stringify(glabConfig)} >/dev/null 2>&1`,
  ], { encoding: "utf8", timeout: 15_000 });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});

test("hardened systemd profile makes host Tea configuration inaccessible", (t) => {
  const teaConfig = join(homedir(), ".config", "tea", "config.yml");
  if (!supportsHardenedUserUnits()) {
    t.skip("systemd 257+ hardened user namespaces are unavailable");
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

test("hardened systemd profile blocks the host Docker control socket without contacting the daemon", (t) => {
  const dockerSocket = "/run/docker.sock";
  if (!supportsHardenedUserUnits()) {
    t.skip("systemd 257+ hardened user namespaces are unavailable");
    return;
  }
  if (!existsSync(dockerSocket)) {
    t.skip("host Docker socket is absent");
    return;
  }
  const dockerPath = spawnSync("sh", ["-c", "command -v docker"], { encoding: "utf8" }).stdout.trim();
  if (!dockerPath) {
    t.skip("Docker CLI is absent");
    return;
  }
  const hostProof = spawnSync(dockerPath, ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
    env: { ...process.env, DOCKER_HOST: `unix://${dockerSocket}` },
    timeout: 10_000,
  });
  if (hostProof.status !== 0) {
    t.skip(`host Docker daemon is not reachable for a non-vacuous proof: ${hostProof.stderr.trim()}`);
    return;
  }

  const builder = DEFAULT_CONFIG.permissionProfiles["builder-restricted"];
  assert.ok(builder);
  const properties = buildPermissionUnitProperties(builder, process.cwd());
  const propertyArgs = properties.map((property) => `--property=${property}`);

  const socketProbe = String.raw`
    const net = require("node:net");
    const socket = net.createConnection({ path: ${JSON.stringify(dockerSocket)} });
    const timer = setTimeout(() => { socket.destroy(); process.exit(2); }, 2000);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); process.exit(3); });
    socket.once("error", (error) => { clearTimeout(timer); console.log(error.code || error.message); process.exit(0); });
  `;
  const openResult = spawnSync("systemd-run", [
    "--user", "--wait", "--pipe", ...propertyArgs,
    process.execPath, "-e", socketProbe,
  ], { encoding: "utf8", timeout: 15_000 });
  assert.equal(openResult.status, 0, `${openResult.stdout}${openResult.stderr}`);
  assert.match(openResult.stdout, /EACCES|ENOENT|EPERM|ENOTDIR/);

  const dockerResult = spawnSync("systemd-run", [
    "--user", "--wait", "--pipe", ...propertyArgs,
    `--setenv=DOCKER_HOST=unix://${dockerSocket}`,
    dockerPath, "version", "--format", "{{.Server.Version}}",
  ], { encoding: "utf8", timeout: 15_000 });
  assert.notEqual(dockerResult.status, 0, `${dockerResult.stdout}${dockerResult.stderr}`);
  assert.match(`${dockerResult.stdout}\n${dockerResult.stderr}`, /permission denied|cannot connect|failed to connect|no such file|operation not permitted/i);
});

test("hardened systemd profile blocks direct host login and shutdown Varlink sockets", (t) => {
  if (!supportsHardenedUserUnits()) {
    t.skip("systemd 257+ hardened user namespaces are unavailable");
    return;
  }
  const varlinkctl = spawnSync("sh", ["-c", "command -v varlinkctl"], { encoding: "utf8" }).stdout.trim();
  if (!varlinkctl) {
    t.skip("varlinkctl is absent");
    return;
  }
  const endpoints = [
    "/run/systemd/io.systemd.Login",
    "/run/systemd/io.systemd.Shutdown",
  ].filter((path) => existsSync(path));
  if (!endpoints.length) {
    t.skip("host login/shutdown Varlink sockets are absent");
    return;
  }
  for (const endpoint of endpoints) {
    const hostInfo = spawnSync(varlinkctl, ["info", `unix:${endpoint}`], { encoding: "utf8", timeout: 10_000 });
    assert.equal(hostInfo.status, 0, `host Varlink proof failed for ${endpoint}: ${hostInfo.stdout}${hostInfo.stderr}`);
    assert.match(hostInfo.stdout, /io\.systemd\.(?:Login|Shutdown)/);
  }

  const builder = DEFAULT_CONFIG.permissionProfiles["builder-restricted"];
  assert.ok(builder);
  const propertyArgs = buildPermissionUnitProperties(builder, process.cwd()).map((property) => `--property=${property}`);
  for (const endpoint of endpoints) {
    const socketProbe = String.raw`
      const net = require("node:net");
      const socket = net.createConnection({ path: ${JSON.stringify(endpoint)} });
      const timer = setTimeout(() => { socket.destroy(); process.exit(2); }, 2000);
      socket.once("connect", () => { clearTimeout(timer); socket.destroy(); process.exit(3); });
      socket.once("error", (error) => { clearTimeout(timer); console.log(error.code || error.message); process.exit(0); });
    `;
    const blocked = spawnSync("systemd-run", [
      "--user", "--wait", "--pipe", ...propertyArgs,
      process.execPath, "-e", socketProbe,
    ], { encoding: "utf8", timeout: 15_000 });
    assert.equal(blocked.status, 0, `hardened unit socket probe failed for ${endpoint}: ${blocked.stdout}${blocked.stderr}`);
    assert.match(blocked.stdout, /EACCES|EPERM|ENOENT|ENOTDIR/);
  }
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

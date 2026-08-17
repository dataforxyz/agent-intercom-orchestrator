import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDirectInteractiveBossCommand,
  bossAuthorityUnavailableMessage,
  bossCreateRequest,
  parseBossCommand,
} from "../src/boss-command.ts";

test("Boss command parser is exact and defaults to status", () => {
  assert.deepEqual(parseBossCommand(""), { action: "status" });
  assert.deepEqual(parseBossCommand("status"), { action: "status" });
  assert.deepEqual(parseBossCommand("doctor"), { action: "doctor" });
  assert.deepEqual(parseBossCommand("plan"), { action: "plan" });
  assert.throws(() => parseBossCommand("doctor extra"), /does not accept arguments/);
  assert.throws(() => parseBossCommand("plan extra"), /does not accept arguments/);
  assert.deepEqual(parseBossCommand("status boss-run_123"), { action: "status", bossRunId: "boss-run_123" });
  assert.deepEqual(parseBossCommand("create implement one exact goal"), {
    action: "create",
    goal: "implement one exact goal",
  });
  assert.deepEqual(parseBossCommand("reject boss-run_123 insufficient proof"), {
    action: "reject",
    bossRunId: "boss-run_123",
    note: "insufficient proof",
  });
  assert.deepEqual(parseBossCommand("freeze boss-run_123 4 7"), {
    action: "freeze",
    bossRunId: "boss-run_123",
    expectedAcceptanceRevision: 4,
    expectedDesignRevision: 7,
  });
  assert.deepEqual(parseBossCommand(`unfreeze boss-run_123 3 ${"a".repeat(64)}`), {
    action: "unfreeze",
    bossRunId: "boss-run_123",
    expectedFreezeRevision: 3,
    expectedFingerprintSha256: "a".repeat(64),
  });
  assert.throws(() => parseBossCommand("freeze boss-run_123 1"), /requires/);
  assert.throws(() => parseBossCommand("freeze boss-run_123 0 1"), /positive/);
  assert.throws(() => parseBossCommand("unfreeze boss-run_123 1 nope"), /requires/);
  assert.throws(() => parseBossCommand("create"), /requires one explicit goal/);
  assert.throws(() => parseBossCommand("resume short"), /8-128/);
  for (const action of ["resume", "pause", "freeze", "unfreeze", "cancel", "proof", "approve", "reject"] as const) {
    assert.throws(() => parseBossCommand(action), /Boss run id must be 8-128/, `${action} must require an exact run id`);
  }
  assert.throws(() => parseBossCommand("status boss-run_123 unexpected-detail-token"), /Boss run id must be 8-128/);
  assert.throws(() => parseBossCommand("unknown"), /Unknown \/boss action/);
});

test("Boss tool create requirements use only explicit structured fields", () => {
  assert.deepEqual(bossCreateRequest("  implement and verify  ", { worktree: "write", edit: true, tests: true }), {
    action: "create",
    goal: "implement and verify",
    requirements: { worktree: "write", edit: true, tests: true },
  });
  assert.deepEqual(bossCreateRequest("inspect only", { edit: false, tests: false, testCommand: [], gitTransport: "none" }), { action: "create", goal: "inspect only" });
  assert.deepEqual(bossCreateRequest("test explicitly", { tests: true, testCommand: [" npm ", " test "] }), { action: "create", goal: "test explicitly", requirements: { tests: true, testCommand: ["npm", "test"] } });
  assert.deepEqual(bossCreateRequest("provision explicitly", { worktree: "write", gitTransport: "none" }, "  /srv/source/repo  "), { action: "create", goal: "provision explicitly", requirements: { worktree: "write" }, sourcePath: "/srv/source/repo" });
  assert.throws(() => bossCreateRequest("work", { worktree: "write" }, "relative/repo"), /sourcePath must be absolute/);
  assert.throws(() => bossCreateRequest("work", { edit: true }, "/srv/source/repo"), /sourcePath requires an explicit worktree/);
  assert.throws(() => bossCreateRequest("", { edit: true }), /requires one explicit goal/);
  assert.throws(() => bossCreateRequest("work", ["edit"] as any), /structured object/);
  assert.throws(() => bossCreateRequest("work", { worktree: "execute" } as any), /must be read or write/);
  assert.throws(() => bossCreateRequest("work", { gitTransport: "execute" } as any), /must be none, read, or write/);
  assert.throws(() => bossCreateRequest("work", { testCommand: ["npm", "test"] }), /requires tests=true/);
  assert.throws(() => bossCreateRequest("work", { tests: true, testCommand: [""] }), /argv array of non-empty strings/);
  assert.throws(() => bossCreateRequest("work", { remoteShell: true } as any), /unknown field/);
});

test("Boss commands reject every non-interactive invocation", () => {
  assert.doesNotThrow(() => assertDirectInteractiveBossCommand({ mode: "tui", hasUI: true }));
  for (const mode of ["rpc", "json", "print"] as const) {
    assert.throws(
      () => assertDirectInteractiveBossCommand({ mode, hasUI: mode === "rpc" }),
      /BOSS_DIRECT_USER_COMMAND_REQUIRED/,
    );
  }
  assert.throws(
    () => assertDirectInteractiveBossCommand({ mode: "tui", hasUI: false }),
    /BOSS_DIRECT_USER_COMMAND_REQUIRED/,
  );
});

test("unavailable authority response names every missing root of trust and makes no success claim", () => {
  const message = bossAuthorityUnavailableMessage(parseBossCommand("create prove the feature"));
  assert.match(message, /BOSS_AUTHORITY_UNAVAILABLE/);
  assert.match(message, /dedicated-UID Controller authority service/);
  assert.match(message, /broker-authoritative authority transition/);
  assert.match(message, /Manager inventory verification/);
  assert.match(message, /No run, credential, assignment, transition, or correlation state was created/);
  assert.doesNotMatch(message, /created successfully|ready|approved successfully/i);
});

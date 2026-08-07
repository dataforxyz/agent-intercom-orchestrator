# Orc Boss installation and onboarding

Orc Boss is a trusted-local workflow for a top-level Pi Controller. It requires Linux, a responsive systemd user manager, an active Agent Intercom identity, and four globally configured Pi resources:

1. [`dataforxyz/agent-intercom-pi`](https://github.com/dataforxyz/agent-intercom-pi)
2. [`dataforxyz/agent-intercom-orchestrator`](https://github.com/dataforxyz/agent-intercom-orchestrator)
3. the `pi-ralph-wiggum/index.ts` extension from [`dataforxyz/pi-extensions`](https://github.com/dataforxyz/pi-extensions)
4. [`dataforxyz/pi-return-on`](https://github.com/dataforxyz/pi-return-on)

> **TRUSTED LOCAL MODE — same-user agents and local files are trusted; evidence is advisory, not tamper-proof.**

The setup path is preview-first. It does not overwrite unrelated Pi settings, providers, authentication, themes, package entries, model configuration, or unrelated Orchestrator fields. It refuses configured resources that are dirty, explicitly pinned, duplicated, filtered so the required entrypoint is disabled, missing their manifest/entrypoint, or resolved to the wrong package identity.

## 1. Bootstrap the setup command

Install the Intercom control plane and Orchestrator if they are not already available:

```bash
pi install npm:@dataforxyz/agent-intercom-pi
pi install npm:@dataforxyz/agent-intercom-orchestrator
```

The Orchestrator package exposes `agent-intercom-boss-setup`. If your Pi package installation does not place package bins on `PATH`, invoke the package's `src/boss-setup-cli.mjs` with Node from its resolved Pi package directory.

Do not run a broad update to “fix” an existing Git checkout. Preserve local changes first, and change a pin only after reviewing that source choice explicitly.

## 2. Inspect before changing anything

```bash
agent-intercom-boss-setup --check
agent-intercom-boss-setup --plan
agent-intercom-boss-setup --plan --json
```

`--check` inventories the required stack. `--plan` also shows exact missing-resource install commands and whether onboarding values were supplied. Both modes are read-only. A nonzero exit means the stack is not ready; read each diagnostic rather than treating it as permission to replace the install.

The planner understands string and object-valued entries in `~/.pi/agent/settings.json`, including `extensions` filters. Required packages are global Pi resources; project-local package configuration is not sufficient for a Boss Controller or its participants.

## 3. Choose role preferences and a handle prefix

Onboarding requires one explicit Pi model identifier and supported effort for every baseline role:

- **Manager** — supervises the goal and integrates evidence.
- **Worker** — performs the implementation assignment.
- **Scout** — independently inspects the workspace and missing evidence.
- **Adversary** — challenges the latest proof before approval or rejection.

Valid efforts are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; the selected model must actually support the effort. Model identifiers cannot contain wildcards. The handle prefix must be 1–32 lowercase letters, digits, or internal dashes and cannot begin or end with a dash.

Discover live Pi models before choosing:

```typescript
agent_fleet({ action: "models", harness: "pi" })
```

Example preview—replace every model and effort with choices available in your Pi installation:

```bash
agent-intercom-boss-setup --plan \
  --handle-prefix boss \
  --manager-model provider/manager-model --manager-effort high \
  --worker-model provider/worker-model --worker-effort high \
  --scout-model provider/scout-model --scout-effort medium \
  --adversary-model provider/adversary-model --adversary-effort max
```

These preferences are stored under the canonical `boss.roles` and `boss.handlePrefix` fields in `~/.pi/agent/intercom/orchestrator/config.json`. Completion is recorded as versioned onboarding metadata. Setup writes those Boss fields atomically and preserves unrelated or unknown configuration.

Boss currently launches all four roles as independent Pi peers because Pi is the adapter with the exact team contract. A role's model may still select any provider exposed through Pi. The role preferences do not alter ordinary `agent_fleet` routing defaults.

## 4. Apply the reviewed plan

Interactive apply prints the plan and requires typing `yes`:

```bash
agent-intercom-boss-setup --apply \
  --handle-prefix boss \
  --manager-model provider/manager-model --manager-effort high \
  --worker-model provider/worker-model --worker-effort high \
  --scout-model provider/scout-model --scout-effort medium \
  --adversary-model provider/adversary-model --adversary-effort max
```

For an already reviewed noninteractive transaction, add `--yes`. This is confirmation, not an override: blockers still fail closed. Apply installs only missing recognized resources, verifies the complete stack afterward, then writes onboarding configuration. Reapplying identical choices is configuration-idempotent.

Setup may add these unpinned Git sources when they are missing:

```bash
pi install git:github.com/dataforxyz/agent-intercom-pi
pi install git:github.com/dataforxyz/agent-intercom-orchestrator
pi install git:github.com/dataforxyz/pi-extensions
pi install git:github.com/dataforxyz/pi-return-on
```

If you intentionally use an object entry for `pi-extensions`, its `extensions` filter must include `pi-ralph-wiggum/index.ts`. Return On must expose `src/index.ts`.

## 5. Reload and run readiness diagnostics

Reload every open Controller Pi session after package changes. Then run:

```text
/reload
/boss plan
/boss doctor
```

The LLM-callable equivalents are:

```typescript
boss({ action: "plan" })
boss({ action: "doctor" })
```

`plan` is the read-only package/setup inventory. `doctor` composes that inventory with live host, Controller Intercom, onboarding, model-catalog, and writable state-root checks. It verifies:

- the four required global package resources and entrypoints;
- systemd user-manager responsiveness;
- the active Controller's Agent Intercom identity;
- complete versioned onboarding and all role preferences;
- configured model presence when Pi provides live model enumeration;
- writable Boss, worker, Ralph, and Return On state roots.

If Pi cannot enumerate models, doctor reports a warning instead of claiming the models were verified. If Pi does return a catalog and a configured role model is absent, readiness is blocked. `boss create` runs the same readiness gate before writing a trusted-local run.

## 6. First-run smoke

Create a small bounded goal from the top-level Controller:

```text
/boss create Inspect this repository, make no edits, and report one independently verified readiness observation.
/boss status
```

Or use the tool:

```typescript
boss({ action: "create", goal: "Inspect this repository, make no edits, and report one independently verified readiness observation." })
boss({ action: "status" })
```

When the goal has concrete execution needs, declare them on the tool call instead of relying on goal-text inference:

```typescript
boss({
  action: "create",
  goal: "Implement and verify the requested change in the assigned worktree.",
  needs: ["worktree", "edit", "test"],
})
```

The optional values are `worktree`, `edit`, `test`, and `git-transport`. Boss checks them before persisting a run. It verifies linked-worktree metadata, reports edit/test access as configured policy rather than proof of successful work, and reports Git transport as a gap because remote reachability, credentials, and write authority are not verified at create time. `BOSS_CAPABILITY_GAP` means no run or participant was created. The successful structured result includes `details.capabilityReport`; `/boss create` remains the goal-only interactive shorthand.

A run displays both a deterministic `<prefix>-<base32-digest>` handle and its exact `boss-...` run ID. Later commands accept either value; mutation results continue to show the exact ID. Multiple nonterminal trusted-local runs may coexist, but each remains owned by its exact creating Controller session.

Status deliberately separates process/transport lifecycle from communication and substantive work. A participant may be `ready` while no authenticated communication has been observed. Each assigned role shows a ten-minute authenticated-communication deadline and becomes `authenticated-communication-stale` if the exact owned WorkerStore incarnation has produced no later authenticated Intercom traffic. Manual lease renewal and adoption update general lifecycle timing but not this dedicated evidence timestamp. Assignment acknowledgement, authenticated communication, and substantive typed checkpoints are reported separately: the timestamp proves communication only, while acknowledgement and substantive-checkpoint telemetry remain explicitly unavailable.

Boss injects the verified Intercom, Orchestrator, Ralph, and Return On extensions into each participant. Return On uses a separate `PI_RETURN_ON_STATE_DIR` for every run and role so participants do not share watcher state.

After the smoke, inspect the selected run and cancel it if it should not continue:

```text
/boss status <handle-or-exact-run-id>
/boss cancel <handle-or-exact-run-id> smoke complete
```

## Troubleshooting

- **Dirty Git checkout:** commit, stash, or separately preserve it. Setup will not reset or replace it.
- **Pinned source:** readiness remains blocked for deliberately pinned Git or npm package entries. Review and explicitly change the package entry yourself if moving the pin is intended; setup never moves or overrides it.
- **Duplicate source:** keep one deliberate global package entry; setup will not choose for you.
- **Filtered object entry:** preserve the object and add only the required extension path.
- **Model warning:** use `agent_fleet({ action: "models", harness: "pi" })`; do not infer availability from provider marketing names.
- **Unresponsive user manager:** check `systemctl --user` health and the user session environment before retrying.
- **No Controller Intercom identity:** verify `agent-intercom-pi`, reload Pi, and confirm the current top-level session is connected.
- **State path failure:** correct ownership/permissions for the reported path; do not run Boss or Pi as root.

See [`boss-trusted-local-v1.md`](boss-trusted-local-v1.md) for the advisory evidence and lifecycle contract.

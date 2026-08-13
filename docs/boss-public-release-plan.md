# Orc Boss public release plan

Status: implementation-ready after independent `claude/claude-fable-5` max review and resolution of its blocking findings. This plan covers the trusted-local Orc Boss implementation only. The protected-service design remains deferred and must not be implied by setup or diagnostics.

## Release target

Ship trusted-local Boss as a supported surface of the public `@dataforxyz/orcboss` Pi package, using only Pi's public package, extension, command, tool, model-registry, UI, and settings surfaces. No Pi internal patch is required.

Every setup, diagnostic, status, proof, and documentation surface must retain this statement:

> TRUSTED LOCAL MODE — same-user agents and local files are trusted; evidence is advisory, not tamper-proof.

## Audit findings

### Current package and release state

- Boss is implemented in this public repository; there is no separate Boss package or repository.
- `main` contains concurrent Controller-owned runs, the LLM-callable `boss` tool, active Ralph supervision, and participant wake behavior after the `v0.10.0` tag.
- `package.json`, npm `latest`, and the newest Git tag are still `0.10.0`; the unreleased Boss work therefore is not installable from the documented npm release.
- The README still recommends Git pins at `v0.9.3`, which predates Boss entirely.
- The package already exports its extension and Agent Skill through the public `pi` manifest. Boss can remain in that package; Pi internals do not need modification.
- Current Pi package documentation says Pi-owned runtime imports (`@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox`) belong in `peerDependencies` with `"*"`. This repository currently places four of them in `dependencies`, and its package test enforces that now-obsolete arrangement.

### Required and optional runtime boundaries

Required supported Boss stack:

1. Pi CLI/runtime and a trusted installation of this Orchestrator package.
2. `@dataforxyz/agent-intercom-pi` for Controller/participant communication and wake delivery.
3. `@tmustier/pi-ralph-wiggum` or the recognized `pi-extensions/pi-ralph-wiggum` Git resource for participant supervision.
4. `pi-return-on` from the public `dataforxyz/pi-return-on` Git repository for the supported external-wait/wake runtime. Its package manifest is intentionally unpublished/private, so setup must install and update the recognized Git source rather than claim npm availability.
5. Linux systemd user services, systemd 257 or newer for hardened profiles, and `/usr/bin/bwrap`.

Optional:

- Codex, Claude Code, and OpenCode CLIs and their Agent Intercom adapters remain optional for ordinary fleet use. Trusted-local Boss participants are currently forced onto Pi because only the Pi adapter implements the exact team-scoping contract.
- Custom model providers, `models.json`, auth, themes, unrelated packages, and ordinary role presets are user-owned configuration and must not be rewritten.

Current gaps:

- Boss launch resolves Agent Intercom Pi and Ralph by a small hard-coded cache-path list, but setup does not verify package settings, resource enablement, Git cleanliness, pins, versions, or Return On.
- Return On is neither detected by `versions`/`doctor` nor injected into Boss participant launches. Its installed repository can be dirty, so an updater must refuse replacement or reset rather than silently repairing it. The extension supports per-process isolation through `PI_RETURN_ON_STATE_DIR`, so each Boss participant can receive a private state root.
- `inspectAdapterFamily` only understands string-valued Pi package entries. Pi settings also support object package entries, which must be inspected without dropping filters or unrelated fields.
- The existing updater is preview-first and source-aware for the five Intercom packages, but Ralph and Return On are outside its inventory.
- No unified pre-install command exists. Existing `/boss` and the `boss` tool assume the extension is already loaded.

### Configuration and routing

- Canonical Boss presets currently hard-code Manager, Worker, Scout, Adversary, and Council model/effort tuples in `src/routing.ts`.
- Trusted-local participants all launch on Pi, so these values are Pi model identifiers at launch even when the symbolic preset's nominal harness is Codex or Claude. Setup must validate the effective Pi model catalog, not merely the nominal harness catalog.
- Current configuration merging preserves user fields generally, protects symbolic Boss routing order from arbitrary `routing.roles` replacement, and allows explicit role model/effort overrides through `roles`.
- There is no Boss-specific onboarding record, no distinction between package defaults and user-confirmed preferences, and no preferred stable display handle for a run.
- Worker IDs are deterministic from the random run UUID suffix, but user-facing run handles are raw UUID-derived IDs. A deterministic handle should be generated from immutable run identity and stored once; it must never be recomputed from mutable goal text or used instead of the exact run ID for authority checks.

### Superseded governance boundary

- Historical planning records in `docs/boss-workflow-implementation-plan.md` and `docs/boss-workflow-approval-record.md` declared Ralph and Return On out of scope and stated that making them runtime/preflight/release dependencies would violate that boundary.
- Subsequent user direction explicitly supersedes that boundary: Ralph and Return On are required parts of the supported Orc Boss stack. Current code already hard-requires Ralph for participant launch.
- Implementation must add a dated supersession note to those historical records (without rewriting their original decision history), add the decision to the public release documentation, and replace the stale `src/config.ts` diagnostic claiming Orc does not recommend or install Ralph or Return On.
- Because `docs/**` ships in the npm tarball, package-content validation must ensure the supersession note accompanies the historical records so public documentation is not self-contradictory.

### Documentation drift

- `docs/boss-trusted-local-v1.md` incorrectly says only one nonterminal trusted-local run is allowed.
- README coverage is brief and lacks required-stack installation, preflight semantics, onboarding, failure handling, and a complete approval/rejection example.
- The bundled Agent Skill installs only Intercom Pi plus Orchestrator and does not describe Ralph or Return On as required Boss dependencies.
- Examples and changelog do not present a share-ready Boss configuration or release migration.

### Pi public APIs checked

- Pi packages support npm, Git, and local sources in global/project settings, package filters, pins, and source-specific update behavior.
- Extensions can provide commands/tools and interactive setup through `ctx.ui`, inspect `ctx.modelRegistry`, and reload through `ctx.reload()`.
- Runtime package imports must follow Pi's documented peer dependency contract.
- Model onboarding can enumerate the existing registry; it does not need to alter `models.json`, providers, auth, or the active Controller model.

## Implementation plan

### 1. Add a standalone, preview-first Boss setup entrypoint

Add a public binary, `agent-intercom-boss-setup`, that works before the Pi extension is loaded. It should share pure planning/apply code with `/boss setup` and `/boss doctor` after installation.

Modes:

- `agent-intercom-boss-setup --check`: read-only machine/package/config diagnostics.
- `agent-intercom-boss-setup --plan`: print exact proposed package/settings/config changes; default when no apply flag is given.
- `agent-intercom-boss-setup --apply`: apply only the previously displayed safe plan, with a final confirmation when interactive.
- `agent-intercom-boss-setup --json`: stable machine-readable diagnostics and plan output.

The in-Pi `/boss setup` command may use `ctx.ui.select`, `confirm`, and `input` for model/effort/handle preferences, then show the same plan before applying. The LLM-callable `boss` tool will expose read-only `doctor` and `plan` actions only; it will not apply package or configuration changes. Mutation stays in the standalone binary and direct interactive command.

The packaged bin will remain a small `.mjs` launcher, matching existing bins, and re-exec the shared TypeScript CLI/planner with the supported Node `--experimental-strip-types` runtime. Tests must exercise the packed launcher, not only direct TypeScript imports.

### 2. Build a general resource inventory and safe source policy

Represent required resources uniformly: Intercom Pi, Orchestrator, Ralph, and Return On. For each, report:

- expected package/resource identity, optional monorepo subpath, and accepted npm/Git locations;
- configured global source spec and package filter state;
- resolved root, manifest name/version, extension entrypoint, and loadability;
- Git branch/ref, pin state, dirty state, upstream relationship, and fast-forward eligibility;
- npm installed/latest version where publicly published;
- exact safe install/update command or a blocking reason.

Rules:

- Preview by default.
- Never replace a recognized Git install with npm.
- Never reset, clean, checkout, pull, or overwrite a dirty Git install.
- Never move an explicit tag/commit/version pin without a separately acknowledged pin change.
- Never rewrite an object package entry into a string or discard filters/autoload metadata.
- Refuse ambiguous duplicate sources until the user chooses one.
- Treat Return On's current private/unpublished manifest honestly: require its public recognized Git source and do not claim npm availability.
- Orc Boss requires global Pi package installation because participant launches use `--no-extensions` plus verified global extension paths. Project-local `.pi/settings.json`, `.pi/npm`, and `.pi/git` resources do not satisfy Boss readiness; diagnostics must report that boundary clearly while leaving project settings untouched.
- Model Ralph as the `pi-extensions` repository plus the `pi-ralph-wiggum/index.ts` subpath rather than as an independent repository identity.
- Distinguish Controller resource enablement/filtering from participant explicit injection: Controller diagnostics inspect enabled tools/commands, while participant launch verifies and passes exact extension paths regardless of ambient filters.
- Never recommend `pi update --all` or `pi update --extensions` when any required-stack Git checkout is dirty. Warn that Pi's own Git reconciliation resets and cleans clones, so users must resolve or preserve dirty work before invoking those commands themselves.
- Verify the post-apply root, manifest, entrypoint, settings entry, and loaded tool/command inventory.

### 3. Correct package metadata

- Move Pi-owned packages and `typebox` to `peerDependencies: { "*" }` per current Pi package documentation.
- Keep `@dataforxyz/agent-intercom-core` pinned to the reviewed Git commit in `dependencies` and add it to `bundledDependencies`. It is not published on npm; bundling gives npm consumers deterministic offline package contents without requiring a Git fetch during Orchestrator installation. Tarball inspection must verify the bundled manifest, license, and imported runtime files.
- Update the dependency test to assert the documented peer contract, the exact bundled Core dependency, and packed production contents.
- Add the setup binary to `bin` and ensure every required source file is in `files`.

### 4. Add Boss-specific preferences without overwriting user configuration

Add a versioned `boss` configuration section to Orchestrator config, merged field-by-field:

```json
{
  "boss": {
    "roles": {
      "manager": { "model": "...", "effort": "high" },
      "worker": { "model": "...", "effort": "medium" },
      "scout": { "model": "...", "effort": "low" },
      "adversary": { "model": "...", "effort": "xhigh" }
    },
    "handlePrefix": "boss"
  }
}
```

Semantics:

- The new `boss.roles` section is the canonical Orc Boss preference surface. Explicit `boss.roles.<role>` values win; legacy explicit `roles.<role>.model/effort` values are used as migration inputs; package presets are suggestions only.
- Setup proposes copying legacy effective values into the Boss section, or asks the user to choose from the current Pi model registry and supported efforts. It never changes the legacy role keys implicitly.
- Model onboarding is mandatory before the first `create`. The shipped private/development model IDs are not public defaults and must not silently pass readiness. Setup must obtain user-confirmed, currently available/authenticated Pi models and supported efforts for Manager, Worker, Scout, and Adversary.
- `scout-medium` inherits the confirmed Scout model and may raise effort to the configured escalation value. Council presets remain optional advanced fleet roles outside the baseline trusted-local four-participant team and retain their independent configuration unless later onboarded explicitly.
- Applying a plan changes only keys displayed in the plan. Use atomic write/rename and preserve unknown/unrelated config keys.
- Do not modify Pi `settings.json` except required package entries explicitly accepted in the plan. Never alter providers, auth, `models.json`, active model, theme, or unrelated packages.

### 5. Add deterministic human-readable handles

- Keep `bossRunId` as the sole exact authority/ownership identifier.
- Generate a stable handle once from immutable inputs, for example `<sanitized-prefix>-<base32(sha256(bossRunId))[0:10]>`.
- Persist the handle in the run record and enforce uniqueness within the store.
- Display handles in lists/status and accept them only as convenience lookup aliases; ambiguous or unknown aliases fail closed and exact IDs remain in every mutation result.
- Migrate legacy runs by assigning handles under the store lock without changing run IDs or proof correlations.

### 6. Add trusted-local preflight and diagnostics

Create a separate trusted-local readiness report; do not reuse the protected-service `boss-preflight.ts` terminology or evidence claims.

Before `create`, fail closed with actionable checks for:

- explicit trusted-local acknowledgement in the command/tool flow;
- required stack installed, enabled, loadable, and not ambiguously duplicated;
- Pi runtime, Node engine, systemd user manager/version, and Bubblewrap;
- Intercom connectivity and Controller target;
- Ralph and Return On extension/tool availability, public recognized sources, and private participant-state roots;
- a completed versioned onboarding record plus effective role models present/authenticated and requested efforts supported;
- writable private state/runtime locations and clean schema migration;
- no unsafe pending setup plan.

Diagnostics should distinguish `ready`, `warning`, and `blocked`, include exact remediation, and never call advisory evidence attestation.

### 7. Integrate Return On deliberately

- Resolve and load Return On for supported Boss participants through the same verified resource inventory rather than relying on ambient global autoload.
- Permit only the non-exec Return On operations required for bounded process/file/port/url/timer waits. Exec conditions remain unavailable unless the user separately grants them.
- Keep Intercom inbound wake as the Manager's report-wake path; Return On is for external state waits, never conversational polling.
- Set `PI_RETURN_ON_STATE_DIR` to a role- and run-specific directory below the participant's private runtime root; Return On already supports that isolation contract.
- Treat safe Return On injection and isolation as a release blocker. The required use case is bounded waiting on builds, tests, files, processes, ports, URLs, and timers without busy polling; it does not replace Intercom report wake.

### 8. Tests and validation

Focused tests:

- inventory parsing for string/object sources, global/project scope, filters, pins, dirty Git, duplicate installs, monorepo subpaths, missing entrypoints, and unpublished resources;
- preview/apply idempotence and exact-config preservation;
- Boss preference precedence and model/effort validation;
- deterministic handle creation, migration, uniqueness, and alias lookup;
- trusted-local preflight failure codes/remediation;
- Ralph/Return On participant extension/tool injection and isolation, plus actionable fail-closed errors when either is missing;
- stable setup `--json` schema snapshots and packed `.mjs` launcher execution;
- packed-tarball assertions that governance supersession notes ship with historical records;
- outdated concurrency documentation regression checks where practical.

Release gates:

1. `npm run typecheck`.
2. Focused setup/config/Boss tests.
3. Full `npm test`.
4. `npm pack --dry-run` and tarball inspection.
5. Clean temporary Pi agent directory install using the packed tarball plus recognized required-stack sources.
6. Setup plan/apply/idempotence smoke, including dirty and pinned refusal cases.
7. Live Boss create/status/pause/resume/proof/review/cancel smoke with at least two concurrent runs and verified participant wake.
8. Independent final Fable 5 max review with all findings resolved.
9. Commit, push, PR, green CI, merge, and only then an authorized coordinated version/tag/npm release.
10. Verify the published npm version, `latest` dist-tag, provenance, GitHub release/tag, installed checkout update, `/reload`, and final live diagnostics.

## Documentation and release changes

- Rewrite README installation around ordinary Orchestrator use versus the required Boss stack.
- Correct Git pin examples to the release being shipped.
- Update `docs/boss-trusted-local-v1.md` for concurrent runs, setup, handles, diagnostics, Ralph/Return On, and exact limitations.
- Add explicit dated supersession annotations to the historical workflow plan and approval record, and update the stale config migration diagnostic.
- Add a dedicated installation/onboarding guide and a complete example Boss config.
- Update the bundled Agent Skill with required-stack checks and preview/apply guidance.
- Add changelog entries and a release checklist describing coordinated dependency versions, package contents, CI, tag, npm provenance, installed-checkout update, and `/reload` verification.

## Independent plan review

A read-only Pi coworker running `claude/claude-fable-5` at `max` reviewed this plan against the repository and current Pi documentation. It found the audit accurate but initially rated the plan not implementation-ready because of four blockers:

1. the plan omitted the historical Ralph/Return On no-change governance boundary;
2. Return On's required status lacked a publication and isolation decision;
3. private development model IDs could not serve as fresh-install defaults;
4. setup mutation authority, configuration placement, Core packaging, and release version were left as open prerequisites.

The reviewer also requested dirty-clone warnings for Pi's own reconciliation commands, an explicit global-versus-project scope, Ralph monorepo-subpath handling, baseline-versus-Council role coverage, a concrete `.mjs` launcher strategy, and additional tarball/error/JSON tests. The sections above incorporate each finding.

## Resolved design decisions

1. Ralph and Return On are required by explicit later user direction, superseding the earlier no-change boundary. Historical records remain available but must be annotated.
2. Return On is installed from its confirmed public GitHub repository and isolated per participant with `PI_RETURN_ON_STATE_DIR`; safe integration is a release blocker.
3. The LLM-callable `boss` tool is doctor/plan-only for setup. Apply remains a direct-user binary or interactive command operation.
4. `boss.roles` plus a versioned onboarding record is the canonical preference surface; legacy role settings are preserved and used only as proposed migration inputs.
5. First-run model onboarding is mandatory. No private development model identifier is treated as a public default.
6. `@dataforxyz/agent-intercom-core` remains exact-commit-pinned and is bundled in the Orchestrator tarball.
7. Orc Boss supports global required-stack package installs only; project-scoped packages do not satisfy participant readiness.
8. The release version is intentionally not chosen in the implementation plan. Version selection is a release-management decision after required repositories, compatibility, CI, review, and publish authority are confirmed.

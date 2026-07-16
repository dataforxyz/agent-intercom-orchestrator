# Changelog

## Unreleased

- Guide managers to use `intercom_send` for assignments and progress/status checkpoints, reserving `intercom_ask` for blocking decisions.
- Require managers to create sandboxed builder worktrees before spawn and pass the worktree as `cwd`.
- Reserve worker IDs atomically before launch, patch stop/renew/adopt/forget state inside the store lock, and reclaim dead-process locks without stale-snapshot resurrection or orphaned duplicate units.
- Reconcile service state before automatic lease renewal, retry persistent OpenCode startup on early port-bind exits, and reset failed systemd units even when stop escalation reports surviving descendants.

## 0.10.0 - 2026-07-16

- Put the manager Intercom target in every worker environment and standing prompt, and direct coworkers to the read-only `intercom_team` tool.
- Add `versions` and source-aware `update` actions for the coordinated adapter family, including preview-by-default execution, dirty/pinned Git safeguards, harness CLI reporting, and doctor drift warnings.
- Stop advertising `minimal` reasoning for persistent Codex coworkers because the current app-server tool set rejects that effort before a turn can run; `low` is the lowest supported level.

## 0.9.3 - 2026-07-15

- Scope `agent_fleet` list and unqualified status results to the current manager session by default, with `all: true` for explicit cross-manager diagnostics.
- Return and document direct `intercomTarget` routing so managers can message owned workers without rediscovering them through the global Intercom list.
- Update manager guidance to the split `intercom_send`, `intercom_ask`, `intercom_list`, and `intercom_status` tools.
- Coordinate the Agent Intercom family on the `0.9.3` release line.

## 0.9.2 - 2026-07-14

- Coordinate the Agent Intercom family on the `0.9.2` release line.

- Add CI for branches and pull requests.
- Make the OpenCode plugin doctor assertion portable to clean hosted runners.
- Add tag-driven npm trusted publishing with provenance and automatic GitHub Releases.

## 0.9.1 - 2026-07-14

- Publish the package under the public npm scope `@dataforxyz/agent-intercom-orchestrator`.
- Keep the Git repository and executable names unchanged.

## 0.9.0 - 2026-07-14

- Align the Agent Intercom family on one coordinated `0.9.0` release line.
- No behavior change from the immediately preceding AGPL release.

## 0.2.0 - 2026-07-14

- Changed the current project license from MIT to `AGPL-3.0-or-later`. Versions already published under MIT remain available under their original terms.

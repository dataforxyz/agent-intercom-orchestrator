# `/boss` change-plan approval record

> **CURRENT STATUS:** Revision 17 remains the fully approved base specification at SHA-256 `ee871327a61f3ec39df684e27eace1328f2f4e21b69d126fcae15cabc58c0c03`; Revision 18 remains the protected-repository/trusted-admin amendment at `600bf7bbf9f9889197e432a5e0efc46d10ca7bea197fe3c6954769053fdd957e`; and Revision 19 remains the witnessed-transparency/artifact-cardinality amendment at `38feaf5d6a3b75bec5e848a38e4496fdb082d4ece750767e7d6eed90a4fa8eb8`. Revision 20 is approved at SHA-256 `2d8395a3545159980487fdcd9eaa3aed644c88006e6523dd83455f42ed874f89` and records the user's governance decision that every review after Revision 19 uses unchanged-hash Pi Fable 5 `max` → Codex Sol `xhigh`; Opus is no longer required. These approvals create no signing, installation, elevated-action, service, runtime, or production authority.

Formerly approved artifact:

- Path: `/home/dxyz/src/github.com/dataforxyz/.agent/agent-intercom-orchestrator-boss-change-plan.md`
- Revision: 10
- SHA-256: `469137606ecc4cc19fba993509bf3a597db770cbdbcd535d292a04b48c5f29b2`
- Size at approval: 1,705 lines

Hash-bound verdicts, in required order:

1. **Opus 5 xhigh — APPROVE**
   - Verified the exact hash after four verification streams and an independent consistency sweep.
   - No blocking defects or required amendments.
2. **Fable — APPROVE**
   - Independently computed and matched the exact hash.
   - No required amendments.
3. **Sol xhigh final audit — PASS / APPROVE**
   - Verified the exact hash before and after the full read-only audit.
   - No material amendments required.

The plan file remained unchanged throughout all three operative approvals. Any material amendment invalidates this approval chain and requires Opus → Fable → Sol review again.

Before implementation, copy the exact approved plan and this approval record into a tracked issue or PR without changing the approved artifact content. Record the SHA-256 in the issue/PR.

## Revision 12 superseded approval attempt

- SHA-256: `a354ceb791a64d2c49d96444d90fd7c4c63b77f72271e58e4115c5506a9afbf2`
- Opus 5 xhigh: **APPROVE**
- Fable 5: **APPROVE**
- Sol xhigh: **NOT APPROVED**
- Sol blockers: A39 non-Pi/headless Manager delivery; A40 pre-injection wake arbitration; A41 broker/Controller authority-transition recovery; A42 same-UID Controller/admin isolation and direct-user resume authentication; A43 Boss-run versus worker-incarnation identity separation.
- Result: superseded by Revision 13; no approval carries forward.

## Revision 13 superseded approval attempt

- SHA-256: `90923e51f107971465b88c14d80d35ad2ae16992235c2b99760b74cbb2dc5068`
- Opus 5 xhigh: **NOT APPROVED**
- Closed: Sol A39, A40, A43 and Controller/direct-user portions of A41/A42.
- Blocking: B1 same-UID broker remained the authority root without endpoint/peer/substitution protection; B2 incomplete legacy WorkerState migration.
- Result: superseded by Revision 14.

## Revision 14 superseded without verdict

- SHA-256: `28e384137309a85b7899f7d9595786a155795c66793f48598bd493eba1ec0bb6`
- Opus review was stopped without verdict when the user added durable coworker subscriptions and smart activity/wait awareness.
- Result: superseded by Revision 15.

## Revision 15 superseded after Opus approval

- SHA-256: `34cf064f3587f1473a7da9637a661654eeafe7ae2910c18dd168cef01d238b8a`
- Opus 5 xhigh: **APPROVE**
- Before Fable, four non-blocking advisories were accepted: align soft-idle lease wording, coalesce same-recipient subscription/default notices, name Core subscription ownership, and require bounded external-wait `maxUntil`.
- Result: superseded by Revision 16; approval does not carry forward.

## Revision 16 superseded approval chain

- SHA-256: `591297e7cce14623f456d3b823e2c1f82223047c8f6a00ebf11ad2c617a56600`
- Opus 5 xhigh: **APPROVE** — hash verified unchanged at start/end; C1–C4 closed; no blocking findings.
- Fable 5: **APPROVE** — independently verified the exact unchanged Opus-approved hash; no blockers.
- Sol xhigh: **NOT APPROVED** — exact unchanged hash; two blockers: incomplete collision-resistant delivery-group equivalence/intent arbitration, and unspecified subscriber-epoch rebind migration.
- Result: superseded by Revision 17; Opus/Fable approvals do not carry forward.
- Scope boundary: `pi-return-on`, `pi-ralph-wiggum`, and `pi-subagents` remain **NO CHANGE** and are not required runtime, preflight, storage, notification, or release dependencies.
- Formal sequence: Opus 5 → Fable 5 on unchanged hash → Sol xhigh.

## Revision 17 active approval chain

- SHA-256: `ee871327a61f3ec39df684e27eace1328f2f4e21b69d126fcae15cabc58c0c03`
- Opus 5 xhigh: **APPROVE** — hash verified unchanged at start/end; both Sol Revision 16 blockers closed; full regression clean.
- Fable 5: **APPROVE** — independently verified the exact unchanged Opus-approved hash; full implementation-readiness audit found no blockers.
- Sol xhigh: **FINAL APPROVE** — independently verified the exact unchanged hash at start/end; both Revision 16 blockers closed; full architecture/security/lifecycle/migration/delivery/subscription/lease/proof/release audit found no blockers or required amendment.
- Closes Sol Revision 16 blocker 1 with a complete recipient/source-authority/source-event/worker-generation/transition/assignment-turn-watchdog equivalence key, subscription-registry snapshot membership sealing, normalized inactivity-edge IDs, and deterministic `wake > follow_up > status_only` arbitration.
- Closes Sol Revision 16 blocker 2 with broker-authoritative subscriber rebind reauthorization, binding-generation fencing, deterministic old↔new pending-group migration, target-ledger recovery, and exactly-once default Boss→Manager continuity.
- Scope boundary remains unchanged: `pi-return-on`, `pi-ralph-wiggum`, and `pi-subagents` are **NO CHANGE** and not required dependencies.
- Formal sequence completed on the exact unchanged hash: Opus 5 **APPROVE** → Fable 5 **APPROVE** → Sol xhigh **FINAL APPROVE**.
- Full Sol evidence: `/home/dxyz/src/github.com/dataforxyz/.agent/agent-intercom-orchestrator-boss-change-plan.sol-rev17-verdict.md`.

## Revision 18 additive amendment approval chain

- Amendment path: `docs/boss-workflow-revision-18-amendment.md`
- Repository base commit: `939f201c5ac6bdf0b0213235171f1d4299735bb5`
- Revision 17 original reviewed artifact: `/home/dxyz/src/github.com/dataforxyz/.agent/agent-intercom-orchestrator-boss-change-plan.md`
- Revision 17 tracked publication copy: `docs/boss-workflow-implementation-plan.md`
- Independently verified byte identity and Revision 17 SHA-256: `ee871327a61f3ec39df684e27eace1328f2f4e21b69d126fcae15cabc58c0c03`
- Exact-byte Revision 18 amendment SHA-256: `600bf7bbf9f9889197e432a5e0efc46d10ca7bea197fe3c6954769053fdd957e`
- Exact-byte amendment size: 5,686 bytes
- User authorization: explicit authorization to perform the Pi Opus Council review and complete the review sequence; no authorization for keys, signing, `sudo`, installation, services, system mutation, or Boss activation.
- `claude/claude-opus-5` at `max`: **APPROVE** — worker `boss-revision18-opus-r2-review` independently computed the amendment SHA-256 at review start and end, computed both Revision 17 hashes, confirmed byte identity with `cmp`, verified the repository and trusted-admin boundaries, and reported no blocking defect. The first Opus pass was **REVISE** and does not count; R1–R5 were repaired before this clean restart.
- `claude/claude-fable-5` at `max`: **APPROVE** — worker `boss-revision18-fable-review` independently computed and matched the same amendment SHA-256, both Revision 17 hashes, base commit, and unchanged worktree; independent content review found no blocker or required amendment.
- `gpt-5.6-sol` at `xhigh`: **FINAL APPROVE** — worker `boss-revision18-sol-final-review` independently matched SHA-256 with both `sha256sum` and OpenSSL, confirmed the same base and Revision 17 bytes, hostile-reviewed authority and elevated-permission language, and found no blocker, accidental authority, or required amendment.
- Sequence completed on exact unchanged amendment bytes: Pi Opus **APPROVE** → Pi Fable **APPROVE** → Codex Sol **FINAL APPROVE**.
- Amendment effect: authorizes only the documented architectural scope and governance record. It does not create or approve a trust root, signing ceremony, key, release, installer, path, UID, package, service, runtime, elevated action, or production availability.
- Still unresolved and blocking: split-view/cross-verifier equivocation policy, and artifact cardinality for each `(channel,target,version)`.
- Any change to the amendment bytes invalidates this chain and requires a new SHA-256 plus a restart at Pi Opus.

## Revision 19 trust-decisions amendment approval chain

- Amendment path: `docs/boss-workflow-revision-19-trust-decisions.md`
- Repository base commit: `08d36e1074245f67f3a3f465ef82aa58486dcb79`
- Revision 17 SHA-256: `ee871327a61f3ec39df684e27eace1328f2f4e21b69d126fcae15cabc58c0c03`
- Revision 18 SHA-256: `600bf7bbf9f9889197e432a5e0efc46d10ca7bea197fe3c6954769053fdd957e`
- Exact-byte Revision 19 amendment SHA-256: `38feaf5d6a3b75bec5e848a38e4496fdb082d4ece750767e7d6eed90a4fa8eb8`
- Exact-byte amendment size: 8,223 bytes
- User authorization: the user's broad instruction to proceed and make the reviewed design happen, followed by confirmation that the recommended defaults had already been approved, authorizes these specification decisions and this exact Council sequence only. It does not authorize keys, signing, `sudo`, installation, services, system mutation, releases, or Boss activation.
- Superseded Revision 19 candidate SHA-256 `9da0864609f24c24f438d6105386465dd2fa9c8bbd9648e650781781fc3c904b`: Opus **APPROVE**, Fable **APPROVE**, Sol **REVISE**. Sol found that a 1-of-N stateless witness policy lacked quorum intersection and cross-log continuity. No approval carries forward from that candidate.
- Repair: require one active log per trust generation; distinct witnesses counted once; witness set size `n` and threshold `t` with `2t > n`; mutually independent control domains; persisted per-log witness consistency state; verifier checkpoint and global `(channel,target)` release high-water marks; and root-authorized log transitions preserving monotonicity with no simultaneous fallback or reset.
- `claude/claude-opus-5` at `max`: **APPROVE** — worker `boss-revision19-opus-r2-review` independently matched the exact hash with `sha256sum`, OpenSSL, and Python at start/end; verified quorum intersection and the complete fail-closed authority boundary.
- `claude/claude-fable-5` at `max`: **APPROVE** — worker `boss-revision19-fable-r2-review` independently matched the exact hash at start/end with `sha256sum` and OpenSSL; verified the repaired split-view policy, exact artifact cardinality, and non-authority boundaries.
- `gpt-5.6-sol` at `xhigh`: **FINAL APPROVE** — worker `boss-revision19-sol-r2-final` independently matched the exact hash and confirmed its prior policy blocker was closed without introducing elevated, cryptographic, runtime, installation, or production authority.
- Sequence completed on exact unchanged repaired bytes: Pi Opus **APPROVE** → Pi Fable **APPROVE** → Codex Sol **FINAL APPROVE**.
- Approved policy decisions: an append-only transparency log plus independently controlled, stateful, intersecting witness quorums; and exactly one installable artifact for each `(channel,target,version)`, with SBOM/provenance/attestations/build records separately typed and digest-bound.
- Amendment effect: unblocks drafting semantic schemas and validation rules only. Production identities, algorithms, keys, trust roots, ceremony, verifier, installer, services, elevation, releases, and Boss remain unavailable.
- Any change to the Revision 19 amendment bytes invalidates this historical chain and requires review under the then-governing protocol.

## Revision 20 review-protocol amendment approval chain

- Amendment path: `docs/boss-workflow-revision-20-review-protocol.md`
- Repository base commit: `10aa89f8206085a7d63386958f158c1f39516bb5`
- Revision 17 SHA-256: `ee871327a61f3ec39df684e27eace1328f2f4e21b69d126fcae15cabc58c0c03`
- Revision 18 SHA-256: `600bf7bbf9f9889197e432a5e0efc46d10ca7bea197fe3c6954769053fdd957e`
- Revision 19 SHA-256: `38feaf5d6a3b75bec5e848a38e4496fdb082d4ece750767e7d6eed90a4fa8eb8`
- Exact-byte Revision 20 amendment SHA-256: `2d8395a3545159980487fdcd9eaa3aed644c88006e6523dd83455f42ed874f89`
- Exact-byte amendment size: 3,359 bytes
- User authorization: explicit direction to “drop the opus approval from now on; just do the other two; keep going.” This is review-governance authority only and does not authorize implementation, crypto, signing, elevation, installation, services, releases, runtime activation, or Boss.
- `claude/claude-fable-5` at `max`: **APPROVE** — worker `boss-revision20-fable-review` independently matched the amendment SHA-256 with `sha256sum` and OpenSSL, verified all predecessor hashes and chains, and found the user-directed Fable→Sol protocol coherent, non-circular, and non-operational.
- `gpt-5.6-sol` at `xhigh`: **FINAL APPROVE** — worker `boss-revision20-sol-final-review` independently matched the same exact hash and hostile-reviewed the governance override, exact tuples/order/restart, external ledger, predecessor preservation, and non-authority boundary with no blocker.
- Sequence completed on exact unchanged bytes: Pi Fable **APPROVE** → Codex Sol **FINAL APPROVE**.
- Governing effect: every amendment and review after Revision 19 uses Pi Fable 5 `max` followed by Codex Sol `xhigh`. Any byte change restarts at Pi Fable. Opus is neither required nor part of future sequences.
- Existing Revision 17, Revision 18, and Revision 19 approval chains remain valid historical records and are not retroactively changed.
- Any change to the Revision 20 amendment bytes invalidates this chain and requires restart at Pi Fable.

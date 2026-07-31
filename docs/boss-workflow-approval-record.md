# `/boss` change-plan approval record

> **CURRENT STATUS:** Revision 17 remains the fully approved base specification at SHA-256 `ee871327a61f3ec39df684e27eace1328f2f4e21b69d126fcae15cabc58c0c03`. The additive, non-operational Revision 18 amendment is Council-approved at SHA-256 `600bf7bbf9f9889197e432a5e0efc46d10ca7bea197fe3c6954769053fdd957e` by unchanged-hash Pi Opus 5 `max` → Pi Fable 5 `max` → Codex Sol `xhigh`. This approval records the separate protected-service repository and future trusted-admin boundary; it creates no signing, installation, elevated-action, service, runtime, or production authority. The two named human trust-policy decisions remain unresolved and blocking.

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

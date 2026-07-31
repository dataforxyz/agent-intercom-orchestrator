# DRAFT — Boss Workflow Revision 19 Trust Decisions

Status: **Non-operational additive amendment. It remains DRAFT until the exact frozen bytes complete the Opus → Fable → Sol review and the external ledger in §8 records that unchanged-hash sequence.**

## 1. Hash binding and scope

This amendment is bound to these exact inputs:

- repository base commit: `08d36e1074245f67f3a3f465ef82aa58486dcb79`
- Revision 17 tracked plan: `docs/boss-workflow-implementation-plan.md`
- Revision 17 SHA-256: `ee871327a61f3ec39df684e27eace1328f2f4e21b69d126fcae15cabc58c0c03`
- Revision 18 amendment: `docs/boss-workflow-revision-18-amendment.md`
- Revision 18 SHA-256: `600bf7bbf9f9889197e432a5e0efc46d10ca7bea197fe3c6954769053fdd957e`

Revision 17 and Revision 18 remain unchanged. This document resolves only the two human policy decisions left open by Revision 18 §5. It is an additive semantic-policy amendment, not a replacement plan, production activation, or implementation authorization.

## 2. Authorization recorded

The user's prior broad authorization to proceed, followed by confirmation that the recommended defaults had already been approved, resolves both defaults below for specification drafting. This records a governance decision only. Conversational authorization is not cryptographic release evidence and must not be extended into signing, privileged, runtime, installation, or production authority.

## 3. Transparency-log and independent-witness default

Future release acceptance requires an append-only transparency log and a threshold of at least one independently controlled witness.

The semantic acceptance contract is:

1. Versioned trust metadata, never a manifest, caller, or runtime choice, pins exactly one active log authority for each trust generation, a nonempty finite set of eligible witness authorities, and a witness threshold `t`. If the set contains `n` witnesses, `1 <= t <= n` and `2t > n`; therefore any two threshold-satisfying quorums intersect.
2. Each distinct witness authority may count at most once. The log authority, every counted witness authority, and the release signer must be controlled in mutually independent domains.
3. Acceptance binds the exact canonical manifest digest and exact release tuple to an inclusion proof under the active log's presented checkpoint.
4. The verifier persists both the active-log checkpoint/tree-size high-water mark and a global monotonic release-sequence high-water mark for each `(channel,target)` scope. Neither may regress. A checkpoint advance must carry a valid consistency proof from the previously accepted checkpoint when one exists.
5. Every eligible witness is stateful for each active log: before authorizing a checkpoint it must persist its last authorized checkpoint and verify that the candidate is a monotonic, consistency-proven extension. A witness must refuse an inconsistent fork. Threshold evidence must contain distinct witness authorizations over the exact active-log identity, checkpoint, tree size, and root digest; evidence for another log or checkpoint cannot be substituted.
6. An active-log change requires a root-authorized trust-generation transition that binds the old log's final accepted checkpoint, the new log's identity and initial checkpoint, and the preserved global release high-water state. There is no manifest-selected log, simultaneous active-log fallback, or reset of release monotonicity during rotation.
7. Missing, stale, regressing, inconsistent, insufficiently witnessed, non-intersecting, or otherwise ambiguous evidence fails closed.

Exact production log and witness identities, keys, endpoints, eligible-set size and intersecting threshold above these constraints, custodians, freshness windows, and bootstrap or rotation record encodings remain signing-ceremony or semantic-schema decisions. None is selected or implied here.

## 4. Installable-artifact cardinality default

There must be exactly one installable artifact for each `(channel,target,version)` tuple. A manifest may cover multiple targets, but acceptance for a requested tuple requires exactly one installable match for that tuple.

SBOMs, provenance, attestations, build recipes, toolchains, and builder records are separately typed, digest-bound evidence. They are never installable artifacts and never alternative matches for the requested tuple.

Zero installable matches, multiple installable matches, type confusion, or any other ambiguous selection fails closed.

## 5. Effect and non-authority

These two decisions unblock drafting their semantic schemas and validation rules. They do not approve or implement cryptography, algorithms, formats, trust roots, keys, signing or other ceremony, production identities, a verifier, an installer, `sudo`, packages, services, privileged actions, runtime activation, releases, or Boss. Production remains blocked.

## 6. Inherited Revision 17 and Revision 18 boundaries

Revision 17 §22.15 release order, unavailable errors, dormant adapters, and fail-closed boundaries remain unchanged by hash reference.

Revision 18's protected-repository and trusted-administrator boundaries remain in full force. `dataforxyz/agent-intercom-protected-service` is the only repository eligible for any future privileged packaging or service work; none belongs in Boss, model, coworker, adapter, or Orchestrator repositories. Trusted-administrator authority may be considered only for a future independently verified native package's install, update, repair, or removal lifecycle, and no such authority exists now. Boss, models, coworkers, and Orchestrator runtime must never receive or exercise it. User-writable JavaScript, repositories, and `node_modules` must never execute with `sudo`. Dedicated restricted non-login broker and Controller identities and root-owned code, policy, protected-state, and socket boundaries remain future requirements, not present-tense identities, paths, services, or readiness claims.

## 7. Exact-byte Council sequence

The default no-Claude rule remains in force. Its only permitted exception is a separately user-authorized, hash-bound Council review of this amendment's final frozen bytes, in this exact order:

1. Pi using `claude/claude-opus-5` at `max` independently computes the SHA-256, reviews, and approves the frozen bytes.
2. Pi using `claude/claude-fable-5` at `max` independently computes the SHA-256 and approves the same bytes.
3. Codex using `gpt-5.6-sol` at `xhigh` independently computes the SHA-256 and performs the final review of those same bytes.

Any byte change invalidates every prior Revision 19 review entry and restarts the sequence at Pi Opus. Review does not authorize provider execution outside that exception or confer any implementation or operational authority.

## 8. External exact-byte approval ledger

This file intentionally contains no self hash: embedding its own exact-byte SHA-256 would change the bytes being hashed. After the bytes are frozen, its SHA-256 and Council verdicts must be recorded only in the tracked append-only external ledger `docs/boss-workflow-approval-record.md`. No checkbox, verdict, or hash may be written back into this file after review begins, and no other location may substitute for the authoritative ledger.

The external ledger must record, in order:

1. repository base commit `08d36e1074245f67f3a3f465ef82aa58486dcb79`;
2. Revision 17 SHA-256 `ee871327a61f3ec39df684e27eace1328f2f4e21b69d126fcae15cabc58c0c03`;
3. Revision 18 SHA-256 `600bf7bbf9f9889197e432a5e0efc46d10ca7bea197fe3c6954769053fdd957e`;
4. the exact-byte SHA-256 of this complete Revision 19 amendment;
5. the `claude/claude-opus-5` at `max` verdict bound to an independently computed matching Revision 19 SHA-256;
6. the `claude/claude-fable-5` at `max` verdict bound to an independently computed matching Revision 19 SHA-256; and
7. the `gpt-5.6-sol` at `xhigh` verdict bound to an independently computed matching Revision 19 SHA-256.

A missing, reordered, non-approval, differently hashed, or materially qualified verdict leaves this amendment unapproved. Until the complete external ledger exists for unchanged bytes, this amendment remains a non-operational draft and production remains blocked.

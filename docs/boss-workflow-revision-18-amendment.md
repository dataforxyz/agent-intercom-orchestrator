# DRAFT — Boss Workflow Revision 18 Amendment

Status: **Non-operational amendment candidate. Approval state is determined only by the external ledger named in §7; approval never creates signing, installation, or production authority.**

## 1. Hash binding and scope

This concise amendment is bound only to these exact inputs:

- repository base commit: `939f201c5ac6bdf0b0213235171f1d4299735bb5`
- original reviewed Revision 17 artifact: `/home/dxyz/src/github.com/dataforxyz/.agent/agent-intercom-orchestrator-boss-change-plan.md`
- tracked publication copy: `docs/boss-workflow-implementation-plan.md`
- independently computed SHA-256 of each byte-identical copy: `ee871327a61f3ec39df684e27eace1328f2f4e21b69d126fcae15cabc58c0c03`

Both Revision 17 copies remain byte-for-byte unchanged. This document is an additive draft amendment, not a replacement plan and not authority to implement or operate anything. It records no approval of a topology, ceremony, trust root, package, path, UID, service readiness, or Council verdict.

## 2. Future privileged repository boundary

Subject to later exact-byte approval, `dataforxyz/agent-intercom-protected-service` is the only authorized repository for any future privileged packaging or service work. No privileged packaging or service work belongs in Boss, model, coworker, adapter, or Orchestrator repositories.

The protected-service repository is currently limited to a zero-dependency Rust, format-only candidate. It is non-privileged and has no installer, trust root, keys, service, or runtime. This draft authorizes none of those capabilities.

All adapter artifacts remain dormant candidates. Ordinary behavior remains unchanged.

## 3. Future trusted-admin boundary

Trusted administrator authorization may be considered only for a future, independently verified native package's install, update, repair, or removal lifecycle. No such authorization exists under this draft.

Trusted administrator authorization must never be granted to or exercised by Boss, models, coworkers, or Orchestrator runtime. User-writable JavaScript, repositories, and `node_modules` must never be executed with `sudo`.

Dedicated, restricted, non-login broker and Controller UIDs remain future requirements, as do root-owned code, policy, protected-state, and socket boundaries. They are requirements for a later design and verification process, not claims about current system state or approved paths, identities, packages, or services.

## 4. Hash-bound Council exception

The default no-Claude rule retains full force. Its only proposed exception is an explicit user-authorized, hash-bound Council review of the final frozen bytes of this amendment. That exception does not authorize implementation, runtime use, provider execution outside the review, or any other Claude use.

If the user explicitly authorizes that review, it must occur in this exact order:

1. Pi using `claude/claude-opus-5` at `max` independently computes the SHA-256, reviews, and approves the frozen bytes.
2. Pi using `claude/claude-fable-5` at `max` independently computes the SHA-256 and approves the same bytes.
3. Codex using `gpt-5.6-sol` at `xhigh` independently computes the SHA-256 and performs the final review of those same bytes.

Any byte change invalidates all prior review entries and restarts the sequence at Pi Opus.

## 5. Unresolved human decisions

The following decisions remain explicitly unresolved and require a human choice:

1. Split-view/cross-verifier equivocation handling: transparency, an independent witness, or neither.
2. Artifact cardinality for each `(channel,target,version)`: exactly one artifact or multiple artifacts.

Both decisions block the corresponding semantic schemas and signing ceremony. This draft chooses neither question by implication.

## 6. Inherited release and dormant boundaries

Revision 17 §22.15 release order is preserved byte-for-byte by hash reference. Every current unavailable error and every dormant boundary in the frozen Revision 17 candidate is also preserved byte-for-byte. This amendment changes, relaxes, activates, or reorders none of them.

There is no code, runtime, package, authority, installation, or service activation authorized by this draft, nor any installer, signing, key, trust-root, or privileged operation. The signing ceremony has not been performed, and production remains blocked.

## 7. External exact-byte approval ledger

This file cannot embed its own exact-byte SHA-256 without changing the bytes being hashed. Its hash and Council verdicts therefore must be recorded in the tracked append-only ledger `docs/boss-workflow-approval-record.md` after these bytes are frozen. No approval checkbox or hash value may be written back into this file after review begins, and no other file or location may substitute as the authoritative ledger.

The named external ledger must contain, in order:

1. repository base commit;
2. frozen Revision 17 candidate SHA-256;
3. exact-byte SHA-256 of this complete amendment file;
4. `claude/claude-opus-5` at `max` verdict bound to an independently computed matching amendment SHA-256;
5. `claude/claude-fable-5` at `max` verdict bound to an independently computed matching amendment SHA-256; and
6. `gpt-5.6-sol` at `xhigh` verdict bound to an independently computed matching amendment SHA-256.

A missing, reordered, non-approval, differently hashed, or materially qualified verdict leaves this amendment unapproved. Any byte change requires a new SHA-256 and restarts the sequence at Pi Opus. Until the complete external ledger exists against unchanged bytes, this amendment remains a non-operational draft and production remains blocked.

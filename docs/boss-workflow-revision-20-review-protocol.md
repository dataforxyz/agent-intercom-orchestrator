# `/boss` workflow Revision 20 — review protocol

**Status:** Non-operational review-governance amendment. It changes only the exact-byte review protocol for amendments and reviews after Revision 19 and grants no other authority.

## 1. Exact binding and scope

This amendment is bound to these exact inputs:

- repository base commit: `10aa89f8206085a7d63386958f158c1f39516bb5`
- Revision 17 tracked plan: `docs/boss-workflow-implementation-plan.md`
- Revision 17 SHA-256: `ee871327a61f3ec39df684e27eace1328f2f4e21b69d126fcae15cabc58c0c03`
- Revision 18 amendment: `docs/boss-workflow-revision-18-amendment.md`
- Revision 18 SHA-256: `600bf7bbf9f9889197e432a5e0efc46d10ca7bea197fe3c6954769053fdd957e`
- Revision 19 amendment: `docs/boss-workflow-revision-19-trust-decisions.md`
- Revision 19 SHA-256: `38feaf5d6a3b75bec5e848a38e4496fdb082d4ece750767e7d6eed90a4fa8eb8`

The exact Revision 17, Revision 18, and Revision 19 bytes and their completed approval chains remain valid and unchanged. This amendment neither reopens nor retroactively alters them.

## 2. Governing user direction

The user explicitly directed:

> “drop the opus approval from now on; just do the other two; keep going.”

This sovereign user decision supersedes Revision 19 §7 and §8 for every amendment and review after Revision 19. The quoted conversational text is governance authorization only. It is not release, cryptographic, signing, trust, or elevation evidence and must not be interpreted as broader authority.

## 3. Exact-byte review sequence

Every amendment and review after Revision 19, including this protocol-change amendment, uses this exact sequential review of frozen bytes:

1. Pi using `claude/claude-fable-5` at `max` independently computes the SHA-256, reviews the bytes, and approves them.
2. Codex using `gpt-5.6-sol` at `xhigh` independently computes the SHA-256 of the same bytes, reviews them, and final-approves them.

Any byte change invalidates all review entries for that amendment and restarts the sequence at Pi Fable. Opus approval is neither a prerequisite nor part of the sequence. This protocol-change amendment is itself authorized to use Fable → Sol, so the superseded Revision 19 sequence creates no circular Opus requirement.

## 4. External exact-byte approval ledger

This file intentionally contains no self hash. After its bytes are frozen, its SHA-256 and both verdicts must be recorded only in the tracked external ledger `docs/boss-workflow-approval-record.md`; no approval, verdict, checkbox, or self hash may be written back into this file.

The external ledger entry must bind, in order, the repository base commit, the Revision 17, Revision 18, and Revision 19 hashes above, this complete Revision 20 amendment's exact-byte SHA-256, the matching Pi Fable approval, and the matching Codex Sol final approval. A missing, reordered, non-approval, differently hashed, or materially qualified verdict leaves this amendment unapproved.

## 5. Non-authority

This amendment authorizes only the review-governance change and its exact Fable → Sol review. It does not authorize implementation, a trust root or trusted identity, keys, cryptographic or signing ceremony, release, `sudo`, installation, packages, services, system mutation, runtime activation, production use, or Boss authority. No operational action follows from it.

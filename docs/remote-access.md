# Authenticated remote Intercom

Remote access uses a broker-owned Unix endpoint distinct from the local broker:

```text
local sessions                    -> local broker.sock
remote host broker.sock over SSH  -> local remote-gateway.sock -> broker policy
```

Never forward the authoritative local `broker.sock`. A conventional `broker.sock` path may exist on the remote host for client compatibility, but its SSH target must be the distinct local `remote-gateway.sock`. Health responses are listener-stamped (`local` or `remote`) so a probe cannot mistake a raw authoritative-socket forward for the authenticated gateway.

## Compatibility check

```bash
agent-intercom-access health
```

The command succeeds only when protocol v3, `remote-access-v1`, policy semantic version `2`, and the pinned golden-vector hash all match. Tunnel supervisors must stop forwarding and must not restart a remote manager when this check fails.

## Issue a one-use enrollment

The local parent session must be connected. The credential is written directly to a private file and is not printed:

```bash
agent-intercom-access enroll \
  --parent LOCAL_SESSION_ID \
  --name remote-host/manager \
  --host remote-host \
  --output ~/.local/state/agent-intercom/remote-manager-credential.json \
  --ttl-minutes 10 \
  --can-delegate true \
  --max-depth 3 \
  --max-children 4 \
  --confirm-delegation remote-host/manager
```

Transfer that file through the protected deployment channel and set this in the remote manager service:

```bash
AGENT_INTERCOM_ACCESS_CREDENTIAL_PATH=/private/path/credential.json
```

On first connection, the client atomically replaces the enrollment token with its broker-assigned session ID, generation, and reconnect credential. Credentials must never be copied into prompts, Intercom messages, transcripts, command arguments, issue comments, or logs.

Delegation privilege is optional and requires exact human confirmation. The broker fixes the child's parent/root/host/depth and refuses requested limits wider than the parent. On the remote host, an enrolled manager can write a narrower child token without exposing either credential:

```bash
agent-intercom-access delegate \
  --credential /private/path/manager-credential.json \
  --name remote-host/lead \
  --output /private/path/lead-enrollment.json \
  --can-delegate true \
  --max-depth 3 \
  --max-children 2 \
  --confirm-delegation remote-host/lead
```

Pending child enrollments count against the parent's child limit, preventing parallel one-use tokens from bypassing the quota.

## Inspect the ownership tree

Inspection returns metadata only; it grants no messaging edge. A remote principal can inspect itself or a descendant subtree, never an ancestor, sibling, cousin, or unrelated tree:

```bash
agent-intercom-access inspect --credential /private/path/manager-credential.json
```

A local administrator may choose a subtree root explicitly:

```bash
agent-intercom-access inspect --principal BROKER_ASSIGNED_SESSION_ID
```

Inspection output excludes credential hashes and plaintext credentials. It includes assigned identity, parent/root/host, generation, policy, delegation limits, state, expiry, and current connection status.

## Adopt a subtree

Adoption is a local administrative operation and requires exact confirmation:

```bash
agent-intercom-access adopt \
  --principal SUBTREE_ROOT_ID \
  --new-parent NEW_PARENT_ID \
  --confirm SUBTREE_ROOT_ID
```

The broker atomically rewrites the subtree parent/root, increments every affected generation, cancels pending delivery and ask/reply edges crossing the old boundary, removes old delegated enrollment tokens, disconnects the subtree, and returns metadata containing the new generations. Existing reconnect secrets remain private, but their credential files must be updated to the returned generation before reconnect.

## Revoke

Revocation requires an exact confirmation value and recursively fences the selected principal:

```bash
agent-intercom-access revoke \
  --principal BROKER_ASSIGNED_SESSION_ID \
  --confirm BROKER_ASSIGNED_SESSION_ID
```

Revocation disconnects live principals, cancels pending deliveries and asks, removes replay state, increments generations, rejects reconnect, and records an audit event.

## Tunnel deployment

Install `examples/check-remote-gateway.py` on the remote host and configure `examples/secure-remote-tunnel.sh` with absolute paths. The example:

- verifies the local semantic contract before forwarding;
- forwards only `remote-gateway.sock`;
- verifies the contract again through the remote socket and requires the broker-stamped `remote` listener identity;
- drops the tunnel if the local broker becomes absent or incompatible;
- does not automatically restart the remote manager until three health samples pass.

## Canary and rollback

1. Keep the existing remote manager stopped.
2. Start the authenticated tunnel without a manager.
3. Verify remote health and prove an unenrolled process cannot register or list sessions.
4. Enroll one disposable manager directly under the local root.
5. Verify it sees only its ancestor chain and that unrelated local sessions remain hidden.
6. Delegate a lead and worker; verify ancestors communicate symmetrically while siblings and cousins remain hidden.
7. Test reconnect after a tunnel outage.
8. Revoke the manager and prove the full subtree, pending delivery, replay, and reconnect all fail.
9. Only then enroll the production remote manager.

Rollback is fail-closed: stop the authenticated tunnel and remote manager. Do not restore raw `broker.sock` forwarding. Restore the previous adapter build only after remote services are stopped; an old broker intentionally provides no `remote-gateway.sock`.

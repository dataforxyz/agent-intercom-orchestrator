# Authenticated remote Intercom

Remote access uses a broker-owned Unix endpoint distinct from the local broker:

```text
local sessions  -> broker.sock
SSH forwarding -> remote-gateway.sock -> broker policy
```

Never forward `broker.sock`. Possession of the remote socket alone does not permit registration.

## Compatibility check

```bash
agent-intercom-access health
```

The command succeeds only when protocol v3, `remote-access-v1`, policy semantic version `1`, and the pinned golden-vector hash all match. Tunnel supervisors must stop forwarding and must not restart a remote manager when this check fails.

## Issue a one-use enrollment

The local parent session must be connected. The credential is written directly to a private file and is not printed:

```bash
agent-intercom-access enroll \
  --parent LOCAL_SESSION_ID \
  --name remote-host/manager \
  --host remote-host \
  --output ~/.local/state/agent-intercom/remote-manager-credential.json \
  --ttl-minutes 10
```

Transfer that file through the protected deployment channel and set this in the remote manager service:

```bash
AGENT_INTERCOM_ACCESS_CREDENTIAL_PATH=/private/path/credential.json
```

On first connection, the client atomically replaces the enrollment token with its broker-assigned session ID, generation, and reconnect credential. Credentials must never be copied into prompts, Intercom messages, transcripts, command arguments, issue comments, or logs.

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
- verifies the contract again through the remote socket;
- drops the tunnel if the local broker becomes absent or incompatible;
- does not automatically restart the remote manager until three health samples pass.

## Canary and rollback

1. Keep the existing remote manager stopped.
2. Start the authenticated tunnel without a manager.
3. Verify remote health and prove an unenrolled process cannot register or list sessions.
4. Enroll one disposable manager directly under the local root.
5. Verify it sees only itself and its direct parent.
6. Test reconnect after a tunnel outage.
7. Revoke it and prove pending delivery, replay, and reconnect all fail.
8. Only then enroll the production remote manager.

Rollback is fail-closed: stop the authenticated tunnel and remote manager. Do not restore raw `broker.sock` forwarding. Restore the previous adapter build only after remote services are stopped; an old broker intentionally provides no `remote-gateway.sock`.

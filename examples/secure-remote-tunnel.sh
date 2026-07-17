#!/usr/bin/env bash
# Example fail-closed SSH reverse tunnel for authenticated Agent Intercom access.
set -euo pipefail

: "${AGENT_INTERCOM_REMOTE_SSH:?Set AGENT_INTERCOM_REMOTE_SSH, for example dev@100.64.0.10}"
: "${AGENT_INTERCOM_REMOTE_KEY:?Set AGENT_INTERCOM_REMOTE_KEY to the SSH private key path}"
: "${AGENT_INTERCOM_REMOTE_SOCKET:?Set AGENT_INTERCOM_REMOTE_SOCKET to an absolute remote Unix-socket path}"
: "${AGENT_INTERCOM_REMOTE_HEALTH:?Set AGENT_INTERCOM_REMOTE_HEALTH to the absolute remote health-probe path}"

REMOTE_SOCK="$AGENT_INTERCOM_REMOTE_SOCKET"
LOCAL_SOCK="${AGENT_INTERCOM_LOCAL_REMOTE_GATEWAY:-$HOME/.pi/agent/intercom/remote-gateway.sock}"
REMOTE_HEALTH="$AGENT_INTERCOM_REMOTE_HEALTH"
ACCESS_CLI="${AGENT_INTERCOM_ACCESS_CLI:-agent-intercom-access}"
SSH_BASE=(-i "$AGENT_INTERCOM_REMOTE_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=5 -o ConnectionAttempts=1)
tunnel_pid=""

cleanup() {
  if [[ -n "$tunnel_pid" ]] && kill -0 "$tunnel_pid" 2>/dev/null; then
    kill "$tunnel_pid" 2>/dev/null || true
    wait "$tunnel_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT TERM INT

# Old or incompatible brokers fail here and never receive a forwarded endpoint.
"$ACCESS_CLI" health >/dev/null
[[ -S "$LOCAL_SOCK" ]] || { echo "Authenticated remote gateway is absent: $LOCAL_SOCK" >&2; exit 1; }

ssh "${SSH_BASE[@]}" "$AGENT_INTERCOM_REMOTE_SSH" "python3 - '$REMOTE_SOCK'" <<'PY'
import errno, os, socket, stat, sys
path = os.path.expanduser(sys.argv[1])
try:
    status = os.lstat(path)
except FileNotFoundError:
    raise SystemExit(0)
if not stat.S_ISSOCK(status.st_mode):
    raise SystemExit(f"refusing to replace non-socket path: {path}")
probe = socket.socket(socket.AF_UNIX)
try:
    probe.connect(path)
except OSError as error:
    if error.errno in (errno.ECONNREFUSED, errno.ENOENT):
        os.unlink(path)
    else:
        raise
else:
    raise SystemExit(f"refusing to replace live listener: {path}")
finally:
    probe.close()
PY

ssh -NT \
  "${SSH_BASE[@]}" \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=3 \
  -o ControlMaster=no \
  -R "$REMOTE_SOCK:$LOCAL_SOCK" \
  "$AGENT_INTERCOM_REMOTE_SSH" &
tunnel_pid=$!

healthy_samples=0
while kill -0 "$tunnel_pid" 2>/dev/null; do
  if ! "$ACCESS_CLI" health >/dev/null; then
    echo "Local policy contract changed or disappeared; dropping remote tunnel" >&2
    kill "$tunnel_pid"
    break
  fi
  if ssh "${SSH_BASE[@]}" "$AGENT_INTERCOM_REMOTE_SSH" "$REMOTE_HEALTH" >/dev/null 2>&1; then
    healthy_samples=$((healthy_samples + 1))
    if [[ "$healthy_samples" -eq 3 ]]; then
      echo "Authenticated remote tunnel is healthy; manager restart may now be performed" >&2
    fi
  else
    healthy_samples=0
  fi
  sleep 2
done

wait "$tunnel_pid"

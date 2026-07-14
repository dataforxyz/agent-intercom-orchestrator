#!/usr/bin/env bash
# Start one OpenCode session as the primary Agent Intercom fleet manager.
# Install/link agent-intercom-orchestrator first so agent-intercom-fleet is on PATH,
# or uncomment AGENT_INTERCOM_FLEET_COMMAND with an absolute checkout path.

export OPENCODE_INTERCOM_FLEET=1
export OPENCODE_INTERCOM_NAME=opencode-manager
export OPENCODE_INTERCOM_SESSION_ID=opencode-manager
# export AGENT_INTERCOM_FLEET_COMMAND="$HOME/src/agent-intercom-orchestrator/src/agent-fleet-cli.mjs"

exec opencode "$@"

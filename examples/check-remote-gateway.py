#!/usr/bin/env python3
"""Fail-closed health probe for a forwarded Agent Intercom remote gateway."""
import json
import os
import socket
import struct
import sys
import uuid

# Remote clients keep their conventional broker.sock path; the tunnel must map
# it only to the broker-owned local remote-gateway.sock listener.
SOCKET_PATH = os.environ.get("AGENT_INTERCOM_REMOTE_SOCKET", os.path.expanduser("~/.pi/bridge-agent/intercom/broker.sock"))
EXPECTED_HASH = os.environ.get("AGENT_INTERCOM_POLICY_HASH", "f3b00e503631bc91123aedfbcf1df72cc9913e1893c09728b2c598f3dcdfdfe0")
request_id = str(uuid.uuid4())
request = json.dumps({"type": "health", "requestId": request_id}, separators=(",", ":")).encode()

with socket.socket(socket.AF_UNIX) as client:
    client.settimeout(2)
    client.connect(SOCKET_PATH)
    client.sendall(struct.pack(">I", len(request)) + request)
    header = client.recv(4)
    if len(header) != 4:
        raise SystemExit("remote gateway returned no health frame")
    length = struct.unpack(">I", header)[0]
    if length > 1024 * 1024:
        raise SystemExit("remote gateway health frame is oversized")
    payload = bytearray()
    while len(payload) < length:
        chunk = client.recv(length - len(payload))
        if not chunk:
            raise SystemExit("remote gateway health frame was truncated")
        payload.extend(chunk)

response = json.loads(payload)
contract = response.get("remoteAccess") or {}
if not (
    response.get("type") == "health_ok"
    and response.get("requestId") == request_id
    and response.get("protocol") == "pi-intercom"
    and response.get("version") == 3
    and response.get("endpoint") == "remote"
    and contract.get("feature") == "remote-access-v1"
    and contract.get("policySemanticsVersion") == 2
    and contract.get("policySemanticsHash") == EXPECTED_HASH
):
    raise SystemExit("remote gateway policy contract is absent or incompatible")

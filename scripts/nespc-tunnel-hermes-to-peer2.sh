#!/usr/bin/env bash
# On nespc: expose local Hermes :8788 on Oracle peer2 as 127.0.0.1:18788
# so wpkn-guardian on peer2 can use HERMES_ALERT_URL=http://127.0.0.1:18788
set -euo pipefail

PEER2_HOST="${PEER2_HOST:-130.162.242.213}"
PEER2_USER="${PEER2_USER:-ubuntu}"
KEY="${PEER2_KEY:-$HOME/Projects/Hermes/private/flareon/keys/peer2/peer2.key}"
LOCAL_HERMES_PORT="${LOCAL_HERMES_PORT:-8788}"
REMOTE_BIND_PORT="${REMOTE_BIND_PORT:-18788}"

exec autossh -M 0 -N \
  -o "ServerAliveInterval=30" \
  -o "ServerAliveCountMax=3" \
  -o "ExitOnForwardFailure=yes" \
  -o "StrictHostKeyChecking=accept-new" \
  -i "$KEY" \
  -R "127.0.0.1:${REMOTE_BIND_PORT}:127.0.0.1:${LOCAL_HERMES_PORT}" \
  "${PEER2_USER}@${PEER2_HOST}"

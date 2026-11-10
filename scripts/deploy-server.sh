#!/usr/bin/env bash
# Deploy Ritual to a Docker host over SSH.
#
#   HOST=user@server DEST=/home/user/ritual ./scripts/deploy-server.sh
#
# Optional local settings can live in .deploy.env (gitignored):
#   HOST=user@server
#   DEST=/home/user/ritual
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "$ROOT/.deploy.env" ]; then
  # shellcheck disable=SC1091
  . "$ROOT/.deploy.env"
fi

HOST="${HOST:-user@your-server}"
DEST="${DEST:-/home/user/ritual}"

echo "→ syncing to $HOST:$DEST"
ssh "$HOST" "mkdir -p '$DEST/data'"
rsync -az --delete \
  --exclude 'data/' \
  --exclude 'node_modules/' \
  --exclude '.git/' \
  --exclude '.env' \
  --exclude '.deploy.env' \
  --exclude 'compose.override.yaml' \
  --exclude '.DS_Store' \
  "$ROOT/" "$HOST:$DEST/"

if ! ssh "$HOST" "test -f '$DEST/.env'"; then
  echo "error: $DEST/.env is missing on $HOST" >&2
  echo "create it from .env.example first (see README)" >&2
  exit 1
fi

echo "→ building and starting"
ssh "$HOST" "cd '$DEST' && docker compose up -d --build --force-recreate && docker compose ps"

URL_HOST="${HOST#*@}"
echo "→ http://$URL_HOST:4322"

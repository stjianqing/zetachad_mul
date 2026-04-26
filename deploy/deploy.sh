#!/usr/bin/env bash
# Usage:
#   VPS_HOST=root@87.99.158.208 ./deploy/deploy.sh
#
# What it does:
#   1. rsyncs server/ and client/ to /srv/zetachad/ on the VPS
#   2. installs server prod deps
#   3. runs migrations
#   4. restarts the systemd unit
#
# Requires: ssh access, the zetachad user on the VPS, /etc/zetachad/env in place.

set -euo pipefail

: "${VPS_HOST:?Set VPS_HOST, e.g. root@87.99.158.208}"
REMOTE_DIR=${REMOTE_DIR:-/srv/zetachad}

echo "==> Syncing server/ to $VPS_HOST:$REMOTE_DIR/server/"
rsync -az --delete \
  --exclude node_modules --exclude .env --exclude test \
  ./server/ "$VPS_HOST:$REMOTE_DIR/server/"

echo "==> Syncing client/ to $VPS_HOST:/var/www/zetachad/client/"
rsync -az --delete \
  ./client/ "$VPS_HOST:/var/www/zetachad/client/"

echo "==> Installing prod deps + migrating + restarting"
ssh "$VPS_HOST" "set -euo pipefail
  cd $REMOTE_DIR/server
  sudo -u zetachad npm ci --omit=dev
  sudo -u zetachad node --env-file=/etc/zetachad/env src/db.js
  sudo systemctl restart zetachad
  sudo systemctl status zetachad --no-pager | head -n 20
"
echo "==> Done"

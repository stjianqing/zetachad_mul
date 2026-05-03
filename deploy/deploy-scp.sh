#!/usr/bin/env bash
# Fallback deploy using scp instead of rsync.
# Use this when rsync is not available (e.g. Git Bash on Windows).
#
# Usage: VPS_HOST=root@1.2.3.4 ./deploy/deploy-scp.sh

set -euo pipefail

: "${VPS_HOST:?Set VPS_HOST, e.g. root@87.99.158.208}"

# scp -r footgun: when the destination directory already contains a child with
# the same name as a source, scp -r copies INTO that child instead of replacing
# it (e.g., `scp -r foo dest/` writes to dest/foo/foo on a second run).
# To avoid this, we delete the target subdirs on the remote before copying.

echo "==> Ensure remote dirs"
ssh "$VPS_HOST" "mkdir -p /srv/zetachad/server /var/www/zetachad/client /var/www/zetachad/admin"

echo "==> Sync server"
ssh "$VPS_HOST" "rm -rf /srv/zetachad/server/src /srv/zetachad/server/migrations"
scp -q server/package.json server/package-lock.json "$VPS_HOST:/srv/zetachad/server/"
scp -r -q server/src "$VPS_HOST:/srv/zetachad/server/src"
scp -r -q server/migrations "$VPS_HOST:/srv/zetachad/server/migrations"

echo "==> Sync client (non-admin)"
ssh "$VPS_HOST" "rm -rf /var/www/zetachad/client/css /var/www/zetachad/client/js"
scp -q \
  client/index.html \
  client/leaderboard.html \
  client/login.html \
  client/play.html \
  client/practice.html \
  client/register.html \
  "$VPS_HOST:/var/www/zetachad/client/"
scp -r -q client/css "$VPS_HOST:/var/www/zetachad/client/css"
scp -r -q client/js "$VPS_HOST:/var/www/zetachad/client/js"

echo "==> Sync admin"
ssh "$VPS_HOST" "rm -rf /var/www/zetachad/admin/css /var/www/zetachad/admin/js"
scp -q client/admin/index.html "$VPS_HOST:/var/www/zetachad/admin/"
scp -r -q client/admin/css "$VPS_HOST:/var/www/zetachad/admin/css"
scp -r -q client/admin/js "$VPS_HOST:/var/www/zetachad/admin/js"

echo "==> Install + migrate + restart"
ssh "$VPS_HOST" "set -e
  cd /srv/zetachad/server
  sudo -u zetachad npm ci --omit=dev
  sudo -u zetachad node --env-file=/etc/zetachad/env src/db.js
  sudo systemctl restart zetachad
  sudo systemctl status zetachad --no-pager | head -n 20
"

echo "==> Done"

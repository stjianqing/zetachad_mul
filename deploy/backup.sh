#!/usr/bin/env bash
# Run via cron on the VPS:  0 3 * * * /srv/zetachad/deploy/backup.sh
# Keeps 7 nightly dumps in /var/backups/zetachad/

set -euo pipefail

DEST=/var/backups/zetachad
mkdir -p "$DEST"

STAMP=$(date +%Y%m%d_%H%M%S)
OUT="$DEST/zetachad_$STAMP.sql.gz"

# Read DATABASE_URL from /etc/zetachad/env (the same file systemd uses)
set -a; source /etc/zetachad/env; set +a

pg_dump --no-owner --no-privileges "$DATABASE_URL" | gzip -9 > "$OUT"

# Retain the most recent 7 dumps; delete older ones.
ls -1t "$DEST"/zetachad_*.sql.gz | tail -n +8 | xargs -r rm -f

echo "$(date) ok $OUT" >> "$DEST/backup.log"

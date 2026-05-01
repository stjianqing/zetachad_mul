# zetachad_mul — VPS bootstrap runbook

Target: Ubuntu 24.04 at `87.99.158.208`. Run each numbered section once, in order.

## 1. DuckDNS subdomain

1. Sign in / register at https://www.duckdns.org/
2. Create a subdomain (e.g. `zetachad-mul.duckdns.org`)
3. Set its IP to `87.99.158.208`
4. Note the token DuckDNS gives you (you'll set up auto-renewal of the IP later if you want)

For this runbook, replace `SUBDOMAIN.duckdns.org` with your actual subdomain.

## 2. Server packages

```bash
ssh root@87.99.158.208
apt update && apt -y upgrade
apt -y install curl ca-certificates gnupg ufw nginx postgresql postgresql-contrib certbot python3-certbot-nginx rsync

# Node 22 LTS via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt -y install nodejs

# Firewall: SSH + HTTP + HTTPS
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
```

## 3. Database

```bash
sudo -u postgres psql <<SQL
CREATE ROLE zetachad WITH LOGIN PASSWORD 'CHOOSE_A_STRONG_PASSWORD';
CREATE DATABASE zetachad OWNER zetachad;
SQL
```

## 4. Service user + paths

```bash
useradd --system --create-home --home-dir /srv/zetachad --shell /bin/bash zetachad
mkdir -p /srv/zetachad/server /var/www/zetachad/client /etc/zetachad
chown -R zetachad:zetachad /srv/zetachad
chown -R www-data:www-data /var/www/zetachad
```

## 5. Environment file

Generate a long random cookie secret:

```bash
COOKIE_SECRET=$(openssl rand -base64 48)
cat > /etc/zetachad/env <<EOF
DATABASE_URL=postgres://zetachad:CHOOSE_A_STRONG_PASSWORD@127.0.0.1:5432/zetachad
PORT=3000
HOST=127.0.0.1
COOKIE_SECRET=$COOKIE_SECRET
COOKIE_SECURE=true
NODE_ENV=production
LOG_LEVEL=info
EOF
chmod 600 /etc/zetachad/env
chown root:zetachad /etc/zetachad/env
```

## 6. nginx site

Copy the template, then edit `server_name`:

```bash
cp /srv/zetachad/server/../deploy/nginx.conf /etc/nginx/sites-available/zetachad
# (you will copy this file in step 8 when first deploying — for now, skip if not yet present)
ln -sf /etc/nginx/sites-available/zetachad /etc/nginx/sites-enabled/zetachad
sed -i 's/server_name _;/server_name SUBDOMAIN.duckdns.org;/' /etc/nginx/sites-available/zetachad
nginx -t && systemctl reload nginx
```

## 7. systemd unit

After first deploy (step 8) the service file is on the VPS. Install it:

```bash
cp /srv/zetachad/deploy/zetachad.service /etc/systemd/system/zetachad.service
systemctl daemon-reload
systemctl enable zetachad
```

## 8. Deploying from your laptop

You have two deploy scripts:

- **`deploy/deploy.sh`** — uses `rsync` (faster, supports `--delete`). Use this on Linux/macOS or any environment where `rsync` is available.
- **`deploy/deploy-scp.sh`** — uses `scp` only (slower, no `--delete`). Use this on Windows Git Bash, which does **not** ship with `rsync`.

### From Windows (Git Bash) — use this

Git Bash on Windows has `ssh` and `scp` but not `rsync`. Always use `deploy-scp.sh`:

```bash
cd ~/projects/zetachad_mul
VPS_HOST=root@87.99.158.208 ./deploy/deploy-scp.sh
```

**SSH key auth required.** First time only, copy your public key to the VPS so deploys don't prompt for the password ~6 times:

```powershell
# In PowerShell on the laptop (one-time):
ssh-keygen -t ed25519 -C "your-email"   # accept defaults if no key yet
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh root@87.99.158.208 "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
ssh root@87.99.158.208 "echo 'key auth works'"
```

**Paste tip.** Git Bash ignores `Ctrl+V` by default. Right-click → Paste, or enable `Ctrl+Shift+V` via title bar → Options → Keys → "Ctrl+Shift+letter shortcuts".

**Don't paste multi-line commands into Git Bash.** The terminal silently inserts newlines, which breaks `\` line continuations and causes bash to try to *execute* JSON files. Always run a script from disk (`./deploy/deploy-scp.sh`), not a long inline command.

### From Linux/macOS

```bash
cd /path/to/zetachad_mul
VPS_HOST=root@87.99.158.208 ./deploy/deploy.sh
```

### What both scripts do

1. rsync/scp `server/` → `/srv/zetachad/server/` on VPS
2. rsync/scp `client/` → `/var/www/zetachad/client/`
3. rsync/scp `client/admin/` → `/var/www/zetachad/admin/`
4. SSH in: `npm ci --omit=dev`, run migrations (`node src/db.js`), `systemctl restart zetachad`, print status

### After a routine deploy

Hit `https://SUBDOMAIN.duckdns.org/admin/` (or `/api/health`) from a browser to confirm the new code is serving. If anything looks broken, check logs with:

```bash
ssh root@87.99.158.208 'journalctl -u zetachad -n 50 --no-pager'
```

### First-deploy only

After the very first deploy succeeds, ssh in and start the service (only needed once — subsequent deploys restart it automatically):

```bash
ssh root@87.99.158.208 'systemctl start zetachad && systemctl status zetachad --no-pager'
```

Hit `http://SUBDOMAIN.duckdns.org/api/health` from a browser. Expected: `{"ok":true}`.

### Source of truth

The repo lives on GitHub at `https://github.com/stjianqing/zetachad_mul`. The VPS does **not** have a `.git` directory — it only receives synced files. To update the VPS, you must run the deploy script from a machine that has the latest code (typically your laptop after `git pull`).

## 9. TLS via Let's Encrypt

```bash
ssh root@87.99.158.208 'certbot --nginx -d SUBDOMAIN.duckdns.org --non-interactive --agree-tos -m you@example.com'
```

Certbot will edit the nginx site to add SSL. Verify `https://SUBDOMAIN.duckdns.org/api/health` works. The cert auto-renews via the certbot timer.

## 10. Backups

```bash
ssh root@87.99.158.208 'crontab -l 2>/dev/null | { cat; echo "0 3 * * * /srv/zetachad/deploy/backup.sh"; } | crontab -'
```

## 11. Smoke test

From the laptop:

```bash
curl -i https://SUBDOMAIN.duckdns.org/api/health
curl -i https://SUBDOMAIN.duckdns.org/    # should serve index.html
```

Then from a browser, register an account, play a default-config run, submit, see yourself on the leaderboard.

## 12. Admin dashboard setup (one-time)

Create the admin dashboard directory and install Basic Auth credentials.

```bash
ssh root@87.99.158.208 'mkdir -p /var/www/zetachad/admin && chown -R www-data:www-data /var/www/zetachad/admin'
```

```bash
ssh root@87.99.158.208 'apt-get install -y apache2-utils'
```

```bash
ssh root@87.99.158.208 'htpasswd -cB /etc/nginx/zetachad-admin.htpasswd stjianqing'
# Enter the admin password when prompted: tns6e123
```

```bash
ssh root@87.99.158.208 'chown root:www-data /etc/nginx/zetachad-admin.htpasswd && chmod 640 /etc/nginx/zetachad-admin.htpasswd'
```

```bash
ssh root@87.99.158.208 'nginx -t && systemctl reload nginx'
```

After this, `https://SUBDOMAIN.duckdns.org/admin/` will prompt for HTTP Basic Auth. Enter `stjianqing` / `tns6e123`.

To rotate the password later:

```bash
ssh root@87.99.158.208 'htpasswd -B /etc/nginx/zetachad-admin.htpasswd stjianqing'
```

The dashboard data comes from `/admin/api/*` routes on the same domain, gated by the same Basic Auth.

## Operational notes

- Logs: `journalctl -u zetachad -f`
- Reset a forgotten password (admin path):
  ```sql
  -- ssh in, then
  sudo -u postgres psql zetachad -c "UPDATE users SET password_hash = '...' WHERE username = '...';"
  ```
  (Generate a bcrypt hash with `node -e "import('bcrypt').then(b=>b.default.hash('newpass', 10).then(console.log))"`.)
- DB shell: `sudo -u postgres psql zetachad`
- Nightly backup status: `tail /var/backups/zetachad/backup.log`

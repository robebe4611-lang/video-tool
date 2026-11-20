#!/usr/bin/env bash
# One-time setup for an Oracle Cloud "Always Free" Ubuntu VM.
# Installs: Node 22, ffmpeg, yt-dlp (with browser impersonation), Caddy (free HTTPS),
# runs the app as a service and pulls updates from GitHub automatically every 10 minutes.
# Safe to run again.
set -euo pipefail

REPO="${REPO:-https://github.com/robebe4611-lang/video-tool}"
APP=/opt/video-tool
export DEBIAN_FRONTEND=noninteractive

echo "== packages"
apt-get update -y
apt-get install -y ca-certificates curl git ffmpeg python3-venv iptables-persistent debian-keyring debian-archive-keyring apt-transport-https gnupg

echo "== Node.js 22"
if ! command -v node >/dev/null || ! node -v | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "== yt-dlp"
python3 -m venv /opt/ytdlp
/opt/ytdlp/bin/pip install -q -U "yt-dlp[default,curl-cffi]"
ln -sf /opt/ytdlp/bin/yt-dlp /usr/local/bin/yt-dlp

echo "== app"
id -u videotool >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin videotool
if [ -d "$APP/.git" ]; then git -C "$APP" pull --ff-only; else git clone --depth 1 "$REPO" "$APP"; fi
cd "$APP" && npm ci --omit=dev
chown -R videotool:videotool "$APP"

cat >/etc/systemd/system/video-tool.service <<'EOF'
[Unit]
Description=Video Tool
After=network-online.target

[Service]
User=videotool
WorkingDirectory=/opt/video-tool
Environment=PORT=3000 NODE_ENV=production
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now video-tool
systemctl restart video-tool

echo "== firewall (Oracle Ubuntu images block everything but SSH)"
for p in 80 443; do
  if ! iptables -C INPUT -p tcp --dport $p -j ACCEPT 2>/dev/null; then
    # insert right before Oracle's catch-all REJECT rule (or append if there is none)
    n=$(iptables -L INPUT --line-numbers -n 2>/dev/null | awk '$2=="REJECT"{print $1; exit}' || true)
    if [ -n "$n" ]; then iptables -I INPUT "$n" -p tcp --dport $p -j ACCEPT; else iptables -A INPUT -p tcp --dport $p -j ACCEPT; fi
  fi
done
netfilter-persistent save || true

echo "== HTTPS with Caddy (free certificate, address based on the public IP)"
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi
IP=$(curl -fsS https://api.ipify.org)
HOST="$(echo "$IP" | tr . -).sslip.io"
cat >/etc/caddy/Caddyfile <<EOF
$HOST {
    encode gzip
    reverse_proxy localhost:3000 {
        flush_interval -1
    }
}
EOF
systemctl restart caddy

echo "== automatic updates"
cat >/usr/local/bin/video-tool-update <<'EOF'
#!/usr/bin/env bash
cd /opt/video-tool || exit 0
before=$(git rev-parse HEAD)
sudo -u videotool git pull --ff-only -q || exit 0
after=$(git rev-parse HEAD)
if [ "$before" != "$after" ]; then
  sudo -u videotool npm ci --omit=dev --silent
  systemctl restart video-tool
fi
EOF
chmod +x /usr/local/bin/video-tool-update
cat >/etc/cron.d/video-tool <<'EOF'
*/10 * * * * root /usr/local/bin/video-tool-update >/var/log/video-tool-update.log 2>&1
17 4 * * * root /opt/ytdlp/bin/pip install -q -U "yt-dlp[default,curl-cffi]" >/var/log/ytdlp-update.log 2>&1
EOF

echo
echo "======================================================"
echo " Done. Open on your phone:  https://$HOST"
echo " (the certificate may take a minute on the first visit)"
echo "======================================================"

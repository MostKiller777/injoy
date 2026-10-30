#!/usr/bin/env bash
#
# injoy - provision an always-on Ubuntu host.
#
#   sudo bash deploy/bootstrap.sh [/path/to/source]
#
# Installs Node 22 and headless Chrome (the resolver needs a browser), copies
# the app to /opt/injoy, puts its data in /var/lib/injoy, and runs it under
# systemd so it comes back after a reboot and after a crash. Nothing here is
# interactive: run it once and the site answers on port 80 until you stop it.
#
# Environment:
#   PORT=80          port the app listens on
#   DOMAIN=          optional; installs Caddy in front and gets a free
#                    Let's Encrypt certificate for that name
#   MEDIA_CACHE_GB=  default 40; the disk budget for cached films
#
set -euo pipefail

PORT="${PORT:-80}"
DOMAIN="${DOMAIN:-}"
MEDIA_CACHE_GB="${MEDIA_CACHE_GB:-40}"
SRC="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
APP_DIR=/opt/injoy
DATA_DIR=/var/lib/injoy
SERVICE_USER=injoy

if [ "$(id -u)" -ne 0 ]; then
  echo "run me with sudo" >&2
  exit 1
fi

if [ ! -f "$SRC/server/index.js" ]; then
  echo "no app at $SRC (expected server/index.js)" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

echo "== packages =="
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg apt-transport-https fonts-liberation >/dev/null

echo "== node 22 =="
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "   node $(node -v)"

echo "== browser =="
# The resolver drives a real browser over the netlog: without one the site
# still serves the catalog, but every play falls back to an embed.
have_browser() {
  command -v google-chrome >/dev/null 2>&1 \
    || command -v chromium >/dev/null 2>&1 \
    || command -v chromium-browser >/dev/null 2>&1 \
    || [ -x /snap/bin/chromium ]
}

if ! have_browser; then
  if [ "$(uname -m)" = "x86_64" ]; then
    install -d -m 0755 /etc/apt/keyrings
    curl -fsSL https://dl.google.com/linux/linux_signing_key.pub \
      | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg
    echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
      > /etc/apt/sources.list.d/google-chrome.list
    apt-get update -qq
    apt-get install -y -qq google-chrome-stable >/dev/null
  else
    # Oracle's Ampere A1 is ARM64, and Google does not publish a Linux ARM
    # Chrome. Ubuntu's Chromium snap is the supported ARM browser; the resolver
    # already looks for /snap/bin/chromium.
    apt-get install -y -qq snapd >/dev/null || true
    systemctl enable --now snapd.socket >/dev/null 2>&1 || true
    if ! snap install chromium >/dev/null 2>&1; then
      apt-get install -y -qq chromium-browser >/dev/null 2>&1 || true
    fi
  fi
fi
BROWSER_VERSION="$(google-chrome --version 2>/dev/null || chromium --version 2>/dev/null || chromium-browser --version 2>/dev/null || /snap/bin/chromium --version 2>/dev/null || echo 'browser missing — embeds only')"
echo "   $BROWSER_VERSION"

echo "== user and directories =="
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
install -d -m 0755 "$APP_DIR"
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR"

echo "== app =="
# Copy the source tree without the local library, the downloaded media or the
# tunnel binary: those belong to a machine, not to a deployment.
rm -rf "$APP_DIR/server" "$APP_DIR/public"
cp -R "$SRC/server" "$APP_DIR/server"
cp -R "$SRC/public" "$APP_DIR/public"
cp "$SRC/package.json" "$APP_DIR/package.json"
if [ -f "$SRC/README.md" ]; then
  cp "$SRC/README.md" "$APP_DIR/README.md"
fi
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"

echo "== systemd =="
cat > /etc/systemd/system/injoy.service <<EOF
[Unit]
Description=injoy - curated streaming front end
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_USER
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=HOST=0.0.0.0
Environment=PORT=$PORT
Environment=DATA_DIR=$DATA_DIR
Environment=MEDIA_CACHE_GB=$MEDIA_CACHE_GB
# The service account cannot use Chrome's sandbox on this host; the resolver
# still sniffs the stream, it just runs the browser unsandboxed.
Environment=CHROME_NO_SANDBOX=1
ExecStart=/usr/bin/node $APP_DIR/server/index.js
Restart=always
RestartSec=3
# Port 80 without running as root.
AmbientCapabilities=CAP_NET_BIND_SERVICE
NoNewPrivileges=false
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable injoy >/dev/null
systemctl restart injoy

echo "== firewall =="
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "$PORT"/tcp >/dev/null
fi
# Oracle's Ubuntu images ship a REJECT-all iptables chain that survives reboots.
if command -v iptables >/dev/null 2>&1; then
  if ! iptables -C INPUT -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null; then
    iptables -I INPUT 6 -m state --state NEW -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null || true
  fi
  if command -v netfilter-persistent >/dev/null 2>&1; then
    netfilter-persistent save >/dev/null 2>&1 || true
  fi
fi

echo "== tls =="
if [ -n "$DOMAIN" ]; then
  if ! command -v caddy >/dev/null 2>&1; then
    apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https >/dev/null
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
      > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq
    apt-get install -y -qq caddy >/dev/null
  fi
  cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT
}
EOF
  systemctl reload caddy 2>/dev/null || systemctl restart caddy
  echo "   caddy in front of 127.0.0.1:$PORT for $DOMAIN"
fi

echo "== health =="
for _ in $(seq 1 40); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    IP="$(curl -fsS https://api.ipify.org 2>/dev/null || echo '<this-host>')"
    echo ""
    echo "  injoy is live at  http://$IP$( [ "$PORT" = "80" ] || echo ":$PORT" )"
    if [ -n "$DOMAIN" ]; then
      echo "  with tls at       https://$DOMAIN"
    fi
    echo ""
    echo "  service   systemctl status injoy"
    echo "  logs      journalctl -u injoy -f"
    echo "  data      $DATA_DIR"
    echo ""
    exit 0
  fi
  sleep 1
done

echo "injoy did not answer - journalctl -u injoy -n 60" >&2
exit 1

#!/usr/bin/env bash
# Add an authenticated HTTP CONNECT inbound to an existing sing-box server
# (directory-style config: sing-box run -C /etc/sing-box/conf).
#
# The resulting proxy is reachable directly by the desktop app ("vps" mode):
#   nbd proxy set --mode vps --server "http://user:pass@[<vps-ipv6>]:8443"
#
# Plaintext HTTP CONNECT is fine where no filtering sits in the path; on
# mainland networks prefer the app's embedded tunnel mode (docs/proxy.md).
#
# Usage (on the VPS):
#   sudo ./add-http-inbound.sh                  # generates user+password
#   sudo USER=xuan PORT=8443 ./add-http-inbound.sh
#   sudo USER=xuan PASS=secret PORT=8443 ./add-http-inbound.sh
#
# Idempotent: re-running replaces the inbound file and restarts sing-box.

set -euo pipefail

CONF_DIR="${CONF_DIR:-/etc/sing-box/conf}"
INBOUND_FILE="$CONF_DIR/15_http_proxy_inbounds.json"
SING_BOX_BIN="${SING_BOX_BIN:-$(command -v sing-box || echo /etc/sing-box/sing-box)}"
USER_NAME="${USER_NAME:-nblm}"
PORT="${PORT:-8443}"
PASSWORD="${PASS:-$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')}"

[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)"; exit 1; }
[ -d "$CONF_DIR" ] || { echo "no $CONF_DIR - is sing-box installed with directory config?"; exit 1; }

backup="/root/sing-box-conf-backup-$(date +%Y%m%d%H%M%S).tar.gz"
tar czf "$backup" -C "$(dirname "$CONF_DIR")" "$(basename "$CONF_DIR")"
echo "backup: $backup"

cat > "$INBOUND_FILE" <<EOF
{
  "inbounds": [
    {
      "type": "http",
      "tag": "http-proxy-in",
      "listen": "::",
      "listen_port": $PORT,
      "users": [
        { "username": "$USER_NAME", "password": "$PASSWORD" }
      ]
    }
  ]
}
EOF

"$SING_BOX_BIN" check -C "$CONF_DIR"

# firewall (ufw if present; nftables/iptables users adjust manually)
if command -v ufw >/dev/null 2>&1; then
    ufw allow "$PORT"/tcp comment 'notebooklm-app-proxy' >/dev/null
fi

systemctl restart sing-box
sleep 1
systemctl is-active --quiet sing-box || { echo "sing-box failed to start; restoring backup"; echo "see: tar xzf $backup -C /"; exit 1; }

ss -tlnp | grep ":$PORT " || { echo "warning: port $PORT not listening"; exit 1; }

LOCAL_IP=$(hostname -I | awk '{print $1}')
IP6=$(ip -6 addr show scope global 2>/dev/null | grep -oP '2[0-9a-f:]+' | head -1 || true)

echo
echo "=== HTTP proxy inbound active ==="
echo "  port:        $PORT (dual-stack)"
echo "  user:        $USER_NAME"
echo "  password:    $PASSWORD"
[ -n "$IP6" ] && echo "  vps ipv6:    $IP6"
echo
echo "Desktop app one-liner:"
[ -n "$IP6" ] && echo "  nbd proxy set --mode vps --server \"http://$USER_NAME:$PASSWORD@[$IP6]:$PORT\""
echo "  nbd proxy set --mode vps --server \"http://$USER_NAME:$PASSWORD@$LOCAL_IP:$PORT\""
echo
echo "Keep the password out of git; rotate by re-running with PASS=..."

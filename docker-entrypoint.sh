#!/bin/bash
set -euo pipefail

: "${WG_PRIVATE_KEY:?WG_PRIVATE_KEY is required}"
: "${WG_ADDRESS:?WG_ADDRESS is required}"
: "${WG_SERVER_PUBKEY:?WG_SERVER_PUBKEY is required}"
: "${WG_PSK:?WG_PSK is required}"
: "${WG_ENDPOINT:?WG_ENDPOINT is required}"
: "${WG_ALLOWED_IPS:?WG_ALLOWED_IPS is required}"

mkdir -p /etc/wireguard
cat > /etc/wireguard/wg0.conf <<EOF
[Interface]
PrivateKey = ${WG_PRIVATE_KEY}
Address = ${WG_ADDRESS}
${WG_DNS:+DNS = ${WG_DNS}}

[Peer]
PublicKey = ${WG_SERVER_PUBKEY}
PresharedKey = ${WG_PSK}
Endpoint = ${WG_ENDPOINT}
AllowedIPs = ${WG_ALLOWED_IPS}
PersistentKeepalive = ${WG_KEEPALIVE:-25}
EOF
chmod 600 /etc/wireguard/wg0.conf

wg-quick up wg0

exec "$@"

#!/bin/bash
# Writes /etc/wireguard/wg0.conf from WG_* env vars, brings the tunnel up
# (falling back to userspace wireguard-go automatically if the kernel module
# isn't available — wg-quick does this on its own when it finds a
# wireguard-go binary in PATH), then execs the real command.
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
DNS = ${WG_DNS:-1.1.1.1}

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

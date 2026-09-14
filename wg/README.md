# WireGuard tunnel

`/api/read` needs to reach LiteLLM on skynet's LAN (`10.1.0.155:4000`), which
isn't public. The app image bundles WireGuard itself (`docker-entrypoint.sh`
+ `wireguard-go`) rather than running it as a separate sidecar container —
Coolify's host didn't allow the `SYS_MODULE` capability a sidecar container
needed to load the kernel WireGuard module.

Userspace mode avoids that: `wg-quick` automatically falls back to the
bundled `wireguard-go` binary when the kernel module isn't available, so the
container only needs `NET_ADMIN` + access to `/dev/net/tun` (both set in
`docker-compose.yml`) — no `SYS_MODULE`, no separate container.

`docker-entrypoint.sh` writes `/etc/wireguard/wg0.conf` from the `WG_*`
environment variables in `.env` and brings the tunnel up before starting the
Node server, so the whole thing is settable as Coolify secrets — no config
file to upload.

## Getting a peer config

On skynet, a new peer is added directly to `/etc/wireguard/wg0.conf`
(no wg-easy — plain `wg-quick`):

```
# on this machine, generate a keypair + psk
wg genkey | tee sidecar_private.key | wg pubkey > sidecar_public.key
wg genpsk > sidecar_psk.key

# on skynet, append a [Peer] block to /etc/wireguard/wg0.conf:
#   [Peer]
#   # <name for this deployment>
#   PublicKey = <sidecar_public.key>
#   PresharedKey = <sidecar_psk.key>
#   AllowedIPs = 10.8.0.X/32     # pick an unused address in 10.8.0.0/24
#
# then reload without dropping other peers:
sudo bash -c 'wg syncconf wg0 <(wg-quick strip wg0)'
```

Set in `.env` (see `.env.example` for the full list):
- `WG_PRIVATE_KEY` — this deployment's own private key (`sidecar_private.key`)
- `WG_ADDRESS` — the `10.8.0.X/32` you picked above
- `WG_SERVER_PUBKEY` — skynet's wg0 server public key (`wg show` on skynet)
- `WG_PSK` — `sidecar_psk.key`
- `WG_ENDPOINT` / `WG_ALLOWED_IPS` — usually the defaults in `.env.example` are fine

Delete the local `sidecar_*.key` files once they're in `.env` — nothing on
disk needs them after that.

**Verifying it connected**: `sudo wg show` on skynet should show a
`latest handshake` line for this peer within a minute or two of the
container starting. No handshake ever appearing means the container isn't
starting, `wg-quick up wg0` is failing (check the app container's logs, not
a separate `wg` container — there isn't one anymore), or UDP 51820 is
blocked outbound from wherever this is hosted.

A redeploy that needs a fresh peer (e.g. rotating a leaked key) should
generate a **new** keypair, add it as a new peer, then remove the old
`[Peer]` block from skynet's `wg0.conf` and reload — don't reuse keys across
deployments.

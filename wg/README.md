# WireGuard sidecar

`docker-compose.yml` runs punchcard's `app` container sharing the network
namespace of a `wg` (WireGuard client) container, so `/api/read` can reach
LiteLLM on skynet's LAN (`10.1.0.155:4000`) regardless of where Coolify
places the deployment.

The tunnel config isn't a mounted file — `init-wg-conf.sh` (mounted into
`/custom-cont-init.d/`, which linuxserver images run automatically before
the WireGuard service starts) writes `/config/wg_confs/wg0.conf` from the
`WG_*` environment variables in `.env`. That makes the whole thing settable
as Coolify secrets, no file upload needed.

## Getting a peer config

On skynet, a new peer for this sidecar is added directly to `/etc/wireguard/wg0.conf`
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

A redeploy that needs a fresh peer (e.g. rotating a leaked key) should
generate a **new** keypair, add it as a new peer, then remove the old
`[Peer]` block from skynet's `wg0.conf` and reload — don't reuse keys across
deployments.

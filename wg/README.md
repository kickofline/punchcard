# WireGuard tunnel (embedded, single container)

`/api/read` needs to reach LiteLLM on skynet's LAN (`10.1.0.155:4000`), which
isn't public. The app image brings up a kernel WireGuard tunnel itself —
`docker-entrypoint.sh` writes `/etc/wireguard/wg0.conf` from the `WG_*`
environment variables and runs `wg-quick up wg0` before starting the Node
server — rather than running WireGuard in a separate sidecar container.

This went through two other shapes before landing here:
1. A sidecar (`linuxserver/wireguard`) that `app` joined via
   `network_mode: "service:wg"` — this left `app` with no network identity
   of its own, which broke Coolify's proxy routing (503s even once the
   tunnel itself was up).
2. Flipping it so the sidecar joined `app`'s namespace instead
   (`network_mode: "service:app"` on `wg`) — functionally correct, but still
   two containers and more moving parts than necessary.

Both were worked around because of an earlier, unrelated bug: punchcard's
Coolify resource was building with the **Nixpacks** build pack, which
silently ignored the whole `docker-compose.yml` (`cap_add`, `devices`,
everything) and ran `npm run start` on an auto-generated image. Once that was
fixed (build pack set to **Docker Compose**), there was no longer a reason to
avoid `cap_add: [NET_ADMIN, SYS_MODULE]` directly on the single `app`
container — so it's back to one container, no sidecar, no shared network
namespace to reason about, and Coolify's proxy routes to `app` normally
since it keeps its own identity and published port.

An `/lib/modules:/lib/modules:ro` mount lets `modprobe wireguard` find the
kernel module if it isn't already loaded on the host.

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
container starting. No handshake ever appearing means:
- the Coolify resource isn't actually building via Docker Compose (check the
  build pack setting first — this was the root cause once already),
- the app container's logs show `docker-entrypoint.sh` failing (missing env
  var, or `wg-quick up wg0` erroring — check for a `SYS_MODULE`/permission
  denial there specifically),
- or UDP 51820 is blocked outbound from wherever this is hosted.

A redeploy that needs a fresh peer (e.g. rotating a leaked key) should
generate a **new** keypair, add it as a new peer, then remove the old
`[Peer]` block from skynet's `wg0.conf` and reload — don't reuse keys across
deployments.

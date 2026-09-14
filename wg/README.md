# WireGuard sidecar

`/api/read` needs to reach LiteLLM on skynet's LAN (`10.1.0.155:4000`), which
isn't public. A separate `wg` service (`lscr.io/linuxserver/wireguard`) brings
up the kernel WireGuard tunnel; the `app` service joins it via
`network_mode: "service:wg"` in `docker-compose.yml`, so all of `app`'s
traffic (including its outbound calls to LiteLLM) is routed through the
tunnel automatically.

An earlier attempt embedded a userspace tunnel (`wireguard-go`) directly in
the app image to avoid needing `SYS_MODULE`, on the theory that Coolify
wouldn't grant it to a sidecar. That theory was wrong — the actual problem
was that punchcard's Coolify resource was set to build with **Nixpacks**
instead of **Docker Compose**, which silently ignored `cap_add`/`devices`/the
whole compose file and ran `npm run start` on an auto-generated image with no
WireGuard tooling at all. Once the build pack is set to Docker Compose,
`cap_add: [NET_ADMIN, SYS_MODULE]` is honored normally, so the plain kernel
sidecar works and is simpler than building `wireguard-go` from source.

`wg/init-wg-conf.sh` runs via linuxserver's `/custom-cont-init.d/` hook and
writes `/config/wg_confs/wg0.conf` from the `WG_*` environment variables
before the image's own init brings the tunnel up — so, same as before, the
whole thing is settable as Coolify secrets with no config file to upload
(the script itself is static and lives in the repo; only its inputs are
secret).

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
`latest handshake` line for this peer within a minute or two of the `wg`
container starting. No handshake ever appearing means:
- the Coolify resource isn't actually building via Docker Compose (check the
  build pack setting first — this was the root cause once already),
- `wg` container logs show `init-wg-conf.sh` failing (missing env var),
- or UDP 51820 is blocked outbound from wherever this is hosted.

A redeploy that needs a fresh peer (e.g. rotating a leaked key) should
generate a **new** keypair, add it as a new peer, then remove the old
`[Peer]` block from skynet's `wg0.conf` and reload — don't reuse keys across
deployments.

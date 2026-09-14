# punchcard

A single-page web app for reading a paper punch time card. Point a phone camera
at the card (or upload a photo), and the stamped IN/OUT times are read by a
vision model, laid into the IN/OUT grid, and totalled. Rows are tap-to-edit, so
a misread is a quick fix.

## How it works

- **Frontend** — `index.html` + `app.mjs`, built with Preact + htm as ES
  modules, no build step. Camera / file capture, the punch grid, editing,
  totals, per-day breakdown, `localStorage` persistence.
- **`lib.mjs`** — pure time-card logic (grid layout, shift pairing, formatting),
  unit-tested with `node --test`.
- **`scan.mjs`** — dependency-free frame analysis for the live camera:
  finds the card's four corners for the on-screen outline and framing
  guidance, and perspective-corrects the shot when you tap the shutter.
  Also unit-tested.
- **`server.mjs`** — a zero-dependency Node server that serves the static app
  **and** exposes `POST /api/read`, which relays the photo to a self-hosted
  Gemma 4 vision model behind a LiteLLM proxy. The API key lives only on the
  server, never in the browser.
  Also serves `GET /healthz` and `GET /stats` (JSON, or `?html=1` for a page)
  with usage metrics — read counts, rolling error rate, per-model
  latency / quota / busy counts, which model actually got each read,
  per-day volume and error sparklines, and read-accuracy figures fed by
  client edit reports (`POST /api/correction`). Persisted to `STATS_FILE`.
  Each read also logs one greppable `read key=value …` line.
- **`GET /contrib`** — a review page for the opted-in samples (image +
  model output, suspect-first sorting, mark ok/wrong, export a labeled
  NDJSON set). Gated by `CONTRIB_TOKEN`; localhost-only when that's unset.

## Run locally

```
cp .env.example .env      # then set LITELLM_BASE_URL / LITELLM_API_KEY
node --env-file=.env server.mjs
# open http://localhost:3000
```

`LITELLM_BASE_URL` needs to reach a LiteLLM proxy routing to a vision-capable
model (`gemma4-e4b` by default) — see `docker-compose.yml` for running this
alongside a WireGuard sidecar when the LiteLLM host isn't on the same network.

Run the tests:

```
node --test
```

## Configuration

| Env var | Default | Notes |
| --- | --- | --- |
| `LITELLM_BASE_URL` | `http://litellm:4000/v1` | required for `/api/read`; LiteLLM's OpenAI-compatible base URL |
| `LITELLM_API_KEY` | — | required for `/api/read` |
| `LITELLM_MODEL` | `gemma4-e4b` | model name as configured in LiteLLM |
| `LITELLM_TIMEOUT_MS` | `30000` | per-attempt deadline before giving up |
| `LITELLM_RETRIES` | `2` | attempts against the model before failing |
| `STATS_FILE` | `./.stats.json` | where `/stats` metrics persist; point at a mounted volume to survive redeploys |
| `CONTRIB_DIR` | `contrib` next to `STATS_FILE` | where opted-in card photos + reader output are kept for quality review; set empty to disable |
| `CONTRIB_MAX` | `3000` | cap on stored samples; oldest deleted first |
| `PORT` | `3000` | Coolify sets this automatically |
| `HOST` | `0.0.0.0` | binds all interfaces (reachable from other devices on the LAN); set `127.0.0.1` for local-only |

The model is a single self-hosted deployment (no per-request quota), so
`readCardImage` just retries `LITELLM_RETRIES` times against transient
failures (5xx / timeout) rather than falling through a model list.

## Deploy (Coolify)

Deploy via `docker-compose.yml`, which runs the app alongside a WireGuard
sidecar so it can reach the LiteLLM host over the VPN regardless of where
Coolify places the container:

- Set `LITELLM_API_KEY` as an environment variable (and `LITELLM_BASE_URL` if
  the LiteLLM host's address differs from the default).
- The sidecar needs its own WireGuard peer config — see `wg/README.md`.
- The app listens on `PORT`, which Coolify provides.

## Notes / limits

- The vision model runs on shared self-hosted GPUs — under load a read may
  need a retry or two; `/api/read` returns an error if all `LITELLM_RETRIES`
  attempts fail, and manual row entry is the fallback.
- Vision accuracy is good but not perfect on glare / skew / low-res photos.
  Every row is tap-to-edit and punches can be entered by hand.
- The reader only reads printed machine stamps; handwriting and blank rows are
  ignored.
- Saved state (current card + "other cards" minutes) lives in `localStorage`
  under `timecard:v1`, per browser.
- **Photo sharing**: a checkbox on the main screen ("Share my card photos to
  improve the reader") is on by default. While it's on, each submitted photo
  and the reader's output are written to `CONTRIB_DIR` for accuracy review —
  these can contain names / IDs printed on the card. Unticking it stops all
  storage for that browser (`punchcard:contribute=0`). The sample card is
  never stored. `/stats` shows `contributedSamples`.

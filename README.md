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
  **and** exposes `POST /api/read`, which relays the photo to the Google Gemini
  vision API. The API key lives only on the server, never in the browser.
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
cp .env.example .env      # then put your Gemini key in it
node --env-file=.env server.mjs
# open http://localhost:3000
```

Get a key from https://aistudio.google.com/apikey.

Run the tests:

```
node --test
```

## Configuration

| Env var | Default | Notes |
| --- | --- | --- |
| `GEMINI_API_KEY` | — | required for `/api/read` |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite,gemini-flash-lite-latest,gemini-3.5-flash,gemini-3.6-flash,gemini-3.7-flash,gemini-flash-latest` | comma list; the next model is tried when the one before is out of quota, overloaded, missing, or slow |
| `GEMINI_TIMEOUT_MS` | `15000` | per-model deadline; a model that hasn't answered by then is abandoned for the next one |
| `STATS_FILE` | `./.stats.json` | where `/stats` metrics persist; point at a mounted volume to survive redeploys |
| `CONTRIB_DIR` | `contrib` next to `STATS_FILE` | where opted-in card photos + reader output are kept for quality review; set empty to disable |
| `CONTRIB_MAX` | `3000` | cap on stored samples; oldest deleted first |
| `PORT` | `3000` | Coolify sets this automatically |
| `HOST` | `0.0.0.0` | binds all interfaces (reachable from other devices on the LAN); set `127.0.0.1` for local-only |

The default leads with the `-lite` models: `/stats` on the live app showed
them both faster (p50 ~1.4s vs. the heavier models timing out at the full
`GEMINI_TIMEOUT_MS` window with a 0% quota-error rate — they just weren't
answering in time) and more reliable, so they front the cascade now. The
full-size Flash models still follow as a fallback in case a lite model is
down or a card needs the extra strength. Each model gets one
`GEMINI_TIMEOUT_MS` window before the server moves on.

## Deploy (Coolify)

Deploy as a **Nixpacks** app (not a static site):

- Nixpacks auto-detects Node from `package.json` and runs `npm start`
  (`node server.mjs`).
- Set `GEMINI_API_KEY` (and optionally `GEMINI_MODEL`) as environment variables.
- The app listens on `PORT`, which Coolify provides.

## Notes / limits

- Free-tier Gemini has a **daily request cap**. When the primary model is
  exhausted the server falls through to the lite model; when both are gone,
  `/api/read` returns an error and manual row entry is the fallback.
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

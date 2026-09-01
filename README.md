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
- **`server.mjs`** — a zero-dependency Node server that serves the static app
  **and** exposes `POST /api/read`, which relays the photo to the Google Gemini
  vision API. The API key lives only on the server, never in the browser.

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
| `GEMINI_MODEL` | `gemini-3.7-flash,gemini-3.5-flash-lite` | comma list; the next model is tried when the one before is out of quota or overloaded |
| `PORT` | `3000` | Coolify sets this automatically |

The default pairs the stronger Flash model (best at reading dot-matrix stamps,
~20 requests/day on the free tier) with Flash-Lite as an overflow (500/day,
weaker). The server also does one short retry per model on a transient 503.

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

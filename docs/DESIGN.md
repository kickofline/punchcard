# punchcard — design

## Origin

Ported from `time-card-reader.jsx`, a React component written for the Claude
artifact runtime. The runtime dependencies were removed and the reader rebuilt
twice:

| Was | Now |
| --- | --- |
| React + ReactDOM + Babel (host-provided) | Preact + hooks + htm, vendored ES modules, no build |
| `window.storage` (host-injected) | `localStorage` shim in `app.mjs`, same `{value}` shape |
| `fetch` to `api.anthropic.com` with no key | `POST /api/read` on our own server, which holds a Gemini key |

An interim version used vendored Tesseract.js (on-device OCR) plus OpenCV.js
(auto rotate/crop). Both were dropped when the reader moved to a vision model:
Gemini reads a skewed, glared phone photo — including the IN/OUT row labels — in
one call, so ~51 MB of vendored wasm and the manual crop UI were removed.

## Shape

```
index.html      markup + <script type="module" src="app.mjs">
app.mjs         Preact TimeCard: camera, capture, POST to /api/read, grid, totals
lib.mjs         pure logic (layout, readCard, stamp/format, isPunch) - node-testable
styles.css      lifted from the component's <style>; fonts self-hosted
server.mjs      static file server + POST /api/read Gemini proxy (no deps)
vendor/         preact.mjs, hooks.mjs, htm.mjs
fonts/          Zilla Slab, DotGothic16, Caveat (latin woff2)
test/           lib.test.mjs, server.test.mjs  (node --test)
```

## `/api/read`

Request `{ image: "<base64 or data: URL>", mimeType? }`. The server:

1. `validateReadBody` — unwrap a `data:` URL, check the type is an image, cap the
   body at 8 MB.
2. `readCardImage` — for each model in `GEMINI_MODEL`, call
   `:generateContent` with the image + a strict-JSON extraction prompt. On a
   transient 503 it waits 1.5 s and retries the same model once; on quota
   (`429` / `RESOURCE_EXHAUSTED`) or overload it moves to the next model
   (`shouldFallThrough`).
3. `punchesFromGeminiText` — strip ``` fences, slice out the `{...}`, parse,
   normalise (`type` upper-cased, hour zero-padded), drop anything that fails
   `IN|OUT` + `YYYY-MM-DD` + `HH:MM`.

Response `{ punches: [{type,date,time}], model }`. The frontend merges the
punches through `layout()` and highlights the new rows.

## Static serving

`serveStatic` uses an explicit allow-list (`STATIC_ALLOW`), not a directory
walk — `server.mjs`, `package.json`, `.env`, and dot-files are 404, and
`staticTarget` normalises the path first so `..` traversal cannot escape it.
This is covered by `server.test.mjs`.

## Testing

- `lib.test.mjs` — formatters, `isPunch` (now also checks `type`), `layout`,
  `readCard`.
- `server.test.mjs` — `punchesFromGeminiText`, `isQuotaError`,
  `shouldFallThrough`, `validateReadBody`, `staticTarget` (allow-list +
  traversal).
- View layer verified by server-rendering `TimeCard` with
  `preact-render-to-string`.
- End-to-end (`app.mjs` -> `/api/read` -> real Gemini -> grid + totals) verified
  in headless Chrome with a synthetic tilted card.
- Not covered without a device: `getUserMedia`, `localStorage` round-trip.

## Deploy

Nixpacks/Node on Coolify. `npm start` runs `node server.mjs`, which listens on
`PORT`. `GEMINI_API_KEY` is set as a Coolify environment variable.

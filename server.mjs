/* punchcard server: serves the static app and proxies card photos to the
   Gemini vision API so the API key never reaches the browser.

   Env:
     GEMINI_API_KEY     required for /api/read
     GEMINI_MODEL       comma list, tried in order when one is busy / out of
                        quota / missing / slow. Default is a newest-to-oldest
                        cascade of flash models.
     GEMINI_TIMEOUT_MS  per-model deadline before giving up on it (default 9000)
     PORT               default 3000
     HOST               default 0.0.0.0 (all interfaces); 127.0.0.1 for local only
*/

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { argv } from "node:process";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0"; // all interfaces; set HOST=127.0.0.1 to keep it local
const CALL_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 9000);
const API_KEY = process.env.GEMINI_API_KEY || "";
const MODELS = (
  process.env.GEMINI_MODEL ||
  [
    "gemini-flash-latest",
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-flash-lite-latest",
  ].join(",")
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const MAX_BODY = 8 * 1024 * 1024;

const IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

/* ------------------------------- pure helpers ------------------------------ */

export function validateReadBody(body) {
  let image = body && body.image;
  let mimeType = (body && body.mimeType) || "image/jpeg";
  if (typeof image === "string" && image.startsWith("data:")) {
    const m = /^data:([^;,]+)?(?:;base64)?,(.*)$/s.exec(image);
    if (m) {
      if (m[1]) mimeType = m[1];
      image = m[2];
    }
  }
  if (typeof image !== "string" || image.length === 0) {
    throw new Error("body.image must be a base64 image string");
  }
  if (!IMAGE_TYPES.has(mimeType)) {
    throw new Error(`unsupported mime type: ${mimeType}`);
  }
  return { image, mimeType };
}

export function isQuotaError(status, body) {
  if (status === 429) return true;
  return !!(body && body.error && body.error.status === "RESOURCE_EXHAUSTED");
}

/* Worth trying the next model: out of quota, momentarily overloaded, too slow,
   or retired (404). Only a "this request is bad" error (400, 403) stops the
   cascade. */
export function shouldFallThrough(status, body) {
  if (isQuotaError(status, body)) return true;
  if ([500, 503, 504, 404].includes(status)) return true;
  return !!(
    body &&
    body.error &&
    ["UNAVAILABLE", "DEADLINE", "NOT_FOUND", "INTERNAL"].includes(body.error.status)
  );
}

const validPunch = (p) =>
  !!p &&
  (p.type === "IN" || p.type === "OUT") &&
  /^\d{4}-\d{2}-\d{2}$/.test(p.date) &&
  /^\d{2}:\d{2}$/.test(p.time);

export function punchesFromGeminiText(text) {
  const cleaned = String(text).replace(/```json|```/gi, "");
  const a = cleaned.indexOf("{");
  const b = cleaned.lastIndexOf("}");
  if (a < 0 || b < 0 || b < a) throw new Error("no JSON object in model reply");
  const parsed = JSON.parse(cleaned.slice(a, b + 1));
  const list = Array.isArray(parsed.punches) ? parsed.punches : [];
  const out = [];
  for (const p of list) {
    let time = String((p && p.time) || "");
    const tm = /^(\d{1,2}):(\d{2})/.exec(time);
    if (tm) time = `${tm[1].padStart(2, "0")}:${tm[2]}`;
    const cand = {
      type: String((p && p.type) || "").toUpperCase(),
      date: String((p && p.date) || ""),
      time,
    };
    if (validPunch(cand)) out.push(cand);
  }
  return out;
}

/* --------------------------------- gemini -------------------------------- */

const PROMPT = `This photo shows a paper punch time card. Rows are labeled IN and OUT, alternating down the card. Some rows carry a machine-stamped date and time (for example "31 AUG '26 PM1:35"); the rest are blank or handwritten.

Return ONLY a JSON object, with no markdown fences and no commentary:
{"punches":[{"type":"IN","date":"2026-08-31","time":"13:35"}]}

Rules:
- One entry per stamped row, top to bottom, in the order they appear.
- "type" is that row's printed label: "IN" or "OUT".
- "date" is YYYY-MM-DD. A stamp like 31 AUG '26 is 2026-08-31.
- "time" is 24-hour HH:MM. PM1:35 is 13:35. AM12:05 is 00:05. PM12:40 is 12:40.
- Ignore blank rows and anything handwritten.
- If no row is stamped, return {"punches":[]}.`;

async function callGemini(model, image, mimeType) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-goog-api-key": API_KEY },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { inline_data: { mime_type: mimeType, data: image } },
              { text: PROMPT },
            ],
          },
        ],
        generationConfig: { temperature: 0 },
      }),
    });
    let body = {};
    try {
      body = await res.json();
    } catch {
      /* leave body empty */
    }
    return { status: res.status, body };
  } catch (e) {
    // timeout / network drop - let the caller fall through to the next model
    return {
      status: 504,
      body: { error: { status: "DEADLINE", message: `${model}: ${e.name === "TimeoutError" ? "timed out" : e.message}` } },
    };
  }
}

/* The model that last answered, tried first next time so a busy leader does not
   cost every request. In-memory only; resets on restart. */
let preferredModel = null;

async function readCardImage(image, mimeType, onEvent = () => {}) {
  const order =
    preferredModel && MODELS.includes(preferredModel)
      ? [preferredModel, ...MODELS.filter((m) => m !== preferredModel)]
      : MODELS;

  let lastErr = "no models configured";
  let lastBusy = false;
  for (const model of order) {
    const t = Date.now();
    onEvent("try", { model });
    const { status, body } = await callGemini(model, image, mimeType);
    const ms = Date.now() - t;
    console.log(`  ${model} ${status} ${ms}ms`);
    if (status === 200) {
      const cand = body.candidates && body.candidates[0];
      const text = ((cand && cand.content && cand.content.parts) || [])
        .map((p) => p.text || "")
        .join("");
      const finish = cand && cand.finishReason;
      preferredModel = model;
      let punches = [];
      let parseErr = null;
      try {
        punches = punchesFromGeminiText(text);
      } catch (e) {
        parseErr = e.message;
      }
      if (!punches.length) {
        console.log(
          `  ${model} 200 ${ms}ms but 0 punches` +
            (finish ? ` finish=${finish}` : "") +
            (parseErr ? ` parseErr=${parseErr}` : "") +
            ` raw=${JSON.stringify(text).slice(0, 500)}`
        );
      }
      return { punches, model, raw: text, finish: finish || null };
    }
    lastErr = (body.error && body.error.message) || `HTTP ${status}`;
    lastBusy = shouldFallThrough(status, body);
    console.log(`  fell_through ${model} ${status} ${ms}ms  ${JSON.stringify(lastErr).slice(0, 200)}`);
    onEvent("fell_through", { model, status, ms, busy: lastBusy });
    if (!lastBusy) {
      const e = new Error(lastErr);
      e.upstream = true;
      throw e;
    }
    // overloaded / slow / out of quota / retired - on to the next model
  }
  const e = new Error(
    lastBusy ? "Every model was busy or out of quota. Try again in a moment." : lastErr
  );
  e.upstream = true;
  e.busy = lastBusy;
  throw e;
}

/* ------------------------------- http layer ----------------------------- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
};

/* Only these paths are served. Anything else (server.mjs, package.json, .env,
   dot-files, node_modules, ...) is a 404. */
const STATIC_ALLOW = new Set([
  "index.html",
  "app.mjs",
  "lib.mjs",
  "styles.css",
  "vendor/preact.mjs",
  "vendor/hooks.mjs",
  "vendor/htm.mjs",
  "fonts/caveat.woff2",
  "fonts/dotgothic16-400.woff2",
  "fonts/zillaslab-400.woff2",
  "fonts/zillaslab-500.woff2",
  "fonts/zillaslab-600.woff2",
  "fonts/zillaslab-700.woff2",
]);

const sendJson = (res, code, obj) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
};

async function handleRead(req, res) {
  if (!API_KEY) return sendJson(res, 500, { error: "server is missing GEMINI_API_KEY" });
  let raw = "";
  let tooBig = false;
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) {
      tooBig = true;
      break;
    }
  }
  if (tooBig) return sendJson(res, 413, { error: "image too large" });

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { error: "invalid JSON body" });
  }

  let clean;
  try {
    clean = validateReadBody(parsed);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }

  // Body is valid: switch to an event stream so the page can narrate the
  // model attempts. HTTP status stays 200; success/failure is the last event.
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const emit = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const t0 = Date.now();
  try {
    const { punches, model, raw, finish } = await readCardImage(clean.image, clean.mimeType, emit);
    console.log(`/api/read done  ${model}  ${punches.length} punches  ${Date.now() - t0}ms`);
    const done = { punches, model };
    if (!punches.length) {
      done.finish = finish || null;
      done.raw = String(raw || "").slice(0, 600); // what the model actually said
    }
    emit("done", done);
  } catch (e) {
    console.log(`/api/read error  ${Date.now() - t0}ms  ${e.message || e}`);
    emit("error", { error: e.message || String(e), busy: !!e.busy });
  }
  res.end();
}

/* Resolve a request path to an allow-listed file name, or null. */
export function staticTarget(urlPath) {
  let p;
  try {
    p = decodeURIComponent(String(urlPath).split("?")[0]);
  } catch {
    return null;
  }
  const rel = normalize(p === "/" ? "index.html" : p.replace(/^\/+/, "")).replace(/\\/g, "/");
  return STATIC_ALLOW.has(rel) ? rel : null;
}

async function serveStatic(req, res) {
  const rel = staticTarget(req.url || "/");
  if (!rel) {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
    return;
  }
  try {
    const buf = await readFile(join(ROOT, rel));
    res.writeHead(200, {
      "Content-Type": MIME[extname(rel).toLowerCase()] || "application/octet-stream",
      "Cache-Control": rel === "index.html" ? "no-cache" : "public, max-age=3600",
    });
    res.end(req.method === "HEAD" ? undefined : buf);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
  }
}

export const server = createServer((req, res) => {
  if (req.method === "POST" && (req.url || "").split("?")[0] === "/api/read") {
    handleRead(req, res).catch((e) => sendJson(res, 500, { error: String(e) }));
    return;
  }
  if (req.method === "GET" || req.method === "HEAD") {
    serveStatic(req, res).catch(() => res.writeHead(500).end("error"));
    return;
  }
  res.writeHead(405, { "Content-Type": "text/plain" }).end("method not allowed");
});

if (argv[1] && argv[1] === import.meta.filename) {
  server.listen(PORT, HOST, () => {
    console.log(`punchcard on ${HOST}:${PORT}  models: ${MODELS.join(" -> ")}`);
  });
}

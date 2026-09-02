/* punchcard server: serves the static app and proxies card photos to the
   Gemini vision API so the API key never reaches the browser.

   Env:
     GEMINI_API_KEY     required for /api/read
     GEMINI_MODEL       comma list, tried in order when one is busy / out of
                        quota / missing / slow. Default is a newest-to-oldest
                        cascade of flash models.
     GEMINI_TIMEOUT_MS  per-model deadline before giving up on it (default 9000)
     STATS_FILE         where usage metrics persist (default ./.stats.json)
     PORT               default 3000
     HOST               default 0.0.0.0 (all interfaces); 127.0.0.1 for local only
*/

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { argv } from "node:process";
import { layout, readCard } from "./lib.mjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0"; // all interfaces; set HOST=127.0.0.1 to keep it local
const CALL_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 9000);
const STATS_FILE = process.env.STATS_FILE || join(ROOT, ".stats.json");
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
const SAMPLE_MODELS = (process.env.GEMINI_SAMPLE_MODEL ||
  "gemini-3.5-flash-lite,gemini-flash-lite-latest")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

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
  const cidRaw = body && body.clientId;
  const clientId =
    typeof cidRaw === "string" && cidRaw.length > 0 && cidRaw.length <= 64 ? cidRaw : null;
  const sample = !!(body && body.sample);
  return { image, mimeType, clientId, sample };
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
    const conf = Number(p && p.confidence);
    const cand = {
      type: String((p && p.type) || "").toUpperCase(),
      date: String((p && p.date) || ""),
      time,
      confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 1,
    };
    if (validPunch(cand)) out.push(cand);
  }
  return out;
}

/* --------------------------------- gemini -------------------------------- */

const PROMPT = `This photo shows a paper punch time card. Rows are labeled IN and OUT, alternating down the card. Some rows carry a machine-stamped date and time (for example "31 AUG '26 PM1:35"); the rest are blank or handwritten. The stamps are faint dot-matrix print and may be light or slightly misaligned - read them anyway.

Return ONLY a JSON object, no markdown fences, no commentary:
{"punches":[{"type":"IN","date":"2026-08-31","time":"13:35","confidence":0.9}]}

Rules:
- One entry per stamped row, top to bottom, in the order they appear.
- "type" is that row's printed label: "IN" or "OUT".
- "date" is YYYY-MM-DD. A stamp like 31 AUG '26 is 2026-08-31.
- "time" is 24-hour HH:MM. PM1:35 is 13:35. AM12:05 is 00:05. PM12:40 is 12:40.
- "confidence" is your certainty for that row, 0 to 1. Use a low value when the
  stamp is faint, blurry, or partly cut off.
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
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 2048,
          responseMimeType: "application/json",
        },
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

async function readCardImage(image, mimeType, onEvent = () => {}, opts = {}) {
  const pool = opts.models || MODELS;
  const order =
    !opts.models && preferredModel && pool.includes(preferredModel)
      ? [preferredModel, ...pool.filter((m) => m !== preferredModel)]
      : pool;

  let lastErr = "no models configured";
  let lastBusy = false;
  let attempts = 0;
  for (const model of order) {
    attempts++;
    const t = Date.now();
    onEvent("try", { model });
    const { status, body } = await callGemini(model, image, mimeType);
    const ms = Date.now() - t;
    if (!opts.noMetrics) recordModelCall(model, status === 200, ms);
    console.log(`  ${model} ${status} ${ms}ms`);
    if (status === 200) {
      const cand = body.candidates && body.candidates[0];
      const text = ((cand && cand.content && cand.content.parts) || [])
        .map((p) => p.text || "")
        .join("");
      const finish = cand && cand.finishReason;
      if (!opts.models) preferredModel = model;
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
      return { punches, model, raw: text, finish: finish || null, attempts };
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

/* ------------------------------- ops metrics --------------------------- */

const STARTED_AT = Date.now();
const RING = 500;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/* nearest-rank percentile of a pre-sorted ascending array */
export function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

export const minToHHMM = (m) =>
  m == null ? null : `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

const minuteOfDay = (p) => {
  const [hh, mm] = String(p.time).split(":").map(Number);
  return hh * 60 + mm;
};

const metrics = {
  firstReadAt: null,
  lastReadAt: null,
  reads: { total: 0, ok: 0, zeroPunch: 0, badRequest: 0, upstream: 0, busy: 0 },
  cards: 0, // successful scans
  punchesReturned: 0,
  shiftsRead: 0,
  minutesClocked: 0,
  lowConfPunches: 0,
  confSum: 0,
  confN: 0,
  bytesProcessed: 0, // base64 chars processed
  fallthroughs: 0, // reads that needed > 1 model
  geminiCalls: 0,
  latency: [],
  models: new Map(), // name -> { calls, ok, fail, ms: [] }
  byDay: new Map(), // "YYYY-MM-DD" -> { reads, ok, zero }
  byHour: new Array(24).fill(0),
  byWeekday: new Array(7).fill(0),
  punchesPerCard: new Map(), // count -> occurrences
  clients: new Set(),
  longestShiftMin: 0,
  earliestInMin: null,
  latestOutMin: null,
};

const ringPush = (arr, v) => {
  arr.push(v);
  if (arr.length > RING) arr.shift();
};
const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function recordModelCall(model, ok, ms) {
  metrics.geminiCalls++;
  let m = metrics.models.get(model);
  if (!m) {
    m = { calls: 0, ok: 0, fail: 0, ms: [] };
    metrics.models.set(model, m);
  }
  m.calls++;
  ok ? m.ok++ : m.fail++;
  ringPush(m.ms, ms);
}

function recordRead(code, ms, punches, extra = {}) {
  const now = Date.now();
  const list = Array.isArray(punches) ? punches : [];
  const r = metrics.reads;
  r.total++;
  if (code === 200) {
    r.ok++;
    if (!list.length) r.zeroPunch++;
  } else if (code === 400 || code === 413) r.badRequest++;
  else if (code === 503) r.busy++;
  else r.upstream++;

  ringPush(metrics.latency, ms);
  metrics.lastReadAt = now;
  metrics.firstReadAt = metrics.firstReadAt || now;
  metrics.bytesProcessed += extra.bytes || 0;
  if (extra.attempts > 1) metrics.fallthroughs++;
  if (extra.clientId && metrics.clients.size < 20000) metrics.clients.add(extra.clientId);

  const d = new Date(now);
  metrics.byHour[d.getHours()]++;
  metrics.byWeekday[d.getDay()]++;

  const k = dayKey(now);
  let day = metrics.byDay.get(k);
  if (!day) {
    day = { reads: 0, ok: 0, zero: 0 };
    metrics.byDay.set(k, day);
  }
  day.reads++;

  if (code === 200) {
    day.ok++;
    if (!list.length) day.zero++;
    metrics.cards++;
    metrics.punchesReturned += list.length;
    metrics.punchesPerCard.set(list.length, (metrics.punchesPerCard.get(list.length) || 0) + 1);
    for (const p of list) {
      const c = p && p.confidence != null ? p.confidence : 1;
      metrics.confSum += c;
      metrics.confN++;
      if (c < 0.6) metrics.lowConfPunches++;
    }
    try {
      const { shifts } = readCard(layout(list));
      metrics.shiftsRead += shifts.length;
      for (const s of shifts) {
        metrics.minutesClocked += s.minutes;
        if (s.minutes > metrics.longestShiftMin) metrics.longestShiftMin = s.minutes;
        const inM = minuteOfDay(s.in);
        const outM = minuteOfDay(s.out);
        if (metrics.earliestInMin == null || inM < metrics.earliestInMin) metrics.earliestInMin = inM;
        if (metrics.latestOutMin == null || outM > metrics.latestOutMin) metrics.latestOutMin = outM;
      }
    } catch {
      /* bad punch shape - skip the shift math */
    }
  }

  if (metrics.byDay.size > 60) {
    const keys = [...metrics.byDay.keys()].sort();
    while (metrics.byDay.size > 60) metrics.byDay.delete(keys.shift());
  }
  scheduleSave();
}

export function snapshot(now = Date.now()) {
  const lat = [...metrics.latency].sort((a, b) => a - b);
  const models = {};
  for (const [name, m] of metrics.models) {
    const s = [...m.ms].sort((a, b) => a - b);
    models[name] = {
      calls: m.calls,
      ok: m.ok,
      fail: m.fail,
      p50_ms: percentile(s, 50),
      p95_ms: percentile(s, 95),
    };
  }
  const byDay = {};
  for (const [k, d] of [...metrics.byDay.entries()].sort()) byDay[k] = d;
  const perCard = {};
  for (const [n, c] of [...metrics.punchesPerCard.entries()].sort((a, b) => a[0] - b[0])) perCard[n] = c;
  const weekday = {};
  metrics.byWeekday.forEach((v, i) => (weekday[WEEKDAYS[i]] = v));

  return {
    startedAt: new Date(STARTED_AT).toISOString(),
    uptimeSec: Math.round((now - STARTED_AT) / 1000),
    firstReadAt: metrics.firstReadAt ? new Date(metrics.firstReadAt).toISOString() : null,
    lastReadAt: metrics.lastReadAt ? new Date(metrics.lastReadAt).toISOString() : null,
    preferredModel: preferredModel || null,

    reads: { ...metrics.reads },
    cardsScanned: metrics.cards,
    distinctDevices: metrics.clients.size,
    zeroPunchRate: metrics.reads.ok
      ? Number((metrics.reads.zeroPunch / metrics.reads.ok).toFixed(3))
      : 0,

    punchesRead: metrics.punchesReturned,
    shiftsRead: metrics.shiftsRead,
    hoursClocked: Number((metrics.minutesClocked / 60).toFixed(1)),
    avgPunchesPerCard: metrics.cards
      ? Number((metrics.punchesReturned / metrics.cards).toFixed(2))
      : 0,
    avgShiftMinutes: metrics.shiftsRead
      ? Math.round(metrics.minutesClocked / metrics.shiftsRead)
      : 0,
    longestShiftMinutes: metrics.longestShiftMin,
    earliestClockIn: minToHHMM(metrics.earliestInMin),
    latestClockOut: minToHHMM(metrics.latestOutMin),

    avgConfidence: metrics.confN ? Number((metrics.confSum / metrics.confN).toFixed(3)) : null,
    lowConfidenceRate: metrics.punchesReturned
      ? Number((metrics.lowConfPunches / metrics.punchesReturned).toFixed(3))
      : 0,

    geminiCalls: metrics.geminiCalls,
    modelFallthroughRate: metrics.reads.ok
      ? Number((metrics.fallthroughs / metrics.reads.ok).toFixed(3))
      : 0,
    dataProcessedMB: Number(((metrics.bytesProcessed * 0.75) / 1e6).toFixed(2)),

    latencyMs: {
      p50: percentile(lat, 50),
      p95: percentile(lat, 95),
      max: lat[lat.length - 1] || 0,
      samples: lat.length,
    },
    models,
    byDay,
    punchesPerCard: perCard,
    byHour: [...metrics.byHour],
    byWeekday: weekday,
  };
}

/* ------------------------------ persistence -------------------------- */

function serializeStats() {
  return JSON.stringify({
    v: 1,
    firstReadAt: metrics.firstReadAt,
    lastReadAt: metrics.lastReadAt,
    reads: metrics.reads,
    cards: metrics.cards,
    punchesReturned: metrics.punchesReturned,
    shiftsRead: metrics.shiftsRead,
    minutesClocked: metrics.minutesClocked,
    lowConfPunches: metrics.lowConfPunches,
    confSum: metrics.confSum,
    confN: metrics.confN,
    bytesProcessed: metrics.bytesProcessed,
    fallthroughs: metrics.fallthroughs,
    geminiCalls: metrics.geminiCalls,
    latency: metrics.latency,
    models: [...metrics.models.entries()],
    byDay: [...metrics.byDay.entries()],
    byHour: metrics.byHour,
    byWeekday: metrics.byWeekday,
    punchesPerCard: [...metrics.punchesPerCard.entries()],
    clients: [...metrics.clients],
    longestShiftMin: metrics.longestShiftMin,
    earliestInMin: metrics.earliestInMin,
    latestOutMin: metrics.latestOutMin,
  });
}

function loadStats() {
  try {
    if (!existsSync(STATS_FILE)) return;
    const d = JSON.parse(readFileSync(STATS_FILE, "utf8"));
    Object.assign(metrics.reads, d.reads || {});
    metrics.firstReadAt = d.firstReadAt ?? null;
    metrics.lastReadAt = d.lastReadAt ?? null;
    metrics.cards = d.cards || 0;
    metrics.punchesReturned = d.punchesReturned || 0;
    metrics.shiftsRead = d.shiftsRead || 0;
    metrics.minutesClocked = d.minutesClocked || 0;
    metrics.lowConfPunches = d.lowConfPunches || 0;
    metrics.confSum = d.confSum || 0;
    metrics.confN = d.confN || 0;
    metrics.bytesProcessed = d.bytesProcessed || 0;
    metrics.fallthroughs = d.fallthroughs || 0;
    metrics.geminiCalls = d.geminiCalls || 0;
    metrics.latency = Array.isArray(d.latency) ? d.latency.slice(-RING) : [];
    metrics.models = new Map(d.models || []);
    metrics.byDay = new Map(d.byDay || []);
    metrics.byHour = Array.isArray(d.byHour) && d.byHour.length === 24 ? d.byHour : new Array(24).fill(0);
    metrics.byWeekday =
      Array.isArray(d.byWeekday) && d.byWeekday.length === 7 ? d.byWeekday : new Array(7).fill(0);
    metrics.punchesPerCard = new Map(d.punchesPerCard || []);
    metrics.clients = new Set(d.clients || []);
    metrics.longestShiftMin = d.longestShiftMin || 0;
    metrics.earliestInMin = d.earliestInMin ?? null;
    metrics.latestOutMin = d.latestOutMin ?? null;
    console.log(`stats: restored ${metrics.reads.total} reads from ${STATS_FILE}`);
  } catch (e) {
    console.log("stats: load failed -", e.message);
  }
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      writeFileSync(STATS_FILE, serializeStats());
    } catch (e) {
      console.log("stats: save failed -", e.message);
    }
  }, 1500);
}
function flushStats() {
  try {
    writeFileSync(STATS_FILE, serializeStats());
  } catch {
    /* ignore */
  }
}

loadStats();

/* ------------------------------- http layer ----------------------------- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

/* Only these paths are served. Anything else (server.mjs, package.json, .env,
   dot-files, node_modules, ...) is a 404. */
const STATIC_ALLOW = new Set([
  "index.html",
  "app.mjs",
  "lib.mjs",
  "styles.css",
  "sw.js",
  "manifest.webmanifest",
  "sample-card.jpg",
  "vendor/preact.mjs",
  "vendor/hooks.mjs",
  "vendor/htm.mjs",
  "fonts/archivo.woff2",
  "icons/favicon.svg",
  "icons/favicon-48.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
]);

/* Bare requests that map to a real allow-listed file. */
const STATIC_ALIAS = { "favicon.ico": "icons/favicon-48.png" };

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
  if (tooBig) {
    recordRead(413, 0, []);
    return sendJson(res, 413, { error: "image too large" });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    recordRead(400, 0, []);
    return sendJson(res, 400, { error: "invalid JSON body" });
  }

  let clean;
  try {
    clean = validateReadBody(parsed);
  } catch (e) {
    recordRead(400, 0, []);
    return sendJson(res, 400, { error: e.message });
  }
  const bytes = clean.image.length;

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

  // Sample-card reads use the cheap models only and are left out of the
  // usage metrics so the demo doesn't skew the numbers.
  const readOpts = clean.sample ? { models: SAMPLE_MODELS, noMetrics: true } : {};

  const t0 = Date.now();
  try {
    const { punches, model, raw, finish, attempts } = await readCardImage(
      clean.image,
      clean.mimeType,
      emit,
      readOpts
    );
    const ms = Date.now() - t0;
    console.log(`/api/read done${clean.sample ? " [sample]" : ""}  ${model}  ${punches.length} punches  ${ms}ms`);
    if (!clean.sample) recordRead(200, ms, punches, { bytes, attempts, clientId: clean.clientId });
    const done = { punches, model };
    if (!punches.length) {
      done.finish = finish || null;
      done.raw = String(raw || "").slice(0, 600); // what the model actually said
    }
    emit("done", done);
  } catch (e) {
    const ms = Date.now() - t0;
    console.log(`/api/read error${clean.sample ? " [sample]" : ""}  ${ms}ms  ${e.message || e}`);
    if (!clean.sample) recordRead(e.busy ? 503 : 502, ms, [], { bytes, clientId: clean.clientId });
    emit("error", { error: e.message || String(e), busy: !!e.busy });
  }
  res.end();
}

/* -------------------------------- /stats ------------------------------ */

function statsHtml(s) {
  const row = (k, v) => `<tr><td>${k}</td><td>${v}</td></tr>`;
  const models = Object.entries(s.models)
    .map(
      ([n, m]) =>
        `<tr><td>${n}</td><td>${m.calls}</td><td>${m.ok}</td><td>${m.fail}</td><td>${m.p50_ms}</td><td>${m.p95_ms}</td></tr>`
    )
    .join("");
  const barRow = (label, val, max) =>
    `<div class="d"><span class="k">${label}</span><span class="bar" style="width:${Math.round(
      (val / Math.max(1, max)) * 100
    )}%"></span><span class="n">${val}</span></div>`;
  const days = Object.entries(s.byDay);
  const maxReads = Math.max(1, ...days.map(([, d]) => d.reads));
  const dayBars = days
    .map(
      ([k, d]) =>
        `<div class="d"><span class="k">${k}</span><span class="bar" style="width:${Math.round(
          (d.reads / maxReads) * 100
        )}%"></span><span class="n">${d.reads} r / ${d.ok} ok / ${d.zero} zero</span></div>`
    )
    .join("");
  const hourMax = Math.max(1, ...s.byHour);
  const hourBars = s.byHour
    .map((v, h) => barRow(String(h).padStart(2, "0") + ":00", v, hourMax))
    .join("");
  const wdMax = Math.max(1, ...Object.values(s.byWeekday));
  const wdBars = Object.entries(s.byWeekday)
    .map(([w, v]) => barRow(w, v, wdMax))
    .join("");
  const pcMax = Math.max(1, ...Object.values(s.punchesPerCard));
  const pcBars = Object.entries(s.punchesPerCard)
    .map(([n, v]) => barRow(n + " punches", v, pcMax))
    .join("");
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>punchcard stats</title><style>
:root{--ink:#201e1d;--red:#ec3013}
body{margin:0;padding:24px;font:14px/1.5 ui-monospace,Menlo,Consolas,monospace;color:var(--ink);background:#fff}
h1{font-size:16px;letter-spacing:.06em;text-transform:uppercase;border-bottom:2px solid var(--ink);padding-bottom:8px}
h2{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#605d5d;margin:22px 0 8px}
table{border-collapse:collapse;width:100%;max-width:520px}
td,th{border:1px solid var(--ink);padding:5px 9px;text-align:left}
th{background:#f3f2f2;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.d{display:flex;align-items:center;gap:8px;max-width:640px;margin:2px 0;font-size:12px}
.d .k{width:110px;flex:none}
.d .bar{height:12px;background:var(--red);flex:none;min-width:2px}
.d .n{color:#605d5d}
</style>
<h1>punchcard / ops</h1>
<table>
${row("started / uptime", s.startedAt + " (" + s.uptimeSec + " s)")}
${row("first read", s.firstReadAt || "-")}
${row("last read", s.lastReadAt || "-")}
${row("preferred model", s.preferredModel || "-")}
${row("reads (total)", s.reads.total)}
${row("ok / zero-punch / bad / upstream / busy", [s.reads.ok, s.reads.zeroPunch, s.reads.badRequest, s.reads.upstream, s.reads.busy].join(" / "))}
${row("cards scanned", s.cardsScanned)}
${row("distinct devices", s.distinctDevices)}
${row("zero-punch rate", s.zeroPunchRate)}
${row("punches read", s.punchesRead)}
${row("shifts read", s.shiftsRead)}
${row("hours clocked", s.hoursClocked)}
${row("avg punches / card", s.avgPunchesPerCard)}
${row("avg shift (min)", s.avgShiftMinutes)}
${row("longest shift (min)", s.longestShiftMinutes)}
${row("earliest clock-in / latest clock-out", (s.earliestClockIn || "-") + " / " + (s.latestClockOut || "-"))}
${row("avg confidence", s.avgConfidence ?? "-")}
${row("low-confidence rate", s.lowConfidenceRate)}
${row("gemini calls", s.geminiCalls)}
${row("model fallthrough rate", s.modelFallthroughRate)}
${row("data processed (MB)", s.dataProcessedMB)}
${row("latency p50 / p95 / max ms", s.latencyMs.p50 + " / " + s.latencyMs.p95 + " / " + s.latencyMs.max)}
</table>
<h2>Models</h2>
<table><tr><th>model</th><th>calls</th><th>ok</th><th>fail</th><th>p50 ms</th><th>p95 ms</th></tr>${models || '<tr><td colspan=6>none yet</td></tr>'}</table>
<h2>Reads by day</h2>
${dayBars || "<p>none yet</p>"}
<h2>Reads by hour</h2>
${hourBars}
<h2>Reads by weekday</h2>
${wdBars}
<h2>Punches per card</h2>
${pcBars || "<p>none yet</p>"}`;
}

function handleStats(req, res) {
  const url = new URL(req.url, "http://x");
  const snap = snapshot();
  const wantsHtml = /text\/html/.test(req.headers.accept || "") || url.searchParams.has("html");
  if (wantsHtml) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(statsHtml(snap));
  } else {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(snap, null, 2));
  }
}

/* Resolve a request path to an allow-listed file name, or null. */
export function staticTarget(urlPath) {
  let p;
  try {
    p = decodeURIComponent(String(urlPath).split("?")[0]);
  } catch {
    return null;
  }
  let rel = normalize(p === "/" ? "index.html" : p.replace(/^\/+/, "")).replace(/\\/g, "/");
  if (STATIC_ALIAS[rel]) rel = STATIC_ALIAS[rel];
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
      "Cache-Control":
        rel === "index.html" || rel === "sw.js" ? "no-cache" : "public, max-age=3600",
    });
    res.end(req.method === "HEAD" ? undefined : buf);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
  }
}

export const server = createServer((req, res) => {
  const path = (req.url || "").split("?")[0];
  if (req.method === "POST" && path === "/api/read") {
    handleRead(req, res).catch((e) => sendJson(res, 500, { error: String(e) }));
    return;
  }
  if (req.method === "GET") {
    if (path === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" }).end("ok");
      return;
    }
    if (path === "/stats") {
      handleStats(req, res);
      return;
    }
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
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
      flushStats();
      process.exit(0);
    });
  }
}

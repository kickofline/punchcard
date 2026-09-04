/* punchcard server: serves the static app and proxies card photos to the
   Gemini vision API so the API key never reaches the browser.

   Env:
     GEMINI_API_KEY     required for /api/read
     GEMINI_MODEL       comma list, tried in order when one is busy / out of
                        quota / missing / slow. Default leads with the lite
                        models, which /stats has shown to be both faster and
                        more reliable right now, then climbs to the heavier
                        flash models as a fallback.
     GEMINI_TIMEOUT_MS  per-model deadline before giving up on it (default 15000)
     STATS_FILE         where usage metrics persist (default ./.stats.json)
     CONTRIB_DIR        where opted-in card photos + reader output are kept for
                        quality review (default: a "contrib" dir next to
                        STATS_FILE). Set CONTRIB_DIR= (empty) to disable.
     CONTRIB_MAX        keep at most this many samples, oldest deleted first
                        (default 3000)
     CONTRIB_TOKEN      gate the /contrib review page + its endpoints; when
                        unset those are reachable only from localhost
     PORT               default 3000
     HOST               default 0.0.0.0 (all interfaces); 127.0.0.1 for local only
*/

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  rmSync,
} from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { argv } from "node:process";
import { layout, readCard } from "./lib.mjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0"; // all interfaces; set HOST=127.0.0.1 to keep it local
const CALL_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 15000);
const STATS_FILE = process.env.STATS_FILE || join(ROOT, ".stats.json");
const CONTRIB_DIR =
  process.env.CONTRIB_DIR ?? join(dirname(STATS_FILE), "contrib");
const CONTRIB_MAX = Number(process.env.CONTRIB_MAX || 3000);
const CONTRIB_TOKEN = process.env.CONTRIB_TOKEN || ""; // gate /contrib; blank = loopback only
const API_KEY = process.env.GEMINI_API_KEY || "";
const MODELS = (
  process.env.GEMINI_MODEL ||
  [
    "gemini-3.5-flash-lite",
    "gemini-flash-lite-latest",
    "gemini-3.5-flash",
    "gemini-3.6-flash",
    "gemini-3.7-flash",
    "gemini-flash-latest",
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
  // the client opts in (its checkbox defaults on) to keeping the photo +
  // reader output to improve accuracy; never for the built-in sample card
  const contribute = !sample && !!(body && body.contribute === true);
  // "fast mode": run the read on the lite model pool only
  const fast = !sample && !!(body && body.fast === true);
  return { image, mimeType, clientId, sample, contribute, fast };
}

/* Contribution ids are a timestamp + short suffix; keep any lookup strictly to
   that shape so a request can't walk out of CONTRIB_DIR. */
export function safeId(s) {
  return typeof s === "string" && /^[0-9TZ:.\-]{20,32}_[a-z0-9]{4,10}$/.test(s) ? s : null;
}

/* Why a read looks worth a human's eyes, plus a weight to sort the queue by. */
export function suspectFlags(punches, finish) {
  const flags = [];
  const list = Array.isArray(punches) ? punches : [];
  if (!list.length) flags.push("zero-punch");
  else {
    if (list.length < 2) flags.push("few-punches");
    if (list.some((p) => p && p.confidence != null && p.confidence < 0.6)) flags.push("low-conf");
    try {
      const { shifts, notes } = readCard(layout(list));
      if (notes && notes.length) flags.push("pair-note");
      if (shifts.some((s) => s.bad)) flags.push("bad-shift");
      if (shifts.some((s) => s.out && s.minutes > 16 * 60)) flags.push("long-shift");
    } catch {
      flags.push("pair-fail");
    }
  }
  if (finish && !/^stop$/i.test(String(finish))) flags.push("truncated");
  const w = {
    "zero-punch": 5,
    "pair-fail": 4,
    "bad-shift": 3,
    "pair-note": 2,
    "low-conf": 2,
    "long-shift": 2,
    truncated: 2,
    "few-punches": 1,
  };
  const score = flags.reduce((n, f) => n + (w[f] || 1), 0);
  return { flags, score };
}

/* A compact "what changed" key for one corrected row, for the misread tally. */
export function misreadKey(was, now) {
  if (!was || !now) return null;
  if (was.type !== now.type) return `${was.type}->${now.type}`;
  if (was.time !== now.time) return `${was.time}->${now.time}`;
  if (was.date !== now.date) return "date";
  return null;
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
    if (!opts.noMetrics) {
      const kind =
        status === 200
          ? "ok"
          : isQuotaError(status, body)
            ? "quota"
            : body && body.error && body.error.status === "DEADLINE"
              ? "timeout"
              : shouldFallThrough(status, body)
                ? "busy"
                : "error";
      recordModelCall(model, ms, kind);
    }
    console.log(`  ${model} ${status} ${ms}ms`);
    if (status === 200) {
      const cand = body.candidates && body.candidates[0];
      const text = ((cand && cand.content && cand.content.parts) || [])
        .map((p) => p.text || "")
        .join("");
      const finish = cand && cand.finishReason;
      if (!opts.models) preferredModel = model;
      if (!opts.noMetrics) metrics.modelWins.set(model, (metrics.modelWins.get(model) || 0) + 1);
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
  contributed: 0, // reads whose photo + output the user let us keep
  contribReports: 0, // contributed reads the client later reported a final state for
  contribEditedReads: 0, // ...of those, how many had at least one row edited
  contribLabeled: 0, // contributed reads a reviewer has marked ok / bad
  misreads: new Map(), // "was->now" -> count, from reported edits
  geminiCalls: 0,
  latency: [],
  recent: [], // last N read outcomes, 1 = non-200, for a rolling error rate
  models: new Map(), // name -> { calls, ok, fail, quota, busy, timeout, ms: [] }
  modelWins: new Map(), // name -> reads this model was the one that succeeded
  byDay: new Map(), // "YYYY-MM-DD" -> { reads, ok, zero }
  byHour: new Array(24).fill(0),
  byWeekday: new Array(7).fill(0),
  punchesPerCard: new Map(), // count -> occurrences
  clients: new Set(),
  longestShiftMin: 0,
  earliestInMin: null,
  latestOutMin: null,
};

const ringPush = (arr, v, cap = RING) => {
  arr.push(v);
  if (arr.length > cap) arr.shift();
};
const RECENT = 200;
const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function recordModelCall(model, ms, kind) {
  metrics.geminiCalls++;
  let m = metrics.models.get(model);
  if (!m) {
    m = { calls: 0, ok: 0, fail: 0, quota: 0, busy: 0, timeout: 0, ms: [] };
    metrics.models.set(model, m);
  }
  m.calls++;
  if (kind === "ok") m.ok++;
  else {
    m.fail++;
    if (kind === "quota") m.quota++;
    else if (kind === "timeout") m.timeout++;
    else if (kind === "busy") m.busy++;
  }
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
  ringPush(metrics.recent, code === 200 ? 0 : 1, RECENT);
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
      quota: m.quota || 0,
      busy: m.busy || 0,
      timeout: m.timeout || 0,
      wins: metrics.modelWins.get(name) || 0,
      quotaRate: m.calls ? Number(((m.quota || 0) / m.calls).toFixed(3)) : 0,
      busyRate: m.calls ? Number((((m.busy || 0) + (m.timeout || 0)) / m.calls).toFixed(3)) : 0,
      p50_ms: percentile(s, 50),
      p95_ms: percentile(s, 95),
    };
  }
  const modelWins = {};
  for (const [n, c] of [...metrics.modelWins.entries()].sort((a, b) => b[1] - a[1])) modelWins[n] = c;
  const recent = metrics.recent;
  const errRate = (n) => {
    const w = n ? recent.slice(-n) : recent;
    return w.length ? Number((w.reduce((a, b) => a + b, 0) / w.length).toFixed(3)) : 0;
  };
  const byDay = {};
  for (const [k, d] of [...metrics.byDay.entries()].sort()) {
    byDay[k] = { ...d, err: d.reads - d.ok };
  }
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
    errorRate: {
      last20: errRate(20),
      last100: errRate(100),
      allTime: metrics.reads.total
        ? Number(((metrics.reads.total - metrics.reads.ok) / metrics.reads.total).toFixed(3))
        : 0,
      window: recent.length,
    },
    modelWins,
    contributedSamples: metrics.contributed,
    accuracy: {
      reportedReads: metrics.contribReports,
      editedReads: metrics.contribEditedReads,
      cleanRate: metrics.contribReports
        ? Number(
            ((metrics.contribReports - metrics.contribEditedReads) / metrics.contribReports).toFixed(3)
          )
        : null,
      labeled: metrics.contribLabeled,
      topMisreads: [...metrics.misreads.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
    },
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
    contributed: metrics.contributed,
    contribReports: metrics.contribReports,
    contribEditedReads: metrics.contribEditedReads,
    contribLabeled: metrics.contribLabeled,
    misreads: [...metrics.misreads.entries()],
    geminiCalls: metrics.geminiCalls,
    latency: metrics.latency,
    recent: metrics.recent,
    models: [...metrics.models.entries()],
    modelWins: [...metrics.modelWins.entries()],
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
    metrics.contributed = d.contributed || 0;
    metrics.contribReports = d.contribReports || 0;
    metrics.contribEditedReads = d.contribEditedReads || 0;
    metrics.contribLabeled = d.contribLabeled || 0;
    metrics.misreads = new Map(d.misreads || []);
    metrics.geminiCalls = d.geminiCalls || 0;
    metrics.latency = Array.isArray(d.latency) ? d.latency.slice(-RING) : [];
    metrics.recent = Array.isArray(d.recent) ? d.recent.slice(-RECENT) : [];
    metrics.models = new Map(
      (d.models || []).map(([k, m]) => [
        k,
        { calls: 0, ok: 0, fail: 0, quota: 0, busy: 0, timeout: 0, ms: [], ...m },
      ])
    );
    metrics.modelWins = new Map(d.modelWins || []);
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

/* --------------------- opt-in training contributions ------------------- */

const EXT_FOR = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "image/heif": "heif" };
let contribReady = false;

function ensureContribDir() {
  if (!CONTRIB_DIR) return false;
  if (!contribReady) {
    try {
      mkdirSync(CONTRIB_DIR, { recursive: true });
      contribReady = true;
    } catch (e) {
      console.log("contrib: cannot use", CONTRIB_DIR, "-", e.message);
      return false;
    }
  }
  return true;
}

/* Trim the store to CONTRIB_MAX samples, oldest first (a sample is a .json +
   its sibling image, so the cap counts json files). */
function trimContrib() {
  try {
    const metas = readdirSync(CONTRIB_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ f, t: statSync(join(CONTRIB_DIR, f)).mtimeMs }))
      .sort((a, b) => a.t - b.t);
    for (let i = 0; i < metas.length - CONTRIB_MAX; i++) {
      const base = metas[i].f.replace(/\.json$/, "");
      for (const g of readdirSync(CONTRIB_DIR).filter((x) => x.startsWith(base + ".")))
        rmSync(join(CONTRIB_DIR, g), { force: true });
    }
  } catch (e) {
    /* best effort */
  }
}

const contribPath = (id, ext) => join(CONTRIB_DIR, `${id}.${ext}`);

function readContrib(id) {
  try {
    return JSON.parse(readFileSync(contribPath(id, "json"), "utf8"));
  } catch {
    return null;
  }
}
function writeContrib(id, obj) {
  try {
    writeFileSync(contribPath(id, "json"), JSON.stringify(obj, null, 2));
    return true;
  } catch (e) {
    console.log("contrib: update failed -", e.message);
    return false;
  }
}
function bumpMisread(key) {
  if (!key) return;
  metrics.misreads.set(key, (metrics.misreads.get(key) || 0) + 1);
  if (metrics.misreads.size > 300) {
    const lowest = [...metrics.misreads.entries()].sort((a, b) => a[1] - b[1])[0];
    if (lowest) metrics.misreads.delete(lowest[0]);
  }
}

/* Persist one opted-in read: the raw photo plus what the model returned.
   Fire-and-forget; a failure here must never affect the response. Returns the
   id so the client can attach follow-up edits (POST /api/correction). */
function storeContribution({ image, mimeType, clientId, model, attempts, ms, punches, raw, finish }) {
  if (!ensureContribDir()) return null;
  try {
    const id =
      new Date().toISOString().replace(/[:.]/g, "-") +
      "_" +
      Math.random().toString(36).slice(2, 8);
    const ext = EXT_FOR[mimeType] || "bin";
    const { flags, score } = suspectFlags(punches, finish);
    writeFileSync(contribPath(id, ext), Buffer.from(image, "base64"));
    writeContrib(id, {
      id,
      at: new Date().toISOString(),
      clientId: clientId || null,
      model: model || null,
      attempts: attempts || 1,
      ms: ms || null,
      mimeType,
      ext,
      bytes: Buffer.byteLength(image, "base64"),
      punchCount: punches.length,
      punches,
      finish: finish || null,
      rawText: typeof raw === "string" ? raw.slice(0, 4000) : null,
      flags,
      suspectScore: score,
      report: null, // filled by POST /api/correction
      label: null, // filled by the /contrib review page
    });
    metrics.contributed++;
    scheduleSave();
    if (metrics.contributed % 25 === 0) trimContrib();
    return id;
  } catch (e) {
    console.log("contrib: write failed -", e.message);
    return null;
  }
}

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
  "scan.mjs",
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

/* One greppable key=value line per read. */
function logRead(o) {
  const parts = [];
  for (const [k, v] of Object.entries(o)) {
    if (v === null || v === undefined || v === false) continue;
    parts.push(`${k}=${typeof v === "string" && /[\s"]/.test(v) ? JSON.stringify(v) : v}`);
  }
  console.log("read " + parts.join(" "));
}

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

  // Sample-card reads use the cheap models only and are left out of the usage
  // metrics so the demo doesn't skew the numbers. "Fast mode" also pins the
  // lite pool, but counts and can be contributed like any real read.
  const readOpts = clean.sample
    ? { models: SAMPLE_MODELS, noMetrics: true }
    : clean.fast
      ? { models: SAMPLE_MODELS }
      : {};

  const t0 = Date.now();
  try {
    const { punches, model, raw, finish, attempts } = await readCardImage(
      clean.image,
      clean.mimeType,
      emit,
      readOpts
    );
    const ms = Date.now() - t0;
    if (!clean.sample) recordRead(200, ms, punches, { bytes, attempts, clientId: clean.clientId });
    let contribId = null;
    if (clean.contribute) {
      contribId = storeContribution({
        image: clean.image,
        mimeType: clean.mimeType,
        clientId: clean.clientId,
        model,
        attempts,
        ms,
        punches,
        raw,
        finish,
      });
    }
    logRead({
      id: contribId,
      code: 200,
      model,
      ms,
      punches: punches.length,
      attempts,
      sample: clean.sample,
      fast: clean.fast,
      contributed: !!contribId,
      client: clean.clientId,
      flags: suspectFlags(punches, finish).flags.join(",") || null,
    });
    const done = { punches, model };
    if (contribId) done.contribId = contribId;
    if (!punches.length) {
      done.finish = finish || null;
      done.raw = String(raw || "").slice(0, 600); // what the model actually said
    }
    emit("done", done);
  } catch (e) {
    const ms = Date.now() - t0;
    if (!clean.sample) recordRead(e.busy ? 503 : 502, ms, [], { bytes, clientId: clean.clientId });
    logRead({
      id: null,
      code: e.busy ? 503 : 502,
      model: null,
      ms,
      punches: 0,
      sample: clean.sample,
      fast: clean.fast,
      contributed: false,
      client: clean.clientId,
      error: e.message || String(e),
    });
    emit("error", { error: e.message || String(e), busy: !!e.busy });
  }
  res.end();
}

/* -------------------- corrections + /contrib review ------------------- */

async function readBody(req, cap = 2 * 1024 * 1024) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > cap) throw new Error("body too large");
  }
  return raw ? JSON.parse(raw) : {};
}

const cleanPunch = (p) =>
  p && typeof p === "object"
    ? {
        type: p.type === "OUT" ? "OUT" : "IN",
        date: /^\d{4}-\d{2}-\d{2}$/.test(p.date) ? p.date : "",
        time: /^\d{2}:\d{2}$/.test(p.time) ? p.time : "",
        ...(p.confidence != null ? { confidence: Math.max(0, Math.min(1, Number(p.confidence) || 0)) } : {}),
      }
    : null;

/* The client tells us the final state of a contributed read once the user is
   done with it: which rows they changed, and to what. Best signal we get. */
async function handleCorrection(req, res) {
  let body;
  try {
    body = await readBody(req, 512 * 1024);
  } catch {
    return sendJson(res, 400, { error: "bad body" });
  }
  const id = safeId(body && body.id);
  if (!id) return sendJson(res, 400, { error: "bad id" });
  const rec = readContrib(id);
  if (!rec) return sendJson(res, 404, { error: "unknown id" });
  if (rec.report) return sendJson(res, 200, { ok: true, note: "already reported" });

  const edits = Array.isArray(body.edits) ? body.edits.slice(0, 60) : [];
  const finalPunches = Array.isArray(body.punches)
    ? body.punches.map(cleanPunch).filter((p) => p && p.date && p.time).slice(0, 60)
    : [];
  const editedRows = edits.length;

  rec.report = {
    at: new Date().toISOString(),
    editedRows,
    punches: finalPunches,
    edits: edits.map((e) => ({
      slot: Number.isInteger(e && e.slot) ? e.slot : null,
      was: cleanPunch(e && e.was),
      now: cleanPunch(e && e.now),
    })),
  };
  writeContrib(id, rec);

  metrics.contribReports++;
  if (editedRows > 0) metrics.contribEditedReads++;
  for (const e of rec.report.edits) bumpMisread(misreadKey(e.was, e.now));
  scheduleSave();
  res.writeHead(204).end();
}

function contribAuthed(req) {
  if (!CONTRIB_DIR) return false;
  const url = new URL(req.url, "http://x");
  const t =
    url.searchParams.get("token") || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (CONTRIB_TOKEN) return t === CONTRIB_TOKEN;
  const ra = req.socket.remoteAddress || "";
  return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ra);
}
const contribDeny = (res) =>
  res.writeHead(CONTRIB_DIR ? 403 : 404, { "Content-Type": "text/plain" }).end(
    CONTRIB_DIR ? "forbidden - set CONTRIB_TOKEN and pass ?token=" : "not found"
  );

function listContrib(limit = 40, offset = 0) {
  let files;
  try {
    files = readdirSync(CONTRIB_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return { items: [], total: 0 };
  }
  files.sort().reverse(); // ids start with an ISO timestamp -> newest first
  const total = files.length;
  const items = [];
  for (const f of files.slice(offset, offset + limit)) {
    const rec = readContrib(f.replace(/\.json$/, ""));
    if (rec) items.push(rec);
  }
  return { items, total };
}

function handleContribList(req, res) {
  if (!contribAuthed(req)) return contribDeny(res);
  const url = new URL(req.url, "http://x");
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 40)));
  const offset = Math.max(0, Number(url.searchParams.get("offset") || 0));
  const sort = url.searchParams.get("sort");
  const { items, total } = listContrib(sort === "suspect" ? 500 : limit, sort === "suspect" ? 0 : offset);
  let out = items;
  if (sort === "suspect") {
    out = items
      .filter((r) => !r.label)
      .sort((a, b) => (b.suspectScore || 0) - (a.suspectScore || 0))
      .slice(0, limit);
  }
  sendJson(res, 200, { total, count: out.length, items: out });
}

function handleContribAsset(req, res) {
  if (!contribAuthed(req)) return contribDeny(res);
  const id = safeId(decodeURIComponent((req.url.split("?")[0].split("/").pop() || "").replace(/\.[a-z0-9]+$/i, "")));
  const rec = id && readContrib(id);
  if (!rec) return res.writeHead(404).end("not found");
  try {
    const buf = readFileSync(contribPath(id, rec.ext || "jpg"));
    res.writeHead(200, { "Content-Type": rec.mimeType || "image/jpeg", "Cache-Control": "private, max-age=600" });
    res.end(buf);
  } catch {
    res.writeHead(404).end("not found");
  }
}

async function handleContribLabel(req, res) {
  if (!contribAuthed(req)) return contribDeny(res);
  let body;
  try {
    body = await readBody(req, 512 * 1024);
  } catch {
    return sendJson(res, 400, { error: "bad body" });
  }
  const id = safeId(body && body.id);
  if (!id) return sendJson(res, 400, { error: "bad id" });
  const rec = readContrib(id);
  if (!rec) return sendJson(res, 404, { error: "unknown id" });
  const verdict = body.verdict === "bad" ? "bad" : body.verdict === "ok" ? "ok" : null;
  if (!verdict) return sendJson(res, 400, { error: "verdict must be ok or bad" });
  const wasLabeled = !!rec.label;
  rec.label = {
    at: new Date().toISOString(),
    verdict,
    punches: Array.isArray(body.punches)
      ? body.punches.map(cleanPunch).filter((p) => p && p.date && p.time).slice(0, 60)
      : rec.punches,
  };
  writeContrib(id, rec);
  if (!wasLabeled) metrics.contribLabeled++;
  scheduleSave();
  sendJson(res, 200, { ok: true });
}

function handleContribExport(req, res) {
  if (!contribAuthed(req)) return contribDeny(res);
  const { items } = listContrib(100000, 0);
  const lines = items
    .filter((r) => r.label)
    .map((r) =>
      JSON.stringify({
        id: r.id,
        at: r.at,
        model: r.model,
        image: `${r.id}.${r.ext || "jpg"}`,
        modelPunches: r.punches,
        verdict: r.label.verdict,
        truthPunches: r.label.punches,
        reportedPunches: r.report ? r.report.punches : null,
      })
    );
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Content-Disposition": 'attachment; filename="punchcard-labeled.ndjson"',
  });
  res.end(lines.join("\n") + (lines.length ? "\n" : ""));
}

function handleContribPage(req, res) {
  if (!contribAuthed(req)) return contribDeny(res);
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(contribHtml());
}

function contribHtml() {
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>punchcard / contrib</title><style>
:root{--ink:#201e1d;--red:#ec3013;--bg:#f3f2f2}
*{box-sizing:border-box}
body{margin:0;padding:20px;font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;color:var(--ink);background:#fff}
h1{font-size:15px;letter-spacing:.06em;text-transform:uppercase;border-bottom:2px solid var(--ink);padding-bottom:8px}
.bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:12px 0}
button,select{font:inherit;border:2px solid var(--ink);background:#fff;padding:5px 10px;cursor:pointer;text-transform:uppercase;letter-spacing:.04em}
button.on{background:var(--ink);color:#fff}
a{color:var(--red)}
.card{border:2px solid var(--ink);margin:14px 0;display:grid;grid-template-columns:260px 1fr;gap:0}
.card img{width:100%;display:block;border-right:2px solid var(--ink);background:var(--bg)}
.meta{padding:12px;overflow:auto}
.flags span{display:inline-block;border:1px solid var(--red);color:var(--red);padding:0 6px;margin:0 4px 4px 0;font-size:11px;text-transform:uppercase}
.k{color:#605d5d}
table{border-collapse:collapse;margin:8px 0}
td{border:1px solid #ccc;padding:2px 7px}
textarea{width:100%;min-height:120px;font:inherit;border:2px solid var(--ink);padding:8px}
.act{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}
.tag{font-size:11px;text-transform:uppercase;padding:2px 6px;border:1px solid var(--ink)}
.tag.ok{background:#1a7f37;color:#fff;border-color:#1a7f37}
.tag.bad{background:var(--red);color:#fff;border-color:var(--red)}
@media(max-width:640px){.card{grid-template-columns:1fr}.card img{border-right:0;border-bottom:2px solid var(--ink)}}
</style>
<h1>punchcard / contrib review</h1>
<div class="bar">
  <button id="s-new" class="on">Newest</button>
  <button id="s-sus">Most suspect</button>
  <span class="k" id="count"></span>
  <a id="export" href="#">Export labeled &darr;</a>
  <button id="more">Load more</button>
</div>
<div id="list"></div>
<script>
const qs = new URLSearchParams(location.search);
const tok = qs.get("token") || "";
const withTok = (u) => u + (u.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(tok);
document.getElementById("export").href = withTok("/contrib/export");
let sort = "new", offset = 0;
const listEl = document.getElementById("list");

function punchTable(ps) {
  if (!ps || !ps.length) return "<i>none</i>";
  return "<table>" + ps.map(p =>
    "<tr><td>"+p.type+"</td><td>"+p.date+"</td><td>"+p.time+"</td><td>"+(p.confidence!=null?p.confidence:"")+"</td></tr>").join("") + "</table>";
}
function card(r) {
  const el = document.createElement("div");
  el.className = "card";
  const labelTag = r.label ? '<span class="tag '+r.label.verdict+'">labeled '+r.label.verdict+'</span>' : "";
  const rep = r.report ? '<span class="tag">reported: '+r.report.editedRows+' edits</span>' : "";
  el.innerHTML =
    '<img loading="lazy" src="'+withTok("/contrib/asset/"+r.id)+'">' +
    '<div class="meta">' +
      '<div class="k">'+r.id+'</div>' +
      '<div>'+ (r.model||"?") +' &middot; '+r.punchCount+' punches &middot; '+Math.round((r.bytes||0)/1024)+' kB &middot; score '+(r.suspectScore||0)+' '+labelTag+' '+rep+'</div>' +
      '<div class="flags">'+(r.flags||[]).map(f=>"<span>"+f+"</span>").join("")+'</div>' +
      '<div class="k">model output</div>'+ punchTable(r.punches) +
      (r.report && r.report.punches && r.report.punches.length ? '<div class="k">user\\'s final</div>'+punchTable(r.report.punches) : "") +
      '<div class="k">truth (editable JSON)</div>' +
      '<textarea>'+ JSON.stringify((r.label&&r.label.punches)||(r.report&&r.report.punches)||r.punches, null, 1) +'</textarea>' +
      '<div class="act">' +
        '<button data-v="ok">Mark OK</button>' +
        '<button data-v="bad">Mark WRONG + save truth</button>' +
        '<span class="k save-note"></span>' +
      '</div>' +
    '</div>';
  const ta = el.querySelector("textarea");
  const note = el.querySelector(".save-note");
  el.querySelectorAll("button[data-v]").forEach(b => b.onclick = async () => {
    let punches;
    try { punches = JSON.parse(ta.value); } catch { note.textContent = "bad JSON"; return; }
    note.textContent = "saving…";
    const res = await fetch(withTok("/contrib/label"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: r.id, verdict: b.dataset.v, punches }),
    });
    note.textContent = res.ok ? "saved" : "error";
  });
  return el;
}

async function load(reset) {
  if (reset) { offset = 0; listEl.innerHTML = ""; }
  const u = withTok("/contrib/list?limit=25&offset="+offset+"&sort="+(sort==="sus"?"suspect":"new"));
  const data = await (await fetch(u)).json();
  document.getElementById("count").textContent = data.total + " total";
  data.items.forEach(r => listEl.appendChild(card(r)));
  offset += data.items.length;
}
document.getElementById("s-new").onclick = (e) => { sort="new"; e.target.classList.add("on"); document.getElementById("s-sus").classList.remove("on"); load(true); };
document.getElementById("s-sus").onclick = (e) => { sort="sus"; e.target.classList.add("on"); document.getElementById("s-new").classList.remove("on"); load(true); };
document.getElementById("more").onclick = () => load(false);
load(true);
</script>`;
}

/* -------------------------------- /stats ------------------------------ */

function statsHtml(s) {
  const row = (k, v) => `<tr><td>${k}</td><td>${v}</td></tr>`;
  const pct = (x) => (x * 100).toFixed(1) + "%";
  const models = Object.entries(s.models)
    .map(
      ([n, m]) =>
        `<tr><td>${n}</td><td>${m.calls}</td><td>${m.ok}</td><td>${m.wins}</td><td>${m.quota}</td><td>${m.busy}</td><td>${m.timeout}</td><td>${pct(m.quotaRate)}</td><td>${pct(m.busyRate)}</td><td>${m.p50_ms}</td><td>${m.p95_ms}</td></tr>`
    )
    .join("");
  const barRow = (label, val, max) =>
    `<div class="d"><span class="k">${label}</span><span class="bar" style="width:${Math.round(
      (val / Math.max(1, max)) * 100
    )}%"></span><span class="n">${val}</span></div>`;
  const spark = (vals) => {
    const c = "▁▂▃▄▅▆▇█";
    const max = Math.max(1, ...vals);
    return vals.map((v) => c[Math.min(7, Math.round((v / max) * 7))]).join("") || "-";
  };
  const winEntries = Object.entries(s.modelWins);
  const winMax = Math.max(1, ...winEntries.map(([, v]) => v));
  const winTotal = winEntries.reduce((a, [, v]) => a + v, 0) || 1;
  const winBars = winEntries
    .map(
      ([n, v]) =>
        `<div class="d"><span class="k">${n}</span><span class="bar" style="width:${Math.round(
          (v / winMax) * 100
        )}%"></span><span class="n">${v} (${((v / winTotal) * 100).toFixed(0)}%)</span></div>`
    )
    .join("");
  const days = Object.entries(s.byDay);
  const last30 = days.slice(-30);
  const readsSpark = spark(last30.map(([, d]) => d.reads));
  const errSpark = spark(last30.map(([, d]) => (d.reads ? (d.err / d.reads) * 100 : 0)));
  const maxReads = Math.max(1, ...days.map(([, d]) => d.reads));
  const dayBars = days
    .map(
      ([k, d]) =>
        `<div class="d"><span class="k">${k}</span><span class="bar" style="width:${Math.round(
          (d.reads / maxReads) * 100
        )}%"></span><span class="n">${d.reads} r / ${d.ok} ok / ${d.err} err / ${d.zero} zero</span></div>`
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
.spark{font-size:22px;letter-spacing:3px;line-height:1;margin:6px 0;color:var(--red)}
.spark .lbl{display:block;font-size:11px;letter-spacing:.04em;color:#605d5d;margin-top:2px}
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
${row("error rate  last20 / last100 / all", [pct(s.errorRate.last20), pct(s.errorRate.last100), pct(s.errorRate.allTime)].join(" / ") + "  (n=" + s.errorRate.window + ")")}
${row("shared samples kept", s.contributedSamples)}
${row("data processed (MB)", s.dataProcessedMB)}
${row("latency p50 / p95 / max ms", s.latencyMs.p50 + " / " + s.latencyMs.p95 + " / " + s.latencyMs.max)}
</table>
<h2>Which model got the read</h2>
${winBars || "<p>none yet</p>"}
<h2>Models</h2>
<table><tr><th>model</th><th>calls</th><th>ok</th><th>wins</th><th>quota</th><th>busy</th><th>t/o</th><th>quota %</th><th>busy %</th><th>p50 ms</th><th>p95 ms</th></tr>${models || '<tr><td colspan=11>none yet</td></tr>'}</table>
<h2>Reads / day (last 30)</h2>
<div class="spark">${readsSpark}<span class="lbl">reads per day</span></div>
<div class="spark">${errSpark}<span class="lbl">error rate per day</span></div>
<h2>Reads by day</h2>
${dayBars || "<p>none yet</p>"}
<h2>Reads by hour</h2>
${hourBars}
<h2>Reads by weekday</h2>
${wdBars}
<h2>Punches per card</h2>
${pcBars || "<p>none yet</p>"}
<h2>Read accuracy (from shared cards)</h2>
${
  s.accuracy.reportedReads
    ? `<table>${row("clean rate (no rows edited)", pct(s.accuracy.cleanRate))}${row(
        "reads reported / edited",
        s.accuracy.reportedReads + " / " + s.accuracy.editedReads
      )}${row("reviewer-labeled", s.accuracy.labeled)}</table>` +
      (s.accuracy.topMisreads.length
        ? "<h2>Top misreads (was &rarr; corrected)</h2>" +
          s.accuracy.topMisreads
            .map(([k, v]) => barRow(k, v, s.accuracy.topMisreads[0][1]))
            .join("")
        : "")
    : "<p>no reads reported back yet</p>"
}`;
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
  if (req.method === "POST" && path === "/api/correction") {
    handleCorrection(req, res).catch((e) => sendJson(res, 500, { error: String(e) }));
    return;
  }
  if (req.method === "POST" && path === "/contrib/label") {
    handleContribLabel(req, res).catch((e) => sendJson(res, 500, { error: String(e) }));
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
    if (path === "/contrib") return handleContribPage(req, res);
    if (path === "/contrib/list") return handleContribList(req, res);
    if (path === "/contrib/export") return handleContribExport(req, res);
    if (path.startsWith("/contrib/asset/")) return handleContribAsset(req, res);
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

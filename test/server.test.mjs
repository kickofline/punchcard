import { test } from "node:test";
import assert from "node:assert/strict";

import {
  punchesFromGeminiText,
  isQuotaError,
  shouldFallThrough,
  validateReadBody,
  staticTarget,
  percentile,
  minToHHMM,
  snapshot,
} from "../server.mjs";

/* -------------------------------- metrics ------------------------------ */

test("percentile uses nearest-rank on a sorted array", () => {
  const s = [10, 20, 30, 40, 50];
  assert.equal(percentile(s, 50), 30);
  assert.equal(percentile(s, 95), 50);
  assert.equal(percentile(s, 0), 10);
  assert.equal(percentile([], 50), 0);
});

test("minToHHMM formats minutes-of-day, null-safe", () => {
  assert.equal(minToHHMM(0), "00:00");
  assert.equal(minToHHMM(478), "07:58");
  assert.equal(minToHHMM(1025), "17:05");
  assert.equal(minToHHMM(null), null);
});

test("snapshot returns the expected shape on a fresh server", () => {
  const s = snapshot();
  assert.equal(typeof s.startedAt, "string");
  assert.equal(typeof s.uptimeSec, "number");
  assert.deepEqual(Object.keys(s.reads).sort(), [
    "badRequest",
    "busy",
    "ok",
    "total",
    "upstream",
    "zeroPunch",
  ]);
  for (const k of [
    "cardsScanned",
    "distinctDevices",
    "hoursClocked",
    "shiftsRead",
    "avgConfidence",
    "geminiCalls",
    "dataProcessedMB",
    "byHour",
    "byWeekday",
    "punchesPerCard",
    "errorRate",
    "modelWins",
    "contributedSamples",
  ]) {
    assert.ok(k in s, `snapshot has ${k}`);
  }
  assert.equal(s.byHour.length, 24);
  assert.equal(Object.keys(s.byWeekday).length, 7);
  assert.deepEqual(Object.keys(s.errorRate).sort(), [
    "allTime",
    "last100",
    "last20",
    "window",
  ]);
});

/* ------------------------------- staticTarget ---------------------------- */

test("staticTarget maps / to index.html and passes allow-listed assets", () => {
  assert.equal(staticTarget("/"), "index.html");
  assert.equal(staticTarget("/app.mjs"), "app.mjs");
  assert.equal(staticTarget("/vendor/preact.mjs"), "vendor/preact.mjs");
  assert.equal(staticTarget("/fonts/archivo.woff2"), "fonts/archivo.woff2");
  assert.equal(staticTarget("/sw.js"), "sw.js");
  assert.equal(staticTarget("/manifest.webmanifest"), "manifest.webmanifest");
  assert.equal(staticTarget("/icons/icon-192.png"), "icons/icon-192.png");
});

test("staticTarget aliases the bare favicon request", () => {
  assert.equal(staticTarget("/favicon.ico"), "icons/favicon-48.png");
});

test("staticTarget refuses anything off the allow-list", () => {
  assert.equal(staticTarget("/server.mjs"), null);
  assert.equal(staticTarget("/package.json"), null);
  assert.equal(staticTarget("/.env"), null);
  assert.equal(staticTarget("/test/server.test.mjs"), null);
});

test("staticTarget refuses path traversal", () => {
  assert.equal(staticTarget("/../.env"), null);
  assert.equal(staticTarget("/vendor/../.env"), null);
  assert.equal(staticTarget("/%2e%2e/.env"), null);
  assert.equal(staticTarget("/..%2fserver.mjs"), null);
});

/* --------------------------- punchesFromGeminiText -------------------------- */

test("punchesFromGeminiText parses a bare JSON object and pads the hour", () => {
  const out = punchesFromGeminiText(
    '{"punches":[{"type":"IN","date":"2026-09-02","time":"7:58"}]}'
  );
  assert.deepEqual(out, [
    { type: "IN", date: "2026-09-02", time: "07:58", confidence: 1 },
  ]);
});

test("punchesFromGeminiText strips ```json fences and uppercases the type", () => {
  const out = punchesFromGeminiText(
    '```json\n{"punches":[{"type":"out","date":"2026-09-02","time":"17:04"}]}\n```'
  );
  assert.deepEqual(out, [
    { type: "OUT", date: "2026-09-02", time: "17:04", confidence: 1 },
  ]);
});

test("punchesFromGeminiText finds the object inside surrounding prose", () => {
  assert.deepEqual(punchesFromGeminiText('Sure: {"punches":[]} done'), []);
});

test("punchesFromGeminiText drops entries that fail validation", () => {
  const out = punchesFromGeminiText(
    '{"punches":[' +
      '{"type":"IN","date":"nope","time":"08:00"},' +
      '{"type":"MAYBE","date":"2026-09-02","time":"08:00"},' +
      '{"type":"OUT","date":"2026-09-02","time":"16:30"}' +
      "]}"
  );
  assert.deepEqual(out, [
    { type: "OUT", date: "2026-09-02", time: "16:30", confidence: 1 },
  ]);
});

test("punchesFromGeminiText throws when the reply has no JSON object", () => {
  assert.throws(() => punchesFromGeminiText("I could not read the card"), /no json/i);
});

test("punchesFromGeminiText keeps a clamped confidence, defaulting to 1", () => {
  const out = punchesFromGeminiText(
    '{"punches":[' +
      '{"type":"IN","date":"2026-09-02","time":"08:00","confidence":0.4},' +
      '{"type":"OUT","date":"2026-09-02","time":"16:30","confidence":5},' +
      '{"type":"IN","date":"2026-09-03","time":"08:00"}' +
      "]}"
  );
  assert.deepEqual(out.map((p) => p.confidence), [0.4, 1, 1]);
});

/* ------------------------------- isQuotaError ------------------------------ */

test("isQuotaError is true for HTTP 429", () => {
  assert.equal(isQuotaError(429, {}), true);
});

test("isQuotaError is true for a RESOURCE_EXHAUSTED status in the body", () => {
  assert.equal(isQuotaError(400, { error: { status: "RESOURCE_EXHAUSTED" } }), true);
});

test("isQuotaError is false for other failures", () => {
  assert.equal(isQuotaError(500, { error: { status: "INTERNAL" } }), false);
  assert.equal(isQuotaError(200, {}), false);
});

test("shouldFallThrough covers quota, overload, slowness and retired models", () => {
  assert.equal(shouldFallThrough(429, {}), true);
  assert.equal(shouldFallThrough(503, {}), true);
  assert.equal(shouldFallThrough(504, { error: { status: "DEADLINE" } }), true);
  assert.equal(shouldFallThrough(404, { error: { status: "NOT_FOUND" } }), true);
  assert.equal(shouldFallThrough(400, { error: { status: "UNAVAILABLE" } }), true);
  assert.equal(shouldFallThrough(400, { error: { status: "INVALID_ARGUMENT" } }), false);
  assert.equal(shouldFallThrough(403, { error: { status: "PERMISSION_DENIED" } }), false);
});

/* ------------------------------ validateReadBody ------------------------- */

test("validateReadBody accepts image + mimeType", () => {
  assert.deepEqual(validateReadBody({ image: "QUJD", mimeType: "image/png" }), {
    image: "QUJD",
    mimeType: "image/png",
    clientId: null,
    sample: false,
    contribute: false,
  });
});

test("validateReadBody defaults the mimeType to image/jpeg", () => {
  assert.deepEqual(validateReadBody({ image: "QUJD" }), {
    image: "QUJD",
    mimeType: "image/jpeg",
    clientId: null,
    sample: false,
    contribute: false,
  });
});

test("validateReadBody unwraps a data: URL and keeps clientId + sample", () => {
  assert.deepEqual(
    validateReadBody({ image: "data:image/webp;base64,QUJD", clientId: "abc", sample: true }),
    { image: "QUJD", mimeType: "image/webp", clientId: "abc", sample: true, contribute: false }
  );
});

test("validateReadBody honours contribute:true, but never for the sample card", () => {
  assert.equal(validateReadBody({ image: "QUJD", contribute: true }).contribute, true);
  assert.equal(validateReadBody({ image: "QUJD", contribute: false }).contribute, false);
  assert.equal(validateReadBody({ image: "QUJD" }).contribute, false);
  assert.equal(
    validateReadBody({ image: "QUJD", contribute: true, sample: true }).contribute,
    false
  );
});

test("validateReadBody rejects a missing or non-string image", () => {
  assert.throws(() => validateReadBody({}), /image/i);
  assert.throws(() => validateReadBody({ image: 123 }), /image/i);
});

test("validateReadBody rejects a non-image mime type", () => {
  assert.throws(
    () => validateReadBody({ image: "QUJD", mimeType: "text/html" }),
    /mime/i
  );
});

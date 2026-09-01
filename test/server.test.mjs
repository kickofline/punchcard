import { test } from "node:test";
import assert from "node:assert/strict";

import {
  punchesFromGeminiText,
  isQuotaError,
  shouldFallThrough,
  validateReadBody,
  staticTarget,
} from "../server.mjs";

/* ------------------------------- staticTarget ---------------------------- */

test("staticTarget maps / to index.html and passes allow-listed assets", () => {
  assert.equal(staticTarget("/"), "index.html");
  assert.equal(staticTarget("/app.mjs"), "app.mjs");
  assert.equal(staticTarget("/vendor/preact.mjs"), "vendor/preact.mjs");
  assert.equal(staticTarget("/fonts/caveat.woff2"), "fonts/caveat.woff2");
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
  assert.deepEqual(out, [{ type: "IN", date: "2026-09-02", time: "07:58" }]);
});

test("punchesFromGeminiText strips ```json fences and uppercases the type", () => {
  const out = punchesFromGeminiText(
    '```json\n{"punches":[{"type":"out","date":"2026-09-02","time":"17:04"}]}\n```'
  );
  assert.deepEqual(out, [{ type: "OUT", date: "2026-09-02", time: "17:04" }]);
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
  assert.deepEqual(out, [{ type: "OUT", date: "2026-09-02", time: "16:30" }]);
});

test("punchesFromGeminiText throws when the reply has no JSON object", () => {
  assert.throws(() => punchesFromGeminiText("I could not read the card"), /no json/i);
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
  });
});

test("validateReadBody defaults the mimeType to image/jpeg", () => {
  assert.deepEqual(validateReadBody({ image: "QUJD" }), {
    image: "QUJD",
    mimeType: "image/jpeg",
  });
});

test("validateReadBody unwraps a data: URL", () => {
  assert.deepEqual(
    validateReadBody({ image: "data:image/webp;base64,QUJD" }),
    { image: "QUJD", mimeType: "image/webp" }
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

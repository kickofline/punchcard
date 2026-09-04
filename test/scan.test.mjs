import { test } from "node:test";
import assert from "node:assert/strict";

import {
  otsu,
  orderQuad,
  quadArea,
  quadDrift,
  detectCard,
  robustCorner,
  sharpness,
  affine3,
  targetSize,
} from "../scan.mjs";

/* ------------------------------ helpers ------------------------------ */

// grayscale frame with a bright axis-aligned rectangle on a dark ground
function frameWithRect(w, h, rx0, ry0, rx1, ry1, fg = 210, bg = 40) {
  const g = new Uint8ClampedArray(w * h).fill(bg);
  for (let y = ry0; y < ry1; y++)
    for (let x = rx0; x < rx1; x++) g[y * w + x] = fg;
  return g;
}

// the erosion passes + robust corner averaging both nudge the reported
// corner in from the true edge on purpose, in exchange for not being
// hijacked by a small glare speck; this is the budget for that inset
const CORNER_TOL = 8;

/* -------------------------------- otsu ------------------------------- */

test("otsu splits a clean bimodal histogram between the two peaks", () => {
  const hist = new Uint32Array(256);
  hist[30] = 500;
  hist[220] = 500;
  const t = otsu(hist, 1000);
  assert.ok(t > 30 && t < 220);
});

/* ------------------------------ orderQuad ---------------------------- */

test("orderQuad returns corners as tl, tr, br, bl", () => {
  const jumbled = [
    { x: 10, y: 90 }, // bl
    { x: 90, y: 10 }, // tr
    { x: 10, y: 10 }, // tl
    { x: 90, y: 90 }, // br
  ];
  const [tl, tr, br, bl] = orderQuad(jumbled);
  assert.deepEqual(tl, { x: 10, y: 10 });
  assert.deepEqual(tr, { x: 90, y: 10 });
  assert.deepEqual(br, { x: 90, y: 90 });
  assert.deepEqual(bl, { x: 10, y: 90 });
});

/* ------------------------------ quadArea --------------------------- */

test("quadArea is the shoelace area, winding-independent", () => {
  const q = [
    { x: 0, y: 0 },
    { x: 40, y: 0 },
    { x: 40, y: 20 },
    { x: 0, y: 20 },
  ];
  assert.equal(quadArea(q), 800);
  assert.equal(quadArea([...q].reverse()), 800);
});

/* ------------------------------ quadDrift -------------------------- */

test("quadDrift normalises the worst corner move by the frame diagonal", () => {
  const a = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];
  const b = a.map((p) => ({ x: p.x + 3, y: p.y + 4 })); // each corner moves 5
  assert.ok(Math.abs(quadDrift(a, b, 100, 100) - 5 / Math.hypot(100, 100)) < 1e-9);
  assert.equal(quadDrift(a, null, 100, 100), Infinity);
});

/* ------------------------------ detectCard ------------------------- */

test("detectCard finds a centred bright card and returns ordered corners", () => {
  const w = 120;
  const h = 160;
  const g = frameWithRect(w, h, 20, 30, 100, 130);
  const q = detectCard(g, w, h);
  assert.ok(q, "expected a quad");
  const [tl, tr, br, bl] = q;
  assert.ok(Math.abs(tl.x - 20) <= CORNER_TOL && Math.abs(tl.y - 30) <= CORNER_TOL);
  assert.ok(Math.abs(br.x - 99) <= CORNER_TOL && Math.abs(br.y - 129) <= CORNER_TOL);
  assert.ok(bl.x < tr.x && tl.y < bl.y);
});

test("detectCard returns null on a near-empty frame", () => {
  const w = 120;
  const h = 160;
  const g = frameWithRect(w, h, 55, 75, 62, 82); // tiny speck, < MIN fill
  assert.equal(detectCard(g, w, h), null);
});

test("detectCard returns null when the frame is uniformly bright", () => {
  const g = new Uint8ClampedArray(120 * 160).fill(230);
  assert.equal(detectCard(g, 120, 160), null);
});

test("detectCard is not derailed by a glare speck bridged to the card by a thin filament", () => {
  const w = 120;
  const h = 160;
  const g = frameWithRect(w, h, 20, 30, 100, 130);
  // a small blown-out patch well outside the card, reachable only through a
  // single-pixel-wide bright streak - the kind of thing an overhead light's
  // reflection leaves on a table next to the card
  for (let x = 100; x < 118; x++) g[60 * w + x] = 255; // 1px filament
  for (let y = 55; y < 66; y++) for (let x = 105; x < 117; x++) g[y * w + x] = 255; // glare blob
  const q = detectCard(g, w, h);
  assert.ok(q, "expected a quad despite the glare");
  const [tl, tr, br, bl] = q;
  assert.ok(Math.abs(tl.x - 20) <= CORNER_TOL && Math.abs(tl.y - 30) <= CORNER_TOL);
  // the key assertion: tr didn't get dragged out to the glare blob past x=100
  assert.ok(tr.x <= 100 + CORNER_TOL, `tr.x=${tr.x} should stay near the card, not the glare`);
  assert.ok(Math.abs(br.x - 99) <= CORNER_TOL && Math.abs(br.y - 129) <= CORNER_TOL);
});

/* ------------------------------ robustCorner ------------------------ */

test("robustCorner barely moves for one outlier once the slice is wide enough", () => {
  const cluster = [];
  for (let i = 0; i < 100; i++) cluster.push({ x: i % 10, y: 90 + Math.floor(i / 10) }); // a real corner region
  const outlier = { x: 500, y: 500 }; // one wildly out-of-place bright pixel, scores highest
  const clean = robustCorner(cluster, (p) => p.x + p.y, 0.02, 50, 50);
  const withOutlier = robustCorner([...cluster, outlier], (p) => p.x + p.y, 0.02, 50, 50);
  const moved = Math.hypot(withOutlier.x - clean.x, withOutlier.y - clean.y);
  assert.ok(moved < 15, `one outlier among ${cluster.length} points moved the corner ${moved}px`);
  assert.ok(withOutlier.x < 100, "should stay far from the outlier itself, not jump to it");
});

test("robustCorner falls back to the single point it's given", () => {
  const c = robustCorner([{ x: 5, y: 9 }], (p) => p.x + p.y);
  assert.deepEqual(c, { x: 5, y: 9 });
});

/* ------------------------------ sharpness -------------------------- */

test("sharpness scores an edgy frame far above a flat one", () => {
  const w = 60;
  const h = 60;
  const flat = new Uint8ClampedArray(w * h).fill(128);
  const edgy = frameWithRect(w, h, 10, 10, 50, 50, 255, 0);
  assert.ok(sharpness(edgy, w, h) > sharpness(flat, w, h) + 10);
  assert.equal(sharpness(flat, w, h), 0);
});

/* ------------------------------ affine3 --------------------------- */

test("affine3 maps each source point exactly onto its destination", () => {
  const s = [
    [0, 0],
    [80, 0],
    [0, 120],
  ];
  const d = [
    [10, 5],
    [90, 15],
    [20, 125],
  ];
  const M = affine3(s, d);
  const apply = (x, y) => [
    M[0][0] * x + M[0][1] * y + M[0][2],
    M[1][0] * x + M[1][1] * y + M[1][2],
  ];
  for (let i = 0; i < 3; i++) {
    const [x, y] = apply(s[i][0], s[i][1]);
    assert.ok(Math.abs(x - d[i][0]) < 1e-6 && Math.abs(y - d[i][1]) < 1e-6);
  }
});

test("affine3 returns null for a degenerate (collinear) source triangle", () => {
  assert.equal(
    affine3(
      [
        [0, 0],
        [10, 10],
        [20, 20],
      ],
      [
        [0, 0],
        [1, 0],
        [2, 0],
      ]
    ),
    null
  );
});

/* ------------------------------ targetSize ------------------------ */

test("targetSize keeps the quad's aspect and caps the long edge", () => {
  const quad = [
    { x: 0, y: 0 },
    { x: 600, y: 0 },
    { x: 600, y: 1800 },
    { x: 0, y: 1800 },
  ];
  const { w, h } = targetSize(quad, 900);
  assert.equal(h, 900); // long edge capped at 900
  assert.equal(w, 300); // aspect preserved (600:1800 -> 300:900)
});

/* Pure geometry + frame analysis for the live camera scanner.
   No DOM here - the browser code in app.mjs feeds in a small grayscale
   frame and draws whatever this returns. Kept dependency-free and unit
   tested (test/scan.test.mjs). */

/* framing / focus thresholds for the on-screen scan guide, exported so they
   can be tuned in one place */
export const SCAN = {
  MIN_FILL: 0.3, // card must cover at least this fraction of the frame
  MAX_FILL: 0.92, // ...and not completely fill it (need a margin to find edges)
  STABLE_FRAMES: 8, // steady this many frames -> the outline turns green
  MOVE_TOL: 0.02, // max corner drift (fraction of frame diagonal) to count as steady
  SHARP_MIN: 6, // absolute floor on Laplacian variance
  SHARP_REL: 0.55, // ...or this fraction of the sharpest frame seen so far
  MAX_WAIT_FRAMES: 22, // stop nagging "Focusing" after this many steady frames
};

/* Otsu threshold from a 256-bin histogram. */
export function otsu(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = -1;
  let lo = 127;
  let hi = 127;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      lo = hi = i;
    } else if (between === best) {
      hi = i;
    }
  }
  return Math.round((lo + hi) / 2); // middle of the max-variance plateau
}

/* Largest bright connected component. `gray` is length w*h, 0..255.
   Returns { pixels:Int32Array of indices, area, bbox:[x0,y0,x1,y1] } or null. */
function brightBlob(gray, w, h) {
  const total = w * h;
  const hist = new Uint32Array(256);
  for (let i = 0; i < total; i++) hist[gray[i]]++;
  const thr = Math.max(otsu(hist, total), 70);
  const mask = new Uint8Array(total);
  for (let i = 0; i < total; i++) mask[i] = gray[i] > thr ? 1 : 0;

  const seen = new Uint8Array(total);
  const stack = new Int32Array(total);
  let best = null;
  for (let start = 0; start < total; start++) {
    if (!mask[start] || seen[start]) continue;
    let sp = 0;
    stack[sp++] = start;
    seen[start] = 1;
    const pix = [];
    let x0 = w;
    let y0 = h;
    let x1 = 0;
    let y1 = 0;
    while (sp) {
      const p = stack[--sp];
      pix.push(p);
      const x = p % w;
      const y = (p - x) / w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0 && mask[p - 1] && !seen[p - 1]) (seen[p - 1] = 1), (stack[sp++] = p - 1);
      if (x < w - 1 && mask[p + 1] && !seen[p + 1]) (seen[p + 1] = 1), (stack[sp++] = p + 1);
      if (y > 0 && mask[p - w] && !seen[p - w]) (seen[p - w] = 1), (stack[sp++] = p - w);
      if (y < h - 1 && mask[p + w] && !seen[p + w]) (seen[p + w] = 1), (stack[sp++] = p + w);
    }
    if (!best || pix.length > best.area) {
      best = { pixels: pix, area: pix.length, bbox: [x0, y0, x1, y1] };
    }
  }
  return best;
}

/* Order 4 points as [tl, tr, br, bl] using sum / diff extremes. */
export function orderQuad(pts) {
  let tl = pts[0];
  let br = pts[0];
  let tr = pts[0];
  let bl = pts[0];
  for (const p of pts) {
    if (p.x + p.y < tl.x + tl.y) tl = p;
    if (p.x + p.y > br.x + br.y) br = p;
    if (p.x - p.y > tr.x - tr.y) tr = p;
    if (p.x - p.y < bl.x - bl.y) bl = p;
  }
  return [tl, tr, br, bl];
}

export function quadArea(q) {
  let a = 0;
  for (let i = 0; i < q.length; i++) {
    const p = q[i];
    const n = q[(i + 1) % q.length];
    a += p.x * n.y - n.x * p.y;
  }
  return Math.abs(a) / 2;
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/* Max corner drift between two quads, as a fraction of the frame diagonal. */
export function quadDrift(a, b, w, h) {
  if (!a || !b) return Infinity;
  const diag = Math.hypot(w, h);
  let m = 0;
  for (let i = 0; i < 4; i++) m = Math.max(m, dist(a[i], b[i]));
  return m / diag;
}

/* Find the card quad in a small grayscale frame. Returns [tl,tr,br,bl] in
   frame pixels, or null when nothing card-shaped is present. */
export function detectCard(gray, w, h) {
  const blob = brightBlob(gray, w, h);
  if (!blob) return null;
  const fill = blob.area / (w * h);
  if (fill < 0.12 || fill > 0.985) return null;

  const corners = orderQuad(blob.pixels.map((p) => ({ x: p % w, y: Math.floor(p / w) })));
  const [tl, tr, br, bl] = corners;
  const sides = [dist(tl, tr), dist(tr, br), dist(br, bl), dist(bl, tl)];
  if (Math.min(...sides) < 0.15 * Math.min(w, h)) return null;

  // the quad should account for most of the blob it came from (rejects Ls, blobs)
  const qa = quadArea(corners);
  if (qa < 0.6 * blob.area || qa > 1.6 * blob.area) return null;
  return corners;
}

/* Laplacian variance over a bbox - a cheap sharpness proxy. */
export function sharpness(gray, w, h, bbox) {
  const [x0, y0, x1, y1] = bbox
    ? bbox.map((v, i) => Math.max(i < 2 ? 1 : 0, Math.min(i % 2 ? h - 2 : w - 2, Math.round(v))))
    : [1, 1, w - 2, h - 2];
  let n = 0;
  let sum = 0;
  let sumSq = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * w + x;
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  if (n < 16) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

/* 2x3 affine [[a,c,e],[b,d,f]] mapping src triangle s -> dst triangle d,
   each given as [[x,y],[x,y],[x,y]]. Feeds canvas setTransform(a,b,c,d,e,f). */
export function affine3(s, d) {
  const [x0, y0] = s[0];
  const [x1, y1] = s[1];
  const [x2, y2] = s[2];
  const det = x0 * (y1 - y2) - x1 * (y0 - y2) + x2 * (y0 - y1);
  if (!det) return null;
  const inv = [
    [(y1 - y2) / det, (x2 - x1) / det, (x1 * y2 - x2 * y1) / det],
    [(y2 - y0) / det, (x0 - x2) / det, (x2 * y0 - x0 * y2) / det],
    [(y0 - y1) / det, (x1 - x0) / det, (x0 * y1 - x1 * y0) / det],
  ];
  const D = [
    [d[0][0], d[1][0], d[2][0]],
    [d[0][1], d[1][1], d[2][1]],
  ];
  const M = [
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let r = 0; r < 2; r++)
    for (let c = 0; c < 3; c++)
      M[r][c] = D[r][0] * inv[0][c] + D[r][1] * inv[1][c] + D[r][2] * inv[2][c];
  return M;
}

/* Upright output size for a detected quad, long edge capped at `cap`. */
export function targetSize(quad, cap = 1600) {
  const [tl, tr, br, bl] = quad;
  const wpx = (dist(tl, tr) + dist(bl, br)) / 2;
  const hpx = (dist(tl, bl) + dist(tr, br)) / 2;
  const scale = Math.min(1, cap / Math.max(wpx, hpx));
  return {
    w: Math.max(200, Math.round(wpx * scale)),
    h: Math.max(200, Math.round(hpx * scale)),
  };
}

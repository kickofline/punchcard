/* Pure geometry + frame analysis for the live camera scanner.
   No DOM here - the browser code in app.mjs feeds in a small grayscale
   frame and draws whatever this returns. Kept dependency-free and unit
   tested (test/scan.test.mjs). */

/* framing / focus thresholds for the on-screen scan guide, exported so they
   can be tuned in one place */
export const SCAN = {
  MIN_FILL: 0.26, // card must cover at least this fraction of the frame (detectCard's corners run ~10% inset of the true edge, by design)
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

/* One pass of 4-neighbour erosion on a binary mask - shrinks the bright
   region by a pixel and, more importantly, snaps off any thin filament
   bridging it to an unrelated bright blob (a glare streak reaching toward a
   window or overhead light, say) before the flood fill can merge the two. */
function erode(mask, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = row + x;
      out[i] = mask[i] & mask[i - 1] & mask[i + 1] & mask[i - w] & mask[i + w];
    }
  }
  return out;
}

/* Largest bright connected component. `gray` is length w*h, 0..255.
   Returns { pixels:Int32Array of indices, area, bbox:[x0,y0,x1,y1] } or null. */
function brightBlob(gray, w, h) {
  const total = w * h;
  const hist = new Uint32Array(256);
  // fold blown-out glare highlights into the top card bin before running
  // Otsu, so a hot spot doesn't read as its own bright class and pull the
  // threshold up past legitimately-lit card paper (which would fragment it)
  const GLARE_CLIP = 235;
  for (let i = 0; i < total; i++) hist[gray[i] < GLARE_CLIP ? gray[i] : GLARE_CLIP]++;
  const thr = Math.max(otsu(hist, total), 70);
  let mask = new Uint8Array(total);
  for (let i = 0; i < total; i++) mask[i] = gray[i] > thr ? 1 : 0;
  mask = erode(erode(mask, w, h), w, h);

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

/* The k points of `points` with the highest score(p), kept via a small
   bounded insertion so a single pass costs O(n) amortised rather than a
   full O(n log n) sort of the whole blob. */
function topKBy(points, score, k) {
  const top = []; // ascending by score, length capped at k
  for (const p of points) {
    const s = score(p);
    if (top.length < k) {
      let i = top.length;
      top.push({ p, s });
      while (i > 0 && top[i - 1].s > top[i].s) {
        const t = top[i - 1];
        top[i - 1] = top[i];
        top[i] = t;
        i--;
      }
    } else if (s > top[0].s) {
      top[0] = { p, s };
      let i = 0;
      while (i < top.length - 1 && top[i].s > top[i + 1].s) {
        const t = top[i];
        top[i] = top[i + 1];
        top[i + 1] = t;
        i++;
      }
    }
  }
  return top;
}

/* A corner estimate that isn't just the single most extreme pixel: the
   centroid of the top slice of points by `score`. A true corner is a whole
   region, so it dominates that slice; a stray glare speck a little further
   out only pulls the average a little instead of hijacking the corner
   outright. The slice size is capped rather than scaled with the point
   count - it only needs to be wide enough to outvote a small glare cluster,
   and growing it with a big card blob would just inset the corner more
   without buying any extra robustness. */
export function robustCorner(points, score, frac = 0.002, minN = 12, maxN = 30) {
  if (!points.length) return null;
  const k = Math.min(points.length, Math.min(maxN, Math.max(minN, Math.round(points.length * frac))));
  const top = topKBy(points, score, k);
  let sx = 0;
  let sy = 0;
  for (const { p } of top) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / top.length, y: sy / top.length };
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
  // two erosion passes shave a ~2px border off whatever the mask covers, so
  // compare against the area that's still reachable after that rather than
  // the raw frame - otherwise a frame that's bright edge-to-edge no longer
  // reads as "fills everything" once eroded, and slips past this check
  const reachable = Math.max(1, (w - 4) * (h - 4));
  const fill = blob.area / reachable;
  if (fill < 0.12 || fill > 0.97) return null;

  const points = blob.pixels.map((p) => ({ x: p % w, y: Math.floor(p / w) }));
  // each corner is the centroid of a small extreme slice, not the single
  // most extreme pixel - a real corner is a whole region and dominates that
  // slice, while a stray glare speck only nudges the average
  const corners = [
    robustCorner(points, (p) => -(p.x + p.y)), // tl
    robustCorner(points, (p) => p.x - p.y), // tr
    robustCorner(points, (p) => p.x + p.y), // br
    robustCorner(points, (p) => -(p.x - p.y)), // bl
  ];
  const [tl, tr, br, bl] = corners;
  const sides = [dist(tl, tr), dist(tr, br), dist(br, bl), dist(bl, tl)];
  if (Math.min(...sides) < 0.15 * Math.min(w, h)) return null;

  // the quad should account for most of the blob it came from (rejects Ls, blobs);
  // a little looser on the low side since averaging insets the corners a touch
  const qa = quadArea(corners);
  if (qa < 0.5 * blob.area || qa > 1.6 * blob.area) return null;
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

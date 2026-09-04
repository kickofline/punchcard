import { h, render } from "./vendor/preact.mjs";
import {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
} from "./vendor/hooks.mjs";
import htmFactory from "./vendor/htm.mjs";
import {
  slotType,
  todayISO,
  nowHM,
  stamp,
  minutesOf,
  hrs,
  clock12,
  dayLabel,
  isPunch,
  layout,
  readCard,
  prettyModel,
} from "./lib.mjs";
import {
  SCAN,
  detectCard,
  quadArea,
  quadDrift,
  sharpness,
  affine3,
  targetSize,
} from "./scan.mjs";

const html = htmFactory.bind(h);

const SAMPLE_W = 192; // width of the frame we analyse for the live scanner

const HOURS_URL = "https://info.obu.edu/info/p3/WS_STUHOURS.php?P3PROG=WS_STUHOURS";

const IS_IOS =
  typeof navigator !== "undefined" && /iphone|ipad|ipod/i.test(navigator.userAgent || "");
const IS_STANDALONE =
  typeof window !== "undefined" &&
  ((window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) ||
    window.navigator?.standalone === true);

/* wall-clock ms for a {date:"YYYY-MM-DD", time:"HH:MM"} in the viewer's tz */
const localMs = (p) => {
  const [y, m, d] = p.date.split("-").map(Number);
  const [hh, mm] = p.time.split(":").map(Number);
  return new Date(y, m - 1, d, hh, mm).getTime();
};
const hms = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mn = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const sc = String(s % 60).padStart(2, "0");
  return `${h}:${mn}:${sc}`;
};

/* a stable random id per browser, so /stats can count distinct devices */
function clientId() {
  try {
    let v = localStorage.getItem("punchcard:client-id");
    if (!v) {
      v = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2) + Date.now();
      localStorage.setItem("punchcard:client-id", v);
    }
    return v;
  } catch {
    return null;
  }
}

/* ------------------------------ local storage --------------------------------
   The component was written for a host that injected window.storage. On a plain
   static host that object does not exist, so this shim gives it the same shape
   over localStorage: get() resolves to {value} or null. */
const storage = {
  async get(key) {
    try {
      const value = localStorage.getItem(key);
      return value == null ? null : { value };
    } catch {
      return null;
    }
  },
  async set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private mode / quota - nothing we can do */
    }
  },
  async delete(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

/* ------------------------------ image handling ---------------------------- */

const SENDABLE = ["image/jpeg", "image/png", "image/gif", "image/webp"];

const asDataURL = (file) =>
  new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(new Error("read failed"));
    r.readAsDataURL(file);
  });

const asImage = (src) =>
  new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error("decode failed"));
    i.src = src;
  });

function toCanvas(src, w, h, max) {
  const scale = Math.min(1, max / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * scale));
  c.height = Math.max(1, Math.round(h * scale));
  c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
  return c;
}

/* Draw `video` into a box with object-fit: cover semantics. Returns the
   transform so a point in box space maps back to raw video pixels:
   rawX = (x - dx) / scale,  rawY = (y - dy) / scale. */
function coverDraw(ctx, video, bw, bh) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const scale = Math.max(bw / vw, bh / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  const dx = (bw - dw) / 2;
  const dy = (bh - dh) / 2;
  ctx.drawImage(video, dx, dy, dw, dh);
  return { scale, dx, dy };
}

/* Perspective-correct the card out of the raw video frame using its four
   corners (raw-pixel coords, ordered tl,tr,br,bl). Two affine-mapped
   triangles - no external lib. Returns a canvas, or null if degenerate. */
function warpCard(video, quad) {
  const { w, h } = targetSize(quad, 1600);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  const S = quad.map((p) => [p.x, p.y]);
  const D = [[0, 0], [w, 0], [w, h], [0, h]];
  for (const [a, b, d] of [[0, 1, 3], [1, 2, 3]]) {
    const M = affine3([S[a], S[b], S[d]], [D[a], D[b], D[d]]);
    if (!M) return null;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(D[a][0], D[a][1]);
    ctx.lineTo(D[b][0], D[b][1]);
    ctx.lineTo(D[d][0], D[d][1]);
    ctx.closePath();
    ctx.clip();
    ctx.setTransform(M[0][0], M[1][0], M[0][1], M[1][1], M[0][2], M[1][2]);
    ctx.drawImage(video, 0, 0);
    ctx.restore();
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return c;
}

/* Grayscale + a mild contrast lift so faint dot-matrix stamps read better.
   Conservative on purpose - a good photo should come out barely changed. */
function preprocess(canvas) {
  const ctx = canvas.getContext("2d");
  let img;
  try {
    img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  } catch (e) {
    return canvas; // tainted canvas / not supported - send as-is
  }
  const d = img.data;
  const C = 1.18;
  for (let i = 0; i < d.length; i += 4) {
    const g = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    let v = (g - 128) * C + 132;
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

const shotURL = (canvas) => preprocess(canvas).toDataURL("image/jpeg", 0.9);

/* Three ways in, because iPhone photos arrive as HEIC and some webviews
   refuse blob: URLs. Returns a JPEG data URL, long edge capped so the upload
   to the reader stays small. */
async function loadShot(file) {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      const c = toCanvas(bmp, bmp.width, bmp.height, 1600);
      bmp.close?.();
      return { src: shotURL(c) };
    } catch (e) { /* next route */ }
  }
  let dataURL = null;
  try {
    dataURL = await asDataURL(file);
    const img = await asImage(dataURL);
    const c = toCanvas(img, img.naturalWidth || img.width, img.naturalHeight || img.height, 1600);
    return { src: shotURL(c) };
  } catch (e) { /* next route */ }
  try {
    const url = URL.createObjectURL(file);
    const img = await asImage(url);
    const c = toCanvas(img, img.naturalWidth || img.width, img.naturalHeight || img.height, 1600);
    URL.revokeObjectURL(url);
    return { src: shotURL(c) };
  } catch (e) { /* fall through */ }

  const type = (file.type || "").toLowerCase();
  if (SENDABLE.includes(type) && dataURL && file.size < 6 * 1024 * 1024) {
    return { src: dataURL };
  }
  throw new Error(
    "This phone would not hand over the photo in a readable format. On iPhone: Settings, Camera, Formats, Most Compatible, then shoot the card again."
  );
}

/* --------------------------------- reader -------------------------------- */

/* Send the photo to the server and consume its event stream. `onStep(text)` is
   called with a human status line as each model is tried. Resolves to the
   punch list. */
async function readCardImage(dataURL, onStep = () => {}, opts = {}) {
  let res;
  try {
    res = await fetch("/api/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: dataURL,
        clientId: clientId(),
        sample: !!opts.sample,
        contribute: !opts.sample && !!opts.contribute,
        fast: !opts.sample && !!opts.fast,
      }),
      signal: AbortSignal.timeout(55000),
    });
  } catch (e) {
    if (e && e.name === "TimeoutError") {
      throw new Error("The reader took too long. It may be busy - try again in a moment.");
    }
    throw new Error("Could not reach the reader. Check your connection and try again.");
  }

  // Validation failures come back as plain JSON before the stream starts.
  if (!res.ok || !res.body) {
    let body = {};
    try { body = await res.json(); } catch (e) { /* ignore */ }
    throw new Error(body.error || "The reader could not read that photo. Try again.");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result = null;
  let errText = null;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const event = (frame.match(/^event: (.*)$/m) || [])[1];
        const dataLine = (frame.match(/^data: (.*)$/m) || [])[1];
        let data = {};
        try { data = dataLine ? JSON.parse(dataLine) : {}; } catch (e) { /* ignore */ }
        if (event === "try") {
          onStep(`Asking ${prettyModel(data.model)}…`);
        } else if (event === "fell_through") {
          onStep(`${prettyModel(data.model)} was busy — trying the next one…`);
        } else if (event === "done") {
          result = data;
        } else if (event === "error") {
          errText = data.error;
        }
      }
    }
  } catch (e) {
    if (e && e.name === "TimeoutError") {
      throw new Error("The reader took too long. It may be busy - try again in a moment.");
    }
    throw new Error("The reader connection dropped. Try again.");
  }

  if (errText) throw new Error(errText);
  if (!result) throw new Error("The reader gave no answer. Try again.");

  const found = (result.punches || []).filter(isPunch);
  if (!found.length) {
    if (result.raw) {
      console.log("[punchcard] model returned no usable punches. finish:", result.finish, "raw:", result.raw);
    }
    throw new Error("No stamped rows were read. Get closer, fill the frame, and keep glare off the card.");
  }
  return { punches: found, contribId: result.contribId || null };
}

/* ---------------------------------- view ---------------------------------- */

export function TimeCard() {
  const [punches, setPunches] = useState([]);
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState({ date: todayISO(), time: nowHM() });
  const [status, setStatus] = useState("idle"); // idle | camera | reading
  const [readMsg, setReadMsg] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [lowConfSeen, setLowConfSeen] = useState(true);
  const [tutorial, setTutorial] = useState(false);
  const [clockTick, setClockTick] = useState(0);
  const [installEvt, setInstallEvt] = useState(null);
  const [installHidden, setInstallHidden] = useState(true);
  const [iosHelp, setIosHelp] = useState(false);
  const [hint, setHint] = useState("");
  const [torchState, setTorchState] = useState({ supported: false, on: false });
  const [privacy, setPrivacy] = useState(false);
  const [contribute, setContribute] = useState(true);
  const [fast, setFast] = useState(false);
  const [fastInfo, setFastInfo] = useState(false);
  const [lowLight, setLowLight] = useState(false);
  const [pending, setPending] = useState(null); // { src, from } awaiting "use / retake"

  function copyAndLog(text, key) {
    copy(text, key);
    window.open(HOURS_URL, "_blank", "noopener");
  }

  async function doInstall() {
    if (installEvt) {
      installEvt.prompt();
      try { await installEvt.userChoice; } catch (e) { /* ignore */ }
      setInstallEvt(null);
      setInstallHidden(true);
    } else {
      setIosHelp(true);
    }
  }
  function dismissInstall() {
    setInstallHidden(true);
    storage.set("punchcard:install-dismissed", "1");
  }
  function closeTutorial() {
    setTutorial(false);
  }
  function toggleContribute() {
    setContribute((v) => {
      const n = !v;
      storage.set("punchcard:contribute", n ? "1" : "0");
      return n;
    });
  }
  function toggleFast() {
    setFast((v) => {
      const n = !v;
      storage.set("punchcard:fast", n ? "1" : "0");
      return n;
    });
  }
  const [fresh, setFresh] = useState([]);
  const [copied, setCopied] = useState(null);
  const [shot, setShot] = useState(null);

  const library = useRef(null);
  const video = useRef(null);
  const stream = useRef(null);
  const sampler = useRef(null); // hidden canvas the scanner reads frames from
  const overlay = useRef(null); // canvas that draws the detected card outline
  const torchTrack = useRef(null);
  const scan = useRef(null); // live-scan working state (see the camera effect)
  const lastRead = useRef(null); // { id, freshSlots, baseline, edits, reported } for edit reporting
  const punchesRef = useRef([]); // latest punches, readable from non-render callbacks
  const reportTimer = useRef(0);

  useEffect(() => {
    (async () => {
      try {
        const saved = await storage.get("timecard:v1");
        if (saved) setPunches(JSON.parse(saved.value).punches || []);
      } catch (e) { /* nothing saved yet */ }
      try {
        const dismissed = await storage.get("punchcard:install-dismissed");
        if (!dismissed && !IS_STANDALONE) setInstallHidden(false);
      } catch (e) { /* first run */ }
      try {
        const c = await storage.get("punchcard:contribute");
        if (c && c.value === "0") setContribute(false);
      } catch (e) { /* default on */ }
      try {
        const f = await storage.get("punchcard:fast");
        if (f && f.value === "1") setFast(true);
      } catch (e) { /* default off */ }
    })();
  }, []);

  useEffect(() => {
    const onPrompt = (e) => {
      e.preventDefault();
      setInstallEvt(e);
    };
    const onInstalled = () => {
      setInstallHidden(true);
      storage.set("punchcard:install-dismissed", "1");
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  useEffect(() => {
    if (!punches.length) return;
    storage.set("timecard:v1", JSON.stringify({ punches }));
  }, [punches]);

  useEffect(() => {
    punchesRef.current = punches;
  }, [punches]);

  /* Tell the server the final state of a shared read: which of the freshly
     read rows the user changed, and to what. Best training signal there is. */
  const flushReport = useCallback(() => {
    const lr = lastRead.current;
    if (!lr || !lr.id || lr.reported) return;
    lr.reported = true;
    clearTimeout(reportTimer.current);
    const body = JSON.stringify({
      id: lr.id,
      editedRows: lr.edits.length,
      edits: lr.edits,
      punches: layout(punchesRef.current).filter(Boolean),
    });
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon("/api/correction", new Blob([body], { type: "application/json" }));
      } else {
        fetch("/api/correction", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: true,
        }).catch(() => {});
      }
    } catch (e) { /* offline / blocked - fine */ }
  }, []);

  /* While a shared read is still "live", keep its edit list current by diffing
     the fresh rows against what the model returned. */
  useEffect(() => {
    const lr = lastRead.current;
    if (!lr || !lr.id || lr.reported) return;
    const g = layout(punches);
    lr.edits = lr.freshSlots
      .map((slot) => {
        const was = lr.baseline[slot] || null;
        const c = g[slot];
        const now = c ? { type: c.type, date: c.date, time: c.time } : null;
        const same =
          !was === !now &&
          (!was || (was.type === now.type && was.date === now.date && was.time === now.time));
        return same ? null : { slot, was, now };
      })
      .filter(Boolean);
  }, [punches]);

  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") flushReport();
    };
    window.addEventListener("pagehide", flushReport);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", flushReport);
      document.removeEventListener("visibilitychange", onHide);
      flushReport();
    };
  }, [flushReport]);

  useEffect(() => {
    const a = new URLSearchParams(location.search).get("action");
    if (a === "scan") openCamera();
    else if (a === "punch") punchNow();
    if (a) history.replaceState(null, "", location.pathname);
  }, []);

  useEffect(() => {
    if (status !== "reading") {
      setElapsed(0);
      return;
    }
    const start = Date.now();
    const id = setInterval(() => setElapsed(Math.round((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(id);
  }, [status]);

  const grid = useMemo(() => layout(punches), [punches]);
  const { shifts, notes } = useMemo(() => readCard(grid), [grid]);

  const cardMinutes = shifts.reduce((s, x) => s + x.minutes, 0);
  const open = shifts.find((s) => s.open);

  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setClockTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [!!open]);
  // clockTick just forces the re-render; the value is read live off the wall clock
  void clockTick;
  const runningMs = open ? Date.now() - localMs(open.in) : 0;

  const today = todayISO();
  const byDay = useMemo(() => {
    const m = new Map();
    for (const s of shifts) {
      if (!s.out) continue;
      if (!m.has(s.in.date)) m.set(s.in.date, []);
      m.get(s.in.date).push(s);
    }
    return [...m.entries()].sort().map(([date, list]) => ({
      date,
      list,
      minutes: list.reduce((n, s) => n + s.minutes, 0),
      sumOfRounded: list.reduce((n, s) => n + Number(hrs(s.minutes)), 0),
    }));
  }, [shifts]);
  const todayRow = byDay.find((d) => d.date === today);

  /* Rows to show: every slot that holds a punch, plus a slot being edited. */
  const rows = grid
    .map((p, i) => ({ p, i }))
    .filter(({ p, i }) => p || editing === i);
  const lowSlot = grid.findIndex((p) => p && p.confidence != null && p.confidence < 0.6);
  const uncertain = grid.filter((p) => p && p.confidence != null && p.confidence < 0.6).length;
  const dateStamp = `${today.slice(5, 7)}.${today.slice(8, 10)}.${today.slice(2, 4)}`;

  /* ------------------------------- clipboard ------------------------------ */

  const copy = useCallback((text, key) => {
    const flash = () => {
      setCopied(key);
      setTimeout(() => setCopied(null), 1800);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(flash, () => {});
      return;
    }
    const t = document.createElement("textarea");
    t.value = text;
    document.body.appendChild(t);
    t.select();
    try {
      document.execCommand("copy");
      flash();
    } catch (e) { /* clipboard blocked */ }
    document.body.removeChild(t);
  }, []);

  /* -------------------------------- camera -------------------------------- */

  async function openCamera() {
    setError("");
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 } },
        audio: false,
      });
      stream.current = s;
      const track = s.getVideoTracks()[0] || null;
      torchTrack.current = track;
      let torchable = false;
      try {
        torchable = !!(track && track.getCapabilities && track.getCapabilities().torch);
      } catch (e) { /* not supported */ }
      setTorchState({ supported: torchable, on: false });
      setHint("");
      setStatus("camera");
      setTimeout(() => {
        if (video.current) {
          video.current.srcObject = s;
          video.current.play().catch(() => {});
        }
      }, 0);
    } catch (e) {
      setError("No camera available here, or permission was refused. Upload a photo instead.");
    }
  }

  function stopCamera() {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    torchTrack.current = null;
    setTorchState({ supported: false, on: false });
  }

  async function toggleTorch() {
    const t = torchTrack.current;
    if (!t) return;
    const next = !torchState.on;
    try {
      await t.applyConstraints({ advanced: [{ torch: next }] });
      setTorchState((v) => ({ ...v, on: next }));
    } catch (e) { /* device refused the constraint */ }
  }

  /* Take the shot. If the live scanner has a lock on the card, straighten it
     out of the frame; otherwise fall back to the whole frame. */
  async function capture(quad, cover) {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    let c = null;
    if (quad && cover) {
      const raw = quad.map((p) => ({
        x: (p.x - cover.dx) / cover.scale,
        y: (p.y - cover.dy) / cover.scale,
      }));
      try {
        c = warpCard(v, raw);
      } catch (e) { /* fall back below */ }
    }
    if (!c) c = toCanvas(v, v.videoWidth, v.videoHeight, 1600);
    stopCamera();
    setPending({ src: shotURL(c), from: "camera" });
    setStatus("confirm");
  }

  function confirmUse() {
    const p = pending;
    setPending(null);
    if (p) send({ src: p.src });
  }
  function confirmRedo() {
    const from = pending?.from;
    setPending(null);
    if (from === "file") library.current?.click();
    else openCamera();
  }
  function confirmCancel() {
    setPending(null);
    setStatus("idle");
  }

  /* Live scanner: while the camera is open, sample small frames, find the
     card, draw its outline, and (when Auto is on) fire the shutter once the
     card is framed, steady and in focus. */
  useEffect(() => {
    if (status !== "camera") return;
    const bw = SAMPLE_W;
    const bh = Math.round((SAMPLE_W * 4) / 3);
    const sc = sampler.current;
    const oc = overlay.current;
    if (!sc || !oc) return;
    sc.width = oc.width = bw;
    sc.height = oc.height = bh;
    const sctx = sc.getContext("2d", { willReadFrequently: true });
    const octx = oc.getContext("2d");
    const st = (scan.current = { raf: 0, prev: null, stable: 0, wait: 0, maxSharp: 0, quad: null, cover: null });
    let stopped = false;

    const tick = () => {
      if (stopped) return;
      st.raf = requestAnimationFrame(tick);
      const v = video.current;
      if (!v || !v.videoWidth) return;
      st.cover = coverDraw(sctx, v, bw, bh);
      let img;
      try {
        img = sctx.getImageData(0, 0, bw, bh);
      } catch (e) {
        return;
      }
      const d = img.data;
      const gray = new Uint8ClampedArray(bw * bh);
      let lsum = 0;
      for (let i = 0, j = 0; i < d.length; i += 4, j++) {
        const g = (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
        gray[j] = g;
        lsum += g;
      }
      // dim scene for a while -> suggest the torch (only if it's available)
      st.dark = lsum / gray.length < 60 ? (st.dark || 0) + 1 : 0;
      setLowLight(torchState.supported && !torchState.on && st.dark > 12);
      const quad = detectCard(gray, bw, bh);
      st.quad = quad;

      octx.clearRect(0, 0, bw, bh);
      if (quad) {
        octx.lineWidth = 2;
        octx.strokeStyle = st.stable >= SCAN.STABLE_FRAMES ? "#3ad07a" : "rgba(255,255,255,0.92)";
        octx.beginPath();
        quad.forEach((p, i) => (i ? octx.lineTo(p.x, p.y) : octx.moveTo(p.x, p.y)));
        octx.closePath();
        octx.stroke();
      }

      if (!quad) {
        st.prev = null;
        st.stable = 0;
        st.wait = 0;
        setHint("Point at the card");
        return;
      }
      const fill = quadArea(quad) / (bw * bh);
      const drift = quadDrift(st.prev, quad, bw, bh);
      st.prev = quad;
      const xs = quad.map((p) => p.x);
      const ys = quad.map((p) => p.y);
      const sharp = sharpness(gray, bw, bh, [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
      if (sharp > st.maxSharp) st.maxSharp = sharp;

      if (fill < SCAN.MIN_FILL) {
        st.stable = 0;
        st.wait = 0;
        return setHint("Move closer");
      }
      if (fill > SCAN.MAX_FILL) {
        st.stable = 0;
        st.wait = 0;
        return setHint("Back up a little");
      }
      if (drift > SCAN.MOVE_TOL) {
        st.stable = 0;
        return setHint("Hold steady");
      }
      st.stable++;
      const soft = sharp < Math.max(SCAN.SHARP_MIN, SCAN.SHARP_REL * st.maxSharp);
      if (soft && st.wait < SCAN.MAX_WAIT_FRAMES) {
        st.wait++;
        return setHint("Focusing…");
      }
      setHint("Card in view — tap to shoot");
    };

    st.raf = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      cancelAnimationFrame(st.raf);
      try {
        octx.clearRect(0, 0, bw, bh);
      } catch (e) { /* canvas gone */ }
      setHint("");
    };
  }, [status, torchState.supported, torchState.on]);

  async function onFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError("");
    try {
      const s = await loadShot(file);
      setPending({ src: s.src, from: "file" });
      setStatus("confirm");
    } catch (err) {
      setError(err.message || "That photo could not be read.");
      setStatus("idle");
    }
  }

  async function trySample() {
    setError("");
    try {
      const blob = await (await fetch("/sample-card.jpg")).blob();
      const dataURL = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = () => rej(new Error("read failed"));
        r.readAsDataURL(blob);
      });
      await send({ src: dataURL }, { sample: true });
    } catch (err) {
      setError("Couldn't load the sample card.");
      setStatus("idle");
    }
  }

  async function send(s, opts = {}) {
    setShot(s);
    setStatus("reading");
    setReadMsg("Sending the photo…");
    setError("");
    try {
      const { punches: found, contribId } = await readCardImage(s.src, setReadMsg, {
        contribute: !opts.sample && contribute,
        fast: !opts.sample && fast,
        ...opts,
      });
      // The photo is what's on the card right now, so a scan replaces the
      // current card rather than piling onto whatever was read before.
      const merged = layout(found);
      const freshSlots = [];
      const baseline = {};
      merged.forEach((p, i) => {
        if (p) {
          freshSlots.push(i);
          baseline[i] = { type: p.type, date: p.date, time: p.time };
        }
      });
      flushReport(); // close out the previous shared read, if any
      lastRead.current = contribId
        ? { id: contribId, freshSlots, baseline, edits: [], reported: false }
        : null;
      if (lastRead.current) {
        clearTimeout(reportTimer.current);
        reportTimer.current = setTimeout(flushReport, 25000);
      }
      setFresh(freshSlots);
      setPunches(merged.filter(Boolean));
      setShot(null);
      setStatus("idle");
      setReadMsg("");
      setLowConfSeen(!found.some((p) => p.confidence != null && p.confidence < 0.6));
      setTimeout(() => setFresh([]), 2500);
    } catch (err) {
      setError(err.message || "That photo could not be read.");
      setShot(null);
      setStatus("idle");
      setReadMsg("");
    }
  }

  /* --------------------------------- rows --------------------------------- */

  function openRow(i) {
    const p = grid[i];
    setDraft(p ? { ...p } : { date: grid[i - 1]?.date || todayISO(), time: nowHM() });
    setEditing(i);
  }
  function saveRow() {
    const p = { type: slotType(editing), date: draft.date, time: draft.time };
    if (!isPunch(p)) return;
    setPunches([...grid.filter((x, i) => x && i !== editing), p]);
    setEditing(null);
  }
  function clearRow() {
    setPunches(grid.filter((x, i) => x && i !== editing));
    setEditing(null);
  }
  function addPunch() {
    const p = { type: open ? "OUT" : "IN", date: todayISO(), time: nowHM() };
    const next = [...grid.filter(Boolean), p];
    setPunches(next);
    const idx = layout(next).indexOf(p);
    if (idx >= 0) {
      setDraft({ date: p.date, time: p.time });
      setEditing(idx);
    }
  }
  function punchNow() {
    setEditing(null);
    setPunches([
      ...grid.filter(Boolean),
      { type: open ? "OUT" : "IN", date: todayISO(), time: nowHM() },
    ]);
  }
  function clearCard() {
    setPunches([]);
    setEditing(null);
    storage.delete("timecard:v1");
  }
  function copyDay(d) {
    const lines = d.list.map((s) => `${clock12(s.in)} to ${clock12(s.out)} = ${hrs(s.minutes)} h (${s.minutes} min)`);
    copy(`${dayLabel(d.date)}\n${lines.join("\n")}\nTotal: ${hrs(d.minutes)} h (${d.minutes} min)`, d.date);
  }

  return html`
    <div class="app">
      ${status === "camera" && html`
        <div class="stage">
          <div class="stagebar">
            <span>${lowLight && !hint ? "Dim — tap Light" : hint || "Align the card"}</span>
            <button class="x" onClick=${() => { stopCamera(); setStatus("idle"); }}>Cancel</button>
          </div>
          <div class="stagebody">
            <div class="viewport">
              <video ref=${video} playsinline muted></video>
              <canvas class="overlay" ref=${overlay}></canvas>
              <div class="guide">
                <span class="tl"></span><span class="tr"></span><span class="bl"></span><span class="br"></span>
              </div>
              ${(hint || lowLight) && html`<div class="hint">${lowLight ? "Low light — tap Light" : hint}</div>`}
            </div>
          </div>
          <div class="shutterbar">
            <span class="chip-spacer"></span>
            <button
              class="shutter"
              onClick=${() => capture(scan.current?.quad || null, scan.current?.cover || null)}
              aria-label="Take photo"
            ></button>
            ${torchState.supported
              ? html`<button
                  class=${`chip ${torchState.on ? "on" : ""} ${lowLight ? "attn" : ""}`}
                  onClick=${toggleTorch}
                  aria-pressed=${torchState.on}
                >Light</button>`
              : html`<span class="chip-spacer"></span>`}
          </div>
          <canvas ref=${sampler} class="probe" aria-hidden="true"></canvas>
        </div>
      `}

      ${status === "confirm" && pending && html`
        <div class="stage">
          <div class="stagebar">
            <span>Whole card, in focus?</span>
            <button class="x" onClick=${confirmCancel}>Cancel</button>
          </div>
          <div class="stagebody">
            <div class="frame full">
              <img src=${pending.src} alt="Photo you just took" />
            </div>
          </div>
          <div class="shutterbar confirmbar">
            <button class="chip" onClick=${confirmRedo}>
              ${pending.from === "file" ? "Choose another" : "Retake"}
            </button>
            <button class="btn btn-primary usebtn" onClick=${confirmUse}>Use this photo</button>
          </div>
        </div>
      `}

      ${status === "reading" && shot && html`
        <div class="stage">
          <div class="stagebar">
            <span>Reading your card</span>
            <span class="elapsed">${elapsed}s</span>
          </div>
          <div class="stagebody">
            <div class="frame full">
              <img src=${shot.src} alt="Photo of the time card" />
              <div class="bar"></div>
            </div>
          </div>
          <div class="readpanel">
            <p class="readnote">${readMsg || "Sending the photo…"}</p>
          </div>
        </div>
      `}

      <header class="appbar">
        <span class="brand">Time Card</span>
        <span class="bar-right">
          <button class="help" onClick=${() => setTutorial(true)} aria-label="How it works">?</button>
          <span class="date">${dateStamp}</span>
        </span>
      </header>

      ${!installHidden &&
      (installEvt || IS_IOS) &&
      status === "idle" &&
      !tutorial &&
      !iosHelp &&
      !error &&
      lowConfSeen &&
      html`
        <div class="installbar">
          <button class="installbtn" onClick=${doInstall}>Add to Home Screen</button>
          <button class="installx" onClick=${dismissInstall} aria-label="Dismiss">✕</button>
        </div>
      `}

      <div class="wrap">
        <div class="stats solo">
          <button
            class="stat today"
            onClick=${() => todayRow && copyAndLog(hrs(todayRow.minutes), "today")}
            disabled=${!todayRow}
          >
            <span class="tag">Today</span>
            <span class="figure">${todayRow ? hrs(todayRow.minutes) : "0.00"}</span>
            <span class="sub">
              ${open
                ? html`<span class="running">Running ${hms(runningMs)}</span>`
                : todayRow
                ? `${todayRow.list.length} shift${todayRow.list.length === 1 ? "" : "s"} · ${todayRow.minutes} min`
                : "No shifts today"}
            </span>
            <span class="cue">${copied === "today" ? "Copied · opening OBU" : todayRow ? "Tap: copy + open OBU" : ""}</span>
          </button>
        </div>

        <div class="actions">
          <button class="btn btn-primary" onClick=${openCamera}>Take photo</button>
          <button class="btn btn-secondary" onClick=${() => library.current.click()}>Choose photo</button>
        </div>
        <button
          class=${`btn punchnow ${open ? "btn-primary" : "btn-secondary"}`}
          onClick=${punchNow}
        >
          ${open ? "Punch out now" : "Punch in now"}
        </button>
        <input ref=${library} type="file" accept="image/*" onChange=${onFile} hidden />
        ${error && html`<div class="err">${error}</div>`}

        <div class="sheet">
          <div class="sheethead">
            <span class="h">Punches</span>
            <span class="hint-h">Tap a row to edit</span>
          </div>

          <div class="grid">
            ${rows.length === 0 && editing === null && html`
              <div class="empty">
                No punches. Photograph the card, or add one by hand.
                <button class="samplebtn" onClick=${trySample}>Try a sample card</button>
              </div>
            `}
            ${rows.map(({ p, i }) => {
              const shift = shifts.find((s) => s.slot === (i % 2 === 0 ? i : i - 1));
              const showDur = i % 2 === 1 && shift && shift.out;
              const low = p && p.confidence != null && p.confidence < 0.6;
              const isOut = i % 2 === 1;
              return html`
                <div key=${i} class=${`row${editing === i ? " editing" : ""}`}>
                  <div class=${`lab${isOut ? " out" : ""}`}>${slotType(i)}</div>
                  ${editing === i
                    ? html`
                        <div class="editor">
                          <input class="input" type="date" value=${draft.date} aria-label="Date"
                            onInput=${(e) => setDraft({ ...draft, date: e.target.value })} />
                          <input class="input" type="time" value=${draft.time} aria-label="Time"
                            onInput=${(e) => setDraft({ ...draft, time: e.target.value })} />
                          <button class="btn btn-primary" onClick=${saveRow}>Save</button>
                          <button class="btn btn-ghost" onClick=${() => setEditing(null)}>Cancel</button>
                          <button class="mini-remove" onClick=${clearRow}>Remove</button>
                        </div>
                      `
                    : html`
                        <button class="val" onClick=${() => openRow(i)}>
                          <span class=${`punched${fresh.includes(i) ? " ink-flash" : ""}${low ? " low" : ""}`}>
                            ${stamp(p)}
                          </span>
                          ${low && html`<span class="qmark" title="Low confidence — verify this row">[?]</span>`}
                          ${showDur && html`
                            <span class=${`dur${shift.bad ? " flag" : ""}`}>
                              ${shift.bad ? "Review" : `${hrs(shift.minutes)} h`}
                            </span>
                          `}
                        </button>
                      `}
                </div>
              `;
            })}
            <button class=${`add${rows.length === 0 && editing === null ? " standalone" : ""}`} onClick=${addPunch}>+ Add punch</button>
          </div>

          <div class="totals">
            <div class="tline">
              <span class="lbl">This card</span>
              <span class="num">${cardMinutes || 0} min</span>
            </div>
            <div class="tline big">
              <span class="lbl">Hours</span>
              <span class="num">${cardMinutes ? hrs(cardMinutes) : "0.00"}</span>
            </div>
          </div>
        </div>

        ${uncertain > 0 && html`
          <p class="note">${uncertain} row${uncertain === 1 ? "" : "s"} read at low confidence. Verify against the card.</p>
        `}

        <div class="byday">
          ${!!byDay.length && html`
            <h2>By day</h2>
            ${byDay.map((d) => html`
              <div class="daybox" key=${d.date}>
                <div class="dayhead">
                  <span>${dayLabel(d.date)}${d.date === today ? " · today" : ""}</span>
                  <button class="copy" onClick=${() => copyDay(d)}>
                    ${copied === d.date ? "Copied" : "Copy"}
                  </button>
                </div>
                ${d.list.map((s, i) => html`
                  <div class="shift" key=${i}>
                    <span class="n">${i + 1}</span>
                    <span class="span">
                      ${clock12(s.in)}–${clock12(s.out)}${s.overnight ? " +1" : ""}
                      ${s.out.date !== s.in.date ? ` (${dayLabel(s.out.date)})` : ""}
                    </span>
                    <b>${hrs(s.minutes)} h</b>
                  </div>
                `)}
                <div class="daytotal">
                  <span>${d.list.length} shift${d.list.length === 1 ? "" : "s"}</span>
                  <b>${hrs(d.minutes)} h</b>
                </div>
                ${Math.abs(d.sumOfRounded - Number(hrs(d.minutes))) >= 0.005 && html`
                  <p class="note">
                    Rounding each shift gives ${d.sumOfRounded.toFixed(2)} h. Submit ${hrs(d.minutes)} h for a single daily figure.
                  </p>
                `}
              </div>
            `)}
          `}

          ${open && html`
            <p class="note">Open shift since ${clock12(open.in)}. It won't count until there's a matching OUT.</p>
          `}
          ${notes.map((n, i) => html`<p class="note" key=${i}>${n}</p>`)}
          ${punches.length > 0 && html`
            <button class="btn btn-secondary reset" onClick=${clearCard}>Clear card</button>
          `}
        </div>

        <p class="disclaimer">
          The times here are read from your photo by an AI, and it can misread a faint or
          crooked stamp. Look over every row against the card before you turn in your hours.
        </p>
        <label class="contrib">
          <input type="checkbox" checked=${contribute} onChange=${toggleContribute} />
          <span>Share my card photos to improve the reader.</span>
        </label>
        <label class="contrib">
          <input type="checkbox" checked=${fast} onChange=${toggleFast} />
          <span>
            Fast mode.${" "}
            <button type="button" class="linklike" onClick=${() => setFastInfo((v) => !v)}>[What's this?]</button>
          </span>
        </label>
        ${fastInfo && html`<p class="fasthelp">Uses a less accurate, but faster model.</p>`}
        <p class="footlink">
          <a href="/stats">Usage stats</a>
          <span aria-hidden="true"> · </span>
          <button class="linklike" onClick=${() => setPrivacy(true)}>Your photo and privacy</button>
        </p>
      </div>

      ${!lowConfSeen && uncertain > 0 && editing === null && html`
        <div class="dialog-backdrop">
          <div class="dialog" role="dialog" aria-modal="true">
            <div class="dialog-title">Low confidence read</div>
            <div class="dialog-body">
              ${uncertain} row${uncertain === 1 ? " was" : "s were"} read at low confidence. Verify against the card before you submit.
            </div>
            <div class="dialog-actions">
              <button class="btn btn-secondary" onClick=${() => setLowConfSeen(true)}>Dismiss</button>
              <button
                class="btn btn-primary"
                onClick=${() => { setLowConfSeen(true); if (lowSlot >= 0) openRow(lowSlot); }}
              >
                Review row
              </button>
            </div>
          </div>
        </div>
      `}

      ${tutorial && html`
        <div class="stage">
          <div class="stagebar">
            <span>How it works</span>
            <button class="x" onClick=${closeTutorial}>Close</button>
          </div>
          <div class="tutbody">
            <ol class="tut">
              <li>Photograph the punch card, or add rows by hand.</li>
              <li>The reader fills in each IN and OUT time. Tap any row to fix one.</li>
              <li>Rows marked [?] were read with low confidence — check those against the card.</li>
              <li>Hours is your running total. Tap a stat card to copy it and open the OBU hours page.</li>
            </ol>
          </div>
          <div class="tutfoot">
            <button class="btn btn-primary" onClick=${closeTutorial}>Got it</button>
          </div>
        </div>
      `}

      ${privacy && html`
        <div class="dialog-backdrop">
          <div class="dialog" role="dialog" aria-modal="true">
            <div class="dialog-title">Your photo and privacy</div>
            <div class="dialog-body">
              <p>
                When you read a card, the photo is sent over HTTPS to Google's Gemini
                vision service, which returns the times it can make out. Our server
                relays it and records the read in anonymous usage counts.
              </p>
              <p>
                <b>"Share my card photos"</b> is on by default. While it's on, the photo
                you submit and the times the reader returned are saved so misreads can
                be found and fixed. It can include your name and ID if they're on the
                card. Untick the box and nothing from your reads is kept.
              </p>
              <p>
                Either way, your punch rows and totals stay in this browser and are
                never uploaded. The sample card uses a smaller model and is never saved.
              </p>
            </div>
            <div class="dialog-actions">
              <button class="btn btn-primary" onClick=${() => setPrivacy(false)}>Got it</button>
            </div>
          </div>
        </div>
      `}

      ${iosHelp && html`
        <div class="dialog-backdrop">
          <div class="dialog" role="dialog" aria-modal="true">
            <div class="dialog-title">Add to Home Screen</div>
            <div class="dialog-body">
              In Safari, tap the Share button, then choose "Add to Home Screen".
            </div>
            <div class="dialog-actions">
              <button class="btn btn-primary" onClick=${() => setIosHelp(false)}>Got it</button>
            </div>
          </div>
        </div>
      `}
    </div>
  `;
}

const mount =
  typeof document !== "undefined" && document.getElementById("app");
if (mount) render(html`<${TimeCard} />`, mount);

if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    location.reload(); // a new worker took over - pick up the fresh assets
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

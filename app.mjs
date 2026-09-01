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

const html = htmFactory.bind(h);

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
async function readCardImage(dataURL, onStep = () => {}) {
  let res;
  try {
    res = await fetch("/api/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: dataURL }),
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
  return found;
}

/* ---------------------------------- view ---------------------------------- */

export function TimeCard() {
  const [punches, setPunches] = useState([]);
  const [other, setOther] = useState("");
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState({ date: todayISO(), time: nowHM() });
  const [status, setStatus] = useState("idle"); // idle | camera | reading
  const [readMsg, setReadMsg] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [fresh, setFresh] = useState([]);
  const [copied, setCopied] = useState(null);
  const [shot, setShot] = useState(null);

  const library = useRef(null);
  const video = useRef(null);
  const stream = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        const saved = await storage.get("timecard:v1");
        if (saved) {
          const v = JSON.parse(saved.value);
          setPunches(v.punches || []);
          setOther(v.other || "");
        }
      } catch (e) { /* nothing saved yet */ }
    })();
  }, []);

  useEffect(() => {
    if (!punches.length && !other) return;
    storage.set("timecard:v1", JSON.stringify({ punches, other }));
  }, [punches, other]);

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
  const otherMinutes = Math.max(0, parseInt(other, 10) || 0);
  const totalMinutes = cardMinutes + otherMinutes;
  const open = shifts.find((s) => s.open);

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

  const done = shifts.filter((s) => s.out && !s.bad);
  const last = done[done.length - 1];

  /* Rows to show: every slot that holds a punch, plus a slot being edited. */
  const rows = grid
    .map((p, i) => ({ p, i }))
    .filter(({ p, i }) => p || editing === i);
  const uncertain = grid.filter((p) => p && p.confidence != null && p.confidence < 0.6).length;

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
  }

  async function grabFrame() {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const c = toCanvas(v, v.videoWidth, v.videoHeight, 1600);
    stopCamera();
    await send({ src: shotURL(c) });
  }

  async function onFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError("");
    try {
      const s = await loadShot(file);
      await send(s);
    } catch (err) {
      setError(err.message || "That photo could not be read.");
      setStatus("idle");
    }
  }

  async function send(s) {
    setShot(s);
    setStatus("reading");
    setReadMsg("Sending the photo…");
    setError("");
    try {
      const found = await readCardImage(s.src, setReadMsg);
      const merged = layout([...punches, ...found]);
      const keys = new Set(found.map((p) => `${p.type}|${p.date}|${p.time}`));
      setFresh(merged.map((p, i) => (p && keys.has(`${p.type}|${p.date}|${p.time}`) ? i : -1)).filter((i) => i >= 0));
      setPunches(merged.filter(Boolean));
      setShot(null);
      setStatus("idle");
      setReadMsg("");
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
  function clearCard() {
    setPunches([]);
    setOther("");
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
            <span>Line the card up in the frame, then take the photo</span>
            <button class="x" onClick=${() => { stopCamera(); setStatus("idle"); }}>Cancel</button>
          </div>
          <div class="stagebody">
            <video ref=${video} playsinline muted></video>
            <div class="guide"></div>
          </div>
          <div class="shutterbar">
            <button class="shutter" onClick=${grabFrame} aria-label="Take photo"></button>
          </div>
        </div>
      `}

      ${status === "reading" && shot && html`
        <div class="stage">
          <div class="stagebar">
            <span>Reading your card…</span>
            <span class="elapsed">${elapsed}s</span>
          </div>
          <div class="stagebody">
            <div class="frame">
              <img src=${shot.src} alt="Photo of the time card" />
              <div class="bar"></div>
            </div>
          </div>
          <div class="readpanel">
            <p class="readnote">${readMsg || "Sending the photo…"}</p>
          </div>
        </div>
      `}

      <header class="appbar"><h1>Time Card</h1></header>

      <div class="wrap">
        <p class="intro">Photograph your punch card to total your hours.</p>
        <p class="ainote">An AI reads the photo and can misread a faint stamp. Check every row against the card before you submit your hours.</p>

        <div class="stats">
          <button
            class="stat"
            onClick=${() => last && copy(hrs(last.minutes), "last")}
            disabled=${!last}
          >
            <span class="tag">Last shift</span>
            <span class="figure">${last ? hrs(last.minutes) : "—"}</span>
            <span class="sub">
              ${last
                ? `${clock12(last.in)}–${clock12(last.out)} · ${last.minutes} min`
                : "No completed shift yet"}
            </span>
            <span class="cue">${copied === "last" ? "Copied" : last ? "Tap to copy" : ""}</span>
          </button>
          <button
            class="stat today"
            onClick=${() => todayRow && copy(hrs(todayRow.minutes), "today")}
            disabled=${!todayRow}
          >
            <span class="tag">Today</span>
            <span class="figure">${todayRow ? hrs(todayRow.minutes) : "0.00"}</span>
            <span class="sub">
              ${todayRow
                ? `${todayRow.list.length} shift${todayRow.list.length === 1 ? "" : "s"} · ${todayRow.minutes} min`
                : "No shifts today"}
            </span>
            <span class="cue">${copied === "today" ? "Copied" : todayRow ? "Tap to copy" : ""}</span>
          </button>
        </div>

        <div class="actions">
          <button class="btn key" onClick=${openCamera}>Take photo</button>
          <button class="btn" onClick=${() => library.current.click()}>Choose photo</button>
        </div>
        <input ref=${library} type="file" accept="image/*" onChange=${onFile} hidden />
        ${error && html`<div class="err">${error}</div>`}

        <div class="card">
          <div class="cardhead">
            <span class="h">Punches</span>
            <span class="hint-h">Tap a row to edit</span>
          </div>

          <div class="grid">
            ${rows.length === 0 && editing === null && html`
              <div class="row"><span class="empty">No punches yet. Take a photo of your card, or add one by hand.</span></div>
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
                          <input type="date" value=${draft.date} aria-label="Date"
                            onInput=${(e) => setDraft({ ...draft, date: e.target.value })} />
                          <input type="time" value=${draft.time} aria-label="Time"
                            onInput=${(e) => setDraft({ ...draft, time: e.target.value })} />
                          <button class="mini go" onClick=${saveRow}>Save</button>
                          <button class="mini drop" onClick=${clearRow}>Remove</button>
                          <button class="mini" onClick=${() => setEditing(null)}>Cancel</button>
                        </div>
                      `
                    : html`
                        <button class="val" onClick=${() => openRow(i)}>
                          <span class=${`punched${fresh.includes(i) ? " ink" : ""}${low ? " low" : ""}`}>
                            ${stamp(p)}${low ? html`<span class="qmark" title="Low confidence — verify this row">?</span>` : ""}
                          </span>
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
            <button class="add" onClick=${addPunch}>Add punch</button>
          </div>
          ${uncertain > 0 && html`
            <p class="uncertainnote">
              ${uncertain} row${uncertain === 1 ? " was" : "s were"} read with low confidence. Verify ${uncertain === 1 ? "it" : "them"} against the card.
            </p>
          `}

          <div class="totals">
            <div class="tline">
              <span class="lbl">This card</span>
              <span class="num">${cardMinutes || 0} min</span>
            </div>
            <div class="tline">
              <span class="lbl">Other cards</span>
              <input class="num" inputMode="numeric" value=${other} aria-label="Minutes from other cards"
                onInput=${(e) => setOther(e.target.value.replace(/[^0-9]/g, ""))} />
            </div>
            <div class="tline">
              <span class="lbl">Total minutes</span>
              <span class="num">${totalMinutes || 0} min</span>
            </div>
            <div class="tline big">
              <span class="lbl">Hours</span>
              <span class="num">${totalMinutes ? hrs(totalMinutes) : "0.00"}</span>
            </div>
          </div>
        </div>

        <div class="byday">
          ${!!byDay.length && html`
            <h2>By day</h2>
            ${byDay.map((d) => html`
              <div class="daybox" key=${d.date}>
                <div class="dayhead">
                  <span>${dayLabel(d.date)}${d.date === today ? " (today)" : ""}</span>
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
                    <span class="mins">${s.minutes} min</span>
                  </div>
                `)}
                <div class="daytotal">
                  <span>${d.list.length} shift${d.list.length === 1 ? "" : "s"}</span>
                  <b>${hrs(d.minutes)} h · ${d.minutes} min</b>
                </div>
                ${Math.abs(d.sumOfRounded - Number(hrs(d.minutes))) >= 0.005 && html`
                  <p class="note small">
                    Rounding each shift individually gives ${d.sumOfRounded.toFixed(2)} h.
                    Submit ${hrs(d.minutes)} h for a single daily figure.
                  </p>
                `}
              </div>
            `)}
          `}

          ${open && html`
            <p class="note">Open shift since ${clock12(open.in)}. It won't count until there's a matching OUT.</p>
          `}
          ${notes.map((n, i) => html`<p class="note" key=${i}>${n}</p>`)}
          ${(punches.length > 0 || other) && html`
            <button class="btn reset" onClick=${clearCard}>Clear card</button>
          `}
        </div>
      </div>
    </div>
  `;
}

const mount =
  typeof document !== "undefined" && document.getElementById("app");
if (mount) render(html`<${TimeCard} />`, mount);

if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

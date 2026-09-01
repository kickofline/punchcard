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
  SLOTS,
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

/* Three ways in, because iPhone photos arrive as HEIC and some webviews
   refuse blob: URLs. Returns a JPEG data URL, long edge capped so the upload
   to the reader stays small. */
async function loadShot(file) {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      const c = toCanvas(bmp, bmp.width, bmp.height, 1600);
      bmp.close?.();
      return { src: c.toDataURL("image/jpeg", 0.9) };
    } catch (e) { /* next route */ }
  }
  let dataURL = null;
  try {
    dataURL = await asDataURL(file);
    const img = await asImage(dataURL);
    const c = toCanvas(img, img.naturalWidth || img.width, img.naturalHeight || img.height, 1600);
    return { src: c.toDataURL("image/jpeg", 0.9) };
  } catch (e) { /* next route */ }
  try {
    const url = URL.createObjectURL(file);
    const img = await asImage(url);
    const c = toCanvas(img, img.naturalWidth || img.width, img.naturalHeight || img.height, 1600);
    URL.revokeObjectURL(url);
    return { src: c.toDataURL("image/jpeg", 0.9) };
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

/* Send the photo to the server, which relays it to the vision model and
   returns { punches: [{type,date,time}] }. */
async function readCardImage(dataURL) {
  let res;
  try {
    res = await fetch("/api/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: dataURL }),
    });
  } catch (e) {
    throw new Error("Could not reach the reader. Check your connection and try again.");
  }
  let body = {};
  try {
    body = await res.json();
  } catch (e) { /* leave body empty */ }
  if (!res.ok) {
    throw new Error(body.error || "The reader could not read that photo. Try again.");
  }
  const found = (body.punches || []).filter(isPunch);
  if (!found.length) {
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
  const [error, setError] = useState("");
  const [fresh, setFresh] = useState([]);
  const [showAll, setShowAll] = useState(false);
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

  const lastFilled = grid.reduce((n, p, i) => (p ? i : n), -1);
  const visible = showAll ? SLOTS : Math.min(SLOTS, Math.max(6, lastFilled + 3));

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
    await send({ src: c.toDataURL("image/jpeg", 0.9) });
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
    setError("");
    try {
      const found = await readCardImage(s.src);
      const merged = layout([...punches, ...found]);
      const keys = new Set(found.map((p) => `${p.type}|${p.date}|${p.time}`));
      setFresh(merged.map((p, i) => (p && keys.has(`${p.type}|${p.date}|${p.time}`) ? i : -1)).filter((i) => i >= 0));
      setPunches(merged.filter(Boolean));
      setShot(null);
      setStatus("idle");
      setTimeout(() => setFresh([]), 2500);
    } catch (err) {
      setError(err.message || "That photo could not be read.");
      setShot(null);
      setStatus("idle");
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
  function punchNow(type) {
    setPunches([...grid.filter(Boolean), { type, date: todayISO(), time: nowHM() }]);
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
    <div class="desk">
      ${status === "camera" && html`
        <div class="stage">
          <div class="stagebar">
            <span>Fill the frame with the card, then tap the shutter</span>
            <button class="btn" onClick=${() => { stopCamera(); setStatus("idle"); }}>Cancel</button>
          </div>
          <div class="stagebody">
            <video ref=${video} playsinline muted></video>
            <div class="guide"></div>
          </div>
          <div class="shutterbar">
            <button class="shutter" onClick=${grabFrame} aria-label="Capture"></button>
          </div>
        </div>
      `}

      ${status === "reading" && shot && html`
        <div class="stage">
          <div class="stagebar">
            <span>Reading the card…</span>
          </div>
          <div class="stagebody">
            <div class="frame">
              <img src=${shot.src} alt="Captured time card" />
              <div class="scan"></div>
            </div>
          </div>
        </div>
      `}

      <div class="wrap">
        <div class="masthead">
          <h1>Time card</h1>
          <p>Point the camera at the card and the punches come across.</p>
        </div>

        <div class="tiles">
          <button
            class="tile"
            onClick=${() => last && copy(hrs(last.minutes), "last")}
            disabled=${!last}
          >
            <span class="tag">Last clock</span>
            <span class="figure">${last ? hrs(last.minutes) : "—"}</span>
            <span class="sub">
              ${last
                ? `${clock12(last.in)} to ${clock12(last.out)} · ${last.minutes} min`
                : "no finished clock yet"}
            </span>
            <span class="cue">${copied === "last" ? "Copied" : last ? "Tap to copy" : ""}</span>
          </button>
          <button
            class="tile now"
            onClick=${() => todayRow && copy(hrs(todayRow.minutes), "today")}
            disabled=${!todayRow}
          >
            <span class="tag">Today</span>
            <span class="figure">${todayRow ? hrs(todayRow.minutes) : "0.00"}</span>
            <span class="sub">
              ${todayRow
                ? `${todayRow.list.length} clock${todayRow.list.length === 1 ? "" : "s"} · ${todayRow.minutes} min`
                : "nothing punched today"}
            </span>
            <span class="cue">${copied === "today" ? "Copied" : todayRow ? "Tap to copy" : ""}</span>
          </button>
        </div>

        <div class="actions">
          <button class="btn key" onClick=${openCamera}>Use camera</button>
          <button class="btn" onClick=${() => library.current.click()}>Upload a photo</button>
          <button class="btn" onClick=${() => punchNow(open ? "OUT" : "IN")}>
            ${open ? "Punch out now" : "Punch in now"}
          </button>
        </div>
        <input ref=${library} type="file" accept="image/*" onChange=${onFile} hidden />
        ${error && html`<div class="err">${error}</div>`}

        <div class="card">
          <div class="cardhead">
            <span>Punch record</span>
            <span>tap a line to edit</span>
          </div>

          <div class="grid">
            ${Array.from({ length: visible }, (_, i) => {
              const p = grid[i];
              const shift = shifts.find((s) => s.slot === (i % 2 === 0 ? i : i - 1));
              const showDur = i % 2 === 1 && shift && shift.out;
              return html`
                <div key=${i} class=${`row${editing === i ? " editing" : ""}`}>
                  <div class="lab">${slotType(i)}</div>
                  ${editing === i
                    ? html`
                        <div class="editor">
                          <input type="date" value=${draft.date} aria-label="Date"
                            onInput=${(e) => setDraft({ ...draft, date: e.target.value })} />
                          <input type="time" value=${draft.time} aria-label="Time"
                            onInput=${(e) => setDraft({ ...draft, time: e.target.value })} />
                          <button class="mini go" onClick=${saveRow}>Save</button>
                          ${p && html`<button class="mini drop" onClick=${clearRow}>Erase</button>`}
                          <button class="mini" onClick=${() => setEditing(null)}>Cancel</button>
                        </div>
                      `
                    : html`
                        <button class="val" onClick=${() => openRow(i)}>
                          ${p
                            ? html`<span class=${`punched${fresh.includes(i) ? " ink" : ""}`}>${stamp(p)}</span>`
                            : html`<span class="hint">tap to punch ${slotType(i).toLowerCase()}</span>`}
                          ${showDur && html`
                            <span class=${`dur${shift.bad ? " flag" : ""}`}>
                              ${shift.bad ? "check this" : `${hrs(shift.minutes)} h`}
                            </span>
                          `}
                        </button>
                      `}
                </div>
              `;
            })}
            ${!showAll && visible < SLOTS && html`
              <button class="more" onClick=${() => setShowAll(true)}>
                Show the remaining ${SLOTS - visible} lines
              </button>
            `}
          </div>

          <div class="totals">
            <div class="tline">
              <span>Subtotal Minutes for this card:</span>
              <span class="fill"></span>
              <span class="num">${cardMinutes || ""}</span>
            </div>
            <div class="tline">
              <span>Subtotal Minutes from other cards:</span>
              <span class="fill"></span>
              <input class="num" inputMode="numeric" value=${other} aria-label="Minutes from other cards"
                onInput=${(e) => setOther(e.target.value.replace(/[^0-9]/g, ""))} />
            </div>
            <div class="tline">
              <span>Total Minutes:</span>
              <span class="fill"></span>
              <span class="num">${totalMinutes || ""}</span>
            </div>
            <div class="tline big">
              <span>Minutes divided by 60 = hours (to the hundredths)</span>
              <span class="fill"></span>
              <span class="num">${totalMinutes ? hrs(totalMinutes) : ""}</span>
            </div>
          </div>
        </div>

        <div class="aside">
          ${!!byDay.length && html`
            <h2>Every clock</h2>
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
                      ${clock12(s.in)} to ${clock12(s.out)}
                      ${s.out.date !== s.in.date ? ` (${dayLabel(s.out.date)})` : ""}
                    </span>
                    <b>${hrs(s.minutes)} h</b>
                    <span class="mins">${s.minutes} min</span>
                  </div>
                `)}
                <div class="daytotal">
                  <span>${d.list.length} clock${d.list.length === 1 ? "" : "s"}</span>
                  <b>${hrs(d.minutes)} h · ${d.minutes} min</b>
                </div>
                ${Math.abs(d.sumOfRounded - Number(hrs(d.minutes))) >= 0.005 && html`
                  <p class="warn small">
                    Each clock rounded and added comes to ${d.sumOfRounded.toFixed(2)} h. Submit ${hrs(d.minutes)} h
                    if the form wants one figure for the day.
                  </p>
                `}
              </div>
            `)}
          `}

          ${open && html`
            <p class="warn">
              Still clocked in since ${clock12(open.in)}. Nothing counts until you punch out.
            </p>
          `}
          ${notes.map((n, i) => html`<p class="warn" key=${i}>${n}</p>`)}
          ${!byDay.length && !open && html`<p>Nothing on the card yet. Shoot it, or tap any line to enter a punch.</p>`}
          ${(punches.length > 0 || other) && html`
            <button class="btn" style=${{ marginTop: 12 }} onClick=${clearCard}>Start a new card</button>
          `}
        </div>
      </div>
    </div>
  `;
}

const mount =
  typeof document !== "undefined" && document.getElementById("app");
if (mount) render(html`<${TimeCard} />`, mount);

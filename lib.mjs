/* Framework-free time-card logic. Safe to import from Node (tests) or the browser.
   Nothing in here touches the DOM, the network, or storage. */

export const SLOTS = 24; // 12 IN/OUT pairs, same as the paper card
export const slotType = (i) => (i % 2 === 0 ? "IN" : "OUT");
export const MON = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];

/* "gemini-3.5-flash-lite" -> "3.5 flash lite"; "gemini-flash-latest" -> "flash".
   For short status lines. */
export function prettyModel(id) {
  return String(id || "")
    .replace(/^gemini-/, "")
    .replace(/-latest$/, "")
    .replace(/-/g, " ")
    .trim() || "the reader";
}

export const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const nowHM = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/* Print a punch the way the machine prints it: 31 AUG '26 PM1:35 */
export function stamp(p) {
  const [y, m, d] = p.date.split("-").map(Number);
  const [hh, mm] = p.time.split(":").map(Number);
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${String(d).padStart(2, "0")} ${MON[m - 1]} '${String(y).slice(2)} ${hh < 12 ? "AM" : "PM"}${h12}:${String(mm).padStart(2, "0")}`;
}

export const minutesOf = (p) => {
  const [y, m, d] = p.date.split("-").map(Number);
  const [hh, mm] = p.time.split(":").map(Number);
  return Date.UTC(y, m - 1, d, hh, mm) / 60000;
};

export const hrs = (mins) => (mins / 60).toFixed(2);

export const clock12 = (p) => {
  const [hh, mm] = p.time.split(":").map(Number);
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${String(mm).padStart(2, "0")} ${hh < 12 ? "AM" : "PM"}`;
};

export const dayLabel = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MON[m - 1]} ${y}`;
};

export const isPunch = (p) =>
  !!p &&
  (p.type === "IN" || p.type === "OUT") &&
  /^\d{4}-\d{2}-\d{2}$/.test(p.date) &&
  /^\d{2}:\d{2}$/.test(p.time);

/* Sort punches, then drop them into the fixed IN/OUT grid in reading order. */
export function layout(punches) {
  const seen = new Set();
  const clean = punches
    .filter(isPunch)
    .filter((p) => {
      const k = `${p.type}|${p.date}|${p.time}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => minutesOf(a) - minutesOf(b));

  const grid = Array(SLOTS).fill(null);
  let cursor = 0;
  for (const p of clean) {
    let i = cursor;
    while (i < SLOTS && slotType(i) !== p.type) i++;
    if (i >= SLOTS) break;
    grid[i] = p;
    cursor = i + 1;
  }
  return grid;
}

/* Pair each IN row with the OUT row under it. */
export function readCard(grid) {
  const shifts = [];
  const notes = [];
  for (let i = 0; i < SLOTS; i += 2) {
    const inP = grid[i];
    const outP = grid[i + 1];
    if (!inP && !outP) continue;
    if (!inP && outP) {
      notes.push(`Line ${i + 2} has a punch out with no punch in above it.`);
      continue;
    }
    if (inP && !outP) {
      shifts.push({ slot: i, in: inP, out: null, minutes: 0, open: true });
      continue;
    }
    const mins = minutesOf(outP) - minutesOf(inP);
    if (mins < 0) {
      notes.push(`Line ${i + 2} punches out before the punch in above it.`);
      shifts.push({ slot: i, in: inP, out: outP, minutes: 0, bad: true });
    } else {
      shifts.push({ slot: i, in: inP, out: outP, minutes: mins });
    }
  }
  return { shifts, notes };
}

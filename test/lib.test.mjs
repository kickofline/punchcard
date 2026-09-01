import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SLOTS,
  slotType,
  stamp,
  clock12,
  dayLabel,
  minutesOf,
  hrs,
  isPunch,
  layout,
  readCard,
} from "../lib.mjs";

/* ------------------------------ format helpers ------------------------------ */

test("stamp prints the way the machine prints it", () => {
  assert.equal(stamp({ date: "2026-08-31", time: "13:35" }), "31 AUG '26 PM1:35");
  assert.equal(stamp({ date: "2026-01-05", time: "00:05" }), "05 JAN '26 AM12:05");
});

test("clock12 renders a 12-hour wall clock", () => {
  assert.equal(clock12({ date: "2026-08-31", time: "13:35" }), "1:35 PM");
  assert.equal(clock12({ date: "2026-08-31", time: "08:02" }), "8:02 AM");
});

test("dayLabel renders a human date", () => {
  assert.equal(dayLabel("2026-08-31"), "31 AUG 2026");
});

test("hrs is minutes over 60 to the hundredth", () => {
  assert.equal(hrs(510), "8.50");
  assert.equal(hrs(0), "0.00");
});

test("minutesOf yields a difference matching wall-clock elapsed time", () => {
  const a = minutesOf({ date: "2026-08-31", time: "09:00" });
  const b = minutesOf({ date: "2026-08-31", time: "17:30" });
  assert.equal(b - a, 510);
});

/* --------------------------------- isPunch --------------------------------- */

test("isPunch validates the type, date and time shape", () => {
  assert.equal(isPunch({ type: "IN", date: "2026-08-31", time: "13:35" }), true);
  assert.equal(isPunch({ type: "OUT", date: "2026-08-31", time: "13:35" }), true);
  assert.equal(isPunch({ type: "in", date: "2026-08-31", time: "13:35" }), false);
  assert.equal(isPunch({ date: "2026-08-31", time: "13:35" }), false);
  assert.equal(isPunch({ type: "IN", date: "8/31/26", time: "13:35" }), false);
  assert.equal(isPunch({ type: "IN", date: "2026-08-31", time: "1:35" }), false);
  assert.equal(isPunch(null), false);
});

/* --------------------------------- layout ---------------------------------- */

test("layout sorts, de-dupes, and drops punches into the IN/OUT grid", () => {
  const grid = layout([
    { type: "OUT", date: "2026-08-31", time: "17:30" },
    { type: "IN", date: "2026-08-31", time: "09:00" },
    { type: "IN", date: "2026-08-31", time: "09:00" },
  ]);
  assert.equal(grid.length, SLOTS);
  assert.equal(slotType(0), "IN");
  assert.equal(grid[0].time, "09:00");
  assert.equal(grid[1].time, "17:30");
  assert.equal(grid[2], null);
});

/* -------------------------------- readCard -------------------------------- */

test("readCard pairs each IN row with the OUT row below it", () => {
  const grid = layout([
    { type: "IN", date: "2026-08-31", time: "09:00" },
    { type: "OUT", date: "2026-08-31", time: "17:30" },
  ]);
  const { shifts, notes } = readCard(grid);
  assert.equal(notes.length, 0);
  assert.equal(shifts.length, 1);
  assert.equal(shifts[0].minutes, 510);
});

test("readCard flags an OUT punch with no IN above it", () => {
  const grid = Array(SLOTS).fill(null);
  grid[1] = { type: "OUT", date: "2026-08-31", time: "17:30" };
  const { shifts, notes } = readCard(grid);
  assert.equal(shifts.length, 0);
  assert.match(notes[0], /punch out with no punch in/i);
});

test("readCard leaves an unclosed shift open", () => {
  const grid = Array(SLOTS).fill(null);
  grid[0] = { type: "IN", date: "2026-08-31", time: "09:00" };
  const { shifts } = readCard(grid);
  assert.equal(shifts[0].open, true);
  assert.equal(shifts[0].minutes, 0);
});

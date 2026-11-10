import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TIME_RULES as R, checkPastDayTimes, checkTypedTime, parseTime } from "../src/lib/sheet";

const at = (hh: number, mm: number) => hh * 60 + mm; // school clock, minutes since midnight
const err = (c: ReturnType<typeof checkTypedTime>) => (c.ok ? "" : c.error);

test("typed times are read however people write them", () => {
  for (const [raw, want] of [
    ["09:05", "09:05"], ["9:05", "09:05"], ["905", "09:05"], ["0905", "09:05"], ["9.05", "09:05"],
    ["9:05 am", "09:05"], ["9:05AM", "09:05"], ["9:05 p.m.", "21:05"], ["12:10 am", "00:10"], ["12:10 pm", "12:10"],
    ["16:30", "16:30"], [" 4:30 pm ", "16:30"], ["09:05:59", "09:05"],
  ] as const) assert.equal(parseTime(raw), want, raw);
  for (const raw of ["", "9", "25:00", "9:60", "13:00 pm", "0:30 am", "abc", "9:5", null, 905]) assert.equal(parseTime(raw), null, String(raw));
});

test("start: now or within the window is accepted, and how late it was typed is kept", () => {
  assert.deepEqual(checkTypedTime("start", "09:12", at(9, 12), R), { ok: true, time: "09:12", lateBy: 0 });
  assert.deepEqual(checkTypedTime("start", "8:57 am", at(9, 12), R), { ok: true, time: "08:57", lateBy: 15 });
});

test("start: no future times, nothing older than the window", () => {
  assert.match(err(checkTypedTime("start", "09:13", at(9, 12), R)), /hasn't happened yet/);
  assert.match(err(checkTypedTime("start", "08:56", at(9, 12), R)), /last 15 minutes .*8:57 am to 9:12 am/);
  assert.match(err(checkTypedTime("start", "07:00", at(9, 12), R)), /Ask a staff member/);
});

test("AM/PM mix-ups are explained, not silently accepted", () => {
  assert.match(err(checkTypedTime("start", "1:05", at(13, 10), R)), /Did you mean 1:05 pm/); // typed 01:05 at 1:10 pm
  assert.match(err(checkTypedTime("start", "9:05 pm", at(9, 10), R)), /Did you mean 9:05 am/);
});

test("end: must come after the start and after the start was entered, with a sensible length", () => {
  const start = { time: "09:00", enteredAtMinutes: at(9, 10) };
  assert.deepEqual(checkTypedTime("end", "4:00 pm", at(16, 3), R, start), { ok: true, time: "16:00", lateBy: 3 });
  assert.match(err(checkTypedTime("end", "08:59", at(9, 5), R, { time: "09:00", enteredAtMinutes: null })), /after your start time/);
  // Entered start "9:00" at 9:10, so they can't claim to have left at 9:06.
  assert.match(err(checkTypedTime("end", "09:06", at(9, 12), R, start)), /entered your start time at 9:10 am/);
  assert.match(err(checkTypedTime("end", "09:03", at(9, 3), R, { time: "09:00", enteredAtMinutes: null })), /only 3 minutes/);
  assert.match(err(checkTypedTime("end", "22:00", at(22, 0), R, { time: "09:00", enteredAtMinutes: null })), /more than 12 hours/);
  assert.match(err(checkTypedTime("end", "16:00", at(16, 0), R)), /start time first/);
});

test("the window never reaches back past midnight", () => {
  assert.equal(checkTypedTime("start", "00:00", at(0, 5), R).ok, true);
  assert.equal(checkTypedTime("start", "23:55", at(0, 5), R).ok, false);
});

test("a window of 0 means students can only enter the current minute", () => {
  const strict = { ...R, windowMinutes: 0 };
  assert.equal(checkTypedTime("start", "09:12", at(9, 12), strict).ok, true);
  assert.equal(checkTypedTime("start", "09:11", at(9, 12), strict).ok, false);
});

// ---------- A past day the student fills in later ----------

test("past day: readable times, end after start, sensible length", () => {
  const rules = { minMinutes: 5, maxMinutes: 720 };
  const ok = checkPastDayTimes("09:00", "14:30", rules);
  assert.deepEqual(ok, { ok: true, start: "09:00", end: "14:30", minutes: 330 });
  assert.equal((checkPastDayTimes("9:05 am", "2:30 pm", rules) as { minutes: number }).minutes, 325);
  const bad = (a: string, b: string) => checkPastDayTimes(a, b, rules) as { ok: false; field: string; error: string };
  assert.equal(bad("", "14:00").field, "startTime");
  assert.equal(bad("09:00", "nope").field, "endTime");
  // 9:00 to 1:00 is most likely 1:00 pm.
  assert.match(bad("09:00", "01:00").error, /Did you mean 1:00 pm/);
  assert.match(bad("14:00", "13:00").error, /after your start time/);
  assert.match(bad("09:00", "09:03").error, /only 3 minutes/);
  assert.match(bad("06:00", "19:00").error, /more than 12 hours/);
});

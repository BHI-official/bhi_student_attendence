import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, attendanceLevel, attendanceSummary, editWindow, enrollmentState } from "../src/lib/sheet";
import { pinFingerprint, uniquePin, weakPin } from "../src/lib/pin";
import { checkInkPng } from "../src/lib/png";
import type { Entry } from "../src/lib/types";

test("the editing window: a row is open for 7 days after its class day, then locked", () => {
  assert.equal(addDays("2026-09-28", 7), "2026-10-05"); // across a month end
  assert.equal(addDays("2026-12-28", 7), "2027-01-04"); // across a year end
  assert.equal(addDays("2026-03-05", -7), "2026-02-26");
  const day = "2026-09-01";
  assert.equal(editWindow(day, "2026-09-01", 7).locked, false);
  assert.equal(editWindow(day, "2026-09-08", 7).locked, false); // the 7th day after is still open
  assert.equal(editWindow(day, "2026-09-09", 7).locked, true);
  assert.equal(editWindow(day, "2026-09-08", 7).lastDay, "2026-09-08");
  assert.equal(editWindow(day, "2026-09-02", 0).locked, true); // 0 = only the day itself
});

const row = (date: string, status: Entry["status"], minutes: number | null = null) => ({ date, status, minutes });
// Mon 2026-09-07 .. Fri 2026-09-11, then Mon 14 .. Fri 18; Mon-Fri classes.
const student = { startDate: "2026-09-07", endDate: "2026-09-30", classDays: [1, 2, 3, 4, 5] };

test("attendance summary: present, absent, unrecorded, excused and holidays", () => {
  const s = attendanceSummary(student, [
    row("2026-09-07", "PRESENT", 420), row("2026-09-08", "PRESENT", 400), row("2026-09-09", "ABSENT"),
    row("2026-09-10", "EXCUSED"), /* 11th: nothing recorded */ row("2026-09-14", "HOLIDAY"),
  ], new Set(["2026-09-15"]), "2026-09-15");
  assert.equal(s.classDays, 7); // 7..11 and 14, 15 (15 is a school holiday, so it counts as decided)
  assert.equal(s.present, 2);
  assert.equal(s.absent, 1);
  assert.equal(s.missing, 1);
  assert.equal(s.excused, 1);
  assert.equal(s.holidays, 2);
  assert.equal(s.minutes, 820);
  assert.equal(s.rate, 50); // 2 present of 4 counted (2 present, 1 absent, 1 missing)
  assert.equal(s.level, "poor");
});

test("attendance summary: today only counts once something is recorded", () => {
  const morning = attendanceSummary(student, [row("2026-09-07", "PRESENT", 420)], new Set(), "2026-09-08");
  assert.equal(morning.classDays, 1);
  assert.equal(morning.rate, 100);
  const arrived = attendanceSummary(student, [row("2026-09-07", "PRESENT", 420), row("2026-09-08", "PRESENT")], new Set(), "2026-09-08");
  assert.equal(arrived.present, 2);
  assert.equal(attendanceSummary(student, [], new Set(), "2026-09-01").level, "none"); // before the course
  assert.equal(attendanceSummary(student, [], new Set(), "2026-09-07").rate, null); // first day, nothing yet
});

test("attendance summary stops at the course end date", () => {
  const short = { startDate: "2026-09-07", endDate: "2026-09-08", classDays: [1, 2, 3, 4, 5] };
  const s = attendanceSummary(short, [row("2026-09-07", "PRESENT", 60)], new Set(), "2026-12-01");
  assert.equal(s.classDays, 2);
  assert.equal(s.missing, 1);
  assert.equal(s.rate, 50);
});

test("attendance colours: green, orange, red at the thresholds", () => {
  const t = { goodPercent: 90, attentionPercent: 75 };
  assert.equal(attendanceLevel(100, t), "good");
  assert.equal(attendanceLevel(90, t), "good");
  assert.equal(attendanceLevel(89.9, t), "attention");
  assert.equal(attendanceLevel(75, t), "attention");
  assert.equal(attendanceLevel(74.9, t), "poor");
  assert.equal(attendanceLevel(null, t), "none");
});

test("enrollment status", () => {
  const s = { startDate: "2026-09-07", endDate: "2026-09-30", active: true };
  assert.equal(enrollmentState(s, "2026-09-01"), "Not started");
  assert.equal(enrollmentState(s, "2026-09-07"), "Active");
  assert.equal(enrollmentState(s, "2026-10-01"), "Completed");
  assert.equal(enrollmentState({ ...s, active: false }, "2026-09-10"), "Inactive");
});

test("PINs: easy ones are refused, fingerprints depend on the secret", () => {
  for (const p of ["0000", "1111", "1234", "4321", "123456", "7890", "999999"]) assert.equal(weakPin(p), true, p);
  for (const p of ["1357", "2468", "8023", "50912"]) assert.equal(weakPin(p), false, p);
  assert.equal(pinFingerprint("1357", "secret-a"), pinFingerprint("1357", "secret-a"));
  assert.notEqual(pinFingerprint("1357", "secret-a"), pinFingerprint("1357", "secret-b"));
  assert.notEqual(pinFingerprint("1357", "secret-a"), pinFingerprint("1358", "secret-a"));
  assert.doesNotMatch(pinFingerprint("1357", "s"), /1357/);
});

test("PINs: a new PIN is never one that is taken, and grows longer when 4 digits run out", async () => {
  const taken = new Set(["5555", "8023"]);
  let n = 0;
  const seq = [8023, 1234, 5555, 6061]; // taken, weak, taken, free
  const pin = await uniquePin((p) => taken.has(p), () => seq[n++]);
  assert.equal(pin, "6061");
  // Every 4-digit PIN taken: moves on to 5 digits.
  const pin5 = await uniquePin((p) => p.length === 4, (max) => (max === 100000 ? 48213 : 4821));
  assert.equal(pin5, "48213");
  await assert.rejects(uniquePin(() => true));
});

/** A tiny valid PNG of a given size (header only is enough for the checks). */
function png(w: number, h: number, extraBytes = 0) {
  const b = Buffer.alloc(33 + extraBytes);
  b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4); b.writeUInt32BE(13, 8); b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return `data:image/png;base64,${b.toString("base64")}`;
}

test("handwriting images are checked: format, size and dimensions", () => {
  assert.ok("png" in checkInkPng(png(300, 90), "SIGNATURE"));
  assert.ok("error" in checkInkPng(png(20, 10), "SIGNATURE")); // too small to read
  assert.ok("error" in checkInkPng(png(1300, 200), "SIGNATURE")); // too wide for a signature
  assert.ok("png" in checkInkPng(png(1300, 500), "NOTE")); // fine for a note
  assert.ok("error" in checkInkPng(png(1700, 500), "NOTE"));
  assert.ok("error" in checkInkPng(png(300, 90, 400_000), "SIGNATURE")); // too many bytes
  assert.ok("error" in checkInkPng("data:image/jpeg;base64,AAAA", "SIGNATURE"));
  assert.ok("error" in checkInkPng("data:image/png;base64,QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFB", "SIGNATURE")); // not a PNG
  assert.ok("error" in checkInkPng(undefined, "NOTE"));
  assert.ok("error" in checkInkPng(12, "NOTE"));
});

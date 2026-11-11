import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dayStatus, isWeekday, mondayOf, openFrom, safeFileName, sniffExcuse, studentCanExcuse, studentCanSubmit, studentLock, teacherLock, weekDates,
} from "../src/lib/week";

// 2026-11-09 is a Monday.
test("weeks run Monday to Friday; a weekend belongs to the week before", () => {
  assert.equal(mondayOf("2026-11-09"), "2026-11-09");
  assert.equal(mondayOf("2026-11-13"), "2026-11-09"); // Friday
  assert.equal(mondayOf("2026-11-15"), "2026-11-09"); // Sunday
  assert.deepEqual(weekDates("2026-11-09"), ["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13"]);
  assert.equal(isWeekday("2026-11-14"), false);
  assert.equal(mondayOf("2027-01-01"), "2026-12-28"); // across a year end
});

test("students can sign this week and last week only, never the future or a weekend", () => {
  const today = "2026-11-11"; // Wednesday
  assert.equal(openFrom(today), "2026-11-02");
  assert.equal(studentLock("2026-11-11", today), null);
  assert.equal(studentLock("2026-11-02", today), null); // Monday of last week
  assert.match(studentLock("2026-10-30", today)!, /locked/); // Friday two weeks back
  assert.match(studentLock("2026-11-12", today)!, /hasn't happened/);
  assert.match(studentLock("2026-11-07", today)!, /Monday to Friday/);
  // On Monday, last week is still open in full.
  assert.equal(studentLock("2026-11-02", "2026-11-09"), null);
  assert.match(studentLock("2026-10-30", "2026-11-09")!, /locked/);
});

test("teachers: same two weeks for taking attendance", () => {
  assert.equal(teacherLock("2026-11-03", "2026-11-11"), null);
  assert.match(teacherLock("2026-10-29", "2026-11-11")!, /locked/);
  assert.match(teacherLock("2026-11-12", "2026-11-11")!, /hasn't happened/);
});

const sig = { id: "s", at: new Date() };
const staffSig = { ...sig, staffId: "t", staffName: "Dr. Saniya" };
const E = (o: Record<string, unknown>) => ({ status: "PRESENT" as const, studentSignature: null, staffSignature: null, correction: null, ...o });

test("statuses: missing, pending, approved, needs correction, absent, excused, holiday", () => {
  const t = "2026-11-11";
  assert.equal(dayStatus(null, false, "2026-11-10", t), "MISSING");
  assert.equal(dayStatus(null, false, "2026-11-12", t), "UPCOMING");
  assert.equal(dayStatus(E({}), false, "2026-11-10", t), "MISSING"); // marked present, no signature
  assert.equal(dayStatus(E({ studentSignature: sig }), false, "2026-11-10", t), "PENDING");
  assert.equal(dayStatus(E({ studentSignature: sig, staffSignature: staffSig }), false, "2026-11-10", t), "APPROVED");
  assert.equal(dayStatus(E({ studentSignature: sig, correction: { byId: "t", byName: "T", at: new Date(), reason: "x" } }), false, "2026-11-10", t), "NEEDS_CORRECTION");
  assert.equal(dayStatus(E({ status: "ABSENT" }), false, "2026-11-10", t), "ABSENT");
  assert.equal(dayStatus(E({ status: "EXCUSED" }), false, "2026-11-10", t), "EXCUSED");
  assert.equal(dayStatus(E({ studentSignature: sig }), true, "2026-11-10", t), "HOLIDAY");
});

test("what a student can do on a day", () => {
  assert.ok(studentCanSubmit("MISSING") && studentCanSubmit("PENDING") && studentCanSubmit("NEEDS_CORRECTION"));
  assert.ok(!studentCanSubmit("APPROVED") && !studentCanSubmit("ABSENT") && !studentCanSubmit("EXCUSED"));
  assert.ok(studentCanExcuse("ABSENT") && studentCanExcuse("MISSING"));
  assert.ok(!studentCanExcuse("APPROVED") && !studentCanExcuse("PENDING"));
});

test("excuse documents are recognised by their contents, not their name", () => {
  assert.equal(sniffExcuse(Buffer.from("%PDF-1.7\n...")), "application/pdf");
  assert.equal(sniffExcuse(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), "image/png");
  assert.equal(sniffExcuse(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffExcuse(Buffer.from("<html><script>")), null);
  assert.equal(sniffExcuse(Buffer.from("GIF89a")), null);
  assert.equal(safeFileName('doctor"s note.exe', "application/pdf"), "doctors note.pdf");
  assert.equal(safeFileName("", "image/png"), "excuse.png");
});

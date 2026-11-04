import { test } from "node:test";
import assert from "node:assert/strict";
import { homeFor, studentStage } from "../src/lib/routing";
import { TEMPLATES, templatesFor, schemaFor, coerceRaw, documentsFor, attendanceFormatFor, describeEnrollment } from "../src/lib/forms/templates";
import { validateSelection } from "../src/lib/selection";
import { approvalBlockedByPayment, formatUsd, formsBlockedByPayment, parseUsdToCents, submitBlockedByPayment } from "../src/lib/payment";
import { courseServes } from "../src/lib/courses";
import {
  biweeklyDayHours, biweeklyDueDate, biweeklyTotal, contentHash, hoursFromTimes, mondayOf, monthlyEntriesHash, periodDates, periodStartFor, periodsBetween, timesProblem,
} from "../src/lib/timesheet";
import { REPORT_FIELDS, monthParts, reportSchema } from "../src/lib/reports/template";
import { detectFileType } from "../src/lib/file-validation";
import { generateOtp } from "../src/lib/crypto";

test("Non-Private tracks (EQISS, DFS) never receive fee templates, even if misconfigured", () => {
  for (const c of ["EQISS", "DFS"] as const) {
    assert.ok(templatesFor(c).every((t) => !t.containsFees), c);
  }
  // Simulate a misconfiguration: a fee template that claims to apply to everyone.
  TEMPLATES.push({ key: "bad", title: "Bad", version: 1, group: "COMMON", appliesTo: "ALL", containsFees: true, requiresSignature: false, pendingOfficialText: false, fields: [] });
  try {
    assert.ok(!templatesFor("EQISS").some((t) => t.key === "bad"));
    assert.ok(!templatesFor("DFS").some((t) => t.key === "bad"));
    assert.ok(templatesFor("PRIVATE").some((t) => t.key === "bad"));
  } finally {
    TEMPLATES.pop();
  }
});

const COMMON = ["student_data", "educational_background", "background_check", "emergency_medical", "workforce_registration", "grievance_policy", "laptop_receipt", "photo_release"];

test("every track gets the 8 Common Forms once, in the packet order", () => {
  for (const c of ["PRIVATE", "EQISS", "DFS"] as const) {
    const keys = templatesFor(c).map((t) => t.key);
    assert.deepEqual(keys.slice(0, 8), COMMON, c);
    assert.equal(new Set(keys).size, keys.length, `${c}: duplicate templates`);
  }
});

test("Private gets Private Forms; Non-Private gets the Non-Private agreement only", () => {
  assert.deepEqual(templatesFor("PRIVATE").slice(8).map((t) => t.key), ["private_agreement_1", "private_agreement_2", "refund_schedule"]);
  for (const c of ["EQISS", "DFS"] as const) assert.deepEqual(templatesFor(c).slice(8).map((t) => t.key), ["nonprivate_agreement"]);
  assert.ok(templatesFor("PRIVATE").filter((t) => t.group === "PRIVATE").every((t) => t.containsFees));
});

test("resume and photo ID are required for every track; referral upload only for Non-Private", () => {
  for (const c of ["PRIVATE", "EQISS", "DFS"] as const) {
    assert.ok(documentsFor(c).some((d) => d.type === "RESUME" && d.required));
    assert.ok(documentsFor(c).some((d) => d.type === "PHOTO_ID" && d.required));
  }
  assert.ok(!documentsFor("PRIVATE").some((d) => d.type === "REFERRAL"));
  assert.ok(documentsFor("DFS").some((d) => d.type === "REFERRAL"));
});

test("enrollment choice: type, program and county are validated and kept separate", () => {
  assert.equal(validateSelection({}).ok, false);
  const p = validateSelection({ enrollmentType: "PRIVATE", fundingProgram: "EQISS", county: "HUDSON" });
  assert.ok(p.ok && p.category === "PRIVATE" && p.selection.fundingProgram === null && p.selection.county === null);
  const noProg = validateSelection({ enrollmentType: "NON_PRIVATE" });
  assert.ok(!noProg.ok && noProg.field === "fundingProgram");
  const dfs = validateSelection({ enrollmentType: "NON_PRIVATE", fundingProgram: "DFS", county: "BERGEN" });
  assert.ok(dfs.ok && dfs.category === "DFS" && dfs.selection.county === null);
  const noCounty = validateSelection({ enrollmentType: "NON_PRIVATE", fundingProgram: "EQISS" });
  assert.ok(!noCounty.ok && noCounty.field === "county");
  assert.equal(validateSelection({ enrollmentType: "NON_PRIVATE", fundingProgram: "EQISS", county: "ESSEX" }).ok, false);
  for (const county of ["HUDSON", "BERGEN", "SOMERSET"]) {
    const r = validateSelection({ enrollmentType: "NON_PRIVATE", fundingProgram: "EQISS", county });
    assert.ok(r.ok && r.category === "EQISS" && r.selection.county === county);
  }
});

test("all three EQISS counties share one attendance format; DFS and Private use the monthly sheet", () => {
  assert.equal(attendanceFormatFor("EQISS"), "BIWEEKLY");
  assert.equal(attendanceFormatFor("DFS"), "MONTHLY");
  assert.equal(attendanceFormatFor("PRIVATE"), "MONTHLY");
  assert.equal(describeEnrollment({ category: "EQISS", county: "SOMERSET" }), "Non-Private: EQISS / One-Stop, Somerset County");
});

test("payment gate: approval always needs a settled Private payment; Non-Private is never gated", () => {
  const priv = { category: "PRIVATE" as const, paymentStatus: "PENDING" as const };
  assert.equal(approvalBlockedByPayment(priv), true);
  assert.equal(approvalBlockedByPayment({ ...priv, paymentStatus: "PAID" }), false);
  assert.equal(approvalBlockedByPayment({ ...priv, paymentStatus: "WAIVED" }), false);
  assert.equal(formsBlockedByPayment(priv, "BEFORE_FORMS"), true);
  assert.equal(formsBlockedByPayment(priv, "BEFORE_SUBMIT"), false);
  assert.equal(submitBlockedByPayment(priv, "BEFORE_SUBMIT"), true);
  assert.equal(submitBlockedByPayment(priv, "BEFORE_APPROVAL"), false);
  for (const c of ["EQISS", "DFS"] as const) {
    const a = { category: c, paymentStatus: "NOT_REQUIRED" as const };
    assert.equal(approvalBlockedByPayment(a) || formsBlockedByPayment(a, "BEFORE_FORMS") || submitBlockedByPayment(a, "BEFORE_FORMS"), false);
  }
});

test("courses with no funding programs are open to all; otherwise only listed programs", () => {
  assert.equal(courseServes({ fundingPrograms: [] }, "DFS"), true);
  assert.equal(courseServes({ fundingPrograms: ["PRIVATE"] }, "EQISS"), false);
  assert.equal(courseServes({ fundingPrograms: ["EQISS", "DFS"] }, "DFS"), true);
  assert.equal(courseServes({ fundingPrograms: [] }, null), false);
});

test("handwritten times: hours = end - start - lunch; bad combinations refused", () => {
  assert.equal(hoursFromTimes({ startTime: "09:00", lunchOut: "12:00", lunchIn: "12:30", endTime: "15:00" }), 5.5);
  assert.equal(hoursFromTimes({ startTime: "09:00", endTime: "13:15" }), 4.25);
  assert.equal(hoursFromTimes({ startTime: "09:00" }), null);
  assert.ok(timesProblem({ startTime: "9am" }));
  assert.ok(timesProblem({ startTime: "10:00", endTime: "09:00" }));
  assert.ok(timesProblem({ lunchOut: "12:00" }));
  assert.ok(timesProblem({ startTime: "09:00", lunchOut: "12:30", lunchIn: "12:00", endTime: "15:00" }));
  assert.equal(timesProblem({}), null);
  // Extra fields on the object (as the integration API passes whole records) are ignored.
  assert.equal(timesProblem({ startTime: "09:00", endTime: "12:00", enrollmentId: "0b6c…", status: "PRESENT" } as never), null);
});

test("biweekly periods: 14 days Monday to Sunday, anchored on the program start", () => {
  assert.equal(mondayOf("2026-10-14"), "2026-10-12"); // Wednesday -> Monday
  assert.equal(mondayOf("2026-10-18"), "2026-10-12"); // Sunday -> Monday
  const p = periodStartFor("2026-09-02", "2026-10-14"); // program starts Wed 2 Sep -> anchor Mon 31 Aug
  assert.equal(p, "2026-10-12");
  const days = periodDates(p);
  assert.equal(days.length, 14);
  assert.equal(new Date(`${days[0]}T12:00:00Z`).getUTCDay(), 1);
  assert.equal(new Date(`${days[13]}T12:00:00Z`).getUTCDay(), 0);
  assert.equal(periodStartFor("2026-09-02", "2026-09-13"), "2026-08-31");
  assert.equal(periodStartFor("2026-09-02", "2026-09-14"), "2026-09-14");
  assert.deepEqual(periodsBetween("2026-09-02", "2026-09-30"), ["2026-08-31", "2026-09-14", "2026-09-28"]);
});

test("biweekly report is due two business days after the period", () => {
  assert.equal(biweeklyDueDate("2026-10-12"), "2026-10-27"); // ends Sun 25 Oct -> Tue 27 Oct
});

test("biweekly hours: A, H and S days count zero; totals add up", () => {
  assert.equal(biweeklyDayHours({ timeIn: "09:00", timeOut: "13:30", code: "" }), 4.5);
  for (const code of ["A", "H", "S"] as const) assert.equal(biweeklyDayHours({ timeIn: "09:00", timeOut: "13:30", code }), 0);
  assert.equal(biweeklyTotal([{ hours: 4.5 }, { hours: 0 }, { hours: 3.25 }]), 7.75);
});

test("sheet hashes change when entries change and ignore key order", () => {
  assert.equal(contentHash({ a: 1, b: [1, 2] }), contentHash({ b: [1, 2], a: 1 }));
  const rows = [{ date: "2026-10-01", record: { status: "PRESENT" as const, hours: 4, note: "", startTime: "09:00" } }];
  const h = monthlyEntriesHash(rows);
  assert.notEqual(h, monthlyEntriesHash([{ ...rows[0], record: { ...rows[0].record, startTime: "09:15" } }]));
});

test("progress report follows the template: lesson numbers and comments required to submit", () => {
  assert.deepEqual(REPORT_FIELDS.map((f) => f.label), ["Lesson(s) number", "Comments"]);
  assert.equal(reportSchema(false).safeParse({ lessons: "", comments: "" }).success, true);
  assert.equal(reportSchema(true).safeParse({ lessons: "4-6", comments: "" }).success, false);
  assert.equal(reportSchema(true).safeParse({ lessons: "4-6", comments: "Good progress." }).success, true);
  assert.deepEqual(monthParts("2026-10"), { month: "October", year: "2026" });
});

test("student routing follows status", () => {
  assert.equal(studentStage("DRAFT", false), "ENROLL");
  assert.equal(studentStage("CORRECTIONS_REQUESTED", false), "ENROLL");
  assert.equal(studentStage("SUBMITTED", false), "STATUS");
  assert.equal(studentStage("APPROVED", false), "STATUS");
  assert.equal(studentStage("APPROVED", true), "DASHBOARD");
  assert.equal(studentStage("REJECTED", true), "STATUS");
  assert.equal(homeFor({ role: "STUDENT", emailVerified: false }), "/verify");
  assert.equal(homeFor({ role: "INSTRUCTOR", emailVerified: true, instructorStatus: "PENDING" }), "/instructor/pending");
  assert.equal(homeFor({ role: "ADMIN", emailVerified: true }), "/admin");
});

test("form schema enforces required fields and confirmations", () => {
  const grievance = TEMPLATES.find((t) => t.key === "grievance_policy")!;
  const bad = schemaFor(grievance).safeParse(coerceRaw(grievance, {}));
  assert.equal(bad.success, false);
  const good = schemaFor(grievance).safeParse(coerceRaw(grievance, { acknowledged: "on" }));
  assert.equal(good.success, true);
  const personal = TEMPLATES.find((t) => t.key === "student_data")!;
  const r = schemaFor(personal).safeParse({ legalName: "A", dateOfBirth: "not-a-date", phone: "1", street: "x", city: "x", state: "x", zip: "1" });
  assert.equal(r.success, false);
});

test("file types are detected from content", () => {
  assert.equal(detectFileType(Buffer.from("%PDF-1.7 ..."))?.ext, "pdf");
  assert.equal(detectFileType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))?.ext, "png");
  assert.equal(detectFileType(Buffer.from("MZ\x90\x00 windows exe")), null);
  assert.equal(detectFileType(Buffer.from("<html><script>")), null);
});

test("OTP codes are 6 digits", () => {
  for (let i = 0; i < 200; i++) assert.match(generateOtp(), /^\d{6}$/);
});

// ---- Added with the audit fixes ----
import { canonicalEmail } from "../src/lib/email-canonical";
import { todayLocal } from "../src/lib/dates";
import { attendanceChanges, dateProblem, enrolledOn } from "../src/lib/attendance-rules";

test("Gmail aliases collapse to one mailbox; other domains are untouched", () => {
  const base = canonicalEmail("janedoe@gmail.com");
  for (const alias of ["Jane.Doe@gmail.com", "j.a.n.e.d.o.e+lms@gmail.com", "janedoe+2@googlemail.com", " JANEDOE@GMAIL.COM "]) {
    assert.equal(canonicalEmail(alias), base, alias);
  }
  assert.equal(canonicalEmail("jane.doe+x@yahoo.com"), "jane.doe+x@yahoo.com");
});

test("'today' follows the office time zone, not UTC", () => {
  // 01:30 UTC on Oct 14 is still Oct 13 in New Jersey.
  assert.equal(todayLocal(new Date("2026-10-14T01:30:00Z")), "2026-10-13");
});

const klass = { archived: false, startDate: "2020-01-01", endDate: "2099-12-31" } as never;
test("attendance dates: no future dates, nothing outside the class, archived classes refused", () => {
  assert.match(dateProblem(klass, "2099-01-01", "INSTRUCTOR")!, /future/);
  assert.match(dateProblem(klass, "2019-12-31", "ADMIN")!, /outside/);
  assert.match(dateProblem({ ...(klass as object), archived: true } as never, "2020-02-01", "ADMIN")!, /archived/);
  assert.equal(dateProblem(klass, todayLocal(), "INSTRUCTOR"), null);
});

test("attendance edit lock applies to instructors only", () => {
  process.env.ATTENDANCE_EDIT_DAYS = "7";
  try {
    const old = todayLocal(new Date(Date.now() - 30 * 86_400_000));
    assert.match(dateProblem(klass, old, "INSTRUCTOR")!, /locked/);
    assert.equal(dateProblem(klass, old, "ADMIN"), null);
  } finally {
    delete process.env.ATTENDANCE_EDIT_DAYS;
  }
});

test("withdrawn students can only be marked up to the day they left", () => {
  const left = { status: "WITHDRAWN" as const, endedAt: new Date("2026-03-10T15:00:00Z") };
  assert.ok(enrolledOn(left, "2026-03-10"));
  assert.ok(!enrolledOn(left, "2026-03-11"));
  assert.ok(enrolledOn({ status: "ACTIVE", endedAt: null }, "2099-01-01"));
});

test("attendance audit records before and after values, and skips unchanged rows", () => {
  const before = { e1: { status: "ABSENT", hours: 0, note: "", recordedById: "x", updatedAt: new Date() } } as never;
  const changes = attendanceChanges(before, { e1: { status: "PRESENT", hours: 6, note: "" }, e2: { status: "LATE", hours: 3, note: "" } });
  assert.deepEqual(changes.map((c) => [c.enrollmentId, c.from?.status ?? null, c.to.status]), [["e1", "ABSENT", "PRESENT"], ["e2", null, "LATE"]]);
  assert.equal(attendanceChanges(before, { e1: { status: "ABSENT", hours: 0, note: "" } }).length, 0);
});

// ---- Student check-in ----
import { codeFor, codeMatches, isOpen, msLeft, statusAt, sharedDevices, CODE_VALID_MINUTES } from "../src/lib/checkin";
import {
  computeDay, dailyRecordsHash, dayCounts, initialsOf, isPendingFill, localHHMM, minutesOf, scheduleProblem,
} from "../src/lib/attendance-math";

const SECRET = "x".repeat(40);
const sess = { _id: "s1", seed: "seed-1" };

test("a check-in code is 6 digits and stays the same for its whole 10 minutes", () => {
  const code = codeFor(SECRET, sess);
  assert.match(code, /^\d{6}$/);
  assert.equal(codeFor(SECRET, sess), code); // no rotation
  assert.ok(codeMatches(SECRET, sess, code));
  assert.ok(!codeMatches(SECRET, sess, "12345"));
  assert.ok(!codeMatches(SECRET, sess, "abcdef"));
  assert.equal(CODE_VALID_MINUTES, 10);
});

test("a new code (new seed) makes the old code useless; codes differ per session and secret", () => {
  const old = codeFor(SECRET, sess);
  assert.notEqual(codeFor(SECRET, { ...sess, seed: "seed-2" }), old);
  assert.notEqual(codeFor(SECRET, { ...sess, _id: "s2" }), old);
  assert.notEqual(codeFor("y".repeat(40), sess), old);
});

test("the code works until exactly 10 minutes after it was issued", () => {
  const issued = new Date("2026-10-13T13:00:00Z");
  const s = { closedAt: null, expiresAt: new Date(issued.getTime() + CODE_VALID_MINUTES * 60_000) };
  assert.ok(isOpen(s, new Date("2026-10-13T13:09:59.999Z")));
  assert.ok(!isOpen(s, new Date("2026-10-13T13:10:00Z")));
  assert.equal(msLeft(s, new Date("2026-10-13T13:09:00Z")), 60_000);
  assert.equal(msLeft(s, new Date("2026-10-13T13:11:00Z")), 0);
  assert.ok(!isOpen({ ...s, closedAt: issued }, new Date("2026-10-13T13:01:00Z")));
});

test("on time within the first code's 10 minutes, late after", () => {
  const s = { openedAt: new Date("2026-10-13T13:00:00Z"), lateAfterMinutes: CODE_VALID_MINUTES };
  assert.equal(statusAt(s, new Date("2026-10-13T13:10:00Z")), "PRESENT");
  assert.equal(statusAt(s, new Date("2026-10-13T13:10:01Z")), "LATE");
});

test("two students on one phone are both flagged", () => {
  const flags = sharedDevices({ a: { deviceId: "d1" }, b: { deviceId: "d1" }, c: { deviceId: "d2" } });
  assert.deepEqual(flags.get("a"), ["b"]);
  assert.deepEqual(flags.get("b"), ["a"]);
  assert.equal(flags.has("c"), false);
});

// ---- Precise hours ----

test("time in rounds up and time out rounds down to the minute, in the office time zone", () => {
  const tz = "America/New_York";
  assert.equal(localHHMM(new Date("2026-10-13T13:04:00.000Z"), tz, "ceil"), "09:04");
  assert.equal(localHHMM(new Date("2026-10-13T13:04:00.001Z"), tz, "ceil"), "09:05");
  assert.equal(localHHMM(new Date("2026-10-13T13:04:59Z"), tz, "floor"), "09:04");
  assert.equal(localHHMM(new Date("2026-01-13T14:04:30Z"), tz, "floor"), "09:04"); // winter time (UTC-5)
  assert.equal(localHHMM(new Date("2026-10-13T03:59:30Z"), tz, "ceil"), "23:59"); // never rolls into the next day
});

test("hours are counted only inside class time, with the break deducted", () => {
  const s = { sessionStart: "09:00", sessionEnd: "13:00", breakStart: "11:00", breakEnd: "11:30" };
  const full = computeDay("08:52", "13:07", s);
  assert.ok(full.ok);
  if (full.ok) {
    assert.deepEqual([full.startTime, full.lunchOut, full.lunchIn, full.endTime, full.minutes, full.hours], ["09:00", "11:00", "11:30", "13:00", 210, 3.5]);
  }
  const late = computeDay("09:04", "12:59", s);
  assert.ok(late.ok && late.minutes === 205 && late.hours === 3.42);
  const leftAtBreak = computeDay("09:00", "11:15", s);
  assert.ok(leftAtBreak.ok && leftAtBreak.endTime === "11:00" && leftAtBreak.lunchOut === "" && leftAtBreak.minutes === 120);
  const cameAtBreak = computeDay("11:10", "13:00", s);
  assert.ok(cameAtBreak.ok && cameAtBreak.startTime === "11:30" && cameAtBreak.minutes === 90);
  assert.equal(computeDay("13:05", "13:30", s).ok, false); // nothing inside class time
  assert.equal(computeDay("09:10", "09:10", {}).ok, false);
});

test("without a schedule, the real time in and out are counted", () => {
  const r = computeDay("09:04", "12:31", {});
  assert.ok(r.ok && r.minutes === 207 && r.hours === 3.45 && r.lunchOut === "");
});

test("computed days always agree with the sheet's own hours rule", () => {
  const s = { sessionStart: "08:30", sessionEnd: "15:15", breakStart: "12:00", breakEnd: "12:45" };
  for (let a = 8 * 60; a < 16 * 60; a += 7) {
    for (let b = a + 1; b < 17 * 60; b += 11) {
      const f = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
      const r = computeDay(f(a), f(b), s);
      if (!r.ok) continue;
      assert.equal(timesProblem(r), null);
      assert.equal(hoursFromTimes(r), r.hours);
      assert.ok(r.minutes <= b - a);
    }
  }
});

test("class schedules are validated", () => {
  assert.equal(scheduleProblem({}), null);
  assert.equal(scheduleProblem({ sessionStart: "09:00", sessionEnd: "13:00", breakStart: "11:00", breakEnd: "11:30" }), null);
  assert.match(scheduleProblem({ sessionStart: "09:00" })!, /both/);
  assert.match(scheduleProblem({ sessionStart: "13:00", sessionEnd: "09:00" })!, /after/);
  assert.match(scheduleProblem({ sessionStart: "09:00", sessionEnd: "13:00", breakStart: "08:00", breakEnd: "08:30" })!, /inside/);
  assert.match(scheduleProblem({ sessionStart: "9:00", sessionEnd: "13:00" })!, /HH:MM/);
});

test("day totals add exact minutes (no rounding drift) and ignore stale minutes", () => {
  const rec = (status: string, hours: number, minutes?: number) => ({ status, hours, minutes, note: "", recordedById: "x", updatedAt: new Date() }) as never;
  // Three 20-minute days: 1.00 h exactly, not 0.33 x 3 = 0.99.
  const records = { a: rec("PRESENT", 0.33, 20), b: rec("LATE", 0.33, 20), c: rec("PRESENT", 0.33, 20), d: rec("ABSENT", 0, 0) };
  const c = dayCounts(records, ["a", "b", "c", "d", "e"]);
  assert.deepEqual([c.enrolled, c.present, c.late, c.absent, c.minutes], [5, 2, 1, 1, 60]);
  // Hours edited later by a screen that doesn't set minutes: hours win.
  assert.equal(minutesOf(rec("PRESENT", 4, 20)), 240);
  assert.equal(minutesOf(rec("ABSENT", 4, 240)), 0);
});

test("the daily signature hash changes when any mark changes or a student is missing", () => {
  const rec = (status: string, hours: number) => ({ status, hours, note: "", recordedById: "x", updatedAt: new Date() }) as never;
  const h1 = dailyRecordsHash({ a: rec("PRESENT", 4), b: rec("ABSENT", 0) }, ["a", "b"]);
  assert.equal(h1, dailyRecordsHash({ b: rec("ABSENT", 0), a: rec("PRESENT", 4) }, ["b", "a"]));
  assert.notEqual(h1, dailyRecordsHash({ a: rec("PRESENT", 3.5), b: rec("ABSENT", 0) }, ["a", "b"]));
  assert.notEqual(h1, dailyRecordsHash({ a: rec("PRESENT", 4) }, ["a", "b"]));
});

test("a checked-in day is pending until it has a time out", () => {
  assert.ok(isPendingFill({ source: "CHECKIN", status: "PRESENT", startTime: "09:00" }));
  assert.ok(!isPendingFill({ source: "CHECKIN", status: "PRESENT", startTime: "09:00", endTime: "13:00" }));
  assert.ok(!isPendingFill({ source: "INSTRUCTOR", status: "PRESENT" }));
  assert.ok(!isPendingFill(null));
});

test("initials for the EQISS report", () => {
  assert.equal(initialsOf("Maria del Carmen Lopez"), "ML");
  assert.equal(initialsOf("  ana  "), "A");
});

test("rate limit counts the overlap with the previous window", () => {
  // Same weighting as lib/rate-limit.ts: 6 attempts just before a boundary + 5 just after must exceed a limit of 10.
  const estimate = (curr: number, prev: number, elapsed: number) => curr + prev * (1 - elapsed);
  assert.ok(estimate(5, 6, 0.01) > 10);
  assert.ok(estimate(5, 6, 0.99) <= 10); // the old attempts have aged out
});

// ---- Online tuition payment ----

test("Private students fill in and submit before paying; approval still needs a settled payment", () => {
  const priv = { category: "PRIVATE" as const, paymentStatus: "PENDING" as const };
  assert.equal(formsBlockedByPayment(priv), false);
  assert.equal(submitBlockedByPayment(priv), false);
  assert.equal(approvalBlockedByPayment(priv), true);
  assert.equal(approvalBlockedByPayment({ ...priv, paymentStatus: "REQUESTED" }), true);
  assert.equal(approvalBlockedByPayment({ ...priv, paymentStatus: "PAID" }), false);
});

test("dollar amounts are parsed exactly into cents", () => {
  assert.equal(parseUsdToCents("1500"), 150000);
  assert.equal(parseUsdToCents("1,500.00"), 150000);
  assert.equal(parseUsdToCents("$1500.5"), 150050);
  assert.equal(parseUsdToCents(" 0.50 "), 50);
  assert.equal(parseUsdToCents("19.99"), 1999);
  assert.equal(parseUsdToCents("0.29"), 29 >= 50 ? 29 : null); // below Stripe's minimum
  assert.equal(parseUsdToCents("50000"), 5_000_000);
  for (const bad of ["", "abc", "-5", "1.234", "1e3", "50000.01", "1 500", "0", "$"]) assert.equal(parseUsdToCents(bad), null, bad);
});

test("amounts are shown as US dollars", () => {
  assert.equal(formatUsd(150050), "$1,500.50");
  assert.equal(formatUsd(50), "$0.50");
});

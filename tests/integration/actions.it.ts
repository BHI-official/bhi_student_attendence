/**
 * Integration tests: the real server actions against a real MongoDB.
 *   MONGODB_URI=mongodb://127.0.0.1:27017/bhi_it npm run test:integration
 * The database named in MONGODB_URI is wiped first, so never point this at real data.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import bcrypt from "bcryptjs";

process.env.SESSION_SECRET ??= "integration-test-secret-integration-test-secret";
process.env.APP_TIMEZONE ??= "America/New_York";
process.env.MIN_CLASS_MINUTES = "1";
const URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/bhi_it";
process.env.MONGODB_URI = URI;
if (!/\/bhi_(it|e2e)\b/.test(URI)) throw new Error("Refusing to run: MONGODB_URI must name a bhi_it or bhi_e2e test database.");

/* eslint-disable @typescript-eslint/no-explicit-any */
let A: any; // admin actions
let S: any; // staff actions
let ST: any; // student actions
let auth: any;
let sheet: any;
let report: any;
let summary: any;
let db: ReturnType<MongoClient["db"]>;
let client: MongoClient;

const jar = () => (globalThis as any).__jar as Map<string, string>;
const fd = (o: Record<string, string | string[]>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) (Array.isArray(v) ? v : [v]).forEach((x) => f.append(k, x));
  return f;
};

/** A real PNG (solid blue strip), so the server's PNG checks pass. */
function realPng(w: number, h: number) {
  const zlib = require("node:zlib") as typeof import("node:zlib");
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([28, 63, 170, 255], y * (w * 4 + 1) + 1 + x * 4);
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString("base64")}`;
}
const SIG = realPng(200, 60);
let week: any;
let roster: any;

let today = "", lastMon = "", lastTue = "", lastWed = "", lastThu = "", lastFri = "", oldDay = "";
const ids = { admin: randomUUID(), saniya: randomUUID(), omar: randomUUID() };

async function asStaff(id: string) {
  jar().clear();
  const s = await db.collection("staff").findOne({ _id: id as any });
  await auth.startStaffSession(s);
}
async function asStudent(id: unknown) {
  jar().clear();
  await auth.startStudentSession(String(id));
}
async function redirected(p: Promise<unknown>) {
  try { await p; } catch (e: any) { if (e?.to) return e.to as string; throw e; }
  return null;
}
const entry = (studentId: string, date: string) => db.collection("entries").findOne({ _id: `${studentId}:${date}` as any });
const day = (o: Record<string, string> = {}) => fd({ startInk: SIG, lunchStartInk: SIG, lunchEndInk: SIG, endInk: SIG, signature: SIG, ...o });
const PDF = new File([Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF")], "doctor note.pdf", { type: "application/pdf" });

before(async () => {
  client = await MongoClient.connect(URI);
  db = client.db();
  await db.dropDatabase();
  await db.collection("staff").createIndex({ email: 1 }, { unique: true });
  await db.collection("students").createIndex({ pinKey: 1 }, { unique: true, name: "unique_active_pin", partialFilterExpression: { active: true, pinKey: { $type: "string" } } });
  await db.collection("rate_limits").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

  A = await import("../../src/actions/admin");
  S = await import("../../src/actions/staff");
  ST = await import("../../src/actions/student");
  auth = await import("../../src/lib/auth");
  sheet = await import("../../src/lib/sheet");
  week = await import("../../src/lib/week");
  report = await import("../../src/lib/report");
  summary = await import("../../src/lib/summary");
  roster = await import("../../src/lib/roster");

  today = sheet.todayIn("America/New_York");
  lastMon = sheet.addDays(week.mondayOf(today), -7);
  [lastTue, lastWed, lastThu, lastFri] = [1, 2, 3, 4].map((i) => sheet.addDays(lastMon, i));
  oldDay = sheet.addDays(lastMon, -3); // Friday two weeks ago: locked for students and teachers
  const hash = await bcrypt.hash("password-123456", 4);
  const now = new Date();
  await db.collection("staff").insertMany([
    { _id: ids.admin, name: "Ada Admin", email: "admin@x.test", position: "Director", role: "ADMIN", passwordHash: hash, active: true, createdAt: now },
    { _id: ids.saniya, name: "Dr. Saniya", email: "saniya@x.test", position: "Instructor", role: "TEACHER", passwordHash: hash, active: true, createdAt: now },
    { _id: ids.omar, name: "Omar Teacher", email: "omar@x.test", position: "Instructor", role: "TEACHER", passwordHash: hash, active: true, createdAt: now },
  ] as any[]);
});
after(async () => {
  await client?.close();
  const appClient = await (globalThis as any).mongo?.catch(() => null);
  await appClient?.close();
});

const studentForm = (name: string, teacherId = "", pin = "") => fd({
  name, courseName: "Clinical Medical Assistant", courseCode: "CMA", courseDuration: "6 months", caseManager: "S. Nandi", instructor: "Dr. Saniya",
  startDate: sheet.addDays(today, -60), endDate: sheet.addDays(today, 60), classDays: ["1", "2", "3", "4", "5"], pin, teacherId,
});
const byName = (name: string) => db.collection("students").findOne({ name }) as Promise<any>;

// ---------------------------------------------------------------- setup

test("admins add students straight onto a teacher's roster; PINs stay unique", async () => {
  await asStaff(ids.admin);
  let r = await A.saveStudentAction(null, {}, studentForm("Jennifer Quezada", ids.saniya, "2468"));
  assert.ok(r.ok, JSON.stringify(r));
  r = await A.saveStudentAction(null, {}, studentForm("Alexandra Mendez", ids.saniya, "2468"));
  assert.match(r.fieldErrors?.pin ?? "", /Another student already has this PIN/);
  r = await A.saveStudentAction(null, {}, studentForm("Alexandra Mendez", ids.saniya, "3579"));
  assert.ok(r.ok);
  r = await A.saveStudentAction(null, {}, studentForm("Maria Lopez", "", "8023"));
  assert.ok(r.ok);
  r = await A.saveStudentAction(null, {}, studentForm("Nobody Teacher", "not-a-teacher"));
  assert.ok(r.fieldErrors?.teacherId);
  const jen = await byName("Jennifer Quezada");
  assert.equal(jen.teacherId, ids.saniya);
  assert.equal((await byName("Maria Lopez")).teacherId, null);
  assert.equal(await db.collection("teacher_assignments").countDocuments({ studentId: jen._id, to: null }), 1);

  // Teachers see only their own students.
  const saniya = await db.collection("staff").findOne({ _id: ids.saniya as any });
  const { rows } = await roster.loadRoster(saniya, { from: lastMon, to: lastFri });
  assert.deepEqual([...new Set(rows.map((x: any) => x.name))].sort(), ["Alexandra Mendez", "Jennifer Quezada"]);
  assert.equal(rows.length, 10); // 2 students x Monday..Friday
  assert.ok(rows.every((x: any) => x.status === "MISSING"));
});

test("student signs in with name + PIN", async () => {
  jar().clear();
  const jen = await byName("Jennifer Quezada");
  assert.equal((await ST.pinSignInAction(jen._id, {}, fd({ pin: "1111" }))).error, "That PIN isn't right. Try again.");
  assert.equal(await redirected(ST.pinSignInAction(jen._id, {}, fd({ pin: "2468" }))), "/student/sheet");
});

// ---------------------------------------------------------------- student submits

test("student fills in a past day: start, lunch start, lunch end, end and signature all by hand, sent to the teacher as Pending", async () => {
  const jen = await byName("Jennifer Quezada");
  await asStudent(jen._id);
  // Start, end and the signature are required; lunch is both-or-neither.
  assert.ok((await ST.submitDayAction(lastMon, {}, day({ startInk: "" }))).fieldErrors?.startInk);
  assert.ok((await ST.submitDayAction(lastMon, {}, day({ endInk: "" }))).fieldErrors?.endInk);
  assert.ok((await ST.submitDayAction(lastMon, {}, day({ signature: "" }))).fieldErrors?.signature);
  assert.match((await ST.submitDayAction(lastMon, {}, day({ lunchEndInk: "" }))).fieldErrors?.lunchEndInk ?? "", /both lunch times/);
  assert.equal(await entry(jen._id, lastMon), null, "nothing is saved when something is missing");

  const r = await ST.submitDayAction(lastMon, {}, day({ note: "Forgot on the day" }));
  assert.ok(r.ok, JSON.stringify(r));
  assert.match(r.message, /Sent to Dr\. Saniya to check and sign/);
  const e: any = await entry(jen._id, lastMon);
  assert.equal(e.status, "PRESENT");
  assert.equal(e.minutes, null, "no hours are calculated");
  assert.ok(e.startInkId && e.lunchStartInkId && e.lunchEndInkId && e.endInkId && e.studentSignature?.id);
  const ink: any = await db.collection("signatures").findOne({ _id: e.lunchStartInkId });
  assert.equal(ink.kind, "TIME");
  assert.ok(e.filledLaterAt, "a past day is flagged as submitted late");
  assert.equal(week.dayStatus(e, false, lastMon, today), "PENDING");
  assert.equal(e.comments[0].text, "Forgot on the day");

  // A second day (no lunch break) gets its own new signature image: nothing is reused.
  assert.ok((await ST.submitDayAction(lastTue, {}, day({ lunchStartInk: "", lunchEndInk: "" }))).ok);
  const e2: any = await entry(jen._id, lastTue);
  assert.equal(e2.lunchStartInkId, null);
  assert.notEqual(e2.studentSignature.id, e.studentSignature.id);
  const sigs = await db.collection("signatures").countDocuments({ ownerId: jen._id, kind: "SIGNATURE" });
  assert.equal(sigs, 2);
});

test("students can't sign future days, weekends, or anything before last week", async () => {
  const jen = await byName("Jennifer Quezada");
  await asStudent(jen._id);
  assert.match((await ST.submitDayAction(sheet.addDays(today, 1), {}, day())).error, /hasn't happened yet|Monday to Friday/);
  assert.match((await ST.submitDayAction(sheet.addDays(lastMon, -1), {}, day())).error, /Monday to Friday/);
  assert.match((await ST.submitDayAction(oldDay, {}, day())).error, /locked/);
  assert.equal(await entry(jen._id, oldDay), null);
});

test("one record per day: submitting again updates the same day and keeps the earlier one in its history", async () => {
  const jen = await byName("Jennifer Quezada");
  await asStudent(jen._id);
  const before: any = await entry(jen._id, lastTue);
  assert.ok((await ST.submitDayAction(lastTue, {}, day())).ok);
  assert.equal(await db.collection("entries").countDocuments({ studentId: jen._id, date: lastTue }), 1);
  const after: any = await entry(jen._id, lastTue);
  assert.notEqual(after.endInkId, before.endInkId);
  assert.notEqual(after.studentSignature.id, before.studentSignature.id);
  assert.match(after.history.at(-1).what, /submitted again/);
  assert.match(after.history.at(-1).what, new RegExp(before.studentSignature.id));
});

// ---------------------------------------------------------------- teacher

test("teacher approves several days at once with one handwritten signature; approved days lock for the student", async () => {
  const jen = await byName("Jennifer Quezada");
  const alex = await byName("Alexandra Mendez");
  await asStudent(alex._id);
  assert.ok((await ST.submitDayAction(lastMon, {}, day())).ok);

  await asStaff(ids.saniya);
  const keys = [`${jen._id}:${lastMon}`, `${alex._id}:${lastMon}`, `${jen._id}:${lastWed}` /* nothing submitted */];
  assert.ok((await S.approveRowsAction({}, fd({ rows: JSON.stringify(keys) }))).error, "a signature is required");
  const r = await S.approveRowsAction({}, fd({ rows: JSON.stringify(keys), signature: SIG }));
  assert.ok(r.ok, JSON.stringify(r));
  assert.match(r.message, /Approved and signed 2 days/);
  assert.match(r.message, /no signed submission/);
  const a: any = await entry(jen._id, lastMon), b: any = await entry(alex._id, lastMon);
  assert.equal(a.staffSignature.staffName, "Dr. Saniya");
  assert.equal(a.staffSignature.id, b.staffSignature.id, "one signature, stored on each approved day");

  await asStudent(jen._id);
  assert.match((await ST.submitDayAction(lastMon, {}, day())).error, /already approved by Dr\. Saniya/);
});

test("only the student's own teacher signs the teacher column: never an admin", async () => {
  const alex = await byName("Alexandra Mendez");
  await asStudent(alex._id);
  assert.ok((await ST.submitDayAction(lastTue, {}, day())).ok);
  await asStaff(ids.admin);
  assert.match((await S.approveRowsAction({}, fd({ rows: JSON.stringify([`${alex._id}:${lastTue}`]), signature: SIG }))).error, /Only the student's teacher/);
  assert.equal(((await entry(alex._id, lastTue)) as any).staffSignature, null);
});

test("teachers can't act on other teachers' students", async () => {
  const jen = await byName("Jennifer Quezada");
  await asStaff(ids.omar);
  const r = await S.approveRowsAction({}, fd({ rows: JSON.stringify([`${jen._id}:${lastTue}`]), signature: SIG }));
  assert.match(r.error, /not one of your students/);
  assert.match((await S.markRowsAction({}, fd({ rows: JSON.stringify([`${jen._id}:${lastWed}`]), mark: "ABSENT" }))).error, /not one of your students/);
});

test("send back: Needs correction with the reason; the student fixes and signs again", async () => {
  const jen = await byName("Jennifer Quezada");
  await asStaff(ids.saniya);
  const key = `${jen._id}:${lastTue}`;
  assert.ok((await S.rejectRowAction(key, {}, fd({ reason: "" }))).error);
  assert.ok((await S.rejectRowAction(key, {}, fd({ reason: "End time should be 2:00 pm" }))).ok);
  let e: any = await entry(jen._id, lastTue);
  assert.equal(week.dayStatus(e, false, lastTue, today), "NEEDS_CORRECTION");
  assert.equal(e.correction.reason, "End time should be 2:00 pm");

  await asStudent(jen._id);
  assert.ok((await ST.submitDayAction(lastTue, {}, day())).ok);
  e = await entry(jen._id, lastTue);
  assert.equal(week.dayStatus(e, false, lastTue, today), "PENDING");
  assert.equal(e.correction, null);
});

test("marking present is not approving: the signature stays missing until the student signs", async () => {
  const jen = await byName("Jennifer Quezada");
  await asStaff(ids.saniya);
  const key = `${jen._id}:${lastWed}`;
  assert.ok((await S.markRowsAction({}, fd({ rows: JSON.stringify([key]), mark: "PRESENT" }))).ok);
  let e: any = await entry(jen._id, lastWed);
  assert.equal(e.status, "PRESENT");
  assert.equal(e.markedBy.staffName, "Dr. Saniya");
  assert.equal(week.dayStatus(e, false, lastWed, today), "MISSING");
  // It can't be approved without the student's signature.
  assert.match((await S.approveRowsAction({}, fd({ rows: JSON.stringify([key]), signature: SIG }))).error, /no signed submission/);
  // The student signs it; the teacher's mark stays on record.
  await asStudent(jen._id);
  assert.ok((await ST.submitDayAction(lastWed, {}, day())).ok);
  e = await entry(jen._id, lastWed);
  assert.equal(week.dayStatus(e, false, lastWed, today), "PENDING");
  assert.equal(e.markedBy.mark, "PRESENT");
  // Teachers can't take attendance on locked days.
  await asStaff(ids.saniya);
  assert.match((await S.markRowsAction({}, fd({ rows: JSON.stringify([`${jen._id}:${oldDay}`]), mark: "ABSENT" }))).error, /locked/);
});

// ---------------------------------------------------------------- excuses

test("excuse: student uploads for an absence, teacher approves, the day becomes Excused and stops counting", async () => {
  const jen = await byName("Jennifer Quezada");
  await asStaff(ids.saniya);
  const key = `${jen._id}:${lastThu}`;
  assert.ok((await S.markRowsAction({}, fd({ rows: JSON.stringify([key]), mark: "ABSENT" }))).ok);

  await asStudent(jen._id);
  assert.match((await ST.submitDayAction(lastThu, {}, day())).error, /marked you absent/);
  const fake = new File([Buffer.from("<script>alert(1)</script>")], "note.pdf", { type: "application/pdf" });
  const bad = new FormData(); bad.set("file", fake);
  assert.match((await ST.uploadExcuseAction(lastThu, {}, bad)).error, /PDF, JPG or PNG/);
  const f = new FormData(); f.set("file", PDF); f.set("note", "I was sick");
  const r = await ST.uploadExcuseAction(lastThu, {}, f);
  assert.ok(r.ok, JSON.stringify(r));
  let e: any = await entry(jen._id, lastThu);
  assert.equal(e.status, "ABSENT", "an upload alone doesn't excuse the day");
  assert.equal(e.excuse.status, "PENDING");
  const file: any = await db.collection("excuse_files").findOne({ _id: e.excuse.fileId });
  assert.equal(file.mime, "application/pdf");
  assert.equal(file.name, "doctor note.pdf");

  // Excused days don't count against the student.
  const s1 = await summary.summaryFor(jen);
  await asStaff(ids.saniya);
  assert.match((await S.decideExcuseAction(key, {}, fd({ decision: "REJECTED", reason: "" }))).error, /why/);
  assert.ok((await S.decideExcuseAction(key, {}, fd({ decision: "APPROVED" }))).ok);
  e = await entry(jen._id, lastThu);
  assert.equal(e.status, "EXCUSED");
  assert.equal(e.excuse.decidedBy.name, "Dr. Saniya");
  const s2 = await summary.summaryFor(jen);
  assert.equal(s2.excused, s1.excused + 1);
  assert.equal(s2.absent, s1.absent - 1);
  // The teacher can't change a decided excuse; an admin can.
  assert.match((await S.decideExcuseAction(key, {}, fd({ decision: "REJECTED", reason: "Not a medical note" }))).error, /Ask an admin/);
  await asStaff(ids.admin);
  assert.ok((await S.decideExcuseAction(key, {}, fd({ decision: "REJECTED", reason: "Not a medical note" }))).ok);
  assert.equal(((await entry(jen._id, lastThu)) as any).status, "ABSENT");
  assert.ok((await S.decideExcuseAction(key, {}, fd({ decision: "APPROVED" }))).ok);
});

test("a student can report an absence they weren't marked for, with a document", async () => {
  const alex = await byName("Alexandra Mendez");
  await asStudent(alex._id);
  const f = new FormData(); f.set("file", PDF);
  assert.ok((await ST.uploadExcuseAction(lastFri, {}, f)).ok);
  const e: any = await entry(alex._id, lastFri);
  assert.equal(e.status, "ABSENT");
  assert.equal(e.excuse.status, "PENDING");
  assert.match((await ST.uploadExcuseAction(oldDay, {}, f)).error, /locked/);
});

// ---------------------------------------------------------------- reassignment

test("reassigning a teacher changes only who manages the student; records and approvals stay, pending moves", async () => {
  const jen = await byName("Jennifer Quezada");
  const snapshot = await db.collection("entries").find({ studentId: jen._id }).sort({ _id: 1 }).toArray();
  await asStaff(ids.saniya);
  assert.match((await A.assignTeacherAction(jen._id, {}, fd({ teacherId: ids.omar })).catch((e: any) => ({ error: String(e) }))).error ?? "", /REDIRECT|admin/i);

  await asStaff(ids.admin);
  const r = await A.assignTeacherAction(jen._id, {}, fd({ teacherId: ids.omar }));
  assert.ok(r.ok, JSON.stringify(r));
  assert.match(r.message, /Omar Teacher's roster/);
  assert.match(r.message, /pending day/);
  const after = await db.collection("entries").find({ studentId: jen._id }).sort({ _id: 1 }).toArray();
  assert.deepEqual(after, snapshot, "attendance records are untouched");
  assert.equal(((await entry(jen._id, lastMon)) as any).staffSignature.staffName, "Dr. Saniya", "the original approver is kept");

  const saniya = await db.collection("staff").findOne({ _id: ids.saniya as any });
  const omar = await db.collection("staff").findOne({ _id: ids.omar as any });
  const oldRoster = (await roster.loadRoster(saniya, { from: lastMon, to: lastFri })).rows;
  const newRoster = (await roster.loadRoster(omar, { from: lastMon, to: lastFri })).rows;
  assert.ok(!oldRoster.some((x: any) => x.name === "Jennifer Quezada"));
  assert.ok(newRoster.some((x: any) => x.name === "Jennifer Quezada" && x.status === "PENDING"));
  assert.ok(newRoster.some((x: any) => x.name === "Jennifer Quezada" && x.status === "APPROVED" && x.approvedBy === "Dr. Saniya"));

  // The new teacher approves the pending days; the old one can't any more.
  await asStaff(ids.saniya);
  assert.match((await S.approveRowsAction({}, fd({ rows: JSON.stringify([`${jen._id}:${lastTue}`]), signature: SIG }))).error, /not one of your students/);
  await asStaff(ids.omar);
  assert.ok((await S.approveRowsAction({}, fd({ rows: JSON.stringify([`${jen._id}:${lastTue}`]), signature: SIG }))).ok);

  // The assignment history: Saniya's period is closed, Omar's is open.
  const periods = await db.collection("teacher_assignments").find({ studentId: jen._id }).sort({ from: 1 }).toArray();
  assert.deepEqual(periods.map((p) => [p.teacherName, p.to === null]), [["Dr. Saniya", false], ["Omar Teacher", true]]);
});

test("bulk assignment puts unassigned students on a roster", async () => {
  const maria = await byName("Maria Lopez");
  await asStaff(ids.admin);
  const f = new FormData(); f.append("ids", maria._id); f.set("teacherId", ids.saniya);
  const r = await A.bulkAssignTeacherAction({}, f);
  // (Only admins can be chosen to sign "Approved by".)
  assert.match((await A.setStaffSignsOffAction(ids.saniya, {}, fd({ signsOff: "1" }))).error, /Only an admin account/);
  assert.match(r.message, /1 student moved to Dr\. Saniya's roster/);
  assert.equal((await byName("Maria Lopez")).teacherId, ids.saniya);
});

// ---------------------------------------------------------------- admin

test("admin corrects any day, including old ones; the original is kept and the student's signature is never faked", async () => {
  const alex = await byName("Alexandra Mendez");
  await asStaff(ids.saniya);
  assert.match((await S.adminEditRowAction(alex._id, oldDay, {}, fd({ status: "PRESENT" }))).error, /Only an admin/);

  await asStaff(ids.admin);
  // Add a missing old day.
  let r = await S.adminEditRowAction(alex._id, oldDay, {}, fd({ status: "PRESENT", startTime: "09:00", endTime: "13:00", reason: "" }));
  assert.ok(r.ok, JSON.stringify(r));
  assert.match(r.message, /signature stays missing/);
  let e: any = await entry(alex._id, oldDay);
  assert.equal(e.startTime, "09:00");
  assert.equal(e.minutes, null);
  assert.equal(e.studentSignature, null);
  assert.equal(week.dayStatus(e, false, oldDay, today), "MISSING");

  // Correct an approved day: a reason is required, the approval comes off, the original is recorded.
  const key = `${alex._id}:${lastMon}`;
  const before: any = await entry(alex._id, lastMon);
  assert.ok((await S.adminEditRowAction(alex._id, lastMon, {}, fd({ status: "PRESENT", startTime: "09:00", endTime: "12:00" }))).fieldErrors?.reason);
  r = await S.adminEditRowAction(alex._id, lastMon, {}, fd({ status: "PRESENT", startTime: "09:00", endTime: "12:00", reason: "Left early, confirmed by teacher" }));
  assert.ok(r.ok);
  e = await entry(alex._id, lastMon);
  assert.equal(e.endTime, "12:00");
  assert.equal(e.endInkId, null, "the corrected time replaces the handwritten one on the sheet");
  assert.equal(e.staffSignature, null);
  assert.equal(e.studentSignature.id, before.studentSignature.id, "the student's own signature is kept, untouched");
  assert.match(e.history.at(-1).what, /^admin: .*approval by Dr\. Saniya removed/);
  assert.equal(e.history.at(-1).byName, "Ada Admin");
  const log: any = await db.collection("audit_logs").findOne({ action: "admin.edit_day", target: key });
  assert.equal(log.meta.before.endInkId, before.endInkId, "the student's original handwriting is kept in the audit log");
  assert.equal(log.meta.before.staffSignature.staffName, "Dr. Saniya");
  assert.equal(log.meta.reason, "Left early, confirmed by teacher");

  // An excused absence for an old date, with a document.
  const f = fd({ status: "EXCUSED", reason: "Doctor's note handed in" }); f.set("file", PDF);
  assert.ok((await S.adminEditRowAction(alex._id, sheet.addDays(oldDay, -1), {}, f)).ok);
  e = await entry(alex._id, sheet.addDays(oldDay, -1));
  assert.equal(e.status, "EXCUSED");
  assert.equal(e.excuse.status, "APPROVED");
});

test("admin can also reopen an approved day for the student", async () => {
  const jen = await byName("Jennifer Quezada");
  await asStaff(ids.omar);
  assert.match((await S.rejectRowAction(`${jen._id}:${lastTue}`, {}, fd({ reason: "Wrong times" }))).error, /Already approved/);
  await asStaff(ids.admin);
  assert.ok((await S.rejectRowAction(`${jen._id}:${lastTue}`, {}, fd({ reason: "Wrong times" }))).ok);
  const e: any = await entry(jen._id, lastTue);
  assert.equal(week.dayStatus(e, false, lastTue, today), "NEEDS_CORRECTION");
  assert.match(e.history.at(-1).what, /approval by Omar Teacher removed/);
});

test("Mahek signs off a finished month by hand; teacher days must be checked first; the month then locks", async () => {
  const MAHEK = "11111111-1111-4111-8111-111111111111";
  await db.collection("staff").insertOne({ _id: MAHEK, name: "Mahek", email: "mahek@x.test", position: "Asst. Director", role: "ADMIN", signsOff: true, passwordHash: "x", active: true, createdAt: new Date() } as any);
  const jen = await byName("Jennifer Quezada"), alex = await byName("Alexandra Mendez");
  const month = sheet.shiftMonth(today.slice(0, 7), -1);
  const day1 = sheet.monthDates(month).find((x: string) => week.isWeekday(x))!;
  const day2 = sheet.monthDates(month).filter((x: string) => week.isWeekday(x))[1];
  // Last month: Jennifer has a day still waiting for her teacher; Alexandra has an excused day recorded.
  await db.collection("entries").insertOne({ _id: `${jen._id}:${day1}`, studentId: jen._id, date: day1, status: "PRESENT", studentSignature: { id: "x", at: new Date() }, staffSignature: null, history: [], comments: [], updatedAt: new Date() } as any);
  await asStaff(ids.admin);
  assert.ok((await S.adminEditRowAction(alex._id, day1, {}, fd({ status: "EXCUSED", reason: "doctor's note" }))).ok);

  await asStaff(ids.saniya);
  assert.match((await S.signMonthsAction({}, fd({ month, students: JSON.stringify([alex._id]), signature: SIG }))).error, /Only the admin who signs/);
  // Another admin (not the chosen signer) can't sign the "Approved by" section either.
  await asStaff(ids.admin);
  assert.match((await S.signMonthsAction({}, fd({ month, students: JSON.stringify([alex._id]), signature: SIG }))).error, /Only the admin who signs/);
  jar().clear(); await auth.startStaffSession({ _id: MAHEK, passwordHash: "x" });
  assert.match((await S.signMonthsAction({}, fd({ month, students: JSON.stringify([alex._id]) }))).error, /Sign by hand/);
  // The current month isn't over: it can't be signed off yet (that would lock the student's remaining days).
  assert.match((await S.signMonthsAction({}, fd({ month: today.slice(0, 7), students: JSON.stringify([alex._id]), signature: SIG }))).error, /isn't over yet/);

  // A typed name or position is ignored: it's always the signer's own account.
  const r = await S.signMonthsAction({}, fd({ month, students: JSON.stringify([jen._id, alex._id]), signature: SIG, staffName: "Pratip Kayal", position: "Instructor", comments: "Good month" }));
  assert.ok(r.ok, JSON.stringify(r));
  assert.match(r.message, /Signed off .* for 1 student/);
  assert.match(r.message, /Jennifer Quezada: 1 day still waiting for the teacher/);
  const signed: any = await db.collection("month_approvals").findOne({ _id: `${alex._id}:${month}` as any });
  assert.deepEqual([signed.staffName, signed.position, signed.comments], ["Mahek", "Asst. Director", "Good month"]);

  // Closed for teachers (and students, in the weeks they can still reach).
  await asStaff(ids.saniya);
  assert.match((await S.markRowsAction({}, fd({ rows: JSON.stringify([`${alex._id}:${day2}`]), mark: "ABSENT" }))).error, /signed off by Mahek/);
  if (day2 >= week.openFrom(today)) {
    await asStudent(alex._id);
    assert.match((await ST.submitDayAction(day2, {}, day())).error, /signed off/);
  }

  // The student sees Mahek's signature on their sheet; another student can't open it.
  const route = await import("../../src/app/api/ink/[id]/route");
  const get = () => route.GET(new Request("http://x"), { params: Promise.resolve({ id: signed.signatureId }) });
  await asStudent(alex._id);
  assert.equal((await get()).status, 200);
  await asStudent(jen._id);
  assert.equal((await get()).status, 404);

  // The PDF prints it at the bottom ("Approved by"), current.
  const rep = await report.loadReport(alex._id, month);
  assert.equal(rep.months[0].approval.staffName, "Mahek");
  assert.equal(rep.months[0].approvalCurrent, true);

  // An admin can take the sign-off off again; it's kept in the audit log.
  await asStaff(ids.admin);
  assert.ok((await S.removeMonthSignOffAction(alex._id, month, {}, fd({}))).ok);
  assert.equal(await db.collection("month_approvals").countDocuments({ _id: `${alex._id}:${month}` as any }), 0);
  assert.ok(await db.collection("audit_logs").findOne({ action: "admin.remove_month_sign_off" }));
});

test("reports still build with the new records (PDF and Word)", async () => {
  const jen = await byName("Jennifer Quezada");
  const rep = await report.loadReport(jen._id, lastMon.slice(0, 7));
  // Every handwritten time, lunch included, is loaded for printing.
  const mon: any = await entry(jen._id, lastMon);
  for (const id of [mon.startInkId, mon.lunchStartInkId, mon.lunchEndInkId, mon.endInkId]) if (id) assert.ok(rep.months[0].images[id], "handwriting image loaded for the sheet");
  const pdf = await report.buildPdf(rep);
  assert.equal(Buffer.from(pdf).subarray(0, 5).toString(), "%PDF-");
  const docx = await report.buildDocx(rep);
  assert.equal(Buffer.from(docx).subarray(0, 2).toString(), "PK");
});

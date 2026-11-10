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
const NOTE = realPng(400, 120);

let today = "", d3 = "", d10 = "", lastMonth = "";
const ids = { admin: randomUUID(), teacher: randomUUID(), mahek: randomUUID(), night: randomUUID() };
const sigIds = { mahek: randomUUID(), teacher: randomUUID() };

async function asStaff(id: string) {
  jar().clear();
  const s = await db.collection("staff").findOne({ _id: id as any });
  await auth.startStaffSession(s);
}
async function asStudent(id: unknown) {
  jar().clear();
  await auth.startStudentSession(String(id));
}
/** Runs an action that ends in redirect(); returns where it went. */
async function redirected(p: Promise<unknown>) {
  try { await p; } catch (e: any) { if (e?.to) return e.to as string; throw e; }
  return null;
}

before(async () => {
  client = await MongoClient.connect(URI);
  db = client.db();
  await db.dropDatabase();
  // The same indexes as `npm run setup`.
  await db.collection("staff").createIndex({ email: 1 }, { unique: true });
  await db.collection("students").createIndex({ pinKey: 1 }, { unique: true, name: "unique_active_pin", partialFilterExpression: { active: true, pinKey: { $type: "string" } } });
  await db.collection("rate_limits").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

  A = await import("../../src/actions/admin");
  S = await import("../../src/actions/staff");
  ST = await import("../../src/actions/student");
  auth = await import("../../src/lib/auth");
  sheet = await import("../../src/lib/sheet");
  report = await import("../../src/lib/report");
  summary = await import("../../src/lib/summary");

  today = sheet.todayIn("America/New_York");
  d3 = sheet.addDays(today, -3);
  d10 = sheet.addDays(today, -10);
  lastMonth = sheet.shiftMonth(today.slice(0, 7), -1);
  const hash = await bcrypt.hash("password-123456", 4);
  const now = new Date();
  await db.collection("staff").insertMany([
    { _id: ids.admin, name: "Ada Admin", email: "admin@x.test", position: "Director", role: "ADMIN", courses: [], passwordHash: hash, signatureId: null, active: true, createdAt: now },
    { _id: ids.teacher, name: "Tom Teacher", email: "tom@x.test", position: "Instructor", role: "TEACHER", courses: ["Office"], passwordHash: hash, signatureId: sigIds.teacher, active: true, createdAt: now },
    { _id: ids.mahek, name: "Mahek", email: "mahek@x.test", position: "Asst. Director", role: "ADMIN", courses: [], passwordHash: hash, signatureId: sigIds.mahek, active: true, createdAt: now },
  ] as any[]);
  await db.collection("signatures").insertMany([
    { _id: sigIds.mahek, ownerType: "STAFF", ownerId: ids.mahek, png: SIG, source: "DRAWN", createdAt: now, createdBy: ids.mahek },
    { _id: sigIds.teacher, ownerType: "STAFF", ownerId: ids.teacher, png: SIG, source: "DRAWN", createdAt: now, createdBy: ids.teacher },
  ] as any[]);
});
after(async () => {
  await client?.close();
  // The app keeps one shared connection; close it so the test run can finish.
  const appClient = await (globalThis as any).mongo?.catch(() => null);
  await appClient?.close();
});

const studentForm = (name: string, course: string, pin = "") => fd({
  name, courseName: course, courseCode: "305-V", courseDuration: "6 months", caseManager: "S. Nandi", instructor: "Mr. Rakesh",
  startDate: sheet.addDays(today, -60), endDate: sheet.addDays(today, 60), classDays: ["1", "2", "3", "4", "5", "6", "7"], pin,
});
const studentByName = (name: string) => db.collection("students").findOne({ name });

// ---------------------------------------------------------------- PINs

test("PINs are unique among active students, never trivial, and only admins reset them", async () => {
  await asStaff(ids.admin);
  let r = await A.saveStudentAction(null, {}, studentForm("Kevin Reid", "Office", "2468"));
  assert.ok(r.ok, JSON.stringify(r));
  r = await A.saveStudentAction(null, {}, studentForm("Maria Lopez", "Office", "2468"));
  assert.match(r.fieldErrors?.pin ?? "", /Another student already has this PIN/);
  r = await A.saveStudentAction(null, {}, studentForm("Maria Lopez", "Office", "1234"));
  assert.match(r.fieldErrors?.pin ?? "", /easy to guess/);
  r = await A.saveStudentAction(null, {}, studentForm("Maria Lopez", "Office"));
  assert.ok(r.ok);
  const mariaPin = (r.data as any).pin as string;
  assert.match(mariaPin, /^\d{4,6}$/);
  assert.notEqual(mariaPin, "2468");
  r = await A.saveStudentAction(null, {}, studentForm("Łukasz Nowak", "Night", "8023"));
  assert.ok(r.ok);

  const all = await db.collection("students").find({}).toArray();
  assert.equal(new Set(all.map((s) => s.pinKey)).size, all.length);
  assert.ok(all.every((s) => typeof s.pinKey === "string" && !String(s.pinKey).includes("2468")));

  // The database itself refuses a duplicate, even if a check were skipped (race between two admins).
  const kevin = await studentByName("Kevin Reid");
  await assert.rejects(db.collection("students").insertOne({ _id: randomUUID(), name: "Dup", active: true, pinKey: kevin!.pinKey } as any), /E11000/);

  // Teachers can't reset PINs.
  await asStaff(ids.teacher);
  assert.equal(await redirected(A.resetPinAction(kevin!._id, {}, fd({}))), "/teacher");

  // Admin: typed PIN that another student has is refused; random works.
  await asStaff(ids.admin);
  r = await A.resetPinAction(kevin!._id, {}, fd({ pin: "8023" }));
  assert.match(r.fieldErrors?.pin ?? "", /Another student/);
  r = await A.resetPinAction(kevin!._id, {}, fd({ pin: "" }));
  assert.ok(r.ok);
  const newPin = /New PIN for Kevin Reid: (\d+)/.exec(r.message)![1];
  // Put Kevin back on PIN 2468 for the login test below.
  r = await A.resetPinAction(kevin!._id, {}, fd({ pin: "2468" }));
  assert.ok(r.ok, JSON.stringify(r));
  assert.notEqual(newPin, "");
});

test("an inactive student's PIN can be reused, and they can't come back while someone has it", async () => {
  await asStaff(ids.admin);
  let r = await A.saveStudentAction(null, {}, studentForm("Old Student", "Office", "5813"));
  assert.ok(r.ok);
  const old = await studentByName("Old Student");
  r = await A.setStudentActiveAction(old!._id, {}, fd({ active: "0" }));
  assert.ok(r.ok);
  r = await A.saveStudentAction(null, {}, studentForm("New Student", "Office", "5813"));
  assert.ok(r.ok, "the PIN of an inactive student is free again");
  r = await A.setStudentActiveAction(old!._id, {}, fd({ active: "1" }));
  assert.match(r.error ?? "", /Give them a new PIN first/);
  assert.equal((await studentByName("Old Student"))!.active, false);
});

test("importing students: a file with clashing PINs imports nothing; random PINs are unique", async () => {
  await asStaff(ids.admin);
  const header = "name,courseName,courseCode,courseDuration,caseManager,instructor,startDate,endDate,pin\n";
  const before = await db.collection("students").countDocuments();
  const bad = new File([`${header}A One,Office,1,1,x,y,01/01/2026,12/31/2026,3579\nB Two,Office,1,1,x,y,01/01/2026,12/31/2026,3579\n`], "s.csv", { type: "text/csv" });
  const f1 = new FormData(); f1.set("file", bad);
  let r = await A.importStudentsAction({}, f1);
  assert.match(r.error ?? "", /same PIN as A One/);
  const taken = new File([`${header}C Three,Office,1,1,x,y,01/01/2026,12/31/2026,2468\n`], "s.csv");
  const f2 = new FormData(); f2.set("file", taken);
  r = await A.importStudentsAction({}, f2);
  assert.match(r.error ?? "", /already used by another student/);
  assert.equal(await db.collection("students").countDocuments(), before, "nothing imported");
  const rows = Array.from({ length: 40 }, (_, i) => `Bulk ${i},Office,1,1,x,y,01/01/2026,12/31/2026,`).join("\n");
  const f3 = new FormData(); f3.set("file", new File([header + rows], "s.csv"));
  r = await A.importStudentsAction({}, f3);
  assert.ok(r.ok, JSON.stringify(r));
  const pins = (r.data as any).pins.map((p: any) => p.pin);
  assert.equal(new Set(pins).size, 40);
  assert.ok(pins.every((p: string) => p !== "2468" && p !== "8023"));
});

// ---------------------------------------------------------------- Student sign-in and handwriting

test("a student signs in with their name and PIN; a wrong PIN doesn't", async () => {
  const kevin = await studentByName("Kevin Reid");
  jar().clear();
  const wrong = await ST.pinSignInAction(kevin!._id, {}, fd({ pin: "1357" }));
  assert.match(wrong.error ?? "", /isn't right/);
  assert.equal(await redirected(ST.pinSignInAction(kevin!._id, {}, fd({ pin: "2468" }))), "/student/sheet");
  assert.equal((await auth.currentStudent())._id, kevin!._id);
});

test("end of day: the student must sign by hand; the signature is stored and kept on file", async () => {
  const kevin = await studentByName("Kevin Reid");
  // Started 30 minutes ago (written directly: typed times are checked against the real clock).
  const startAt = new Date(Date.now() - 30 * 60_000);
  const startTime = sheet.clockIn("America/New_York", startAt, "start");
  await db.collection("entries").insertOne({
    _id: `${kevin!._id}:${today}`, studentId: kevin!._id, date: today, status: "PRESENT", startAt, endAt: null, startTime, endTime: null,
    minutes: null, startLateBy: 0, endLateBy: null, studentSignature: null, staffSignature: null, note: "", history: [], comments: [], updatedAt: startAt,
  } as any);
  await asStudent(kevin!._id);
  const nowTime = sheet.clockIn("America/New_York", new Date(), "end");
  // The end time is written by hand; without the handwriting nothing is saved.
  let r = await ST.studentFillAction({}, fd({ signature: SIG }));
  assert.match(r.error ?? "", /Write the time in the box/);
  r = await ST.studentFillAction({}, fd({ timeInk: SIG }));
  assert.match(r.error ?? "", /Sign in the box/);
  r = await ST.studentFillAction({}, fd({ timeInk: SIG, signature: "data:image/png;base64,AAAA" }));
  assert.ok(r.error);
  // A typed time is ignored: the server records its own clock with the handwriting.
  r = await ST.studentFillAction({}, fd({ time: "23:59", timeInk: SIG, signature: SIG }));
  assert.ok(r.ok, JSON.stringify(r));
  const e = await db.collection("entries").findOne({ _id: `${kevin!._id}:${today}` as any });
  assert.equal(e!.endTime, nowTime);
  const timeInk = await db.collection("signatures").findOne({ _id: e!.endInkId });
  assert.equal(timeInk!.kind, "TIME");
  assert.equal(timeInk!.ownerId, kevin!._id);
  const sig = await db.collection("signatures").findOne({ _id: e!.studentSignature.id });
  assert.equal(sig!.source, "DRAWN");
  assert.equal(sig!.ownerId, kevin!._id);
  assert.equal((await studentByName("Kevin Reid"))!.signatureId, sig!._id, "first handwritten signature is kept on file");
  // Filling again doesn't write twice.
  r = await ST.studentFillAction({}, fd({ timeInk: SIG, signature: SIG }));
  assert.match(r.message ?? "", /already filled/);
});

test("the student can sign an open day staff completed, but not a locked one; and add a handwritten note", async () => {
  const maria = await studentByName("Maria Lopez");
  const base = { studentId: maria!._id, status: "PRESENT", startAt: null, endAt: null, startTime: "09:00", endTime: "15:00", minutes: 360, studentSignature: null, staffSignature: null, note: "", history: [], comments: [], updatedAt: new Date() };
  await db.collection("entries").insertMany([{ _id: `${maria!._id}:${d3}`, date: d3, ...base }, { _id: `${maria!._id}:${d10}`, date: d10, ...base }] as any[]);
  await asStudent(maria!._id);
  let r = await ST.studentSignRowAction(d10, {}, fd({ signature: SIG }));
  assert.match(r.error ?? "", /locked/);
  r = await ST.studentSignRowAction(d3, {}, fd({ signature: SIG }));
  assert.ok(r.ok, JSON.stringify(r));
  r = await ST.studentSignRowAction(sheet.addDays(today, 1), {}, fd({ signature: SIG }));
  assert.match(r.error ?? "", /hasn't happened/);
  // A note on today needs today's row first.
  r = await ST.studentCommentAction({}, fd({ text: "Bus was late" }));
  assert.match(r.error ?? "", /start time first/);
  const kevin = await studentByName("Kevin Reid");
  await asStudent(kevin!._id);
  r = await ST.studentCommentAction({}, fd({ text: "Bus was late", ink: NOTE }));
  assert.ok(r.ok, JSON.stringify(r));
  const e = await db.collection("entries").findOne({ _id: `${kevin!._id}:${today}` as any });
  assert.equal(e!.comments.length, 1);
  assert.equal(e!.comments[0].byRole, "STUDENT");
  assert.equal((await db.collection("signatures").findOne({ _id: e!.comments[0].inkId }))!.kind, "NOTE");
});

// ---------------------------------------------------------------- Seven-day window and history

test("the 7-day window: teachers can't comment on old rows but can still sign an unsigned one; admins change rows with a recorded reason", async () => {
  const maria = await studentByName("Maria Lopez");
  await asStaff(ids.teacher);
  let r = await S.addCommentAction(`${maria!._id}:${d10}`, {}, fd({ text: "late note" }));
  assert.match(r.error ?? "", /locked/);

  await asStaff(ids.admin);
  r = await S.editRowAction(maria!._id, d3, {}, fd({ status: "PRESENT", startTime: "09:00", endTime: "14:00", reason: "left early" }));
  assert.ok(r.ok, JSON.stringify(r));
  r = await S.editRowAction(maria!._id, d10, {}, fd({ status: "PRESENT", startTime: "09:00", endTime: "14:00", reason: "" }));
  assert.match(r.fieldErrors?.reason ?? "", /locked/);
  r = await S.editRowAction(maria!._id, d10, {}, fd({ status: "PRESENT", startTime: "09:00", endTime: "14:00", reason: "Paper sheet shows 2 pm" }));
  assert.ok(r.ok, JSON.stringify(r));
  const log = await db.collection("audit_logs").findOne({ action: "admin.edit_locked_row", target: `${maria!._id}:${d10}` });
  assert.equal(log!.meta.reason, "Paper sheet shows 2 pm");
  r = await S.addCommentAction(`${maria!._id}:${d10}`, {}, fd({ text: "Checked against paper" }));
  assert.ok(r.ok);
  // Admins don't sign rows: that's the teacher's signature.
  const s = new FormData(); s.set("rows", JSON.stringify([`${maria!._id}:${d10}`])); s.set("signature", SIG);
  assert.match((await S.signRowsAction({}, s)).error ?? "", /signed by the teacher/);

  // The teacher signs the corrected old row: it had no signature, so nothing is replaced.
  await asStaff(ids.teacher);
  r = await S.signRowsAction({}, s);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal((await db.collection("entries").findOne({ _id: `${maria!._id}:${d10}` as any }))!.staffSignature.staffId, ids.teacher);
});

test("historical signatures are kept: nobody swaps a signature on a locked row, and nobody replaces Mahek's", async () => {
  const kevin = await studentByName("Kevin Reid");
  const mahekSig = { id: sigIds.mahek, at: new Date(), staffId: ids.mahek, staffName: "Mahek" };
  const base = { studentId: kevin!._id, status: "PRESENT", startAt: null, endAt: null, startTime: "09:00", endTime: "15:00", minutes: 360, studentSignature: null, staffSignature: mahekSig, note: "", history: [], comments: [], updatedAt: new Date() };
  await db.collection("entries").insertMany([{ _id: `${kevin!._id}:${d10}`, date: d10, ...base }, { _id: `${kevin!._id}:${d3}`, date: d3, ...base }] as any[]);

  for (const who of [ids.teacher, ids.admin, ids.mahek]) {
    await asStaff(who);
    const r = await S.replaceRowSignatureAction(`${kevin!._id}:${d10}`, "staff");
    assert.match(r.error ?? "", who === ids.teacher ? /locked/ : /signed by the teacher/);
  }
  await asStaff(ids.teacher);
  let r = await S.replaceRowSignatureAction(`${kevin!._id}:${d3}`, "staff");
  assert.match(r.error ?? "", /signed by Mahek/);
  // Signing again (bulk) leaves rows already signed by someone else alone.
  const s = new FormData(); s.set("rows", JSON.stringify([`${kevin!._id}:${d3}`]));
  await S.signRowsAction({}, s);
  const rows = await db.collection("entries").find({ _id: { $in: [`${kevin!._id}:${d10}`, `${kevin!._id}:${d3}`] } as any }).toArray();
  assert.ok(rows.every((x) => x.staffSignature.id === sigIds.mahek && x.staffSignature.staffName === "Mahek"));
  // Mahek is an admin now: she signs months, not rows, so her old row signatures simply stay.
  await asStaff(ids.mahek);
  r = await S.replaceRowSignatureAction(`${kevin!._id}:${d3}`, "staff");
  assert.match(r.error ?? "", /signed by the teacher/);
  assert.ok(await db.collection("signatures").findOne({ _id: sigIds.mahek as any }), "old signature image is never deleted");
  assert.equal((await db.collection("entries").findOne({ _id: `${kevin!._id}:${d3}` as any }))!.staffSignature.id, sigIds.mahek);
});

test("staff validate attendance by signing by hand; that signature is stored per signing", async () => {
  const maria = await studentByName("Maria Lopez");
  await asStaff(ids.teacher);
  const s = new FormData();
  s.set("rows", JSON.stringify([`${maria!._id}:${d3}`]));
  s.set("signature", SIG);
  const r = await S.signRowsAction({}, s);
  assert.ok(r.ok, JSON.stringify(r));
  const e = await db.collection("entries").findOne({ _id: `${maria!._id}:${d3}` as any });
  assert.equal(e!.staffSignature.staffId, ids.teacher);
  assert.notEqual(e!.staffSignature.id, sigIds.teacher, "a fresh handwritten signature, not the one on file");
  assert.equal((await db.collection("signatures").findOne({ _id: e!.staffSignature.id }))!.source, "DRAWN");
  // A teacher with no signature on file can still sign by hand.
  await db.collection("staff").updateOne({ _id: ids.teacher as any }, { $set: { signatureId: null } });
  await asStaff(ids.teacher);
  const kevin = await studentByName("Kevin Reid");
  const s2 = new FormData(); s2.set("rows", JSON.stringify([`${kevin!._id}:${today}`]));
  assert.match((await S.signRowsAction({}, s2)).error ?? "", /Sign by hand/);
  s2.set("signature", SIG);
  assert.ok((await S.signRowsAction({}, s2)).ok);
  await db.collection("staff").updateOne({ _id: ids.teacher as any }, { $set: { signatureId: sigIds.teacher } });
});

test("month approvals (the bottom of the sheet) are signed by admins like Mahek, never by teachers", async () => {
  const kevin = await studentByName("Kevin Reid");
  await db.collection("entries").insertOne({ _id: `${kevin!._id}:${lastMonth}-15`, studentId: kevin!._id, date: `${lastMonth}-15`, status: "ABSENT", startAt: null, endAt: null, startTime: null, endTime: null, minutes: null, studentSignature: null, staffSignature: null, note: "", history: [], comments: [], updatedAt: new Date() } as any);
  await asStaff(ids.mahek);
  let r = await S.approveMonthAction(kevin!._id, lastMonth, {}, fd({ comments: "Good month", commentsInk: NOTE }));
  assert.ok(r.ok, JSON.stringify(r));
  const a = await db.collection("month_approvals").findOne({ _id: `${kevin!._id}:${lastMonth}` as any });
  assert.ok(a!.commentsInkId);
  await asStaff(ids.teacher);
  r = await S.approveMonthAction(kevin!._id, lastMonth, {}, fd({ comments: "mine", signature: SIG }));
  assert.match(r.error ?? "", /signed by an admin/);
  assert.equal((await db.collection("month_approvals").findOne({ _id: `${kevin!._id}:${lastMonth}` as any }))!.staffName, "Mahek", "Mahek's approval is untouched");
  await asStaff(ids.mahek);
  r = await S.approveMonthAction(kevin!._id, lastMonth, {}, fd({ comments: "Good month, checked again", signature: SIG }));
  assert.ok(r.ok, "the same person can approve again");
  await asStaff(ids.admin);
  r = await S.approveMonthAction(kevin!._id, lastMonth, {}, fd({ comments: "Admin review", signature: SIG }));
  assert.ok(r.ok, JSON.stringify(r));
  const log = await db.collection("audit_logs").findOne({ action: "staff.approve_month", actor: ids.admin });
  assert.equal(log!.meta.replaced.staffName, "Mahek");
});

// ---------------------------------------------------------------- Class days off, comments, scope

test("a class day off: only admins mark it, with a note; a student can't start on it", async () => {
  const lukasz = await studentByName("Łukasz Nowak");
  await asStaff(ids.teacher);
  let r = await S.markCourseDayAction({}, fd({ date: sheet.addDays(today, 3), course: "Office", status: "HOLIDAY", note: "Instructor training" }));
  assert.match(r.error ?? "", /Only an admin/);
  assert.equal(await db.collection("entries").countDocuments({ date: sheet.addDays(today, 3) }), 0, "nothing written");
  await asStaff(ids.admin);
  r = await S.markCourseDayAction({}, fd({ date: sheet.addDays(today, 3), course: "Office", status: "HOLIDAY", note: "" }));
  assert.ok(r.fieldErrors?.note);
  r = await S.markCourseDayAction({}, fd({ date: sheet.addDays(today, 3), course: "Office", status: "HOLIDAY", note: "Instructor training" }));
  assert.ok(r.ok, JSON.stringify(r));
  const n = await db.collection("entries").countDocuments({ date: sheet.addDays(today, 3), status: "HOLIDAY", note: "Instructor training" });
  assert.ok(n >= 40, `marked ${n}`);
  r = await S.markCourseDayAction({}, fd({ date: sheet.addDays(today, 3), course: "Office", status: "REMOVE", note: "" }));
  assert.ok(r.ok);
  assert.equal(await db.collection("entries").countDocuments({ date: sheet.addDays(today, 3) }), 0);

  r = await S.markCourseDayAction({}, fd({ date: today, course: "Night", status: "HOLIDAY", note: "Room flooded" }));
  assert.ok(r.ok, JSON.stringify(r));
  await asStudent(lukasz!._id);
  r = await ST.studentStartAction({}, fd({ timeInk: SIG }));
  assert.match(r.error ?? "", /holiday for your class \(Room flooded\)/);
  // An Excused row someone recorded by hand is not removed by "Remove".
  await asStaff(ids.admin);
  await S.editRowAction(lukasz!._id, d3, {}, fd({ status: "EXCUSED", note: "doctor", reason: "" }));
  await S.markCourseDayAction({}, fd({ date: d3, course: "Night", status: "REMOVE", note: "" }));
  assert.ok(await db.collection("entries").findOne({ _id: `${lukasz!._id}:${d3}` as any }));
});

test("teachers only reach students of their own classes", async () => {
  const lukasz = await studentByName("Łukasz Nowak");
  await asStaff(ids.teacher);
  const r = await S.addCommentAction(`${lukasz!._id}:${today}`, {}, fd({ text: "hi" }));
  assert.match(r.error ?? "", /isn't in your courses/);
  const s = new FormData(); s.set("rows", JSON.stringify([`${lukasz!._id}:${today}`])); s.set("signature", SIG);
  assert.match((await S.signRowsAction({}, s)).error ?? "", /not one of your students/);
  assert.match((await S.replaceRowSignatureAction(`${lukasz!._id}:${today}`, "staff")).error ?? "", /isn't in your courses/);
  assert.equal(await redirected(A.saveStudentProfileAction(lukasz!._id, {}, fd({ phone: "1" }))), "/teacher");
});

test("the profile keeps contact and social information (admins edit it)", async () => {
  const kevin = await studentByName("Kevin Reid");
  await asStaff(ids.admin);
  let r = await A.saveStudentProfileAction(kevin!._id, {}, fd({ phone: "201-555-0100", email: "not-an-email", address: "", emergencyName: "", emergencyPhone: "", social: "" }));
  assert.ok(r.fieldErrors?.email);
  r = await A.saveStudentProfileAction(kevin!._id, {}, fd({ phone: "201-555-0100", email: "Kevin@Example.com", address: "1 Main St", emergencyName: "Ann Reid (mother)", emergencyPhone: "201-555-0101", social: "Takes the 80 bus" }));
  assert.ok(r.ok);
  const k = await studentByName("Kevin Reid");
  assert.equal(k!.profile.email, "kevin@example.com");
  assert.equal(k!.profile.social, "Takes the 80 bus");
});

// ---------------------------------------------------------------- Summary and reports

test("attendance summaries and colours come out of real rows", async () => {
  const maria = await studentByName("Maria Lopez");
  const m = await summary.summaryFor(maria);
  // 61 class days so far (every day for 60 days back, today not yet recorded); 2 present.
  assert.equal(m.present, 2);
  assert.ok(m.missing > 50);
  assert.equal(m.level, "poor");
});

test("reports build with any names and comments (accents, other alphabets, emoji) in PDF and Word", async () => {
  const lukasz = await studentByName("Łukasz Nowak");
  await asStaff(ids.admin);
  await S.editRowAction(lukasz!._id, sheet.addDays(today, -1), {}, fd({ status: "PRESENT", startTime: "09:00", endTime: "12:00", reason: "" }));
  await S.addCommentAction(`${lukasz!._id}:${sheet.addDays(today, -1)}`, {}, fd({ text: "Très bien 👍 — Ωmega “quoted” ".repeat(30), ink: NOTE }));
  const kevin = await studentByName("Kevin Reid");
  const { PDFDocument } = await import("pdf-lib");
  for (const id of [lukasz!._id, kevin!._id]) {
    const rep = await report.loadReport(id, "all");
    const pdf = await report.buildPdf(rep);
    const doc = await PDFDocument.load(pdf);
    assert.ok(doc.getPageCount() >= 3, "every month of the course, plus comment pages");
    const docx = await report.buildDocx(rep);
    assert.equal(docx.subarray(0, 2).toString(), "PK");
  }
  const cls = await import("../../src/lib/classreport");
  const rows = await cls.classMonth({}, today.slice(0, 7));
  assert.ok(rows.length >= 40);
  const sumPdf = await PDFDocument.load(await report.buildMonthSummaryPdf(today.slice(0, 7), "", rows));
  assert.ok(sumPdf.getPageCount() >= 2, "long class lists continue on more pages");
  assert.equal(sumPdf.getPage(0).getWidth(), 792, "landscape");
  const helv = await (await PDFDocument.create()).embedFont("Helvetica");
  // Accents the font has are kept (é, curly quotes); others lose the accent (Ł -> L); emoji become "?".
  assert.equal(report.pdfSafe("Łukasz Très 👍 “x”", helv), "Lukasz Très ? “x”");
});

// ---------------------------------------------------------------- Admin and teacher portals

test("admins and teachers each sign in on their own page", async () => {
  jar().clear();
  const login = (fn: any, email: string) => fn({}, fd({ email, password: "password-123456" }));
  assert.match((await login(S.teacherLoginAction, "admin@x.test")).error ?? "", /admin account/);
  assert.match((await login(S.adminLoginAction, "tom@x.test")).error ?? "", /teacher account/);
  assert.equal(jar().size, 0, "no session from the wrong page");
  assert.equal(await redirected(login(S.teacherLoginAction, "tom@x.test")), "/teacher");
  assert.equal(await redirected(login(S.adminLoginAction, "admin@x.test")), "/admin");
  assert.match((await S.teacherLoginAction({}, fd({ email: "tom@x.test", password: "wrong-password" }))).error ?? "", /incorrect/);
});

test("teachers sign each row but never change the student's entries; the admin signs the bottom", async () => {
  const kevin = await studentByName("Kevin Reid");
  const d2 = sheet.addDays(today, -2);
  const key = `${kevin!._id}:${d2}`;
  // The student's own row, without a student signature yet.
  await db.collection("entries").insertOne({ _id: key, studentId: kevin!._id, date: d2, status: "PRESENT", startAt: null, endAt: null, startTime: "09:00", endTime: "13:00", minutes: 240, studentSignature: null, staffSignature: null, note: "", history: [], comments: [], updatedAt: new Date() } as any);
  await db.collection("students").updateOne({ _id: kevin!._id }, { $set: { signatureId: sigIds.teacher } }); // any image on file
  const before = await db.collection("entries").findOne({ _id: key as any });

  await asStaff(ids.teacher);
  const blocked = /can't change a student's entries/;
  assert.match((await S.editRowAction(kevin!._id, d2, {}, fd({ status: "ABSENT", reason: "teacher thinks so" }))).error ?? "", blocked);
  assert.match((await S.markAbsentAction(today, {}, fd({ students: JSON.stringify([kevin!._id]) }))).error ?? "", blocked);
  assert.match((await S.fillStudentSignatureAction(key)).error ?? "", blocked);
  assert.match((await S.fillStudentSignaturesAction([key])).error ?? "", blocked);
  assert.match((await S.replaceRowSignatureAction(key, "student")).error ?? "", blocked);
  assert.equal(await redirected(A.setStudentSignatureAction(kevin!._id, {}, fd({ signature: SIG }))), "/teacher");
  const after = await db.collection("entries").findOne({ _id: key as any });
  assert.deepEqual(after, before, "the row is exactly as the student left it");
  assert.equal(await db.collection("entries").countDocuments({ date: today, status: "ABSENT", studentId: kevin!._id }), 0);

  // What a teacher does do: sign the row's staff signature, and comment.
  const sign = new FormData(); sign.set("rows", JSON.stringify([key]));
  let r = await S.signRowsAction({}, sign);
  assert.ok(r.ok, JSON.stringify(r));
  const signed = await db.collection("entries").findOne({ _id: key as any });
  assert.equal(signed!.staffSignature.staffId, ids.teacher);
  assert.equal(signed!.studentSignature, null, "the student's signature is still theirs to add");
  assert.equal(signed!.startTime, "09:00");
  r = await S.addCommentAction(key, {}, fd({ text: "Arrived on time" }));
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal((await db.collection("entries").findOne({ _id: key as any }))!.comments.at(-1).byRole, "TEACHER");

  // The bottom of the sheet ("Approved by") is the admin's: Mahek signs it, the teacher can't.
  const month = d2.slice(0, 7);
  r = await S.approveMonthAction(kevin!._id, month, {}, fd({ staffName: "Tom Teacher", comments: "x", signature: SIG }));
  assert.match(r.error ?? "", /signed by an admin/);
  await asStaff(ids.mahek);
  r = await S.approveMonthAction(kevin!._id, month, {}, fd({ staffName: " ", position: "Asst. Director", comments: "x" }));
  assert.ok(r.fieldErrors?.staffName, "a name is needed for the Approved by block");
  r = await S.approveMonthAction(kevin!._id, month, {}, fd({ staffName: "Mahek  Shah", position: "Asst. Director", comments: "Good month", signature: SIG }));
  assert.ok(r.ok, JSON.stringify(r));
  const a = await db.collection("month_approvals").findOne({ _id: `${kevin!._id}:${month}` as any });
  assert.equal(a!.staffName, "Mahek Shah");
  assert.equal(a!.position, "Asst. Director");
  assert.equal(a!.staffId, ids.mahek, "the account that approved is always recorded");
  const log = await db.collection("audit_logs").findOne({ action: "staff.approve_month", target: `${kevin!._id}:${month}` }, { sort: { at: -1 } });
  assert.equal(log!.meta.account, "Mahek");

  // The review list reflects it.
  const T = await import("../../src/lib/teacher");
  const staffDoc = (await db.collection("staff").findOne({ _id: ids.teacher as any })) as any;
  const rows = await T.reviewMonth(staffDoc, month, "Office");
  assert.ok(rows.every((x: any) => x.course === "Office"), "only the course asked for");
  assert.equal(rows.find((x: any) => x.id === kevin!._id)!.approval, "approved");
  assert.equal((await T.reviewMonth(staffDoc, month, "Night")).length, 0, "not the teacher's course");
  await db.collection("month_approvals").deleteOne({ _id: `${kevin!._id}:${month}` as any });
});

// ---------------------------------------------------------------- Students fill in earlier days

test("a student can fill in an earlier class day they forgot; teachers see it flagged", async () => {
  await asStaff(ids.admin);
  const r0 = await A.saveStudentAction(null, {}, studentForm("Pat Past", "Office", "7391"));
  assert.ok(r0.ok, JSON.stringify(r0));
  const pat = await studentByName("Pat Past");
  const [d1, d2, d4] = [1, 2, 4].map((n) => sheet.addDays(today, -n));
  await S.markAbsentAction(d1, {}, fd({ students: JSON.stringify([pat!._id]) }));
  await asStudent(pat!._id);
  const good = { startTime: "09:00", endTime: "13:30", signature: SIG };

  let r = await ST.studentFillPastDayAction(today, {}, fd(good));
  assert.match(r.error ?? "", /For today/);
  r = await ST.studentFillPastDayAction(sheet.addDays(today, 1), {}, fd(good));
  assert.match(r.error ?? "", /hasn't happened/);
  r = await ST.studentFillPastDayAction(d4, {}, fd({ startTime: "09:00", endTime: "13:30" }));
  assert.ok(r.fieldErrors?.signature);
  r = await ST.studentFillPastDayAction(d4, {}, fd({ ...good, endTime: "08:00" }));
  assert.ok(r.fieldErrors?.endTime);
  assert.equal(await db.collection("entries").countDocuments({ studentId: pat!._id, date: d4 }), 0, "nothing saved on a mistake");
  r = await ST.studentFillPastDayAction(d1, {}, fd(good));
  assert.match(r.error ?? "", /marked absent/, "an admin's decision is left alone");

  r = await ST.studentFillPastDayAction(d4, {}, fd({ ...good, note: "Tablet was broken" }));
  assert.ok(r.ok, JSON.stringify(r));
  const e = await db.collection("entries").findOne({ _id: `${pat!._id}:${d4}` as any });
  assert.equal(e!.status, "PRESENT");
  assert.equal(e!.minutes, 270);
  assert.ok(e!.filledLaterAt instanceof Date);
  assert.ok(e!.studentSignature?.id);
  assert.equal(e!.staffSignature, null);
  assert.equal(e!.comments[0].text, "Tablet was broken");
  assert.equal(e!.comments[0].byRole, "STUDENT");
  assert.ok(await db.collection("audit_logs").findOne({ action: "student.fill_past_day", target: `${pat!._id}:${d4}` }));
  r = await ST.studentFillPastDayAction(d4, {}, fd({ ...good, startTime: "07:00" }));
  assert.match(r.message ?? "", /already filled in/);
  assert.equal((await db.collection("entries").findOne({ _id: `${pat!._id}:${d4}` as any }))!.startTime, "09:00", "not overwritten");

  // An approved month is closed to filling in.
  await db.collection("month_approvals").insertOne({ _id: `${pat!._id}:${d2.slice(0, 7)}`, studentId: pat!._id, month: d2.slice(0, 7), staffId: ids.teacher, staffName: "Tom Teacher", position: "", signatureId: sigIds.teacher, comments: "", entriesHash: "x", signedAt: new Date() } as any);
  r = await ST.studentFillPastDayAction(d2, {}, fd(good));
  assert.match(r.error ?? "", /already approved/);
  await db.collection("month_approvals").deleteOne({ _id: `${pat!._id}:${d2.slice(0, 7)}` as any });

  // A day they started but never ended: they add the end time later; the recorded start stays.
  const d5 = sheet.addDays(today, -5);
  const started = new Date();
  await db.collection("entries").insertOne({
    _id: `${pat!._id}:${d5}`, studentId: pat!._id, date: d5, status: "PRESENT", startAt: started, endAt: null, startTime: "09:10", endTime: null, minutes: null,
    startInkId: null, endInkId: null, startLateBy: 0, endLateBy: null, studentSignature: null, staffSignature: null, note: "", history: [], comments: [], updatedAt: started,
  } as any);
  r = await ST.studentFillPastDayAction(d5, {}, fd({ ...good, endTime: "09:00" }));
  assert.ok(r.fieldErrors?.endTime, "end must be after the recorded start");
  r = await ST.studentFillPastDayAction(d5, {}, fd({ ...good, startTime: "06:00", endTime: "12:10", note: "Forgot to tap end" }));
  assert.ok(r.ok, JSON.stringify(r));
  const e3 = await db.collection("entries").findOne({ _id: `${pat!._id}:${d5}` as any });
  assert.equal(e3!.startTime, "09:10", "the recorded start time is not replaced");
  assert.equal(e3!.endTime, "12:10");
  assert.equal(e3!.minutes, 180);
  assert.ok(e3!.filledLaterAt instanceof Date);
  assert.ok(e3!.studentSignature?.id);
  assert.equal(e3!.comments[0].text, "Forgot to tap end");
  assert.ok(await db.collection("audit_logs").findOne({ action: "student.finish_past_day", target: `${pat!._id}:${d5}` }));
  r = await ST.studentFillPastDayAction(d5, {}, fd(good));
  assert.match(r.message ?? "", /already filled in/);

  // The days still open to fill in, for the reminder on the student's sheet.
  const data = await import("../../src/lib/data");
  const policy = await import("../../src/lib/policy");
  const missed: string[] = await data.missedDays(pat as any, policy.firstOpenDate());
  assert.ok(missed.includes(d2) && !missed.includes(d4) && !missed.includes(d1) && !missed.includes(d5) && !missed.includes(today));
  // No time limit: a day well outside the teachers' 7-day window can still be filled in.
  const d20 = sheet.addDays(today, -20);
  r = await ST.studentFillPastDayAction(d20, {}, fd({ ...good, note: "Was away, catching up" }));
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok((await db.collection("entries").findOne({ _id: `${pat!._id}:${d20}` as any }))!.filledLaterAt instanceof Date);

  const todo = await data.daysToFill(pat as any);
  const todoDates = todo.map((d: any) => d.row.date);
  assert.ok(todoDates.every((d: string) => d < today), "only past days");
  assert.ok(todoDates.includes(d2) && !todoDates.includes(d4) && !todoDates.includes(d1) && !todoDates.includes(d5) && !todoDates.includes(d20), "only days that still need something");
  assert.ok(todoDates.includes(sheet.addDays(today, -30)), "older days are listed too, with no time limit");
  assert.deepEqual(todoDates, [...todoDates].sort().reverse(), "newest first");
  assert.ok(todo.every((d: any) => !d.row.entry || d.row.entry.history.length === 0), "no history sent to the student");

  // The teacher sees it flagged until they sign it.
  const T = await import("../../src/lib/teacher");
  const staffDoc = (await db.collection("staff").findOne({ _id: ids.teacher as any })) as any;
  const row = async () => (await T.reviewMonth(staffDoc, d4.slice(0, 7), "Office")).find((x: any) => x.id === pat!._id);
  assert.equal((await row())!.filledLater, 1);
  await asStaff(ids.teacher);
  const sign = new FormData(); sign.set("rows", JSON.stringify([`${pat!._id}:${d4}`]));
  assert.ok((await S.signRowsAction({}, sign)).ok);
  assert.equal((await row())!.filledLater, 0);
});

// ---------------------------------------------------------------- Staff notes on a student

test("admins and the student's teachers add dated notes; only the author or an admin deletes them", async () => {
  const N = await import("../../src/actions/notes");
  const L = await import("../../src/lib/notes");
  const patId = String((await studentByName("Pat Past"))!._id);
  const lukaszId = String((await studentByName("Łukasz Nowak"))!._id);

  await asStaff(ids.teacher);
  let r = await N.addStudentNoteAction(patId, {}, fd({ date: "", text: "  " }));
  assert.ok(r.fieldErrors?.text, "an empty note is refused");
  r = await N.addStudentNoteAction(patId, {}, fd({ date: "not-a-date", text: "x" }));
  assert.ok(r.fieldErrors?.date);
  r = await N.addStudentNoteAction(lukaszId, {}, fd({ date: today, text: "Not my course" }));
  assert.match(r.error ?? "", /not found/, "a teacher can't add notes to students outside their courses");
  r = await N.addStudentNoteAction(patId, {}, fd({ date: "", text: "Called about missed days." }));
  assert.ok(r.ok, JSON.stringify(r));
  const teacherNote = await db.collection("student_notes").findOne({ studentId: patId, byId: ids.teacher });
  assert.equal(teacherNote!.date, today, "the date defaults to today");
  assert.equal(teacherNote!.byRole, "TEACHER");

  await asStaff(ids.admin);
  r = await N.addStudentNoteAction(patId, {}, fd({ date: d3, text: "Out for a medical appointment." }));
  assert.ok(r.ok, JSON.stringify(r));
  const notes = await L.loadStudentNotes(patId);
  assert.deepEqual(notes.map((n: any) => n.date), [today, d3], "newest day first");
  const adminNote = notes.find((n: any) => n.byId === ids.admin)!;

  await asStaff(ids.teacher);
  r = await N.deleteStudentNoteAction(adminNote._id, {}, fd({}));
  assert.match(r.error ?? "", /own notes/, "a teacher can't delete someone else's note");
  r = await N.deleteStudentNoteAction(String(teacherNote!._id), {}, fd({}));
  assert.ok(r.ok);

  await asStaff(ids.admin);
  r = await N.deleteStudentNoteAction(adminNote._id, {}, fd({}));
  assert.ok(r.ok);
  assert.equal(await db.collection("student_notes").countDocuments({ studentId: patId }), 0);
  assert.ok(await db.collection("audit_logs").findOne({ action: "staff.delete_student_note", "meta.text": "Out for a medical appointment." }), "the deleted text is kept in the audit log");
});

// ---------------------------------------------------------------- Handwritten signatures, roles

test("signatures on file are always handwritten, even if a client claims a photo upload", async () => {
  await asStaff(ids.teacher);
  let r = await S.saveMySignatureAction({}, fd({ signature: SIG, source: "UPLOAD" }));
  assert.ok(r.ok, JSON.stringify(r));
  const t = await db.collection("staff").findOne({ _id: ids.teacher as any });
  assert.equal((await db.collection("signatures").findOne({ _id: t!.signatureId }))!.source, "DRAWN");
  const kevin = await studentByName("Kevin Reid");
  await asStaff(ids.admin);
  r = await A.setStudentSignatureAction(kevin!._id, {}, fd({ signature: SIG, source: "UPLOAD" }));
  assert.ok(r.ok, JSON.stringify(r));
  const k = await db.collection("students").findOne({ _id: kevin!._id });
  assert.equal((await db.collection("signatures").findOne({ _id: k!.signatureId }))!.source, "DRAWN");
  await db.collection("staff").updateOne({ _id: ids.teacher as any }, { $set: { signatureId: sigIds.teacher } });
});

test("an admin can make an account an admin or a teacher, but not change their own", async () => {
  await asStaff(ids.admin);
  let r = await A.createStaffAction({}, fd({ name: "Sam Switch", email: "sam@x.test", position: "", role: "TEACHER", password: "password-123456" }));
  assert.ok(r.ok, JSON.stringify(r));
  const sam = await db.collection("staff").findOne({ email: "sam@x.test" });
  r = await A.setStaffRoleAction(sam!._id, {}, fd({ role: "ADMIN" }));
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal((await db.collection("staff").findOne({ _id: sam!._id }))!.role, "ADMIN");
  assert.ok(await db.collection("audit_logs").findOne({ action: "admin.set_role", target: sam!._id }));
  assert.match((await A.setStaffRoleAction(ids.admin, {}, fd({ role: "TEACHER" }))).error ?? "", /your own role/);
  await asStaff(ids.teacher);
  assert.equal(await redirected(A.setStaffRoleAction(ids.teacher, {}, fd({ role: "ADMIN" }))), "/teacher");
  assert.equal((await db.collection("staff").findOne({ _id: ids.teacher as any }))!.role, "TEACHER");
});

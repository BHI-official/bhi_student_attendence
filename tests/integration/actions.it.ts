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
    { _id: ids.mahek, name: "Mahek", email: "mahek@x.test", position: "Asst. Director", role: "TEACHER", courses: ["Office"], passwordHash: hash, signatureId: sigIds.mahek, active: true, createdAt: now },
  ] as any[]);
  await db.collection("signatures").insertMany([
    { _id: sigIds.mahek, ownerType: "STAFF", ownerId: ids.mahek, png: SIG, source: "UPLOAD", createdAt: now, createdBy: ids.mahek },
    { _id: sigIds.teacher, ownerType: "STAFF", ownerId: ids.teacher, png: SIG, source: "UPLOAD", createdAt: now, createdBy: ids.teacher },
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
  assert.equal(await redirected(A.resetPinAction(kevin!._id, {}, fd({}))), "/staff");

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
  let r = await ST.studentFillAction({}, fd({ time: nowTime }));
  assert.match(r.error ?? "", /Sign in the box/);
  r = await ST.studentFillAction({}, fd({ time: nowTime, signature: "data:image/png;base64,AAAA" }));
  assert.ok(r.error);
  r = await ST.studentFillAction({}, fd({ time: nowTime, signature: SIG }));
  assert.ok(r.ok, JSON.stringify(r));
  const e = await db.collection("entries").findOne({ _id: `${kevin!._id}:${today}` as any });
  assert.equal(e!.endTime, nowTime);
  const sig = await db.collection("signatures").findOne({ _id: e!.studentSignature.id });
  assert.equal(sig!.source, "DRAWN");
  assert.equal(sig!.ownerId, kevin!._id);
  assert.equal((await studentByName("Kevin Reid"))!.signatureId, sig!._id, "first handwritten signature is kept on file");
  // Filling again doesn't write twice.
  r = await ST.studentFillAction({}, fd({ time: nowTime, signature: SIG }));
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

test("teachers can't change rows older than 7 days; admins can, with a reason that is recorded", async () => {
  const maria = await studentByName("Maria Lopez");
  await asStaff(ids.teacher);
  let r = await S.editRowAction(maria!._id, d10, {}, fd({ status: "PRESENT", startTime: "09:00", endTime: "14:00", reason: "fix" }));
  assert.match(r.error ?? "", /locked/);
  r = await S.editRowAction(maria!._id, d3, {}, fd({ status: "PRESENT", startTime: "09:00", endTime: "14:00", reason: "left early" }));
  assert.ok(r.ok, JSON.stringify(r));
  const s = new FormData(); s.set("rows", JSON.stringify([`${maria!._id}:${d10}`]));
  r = await S.signRowsAction({}, s);
  assert.match(r.error ?? "", /locked/);
  r = await S.markAbsentAction(d10, {}, fd({ students: JSON.stringify([maria!._id]) }));
  assert.match(r.error ?? "", /locked/);
  r = await S.addCommentAction(`${maria!._id}:${d10}`, {}, fd({ text: "late note" }));
  assert.match(r.error ?? "", /locked/);

  await asStaff(ids.admin);
  r = await S.editRowAction(maria!._id, d10, {}, fd({ status: "PRESENT", startTime: "09:00", endTime: "14:00", reason: "" }));
  assert.match(r.fieldErrors?.reason ?? "", /locked/);
  r = await S.editRowAction(maria!._id, d10, {}, fd({ status: "PRESENT", startTime: "09:00", endTime: "14:00", reason: "Paper sheet shows 2 pm" }));
  assert.ok(r.ok, JSON.stringify(r));
  const log = await db.collection("audit_logs").findOne({ action: "admin.edit_locked_row", target: `${maria!._id}:${d10}` });
  assert.equal(log!.meta.reason, "Paper sheet shows 2 pm");
  r = await S.addCommentAction(`${maria!._id}:${d10}`, {}, fd({ text: "Checked against paper" }));
  assert.ok(r.ok);
});

test("historical signatures are kept: nobody swaps a signature on a locked row, and nobody replaces Mahek's", async () => {
  const kevin = await studentByName("Kevin Reid");
  const mahekSig = { id: sigIds.mahek, at: new Date(), staffId: ids.mahek, staffName: "Mahek" };
  const base = { studentId: kevin!._id, status: "PRESENT", startAt: null, endAt: null, startTime: "09:00", endTime: "15:00", minutes: 360, studentSignature: null, staffSignature: mahekSig, note: "", history: [], comments: [], updatedAt: new Date() };
  await db.collection("entries").insertMany([{ _id: `${kevin!._id}:${d10}`, date: d10, ...base }, { _id: `${kevin!._id}:${d3}`, date: d3, ...base }] as any[]);

  for (const who of [ids.teacher, ids.admin]) {
    await asStaff(who);
    const r = await S.replaceRowSignatureAction(`${kevin!._id}:${d10}`, "staff");
    assert.match(r.error ?? "", /locked/);
  }
  await asStaff(ids.teacher);
  let r = await S.replaceRowSignatureAction(`${kevin!._id}:${d3}`, "staff");
  assert.match(r.error ?? "", /signed by Mahek/);
  // Signing again (bulk) leaves rows already signed by someone else alone.
  const s = new FormData(); s.set("rows", JSON.stringify([`${kevin!._id}:${d3}`]));
  await S.signRowsAction({}, s);
  const rows = await db.collection("entries").find({ _id: { $in: [`${kevin!._id}:${d10}`, `${kevin!._id}:${d3}`] } as any }).toArray();
  assert.ok(rows.every((x) => x.staffSignature.id === sigIds.mahek && x.staffSignature.staffName === "Mahek"));
  // Mahek can update her own signature on an open row; the old image stays stored.
  const newMahek = randomUUID();
  await db.collection("signatures").insertOne({ _id: newMahek, ownerType: "STAFF", ownerId: ids.mahek, png: SIG, source: "DRAWN", createdAt: new Date(), createdBy: ids.mahek } as any);
  await db.collection("staff").updateOne({ _id: ids.mahek as any }, { $set: { signatureId: newMahek } });
  await asStaff(ids.mahek);
  r = await S.replaceRowSignatureAction(`${kevin!._id}:${d3}`, "staff");
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(await db.collection("signatures").findOne({ _id: sigIds.mahek as any }), "old signature image is never deleted");
  assert.equal((await db.collection("entries").findOne({ _id: `${kevin!._id}:${d10}` as any }))!.staffSignature.id, sigIds.mahek);
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

test("month approvals: someone else's approval (e.g. Mahek's) is only replaced by an admin", async () => {
  const kevin = await studentByName("Kevin Reid");
  await db.collection("entries").insertOne({ _id: `${kevin!._id}:${lastMonth}-15`, studentId: kevin!._id, date: `${lastMonth}-15`, status: "ABSENT", startAt: null, endAt: null, startTime: null, endTime: null, minutes: null, studentSignature: null, staffSignature: null, note: "", history: [], comments: [], updatedAt: new Date() } as any);
  await asStaff(ids.mahek);
  let r = await S.approveMonthAction(kevin!._id, lastMonth, {}, fd({ comments: "Good month", commentsInk: NOTE }));
  assert.ok(r.ok, JSON.stringify(r));
  const a = await db.collection("month_approvals").findOne({ _id: `${kevin!._id}:${lastMonth}` as any });
  assert.ok(a!.commentsInkId);
  await asStaff(ids.teacher);
  r = await S.approveMonthAction(kevin!._id, lastMonth, {}, fd({ comments: "mine" }));
  assert.match(r.error ?? "", /approved by Mahek/);
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

test("a class day off: teachers mark their own classes with a note; a student can't start on it", async () => {
  const lukasz = await studentByName("Łukasz Nowak");
  await asStaff(ids.teacher);
  let r = await S.markCourseDayAction({}, fd({ date: today, course: "Night", status: "HOLIDAY", note: "Room flooded" }));
  assert.match(r.error ?? "", /isn't one of yours/);
  r = await S.markCourseDayAction({}, fd({ date: d10, course: "Office", status: "HOLIDAY", note: "x" + "y" }));
  assert.match(r.error ?? "", /locked/);
  r = await S.markCourseDayAction({}, fd({ date: sheet.addDays(today, 3), course: "Office", status: "HOLIDAY", note: "" }));
  assert.ok(r.fieldErrors?.note);
  r = await S.markCourseDayAction({}, fd({ date: sheet.addDays(today, 3), course: "Office", status: "HOLIDAY", note: "Instructor training" }));
  assert.ok(r.ok, JSON.stringify(r));
  const n = await db.collection("entries").countDocuments({ date: sheet.addDays(today, 3), status: "HOLIDAY", note: "Instructor training" });
  assert.ok(n >= 40, `marked ${n}`);
  r = await S.markCourseDayAction({}, fd({ date: sheet.addDays(today, 3), course: "Office", status: "REMOVE", note: "" }));
  assert.ok(r.ok);
  assert.equal(await db.collection("entries").countDocuments({ date: sheet.addDays(today, 3) }), 0);

  await asStaff(ids.admin);
  r = await S.markCourseDayAction({}, fd({ date: today, course: "Night", status: "HOLIDAY", note: "Room flooded" }));
  assert.ok(r.ok, JSON.stringify(r));
  await asStudent(lukasz!._id);
  r = await ST.studentStartAction({}, fd({ time: sheet.clockIn("America/New_York", new Date(), "end") }));
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
  const e = await S.editRowAction(lukasz!._id, today, {}, fd({ status: "ABSENT", reason: "x" }));
  assert.match(e.error ?? "", /isn't in your courses/);
  assert.equal(await redirected(A.saveStudentProfileAction(lukasz!._id, {}, fd({ phone: "1" }))), "/staff");
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

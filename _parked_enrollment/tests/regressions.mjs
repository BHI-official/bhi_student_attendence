// Regression tests for the loopholes found in the October 2026 audit. Each check fails if the hole reopens.
// Run against a running server, same setup as tests/e2e.mjs:
// BASE=http://localhost:3100 LOG=/tmp/dev.log ADMIN_EMAIL=... ADMIN_PASSWORD=... INTEGRATION_API_KEY=... node tests/regressions.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pdfContains } from "./pdf-text.mjs";
import { MongoClient } from "mongodb";

const mongo = await MongoClient.connect(process.env.MONGODB_URI);
const mdb = mongo.db(process.env.MONGODB_DB || undefined);

const require = createRequire(import.meta.url);
const { encodeReply } = require("next/dist/compiled/react-server-dom-webpack/client.node");

const BASE = process.env.BASE ?? "http://localhost:3100";
const LOG = process.env.LOG ?? "/tmp/dev.log";
const run = Date.now().toString(36);
let passed = 0;
const ok = (msg) => { passed++; console.log(`  ✓ ${msg}`); };

/** The dev server restarts itself when it nears its memory limit; wait for it and retry once. */
async function retrying(fn) {
  try {
    return await fn();
  } catch (e) {
    if (!/terminated|ECONNRESET|ECONNREFUSED|fetch failed|other side closed/.test(String(e?.cause ?? e) + String(e))) throw e;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      if (await fetch(BASE + "/login").then((r) => r.ok, () => false)) break;
    }
    return fn();
  }
}

class Client {
  cookies = new Map();
  cookieHeader() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "); }
  store(res) {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const [k, v] = pair.split("=");
      if (/expires=Thu, 01 Jan 1970/i.test(c) || v === "") this.cookies.delete(k); else this.cookies.set(k, v);
    }
  }
  async get(path) {
    const res = await retrying(() => fetch(BASE + path, { redirect: "manual", headers: { cookie: this.cookieHeader() } }));
    this.store(res);
    // React separates adjacent text with <!-- --> in HTML; drop it so text checks see what users see.
    const text = res.headers.get("content-type")?.includes("pdf") ? "" : (await res.text()).replaceAll("<!-- -->", "");
    return { status: res.status, location: res.headers.get("location"), text, res };
  }
  async bytes(path) {
    const res = await retrying(() => fetch(BASE + path, { redirect: "manual", headers: { cookie: this.cookieHeader() } }));
    return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), type: res.headers.get("content-type") };
  }
  async action(page, name, args) {
    await this.get(page); // compiles the page in dev so the action id is in the manifest
    const id = actionId(name);
    const send = async () => fetch(BASE + page, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: this.cookieHeader(), "Next-Action": id, Accept: "text/x-component", Origin: BASE },
      body: await encodeReply(args),
    });
    const res = await retrying(send);
    this.store(res);
    const text = await retrying(() => res.text()).catch(async () => (await send()).text());
    const redirect = res.headers.get("x-action-redirect")?.split(";")[0] ?? null;
    return { status: res.status, redirect, text };
  }
}

function actionId(name) {
  const m = JSON.parse(fs.readFileSync(".next/server/server-reference-manifest.json", "utf8"));
  for (const [id, entry] of Object.entries(m.node)) {
    if (entry.exportedName === name) return id;
    // Dev builds encode names in the loader query instead.
    for (const w of Object.values(entry.workers)) {
      const q = decodeURIComponent(String(w.moduleId).split("actions=")[1]?.split("&")[0] ?? "[]");
      try {
        for (const [, list] of JSON.parse(q)) if (list.some((a) => a.id === id && a.exportedName === name)) return id;
      } catch { /* not a dev entry */ }
    }
  }
  throw new Error(`Action ${name} not found in manifest`);
}

function latestOtp(email) {
  const log = fs.readFileSync(LOG, "utf8");
  const blocks = log.split("[email:dev]").filter((b) => b.includes(`To: ${email}`));
  const m = blocks.at(-1)?.match(/Code: (\d{6})/);
  if (!m) throw new Error(`No OTP for ${email}`);
  return m[1];
}

function latestInvite(email) {
  const log = fs.readFileSync(LOG, "utf8");
  const blocks = log.split("[email:dev]").filter((b) => b.includes(`To: ${email}`));
  const m = blocks.at(-1)?.match(/\/invite\/([A-Za-z0-9_-]{43})/);
  if (!m) throw new Error(`No invite for ${email}`);
  return m[1];
}

/** Admin adds an instructor; the instructor opens the emailed link and sets a password. Returns where they land. */
async function inviteInstructor(adminClient, c, name, email) {
  const r = await adminClient.action("/admin/instructors", "createInstructorAction", [{}, fd({ name, email })]);
  assert.match(r.text, /invitation to set a password was emailed/, r.text.slice(0, 300));
  const token = latestInvite(email);
  const done = await c.action(`/invite/${token}`, "acceptInviteAction", [token, {}, fd({ password: PW, confirm: PW })]);
  assert.ok(done.redirect, `accept invite ${email}: ${done.text.slice(0, 200)}`);
  return { redirect: done.redirect, token };
}

const fd = (obj) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) v.forEach((x) => f.append(k, x)); else f.set(k, v);
  }
  return f;
};

const SIG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000009 00000 n \n0000000052 00000 n \n0000000101 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n164\n%%EOF");
const PW = "Str0ngPassw0rd!";

// Answers for the October 2026 packet (Common Forms + Private or Non-Private Forms).
const answers = {
  student_data: { legalName: "Ana Rivera", dateOfBirth: "1995-04-02", phone: "201-555-0100", street: "1 Main St", city: "Jersey City", state: "NJ", zip: "07302" },
  educational_background: { highestEducation: "High school diploma / GED", lastSchool: "" },
  background_check: { acknowledged: "on" },
  emergency_medical: { contactName: "Luis Rivera", relationship: "Brother", contactPhone: "201-555-0101", acknowledged: "on" },
  workforce_registration: { acknowledged: "on" },
  grievance_policy: { acknowledged: "on" },
  laptop_receipt: { acknowledged: "on" },
  photo_release: { photoRelease: "I give permission" },
  nonprivate_agreement: { acknowledged: "on" },
  private_agreement_1: { acknowledged: "on" },
  private_agreement_2: { acknowledged: "on" },
  refund_schedule: { acknowledged: "on" },
};
const SIGNED = new Set(Object.keys(answers).filter((k) => k !== "student_data" && k !== "educational_background"));
const COMMON_KEYS = ["student_data", "educational_background", "background_check", "emergency_medical", "workforce_registration", "grievance_policy", "laptop_receipt", "photo_release"];

async function registerAndVerify(c, kind, name, email) {
  const r = await c.action(kind === "student" ? "/register" : "/register/instructor", "registerAction",
    [{}, fd({ kind, name, email, password: PW, confirm: PW })]);
  assert.equal(r.redirect, "/verify", `register ${email}: ${r.text.slice(0, 300)}`);
  const bad = await c.action("/verify", "verifyEmailAction", [{}, fd({ code: latestOtp(email) === "000000" ? "111111" : "000000" })]);
  assert.match(bad.text, /isn't right/);
  const good = await c.action("/verify", "verifyEmailAction", [{}, fd({ code: latestOtp(email) })]);
  assert.ok(good.redirect, `verify ${email}: ${good.text.slice(0, 200)}`);
  return good.redirect;
}

async function completeEnrollment(c, keys) {
  for (const key of keys) {
    const data = { ...answers[key], intent: "complete" };
    if (SIGNED.has(key)) Object.assign(data, { signature: SIG, signerName: "Ana Rivera" });
    const r = await c.action(`/enroll/forms/${key}`, "saveFormAction", [key, {}, fd(data)]);
    assert.ok(r.redirect?.startsWith("/enroll/"), `save ${key}: ${r.text.slice(0, 400)}`);
  }
}

async function upload(c, type, buf, name, mime) {
  return c.action("/enroll/documents", "uploadDocumentAction", [{}, fd({ type, file: new File([buf], name, { type: mime }) })]);
}

await mdb.collection("rate_limits").deleteMany({});
const FUNDED_KEYS = [...COMMON_KEYS, "nonprivate_agreement"];
const PRIVATE_KEYS = [...COMMON_KEYS, "private_agreement_1", "private_agreement_2", "refund_schedule"];
const SELECTION = {
  EQISS: { enrollmentType: "NON_PRIVATE", fundingProgram: "EQISS", county: "HUDSON" },
  DFS: { enrollmentType: "NON_PRIVATE", fundingProgram: "DFS" },
  PRIVATE: { enrollmentType: "PRIVATE" },
};
let regCourse; // a course open to every program, created after the admin signs in
async function login(email, pw) { const c = new Client(); const r = await c.action("/login", "loginAction", [{}, fd({ email, password: pw })]); return { c, r }; }
const userBy = (email) => mdb.collection("users").findOne({ email });
const appOf = async (email) => mdb.collection("applications").findOne({ studentId: (await userBy(email))._id });
async function submitted(name, email, keys = FUNDED_KEYS, cat = "EQISS") {
  const c = new Client();
  await registerAndVerify(c, "student", name, email);
  await c.action("/enroll", "setCategoryAction", [{}, fd(SELECTION[cat])]);
  await c.action("/enroll/course", "setCourseAction", [{}, fd({ courseId: regCourse })]);
  if (cat === "PRIVATE") {
    // Private tuition must be verified by the office before the forms open (PRIVATE_PAYMENT_GATE=BEFORE_FORMS).
    const id = (await appOf(email))._id;
    await admin.action(`/admin/applications/${id}`, "setPaymentStatusAction", [id, {}, fd({ paymentStatus: "PAID" })]);
  }
  await completeEnrollment(c, keys);
  await upload(c, "RESUME", PDF, "resume.pdf", "application/pdf");
  await upload(c, "PHOTO_ID", PDF, "id.pdf", "application/pdf");
  const s = await c.action("/enroll/review", "submitApplicationAction", [{}, fd({ confirm: "on" })]);
  assert.equal(s.redirect, "/application", s.text.slice(0, 300));
  return c;
}
async function approved(name, email, keys, cat) {
  const c = await submitted(name, email, keys, cat);
  const id = (await appOf(email))._id;
  const res = await admin.action(`/admin/applications/${id}`, "approveApplicationAction", [id, {}]);
  assert.match(res.text, /Approved and enrolled/, res.text.slice(0, 300));
  // Approval now places the student in a section of their course automatically. These regression checks
  // were written for "approved, not yet in a class", so that automatic placement is undone here (test setup only).
  const sid = (await userBy(email))._id;
  await mdb.collection("enrollments").deleteMany({ studentId: sid, assignedById: (await userBy(process.env.ADMIN_EMAIL))._id, classId: { $in: (await mdb.collection("classes").find({ courseId: regCourse }).toArray()).map((k) => k._id) } });
  return { c, id: sid };
}
const r = Date.now().toString(36);
const TZ = process.env.APP_TIMEZONE || "America/New_York";
const day = (n) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + n * 864e5));
const { c: admin } = await login(process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD);
regCourse = (await admin.action("/admin/courses", "saveCourseAction", [null, {}, fd({ name: `Regression course ${r}`, description: "" })])).redirect.split("/").pop();

console.log("Accounts");
{
  const a = await new Client().action("/register", "registerAction", [{}, fd({ kind: "student", name: "Dup One", email: `dupe${r}@gmail.com`, password: PW, confirm: PW })]);
  assert.equal(a.redirect, "/verify");
  for (const alias of [`d.u.p.e${r}@gmail.com`, `dupe${r}+2@gmail.com`, `DUPE${r}@googlemail.com`]) {
    const b = await new Client().action("/register", "registerAction", [{}, fd({ kind: "student", name: "Dup Two", email: alias, password: PW, confirm: PW })]);
    assert.match(b.text, /already exists/, alias);
  }
  ok("P1 Gmail aliases (dots, +tags, googlemail.com) can't create a second account");
}

console.log("Corrections");
await mdb.collection("rate_limits").deleteMany({}); // the app allows 10 sign-ups/hour per network; this suite makes more
{
  const email = `cat${r}@gmail.com`;
  const c = await submitted("Cat Switch", email);
  const id = (await appOf(email))._id;
  await admin.action(`/admin/applications/${id}`, "requestCorrectionsAction", [id, {}, fd({ sections: ["category"], note: "Please re-check your category" })]);
  await c.action("/enroll", "setCategoryAction", [{}, fd({ enrollmentType: "PRIVATE" })]);
  await admin.action(`/admin/applications/${id}`, "setPaymentStatusAction", [id, {}, fd({ paymentStatus: "PAID" })]);
  for (const key of ["private_agreement_1", "private_agreement_2", "refund_schedule"]) {
    const s = await c.action(`/enroll/forms/${key}`, "saveFormAction", [key, {}, fd({ ...answers[key], intent: "complete", signature: SIG, signerName: "Cat Switch" })]);
    assert.ok(s.redirect, `${key}: ${s.text.slice(0, 200)}`);
  }
  const sub = await c.action("/enroll/review", "submitApplicationAction", [{}, fd({ confirm: "on" })]);
  assert.equal(sub.redirect, "/application", sub.text.slice(0, 300));
  const app = await appOf(email);
  assert.equal(app.status, "RESUBMITTED"); assert.equal(app.category, "PRIVATE");
  ok("P2 switching category during corrections unlocks the new forms and the student can resubmit");
  // Only the switched-in forms were unlocked, not unrelated common sections.
  const unlocked = app.corrections.at(-1).sections;
  assert.ok(!unlocked.includes("student_data") && unlocked.includes("refund_schedule"), JSON.stringify(unlocked));
  ok("P2 unlock is limited to the new category's forms and documents");
}

console.log("Class assignment funding");
await mdb.collection("rate_limits").deleteMany({}); // the app allows 10 sign-ups/hour per network; this suite makes more
let privClass, hudsonId, hudsonEnrollment, instClient, instEmail;
{
  const cr = await admin.action("/admin/courses", "saveCourseAction", [null, {}, fd({ name: `Course ${r}`, description: "", fundingPrograms: ["PRIVATE"] })]);
  const courseId = cr.redirect.split("/").pop();
  const kr = await admin.action(`/admin/courses/${courseId}`, "saveClassAction", [courseId, null, {}, fd({ code: `PRIV-${r}`, cohort: "A", startDate: day(-60), endDate: day(60), schedule: "", location: "", capacity: "10", fundingProgram: "PRIVATE" })]);
  privClass = kr.redirect.split("/").pop();
  ({ id: hudsonId } = await approved("Fund Mismatch", `fund${r}@gmail.com`));
  const blocked = await admin.action("/admin/students", "assignStudentAction", [{}, fd({ studentId: hudsonId, classId: privClass })]);
  assert.match(blocked.text, /Funding mismatch/);
  assert.equal(await mdb.collection("enrollments").countDocuments({ studentId: hudsonId }), 0);
  ok("P3 funded student can't be put in a differently funded class by accident");
  const forced = await admin.action("/admin/students", "assignStudentAction", [{}, fd({ studentId: hudsonId, classId: privClass, fundingMismatch: "on" })]);
  assert.match(forced.text, /Assigned to/);
  const log = await mdb.collection("audit_logs").findOne({ action: "enrollment.assign", entityId: privClass, "meta.studentId": hudsonId });
  assert.equal(log.meta.fundingOverride, true);
  ok("P3 explicit override works and is recorded in the audit log");
  hudsonEnrollment = (await mdb.collection("enrollments").findOne({ studentId: hudsonId, classId: privClass }))._id;
}

console.log("Attendance integrity");
await mdb.collection("rate_limits").deleteMany({}); // the app allows 10 sign-ups/hour per network; this suite makes more
{
  instEmail = `inst${r}@bhi.test`;
  instClient = new Client();
  await inviteInstructor(admin, instClient, "Ina Structor", instEmail);
  const inst = await userBy(instEmail);
  await admin.action(`/admin/classes/${privClass}`, "assignInstructorAction", [privClass, {}, fd({ instructorId: inst._id, role: "LEAD" })]);

  const post = (date, enrollmentId = hudsonEnrollment, by = instEmail) => fetch(`${BASE}/api/integrations/attendance`, {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": process.env.INTEGRATION_API_KEY },
    body: JSON.stringify({ classId: privClass, date, recordedByEmail: by, records: [{ enrollmentId, status: "PRESENT", hours: 4 }] }),
  });
  assert.equal((await post(day(-1))).status, 200);
  assert.equal((await post("2099-01-01")).status, 400);
  assert.equal((await post(day(-90))).status, 400);
  ok("P4 integration refuses future dates and dates outside the class");

  await admin.action(`/admin/students/${hudsonId}`, "endEnrollmentAction", [{}, fd({ enrollmentId: hudsonEnrollment, status: "WITHDRAWN" })]);
  assert.equal((await post(day(0))).status, 200, "same-day mark for a student who left today is allowed");
  await mdb.collection("enrollments").updateOne({ _id: hudsonEnrollment }, { $set: { endedAt: new Date(Date.now() - 10 * 864e5) } });
  const late = await post(day(-1));
  assert.equal(late.status, 400); assert.match(await late.text(), /not enrolled on this date/);
  ok("P4 integration refuses marks for a withdrawn student after the day they left");

  const { c: s } = await login(`fund${r}@gmail.com`, PW);
  const t = (await s.get("/application")).text;
  assert.match(t, /not currently enrolled/); assert.doesNotMatch(t, /assigning you to a class/);
  ok("P5 withdrawn student sees an accurate status, not 'we're assigning you'");

  const { id: sid } = await approved("Att Edit", `att${r}@gmail.com`);
  await admin.action("/admin/students", "assignStudentAction", [{}, fd({ studentId: sid, classId: privClass, fundingMismatch: "on" })]);
  const eid = (await mdb.collection("enrollments").findOne({ studentId: sid, classId: privClass }))._id;
  const d = day(-45);
  await instClient.action(`/instructor/classes/${privClass}/attendance`, "recordAttendanceAction", [privClass, {}, fd({ date: d, [`status_${eid}`]: "ABSENT", [`hours_${eid}`]: "0" })]);
  await instClient.action(`/instructor/classes/${privClass}/attendance`, "recordAttendanceAction", [privClass, {}, fd({ date: d, [`status_${eid}`]: "PRESENT", [`hours_${eid}`]: "6" })]);
  const logs = await mdb.collection("audit_logs").find({ action: "attendance.record", entityId: privClass, "meta.date": d }).sort({ createdAt: 1 }).toArray();
  const change = logs.at(-1).meta.changes.find((x) => x.enrollmentId === eid);
  assert.equal(change.from.status, "ABSENT"); assert.equal(change.to.status, "PRESENT"); assert.equal(change.to.hours, 6);
  ok("P6 changing past attendance records the old and new values in the audit log");

  const bad = await post(day(-1), eid, `nobody${r}@bhi.test`);
  assert.equal(bad.status, 400);
  await admin.action(`/admin/instructors/${(await userBy(instEmail))._id}`, "setAccountDisabledAction", [(await userBy(instEmail))._id, {}, fd({ disable: "true" })]);
  assert.equal((await post(day(-1), eid)).status, 400);
  ok("P4 integration refuses unknown and disabled recorders");
  await admin.action(`/admin/instructors/${(await userBy(instEmail))._id}`, "setAccountDisabledAction", [(await userBy(instEmail))._id, {}, fd({ disable: "false" })]);
}

console.log("Admin controls");
await mdb.collection("rate_limits").deleteMany({}); // the app allows 10 sign-ups/hour per network; this suite makes more
{
  const email = `rej${r}@gmail.com`;
  await submitted("Rej Ected", email);
  const id = (await appOf(email))._id;
  await admin.action(`/admin/applications/${id}`, "rejectApplicationAction", [id, {}, fd({ reason: "Clicked by mistake" })]);
  assert.equal((await appOf(email)).status, "REJECTED");
  const re = await admin.action(`/admin/applications/${id}`, "reopenApplicationAction", [id, {}]);
  assert.match(re.text, /reopened/);
  const after = await appOf(email);
  assert.equal(after.status, "SUBMITTED"); assert.equal(after.rejectionReason, null);
  const log = await mdb.collection("audit_logs").findOne({ action: "application.reopen", entityId: id });
  assert.equal(log.meta.previousReason, "Clicked by mistake");
  ok("P7 a mistaken rejection can be reopened; the old reason is kept in the audit log");
  const again = await admin.action(`/admin/applications/${id}`, "reopenApplicationAction", [id, {}]);
  assert.match(again.text, /Only rejected/);
  ok("P7 reopen only works on rejected applications");

  const sEmail = `dis${r}@gmail.com`;
  const victim = new Client();
  await registerAndVerify(victim, "student", "Dis Abled", sEmail);
  assert.equal((await victim.get("/enroll")).status, 200);
  const uid = (await userBy(sEmail))._id;
  await admin.action(`/admin/students/${uid}`, "setAccountDisabledAction", [uid, {}, fd({ disable: "true" })]);
  assert.equal((await victim.get("/enroll")).location, "/login");
  assert.match((await login(sEmail, PW)).r.text, /incorrect/);
  ok("P8 disabling an account signs it out everywhere and blocks sign-in");
  const self = await admin.action("/admin", "setAccountDisabledAction", [(await userBy(process.env.ADMIN_EMAIL))._id, {}, fd({ disable: "true" })]);
  assert.match(self.text, /own account/);
  ok("P8 an admin can't disable their own account");
  await admin.action(`/admin/students/${uid}`, "setAccountDisabledAction", [uid, {}, fd({ disable: "false" })]);
  assert.ok((await login(sEmail, PW)).r.redirect);
  ok("P8 re-enabling restores sign-in");

  const pEmail = `pay${r}@gmail.com`;
  await submitted("Pay Ing", pEmail, PRIVATE_KEYS, "PRIVATE");
  const pid = (await appOf(pEmail))._id;
  await admin.action(`/admin/applications/${pid}`, "setPaymentStatusAction", [pid, {}, fd({ paymentStatus: "PENDING" })]);
  assert.equal((await appOf(pEmail)).paymentStatus, "PENDING");
  const paid = await admin.action(`/admin/applications/${pid}`, "setPaymentStatusAction", [pid, {}, fd({ paymentStatus: "PAID" })]);
  assert.match(paid.text, /marked paid/); assert.equal((await appOf(pEmail)).paymentStatus, "PAID");
  ok("P9 admin can mark a private student's tuition paid");
  const fid = (await appOf(`fund${r}@gmail.com`))._id;
  const f = await admin.action(`/admin/applications/${fid}`, "setPaymentStatusAction", [fid, {}, fd({ paymentStatus: "PAID" })]);
  assert.match(f.text, /private/i); assert.equal((await appOf(`fund${r}@gmail.com`)).paymentStatus, "NOT_REQUIRED");
  ok("P9 a funded student can never be given a payment status");
  const pageText = (await admin.get(`/admin/applications/${fid}`)).text;
  assert.doesNotMatch(pageText, /Tuition payment/);
  ok("P9 funded application page shows no payment card");
}

console.log("Access control on the new actions");
await mdb.collection("rate_limits").deleteMany({}); // the app allows 10 sign-ups/hour per network; this suite makes more
{
  const { c: stu } = await login(`fund${r}@gmail.com`, PW);
  const anyApp = (await appOf(`pay${r}@gmail.com`))._id;
  const tries = [
    stu.action("/application", "setPaymentStatusAction", [anyApp, {}, fd({ paymentStatus: "WAIVED" })]),
    stu.action("/application", "reopenApplicationAction", [anyApp, {}]),
    instClient.action("/instructor", "setAccountDisabledAction", [hudsonId, {}, fd({ disable: "true" })]),
  ];
  await Promise.all(tries);
  assert.equal((await appOf(`pay${r}@gmail.com`)).paymentStatus, "PAID");
  assert.equal((await userBy(`fund${r}@gmail.com`)).disabledAt, null);
  ok("students and instructors can't call the new admin-only actions");
}

console.log("Disabled accounts can't be assigned");
{
  await admin.action(`/admin/students/${hudsonId}`, "setAccountDisabledAction", [hudsonId, {}, fd({ disable: "true" })]);
  const a = await admin.action("/admin/students", "assignStudentAction", [{}, fd({ studentId: hudsonId, classId: privClass, fundingMismatch: "on" })]);
  assert.match(a.text, /disabled/);
  ok("a disabled student can't be assigned to a class");
  await admin.action(`/admin/students/${hudsonId}`, "setAccountDisabledAction", [hudsonId, {}, fd({ disable: "false" })]);

  const iid = (await userBy(instEmail))._id;
  await admin.action(`/admin/instructors/${iid}`, "setAccountDisabledAction", [iid, {}, fd({ disable: "true" })]);
  const b = await admin.action(`/admin/classes/${privClass}`, "assignInstructorAction", [privClass, {}, fd({ instructorId: iid, role: "ASSISTANT" })]);
  assert.match(b.text, /Only approved instructors/);
  assert.doesNotMatch((await admin.get(`/admin/classes/${privClass}`)).text, new RegExp(`<option[^>]*value="${iid}"`));
  ok("a disabled instructor can't be assigned and isn't offered in the picker");
  await admin.action(`/admin/instructors/${iid}`, "setAccountDisabledAction", [iid, {}, fd({ disable: "false" })]);
}

console.log("Instructor invites");
{
  const email = `pend${r}@bhi.test`;
  await admin.action("/admin/instructors", "createInstructorAction", [{}, fd({ name: "Pen Ding", email })]);
  const token = latestInvite(email);
  const uid = (await userBy(email))._id;
  await admin.action(`/admin/instructors/${uid}`, "setAccountDisabledAction", [uid, {}, fd({ disable: "true" })]);
  const t = await new Client().action(`/invite/${token}`, "acceptInviteAction", [token, {}, fd({ password: PW, confirm: PW })]);
  assert.match(t.text, /expired or was already used/);
  ok("a disabled instructor's invite link stops working");
  await admin.action(`/admin/instructors/${uid}`, "setAccountDisabledAction", [uid, {}, fd({ disable: "false" })]);

  await mdb.collection("users").updateOne({ _id: uid }, { $set: { inviteExpiresAt: new Date(Date.now() - 1000) } });
  assert.match((await new Client().action(`/invite/${token}`, "acceptInviteAction", [token, {}, fd({ password: PW, confirm: PW })])).text, /expired/);
  ok("an expired invite link is refused");

  // Forgot-password also activates an invited instructor, and then the invite link is retired.
  await admin.action("/admin/instructors", "resendInviteAction", [uid, {}]);
  const fresh = latestInvite(email);
  const c = new Client();
  await c.action("/forgot-password", "forgotPasswordAction", [{}, fd({ email })]);
  const reset = await c.action("/reset-password", "resetPasswordAction", [{}, fd({ email, code: latestOtp(email), password: PW, confirm: PW })]);
  assert.ok(reset.redirect, reset.text.slice(0, 200));
  assert.match((await new Client().action(`/invite/${fresh}`, "acceptInviteAction", [fresh, {}, fd({ password: PW + "x", confirm: PW + "x" })])).text, /already used/);
  ok("resetting the password retires any open invite link");

  const stu = (await login(`fund${r}@gmail.com`, PW)).c;
  const sneak = await stu.action("/dashboard", "createInstructorAction", [{}, fd({ name: "Me Teacher", email: `me${r}@bhi.test` })]);
  assert.equal(await mdb.collection("users").countDocuments({ email: `me${r}@bhi.test` }), 0, sneak.text.slice(0, 100));
  ok("students can't create instructor accounts");
}

console.log("Instructor assignment");
let instB, instBClient, c2;
{
  await mdb.collection("rate_limits").deleteMany({});
  const courseId = (await mdb.collection("classes").findOne({ _id: privClass })).courseId;
  const mk = async (code, start, end) => (await admin.action(`/admin/courses/${courseId}`, "saveClassAction",
    [courseId, null, {}, fd({ code, cohort: "B", startDate: start, endDate: end, schedule: "Mon 9-1", location: "", capacity: "10", fundingProgram: "PRIVATE" })])).redirect.split("/").pop();
  c2 = await mk(`C2-${r}`, day(-30), day(30));
  const inst = await userBy(instEmail);

  const a = await admin.action(`/admin/instructors/${inst._id}`, "assignClassToInstructorAction", [inst._id, {}, fd({ classId: c2, role: "LEAD" })]);
  assert.match(a.text, /assigned to .* as lead/);
  assert.match(fs.readFileSync(LOG, "utf8"), new RegExp(`New class: .*C2-${r}`));
  ok("admin assigns an instructor to a class from the instructor's page, and the instructor is emailed");

  instBClient = new Client();
  await inviteInstructor(admin, instBClient, "Bea Second", `beasecond${r}@bhi.test`);
  instB = await userBy(`beasecond${r}@bhi.test`);
  const clash = await admin.action(`/admin/classes/${c2}`, "assignInstructorAction", [c2, {}, fd({ instructorId: instB._id, role: "LEAD" })]);
  assert.match(clash.text, /already has a lead instructor/);
  ok("a class can't get a second lead by accident");
  const swap = await admin.action(`/admin/classes/${c2}`, "assignInstructorAction", [c2, {}, fd({ instructorId: instB._id, role: "LEAD", replaceLead: "on" })]);
  assert.match(swap.text, /previous lead is now an assistant/);
  const roles = Object.fromEntries((await mdb.collection("classes").findOne({ _id: c2 })).instructors.map((i) => [i.instructorId, i.role]));
  assert.equal(roles[instB._id], "LEAD"); assert.equal(roles[inst._id], "ASSISTANT");
  ok("replacing the lead makes the old lead an assistant");

  const archived = await mk(`ARC-${r}`, day(-5), day(5));
  await admin.action(`/admin/classes/${archived}`, "archiveClassAction", [archived, {}]);
  assert.match((await admin.action(`/admin/instructors/${instB._id}`, "assignClassToInstructorAction", [instB._id, {}, fd({ classId: archived, role: "ASSISTANT" })])).text, /archived/);
  ok("instructors can't be assigned to archived classes");
  assert.match((await admin.action(`/admin/classes/${privClass}`, "removeInstructorAction", [privClass, {}, fd({ instructorId: instB._id })])).text, /isn't on this class/);
  ok("removing an instructor who isn't on the class is reported, not silently ignored");

  const sneaky = await instBClient.action("/instructor", "assignClassToInstructorAction", [instB._id, {}, fd({ classId: privClass, role: "LEAD" })]);
  assert.ok(!(await mdb.collection("classes").findOne({ _id: privClass })).instructors.some((i) => i.instructorId === instB._id), sneaky.text.slice(0, 80));
  ok("instructors can't assign themselves to classes");
  assert.match((await instBClient.get("/instructor")).text, new RegExp(`C2-${r}`));
  ok("the instructor sees the newly assigned class");
}

console.log("Student check-in");
{
  await mdb.collection("rate_limits").deleteMany({});
  // An earlier section disabled and re-enabled this instructor, which correctly signed them out everywhere.
  const relog = await instClient.action("/login", "loginAction", [{}, fd({ email: instEmail, password: PW })]);
  assert.equal(relog.redirect, "/instructor");
  // Three active students in privClass (the earlier "Att Edit" student plus two more).
  const s1 = (await login(`att${r}@gmail.com`, PW)).c;
  const mkStudent = async (name, email) => {
    const { c, id } = await approved(name, email, PRIVATE_KEYS, "PRIVATE");
    await admin.action("/admin/students", "assignStudentAction", [{}, fd({ studentId: id, classId: privClass })]);
    return { c: (await login(email, PW)).c, eid: (await mdb.collection("enrollments").findOne({ studentId: id, classId: privClass }))._id };
  };
  const st2 = await mkStudent("Sam Two", `samtwo${r}@gmail.com`);
  const st3 = await mkStudent("Tia Three", `tiathree${r}@gmail.com`);
  await mdb.collection("rate_limits").deleteMany({});
  const s1eid = (await mdb.collection("enrollments").findOne({ studentId: (await userBy(`att${r}@gmail.com`))._id, classId: privClass }))._id;
  const checkIn = (c, code) => c.action("/dashboard", "checkInAction", [privClass, {}, fd({ code })]);
  const fill = (c) => c.action("/dashboard", "fillMyAttendanceAction", [privClass, {}]);
  const live = async (c = instClient) => JSON.parse((await c.get(`/api/checkin/${privClass}`)).text);
  const me = async (c) => JSON.parse((await c.get(`/api/checkin/${privClass}/me`)).text);
  const attPage = `/instructor/classes/${privClass}/attendance`;
  const issueCode = (c = instClient, page = attPage) => c.action(page, "startCheckInAction", [privClass, {}]);
  const today = day(0);
  const dayDoc = () => mdb.collection("class_sessions").findOne({ classId: privClass, date: today });
  const ciDoc = () => mdb.collection("attendance_checkins").findOne({ classId: privClass, date: today });
  const backdate = async (eid, minutes) => {
    const at = new Date(Date.now() - minutes * 60000);
    await mdb.collection("attendance_checkins").updateOne({ classId: privClass, date: today }, { $set: { [`entries.${eid}.at`]: at } });
    await mdb.collection("class_sessions").updateOne({ classId: privClass, date: today, [`records.${eid}`]: { $exists: true } }, { $set: { [`records.${eid}.checkInAt`]: at } });
  };
  const sign = (c = instClient, page = attPage) => c.action(page, "signDayAction", [privClass, today, {}, fd({ signature: SIG, signerName: "Instructor Name" })]);

  assert.match((await checkIn(s1, "123456")).text, /no valid code/);
  ok("students can't check in before the instructor issues a code");
  assert.equal((await instBClient.get(`/api/checkin/${privClass}`)).status, 404);
  // Posted from Bea's own class page (which carries the action) but aimed at a class she doesn't teach.
  assert.match((await instBClient.action(`/instructor/classes/${c2}/attendance`, "startCheckInAction", [privClass, {}])).text, /don't have access/);
  assert.equal(await mdb.collection("attendance_checkins").countDocuments({ classId: privClass }), 0);
  assert.equal((await s1.get(`/api/checkin/${privClass}`)).status, 404);
  ok("only the class's own instructors (and admins) can issue a code or see it");

  assert.match((await issueCode()).text, /Code issued\. It works for 10 minutes/);
  let st = await live();
  assert.equal(st.open, true); assert.match(st.code, /^\d{6}$/); assert.equal(st.enrolled, 3);
  const c0 = await ciDoc();
  assert.equal(c0.expiresAt.getTime() - c0.rounds[0].openedAt.getTime(), 10 * 60000);
  const s1me = await me(s1);
  assert.equal(s1me.open, true); assert.equal(s1me.code, undefined);
  ok("one code, valid for exactly 10 minutes; students see check-in is open but never the code");

  const firstCode = st.code;
  assert.match((await issueCode()).text, /still works until/);
  assert.equal((await live()).code, firstCode);
  ok("asking again while the code is valid keeps the same code");

  const wrong = st.code === "000000" ? "111111" : "000000";
  assert.match((await checkIn(s1, wrong)).text, /isn't right/);
  ok("a wrong code is refused");

  assert.match((await checkIn(s1, st.code)).text, /Checked in at .*\(on time\)/);
  assert.match((await checkIn(s1, st.code)).text, /already checked in/);
  let d = await dayDoc();
  assert.equal(d.records[s1eid].source, "CHECKIN"); assert.equal(d.records[s1eid].status, "PRESENT");
  assert.match(d.records[s1eid].startTime, /^\d\d:\d\d$/); assert.equal(d.records[s1eid].hours, 0);
  assert.equal((await me(s1)).canFill, true);
  ok("a student checks in once, and their time in is on the sheet straight away");

  // Sam checks in on Att's phone: same device cookie.
  st2.c.cookies.set("bhi_device", s1.cookies.get("bhi_device"));
  assert.match((await checkIn(st2.c, st.code)).text, /Checked in/);
  st = await live();
  assert.equal(st.entries.length, 2);
  assert.ok(st.rows.filter((r) => r.checkIn).every((r) => /Same phone/.test(r.attention ?? "")));
  ok("two students checking in from one phone are both flagged to the instructor");

  for (let i = 0; i < 10; i++) await checkIn(st3.c, wrong);
  assert.match((await checkIn(st3.c, (await live()).code)).text, /Too many tries/);
  ok("guessing codes is cut off after 10 tries");

  const fund = (await login(`fund${r}@gmail.com`, PW)).c;
  const w = await fund.action("/dashboard", "checkInAction", [privClass, {}, fd({ code: (await live()).code })]);
  // With no active class they can't even reach the dashboard; either way nothing is recorded.
  assert.ok(w.redirect === "/application" || /not enrolled/.test(w.text), w.text.slice(0, 120));
  assert.equal((await ciDoc()).entries[hudsonEnrollment], undefined);
  ok("withdrawn students can't check in");

  // After 10 minutes the code is dead, even typed correctly.
  await mdb.collection("attendance_checkins").updateOne({ classId: privClass, date: today }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  await mdb.collection("rate_limits").deleteMany({});
  assert.match((await checkIn(st3.c, firstCode)).text, /no valid code/);
  st = await live();
  assert.equal(st.open, false); assert.equal(st.code, null);
  ok("after 10 minutes the code stops working and disappears from the instructor's screen");

  // A code for latecomers: the old code is useless, and check-ins with the new one are late.
  await mdb.collection("attendance_checkins").updateOne({ classId: privClass, date: today }, { $set: { openedAt: new Date(Date.now() - 20 * 60000) } });
  assert.match((await issueCode()).text, /New code issued/);
  st = await live();
  if (st.code !== firstCode) assert.match((await checkIn(st3.c, firstCode)).text, /isn't right/);
  assert.match((await checkIn(st3.c, st.code)).text, /\(late\)/);
  assert.equal((await dayDoc()).records[st3.eid].status, "LATE");
  assert.equal((await ciDoc()).rounds.length, 2);
  ok("a new code for latecomers replaces the old one, and its check-ins are late");

  // Saving the correction form unchanged during class must not take over anyone's check-in.
  const notes = (await dayDoc()).records;
  const save = (marks) => instClient.action(attPage, "recordAttendanceAction",
    [privClass, {}, fd({ date: today, ...Object.fromEntries(Object.entries(marks).flatMap(([e, [s, h, n]]) => [[`status_${e}`, s], [`hours_${e}`, String(h)], [`note_${e}`, n ?? notes[e]?.note ?? ""]])) })]);
  assert.match((await save({ [st2.eid]: ["PRESENT", 0], [st3.eid]: ["LATE", 0] })).text, /Nothing changed/);
  assert.equal((await dayDoc()).records[st3.eid].source, "CHECKIN");
  ok("saving the sheet unchanged during class leaves students able to fill out");

  // Filling out right after checking in counts nothing and is refused (check-in moved to "now" so a slow run can't cross a minute).
  await backdate(st3.eid, 0);
  assert.match((await fill(st3.c)).text, /class is over/);
  // Att was in class for 5 minutes, then fills out.
  await backdate(s1eid, 5);
  assert.match((await fill(s1)).text, /Attendance filled/);
  const r1 = (await dayDoc()).records[s1eid];
  assert.equal(r1.source, "STUDENT_FILL"); assert.ok(r1.studentFilledAt); assert.ok(r1.endTime);
  assert.ok(r1.minutes >= 4 && r1.minutes <= 5, String(r1.minutes));
  assert.equal(r1.hours, Math.round((r1.minutes / 60) * 100) / 100);
  assert.match((await fill(s1)).text, /Already filled out/);
  ok("the student fills out the day with one press: exact minutes, no signature, once");

  assert.match((await sign()).text, /Not ready to sign/);
  assert.match((await instClient.get("/instructor")).text, /Attendance waiting for you/);
  assert.match((await admin.get("/admin")).text, /not completed or signed/);
  ok("the day can't be signed while students still have to fill out; instructors and admins are told");
  assert.match((await sign(admin, `/admin/classes/${privClass}`)).text, /Only the class's instructor/);
  ok("admins can't sign for the instructor");

  // Complete the day: Sam and Tia checked in but didn't fill out; their time out is set to now.
  await backdate(st2.eid, 30); await backdate(st3.eid, 20);
  assert.match((await instClient.action(attPage, "completeDayAction", [privClass, today, {}])).text, /2 filled out, \d+ marked absent/);
  d = await dayDoc();
  for (const e of [st2.eid, st3.eid]) { assert.equal(d.records[e].source, "INSTRUCTOR_FILL"); assert.ok(d.records[e].minutes >= 19); }
  assert.equal(d.records[s1eid].source, "STUDENT_FILL");
  ok("completing the day fills out the stragglers and never overwrites a student's own fill-out");

  assert.match((await sign()).text, /signed/);
  st = await live();
  assert.equal(st.signoff.current, true);
  assert.equal((await me(st3.c)).canFill, false);
  assert.match((await issueCode()).text, /already signed/);
  ok("the instructor signs the day once for the whole class; signed days take no new codes");

  assert.match((await save({ [st2.eid]: ["ABSENT", 0, "Left before class started"] })).text, /saved/);
  st = await live();
  assert.equal(st.signoff.current, false);
  assert.match((await sign()).text, /signed/);
  st = await live();
  assert.equal(st.signoff.current, true); assert.equal(st.signoff.history, 1);
  ok("a change after signing shows the signature is out of date until the instructor signs again (history kept)");

  assert.match((await admin.action(`/admin/classes/${privClass}`, "closeCheckInAction", [privClass, {}])).text, /closed/);
  ok("admins can close check-in for any class");

  const future = (await admin.action(`/admin/courses/${(await mdb.collection("classes").findOne({ _id: privClass })).courseId}`, "saveClassAction",
    [(await mdb.collection("classes").findOne({ _id: privClass })).courseId, null, {}, fd({ code: `FUT-${r}`, cohort: "F", startDate: day(10), endDate: day(40), schedule: "", location: "", capacity: "5", fundingProgram: "PRIVATE" })])).redirect.split("/").pop();
  assert.match((await admin.action(`/admin/classes/${future}`, "startCheckInAction", [future, {}])).text, /outside the class dates|no students/);
  ok("a code can't be issued for a class that isn't running today");
}

console.log(`\nAll ${passed} regression checks passed.`);
await mongo.close();

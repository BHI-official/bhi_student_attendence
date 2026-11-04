// End-to-end test of the October 2026 BHI workflows against a running dev server (`npm run dev`) with
// and RESEND_API_KEY empty (OTP codes are read from the server log).
// Usage: BASE=http://localhost:3100 LOG=/tmp/dev.log ADMIN_EMAIL=... ADMIN_PASSWORD=... node tests/e2e.mjs
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

// ---------- Enrollment helpers ----------
const COMMON = {
  student_data: { legalName: "Ana Rivera", dateOfBirth: "1995-04-02", phone: "201-555-0100", street: "1 Main St", city: "Jersey City", state: "NJ", zip: "07302" },
  educational_background: { highestEducation: "High school diploma / GED", lastSchool: "Dickinson HS" },
  background_check: { acknowledged: "on" },
  emergency_medical: { contactName: "Luis Rivera", relationship: "Brother", contactPhone: "201-555-0101", acknowledged: "on" },
  workforce_registration: { acknowledged: "on" },
  grievance_policy: { acknowledged: "on" },
  laptop_receipt: { acknowledged: "on" },
  photo_release: { photoRelease: "I give permission" },
};
const NONPRIVATE = { nonprivate_agreement: { acknowledged: "on" } };
const PRIVATE = { private_agreement_1: { acknowledged: "on" }, private_agreement_2: { acknowledged: "on" }, refund_schedule: { acknowledged: "on" } };
const UNSIGNED = new Set(["student_data", "educational_background"]);

async function registerAndVerify(c, page, action, name, email) {
  const r = await c.action(page, action, [{}, fd({ name, email, password: PW, confirm: PW })]);
  assert.equal(r.redirect, "/verify", `register ${email}: ${r.text.slice(0, 300)}`);
  const good = await c.action("/verify", "verifyEmailAction", [{}, fd({ code: latestOtp(email) })]);
  assert.ok(good.redirect, `verify ${email}: ${good.text.slice(0, 200)}`);
  return good.redirect;
}
async function fillForms(c, forms, signer) {
  for (const [key, data] of Object.entries(forms)) {
    const body = { ...data, intent: "complete" };
    if (!UNSIGNED.has(key)) Object.assign(body, { signature: SIG, signerName: signer });
    const r = await c.action(`/enroll/forms/${key}`, "saveFormAction", [key, {}, fd(body)]);
    assert.ok(r.redirect?.startsWith("/enroll/"), `save ${key}: ${r.text.slice(0, 400)}`);
  }
}
const upload = (c, type, buf, name, mime) => c.action("/enroll/documents", "uploadDocumentAction", [{}, fd({ type, file: new File([buf], name, { type: mime }) })]);
const userId = async (email) => (await mdb.collection("users").findOne({ email }))._id;
const appOf = async (email) => mdb.collection("applications").findOne({ studentId: await userId(email) });
const activeEnrollment = async (email) => mdb.collection("enrollments").findOne({ studentId: await userId(email), status: "ACTIVE" });
const visible = (html) => html.replace(/<script[\s\S]*?<\/script>/g, "");
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());

await mdb.collection("rate_limits").deleteMany({});

// ---------- Admin and courses ----------
console.log("Admin and course list");
const admin = new Client();
{
  const r = await admin.action("/login", "loginAction", [{}, fd({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD })]);
  assert.equal(r.redirect, "/admin", r.text.slice(0, 200)); ok("admin signs in");
}
const course = async (name, programs) => {
  const r = await admin.action("/admin/courses", "saveCourseAction", [null, {}, fd({ name, description: "", fundingPrograms: programs })]);
  assert.ok(r.redirect, r.text.slice(0, 300));
  return r.redirect.split("/").pop();
};
const maCourse = await course(`Medical Assistant ${run}`, []);
const privOnly = await course(`Private Only ${run}`, ["PRIVATE"]);
ok("admin adds courses (one open to all programs, one Private only)");

// ---------- EQISS student ----------
console.log("Non-Private EQISS enrollment");
const ana = new Client();
const anaEmail = `ana.${run}@gmail.com`;
assert.equal(await registerAndVerify(ana, "/register", "registerAction", "Ana Rivera", anaEmail), "/enroll");
ok("student registers and verifies email; lands on enrollment, not the dashboard");
assert.equal((await ana.get("/dashboard")).location, "/enroll"); ok("no dashboard before approval");
{
  let r = await ana.action("/enroll", "setCategoryAction", [{}, fd({ enrollmentType: "NON_PRIVATE" })]);
  assert.match(r.text, /EQISS \/ One-Stop or DFS/); ok("Non-Private requires choosing EQISS / One-Stop or DFS");
  r = await ana.action("/enroll", "setCategoryAction", [{}, fd({ enrollmentType: "NON_PRIVATE", fundingProgram: "EQISS" })]);
  assert.match(r.text, /Hudson, Bergen or Somerset/); ok("EQISS requires a county");
  r = await ana.action("/enroll", "setCategoryAction", [{}, fd({ enrollmentType: "NON_PRIVATE", fundingProgram: "EQISS", county: "HUDSON" })]);
  assert.equal(r.redirect, "/enroll/course");
  const app = await appOf(anaEmail);
  assert.deepEqual([app.enrollmentType, app.fundingProgram, app.county, app.category], ["NON_PRIVATE", "EQISS", "HUDSON", "EQISS"]);
  ok("type, program and county are stored as separate fields");
  for (const p of ["/enroll/forms/private_agreement_1", "/enroll/forms/refund_schedule"]) assert.equal((await ana.get(p)).status, 404);
  ok("Non-Private student gets 404 for the Private agreement and refund schedule");
  const smuggle = await ana.action("/enroll/forms/student_data", "saveFormAction", ["refund_schedule", {}, fd({ acknowledged: "on", intent: "complete" })]);
  assert.match(smuggle.text, /isn't part of your enrollment/); ok("tampered request can't save a Private form for a Non-Private student");
  const wrongCourse = await ana.action("/enroll/course", "setCourseAction", [{}, fd({ courseId: privOnly })]);
  assert.match(wrongCourse.text, /isn't available for your program/); ok("a Private-only course can't be chosen by an EQISS student");
  const page = await ana.get("/enroll/course");
  assert.ok(page.text.includes(`Medical Assistant ${run}`) && !page.text.includes(`Private Only ${run}`)); ok("course list shows only courses offered to the student's program");
  r = await ana.action("/enroll/course", "setCourseAction", [{}, fd({ courseId: maCourse })]);
  assert.equal(r.redirect, "/enroll/forms/student_data"); ok("student chooses a course and continues to the Common Forms");
}
{
  const early = await ana.action("/enroll/review", "submitApplicationAction", [{}, fd({ confirm: "on" })]);
  assert.match(early.text, /Complete .{0,3}Student Data/); ok("incomplete application can't be submitted");
  const draft = await ana.action("/enroll/forms/student_data", "saveFormAction", ["student_data", {}, fd({ legalName: "Ana R", intent: "draft" })]);
  assert.match(draft.text, /Draft saved/); ok("progress can be saved as a draft");
  const unsigned = await ana.action("/enroll/forms/grievance_policy", "saveFormAction", ["grievance_policy", {}, fd({ acknowledged: "on", intent: "complete" })]);
  assert.match(unsigned.text, /sign/i); ok("forms that need a signature can't be completed unsigned");
  await fillForms(ana, { ...COMMON, ...NONPRIVATE }, "Ana Rivera"); ok("8 Common Forms + Non-Private Enrollment Agreement completed and signed");
  const noResume = await ana.action("/enroll/review", "submitApplicationAction", [{}, fd({ confirm: "on" })]);
  assert.match(noResume.text, /resume/i); ok("submission blocked until the resume is uploaded");
  assert.match((await upload(ana, "RESUME", Buffer.from("MZ fake exe"), "resume.pdf", "application/pdf")).text, /Upload a PDF/); ok("file type checked by content");
  assert.match((await upload(ana, "RESUME", PDF, "resume.pdf", "application/pdf")).text, /uploaded/);
  assert.match((await upload(ana, "PHOTO_ID", PDF, "id.pdf", "application/pdf")).text, /uploaded/); ok("resume and photo ID uploaded");
  const review = await ana.get("/enroll/review");
  // Visible HTML only: dev builds inline component source code in <script> tags for debugging.
  assert.doesNotMatch(visible(review.text), /Tuition|tuition|4,500|Refund/); ok("review page shows no tuition content to a Non-Private student");
  const sub = await ana.action("/enroll/review", "submitApplicationAction", [{}, fd({ confirm: "on" })]);
  assert.equal(sub.redirect, "/application"); ok("application submitted");
  assert.equal((await ana.get("/enroll")).location, "/application"); ok("forms locked while pending");
  assert.equal((await ana.get("/dashboard")).location, "/application"); ok("no dashboard while pending");
  const app = await appOf(anaEmail);
  assert.equal(app.submissions.length, 1);
  const pdf = await ana.bytes(`/api/pdf/application/${app._id}`);
  assert.ok(pdfContains(pdf.buf, "Non-Private Enrollment Agreement") && pdfContains(pdf.buf, "Hudson County"));
  for (const t of ["Tuition", "Refund", "4,500"]) assert.ok(!pdfContains(pdf.buf, t), `Non-Private PDF contains ${t}`);
  ok("packet PDF has the Non-Private agreement and no tuition content");
}
const anaApp = (await appOf(anaEmail))._id;

console.log("Admin review, corrections and approval");
{
  assert.ok((await admin.get("/admin/applications?county=HUDSON")).text.includes("Ana Rivera"));
  assert.ok(!(await admin.get("/admin/applications?county=BERGEN")).text.includes("Ana Rivera"));
  assert.ok((await admin.get(`/admin/applications?course=${maCourse}&category=EQISS`)).text.includes("Ana Rivera"));
  assert.ok(!(await admin.get("/admin/applications?category=DFS")).text.includes("Ana Rivera"));
  ok("admin filters applications by county, course and program");
  const detail = await admin.get(`/admin/applications/${anaApp}`);
  assert.ok(detail.text.includes("Luis Rivera") && detail.text.includes("resume.pdf") && detail.text.includes(`Medical Assistant ${run}`)); ok("admin sees forms, documents and chosen course");
  const pay = await admin.action(`/admin/applications/${anaApp}`, "setPaymentStatusAction", [anaApp, {}, fd({ paymentStatus: "PAID" })]);
  assert.match(pay.text, /Private applications only/); ok("a Non-Private application can't be given a payment status");
  const cr = await admin.action(`/admin/applications/${anaApp}`, "requestCorrectionsAction", [anaApp, {}, fd({ sections: ["documents", "emergency_medical"], note: "Please upload a clearer photo ID and check your emergency contact phone." })]);
  assert.match(cr.text, /Correction request sent/); ok("admin requests resubmission with a written explanation");
  const log = fs.readFileSync(LOG, "utf8").split("[email:dev]").filter((b) => b.includes(`To: ${anaEmail}`)).at(-1);
  assert.match(log, /clearer photo ID/); ok("resubmission email explains the corrections");
  assert.equal((await ana.get("/application")).location, "/enroll"); ok("student is returned to the editable enrollment");
  const locked = await ana.action("/enroll/forms/student_data", "saveFormAction", ["student_data", {}, fd({ ...COMMON.student_data, intent: "complete" })]);
  assert.match(locked.text, /locked/); ok("unflagged sections stay locked");
  await fillForms(ana, { emergency_medical: { ...COMMON.emergency_medical, contactPhone: "201-555-0199" } }, "Ana Rivera");
  assert.match((await upload(ana, "PHOTO_ID", PDF, "id-clear.pdf", "application/pdf")).text, /uploaded/);
  const sub = await ana.action("/enroll/review", "submitApplicationAction", [{}, fd({ confirm: "on" })]);
  assert.equal(sub.redirect, "/application"); ok("student edits flagged sections and resubmits");
  const app = await appOf(anaEmail);
  assert.equal(app.status, "RESUBMITTED"); assert.equal(app.submissions.length, 2);
  assert.equal(app.submissions[0].forms.emergency_medical.data.contactPhone, "201-555-0101"); ok("the earlier submission is preserved");
  const edit = await admin.action(`/admin/applications/${anaApp}/forms/student_data`, "adminSaveFormAction", [anaApp, "student_data", {}, fd({ ...COMMON.student_data, city: "Hoboken" })]);
  assert.match(edit.text, /saved/); ok("admin edits the application");
  const audit = await mdb.collection("audit_logs").findOne({ entityId: anaApp, action: "application.admin_edit_form" });
  assert.equal(audit.meta.before.city, "Jersey City"); assert.equal(audit.meta.after.city, "Hoboken"); ok("admin edit is audited with before and after values");
  const approve = await admin.action(`/admin/applications/${anaApp}`, "approveApplicationAction", [anaApp, {}]);
  assert.match(approve.text, /Approved and enrolled in Medical Assistant/, approve.text.slice(0, 300)); ok("approval enrolls the student in the course they selected");
  const twice = await admin.action(`/admin/applications/${anaApp}`, "approveApplicationAction", [anaApp, {}]);
  assert.match(twice.text, /Only pending/); ok("double approval refused");
  const e = await activeEnrollment(anaEmail);
  const k = await mdb.collection("classes").findOne({ _id: e.classId });
  assert.equal(k.courseId, maCourse); ok("enrollment is in a section of the selected course");
}

console.log("Student dashboard");
{
  assert.equal((await ana.get("/application")).location, "/dashboard");
  const d = await ana.get("/dashboard");
  assert.equal(d.status, 200);
  assert.ok(d.text.includes('href="https://classroom.google.com"')); ok("dashboard has the Google Classroom button");
  assert.ok(d.text.includes(`Medical Assistant ${run}`) && d.text.includes("Biweekly attendance report")); ok("dashboard shows the course and the EQISS biweekly sheet");
}

// ---------- Instructors ----------
console.log("Instructor sign-up, approval and course assignment");
const teach = new Client();
const tEmail = `teach.${run}@example.org`;
{
  assert.equal(await registerAndVerify(teach, "/register/instructor", "registerInstructorAction", "Terry Teach", tEmail), "/instructor/pending");
  const u = await mdb.collection("users").findOne({ email: tEmail });
  assert.equal(u.role, "INSTRUCTOR"); assert.equal(u.instructorStatus, "PENDING"); ok("instructor signs up; account is pending");
  assert.equal((await teach.get("/instructor")).location, "/instructor/pending"); ok("unapproved instructor has no teaching access");
  const sneaky = new Client();
  await registerAndVerify(sneaky, "/register", "registerAction", "Sneaky", `sneaky.${run}@gmail.com`);
  assert.equal((await mdb.collection("users").findOne({ email: `sneaky.${run}@gmail.com` })).role, "STUDENT"); ok("student sign-up can't create an instructor");
  const early = await admin.action(`/admin/instructors/${u._id}`, "assignCourseToInstructorAction", [u._id, {}, fd({ courseId: maCourse })]);
  assert.match(early.text, /approved/); ok("courses can't be assigned before approval");
  assert.match((await admin.action(`/admin/instructors/${u._id}`, "decideInstructorAction", [u._id, {}, fd({ decision: "APPROVED" })])).text, /approved/); ok("admin approves the instructor");
  const a1 = await admin.action(`/admin/instructors/${u._id}`, "assignCourseToInstructorAction", [u._id, {}, fd({ courseId: maCourse })]);
  assert.match(a1.text, /assigned to Medical Assistant/);
  const a2 = await admin.action(`/admin/instructors/${u._id}`, "assignCourseToInstructorAction", [u._id, {}, fd({ courseId: privOnly })]);
  assert.match(a2.text, /assigned to Private Only/); ok("admin assigns two courses to one instructor");
  const home = await teach.get("/instructor");
  assert.ok(home.text.includes("Ana Rivera") && home.text.includes("Attendance Sheet") && home.text.includes("Monthly Progress Report")); ok("instructor dashboard lists students with the two separate actions");
}
const other = new Client();
const oEmail = `other.${run}@example.org`;
await registerAndVerify(other, "/register/instructor", "registerInstructorAction", "Olive Other", oEmail);
await admin.action(`/admin/instructors/${await userId(oEmail)}`, "decideInstructorAction", [await userId(oEmail), {}, fd({ decision: "APPROVED" })]);

console.log("EQISS biweekly report");
let anaEid = (await activeEnrollment(anaEmail))._id;
{
  const page = await teach.get(`/instructor/attendance/${anaEid}`);
  assert.equal(page.status, 200);
  assert.ok(page.text.includes("Customer Instructional Time, Attendance &amp; Progress Biweekly Report"));
  assert.equal((page.text.match(/name="timeIn_\d+"/g) ?? []).length, 14); ok("instructor opens the biweekly report with all 14 daily columns");
  assert.equal((await other.get(`/instructor/attendance/${anaEid}`)).status, 404); ok("an instructor without the course can't open the sheet");
  const sheet = await mdb.collection("biweekly_timesheets").findOne({ enrollmentId: anaEid });
  const days = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [[`timeIn_${i}`, ""], [`timeOut_${i}`, ""], [`code_${i}`, ""], [`instructorInitials_${i}`, ""], [`customerInitials_${i}`, ""]]).flat());
  const header = { ssnLast4: "1234", contractNumber: "ITA-77", caseManager: "Pat Case", schoolName: "Bright Horizon Institute", trainingLocation: "Jersey City", trainingName: "Medical Assistant", programStart: "2026-09-01", programEnd: "2027-03-01", totalProgramHours: "600", scheduledHours: "40" };
  const bad = await teach.action(`/instructor/attendance/${anaEid}`, "saveBiweeklyAction", [sheet._id, {}, fd({ ...days, ...header, ssnLast4: "123-45-6789" })]);
  assert.match(bad.text, /Last 4 digits/); ok("only the last 4 SSN digits are accepted");
  const save = await teach.action(`/instructor/attendance/${anaEid}`, "saveBiweeklyAction", [sheet._id, {}, fd({
    ...days, ...header, timeIn_0: "09:00", timeOut_0: "13:30", instructorInitials_0: "TT", code_1: "A", timeIn_1: "09:00", timeOut_1: "12:00", code_2: "H", code_3: "S",
    timeIn_7: "09:00", timeOut_7: "12:00", comments: "On track", courseGrades: "Vitals: 92", indicator: "ABOVE_AVERAGE", additionalComments: "",
  })]);
  assert.match(save.text, /Report saved/, save.text.slice(0, 300));
  let s = await mdb.collection("biweekly_timesheets").findOne({ _id: sheet._id });
  assert.equal(s.days[0].hours, 4.5); assert.equal(s.days[1].hours, 0); assert.equal(s.days[1].timeIn, ""); assert.deepEqual(s.days.slice(1, 4).map((d) => d.code), ["A", "H", "S"]);
  assert.equal(s.header.contractNumber, "ITA-77"); assert.equal(s.progress.indicator, "ABOVE_AVERAGE"); ok("times, A/H/S codes, header, comments and progress are saved; A/H/S count zero hours");
  const view = await ana.get(`/dashboard/attendance/${anaEid}`);
  assert.ok(view.text.includes("XXX-XX-1234") && !view.text.includes('value="1234"') && view.text.includes("7.50")); ok("student sees the sheet with SSN masked and the biweekly total");
  const sForge = await ana.action(`/dashboard/attendance/${anaEid}`, "saveBiweeklyAction", [sheet._id, {}, fd({ ...days, customerInitials_0: "AR", timeIn_0: "06:00", timeOut_0: "18:00", contractNumber: "HACKED" })]);
  assert.match(sForge.text, /Report saved/);
  s = await mdb.collection("biweekly_timesheets").findOne({ _id: sheet._id });
  assert.equal(s.days[0].customerInitials, "AR"); assert.equal(s.days[0].timeIn, "09:00"); assert.equal(s.header.contractNumber, "ITA-77"); ok("student can write only their own initials (times and header ignored)");
  assert.match((await ana.action(`/dashboard/attendance/${anaEid}`, "signBiweeklyAction", [sheet._id, {}, fd({ signature: SIG, signerName: "Ana Rivera" })])).text, /Signed/);
  assert.match((await teach.action(`/instructor/attendance/${anaEid}`, "signBiweeklyAction", [sheet._id, {}, fd({ signature: SIG, signerName: "Terry Teach" })])).text, /complete/);
  s = await mdb.collection("biweekly_timesheets").findOne({ _id: sheet._id });
  assert.equal(s.status, "COMPLETED"); ok("customer and instructor sign the certification; report complete");
  const after = await teach.action(`/instructor/attendance/${anaEid}`, "saveBiweeklyAction", [sheet._id, {}, fd({ ...days, ...header })]);
  assert.match(after.text, /admin must reopen/); ok("a completed report is locked");
  assert.match((await admin.action(`/admin/attendance/sheets/${anaEid}`, "reopenBiweeklyAction", [sheet._id, {}])).text, /reopened/); ok("admin can reopen it");
}

console.log("Monthly Student Progress Report");
const month = today.slice(0, 7);
{
  const r = await teach.get(`/instructor/reports/${anaEid}/${month}`);
  assert.ok(r.text.includes("Lesson(s) number") && r.text.includes("Instructor Signature")); ok("report form follows the template");
  assert.match((await teach.action(`/instructor/reports/${anaEid}/${month}`, "saveReportAction", [anaEid, month, {}, fd({ lessons: "4", comments: "", intent: "draft" })])).text, /Draft saved/);
  assert.match((await teach.action(`/instructor/reports/${anaEid}/${month}`, "saveReportAction", [anaEid, month, {}, fd({ lessons: "4", comments: "Good", intent: "submit" })])).text, /Sign the report/);
  ok("draft saved; submit needs the instructor's signature");
  const sub = await teach.action(`/instructor/reports/${anaEid}/${month}`, "saveReportAction", [anaEid, month, {}, fd({ lessons: "4-6", comments: "Strong on vitals.", intent: "submit", signature: SIG, signerName: "Terry Teach" })]);
  assert.match(sub.text, /Report submitted/); ok("instructor completes and signs the report");
  const rep = await mdb.collection("progress_reports").findOne({ enrollmentId: anaEid, month });
  assert.equal(rep.revisions.length, 1); assert.equal(rep.instructorName, "Terry Teach"); ok("earlier version kept in revisions");
  const steal = await other.action("/instructor", "saveReportAction", [anaEid, month, {}, fd({ lessons: "1", comments: "x", intent: "draft" })]);
  assert.match(steal.text, /don't have access/); ok("another instructor can't write this report");
  const adminView = await admin.get(`/admin/reports/${rep._id}`);
  assert.ok(adminView.text.includes("Strong on vitals.") && adminView.text.includes("Terry Teach")); ok("admin views the saved report");
  const pdf = await admin.bytes(`/api/pdf/report/${rep._id}`);
  assert.ok(pdfContains(pdf.buf, "Student Progress Report") && pdfContains(pdf.buf, "Lesson(s) number")); ok("report PDF downloads in the template's structure");
}

// ---------- Private student ----------
console.log("Private enrollment with payment");
const pri = new Client();
const pEmail = `pri.${run}@gmail.com`;
{
  await registerAndVerify(pri, "/register", "registerAction", "Pri Vate", pEmail);
  assert.equal((await pri.action("/enroll", "setCategoryAction", [{}, fd({ enrollmentType: "PRIVATE" })])).redirect, "/enroll/course");
  assert.equal((await pri.action("/enroll/course", "setCourseAction", [{}, fd({ courseId: privOnly })])).redirect, "/enroll/forms/student_data");
  ok("Private student goes straight to the forms (no payment during enrollment)");
  assert.equal((await pri.get("/enroll/payment")).location, "/enroll"); ok("the old payment step just returns to the enrollment overview");
  const app = await appOf(pEmail);
  await fillForms(pri, { ...COMMON, ...PRIVATE }, "Pri Vate");
  await upload(pri, "RESUME", PDF, "cv.pdf", "application/pdf");
  await upload(pri, "PHOTO_ID", PDF, "id.pdf", "application/pdf");
  assert.equal((await pri.action("/enroll/review", "submitApplicationAction", [{}, fd({ confirm: "on" })])).redirect, "/application"); ok("Common + Private Forms completed and submitted");
  const pdf = await pri.bytes(`/api/pdf/application/${app._id}`);
  assert.ok(pdfContains(pdf.buf, "Tuition Refund Schedule") && pdfContains(pdf.buf, "4,500")); ok("Private packet PDF includes the Private Forms");
  assert.match((await admin.action(`/admin/applications/${app._id}`, "approveApplicationAction", [app._id, {}])).text, /payment isn't settled/);
  ok("approval refused until tuition is settled");
  assert.ok((await admin.get("/admin/applications?status=PAYMENT")).text.includes("Pri Vate")); ok("submitted Private application appears under 'payment to request'");
  const req = await admin.action(`/admin/applications/${app._id}`, "requestPaymentAction", [app._id, {}, fd({ amount: "4500", note: "" })]);
  if (/isn't set up/.test(req.text)) {
    ok("payment request explains that Stripe isn't configured (test server has no Stripe keys)");
  } else {
    assert.match(req.text, /Payment request for \$4,500\.00 sent/);
    assert.equal((await appOf(pEmail)).paymentStatus, "REQUESTED");
    assert.ok((await pri.get("/application")).text.includes("$4,500.00")); ok("student sees the payment request on the status page");
  }
  assert.match((await admin.action(`/admin/applications/${app._id}`, "setPaymentStatusAction", [app._id, {}, fd({ paymentStatus: "PAID", reference: "RCPT-991" })])).text, /marked paid/);
  ok("admin can record an offline payment (any open online request is cancelled)");
  assert.match((await admin.action(`/admin/applications/${app._id}`, "approveApplicationAction", [app._id, {}])).text, /Approved and enrolled in Private Only/); ok("Private student approved and enrolled");
}

console.log("DFS / Private monthly handwritten sheet");
const priEid = (await activeEnrollment(pEmail))._id;
{
  const page = await teach.get(`/instructor/attendance/${priEid}`);
  assert.ok(page.text.includes(`Monthly attendance: ${month}`) && page.text.includes("Lunch out") && !page.text.includes("timeIn_0")); ok("Private student gets the monthly handwritten sheet, not the biweekly report");
  const save = await teach.action(`/instructor/attendance/${priEid}`, "saveDailyEntryAction", [priEid, today, {}, fd({ status: "PRESENT", startTime: "09:00", lunchOut: "12:00", lunchIn: "12:30", endTime: "15:00", note: "Lab day", signature: SIG, signerName: "Pri Vate" })]);
  assert.match(save.text, /Saved/, save.text.slice(0, 300));
  const sess = await mdb.collection("class_sessions").findOne({ classId: (await activeEnrollment(pEmail)).classId, date: today });
  const r = sess.records[priEid];
  assert.equal(r.hours, 5.5); assert.equal(r.lunchOut, "12:00"); assert.ok(r.studentSignature?.imageDataUrl); ok("start, lunch out, lunch in, end, signature and note saved; hours computed");
  const badTimes = await teach.action(`/instructor/attendance/${priEid}`, "saveDailyEntryAction", [priEid, today, {}, fd({ status: "PRESENT", startTime: "15:00", endTime: "09:00" })]);
  assert.match(badTimes.text, /End time must be after/); ok("impossible times refused");
  const future = await teach.action(`/instructor/attendance/${priEid}`, "saveDailyEntryAction", [priEid, "2099-01-01", {}, fd({ status: "PRESENT" })]);
  assert.match(future.text, /future|outside/); ok("future dates refused");
  assert.match((await teach.action(`/instructor/attendance/${priEid}`, "signMonthlySheetAction", [priEid, month, {}, fd({ signature: SIG, signerName: "Terry Teach" })])).text, /signed/); ok("instructor signs off the month");
  await teach.action(`/instructor/attendance/${priEid}`, "saveDailyEntryAction", [priEid, today, {}, fd({ status: "HOLIDAY", note: "Office closed" })]);
  const after = await admin.get(`/admin/attendance/sheets/${priEid}?month=${month}`);
  assert.ok(after.text.includes("Holiday") && after.text.includes("changed after this sign-off")); ok("holiday option works and changes after sign-off are flagged to the admin");
  const mine = await pri.get(`/dashboard/attendance/${priEid}?month=${month}`);
  assert.equal(mine.status, 200); assert.ok(!mine.text.includes("Save day")); ok("student sees their own sheet read-only");
  assert.equal((await pri.get(`/dashboard/attendance/${anaEid}`)).status, 404); ok("a student can't open another student's sheet");
  assert.equal((await ana.get(`/dashboard/attendance/${priEid}`)).status, 404);
  const forge = await pri.action(`/dashboard/attendance/${priEid}`, "saveDailyEntryAction", [priEid, today, {}, fd({ status: "PRESENT" })]);
  assert.match(forge.text, /don't have access/); ok("students can't edit attendance");
}

console.log("Sections: move, merge and history");
{
  const mk = async (code) => {
    const r = await admin.action(`/admin/courses/${maCourse}`, "saveClassAction", [maCourse, null, {}, fd({ code: `${code}-${run}`, cohort: code, startDate: "2026-09-01", endDate: "2027-06-30", capacity: "20", fundingProgram: "MIXED" })]);
    return r.redirect.split("/").pop();
  };
  const secB = await mk("B"), secC = await mk("C");
  const oldEid = anaEid;
  const mv = await admin.action(`/admin/classes/${secB}`, "moveStudentAction", [{}, fd({ enrollmentId: oldEid, targetClassId: secC })]);
  assert.match(mv.text, /Moved to C-/, mv.text.slice(0, 300));
  const old = await mdb.collection("enrollments").findOne({ _id: oldEid });
  assert.equal(old.status, "TRANSFERRED"); assert.ok(old.movedToEnrollmentId); ok("student moved to another section; old enrollment kept and linked");
  assert.ok(await mdb.collection("biweekly_timesheets").findOne({ enrollmentId: oldEid })); assert.ok(await mdb.collection("progress_reports").findOne({ enrollmentId: oldEid }));
  assert.equal((await admin.get(`/admin/attendance/sheets/${oldEid}`)).status, 200); ok("attendance and reports from the old section are preserved and viewable");
  const merge = await admin.action(`/admin/classes/${secB}`, "mergeSectionsAction", [secB, {}, fd({ sourceClassIds: [secC] })]);
  assert.match(merge.text, /1 student moved/);
  const c = await mdb.collection("classes").findOne({ _id: secC });
  assert.equal(c.archived, true); assert.equal(c.mergedIntoClassId, secB);
  anaEid = (await activeEnrollment(anaEmail))._id;
  assert.equal((await mdb.collection("enrollments").findOne({ _id: anaEid })).classId, secB); ok("sections merged into one roster; merged section archived with its records");
  const d = await ana.get("/dashboard");
  assert.ok(d.text.includes("Earlier sections")); ok("student still sees earlier sections' attendance");
  assert.ok((await teach.get("/instructor")).text.includes("Ana Rivera")); ok("course instructor still sees the student after the move");
}

console.log("Changing instructor assignments keeps history");
{
  const a = await mdb.collection("course_assignments").findOne({ instructorId: await userId(tEmail), courseId: maCourse, removedAt: null });
  assert.match((await admin.action(`/admin/instructors/${await userId(tEmail)}`, "removeCourseAssignmentAction", [{}, fd({ assignmentId: a._id })])).text, /Assignment removed/);
  assert.equal((await teach.get(`/instructor/attendance/${anaEid}`)).status, 404); ok("removing the course assignment removes access");
  const rep = await mdb.collection("progress_reports").findOne({ month, authorId: await userId(tEmail) });
  assert.ok(rep && rep.signature.signerName === "Terry Teach"); ok("reports and signatures written before the change are untouched");
  assert.match((await admin.action(`/admin/courses/${maCourse}`, "assignInstructorToCourseAction", [maCourse, {}, fd({ instructorId: await userId(oEmail) })])).text, /assigned/);
  assert.equal((await other.get(`/instructor/attendance/${anaEid}`)).status, 200); ok("a new instructor assigned from the course page gets access");
}

console.log("Access control");
{
  // Through /admin the middleware already refuses (307). Through pages they can open, the action's own
  // server-side role check must refuse it.
  assert.equal((await ana.action("/admin", "approveApplicationAction", [anaApp, {}])).status, 307);
  const p = await appOf(pEmail);
  const rejectAsStudent = await ana.action("/dashboard", "rejectApplicationAction", [p._id, {}, fd({ reason: "student forging an admin action" })]);
  assert.doesNotMatch(rejectAsStudent.text, /rejected/);
  assert.equal((await appOf(pEmail)).status, "APPROVED");
  const asInst = await teach.action("/instructor", "setPaymentStatusAction", [p._id, {}, fd({ paymentStatus: "WAIVED" })]);
  assert.doesNotMatch(asInst.text, /marked/); assert.equal((await appOf(pEmail)).paymentStatus, "PAID");
  const mergeAsInst = await teach.action("/instructor", "assignCourseToInstructorAction", [await userId(tEmail), {}, fd({ courseId: maCourse })]);
  assert.doesNotMatch(mergeAsInst.text, /assigned to/);
  assert.equal(await mdb.collection("course_assignments").countDocuments({ instructorId: await userId(tEmail), courseId: maCourse, removedAt: null }), 0);
  ok("students and instructors can't run admin actions, even when posting the action directly");
  assert.equal((await ana.get("/admin")).status, 307); assert.equal((await teach.get("/admin/applications")).status, 307); ok("admin pages refuse other roles");
  const docId = (await admin.get(`/admin/applications/${anaApp}`)).text.match(/\/api\/files\/([0-9a-f-]{36})/)[1];
  assert.equal((await pri.get(`/api/files/${docId}`)).status, 404); assert.equal((await new Client().get(`/api/files/${docId}`)).status, 401); ok("uploaded files are access-controlled");
  assert.equal((await pri.get(`/api/pdf/application/${anaApp}`)).status, 404); ok("another student's packet can't be downloaded");
}

console.log("Handwritten attendance app integration");
{
  const json = await (await fetch(`${BASE}/api/integrations/rosters`, { headers: { "x-api-key": process.env.INTEGRATION_API_KEY } })).json();
  const row = json.classes.flatMap((k) => k.students.map((s) => ({ ...s, classId: k.id }))).find((s) => s.enrollmentId === priEid);
  assert.equal(row.sheet, "MONTHLY"); ok("roster feed tells the app which students use the monthly sheet");
  const res = await fetch(`${BASE}/api/integrations/attendance`, {
    method: "POST", headers: { "x-api-key": process.env.INTEGRATION_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ classId: row.classId, date: today, recordedByEmail: tEmail, records: [{ enrollmentId: priEid, status: "PRESENT", startTime: "08:30", lunchOut: "12:00", lunchIn: "12:45", endTime: "14:00", studentSignature: SIG }] }),
  });
  assert.equal(res.status, 200, await res.clone().text());
  const sess = await mdb.collection("class_sessions").findOne({ classId: row.classId, date: today });
  assert.equal(sess.records[priEid].hours, 4.75); assert.equal(sess.records[priEid].note, "Office closed"); ok("handwritten times and signature from the app are stored; hours computed; other fields kept");
}

await mongo.close();
console.log(`\nAll ${passed} checks passed.`);

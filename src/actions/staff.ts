"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Binary } from "mongodb";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { audit, cols, newId, rateLimit, type Entry, type EntryStatus, type Excuse, type RowComment, type Staff } from "@/lib/db";
import { PORTAL, endStaffSession, requireStaff, startStaffSession } from "@/lib/auth";
import { holidaysBetween, thisMonth, today } from "@/lib/data";
import { DATE_RE, MONTH_RE, addDays, isClassDay, minutesBetween, monthTitle, parseTime, time12, usDate } from "@/lib/sheet";
import { entriesHash } from "@/lib/hash";
import { canSee } from "@/lib/access";
import { checkSignaturePng, saveSignature } from "@/lib/signatures";
import { EXCUSE_MAX_BYTES, STATUS_LABEL, dayStatus, safeFileName, sniffExcuse, teacherLock } from "@/lib/week";
import type { ActionState } from "@/lib/action";

const refresh = () => { revalidatePath("/admin", "layout"); revalidatePath("/teacher", "layout"); revalidatePath("/student", "layout"); };

/**
 * Admins and teachers each have their own sign-in page. The password is checked first, so the
 * "wrong page" hint only appears to someone who already knows the password.
 */
async function signIn(role: "ADMIN" | "TEACHER", fd: FormData): Promise<ActionState> {
  const email = String(fd.get("email") ?? "").trim().toLowerCase();
  const password = String(fd.get("password") ?? "");
  if (!email || !password) return { error: "Enter your email and password." };
  if (!(await rateLimit(`login:${email}`, 8, 900))) return { error: "Too many tries. Wait 15 minutes." };
  const staff = await (await cols()).staff.findOne({ email, active: true });
  if (!staff || !(await bcrypt.compare(password, staff.passwordHash))) return { error: "Email or password is incorrect." };
  if (staff.role !== role) {
    return { error: staff.role === "ADMIN" ? "This is an admin account. Use the admin sign-in page." : "This is a teacher account. Use the teacher sign-in page." };
  }
  await startStaffSession(staff);
  await audit(staff._id, role === "ADMIN" ? "admin.login" : "teacher.login", staff._id);
  redirect(PORTAL[role].home);
}
export async function adminLoginAction(_: ActionState, fd: FormData) { return signIn("ADMIN", fd); }
export async function teacherLoginAction(_: ActionState, fd: FormData) { return signIn("TEACHER", fd); }

export async function adminLogoutAction() {
  await endStaffSession();
  redirect(PORTAL.ADMIN.login);
}
export async function teacherLogoutAction() {
  await endStaffSession();
  redirect(PORTAL.TEACHER.login);
}

// ---------- The roster: approve, send back, present / absent, excuses ----------

const entries = async () => (await cols()).entries;
const ROW_KEY = /^[0-9a-f-]{36}:\d{4}-\d{2}-\d{2}$/;
const rowKeys = (raw: unknown) => {
  try {
    const p = z.array(z.string().regex(ROW_KEY)).min(1).max(3000).safeParse(JSON.parse(String(raw ?? "[]")));
    return p.success ? [...new Set(p.data)] : null;
  } catch {
    return null;
  }
};

/** The student and row behind a roster key, if this staff member may act on it. */
async function rowFor(staff: Staff, key: string) {
  const [studentId, date] = [key.slice(0, 36), key.slice(37)];
  const { students, entries } = await cols();
  const student = await students.findOne({ _id: studentId });
  if (!student || !canSee(staff, student)) return { ok: false, error: "not one of your students" } as const;
  if (date > today()) return { ok: false, error: `${usDate(date)} hasn't happened yet` } as const;
  const holiday = (await holidaysBetween(date, date)).has(date);
  const entry = await entries.findOne({ _id: key });
  // Once the admin has signed off the month, only admins change it.
  const signed = await (await cols()).approvals.findOne({ _id: `${studentId}:${date.slice(0, 7)}` }, { projection: { staffName: 1 } });
  if (signed && staff.role !== "ADMIN") return { ok: false, error: `${student.name}'s ${monthTitle(date.slice(0, 7))} is signed off by ${signed.staffName}` } as const;
  return { ok: true, student, date, entry, holiday, status: dayStatus(entry, holiday, date, today()) } as const;
}

const summarize = (done: number, verb: string, problems: string[]) => {
  const extra = problems.length ? ` Skipped: ${problems.slice(0, 4).join("; ")}${problems.length > 4 ? ` and ${problems.length - 4} more` : ""}.` : "";
  return done ? { ok: true, message: `${verb} ${done} day${done === 1 ? "" : "s"}.${extra}` } : { error: `Nothing changed.${extra}` };
};

/**
 * Approve signed attendance: the student's assigned teacher verifies and signs by hand. One signature
 * covers every day they ticked, and is stored on each of those days. Only days the student has
 * signed can be approved. Pending days can be approved at any time (they wait for this teacher).
 */
export async function approveRowsAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const staff = await requireStaff();
  // The teacher signature column is the student's own teacher's handwritten signature, nobody else's.
  if (staff.role !== "TEACHER") return { error: "Only the student's teacher signs the teacher signature column. Admins can send a day back or correct it." };
  const keys = rowKeys(fd.get("rows"));
  if (!keys) return { error: "Choose the days to approve." };
  const sig = checkSignaturePng(fd.get("signature"));
  if ("error" in sig) return { error: "Sign by hand to approve." };
  const { entries } = await cols();
  const now = new Date();
  const sigId = await saveSignature("STAFF", staff._id, sig.png, "DRAWN", staff._id);
  const signature = { id: sigId, at: now, staffId: staff._id, staffName: staff.name };
  let done = 0;
  const problems: string[] = [];
  for (const key of keys) {
    const r = await rowFor(staff, key);
    if (!r.ok) { problems.push(r.error); continue; }
    const who = `${r.student.name} ${usDate(r.date)}`;
    const e = r.entry;
    if (r.status === "APPROVED") { problems.push(`${who} is already approved`); continue; }
    if (!e || e.status !== "PRESENT" || !e.studentSignature) { problems.push(`${who} has no signed submission`); continue; }
    const res = await entries.updateOne(
      { _id: key, staffSignature: null, status: "PRESENT", "studentSignature.id": e.studentSignature.id },
      {
        $set: { staffSignature: signature, correction: null, updatedAt: now },
        $push: { history: { at: now, byId: staff._id, byName: staff.name, what: "checked and signed by teacher", reason: "" } },
      },
    );
    if (res.modifiedCount) done++; else problems.push(`${who} changed in the meantime`);
  }
  await audit(staff._id, "staff.approve", "entries", { approved: done, skipped: problems.length, signatureId: sigId, rows: keys.length });
  refresh();
  return summarize(done, "Approved and signed", problems);
}

/**
 * Send a submission back to the student: "Needs correction", with the reason they see. The
 * student fills the day in again (and signs again). Teachers: days not approved yet. Admins can
 * also reopen an approved day; the approval is kept in the row's history.
 */
export async function rejectRowAction(key: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const staff = await requireStaff();
  if (!ROW_KEY.test(key)) return { error: "Invalid day." };
  const reason = String(fd.get("reason") ?? "").trim().slice(0, 300);
  if (reason.length < 3) return { error: "Tell the student what to fix.", fieldErrors: { reason: "Tell the student what to fix." } };
  const r = await rowFor(staff, key);
  if (!r.ok) return { error: `This day is ${r.error}.` };
  const e = r.entry;
  if (!e || e.status !== "PRESENT" || !e.studentSignature) return { error: "There is no signed submission to send back." };
  if (e.staffSignature && staff.role !== "ADMIN") return { error: `Already approved by ${e.staffSignature.staffName}. Ask an admin.` };
  const now = new Date();
  const comment: RowComment = { id: newId(), at: now, byId: staff._id, byName: staff.name, byRole: staff.role, text: `Needs correction: ${reason}`, inkId: null };
  const res = await (await entries()).updateOne(
    { _id: key, updatedAt: e.updatedAt },
    {
      $set: { correction: { byId: staff._id, byName: staff.name, at: now, reason }, staffSignature: null, updatedAt: now },
      $push: {
        history: { at: now, byId: staff._id, byName: staff.name, what: `sent back to student${e.staffSignature ? ` (approval by ${e.staffSignature.staffName} removed)` : ""}`, reason },
        comments: comment,
      },
    },
  );
  if (!res.modifiedCount) return { error: "This day changed in the meantime. Reload the page." };
  await audit(staff._id, "staff.reject", key, { reason, removedApproval: e.staffSignature ?? null });
  refresh();
  return { ok: true, message: `Sent back to ${r.student.name} for ${usDate(r.date)}.` };
}
/**
 * Taking attendance: mark students Present or Absent for days. Marking present is not approving:
 * a student who hasn't signed stays "signature missing" until they do. Teachers: this week and
 * last week, not approved or excused days. Times and signatures the student wrote are kept.
 */
export async function markRowsAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const staff = await requireStaff();
  const keys = rowKeys(fd.get("rows"));
  if (!keys) return { error: "Choose the students to mark." };
  const mark = z.enum(["PRESENT", "ABSENT"]).safeParse(fd.get("mark"));
  if (!mark.success) return { error: "Choose present or absent." };
  const col = await entries();
  const now = new Date();
  const markedBy = { staffId: staff._id, staffName: staff.name, at: now, mark: mark.data };
  const word = mark.data === "PRESENT" ? "present" : "absent";
  let done = 0;
  const problems: string[] = [];
  for (const key of keys) {
    const r = await rowFor(staff, key);
    if (!r.ok) { problems.push(r.error); continue; }
    const who = `${r.student.name} ${usDate(r.date)}`;
    if (staff.role !== "ADMIN") {
      const lock = teacherLock(r.date, today());
      if (lock) { problems.push(`${who} is locked`); continue; }
    }
    if (!isClassDay(r.student, r.date)) { problems.push(`${who} isn't a class day`); continue; }
    if (r.status === "HOLIDAY") { problems.push(`${who} is a holiday`); continue; }
    if (r.status === "APPROVED") { problems.push(`${who} is approved (an admin can change it)`); continue; }
    if (r.status === "EXCUSED") { problems.push(`${who} is excused (an admin can change it)`); continue; }
    const history = { at: now, byId: staff._id, byName: staff.name, what: `marked ${word}`, reason: "" };
    if (!r.entry) {
      const row: Entry = {
        _id: key, studentId: r.student._id, date: r.date, status: mark.data, startAt: null, endAt: null, startTime: null, endTime: null, minutes: null,
        studentSignature: null, staffSignature: null, correction: null, markedBy, excuse: null, note: "", comments: [], history: [history], updatedAt: now,
      };
      try { await col.insertOne(row); done++; } catch { problems.push(`${who} changed in the meantime`); }
      continue;
    }
    if (r.entry.status === mark.data && r.entry.markedBy?.mark === mark.data) { done++; continue; }
    const res = await col.updateOne(
      { _id: key, updatedAt: r.entry.updatedAt, staffSignature: null, status: { $in: ["PRESENT", "ABSENT"] } },
      { $set: { status: mark.data, markedBy, updatedAt: now }, $push: { history } },
    );
    if (res.modifiedCount) done++; else problems.push(`${who} changed in the meantime`);
  }
  await audit(staff._id, "staff.mark", "entries", { mark: mark.data, marked: done, skipped: problems.length });
  refresh();
  return summarize(done, `Marked ${word}:`, problems);
}

/**
 * Approve or reject an uploaded excuse. Approved: the day becomes Excused (it no longer counts
 * against the student). Rejected: it stays Absent, with the reason. Teachers decide pending
 * excuses; admins can also change a decision.
 */
export async function decideExcuseAction(key: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const staff = await requireStaff();
  if (!ROW_KEY.test(key)) return { error: "Invalid day." };
  const decision = z.enum(["APPROVED", "REJECTED"]).safeParse(fd.get("decision"));
  if (!decision.success) return { error: "Choose approve or reject." };
  const reason = String(fd.get("reason") ?? "").trim().slice(0, 300);
  const r = await rowFor(staff, key);
  if (!r.ok) return { error: `This day is ${r.error}.` };
  const e = r.entry;
  if (!e?.excuse) return { error: "There is no excuse for this day." };
  if (e.excuse.status !== "PENDING" && staff.role !== "ADMIN") return { error: `This excuse was already ${e.excuse.status.toLowerCase()}. Ask an admin to change it.` };
  if (e.excuse.status === decision.data) return { ok: true, message: "Nothing changed." };
  if (decision.data === "REJECTED" && reason.length < 3) return { error: "Say why the excuse is rejected.", fieldErrors: { reason: "Say why." } };
  const now = new Date();
  const status: EntryStatus = decision.data === "APPROVED" ? "EXCUSED" : "ABSENT";
  const res = await (await entries()).updateOne(
    { _id: key, updatedAt: e.updatedAt },
    {
      $set: {
        status, updatedAt: now,
        "excuse.status": decision.data, "excuse.decidedBy": { id: staff._id, name: staff.name, role: staff.role }, "excuse.decidedAt": now, "excuse.reason": reason,
      },
      $push: { history: { at: now, byId: staff._id, byName: staff.name, what: `excuse ${decision.data.toLowerCase()} (was ${e.excuse.status.toLowerCase()})`, reason } },
    },
  );
  if (!res.modifiedCount) return { error: "This day changed in the meantime. Reload the page." };
  await audit(staff._id, decision.data === "APPROVED" ? "staff.approve_excuse" : "staff.reject_excuse", key, { from: e.excuse.status, reason, fileId: e.excuse.fileId });
  refresh();
  return { ok: true, message: decision.data === "APPROVED" ? `Excuse approved: ${r.student.name}, ${usDate(r.date)} is now Excused.` : `Excuse rejected: ${usDate(r.date)} stays Absent.` };
}

// ---------- Admin: "Approved by" at the bottom of the month ----------

/**
 * The admin (for example Mahek) signs off students' months: the "Approved by" section at the bottom
 * of the sheet, with her name, position, a handwritten signature and optional comments. One
 * signature can sign off many students at once. A student is skipped while any of their days that
 * month still wait for the teacher (Pending or Needs correction). Signing again replaces the
 * earlier sign-off, which is kept in the audit log. A signed month is closed for students and
 * teachers; if an admin changes a day afterwards, the sign-off shows as out of date.
 */
export async function signMonthsAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const staff = await requireStaff();
  if (staff.role !== "ADMIN" || !staff.signsOff) return { error: "Only the admin who signs the “Approved by” section (set on the Staff page) can sign off months." };
  const month = String(fd.get("month") ?? "");
  if (!MONTH_RE.test(month) || month > thisMonth()) return { error: "Choose a month." };
  let ids: string[] = [];
  try {
    const p = z.array(z.string().uuid()).min(1).max(2000).safeParse(JSON.parse(String(fd.get("students") ?? "[]")));
    if (p.success) ids = [...new Set(p.data)];
  } catch { /* handled below */ }
  if (!ids.length) return { error: "Choose the students to sign off." };
  const sig = checkSignaturePng(fd.get("signature"));
  if ("error" in sig) return { error: "Sign by hand to sign off the month." };
  // Always the signer's own name and position from her account: nothing typed in can change who it says.
  const staffName = staff.name, position = staff.position;
  const comments = String(fd.get("comments") ?? "").trim().slice(0, 600);
  const { students, entries, approvals } = await cols();
  const now = new Date();
  const signatureId = await saveSignature("STAFF", staff._id, sig.png, "DRAWN", staff._id);
  const holidays = await holidaysBetween(`${month}-01`, `${month}-31`);
  let done = 0;
  const problems: string[] = [];
  for (const s of await students.find({ _id: { $in: ids } }).toArray()) {
    // Signed at the end of the month, like the paper sheet (or once the student's course has ended).
    if (month >= thisMonth() && s.endDate >= today()) { problems.push(`${s.name}: ${monthTitle(month)} isn't over yet`); continue; }
    const list = await entries.find({ studentId: s._id, date: { $gte: `${month}-01`, $lte: `${month}-31` } }).toArray();
    const waiting = list.filter((e) => ["PENDING", "NEEDS_CORRECTION"].includes(dayStatus(e, holidays.has(e.date), e.date, today()))).length;
    if (waiting) { problems.push(`${s.name}: ${waiting} day${waiting === 1 ? "" : "s"} still waiting for the teacher`); continue; }
    if (!list.length) { problems.push(`${s.name}: nothing recorded`); continue; }
    const id = `${s._id}:${month}`;
    const existing = await approvals.findOne({ _id: id });
    await approvals.updateOne(
      { _id: id },
      { $set: { studentId: s._id, month, staffId: staff._id, staffName, position, signatureId, comments, commentsInkId: null, entriesHash: entriesHash(list), signedAt: now } },
      { upsert: true },
    );
    await audit(staff._id, "admin.sign_month", id, {
      staffName, position, signatureId, rows: list.length,
      replaced: existing ? { staffId: existing.staffId, staffName: existing.staffName, signatureId: existing.signatureId, signedAt: existing.signedAt } : null,
    });
    done++;
  }
  refresh();
  const extra = problems.length ? ` Not signed: ${problems.slice(0, 4).join("; ")}${problems.length > 4 ? ` and ${problems.length - 4} more` : ""}.` : "";
  return done ? { ok: true, message: `Signed off ${monthTitle(month)} for ${done} student${done === 1 ? "" : "s"}.${extra}` } : { error: `Nothing was signed.${extra}` };
}

/** The admin takes a month's sign-off off again (to let the student or teacher fix something). Kept in the audit log. */
export async function removeMonthSignOffAction(studentId: string, month: string, _: ActionState, __: FormData): Promise<ActionState> {
  const staff = await requireStaff();
  if (staff.role !== "ADMIN") return { error: "Only an admin can do this." };
  if (!z.string().uuid().safeParse(studentId).success || !MONTH_RE.test(month)) return { error: "Invalid month." };
  const gone = await (await cols()).approvals.findOneAndDelete({ _id: `${studentId}:${month}` });
  if (!gone) return { ok: true, message: "This month isn't signed off." };
  await audit(staff._id, "admin.remove_month_sign_off", `${studentId}:${month}`, { removed: gone });
  refresh();
  return { ok: true, message: `Sign-off for ${monthTitle(month)} removed. The month is open again.` };
}

// ---------- Admin corrections ----------

/**
 * An admin corrects or adds one day: status, times, a note, and optionally a document for an
 * excused absence. Works on any date. The original values are kept in the row's history and the
 * audit log. The student's own signature is never written or imitated: a day an admin records as
 * present without the student's signature stays "signature missing". Changing a day takes its
 * approval off, so it is approved again.
 */
export async function adminEditRowAction(studentId: string, date: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const staff = await requireStaff();
  if (staff.role !== "ADMIN") return { error: "Only an admin can correct attendance. Send the day back to the student instead." };
  if (!z.string().uuid().safeParse(studentId).success || !DATE_RE.test(date)) return { error: "Invalid day." };
  if (date > today()) return { error: "You can't record a future date." };
  const status = z.enum(["PRESENT", "ABSENT", "EXCUSED", "HOLIDAY"]).safeParse(fd.get("status"));
  if (!status.success) return { fieldErrors: { status: "Choose a status" } };
  const rawStart = String(fd.get("startTime") ?? "").trim(), rawEnd = String(fd.get("endTime") ?? "").trim();
  const note = String(fd.get("note") ?? "").trim().slice(0, 200);
  const reason = String(fd.get("reason") ?? "").trim().slice(0, 300);
  const present = status.data === "PRESENT";
  let startTime: string | null = null, endTime: string | null = null;
  if (present && (rawStart || rawEnd)) {
    startTime = parseTime(rawStart); endTime = parseTime(rawEnd);
    if (!startTime) return { fieldErrors: { startTime: "Enter the start time" } };
    if (!endTime) return { fieldErrors: { endTime: "Enter the end time" } };
    if (minutesBetween(startTime, endTime) === null) return { fieldErrors: { endTime: "End must be after start" } };
  }
  // An optional document (an excuse for an older date, a note handed in on paper).
  const file = fd.get("file");
  let upload: { buf: Uint8Array; mime: NonNullable<ReturnType<typeof sniffExcuse>>; name: string } | null = null;
  if (file instanceof File && file.size) {
    if (file.size > EXCUSE_MAX_BYTES) return { fieldErrors: { file: "4 MB max." } };
    const buf = new Uint8Array(await file.arrayBuffer());
    const mime = sniffExcuse(buf);
    if (!mime) return { fieldErrors: { file: "Only PDF, JPG or PNG." } };
    upload = { buf, mime, name: safeFileName(file.name, mime) };
  }

  const { entries: col, students, excuseFiles } = await cols();
  const student = await students.findOne({ _id: studentId });
  if (!student) return { error: "Student not found." };
  if (date < student.startDate || date > student.endDate) return { error: `${usDate(date)} is outside ${student.name}'s course dates.` };
  const id = `${studentId}:${date}`;
  const before = await col.findOne({ _id: id });
  const keepTimes = present && !rawStart && !rawEnd && before?.status === "PRESENT";
  if (keepTimes) { startTime = before!.startTime; endTime = before!.endTime; }
  const changed = !before || before.status !== status.data || before.startTime !== startTime || before.endTime !== endTime || (before.note ?? "") !== note || !!upload;
  if (!changed) return { ok: true, message: "Nothing changed." };
  if (before && reason.length < 3) return { fieldErrors: { reason: "Say why you're changing this day" } };
  const now = new Date();
  let excuse: Excuse | null | undefined = undefined;
  if (upload) {
    const fileId = newId();
    await excuseFiles.insertOne({ _id: fileId, studentId, date, name: upload.name, mime: upload.mime, size: upload.buf.length, data: new Binary(Buffer.from(upload.buf)), at: now });
    excuse = {
      fileId, fileName: upload.name, mime: upload.mime, size: upload.buf.length, note: note || reason, at: now,
      status: status.data === "EXCUSED" ? "APPROVED" : "PENDING",
      decidedBy: status.data === "EXCUSED" ? { id: staff._id, name: staff.name, role: staff.role } : null, decidedAt: status.data === "EXCUSED" ? now : null, reason: "",
    };
  } else if (status.data === "EXCUSED" && before?.excuse && before.excuse.status !== "APPROVED") {
    excuse = { ...before.excuse, status: "APPROVED", decidedBy: { id: staff._id, name: staff.name, role: staff.role }, decidedAt: now };
  }
  const describe = (e: Pick<Entry, "status" | "startTime" | "endTime"> | null) =>
    e ? `${STATUS_LABEL[e.status === "PRESENT" ? "PENDING" : e.status].replace("Pending", "Present")}${e.status === "PRESENT" && e.startTime ? ` ${time12(e.startTime)}–${time12(e.endTime)}` : ""}` : "nothing recorded";
  const after = { status: status.data, startTime: present ? startTime : null, endTime: present ? endTime : null, minutes: null, note };
  const timesChanged = before?.startTime !== after.startTime || before?.endTime !== after.endTime;
  const what = `admin: ${describe(before)} → ${describe(after)}${before?.staffSignature ? ` (approval by ${before.staffSignature.staffName} removed)` : ""}${upload ? `; document ${upload.name}` : ""}`;
  await col.updateOne(
    { _id: id },
    {
      $set: {
        ...after, staffSignature: null, correction: null, updatedAt: now,
        // The student's handwritten time no longer matches a corrected time, so the corrected one shows.
        ...(timesChanged ? { startInkId: null, endInkId: null, lunchStartInkId: null, lunchEndInkId: null } : {}),
        ...(excuse !== undefined ? { excuse } : {}),
      },
      $setOnInsert: { studentId, date, startAt: null, endAt: null, studentSignature: null, markedBy: null, comments: [], ...(excuse === undefined ? { excuse: null } : {}) },
      $push: { history: { at: now, byId: staff._id, byName: staff.name, what, reason: reason || "added by admin" } },
    },
    { upsert: true },
  );
  await audit(staff._id, before ? "admin.edit_day" : "admin.add_day", id, {
    reason,
    before: before ? {
      status: before.status, startTime: before.startTime, endTime: before.endTime, minutes: before.minutes, note: before.note,
      startInkId: before.startInkId ?? null, endInkId: before.endInkId ?? null, lunchStartInkId: before.lunchStartInkId ?? null, lunchEndInkId: before.lunchEndInkId ?? null, staffSignature: before.staffSignature ?? null, excuse: before.excuse ? { ...before.excuse } : null,
    } : null,
    after, document: upload?.name ?? null,
  });
  refresh();
  return { ok: true, message: `${student.name}, ${usDate(date)} saved.${present && !before?.studentSignature ? " The student's signature stays missing until they sign." : ""}` };
}

/** A day off for one class: marks the day Holiday or Excused for everyone in the course. Admins only. */
export async function markCourseDayAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const staff = await requireStaff();
  if (staff.role !== "ADMIN") return { error: "Only an admin can mark a class day off." };
  const date = String(fd.get("date") ?? "");
  const course = String(fd.get("course") ?? "").trim();
  const mode = z.enum(["HOLIDAY", "EXCUSED", "REMOVE"]).safeParse(fd.get("status"));
  const note = String(fd.get("note") ?? "").trim().slice(0, 120);
  if (!DATE_RE.test(date)) return { fieldErrors: { date: "Choose a date" } };
  if (date > addDays(today(), 366)) return { fieldErrors: { date: "Choose a date within the next year" } };
  if (!course) return { fieldErrors: { course: "Choose a class" } };
  if (!mode.success) return { fieldErrors: { status: "Choose what to mark" } };
  if (mode.data !== "REMOVE" && note.length < 2) return { fieldErrors: { note: "Add a short note (it's written on the sheet)" } };
  if ((await holidaysBetween(date, date)).get(date)) return { error: "That date is already a school-wide holiday." };
  const { entries, students } = await cols();
  const list = (await students.find({ courseName: course, active: true, startDate: { $lte: date }, endDate: { $gte: date } }).toArray()).filter((s) => isClassDay(s, date));
  if (!list.length) return { error: `Nobody in ${course} has class on ${usDate(date)}.` };
  const now = new Date();
  let changed = 0;
  const kept: string[] = [];
  for (const st of list) {
    const id = `${st._id}:${date}`;
    if (mode.data === "REMOVE") {
      // Only rows this tool made (every change in their history is a class day off) and nothing else recorded.
      const gone = await entries.findOneAndDelete({
        _id: id, status: { $in: ["HOLIDAY", "EXCUSED"] }, startTime: null, staffSignature: null, studentSignature: null,
        "comments.0": { $exists: false }, history: { $not: { $elemMatch: { reason: { $ne: "class day off" } } } },
      });
      if (gone) { changed++; await audit(staff._id, "staff.course_day_removed", id, { removed: gone }); }
      continue;
    }
    const status = mode.data as EntryStatus;
    const history = { at: now, byId: staff._id, byName: staff.name, what: `class marked ${status.toLowerCase()}: ${note}`, reason: "class day off" };
    const res = await entries.updateOne(
      { _id: id },
      {
        $setOnInsert: {
          studentId: st._id, date, status, note, startAt: null, endAt: null, startTime: null, endTime: null, minutes: null,
          studentSignature: null, staffSignature: null, comments: [], history: [history], updatedAt: now,
        },
      },
      { upsert: true },
    );
    if (res.upsertedCount) { changed++; continue; }
    // A row exists: change it only if nothing was recorded on it yet.
    const upd = await entries.updateOne(
      { _id: id, startTime: null, staffSignature: null },
      { $set: { status, note, minutes: null, endTime: null, updatedAt: now }, $push: { history } },
    );
    if (upd.modifiedCount) changed++; else kept.push(st.name);
  }
  await audit(staff._id, "staff.course_day", `${course}:${date}`, { mode: mode.data, note, changed, kept: kept.length });
  refresh();
  if (mode.data === "REMOVE") return { ok: true, message: `Removed from ${changed} student${changed === 1 ? "" : "s"}' sheets.` };
  return {
    ok: true,
    message: `${usDate(date)} marked ${mode.data.toLowerCase()} for ${changed} student${changed === 1 ? "" : "s"} in ${course}.` +
      (kept.length ? ` Left as recorded (already started or signed): ${kept.slice(0, 5).join(", ")}${kept.length > 5 ? "…" : ""}.` : ""),
  };
}

export async function changePasswordAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const staff = await requireStaff();
  const current = String(fd.get("current") ?? "");
  const next = String(fd.get("next") ?? "");
  if (!(await bcrypt.compare(current, staff.passwordHash))) return { fieldErrors: { current: "That isn't your current password" } };
  if (next.length < 10) return { fieldErrors: { next: "Use at least 10 characters" } };
  const hash = await bcrypt.hash(next, 12);
  await (await cols()).staff.updateOne({ _id: staff._id }, { $set: { passwordHash: hash } });
  await startStaffSession({ ...staff, passwordHash: hash });
  await audit(staff._id, "staff.change_password", staff._id);
  return { ok: true, message: "Password changed. Other devices are signed out." };
}
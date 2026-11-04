"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { audit, cols, rateLimit, type Entry, type EntryStatus } from "@/lib/db";
import { endStaffSession, requireStaff, startStaffSession } from "@/lib/auth";
import { holidaysBetween, thisMonth, today } from "@/lib/data";
import { DATE_RE, MONTH_RE, TIME_RE, isClassDay, minutesBetween, time12, usDate } from "@/lib/sheet";
import { entriesHash } from "@/lib/hash";
import { canSee } from "@/lib/access";
import { checkSignaturePng, saveSignature } from "@/lib/signatures";
import type { ActionState } from "@/lib/action";

const refresh = () => { revalidatePath("/staff", "layout"); revalidatePath("/student", "layout"); };

export async function staffLoginAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const email = String(fd.get("email") ?? "").trim().toLowerCase();
  const password = String(fd.get("password") ?? "");
  if (!email || !password) return { error: "Enter your email and password." };
  if (!(await rateLimit(`login:${email}`, 8, 900))) return { error: "Too many tries. Wait 15 minutes." };
  const staff = await (await cols()).staff.findOne({ email, active: true });
  if (!staff || !(await bcrypt.compare(password, staff.passwordHash))) return { error: "Email or password is incorrect." };
  await startStaffSession(staff);
  await audit(staff._id, "staff.login", staff._id);
  redirect("/staff");
}

export async function staffLogoutAction() {
  await endStaffSession();
  redirect("/staff/login");
}

/**
 * A row can be signed by staff once the day is decided: times complete, or absent / excused.
 * Holidays (on the holiday list, or a row marked Holiday) are never signed.
 */
const NO_SIG = "Put your signature on file first (My account), then sign with one tap.";
const isHolidayRow = (e: Entry | null, holiday: boolean) => holiday || e?.status === "HOLIDAY";
const signable = (e: Entry | null, holiday: boolean) =>
  !isHolidayRow(e, holiday) && !!e && (e.status !== "PRESENT" || (!!e.startTime && !!e.endTime));

/** A present day with both times, the only kind of row a student signs. */
const needsStudentSig = (e: Entry | null) => !!e && e.status === "PRESENT" && !!e.startTime && !!e.endTime && !e.studentSignature;

/**
 * Staff signs many rows at once (the "Staff signature" column), with one drawing or their saved
 * signature. Rows already signed by staff are left alone. Holidays are skipped: no signatures.
 *
 * Staff can also add the student's signature on file, in the same step, to present rows that
 * don't have one (e.g. staff wrote the times because the student forgot to tap End). This is
 * recorded on the signature, in the row's history and in the audit log.
 */
export async function signRowsAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const staff = await requireStaff();
  const keys = z.array(z.string().regex(/^[0-9a-f-]{36}:\d{4}-\d{2}-\d{2}$/)).max(1000).safeParse(JSON.parse(String(fd.get("rows") ?? "[]")));
  if (!keys.success || !keys.data.length) return { error: "Choose the rows to sign." };
  if (!staff.signatureId) return { error: NO_SIG };
  const wantsStudentSig = fd.get("withStudentSignature") === "1";
  const { entries, students } = await cols();
  const dates = keys.data.map((k) => k.slice(37));
  const holidays = await holidaysBetween(dates.reduce((a, b) => (a < b ? a : b)), dates.reduce((a, b) => (a > b ? a : b)));
  const now = new Date();
  const sig = { id: staff.signatureId, at: now, staffId: staff._id, staffName: staff.name };
  let signed = 0, studentSigned = 0, holidaysSkipped = 0;
  const skipped: string[] = [];
  const noStudentSig: string[] = [];
  for (const key of new Set(keys.data)) {
    const [studentId, date] = [key.slice(0, 36), key.slice(37)];
    if (date > today()) { skipped.push(`${usDate(date)} is in the future`); continue; }
    const student = await students.findOne({ _id: studentId });
    if (!student || !canSee(staff, student)) { skipped.push(`${usDate(date)}: not one of your students`); continue; }
    if (!isClassDay(student, date)) { skipped.push(`${student.name} ${usDate(date)}: not a class day`); continue; }
    const holiday = holidays.get(date);
    const e = await entries.findOne({ _id: key });
    if (isHolidayRow(e, !!holiday)) { holidaysSkipped++; continue; }
    if (!signable(e, !!holiday)) { skipped.push(`${student.name} ${usDate(date)}: not finished`); continue; }
    if (wantsStudentSig && needsStudentSig(e)) {
      if (!student.signatureId) noStudentSig.push(student.name);
      else {
        // Both signatures in one write, and only if neither was added in the meantime.
        const studentSignature = { id: student.signatureId, at: now, addedBy: { staffId: staff._id, staffName: staff.name } };
        const res = await entries.updateOne(
          { _id: key, staffSignature: null, studentSignature: null },
          {
            $set: { staffSignature: sig, studentSignature, updatedAt: now },
            $push: { history: { at: now, byId: staff._id, byName: staff.name, what: "student signature on file added by staff", reason: "signed with staff signature" } },
          },
        );
        if (res.modifiedCount) {
          signed++; studentSigned++;
          await audit(staff._id, "staff.add_student_signature", key, { signatureId: student.signatureId });
          continue;
        }
      }
    }
    const res = await entries.updateOne({ _id: key, staffSignature: null }, { $set: { staffSignature: sig, updatedAt: now } });
    if (res.modifiedCount) signed++;
  }
  await audit(staff._id, "staff.sign_rows", "entries", { signed, studentSigned, skipped: skipped.length, holidaysSkipped });
  refresh();
  const list = (xs: string[]) => `${xs.slice(0, 5).join("; ")}${xs.length > 5 ? ` and ${xs.length - 5} more` : ""}`;
  const names = [...new Set(noStudentSig)];
  const extra =
    (studentSigned ? ` Added the student's signature to ${studentSigned} of them.` : "") +
    (names.length ? ` No signature on file for ${list(names)}, so their row${noStudentSig.length === 1 ? " has" : "s have"} no student signature yet.` : "") +
    (holidaysSkipped ? ` Holidays are left unsigned (${holidaysSkipped}).` : "") +
    (skipped.length ? ` Not signed: ${list(skipped)}.` : "");
  return signed ? { ok: true, message: `Signed ${signed} row${signed === 1 ? "" : "s"}.${extra}` } : { error: `Nothing was signed.${extra}` };
}

const ROW_KEY = /^[0-9a-f-]{36}:\d{4}-\d{2}-\d{2}$/;
type StaffDoc = Awaited<ReturnType<typeof requireStaff>>;

/**
 * Adds the student's signature on file to one row (a present day with both times, no student
 * signature yet), recorded as added by this staff member. Returns a message for this row.
 */
async function addStudentSignature(staff: StaffDoc, rowKey: string): Promise<{ ok: boolean; message: string }> {
  if (!ROW_KEY.test(rowKey)) return { ok: false, message: "Invalid row." };
  const [studentId, date] = [rowKey.slice(0, 36), rowKey.slice(37)];
  if (date > today()) return { ok: false, message: `${usDate(date)} is in the future.` };
  const { entries, students } = await cols();
  const student = await students.findOne({ _id: studentId });
  if (!student || !canSee(staff, student)) return { ok: false, message: "That student isn't in your courses." };
  if (!student.signatureId) return { ok: false, message: `${student.name} has no signature on file. Add it at the top of the sheet first.` };
  const e = await entries.findOne({ _id: rowKey });
  if (isHolidayRow(e, (await holidaysBetween(date, date)).has(date))) return { ok: false, message: `${usDate(date)} is a holiday: no signature needed.` };
  if (e?.studentSignature) return { ok: false, message: `${usDate(date)} already has the student's signature.` };
  if (!needsStudentSig(e)) return { ok: false, message: `${usDate(date)}: enter the start and end time first.` };
  const now = new Date();
  const res = await entries.updateOne(
    { _id: rowKey, studentSignature: null },
    {
      $set: { studentSignature: { id: student.signatureId, at: now, addedBy: { staffId: staff._id, staffName: staff.name } }, updatedAt: now },
      $push: { history: { at: now, byId: staff._id, byName: staff.name, what: "student signature on file added by staff", reason: "filled from the sheet" } },
    },
  );
  if (!res.modifiedCount) return { ok: false, message: `${usDate(date)} already has the student's signature.` };
  await audit(staff._id, "staff.add_student_signature", rowKey, { signatureId: student.signatureId });
  return { ok: true, message: `Student signature added for ${student.name}, ${usDate(date)}.` };
}

/** One tap in the "Student signature" cell: fill it with the student's signature on file. */
export async function fillStudentSignatureAction(rowKey: string): Promise<ActionState> {
  const staff = await requireStaff();
  const r = await addStudentSignature(staff, rowKey);
  if (r.ok) refresh();
  return r.ok ? { ok: true, message: r.message } : { error: r.message };
}

/** "Fill student signature on all rows": the same as tapping each cell. */
export async function fillStudentSignaturesAction(rowKeys: string[]): Promise<ActionState> {
  const staff = await requireStaff();
  const keys = z.array(z.string().regex(ROW_KEY)).min(1).max(100).safeParse(rowKeys);
  if (!keys.success) return { error: "Choose the rows to fill." };
  let added = 0;
  const problems: string[] = [];
  for (const k of new Set(keys.data)) {
    const r = await addStudentSignature(staff, k);
    if (r.ok) added++; else problems.push(r.message);
  }
  refresh();
  const extra = problems.length ? ` Not filled: ${problems.slice(0, 3).join(" ")}${problems.length > 3 ? ` and ${problems.length - 3} more.` : ""}` : "";
  return added ? { ok: true, message: `Student signature added to ${added} row${added === 1 ? "" : "s"}.${extra}` } : { error: `Nothing was filled.${extra}` };
}

/**
 * Swap the signature already on a row for the current one on file: the student's newest
 * signature, or this staff member's own (which also makes them the row's signer). Times are not
 * touched. The old and new signature are kept in the row's history and the audit log.
 */
export async function replaceRowSignatureAction(rowKey: string, which: "student" | "staff"): Promise<ActionState> {
  const staff = await requireStaff();
  if (!ROW_KEY.test(rowKey) || (which !== "student" && which !== "staff")) return { error: "Invalid row." };
  const [studentId, date] = [rowKey.slice(0, 36), rowKey.slice(37)];
  const { entries, students } = await cols();
  const student = await students.findOne({ _id: studentId });
  if (!student || !canSee(staff, student)) return { error: "That student isn't in your courses." };
  const e = await entries.findOne({ _id: rowKey });
  const now = new Date();
  if (which === "student") {
    if (!e?.studentSignature) return { error: "This row has no student signature to change. Use Fill with signature." };
    if (!student.signatureId) return { error: `${student.name} has no signature on file.` };
    if (e.studentSignature.id === student.signatureId) return { ok: true, message: "This row already uses the current signature." };
    const res = await entries.updateOne(
      { _id: rowKey, "studentSignature.id": e.studentSignature.id },
      {
        $set: { studentSignature: { id: student.signatureId, at: now, addedBy: { staffId: staff._id, staffName: staff.name } }, updatedAt: now },
        $push: { history: { at: now, byId: staff._id, byName: staff.name, what: "student signature changed to the one on file", reason: "updated from the sheet" } },
      },
    );
    if (!res.modifiedCount) return { error: "The row changed in the meantime. Try again." };
    await audit(staff._id, "staff.replace_student_signature", rowKey, { from: e.studentSignature.id, to: student.signatureId });
  } else {
    if (!staff.signatureId) return { error: NO_SIG };
    if (!e?.staffSignature) return { error: "This row isn't signed by staff yet. Use Fill with my signature." };
    if (e.staffSignature.id === staff.signatureId) return { ok: true, message: "This row already has your current signature." };
    const res = await entries.updateOne(
      { _id: rowKey, "staffSignature.id": e.staffSignature.id },
      {
        $set: { staffSignature: { id: staff.signatureId, at: now, staffId: staff._id, staffName: staff.name }, updatedAt: now },
        $push: { history: { at: now, byId: staff._id, byName: staff.name, what: `staff signature changed (was ${e.staffSignature.staffName})`, reason: "re-signed from the sheet" } },
      },
    );
    if (!res.modifiedCount) return { error: "The row changed in the meantime. Try again." };
    await audit(staff._id, "staff.replace_staff_signature", rowKey, { from: e.staffSignature.id, fromStaff: e.staffSignature.staffId, to: staff.signatureId });
  }
  refresh();
  return { ok: true, message: `${usDate(date)}: signature updated.` };
}

/**
 * Staff corrects a row: status, times, note. A change to a row that already had values needs a
 * reason, is kept in the row's history, and removes the staff signature so the row is signed again.
 */
export async function editRowAction(studentId: string, date: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const staff = await requireStaff();
  if (!z.string().uuid().safeParse(studentId).success || !DATE_RE.test(date)) return { error: "Invalid row." };
  if (date > today()) return { error: "You can't fill in a future date." };
  const status = z.enum(["PRESENT", "ABSENT", "EXCUSED", "HOLIDAY"]).safeParse(fd.get("status"));
  if (!status.success) return { fieldErrors: { status: "Choose a status" } };
  const startTime = String(fd.get("startTime") ?? "").trim() || null;
  const endTime = String(fd.get("endTime") ?? "").trim() || null;
  const note = String(fd.get("note") ?? "").trim().slice(0, 200);
  const reason = String(fd.get("reason") ?? "").trim().slice(0, 200);
  let minutes: number | null = null;
  if (status.data === "PRESENT") {
    if (!startTime || !TIME_RE.test(startTime)) return { fieldErrors: { startTime: "Enter the start time" } };
    if (endTime && !TIME_RE.test(endTime)) return { fieldErrors: { endTime: "Enter a valid end time" } };
    if (endTime) {
      minutes = minutesBetween(startTime, endTime);
      if (minutes === null) return { fieldErrors: { endTime: "End must be after start" } };
    }
  }
  const { entries, students } = await cols();
  const student = await students.findOne({ _id: studentId });
  if (!student || !canSee(staff, student)) return { error: "That student isn't in your courses." };
  if (!isClassDay(student, date)) return { error: "That isn't one of this student's class days." };
  const id = `${studentId}:${date}`;
  const before = await entries.findOne({ _id: id });
  const present = status.data === "PRESENT";
  const after = { status: status.data, startTime: present ? startTime : null, endTime: present ? endTime : null, minutes, note };
  const changed = !before || before.status !== after.status || before.startTime !== after.startTime || before.endTime !== after.endTime || (before.note ?? "") !== note;
  if (!changed) return { ok: true, message: "Nothing changed." };
  const hadValues = !!before && (!!before.startTime || before.status !== "PRESENT" || !!before.staffSignature);
  if (hadValues && reason.length < 3) return { fieldErrors: { reason: "Say why you're changing this row" } };
  const now = new Date();
  const what = `${before ? `${before.status} ${time12(before.startTime)}-${time12(before.endTime)}` : "empty"} → ${after.status} ${time12(after.startTime)}-${time12(after.endTime)}`;
  await entries.updateOne(
    { _id: id },
    {
      $set: {
        ...after, staffSignature: null, updatedAt: now,
        // A time written by staff wasn't typed late by the student, so its late-entry flag goes.
        ...(before?.startTime !== after.startTime ? { startLateBy: null } : {}),
        ...(before?.endTime !== after.endTime ? { endLateBy: null } : {}),
      },
      $setOnInsert: { studentId, date, startAt: null, endAt: null, studentSignature: null },
      $push: { history: { at: now, byId: staff._id, byName: staff.name, what, reason: reason || "filled in by staff" } },
    },
    { upsert: true },
  );
  await audit(staff._id, "staff.edit_row", id, { before: before ? { status: before.status, startTime: before.startTime, endTime: before.endTime } : null, after, reason });
  refresh();
  return { ok: true, message: `${student.name}, ${usDate(date)} saved. Sign the row again.` };
}

/** End of day: every listed student with no start time is marked absent. */
export async function markAbsentAction(date: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const staff = await requireStaff();
  if (!DATE_RE.test(date) || date > today()) return { error: "Invalid date." };
  if ((await holidaysBetween(date, date)).get(date)) return { error: "That date is a holiday." };
  const ids = z.array(z.string().uuid()).max(1000).safeParse(JSON.parse(String(fd.get("students") ?? "[]")));
  if (!ids.success || !ids.data.length) return { error: "No students to mark." };
  const { entries, students } = await cols();
  const now = new Date();
  let marked = 0;
  for (const s of await students.find({ _id: { $in: ids.data } }).toArray()) {
    if (!canSee(staff, s) || !isClassDay(s, date)) continue;
    const res = await entries.updateOne(
      { _id: `${s._id}:${date}` },
      {
        $setOnInsert: {
          studentId: s._id, date, status: "ABSENT" as EntryStatus, startAt: null, endAt: null, startTime: null, endTime: null, minutes: null,
          studentSignature: null, staffSignature: null, note: "", updatedAt: now,
          history: [{ at: now, byId: staff._id, byName: staff.name, what: "marked absent", reason: "no start time" }],
        },
      },
      { upsert: true },
    );
    if (res.upsertedCount) marked++;
  }
  await audit(staff._id, "staff.mark_absent", date, { marked });
  refresh();
  return { ok: true, message: `${marked} student${marked === 1 ? "" : "s"} marked absent.` };
}

/** The "Approved by" block: staff name, position, signature and comments for the month. */
export async function approveMonthAction(studentId: string, month: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const staff = await requireStaff();
  if (!z.string().uuid().safeParse(studentId).success || !MONTH_RE.test(month) || month > thisMonth()) return { error: "Invalid month." };
  if (!staff.signatureId) return { error: NO_SIG };
  const student = await (await cols()).students.findOne({ _id: studentId });
  if (!student || !canSee(staff, student)) return { error: "That student isn't in your courses." };
  const comments = String(fd.get("comments") ?? "").trim().slice(0, 600);
  const { entries, approvals } = await cols();
  const list = await entries.find({ studentId, date: { $gte: `${month}-01`, $lte: `${month}-31` } }).toArray();
  if (!list.length) return { error: "There is nothing to approve for this month yet." };
  const now = new Date();
  await approvals.updateOne(
    { _id: `${studentId}:${month}` },
    { $set: { studentId, month, staffId: staff._id, staffName: staff.name, position: staff.position, signatureId: staff.signatureId, comments, entriesHash: entriesHash(list), signedAt: now } },
    { upsert: true },
  );
  await audit(staff._id, "staff.approve_month", `${studentId}:${month}`, { rows: list.length });
  refresh();
  return { ok: true, message: "Month approved." };
}

/** Staff put their own signature on file (uploaded photo or drawn). A new one replaces it for future rows only. */
export async function saveMySignatureAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const staff = await requireStaff();
  const checked = checkSignaturePng(fd.get("signature"));
  if ("error" in checked) return { error: checked.error };
  const id = await saveSignature("STAFF", staff._id, checked.png, fd.get("source") === "UPLOAD" ? "UPLOAD" : "DRAWN", staff._id);
  await (await cols()).staff.updateOne({ _id: staff._id }, { $set: { signatureId: id } });
  await audit(staff._id, "staff.signature_on_file", staff._id, { signatureId: id });
  refresh();
  return { ok: true, message: "Signature on file. You can now sign rows and approve months with one tap." };
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
"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { audit, cols, newId, rateLimit, type Entry, type EntryStatus, type RowComment } from "@/lib/db";
import { endStaffSession, requireStaff, startStaffSession } from "@/lib/auth";
import { holidaysBetween, thisMonth, today } from "@/lib/data";
import { DATE_RE, MONTH_RE, TIME_RE, addDays, isClassDay, minutesBetween, time12, usDate } from "@/lib/sheet";
import { entriesHash } from "@/lib/hash";
import { canSee } from "@/lib/access";
import { checkNotePng, checkSignaturePng, saveSignature } from "@/lib/signatures";
import { editWindowDays, isLocked, lockedFor } from "@/lib/policy";
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
const NO_SIG = "Sign by hand, or put your signature on file (My account) to sign with one tap.";
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
  // Signed by hand just now, or with the signature on file.
  const rawHand = String(fd.get("signature") ?? "");
  const hand = rawHand ? checkSignaturePng(rawHand) : null;
  if (hand && "error" in hand) return { error: hand.error };
  if (!hand && !staff.signatureId) return { error: NO_SIG };
  const wantsStudentSig = fd.get("withStudentSignature") === "1";
  const { entries, students } = await cols();
  const dates = keys.data.map((k) => k.slice(37));
  const holidays = await holidaysBetween(dates.reduce((a, b) => (a < b ? a : b)), dates.reduce((a, b) => (a > b ? a : b)));
  const now = new Date();
  const sigId = hand ? await saveSignature("STAFF", staff._id, hand.png, "DRAWN", staff._id) : staff.signatureId!;
  const sig = { id: sigId, at: now, staffId: staff._id, staffName: staff.name };
  let locked = 0;
  let signed = 0, studentSigned = 0, holidaysSkipped = 0;
  const skipped: string[] = [];
  const noStudentSig: string[] = [];
  for (const key of new Set(keys.data)) {
    const [studentId, date] = [key.slice(0, 36), key.slice(37)];
    if (date > today()) { skipped.push(`${usDate(date)} is in the future`); continue; }
    if (lockedFor(staff, date)) { locked++; continue; }
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
  await audit(staff._id, "staff.sign_rows", "entries", { signed, studentSigned, skipped: skipped.length, holidaysSkipped, locked, handwritten: !!hand, signatureId: sigId });
  refresh();
  const list = (xs: string[]) => `${xs.slice(0, 5).join("; ")}${xs.length > 5 ? ` and ${xs.length - 5} more` : ""}`;
  const names = [...new Set(noStudentSig)];
  const extra =
    (studentSigned ? ` Added the student's signature to ${studentSigned} of them.` : "") +
    (names.length ? ` No signature on file for ${list(names)}, so their row${noStudentSig.length === 1 ? " has" : "s have"} no student signature yet.` : "") +
    (holidaysSkipped ? ` Holidays are left unsigned (${holidaysSkipped}).` : "") +
    (locked ? ` ${locked} row${locked === 1 ? " is" : "s are"} older than ${editWindowDays()} days and locked: ask an admin.` : "") +
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
  const lock = lockedFor(staff, date);
  if (lock) return { ok: false, message: lock };
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
  // Signatures on locked rows are history: they are never swapped, by anyone. To change such a row
  // an admin edits it (with a reason), which is recorded.
  if (isLocked(date)) return { error: `${usDate(date)} is locked, so its signatures are kept as they are. An admin can edit the row if it's wrong.` };
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
    // Only your own older signature is updated. Someone else's validation stays theirs.
    if (e.staffSignature.staffId !== staff._id) return { error: `This row was signed by ${e.staffSignature.staffName}. Their signature is kept.` };
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
  const lock = lockedFor(staff, date);
  if (lock) return { error: lock };
  const { entries, students } = await cols();
  const student = await students.findOne({ _id: studentId });
  if (!student || !canSee(staff, student)) return { error: "That student isn't in your courses." };
  if (!isClassDay(student, date)) return { error: "That isn't one of this student's class days." };
  const id = `${studentId}:${date}`;
  const lockedRow = isLocked(date);
  const before = await entries.findOne({ _id: id });
  const present = status.data === "PRESENT";
  const after = { status: status.data, startTime: present ? startTime : null, endTime: present ? endTime : null, minutes, note };
  const changed = !before || before.status !== after.status || before.startTime !== after.startTime || before.endTime !== after.endTime || (before.note ?? "") !== note;
  if (!changed) return { ok: true, message: "Nothing changed." };
  const hadValues = !!before && (!!before.startTime || before.status !== "PRESENT" || !!before.staffSignature);
  if ((hadValues || lockedRow) && reason.length < 3) return { fieldErrors: { reason: lockedRow ? "This row is locked. Say why you're changing it" : "Say why you're changing this row" } };
  const now = new Date();
  const what = `${before ? `${before.status} ${time12(before.startTime)}-${time12(before.endTime)}` : "empty"} → ${after.status} ${time12(after.startTime)}-${time12(after.endTime)}`;
  await entries.updateOne(
    { _id: id },
    {
      $set: {
        ...after, staffSignature: null, updatedAt: now,
        // A time written by staff wasn't typed late by the student, so its late-entry flag goes.
        // The student's handwritten time no longer matches either, so the sheet shows staff's time.
        ...(before?.startTime !== after.startTime ? { startLateBy: null, startInkId: null } : {}),
        ...(before?.endTime !== after.endTime ? { endLateBy: null, endInkId: null } : {}),
      },
      $setOnInsert: { studentId, date, startAt: null, endAt: null, studentSignature: null, comments: [] },
      $push: { history: { at: now, byId: staff._id, byName: staff.name, what, reason: reason || "filled in by staff" } },
    },
    { upsert: true },
  );
  await audit(staff._id, lockedRow ? "admin.edit_locked_row" : "staff.edit_row", id, {
    before: before ? { status: before.status, startTime: before.startTime, endTime: before.endTime, staffSignature: before.staffSignature ?? null } : null, after, reason,
  });
  refresh();
  return { ok: true, message: `${student.name}, ${usDate(date)} saved. Sign the row again.` };
}

/** End of day: every listed student with no start time is marked absent. */
export async function markAbsentAction(date: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const staff = await requireStaff();
  if (!DATE_RE.test(date) || date > today()) return { error: "Invalid date." };
  const lock = lockedFor(staff, date);
  if (lock) return { error: lock };
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
          studentSignature: null, staffSignature: null, note: "", updatedAt: now, comments: [],
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

/**
 * The "Approved by" block: staff name, position, signature (on file, or signed by hand now) and
 * comments (typed and/or handwritten) for the month. An approval made by someone else (for example
 * historical approvals) can only be replaced by an admin.
 */
export async function approveMonthAction(studentId: string, month: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const staff = await requireStaff();
  if (!z.string().uuid().safeParse(studentId).success || !MONTH_RE.test(month) || month > thisMonth()) return { error: "Invalid month." };
  const rawHand = String(fd.get("signature") ?? "");
  const hand = rawHand ? checkSignaturePng(rawHand) : null;
  if (hand && "error" in hand) return { error: hand.error };
  if (!hand && !staff.signatureId) return { error: NO_SIG };
  const rawInk = String(fd.get("commentsInk") ?? "");
  const ink = rawInk ? checkNotePng(rawInk) : null;
  if (ink && "error" in ink) return { error: ink.error };
  const student = await (await cols()).students.findOne({ _id: studentId });
  if (!student || !canSee(staff, student)) return { error: "That student isn't in your courses." };
  const comments = String(fd.get("comments") ?? "").trim().slice(0, 600);
  const { entries, approvals } = await cols();
  const list = await entries.find({ studentId, date: { $gte: `${month}-01`, $lte: `${month}-31` } }).toArray();
  if (!list.length) return { error: "There is nothing to approve for this month yet." };
  const existing = await approvals.findOne({ _id: `${studentId}:${month}` });
  if (existing && existing.staffId !== staff._id && staff.role !== "ADMIN") {
    return { error: `This month was approved by ${existing.staffName}. Only an admin can replace their approval.` };
  }
  const signatureId = hand ? await saveSignature("STAFF", staff._id, hand.png, "DRAWN", staff._id) : staff.signatureId!;
  const commentsInkId = ink ? await saveSignature("STAFF", staff._id, ink.png, "DRAWN", staff._id, "NOTE") : null;
  const now = new Date();
  // Only replace the approval we looked at, so two people approving at once can't overwrite each other unseen.
  const res = await approvals.updateOne(
    existing ? { _id: existing._id, signedAt: existing.signedAt } : { _id: `${studentId}:${month}` },
    { $set: { studentId, month, staffId: staff._id, staffName: staff.name, position: staff.position, signatureId, comments, commentsInkId, entriesHash: entriesHash(list), signedAt: now } },
    { upsert: !existing },
  );
  if (existing && !res.matchedCount) return { error: "Someone else approved this month just now. Reload the page." };
  await audit(staff._id, "staff.approve_month", `${studentId}:${month}`, {
    rows: list.length, handwritten: !!hand, handwrittenComments: !!commentsInkId,
    replaced: existing ? { staffId: existing.staffId, staffName: existing.staffName, signatureId: existing.signatureId, signedAt: existing.signedAt } : null,
  });
  refresh();
  return { ok: true, message: "Month approved." };
}

/**
 * A comment on one row (typed, handwritten, or both). Comments are added to the row, never edited,
 * and don't touch its times or signatures. Teachers can comment while the row is open; admins any time.
 */
export async function addCommentAction(rowKey: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const staff = await requireStaff();
  if (!ROW_KEY.test(rowKey)) return { error: "Invalid row." };
  const [studentId, date] = [rowKey.slice(0, 36), rowKey.slice(37)];
  const lock = lockedFor(staff, date);
  if (lock) return { error: lock };
  const text = String(fd.get("text") ?? "").trim().slice(0, 500);
  const rawInk = String(fd.get("ink") ?? "");
  const ink = rawInk ? checkNotePng(rawInk) : null;
  if (ink && "error" in ink) return { error: ink.error };
  if (!text && !ink) return { error: "Type or write a comment first." };
  const { entries, students } = await cols();
  const student = await students.findOne({ _id: studentId });
  if (!student || !canSee(staff, student)) return { error: "That student isn't in your courses." };
  const e = await entries.findOne({ _id: rowKey }, { projection: { comments: 1 } });
  if (!e) return { error: "Nothing is recorded for this day yet. Use Edit to record it, then add a comment." };
  if ((e.comments?.length ?? 0) >= 50) return { error: "This row has too many comments." };
  const inkId = ink ? await saveSignature("STAFF", staff._id, ink.png, "DRAWN", staff._id, "NOTE") : null;
  const c: RowComment = { id: newId(), at: new Date(), byId: staff._id, byName: staff.name, byRole: staff.role, text, inkId };
  await entries.updateOne({ _id: rowKey }, { $push: { comments: c } });
  await audit(staff._id, "staff.comment", rowKey, { commentId: c.id, handwritten: !!inkId });
  refresh();
  return { ok: true, message: `Comment added to ${usDate(date)}.` };
}

/**
 * A day off for one class (a course): every student of the course with class that day gets the day
 * marked Holiday (or Excused) with a note. Days a student has already started are left alone.
 * "Remove" takes the mark off again where nothing else was recorded. Teachers: their own courses,
 * and not on locked days. Future days are allowed (up to a year ahead) so a closure can be planned.
 */
export async function markCourseDayAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const staff = await requireStaff();
  const date = String(fd.get("date") ?? "");
  const course = String(fd.get("course") ?? "").trim();
  const mode = z.enum(["HOLIDAY", "EXCUSED", "REMOVE"]).safeParse(fd.get("status"));
  const note = String(fd.get("note") ?? "").trim().slice(0, 120);
  if (!DATE_RE.test(date)) return { fieldErrors: { date: "Choose a date" } };
  if (date > addDays(today(), 366)) return { fieldErrors: { date: "Choose a date within the next year" } };
  if (!course) return { fieldErrors: { course: "Choose a class" } };
  if (!mode.success) return { fieldErrors: { status: "Choose what to mark" } };
  if (mode.data !== "REMOVE" && note.length < 2) return { fieldErrors: { note: "Add a short note (it's written on the sheet)" } };
  if (staff.role !== "ADMIN" && !staff.courses.includes(course)) return { error: "That class isn't one of yours." };
  const lock = lockedFor(staff, date);
  if (lock) return { error: lock };
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
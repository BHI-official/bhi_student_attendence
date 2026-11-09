"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { audit, cols, isDuplicateKey, newId, rateLimit, type Entry, type RowComment } from "@/lib/db";
import { currentStudent, endStudentSession, startStudentSession } from "@/lib/auth";
import { env } from "@/lib/env";
import { holidaysBetween, schoolMinutes, timeRules } from "@/lib/data";
import { DATE_RE, checkTypedTime, isClassDay, minutesBetween, time12, todayIn, usDate } from "@/lib/sheet";
import { checkNotePng, checkSignaturePng, saveSignature } from "@/lib/signatures";
import { isLocked } from "@/lib/policy";
import type { ActionState } from "@/lib/action";

/** Student taps their name, then enters their PIN. */
export async function pinSignInAction(studentId: string, _: ActionState, fd: FormData): Promise<ActionState> {
  if (!z.string().uuid().safeParse(studentId).success) return { error: "Choose your name again." };
  const pin = String(fd.get("pin") ?? "");
  if (!/^\d{4,6}$/.test(pin)) return { error: "Enter your PIN (4 to 6 digits)." };
  // 5 tries per 15 minutes for each student: plenty for typos, useless for guessing.
  if (!(await rateLimit(`pin:${studentId}`, 5, 900))) return { error: "Too many wrong tries. Ask a staff member, or wait 15 minutes." };
  const student = await (await cols()).students.findOne({ _id: studentId, active: true });
  if (!student || !(await bcrypt.compare(pin, student.pinHash))) return { error: "That PIN isn't right. Try again." };
  await startStudentSession(student._id);
  redirect("/student/sheet");
}

export async function studentSignOutAction() {
  await endStudentSession();
  redirect("/student");
}

/**
 * Checks the student may write on today's row. Everything uses one instant (`now`), so the date and
 * the clock can't disagree around midnight. Returns the student and today, or an error.
 */
async function todayFor(now: Date) {
  const student = await currentStudent();
  if (!student) return { error: "You were signed out. Find your name again." } as const;
  const date = todayIn(env().APP_TIMEZONE, now);
  if (!isClassDay(student, date)) return { error: "You don't have class today." } as const;
  const holiday = (await holidaysBetween(date, date)).get(date);
  if (holiday) return { error: `Today is a holiday (${holiday}).` } as const;
  return { student, date, id: `${student._id}:${date}` } as const;
}

/**
 * "Start": the student types the time they arrived. The server checks it against its own clock
 * (no future times, nothing older than the allowed window) and writes it once. The exact moment
 * it was saved is kept too, so staff can see when it was entered.
 */
export async function studentStartAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const now = new Date();
  const t = await todayFor(now);
  if ("error" in t) return { error: t.error };
  if (!(await rateLimit(`time:${t.student._id}`, 30, 600))) return { error: "Too many tries. Wait a few minutes, or ask a staff member." };
  const checked = checkTypedTime("start", fd.get("time"), schoolMinutes(now), timeRules());
  if (!checked.ok) return { error: checked.error, fieldErrors: { time: checked.error } };
  const { entries } = await cols();
  const startTime = checked.time;
  const fresh: Entry = {
    _id: t.id, studentId: t.student._id, date: t.date, status: "PRESENT", startAt: now, endAt: null, startTime, endTime: null, minutes: null,
    startLateBy: checked.lateBy, endLateBy: null,
    studentSignature: null, staffSignature: null, note: "", history: [], comments: [], updatedAt: now,
  };
  try {
    await entries.insertOne(fresh);
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;
    // A row already exists: staff may have marked the day (e.g. absent before the student arrived).
    const res = await entries.updateOne(
      // A day staff marked as a holiday for the class stays closed.
      { _id: t.id, startTime: null, staffSignature: null, status: { $ne: "HOLIDAY" } },
      {
        $set: { status: "PRESENT", startAt: now, startTime, startLateBy: checked.lateBy, updatedAt: now },
        $push: { history: { at: now, byId: t.student._id, byName: t.student.name, what: `start ${startTime}`, reason: "entered by student" } },
      },
    );
    if (!res.modifiedCount) {
      const e2 = await entries.findOne({ _id: t.id });
      if (e2?.startTime) return { ok: true, message: `Your start time is already on the sheet: ${time12(e2.startTime)}.` };
      if (e2?.status === "HOLIDAY") return { error: `Today is marked as a holiday for your class${e2.note ? ` (${e2.note})` : ""}. Ask a staff member if that's wrong.` };
      return { error: "Today's row is already signed by staff. Ask a staff member." };
    }
  }
  await audit(t.student._id, "student.start", t.id, { typed: startTime, savedAt: now.toISOString(), lateBy: checked.lateBy });
  revalidatePath("/student/sheet");
  return { ok: true, message: `Start time written: ${time12(startTime)}.` };
}

/**
 * Saves the student's handwritten signature for one row. The first signature a student writes is
 * also kept on file, so staff can add it for them on a day they forgot to sign.
 */
async function saveDailySignature(student: { _id: string; signatureId: string | null }, png: string) {
  const id = await saveSignature("STUDENT", student._id, png, "DRAWN", student._id);
  if (!student.signatureId) await (await cols()).students.updateOne({ _id: student._id, signatureId: null }, { $set: { signatureId: id } });
  return id;
}

/**
 * "End" at the end of class: the student types the time they left and signs by hand. The server
 * checks the time (after the start, not before the start was entered, not in the future, within the
 * window, a sensible length), then writes the end time, the hours and the student's handwritten
 * signature. Once.
 */
export async function studentFillAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const now = new Date();
  const t = await todayFor(now);
  if ("error" in t) return { error: t.error };
  if (!(await rateLimit(`time:${t.student._id}`, 30, 600))) return { error: "Too many tries. Wait a few minutes, or ask a staff member." };
  const { entries } = await cols();
  const entry = await entries.findOne({ _id: t.id });
  if (!entry || entry.status !== "PRESENT") return { error: entry ? `Today is marked ${entry.status.toLowerCase()}. Ask a staff member.` : "Enter your start time first." };
  if (!entry.startTime) return { error: "Enter your start time first." };
  if (entry.endTime) return { ok: true, message: `Today is already filled (ended ${time12(entry.endTime)}).` };
  const checked = checkTypedTime("end", fd.get("time"), schoolMinutes(now), timeRules(), {
    time: entry.startTime,
    enteredAtMinutes: entry.startAt && todayIn(env().APP_TIMEZONE, entry.startAt) === t.date ? schoolMinutes(entry.startAt) : null,
  });
  if (!checked.ok) return { error: checked.error, fieldErrors: { time: checked.error } };
  const sig = checkSignaturePng(fd.get("signature"));
  if ("error" in sig) return { error: "Sign in the box before saving.", fieldErrors: { signature: sig.error } };
  const endTime = checked.time;
  const minutes = minutesBetween(entry.startTime, endTime);
  if (minutes === null) return { error: "Your end time must be after your start time." };
  const signatureId = await saveDailySignature(t.student, sig.png);
  const res = await entries.updateOne(
    { _id: t.id, endTime: null, startTime: entry.startTime, status: "PRESENT", staffSignature: null },
    { $set: { endAt: now, endTime, minutes, endLateBy: checked.lateBy, studentSignature: { id: signatureId, at: now }, updatedAt: now } },
  );
  if (!res.modifiedCount) return { error: "Today's row changed. Reload the page." };
  await audit(t.student._id, "student.fill", t.id, { typed: endTime, savedAt: now.toISOString(), lateBy: checked.lateBy, minutes, signatureId });
  revalidatePath("/student/sheet");
  return { ok: true, message: `Done for today: ${time12(entry.startTime)} to ${time12(endTime)}, signed.` };
}

/**
 * The student signs one of their own rows by hand, when the times are there but their signature
 * isn't (for example staff wrote the end time because the student forgot). Only while the row is
 * still open (the editing window) and before staff have validated it.
 */
export async function studentSignRowAction(date: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const student = await currentStudent();
  if (!student) return { error: "You were signed out. Find your name again." };
  if (!DATE_RE.test(date)) return { error: "Invalid day." };
  if (date > todayIn(env().APP_TIMEZONE)) return { error: "You can't sign a day that hasn't happened yet." };
  if (isLocked(date)) return { error: `${usDate(date)} is locked. Ask a staff member.` };
  if (!(await rateLimit(`time:${student._id}`, 30, 600))) return { error: "Too many tries. Wait a few minutes, or ask a staff member." };
  const sig = checkSignaturePng(fd.get("signature"));
  if ("error" in sig) return { error: sig.error };
  const id = `${student._id}:${date}`;
  const { entries } = await cols();
  const e = await entries.findOne({ _id: id });
  if (!e || e.status !== "PRESENT" || !e.startTime || !e.endTime) return { error: "This day needs a start and end time before you sign it." };
  if (e.studentSignature) return { ok: true, message: "This day is already signed." };
  if (e.staffSignature) return { error: "Staff have already signed this day. Ask a staff member." };
  const signatureId = await saveDailySignature(student, sig.png);
  const now = new Date();
  const res = await entries.updateOne(
    { _id: id, studentSignature: null, staffSignature: null, status: "PRESENT", startTime: e.startTime, endTime: e.endTime },
    {
      $set: { studentSignature: { id: signatureId, at: now }, updatedAt: now },
      $push: { history: { at: now, byId: student._id, byName: student.name, what: "signed by student", reason: "signed by hand" } },
    },
  );
  if (!res.modifiedCount) return { error: "This day changed. Reload the page." };
  await audit(student._id, "student.sign_row", id, { signatureId });
  revalidatePath("/student/sheet");
  return { ok: true, message: `${usDate(date)} signed.` };
}

/** The student adds a note to today's row: typed, handwritten, or both. */
export async function studentCommentAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const now = new Date();
  const t = await todayFor(now);
  if ("error" in t) return { error: t.error };
  if (!(await rateLimit(`comment:${t.student._id}`, 20, 600))) return { error: "Too many notes. Wait a few minutes." };
  const text = String(fd.get("text") ?? "").trim().slice(0, 500);
  const rawInk = String(fd.get("ink") ?? "");
  const ink = rawInk ? checkNotePng(rawInk) : null;
  if (ink && "error" in ink) return { error: ink.error };
  if (!text && !ink) return { error: "Type or write a note first." };
  const { entries } = await cols();
  const e = await entries.findOne({ _id: t.id }, { projection: { comments: 1 } });
  if (!e) return { error: "Enter your start time first, then add a note." };
  if ((e.comments?.length ?? 0) >= 50) return { error: "This day has too many notes." };
  const inkId = ink ? await saveSignature("STUDENT", t.student._id, ink.png, "DRAWN", t.student._id, "NOTE") : null;
  const c: RowComment = { id: newId(), at: now, byId: t.student._id, byName: t.student.name, byRole: "STUDENT", text, inkId };
  await entries.updateOne({ _id: t.id }, { $push: { comments: c } });
  await audit(t.student._id, "student.comment", t.id, { commentId: c.id, handwritten: !!inkId });
  revalidatePath("/student/sheet");
  return { ok: true, message: "Note added to today." };
}

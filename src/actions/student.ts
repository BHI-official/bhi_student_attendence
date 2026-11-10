"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { audit, cols, isDuplicateKey, newId, rateLimit, type Entry, type RowComment } from "@/lib/db";
import { currentStudent, endStudentSession, startStudentSession } from "@/lib/auth";
import { env } from "@/lib/env";
import { holidaysBetween, schoolMinutes, timeRules } from "@/lib/data";
import { DATE_RE, checkPastDayTimes, checkTypedTime, hoursText, isClassDay, minutesBetween, time12, todayIn, usDate } from "@/lib/sheet";
import { checkNotePng, checkSignaturePng, checkTimePng, saveSignature } from "@/lib/signatures";
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

/** The school clock right now, as "HH:MM". Handwritten times are recorded against this. */
const clockNow = (now: Date) => {
  const m = schoolMinutes(now);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

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
 * "Start": the student writes the time they arrived by hand, like on the paper sheet. The
 * handwriting is what the sheet shows; the server records its own clock reading with it, and the
 * hours are worked out from that, so nothing the student writes can change the hours. Once.
 */
export async function studentStartAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const now = new Date();
  const t = await todayFor(now);
  if ("error" in t) return { error: t.error };
  if (!(await rateLimit(`time:${t.student._id}`, 30, 600))) return { error: "Too many tries. Wait a few minutes, or ask a staff member." };
  const ink = checkTimePng(fd.get("timeInk"));
  if ("error" in ink) return { error: ink.error, fieldErrors: { timeInk: ink.error } };
  const checked = checkTypedTime("start", clockNow(now), schoolMinutes(now), timeRules());
  if (!checked.ok) return { error: checked.error, fieldErrors: { time: checked.error } };
  const { entries } = await cols();
  const startTime = checked.time;
  const startInkId = await saveSignature("STUDENT", t.student._id, ink.png, "DRAWN", t.student._id, "TIME");
  const fresh: Entry = {
    _id: t.id, studentId: t.student._id, date: t.date, status: "PRESENT", startAt: now, endAt: null, startTime, endTime: null, minutes: null,
    startInkId, endInkId: null,
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
        $set: { status: "PRESENT", startAt: now, startTime, startInkId, startLateBy: checked.lateBy, updatedAt: now },
        $push: { history: { at: now, byId: t.student._id, byName: t.student.name, what: `start ${startTime}`, reason: "written by student" } },
      },
    );
    if (!res.modifiedCount) {
      const e2 = await entries.findOne({ _id: t.id });
      if (e2?.startTime) return { ok: true, message: `Your start time is already on the sheet: ${time12(e2.startTime)}.` };
      if (e2?.status === "HOLIDAY") return { error: `Today is marked as a holiday for your class${e2.note ? ` (${e2.note})` : ""}. Ask a staff member if that's wrong.` };
      return { error: "Your teacher has already signed today's row. Ask a staff member." };
    }
  }
  await audit(t.student._id, "student.start", t.id, { clock: startTime, startInkId, savedAt: now.toISOString() });
  revalidatePath("/student/sheet");
  return { ok: true, message: `Start time written (school clock ${time12(startTime)}).` };
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
 * "End" at the end of class: the student writes the time they leave by hand and signs. The server
 * records its own clock reading as the end time (checked: after the start, a sensible length),
 * then writes it with the handwritten time, the hours and the student's signature. Once.
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
  const ink = checkTimePng(fd.get("timeInk"));
  if ("error" in ink) return { error: ink.error, fieldErrors: { timeInk: ink.error } };
  const checked = checkTypedTime("end", clockNow(now), schoolMinutes(now), timeRules(), {
    time: entry.startTime,
    enteredAtMinutes: entry.startAt && todayIn(env().APP_TIMEZONE, entry.startAt) === t.date ? schoolMinutes(entry.startAt) : null,
  });
  if (!checked.ok) return { error: checked.error, fieldErrors: { time: checked.error } };
  const sig = checkSignaturePng(fd.get("signature"));
  if ("error" in sig) return { error: "Sign in the box before saving.", fieldErrors: { signature: sig.error } };
  const endTime = checked.time;
  const minutes = minutesBetween(entry.startTime, endTime);
  if (minutes === null) return { error: "Your end time must be after your start time." };
  const endInkId = await saveSignature("STUDENT", t.student._id, ink.png, "DRAWN", t.student._id, "TIME");
  const signatureId = await saveDailySignature(t.student, sig.png);
  const res = await entries.updateOne(
    { _id: t.id, endTime: null, startTime: entry.startTime, status: "PRESENT", staffSignature: null },
    { $set: { endAt: now, endTime, endInkId, minutes, endLateBy: checked.lateBy, studentSignature: { id: signatureId, at: now }, updatedAt: now } },
  );
  if (!res.modifiedCount) return { error: "Today's row changed. Reload the page." };
  await audit(t.student._id, "student.fill", t.id, { clock: endTime, endInkId, savedAt: now.toISOString(), minutes, signatureId });
  revalidatePath("/student/sheet");
  return { ok: true, message: `Done for today: ${hoursText(minutes)} hours, signed.` };
}

/**
 * The student writes their start or end time again, after saving it, because they wrote the wrong
 * time. Only today, and only until staff have signed the row. Only the handwriting changes: the
 * school clock time and the hours stay as recorded. The earlier handwriting is kept (images are
 * never deleted) and the change goes in the row's history and the audit log, so staff can see it.
 */
export async function studentRewriteTimeAction(which: "start" | "end", _: ActionState, fd: FormData): Promise<ActionState> {
  if (which !== "start" && which !== "end") return { error: "Invalid time." };
  const now = new Date();
  const t = await todayFor(now);
  if ("error" in t) return { error: t.error };
  if (!(await rateLimit(`time:${t.student._id}`, 30, 600))) return { error: "Too many tries. Wait a few minutes, or ask a staff member." };
  const ink = checkTimePng(fd.get("timeInk"));
  if ("error" in ink) return { error: ink.error, fieldErrors: { timeInk: ink.error } };
  const { entries } = await cols();
  const e = await entries.findOne({ _id: t.id });
  const time = which === "start" ? e?.startTime : e?.endTime;
  if (!e || e.status !== "PRESENT" || !time) return { error: `There's no ${which} time to change yet.` };
  if (e.staffSignature) return { error: "Your teacher has already signed today. Ask a staff member to change it." };
  const field = which === "start" ? "startInkId" : "endInkId";
  const before = e[field] ?? null;
  const inkId = await saveSignature("STUDENT", t.student._id, ink.png, "DRAWN", t.student._id, "TIME");
  const res = await entries.updateOne(
    // Nothing else may have changed since it was read (staff signing, a correction).
    { _id: t.id, staffSignature: null, status: "PRESENT", [which === "start" ? "startTime" : "endTime"]: time, [field]: before },
    {
      $set: { [field]: inkId, updatedAt: now },
      $push: { history: { at: now, byId: t.student._id, byName: t.student.name, what: `rewrote ${which} time (clock ${time12(time)})`, reason: "rewritten by student" } },
    },
  );
  if (!res.modifiedCount) return { error: "Today's row changed. Reload the page." };
  await audit(t.student._id, "student.rewrite_time", t.id, { which, from: before, to: inkId, clock: time });
  revalidatePath("/student/sheet");
  return { ok: true, message: `Your ${which} time is rewritten.` };
}

/**
 * The student signs one of their own rows by hand, when the times are there but their signature
 * isn't (for example staff wrote the end time because the student forgot). Any past day, as long
 * as staff haven't validated it yet.
 */
export async function studentSignRowAction(date: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const student = await currentStudent();
  if (!student) return { error: "You were signed out. Find your name again." };
  if (!DATE_RE.test(date)) return { error: "Invalid day." };
  if (date > todayIn(env().APP_TIMEZONE)) return { error: "You can't sign a day that hasn't happened yet." };
  if (!(await rateLimit(`time:${student._id}`, 30, 600))) return { error: "Too many tries. Wait a few minutes, or ask a staff member." };
  const sig = checkSignaturePng(fd.get("signature"));
  if ("error" in sig) return { error: sig.error };
  const id = `${student._id}:${date}`;
  const { entries } = await cols();
  const e = await entries.findOne({ _id: id });
  if (!e || e.status !== "PRESENT" || !e.startTime || !e.endTime) return { error: "This day needs a start and end time before you sign it." };
  if (e.studentSignature) return { ok: true, message: "This day is already signed." };
  if (e.staffSignature) return { error: "Your teacher has already signed this day. Ask a staff member." };
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

/**
 * The student fills in a past class day they forgot: start and end time (typed), their signature,
 * and optionally why it's late. Works on days with nothing recorded yet, and on days where they
 * entered a start time but never an end time (then only the end time is taken; the recorded start
 * stays). Any past class day of their course, whenever they get to it, as long as the month isn't
 * approved and staff haven't signed the row. The row is marked
 * "filled in later" so the teacher reviews it before signing; staff signatures and approvals are
 * never touched here.
 */
export async function studentFillPastDayAction(date: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const now = new Date();
  const student = await currentStudent();
  if (!student) return { error: "You were signed out. Find your name again." };
  if (!DATE_RE.test(date)) return { error: "Invalid day." };
  const today = todayIn(env().APP_TIMEZONE, now);
  if (date > today) return { error: "You can't fill in a day that hasn't happened yet." };
  if (date === today) return { error: "For today, use “Enter start time” and “Enter end time”." };
  if (!isClassDay(student, date)) return { error: `${usDate(date)} isn't one of your class days.` };
  const holiday = (await holidaysBetween(date, date)).get(date);
  if (holiday) return { error: `${usDate(date)} is a holiday (${holiday}).` };
  if (!(await rateLimit(`time:${student._id}`, 30, 600))) return { error: "Too many tries. Wait a few minutes, or ask a staff member." };
  const { entries, approvals } = await cols();
  if (await approvals.findOne({ _id: `${student._id}:${date.slice(0, 7)}` }, { projection: { _id: 1 } })) {
    return { error: "This month is already approved, so it can't be filled in now. Ask an admin." };
  }
  const id = `${student._id}:${date}`;
  const before = await entries.findOne({ _id: id }, { projection: { status: 1, startTime: 1, endTime: 1, staffSignature: 1 } });
  // A day they started but never ended: they add the end time; the recorded start time stays.
  const unfinished = !!before && before.status === "PRESENT" && !!before.startTime && !before.endTime;
  if (unfinished && before.staffSignature) return { error: `Your teacher has already signed ${usDate(date)}. Ask a staff member.` };
  const taken = (e: Pick<Entry, "status" | "startTime"> | null): ActionState =>
    e?.startTime ? { ok: true, message: `${usDate(date)} is already filled in.` } : { error: `${usDate(date)} is marked ${e?.status.toLowerCase() ?? "already"}. Ask an admin if that's wrong.` };
  if (before && !unfinished) return taken(before);
  const times = checkPastDayTimes(unfinished ? before.startTime : fd.get("startTime"), fd.get("endTime"), timeRules());
  if (!times.ok) return { error: times.error, fieldErrors: { [times.field]: times.error } };
  const sig = checkSignaturePng(fd.get("signature"));
  if ("error" in sig) return { error: "Sign in the box before saving.", fieldErrors: { signature: sig.error } };
  const text = String(fd.get("note") ?? "").trim().slice(0, 500);
  const signatureId = await saveDailySignature(student, sig.png);
  const comments: RowComment[] = text ? [{ id: newId(), at: now, byId: student._id, byName: student.name, byRole: "STUDENT", text, inkId: null }] : [];

  if (unfinished) {
    const res = await entries.updateOne(
      // Nothing may have changed since it was read (staff signing or correcting the row).
      { _id: id, status: "PRESENT", startTime: times.start, endTime: null, staffSignature: null },
      {
        $set: { endAt: now, endTime: times.end, minutes: times.minutes, endInkId: null, endLateBy: null, filledLaterAt: now, studentSignature: { id: signatureId, at: now }, updatedAt: now },
        $push: {
          history: { at: now, byId: student._id, byName: student.name, what: `end time filled in later: ${time12(times.end)}`, reason: text || "filled in later by student" },
          comments: { $each: comments },
        },
      },
    );
    if (!res.modifiedCount) return { error: `${usDate(date)} changed. Reload the page.` };
    await audit(student._id, "student.finish_past_day", id, { endTime: times.end, minutes: times.minutes, signatureId, savedAt: now.toISOString(), note: !!text });
    revalidatePath("/student/sheet");
    revalidatePath("/teacher", "layout");
    revalidatePath("/admin", "layout");
    return { ok: true, message: `${usDate(date)} finished: ${hoursText(times.minutes)} hours, signed. Your teacher will review it.` };
  }

  const row: Entry = {
    _id: id, studentId: student._id, date, status: "PRESENT", startAt: now, endAt: now, startTime: times.start, endTime: times.end, minutes: times.minutes,
    startInkId: null, endInkId: null, startLateBy: null, endLateBy: null, filledLaterAt: now,
    studentSignature: { id: signatureId, at: now }, staffSignature: null, note: "", comments, updatedAt: now,
    history: [{ at: now, byId: student._id, byName: student.name, what: `filled in later: ${time12(times.start)}-${time12(times.end)}`, reason: text || "filled in later by student" }],
  };
  try {
    await entries.insertOne(row);
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;
    // Recorded in the meantime (a double tap, or an admin marked the day): leave it as it is.
    return taken(await entries.findOne({ _id: id }, { projection: { status: 1, startTime: 1 } }));
  }
  await audit(student._id, "student.fill_past_day", id, { startTime: times.start, endTime: times.end, minutes: times.minutes, signatureId, savedAt: now.toISOString(), note: !!text });
  revalidatePath("/student/sheet");
  revalidatePath("/teacher", "layout");
  revalidatePath("/admin", "layout");
  return { ok: true, message: `${usDate(date)} filled in: ${hoursText(times.minutes)} hours, signed. Your teacher will review it.` };
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

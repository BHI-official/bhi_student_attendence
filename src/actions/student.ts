"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Binary } from "mongodb";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { audit, cols, isDuplicateKey, newId, rateLimit, type Entry, type Excuse, type RowComment } from "@/lib/db";
import { currentStudent, endStudentSession, startStudentSession } from "@/lib/auth";
import { env } from "@/lib/env";
import { holidaysBetween } from "@/lib/data";
import { DATE_RE, isClassDay, todayIn, usDate } from "@/lib/sheet";
import { checkSignaturePng, checkTimePng, saveSignature } from "@/lib/signatures";
import {
  EXCUSE_MAX_BYTES, STATUS_LABEL, dayStatus, safeFileName, sniffExcuse, studentCanExcuse, studentCanSubmit, studentLock,
} from "@/lib/week";
import type { ActionState } from "@/lib/action";

const refresh = () => { revalidatePath("/student", "layout"); revalidatePath("/teacher", "layout"); revalidatePath("/admin", "layout"); };

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

/** The checks every student action on one day shares: signed in, a class day they may still change. */
async function openDay(date: string, now: Date) {
  const student = await currentStudent();
  if (!student) return { error: "You were signed out. Find your name again." } as const;
  if (!DATE_RE.test(date)) return { error: "Choose a day." } as const;
  const today = todayIn(env().APP_TIMEZONE, now);
  const lock = studentLock(date, today);
  if (lock) return { error: lock } as const;
  if (!isClassDay(student, date)) return { error: `${usDate(date)} isn't one of your class days.` } as const;
  const holiday = (await holidaysBetween(date, date)).get(date);
  if (holiday) return { error: `${usDate(date)} is a holiday (${holiday}).` } as const;
  if (!(await rateLimit(`day:${student._id}`, 40, 600))) return { error: "Too many tries. Wait a few minutes, or ask your teacher." } as const;
  return { student, today, id: `${student._id}:${date}` } as const;
}

async function teacherNameOf(teacherId: string | null | undefined) {
  if (!teacherId) return null;
  return (await (await cols()).staff.findOne({ _id: teacherId }, { projection: { name: 1 } }))?.name ?? null;
}

/** Is this student's month already signed off by the admin ("Approved by" at the bottom)? Then it is closed. */
async function monthSigned(studentId: string, date: string) {
  return (await cols()).approvals.findOne({ _id: `${studentId}:${date.slice(0, 7)}` }, { projection: { staffName: 1 } });
}

/**
 * The student fills in one day, all by hand, like the paper sheet: start time, lunch start, lunch
 * end, end time, and their signature. A new signature every day, never reused. Lunch can be left
 * out (no lunch break), but not half of it. Works for today and any class day back to Monday of
 * last week, and again after the teacher sends it back. Once the teacher approves it (signing by
 * hand), or the admin signs off the month, the day is locked. One record per student per day.
 */
export async function submitDayAction(date: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const now = new Date();
  const d = await openDay(date, now);
  if ("error" in d) return { error: d.error };
  const { student, today, id } = d;

  const ink = (name: string, what: string) => {
    const raw = String(fd.get(name) ?? "");
    if (!raw) return null;
    const r = checkTimePng(raw);
    return "error" in r ? { error: `${what}: ${r.error}` } : r;
  };
  const startInk = ink("startInk", "Start time"), lunchStartInk = ink("lunchStartInk", "Lunch start"),
    lunchEndInk = ink("lunchEndInk", "Lunch end"), endInk = ink("endInk", "End time");
  const fieldErrors: Record<string, string> = {};
  for (const [name, v, label] of [["startInk", startInk, "Write your start time."], ["endInk", endInk, "Write your end time."]] as const) {
    if (!v) fieldErrors[name] = label; else if ("error" in v) fieldErrors[name] = v.error;
  }
  for (const [name, v] of [["lunchStartInk", lunchStartInk], ["lunchEndInk", lunchEndInk]] as const) if (v && "error" in v) fieldErrors[name] = v.error;
  if (!!lunchStartInk !== !!lunchEndInk) fieldErrors[lunchStartInk ? "lunchEndInk" : "lunchStartInk"] = "Write both lunch times, or neither if you had no lunch break.";
  const sig = checkSignaturePng(fd.get("signature"));
  if ("error" in sig) fieldErrors.signature = "Sign in the signature box.";
  if (Object.keys(fieldErrors).length) return { error: Object.values(fieldErrors)[0], fieldErrors };
  const png = (v: typeof startInk) => (v && "png" in v ? v.png : null);
  const text = String(fd.get("note") ?? "").trim().slice(0, 500);

  const { entries } = await cols();
  const signedOff = await monthSigned(student._id, date);
  if (signedOff) return { error: `${usDate(date)} is in a month ${signedOff.staffName} has already signed off, so it's locked. Ask an admin.` };
  const before = await entries.findOne({ _id: id });
  const status = dayStatus(before, false, date, today);
  if (!studentCanSubmit(status)) {
    if (status === "APPROVED") return { error: `${usDate(date)} is already approved by ${before?.staffSignature?.staffName ?? "your teacher"}, so it's locked.` };
    if (status === "ABSENT") return { error: `Your teacher marked you absent on ${usDate(date)}. If you have a document, use “Upload excuse”. Otherwise talk to your teacher.` };
    return { error: `${usDate(date)} is marked ${STATUS_LABEL[status].toLowerCase()}. Talk to your teacher if that's wrong.` };
  }

  const save = (p: string | null) => (p ? saveSignature("STUDENT", student._id, p, "DRAWN", student._id, "TIME") : Promise.resolve(null));
  const [startInkId, lunchStartInkId, lunchEndInkId, endInkId, signatureId] = await Promise.all([
    save(png(startInk)), save(png(lunchStartInk)), save(png(lunchEndInk)), save(png(endInk)),
    saveSignature("STUDENT", student._id, (sig as { png: string }).png, "DRAWN", student._id),
  ]);
  const late = date < today;
  const comments: RowComment[] = text ? [{ id: newId(), at: now, byId: student._id, byName: student.name, byRole: "STUDENT", text, inkId: null }] : [];
  const fields = {
    status: "PRESENT" as const, startTime: null, endTime: null, minutes: null, startInkId, endInkId, lunchStartInkId, lunchEndInkId,
    startAt: now, endAt: now, startLateBy: null, endLateBy: null, filledLaterAt: late ? now : null,
    studentSignature: { id: signatureId, at: now }, correction: null, updatedAt: now,
  };
  const what = before?.studentSignature
    ? `submitted again by student (earlier: times ${[before.startInkId, before.lunchStartInkId, before.lunchEndInkId, before.endInkId].map((x) => x ?? "-").join(", ")}; signature ${before.studentSignature.id})`
    : "submitted by student";
  const history = { at: now, byId: student._id, byName: student.name, what, reason: text || (late ? "filled in later" : "") };

  if (!before) {
    const row: Entry = {
      _id: id, studentId: student._id, date, ...fields, staffSignature: null, markedBy: null, excuse: null,
      note: "", comments, history: [history],
    };
    try {
      await entries.insertOne(row);
    } catch (e) {
      if (!isDuplicateKey(e)) throw e;
      return { error: `${usDate(date)} was just saved from another screen. Reload the page.` };
    }
  } else {
    // Only if nothing changed since it was read (the teacher approving or marking it a moment ago).
    const res = await entries.updateOne(
      { _id: id, updatedAt: before.updatedAt, staffSignature: null, status: "PRESENT" },
      { $set: fields, $push: { history, comments: { $each: comments } } },
    );
    if (!res.modifiedCount) return { error: `${usDate(date)} changed in the meantime. Reload the page.` };
  }
  await audit(student._id, before?.studentSignature ? "student.resubmit_day" : "student.submit_day", id, {
    signatureId, startInkId, lunchStartInkId, lunchEndInkId, endInkId, late, note: !!text,
  });
  refresh();
  const teacher = await teacherNameOf(student.teacherId);
  return { ok: true, message: `Saved and signed for ${usDate(date)}. Sent to ${teacher ?? "your teacher"} to check and sign.`, data: { date } };
}

/**
 * For a day the student was absent: they upload a document (PDF, JPG or PNG, like a doctor's note)
 * and can say why. The day stays Absent until the teacher or an admin approves the excuse; then it
 * becomes Excused and stops counting against their attendance. Same weeks as submitting.
 */
export async function uploadExcuseAction(date: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const now = new Date();
  const d = await openDay(date, now);
  if ("error" in d) return { error: d.error };
  const { student, today, id } = d;

  const file = fd.get("file");
  if (!(file instanceof File) || !file.size) return { error: "Choose a file to upload.", fieldErrors: { file: "Choose a PDF, JPG or PNG file." } };
  if (file.size > EXCUSE_MAX_BYTES) return { error: "That file is too big (4 MB max). Take a smaller photo or a PDF.", fieldErrors: { file: "4 MB max." } };
  const buf = new Uint8Array(await file.arrayBuffer());
  const mime = sniffExcuse(buf);
  if (!mime) return { error: "Upload a PDF, JPG or PNG file.", fieldErrors: { file: "Only PDF, JPG or PNG." } };
  const note = String(fd.get("note") ?? "").trim().slice(0, 500);

  const { entries, excuseFiles } = await cols();
  const signedOff = await monthSigned(student._id, date);
  if (signedOff) return { error: `${usDate(date)} is in a month ${signedOff.staffName} has already signed off. Ask an admin.` };
  const before = await entries.findOne({ _id: id });
  const status = dayStatus(before, false, date, today);
  if (!studentCanExcuse(status)) return { error: `${usDate(date)} is ${STATUS_LABEL[status].toLowerCase()}, so it doesn't need an excuse.` };
  if (before?.markedBy?.mark === "PRESENT" && before.status === "PRESENT") return { error: `Your teacher marked you present on ${usDate(date)}. Fill in the day instead.` };
  if (before?.excuse?.status === "APPROVED") return { error: `Your excuse for ${usDate(date)} is already approved.` };

  const fileName = safeFileName(file.name, mime);
  const fileId = newId();
  await excuseFiles.insertOne({ _id: fileId, studentId: student._id, date, name: fileName, mime, size: buf.length, data: new Binary(Buffer.from(buf)), at: now });
  const excuse: Excuse = { fileId, fileName, mime, size: buf.length, note, at: now, status: "PENDING", decidedBy: null, decidedAt: null, reason: "" };
  const history = {
    at: now, byId: student._id, byName: student.name,
    what: `excuse uploaded (${fileName})${before?.excuse ? `, replacing ${before.excuse.fileName} (${before.excuse.status.toLowerCase()})` : ""}`, reason: note,
  };
  if (!before) {
    const row: Entry = {
      _id: id, studentId: student._id, date, status: "ABSENT", startAt: null, endAt: null, startTime: null, endTime: null, minutes: null,
      studentSignature: null, staffSignature: null, correction: null, markedBy: null, excuse, note: "", comments: [], updatedAt: now,
      history: [{ ...history, what: `absent, reported by student; ${history.what}` }],
    };
    try {
      await entries.insertOne(row);
    } catch (e) {
      if (!isDuplicateKey(e)) throw e;
      return { error: `${usDate(date)} was just saved from another screen. Reload the page.` };
    }
  } else {
    const res = await entries.updateOne(
      { _id: id, updatedAt: before.updatedAt, staffSignature: null },
      { $set: { status: "ABSENT", excuse, updatedAt: now }, $push: { history } },
    );
    if (!res.modifiedCount) return { error: `${usDate(date)} changed in the meantime. Reload the page.` };
  }
  await audit(student._id, "student.upload_excuse", id, { fileId, mime, size: buf.length, note: !!note });
  refresh();
  const teacher = await teacherNameOf(student.teacherId);
  return { ok: true, message: `Excuse uploaded for ${usDate(date)}. ${teacher ?? "Your teacher"} will review it. Until then the day stays Absent.`, data: { date } };
}

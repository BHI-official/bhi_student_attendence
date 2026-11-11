// Pure rules for the weekly attendance flow (no database), so they can be unit-tested.
import { WEEKDAY_NAMES, addDays, usDate, weekday } from "./sheet";
import type { Entry } from "./types";

/** Weeks run Monday to Friday. Monday of the week `date` is in (a Saturday or Sunday belongs to the week before it). */
export const mondayOf = (date: string) => addDays(date, -(weekday(date) - 1));

/** Monday..Friday of the week that starts on `monday`. */
export const weekDates = (monday: string) => [0, 1, 2, 3, 4].map((i) => addDays(monday, i));

export const isWeekday = (date: string) => weekday(date) <= 5;

/**
 * The first day students (and teachers) can still act on: Monday of the previous week. Everything
 * from there to today is open; older days are locked (admins only).
 */
export const openFrom = (today: string) => addDays(mondayOf(today), -7);

/** "Mon 11/09" */
export const shortDay = (date: string) => `${WEEKDAY_NAMES[weekday(date)].slice(0, 3)} ${usDate(date).slice(0, 5)}`;

/** "Week of 11/09/2026" */
export const weekTitle = (monday: string) => `Week of ${usDate(monday)}`;

/** Why a student can't fill in or change this day, or null when they can. */
export function studentLock(date: string, today: string): string | null {
  if (!isWeekday(date)) return "Attendance is Monday to Friday only.";
  if (date > today) return "You can't sign for a day that hasn't happened yet.";
  if (date < openFrom(today)) return `${usDate(date)} is locked. You can fill in this week and last week only. Ask an admin.`;
  return null;
}

/** Why a teacher can't act on this day, or null when they can. Admins have no limit. */
export function teacherLock(date: string, today: string): string | null {
  if (date > today) return `${usDate(date)} hasn't happened yet.`;
  if (date < openFrom(today)) return `${usDate(date)} is older than last week, so it is locked. Ask an admin.`;
  return null;
}

// ---------- Status ----------

/**
 * What one day looks like to everyone. The student sees the same words, except that a day with no
 * submission reads as "Not submitted".
 */
export type DayStatus = "UPCOMING" | "MISSING" | "PENDING" | "APPROVED" | "NEEDS_CORRECTION" | "ABSENT" | "EXCUSED" | "HOLIDAY";

export const STATUS_LABEL: Record<DayStatus, string> = {
  UPCOMING: "Upcoming",
  MISSING: "Missing",
  PENDING: "Pending",
  APPROVED: "Approved",
  NEEDS_CORRECTION: "Needs correction",
  ABSENT: "Absent",
  EXCUSED: "Excused",
  HOLIDAY: "Holiday",
};

type StatusFields = Pick<Entry, "status" | "studentSignature" | "staffSignature"> & Partial<Pick<Entry, "correction">>;

export function dayStatus(e: StatusFields | null | undefined, holiday: boolean, date: string, today: string): DayStatus {
  if (holiday || e?.status === "HOLIDAY") return "HOLIDAY";
  if (e?.status === "EXCUSED") return "EXCUSED";
  if (e?.status === "ABSENT") return "ABSENT";
  if (e?.status === "PRESENT") {
    if (e.staffSignature) return "APPROVED";
    if (e.correction) return "NEEDS_CORRECTION";
    if (e.studentSignature) return "PENDING";
  }
  return date > today ? "UPCOMING" : "MISSING";
}

/** Can the student submit (or submit again) on a day with this status? */
export const studentCanSubmit = (s: DayStatus) => s === "MISSING" || s === "PENDING" || s === "NEEDS_CORRECTION";

/** Can the student upload an excuse for a day with this status? (Absent, or nothing submitted.) */
export const studentCanExcuse = (s: DayStatus) => s === "ABSENT" || s === "MISSING";

// ---------- Excuse documents ----------

export const EXCUSE_MAX_BYTES = 4 * 1024 * 1024;
export const EXCUSE_TYPES = { "application/pdf": "PDF", "image/jpeg": "JPG", "image/png": "PNG" } as const;
export type ExcuseMime = keyof typeof EXCUSE_TYPES;

/** What the file really is, from its first bytes (never trust the name or the browser's type). */
export function sniffExcuse(buf: Uint8Array): ExcuseMime | null {
  if (buf.length >= 5 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46 && buf[4] === 0x2d) return "application/pdf"; // %PDF-
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  return null;
}

/** A file name that is safe to put in a download header. */
export const safeFileName = (name: string, mime: ExcuseMime) => {
  const base = name.replace(/\.[A-Za-z0-9]{1,5}$/, "").replace(/[^A-Za-z0-9 _.-]/g, "").trim().slice(0, 60) || "excuse";
  return `${base}.${mime === "application/pdf" ? "pdf" : mime === "image/png" ? "png" : "jpg"}`;
};

// Pure rules for the attendance sheet (no database), so they can be unit-tested.
import type { Entry, Student } from "./types";

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Today's date (YYYY-MM-DD) in the school's time zone, not UTC. */
export function todayIn(tz: string, now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/**
 * Wall-clock HH:MM of an instant in the school's time zone. Start times round seconds up and end
 * times round them down, so nobody is credited for time they weren't there.
 */
export function clockIn(tz: string, at: Date, mode: "start" | "end") {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  let m = n("hour") * 60 + n("minute");
  if (mode === "start" && (n("second") > 0 || at.getUTCMilliseconds() > 0)) m = Math.min(m + 1, 23 * 60 + 59);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export const toMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Minutes from start to end, or null if either is missing or end isn't after start. */
export function minutesBetween(start: string | null, end: string | null) {
  if (!start || !end || !TIME_RE.test(start) || !TIME_RE.test(end)) return null;
  const m = toMinutes(end) - toMinutes(start);
  return m > 0 ? m : null;
}

/** "13:05" -> "1:05 pm" (the way it's written on the paper sheet). */
export function time12(t: string | null) {
  if (!t) return "";
  const h = Number(t.slice(0, 2));
  return `${h % 12 || 12}:${t.slice(3, 5)} ${h < 12 ? "am" : "pm"}`;
}

/** 420 -> "7", 405 -> "6.75". Hours are kept as exact minutes and only rounded for display. */
export function hoursText(minutes: number | null | undefined) {
  if (minutes == null) return "";
  const h = Math.round((minutes / 60) * 100) / 100;
  return Number.isInteger(h) ? String(h) : h.toFixed(2);
}

/** 1 = Monday ... 7 = Sunday, for a YYYY-MM-DD date. */
export function weekday(date: string) {
  const d = new Date(`${date}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}
export const WEEKDAY_NAMES = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export function monthDates(month: string) {
  const [y, m] = month.split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: days }, (_, i) => `${month}-${String(i + 1).padStart(2, "0")}`);
}

export const shiftMonth = (month: string, by: number) => {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

export const monthTitle = (month: string) =>
  new Date(`${month}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

/** "2026-09-01" -> "09/01/2026", as printed on the paper sheet. */
export const usDate = (date: string) => (date ? `${date.slice(5, 7)}/${date.slice(8, 10)}/${date.slice(0, 4)}` : "");

/** Is this a class day for the student (enrolled, and one of their weekdays)? */
export const isClassDay = (s: Pick<Student, "startDate" | "endDate" | "classDays">, date: string) =>
  date >= s.startDate && date <= s.endDate && s.classDays.includes(weekday(date));

export type SheetRow = {
  date: string;
  weekdayName: string;
  holiday: string | null;
  entry: Entry | null;
  isToday: boolean;
  isFuture: boolean;
};

/** The rows of one month's sheet: every class day of the student, like the paper form. */
export function sheetRows(
  student: Pick<Student, "startDate" | "endDate" | "classDays">, month: string, entries: Entry[], holidays: Map<string, string>, today: string,
): SheetRow[] {
  const byDate = new Map(entries.map((e) => [e.date, e]));
  return monthDates(month)
    .filter((d) => isClassDay(student, d))
    .map((date) => ({
      date,
      weekdayName: WEEKDAY_NAMES[weekday(date)],
      holiday: holidays.get(date) ?? null,
      entry: byDate.get(date) ?? null,
      isToday: date === today,
      isFuture: date > today,
    }));
}

/** Total of the month's counted minutes (present days only). */
export const monthMinutes = (entries: Entry[]) =>
  entries.reduce((t, e) => t + (e.status === "PRESENT" && e.minutes ? e.minutes : 0), 0);

// ---------- Student import (CSV) ----------

export type StudentInput = {
  name: string; courseName: string; courseCode: string; courseDuration: string; caseManager: string; instructor: string;
  startDate: string; endDate: string; pin: string;
  /** Optional: email of the teacher whose roster the student goes on. */
  teacherEmail: string;
};
export const CSV_COLUMNS = ["name", "courseName", "courseCode", "courseDuration", "caseManager", "instructor", "startDate", "endDate", "pin", "teacherEmail"] as const;

/** Accepts 09/01/2026, 9/1/2026 or 2026-09-01. */
export function parseDate(v: string) {
  const s = v.trim();
  if (DATE_RE.test(s)) return s;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (!m) return null;
  const iso = `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  const d = new Date(`${iso}T12:00:00Z`);
  return d.getUTCMonth() + 1 === Number(m[1]) && d.getUTCDate() === Number(m[2]) ? iso : null;
}

/** Splits CSV text into rows, handling quoted fields with commas and doubled quotes. */
export function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  const src = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

/** Validates an import file. The first row must be the header (column names, any order). */
export function parseStudentsCsv(text: string): { students: StudentInput[]; errors: string[] } {
  const rows = csvRows(text);
  const errors: string[] = [];
  if (!rows.length) return { students: [], errors: ["The file is empty."] };
  const header = rows[0].map((h) => h.trim());
  const col = (name: string) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const missing = CSV_COLUMNS.filter((c) => c !== "pin" && c !== "teacherEmail" && col(c) < 0);
  if (missing.length) return { students: [], errors: [`Missing columns: ${missing.join(", ")}. The first row must name the columns.`] };
  const students: StudentInput[] = [];
  rows.slice(1).forEach((r, i) => {
    const line = i + 2;
    const get = (c: string) => (col(c) >= 0 ? (r[col(c)] ?? "").trim() : "");
    const name = get("name").replace(/\s+/g, " ");
    const startDate = parseDate(get("startDate"));
    const endDate = parseDate(get("endDate"));
    const pin = get("pin");
    if (name.length < 2) return errors.push(`Line ${line}: name is missing.`);
    if (!startDate || !endDate) return errors.push(`Line ${line} (${name}): dates must look like 09/01/2026.`);
    if (endDate < startDate) return errors.push(`Line ${line} (${name}): end date is before start date.`);
    if (pin && !/^\d{4,6}$/.test(pin)) return errors.push(`Line ${line} (${name}): PIN must be 4 to 6 digits.`);
    students.push({
      name, courseName: get("courseName"), courseCode: get("courseCode"), courseDuration: get("courseDuration"),
      caseManager: get("caseManager"), instructor: get("instructor"), startDate, endDate, pin, teacherEmail: get("teacherEmail").toLowerCase(),
    });
  });
  return { students, errors };
}

// ---------- Times typed by the student ----------

/** Limits for times a student types. The server's clock is always the judge. */
export type TimeRules = {
  /** How far back a typed time may be, e.g. 15 = "up to 15 minutes ago". */
  windowMinutes: number;
  /** Shortest and longest day that can be recorded without staff. */
  minMinutes: number;
  maxMinutes: number;
};
export const DEFAULT_TIME_RULES: TimeRules = { windowMinutes: 15, minMinutes: 5, maxMinutes: 12 * 60 };

/** Rows typed this long (or more) after the fact are flagged for staff. */
export const LATE_ENTRY_FLAG_MINUTES = 5;

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/**
 * Reads a typed time: "09:05", "9:05", "9.05", "905", "0905", "9:05 am", "9:05pm", "12:10 a.m.".
 * Returns "HH:MM" (24-hour) or null. Without am/pm the hour is read as 24-hour.
 */
export function parseTime(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim().toLowerCase().replace(/\s+/g, " ").replace(/\./g, (c, i, str) => (/\d/.test(str[i - 1] ?? "") && /\d/.test(str[i + 1] ?? "") ? ":" : ""));
  const m = /^(\d{1,2}):?(\d{2})(?::\d{2})? ?(am|pm|a|p)?$/.exec(s);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ap = m[3]?.[0];
  if (min > 59) return null;
  if (ap) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (ap === "p" ? 12 : 0);
  } else if (h > 23) return null;
  return hhmm(h * 60 + min);
}

export type TimeCheck = { ok: true; time: string; lateBy: number } | { ok: false; error: string };

/**
 * Is a typed start or end time believable right now? Used in the browser (instant feedback) and
 * again on the server (the only check that counts). `nowMinutes` is the school's clock, in
 * minutes since midnight, with seconds dropped.
 *
 * Rules:
 *  - the time has already happened (no future times);
 *  - it is from the last `windowMinutes` (anything older is a staff correction);
 *  - an end time is after the start, no earlier than the moment the start was entered (the student
 *    was demonstrably still here then), and the day is between minMinutes and maxMinutes long.
 * AM/PM mix-ups are spotted and explained.
 */
export function checkTypedTime(
  kind: "start" | "end",
  raw: unknown,
  nowMinutes: number,
  rules: TimeRules,
  start?: { time: string; enteredAtMinutes: number | null },
): TimeCheck {
  const t = parseTime(raw);
  if (!t) return { ok: false, error: "Enter the time like 9:05 am." };
  const m = toMinutes(t);
  const earliest = Math.max(0, nowMinutes - rules.windowMinutes);
  const inWindow = (x: number) => x >= earliest && x <= nowMinutes;
  const now = time12(hhmm(nowMinutes));

  if (m > nowMinutes) {
    if (inWindow(m - 720)) return { ok: false, error: `${time12(t)} hasn't happened yet. Did you mean ${time12(hhmm(m - 720))}?` };
    return { ok: false, error: `${time12(t)} hasn't happened yet. It's ${now} now.` };
  }
  if (m < earliest) {
    if (inWindow(m + 720)) return { ok: false, error: `That's ${time12(t)}. Did you mean ${time12(hhmm(m + 720))}?` };
    return {
      ok: false,
      error: `You can only enter a time from the last ${rules.windowMinutes} minutes (${time12(hhmm(earliest))} to ${now}). Ask a staff member to fix an earlier time.`,
    };
  }

  if (kind === "end") {
    if (!start || !TIME_RE.test(start.time)) return { ok: false, error: "Enter your start time first." };
    const s = toMinutes(start.time);
    if (m <= s) return { ok: false, error: `Your end time must be after your start time (${time12(start.time)}).` };
    if (start.enteredAtMinutes != null && m < start.enteredAtMinutes) {
      return { ok: false, error: `You entered your start time at ${time12(hhmm(start.enteredAtMinutes))}, so you can't have left before then.` };
    }
    const length = m - s;
    if (length < rules.minMinutes) return { ok: false, error: `That's only ${length} minute${length === 1 ? "" : "s"} after you started. Enter your end time when class is over.` };
    if (length > rules.maxMinutes) return { ok: false, error: `That's more than ${hoursText(rules.maxMinutes)} hours. Ask a staff member.` };
  }
  return { ok: true, time: t, lateBy: nowMinutes - m };
}

/**
 * Times a student enters for a past class day they forgot to fill in. The server's clock can't
 * vouch for them, so the row is flagged for review; these checks only refuse what can't be right:
 * an unreadable time, an end that isn't after the start, or a day shorter or longer than allowed.
 */
export function checkPastDayTimes(
  rawStart: unknown, rawEnd: unknown, rules: Pick<TimeRules, "minMinutes" | "maxMinutes">,
): { ok: true; start: string; end: string; minutes: number } | { ok: false; field: "startTime" | "endTime"; error: string } {
  const start = parseTime(rawStart);
  if (!start) return { ok: false, field: "startTime", error: "Enter the time you arrived, like 9:05 am." };
  const end = parseTime(rawEnd);
  if (!end) return { ok: false, field: "endTime", error: "Enter the time you left, like 2:30 pm." };
  const minutes = minutesBetween(start, end);
  if (minutes === null) {
    // 9:00 to 1:00 most likely means 1:00 pm.
    const pm = toMinutes(end) + 720;
    if (pm < 24 * 60 && pm > toMinutes(start)) return { ok: false, field: "endTime", error: `Your end time must be after ${time12(start)}. Did you mean ${time12(hhmm(pm))}?` };
    return { ok: false, field: "endTime", error: `Your end time must be after your start time (${time12(start)}).` };
  }
  if (minutes < rules.minMinutes) return { ok: false, field: "endTime", error: `That's only ${minutes} minute${minutes === 1 ? "" : "s"}. Check the times.` };
  if (minutes > rules.maxMinutes) return { ok: false, field: "endTime", error: `That's more than ${hoursText(rules.maxMinutes)} hours. Ask a staff member.` };
  return { ok: true, start, end, minutes };
}

// ---------- Seven-day editing window ----------

/** "2026-09-01" + 7 -> "2026-09-08". */
export function addDays(date: string, days: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * A row can be changed by teachers (and signed by the student) until `windowDays` days after its
 * class day; after that it is locked and only an admin can change it. With a 7-day window, the
 * row for Monday the 1st is editable through Monday the 8th and locked from the 9th.
 */
export function editWindow(date: string, today: string, windowDays: number) {
  const lastDay = addDays(date, windowDays);
  return { locked: today > lastDay, lastDay };
}

// ---------- Attendance summary and colour ----------

export type AttendanceLevel = "good" | "attention" | "poor" | "none";
export type AttendanceThresholds = { goodPercent: number; attentionPercent: number };
export const DEFAULT_THRESHOLDS: AttendanceThresholds = { goodPercent: 90, attentionPercent: 75 };

export type AttendanceSummary = {
  /** Class days so far (course dates and weekdays), up to and including today. */
  classDays: number;
  holidays: number;
  present: number;
  absent: number;
  excused: number;
  /** Past class days with nothing recorded. Counted as absent in the rate. */
  missing: number;
  minutes: number;
  /** present / (class days − holidays − excused − today if not yet recorded), 0–100, or null with nothing to count. */
  rate: number | null;
  level: AttendanceLevel;
};

export function attendanceLevel(rate: number | null, t: AttendanceThresholds = DEFAULT_THRESHOLDS): AttendanceLevel {
  if (rate === null) return "none";
  if (rate >= t.goodPercent) return "good";
  if (rate >= t.attentionPercent) return "attention";
  return "poor";
}
export const LEVEL_WORDS: Record<AttendanceLevel, string> = { good: "Good attendance", attention: "Needs attention", poor: "Poor attendance", none: "No attendance yet" };

/**
 * Attendance so far for one student. Today only counts once something is recorded for it, so a
 * student isn't marked down in the morning before they arrive. Holidays (school-wide, or a row
 * marked Holiday) and excused days are left out of the rate.
 */
export function attendanceSummary(
  student: Pick<Student, "startDate" | "endDate" | "classDays">,
  entries: Pick<Entry, "date" | "status" | "minutes">[],
  holidays: Set<string> | Map<string, string>,
  today: string,
  t: AttendanceThresholds = DEFAULT_THRESHOLDS,
): AttendanceSummary {
  const byDate = new Map(entries.map((e) => [e.date, e]));
  const out: AttendanceSummary = { classDays: 0, holidays: 0, present: 0, absent: 0, excused: 0, missing: 0, minutes: 0, rate: null, level: "none" };
  const last = student.endDate < today ? student.endDate : today;
  for (let d = student.startDate; d <= last; d = addDays(d, 1)) {
    if (!isClassDay(student, d)) continue;
    const e = byDate.get(d);
    if (d === today && !e && !holidays.has(d)) continue; // the day isn't over yet (a holiday is already decided)
    out.classDays++;
    if (holidays.has(d) || e?.status === "HOLIDAY") { out.holidays++; continue; }
    if (!e) { out.missing++; continue; }
    if (e.status === "PRESENT") { out.present++; out.minutes += e.minutes ?? 0; }
    else if (e.status === "ABSENT") out.absent++;
    else if (e.status === "EXCUSED") out.excused++;
  }
  const counted = out.present + out.absent + out.missing;
  out.rate = counted ? Math.round((out.present / counted) * 1000) / 10 : null;
  out.level = attendanceLevel(out.rate, t);
  return out;
}

/** Is the course running, finished, or yet to start? */
export function enrollmentState(s: Pick<Student, "startDate" | "endDate" | "active">, today: string) {
  if (!s.active) return "Inactive" as const;
  if (today < s.startDate) return "Not started" as const;
  if (today > s.endDate) return "Completed" as const;
  return "Active" as const;
}

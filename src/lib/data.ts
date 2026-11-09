import "server-only";
import { cols, type Entry, type Student } from "./db";
import { env } from "./env";
import { clockIn, isClassDay, monthMinutes, sheetRows, todayIn, toMinutes, type TimeRules } from "./sheet";
import { entriesHash } from "./hash";
import { signatureImages } from "./signatures";
import type { Filter } from "mongodb";

export const today = () => todayIn(env().APP_TIMEZONE);
export const thisMonth = () => today().slice(0, 7);

/** Limits for times students type, from settings. */
export const timeRules = (): TimeRules => {
  const e = env();
  return { windowMinutes: e.TIME_ENTRY_WINDOW_MINUTES, minMinutes: e.MIN_CLASS_MINUTES, maxMinutes: e.MAX_CLASS_MINUTES };
};

/** The school's clock right now (or at an instant), in minutes since midnight, seconds dropped. */
export const schoolMinutes = (at = new Date()) => toMinutes(clockIn(env().APP_TIMEZONE, at, "end"));

/** School-wide holidays between two dates: date -> what is written on the sheet (name, and the note if any). */
export async function holidaysBetween(from: string, to: string) {
  const list = await (await cols()).holidays.find({ _id: { $gte: from, $lte: to } }).toArray();
  return new Map(list.map((h) => [h._id, h.note ? `${h.name} – ${h.note}` : h.name]));
}

/** Everything one month's sheet shows for one student. */
export async function loadSheet(studentId: string, month: string) {
  const { students, entries, approvals } = await cols();
  const student = await students.findOne({ _id: studentId });
  if (!student) return null;
  const [list, holidays, approval] = await Promise.all([
    entries.find({ studentId, date: { $gte: `${month}-01`, $lte: `${month}-31` } }).toArray(),
    holidaysBetween(`${month}-01`, `${month}-31`),
    approvals.findOne({ _id: `${studentId}:${month}` }),
  ]);
  const rows = sheetRows(student, month, list, holidays, today());
  const images = await signatureImages([
    ...list.flatMap((e) => [e.studentSignature?.id, e.staffSignature?.id, e.startInkId, e.endInkId, ...(e.comments ?? []).map((c) => c.inkId)]),
    approval?.signatureId, approval?.commentsInkId,
  ]);
  return {
    images,
    student,
    month,
    rows,
    totalMinutes: monthMinutes(list),
    approval,
    approvalCurrent: !!approval && approval.entriesHash === entriesHash(list),
  };
}
export type SheetData = NonNullable<Awaited<ReturnType<typeof loadSheet>>>;

/** Students who have class today, with today's row, for the staff board. */
export async function loadDay(date: string, scope: Filter<Student>, course?: string) {
  const { students, entries } = await cols();
  const list = (await students
    .find({ $and: [scope, { active: true, startDate: { $lte: date }, endDate: { $gte: date }, ...(course ? { courseName: course } : {}) }] })
    .sort({ nameLower: 1 })
    .toArray()).filter((s) => isClassDay(s, date));
  const rows = await entries.find({ date, studentId: { $in: list.map((s) => s._id) } }).toArray();
  const byStudent = new Map(rows.map((e) => [e.studentId, e]));
  const holiday = (await holidaysBetween(date, date)).get(date) ?? null;
  return { date, holiday, rows: list.map((s) => ({ student: s, entry: byStudent.get(s._id) ?? null })) };
}

export const courseNames = async (scope: Filter<Student> = {}) =>
  ((await (await cols()).students.distinct("courseName", { $and: [scope, { active: true }] })) as string[]).filter(Boolean).sort();

/** Who may see a student's sheet: staff, or that student. */
export const sameStudent = (s: Student | null, id: string) => !!s && s._id === id;
export type { Entry };

/** Only the fields the sheet prints. Never send the whole student (it holds the PIN hash) to the browser. */
export const sheetHeader = (s: Student) => ({
  _id: s._id, name: s.name, courseName: s.courseName, courseCode: s.courseCode, courseDuration: s.courseDuration,
  caseManager: s.caseManager, instructor: s.instructor, startDate: s.startDate, endDate: s.endDate,
});

/**
 * Rows as sent to the browser. A student's own sheet must not show staff-only details, so comments
 * are filtered: a student sees their own comments and staff comments, which is everything on their
 * row (nothing on a row belongs to another student). History stays out of the student view.
 */
export const rowsForStudent = (rows: SheetData["rows"]) =>
  rows.map((r) => (r.entry ? { ...r, entry: { ...r.entry, history: [] } } : r));

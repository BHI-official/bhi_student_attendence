import "server-only";
import type { Filter } from "mongodb";
import { cols, type Entry, type Student } from "./db";
import { env } from "./env";
import { clockIn, monthMinutes, sheetRows, todayIn, toMinutes } from "./sheet";
import { entriesHash } from "./hash";
import { signatureImages } from "./signatures";

export const today = () => todayIn(env().APP_TIMEZONE);
export const thisMonth = () => today().slice(0, 7);

/** The school's clock right now (or at an instant), in minutes since midnight, seconds dropped. */
export const schoolMinutes = (at = new Date()) => toMinutes(clockIn(env().APP_TIMEZONE, at, "end"));

/** School-wide holidays between two dates: date -> what is written on the sheet (name, and the note if any). */
export async function holidaysBetween(from: string, to: string) {
  const list = await (await cols()).holidays.find({ _id: { $gte: from, $lte: to } }).toArray();
  return new Map(list.map((h) => [h._id, h.note ? `${h.name} – ${h.note}` : h.name]));
}

/** Everything one month's printed sheet shows for one student (used by the PDF and Word reports). */
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
    ...list.flatMap((e) => [e.studentSignature?.id, e.staffSignature?.id, e.startInkId, e.endInkId, e.lunchStartInkId, e.lunchEndInkId, ...(e.comments ?? []).map((c) => c.inkId)]),
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

export const courseNames = async (scope: Filter<Student> = {}) =>
  ((await (await cols()).students.distinct("courseName", { $and: [scope, { active: true }] })) as string[]).filter(Boolean).sort();

/** Active teachers, for assignment menus and filters. */
export const teacherList = async () =>
  (await (await cols()).staff.find({ role: "TEACHER", active: true }, { projection: { name: 1 } }).sort({ name: 1 }).toArray()).map((t) => ({ id: t._id, name: t.name }));

/** Only the fields a page may show. Never send the whole student (it holds the PIN hash) to the browser. */
export const sheetHeader = (s: Student) => ({
  _id: s._id, name: s.name, courseName: s.courseName, courseCode: s.courseCode, courseDuration: s.courseDuration,
  caseManager: s.caseManager, instructor: s.instructor, startDate: s.startDate, endDate: s.endDate,
});
export type { Entry };

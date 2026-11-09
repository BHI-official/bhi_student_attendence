import "server-only";
import { cols, type Student } from "./db";
import { today } from "./data";
import { thresholds } from "./policy";
import { attendanceSummary, monthDates, type AttendanceSummary } from "./sheet";

type S = Pick<Student, "_id" | "startDate" | "endDate" | "classDays">;

/** The school-wide holiday dates between two dates. */
async function holidayDates(from: string, to: string) {
  if (from > to) return new Set<string>();
  const list = await (await cols()).holidays.find({ _id: { $gte: from, $lte: to } }, { projection: { _id: 1 } }).toArray();
  return new Set(list.map((h) => h._id));
}

/**
 * Attendance summary for many students at once, over their whole course so far, or over one month
 * (`month` = YYYY-MM). One query for the rows, one for the holidays.
 */
export async function summaries(students: S[], month?: string): Promise<Map<string, AttendanceSummary>> {
  const out = new Map<string, AttendanceSummary>();
  if (!students.length) return out;
  const now = today();
  const range = (s: S) => {
    if (!month) return { startDate: s.startDate, endDate: s.endDate };
    const days = monthDates(month);
    return { startDate: s.startDate > days[0] ? s.startDate : days[0], endDate: s.endDate < days[days.length - 1] ? s.endDate : days[days.length - 1] };
  };
  const ranges = students.map(range);
  const from = ranges.reduce((a, r) => (r.startDate < a ? r.startDate : a), "9999-12-31");
  const to = ranges.reduce((a, r) => (r.endDate > a ? r.endDate : a), "0000-01-01");
  const last = to < now ? to : now;
  const [rows, holidays] = await Promise.all([
    (await cols()).entries
      .find({ studentId: { $in: students.map((s) => s._id) }, date: { $gte: from, $lte: last } }, { projection: { studentId: 1, date: 1, status: 1, minutes: 1 } })
      .toArray(),
    holidayDates(from, last),
  ]);
  const byStudent = new Map<string, typeof rows>();
  for (const r of rows) (byStudent.get(r.studentId) ?? byStudent.set(r.studentId, []).get(r.studentId)!).push(r);
  const t = thresholds();
  students.forEach((s, i) => out.set(s._id, attendanceSummary({ ...ranges[i], classDays: s.classDays }, byStudent.get(s._id) ?? [], holidays, now, t)));
  return out;
}

export const summaryFor = async (s: S, month?: string) => (await summaries([s], month)).get(s._id)!;

import "server-only";
import { cols, type Entry, type Staff } from "./db";
import { studentScope } from "./access";
import { holidaysBetween, today } from "./data";
import { entriesHash } from "./hash";
import { enrollmentState } from "./sheet";

export type ApprovalState = "approved" | "outdated" | "none";

/** One student's month, as the teacher reviews it. */
export type ReviewRow = {
  id: string;
  name: string;
  course: string;
  startDate: string;
  endDate: string;
  state: ReturnType<typeof enrollmentState>;
  /** Days with something recorded (present, absent, excused). */
  recorded: number;
  present: number;
  /** Rows ready for the teacher's signature (any past day: each row is signed once). */
  toSign: number;
  /** Rows the student filled in later that no one has signed yet: check these first. */
  filledLater: number;
  approval: ApprovalState;
  approver: string | null;
};

/**
 * A row is ready for the staff signature when the day is decided (both times, or absent / excused)
 * and isn't a holiday. The same rule as signing in the sheet.
 */
const readyToSign = (e: Entry, holidays: Map<string, string>) =>
  !e.staffSignature && e.status !== "HOLIDAY" && !holidays.has(e.date) && (e.status !== "PRESENT" || (!!e.startTime && !!e.endTime));

/**
 * The teacher's students enrolled during `month` (optionally one course), with what is left to
 * review. Scoped to the teacher's own courses like every other teacher query.
 */
export async function reviewMonth(staff: Staff, month: string, course?: string): Promise<ReviewRow[]> {
  const first = `${month}-01`, last = `${month}-31`;
  const { students, entries, approvals } = await cols();
  const list = await students
    .find({ $and: [studentScope(staff), { active: true, startDate: { $lte: last }, endDate: { $gte: first } }, course ? { courseName: course } : {}] },
      { projection: { name: 1, nameLower: 1, courseName: 1, startDate: 1, endDate: 1, active: 1 } })
    .sort({ nameLower: 1 })
    .limit(1000)
    .toArray();
  if (!list.length) return [];
  const ids = list.map((s) => s._id);
  const [rows, apps, holidays] = await Promise.all([
    entries.find({ studentId: { $in: ids }, date: { $gte: first, $lte: last } }).toArray(),
    approvals.find({ studentId: { $in: ids }, month }).toArray(),
    holidaysBetween(first, last),
  ]);
  const byStudent = new Map<string, Entry[]>();
  for (const e of rows) byStudent.set(e.studentId, [...(byStudent.get(e.studentId) ?? []), e]);
  const appBy = new Map(apps.map((a) => [a.studentId, a]));
  const now = today();
  return list.map((s) => {
    const mine = byStudent.get(s._id) ?? [];
    const a = appBy.get(s._id);
    const counted = mine.filter((e) => e.status !== "HOLIDAY" && !holidays.has(e.date));
    return {
      id: s._id, name: s.name, course: s.courseName, startDate: s.startDate, endDate: s.endDate,
      state: enrollmentState(s, now),
      recorded: counted.length,
      present: counted.filter((e) => e.status === "PRESENT").length,
      toSign: mine.filter((e) => e.date <= now && readyToSign(e, holidays)).length,
      filledLater: mine.filter((e) => e.filledLaterAt && !e.staffSignature).length,
      approval: a ? (a.entriesHash === entriesHash(mine) ? "approved" : "outdated") : "none",
      approver: a?.staffName ?? null,
    };
  });
}

/** How a month's approval reads in a table cell. */
export const APPROVAL_WORDS: Record<ApprovalState, string> = { approved: "Approved", outdated: "Changed since approval", none: "Not approved" };

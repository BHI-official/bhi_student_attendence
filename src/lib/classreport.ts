import "server-only";
import type { Filter } from "mongodb";
import { cols, type Student } from "./db";
import { today } from "./data";
import { entriesHash } from "./hash";
import { enrollmentState } from "./sheet";
import { summaries } from "./summary";
import type { SummaryRow } from "./report";

/** Everyone in scope with at least one day of their course in `month`, optionally one class. */
export async function classMonth(scope: Filter<Student>, month: string, course?: string) {
  const { students, entries, approvals } = await cols();
  const list = await students
    .find({ $and: [scope, { startDate: { $lte: `${month}-31` }, endDate: { $gte: `${month}-01` } }, course ? { courseName: course } : {}] })
    .sort({ courseName: 1, nameLower: 1 })
    .limit(1000)
    .toArray();
  const sums = await summaries(list, month);
  const ids = list.map((s) => s._id);
  const [apps, rows] = await Promise.all([
    approvals.find({ studentId: { $in: ids }, month }).toArray(),
    entries.find({ studentId: { $in: ids }, date: { $gte: `${month}-01`, $lte: `${month}-31` } }).toArray(),
  ]);
  const byStudent = new Map<string, typeof rows>();
  for (const r of rows) (byStudent.get(r.studentId) ?? byStudent.set(r.studentId, []).get(r.studentId)!).push(r);
  const now = today();
  return list.map((s): SummaryRow & { id: string } => {
    const a = apps.find((x) => x.studentId === s._id);
    return {
      id: s._id, name: s.name, course: s.courseName, status: enrollmentState(s, now), summary: sums.get(s._id)!,
      approved: a ? (a.entriesHash === entriesHash(byStudent.get(s._id) ?? []) ? "current" : "outdated") : null,
    };
  });
}

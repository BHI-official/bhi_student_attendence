import "server-only";
import { cols, type Entry, type Staff, type Student } from "./db";
import { studentScope } from "./access";
import { holidaysBetween, today } from "./data";
import { addDays, isClassDay, time12 } from "./sheet";
import { dayStatus, isWeekday, teacherLock, type DayStatus } from "./week";
import type { ExcuseStatus } from "./types";

/** One student on one day, as the roster shows it. Plain data, safe to send to the browser. */
export type RosterRow = {
  key: string;
  studentId: string;
  name: string;
  program: string;
  teacherName: string;
  date: string;
  status: DayStatus;
  /** The four times as written by hand (image ids, shown through /api/ink/<id>), or typed by an admin. */
  times: { label: string; ink: string | null; typed: string }[];
  sig: string | null;
  /** The teacher marked them present / absent (who). Present without a signature stays Missing. */
  mark: "PRESENT" | "ABSENT" | null;
  markedByName: string | null;
  approvedBy: string | null;
  approvedSig: string | null;
  correction: string | null;
  excuse: { status: ExcuseStatus; note: string; fileName: string; reason: string; entryKey: string } | null;
  /** Submitted on a later day than the class day. */
  late: boolean;
  /** What the student wrote with their submission. */
  note: string | null;
  /** Why this staff member can't act on the row (teachers: older than last week). null = can act. */
  locked: string | null;
  /** Admin edited the row at some point. */
  edited: boolean;
  /** The admin who signed off this month ("Approved by"); the day is then closed for teachers. */
  signedOffBy: string | null;
};

export function toRow(
  student: Pick<Student, "_id" | "name" | "courseName">, teacherName: string, date: string, e: Entry | null, holiday: boolean, now: string, isAdmin: boolean,
  signedOffBy: string | null = null,
): RosterRow {
  const status = dayStatus(e, holiday, date, now);
  const studentNotes = (e?.comments ?? []).filter((c) => c.byRole === "STUDENT" && c.text);
  const present = e?.status === "PRESENT";
  return {
    key: `${student._id}:${date}`,
    studentId: student._id,
    name: student.name,
    program: student.courseName,
    teacherName,
    date,
    status,
    times: present ? dayTimes(e!) : [],
    sig: e?.studentSignature?.id ?? null,
    // A present day without the student's signature (teacher's mark, or recorded by an admin).
    mark: e?.markedBy?.mark ?? (e?.status === "PRESENT" && !e.studentSignature ? "PRESENT" : null),
    markedByName: e?.markedBy?.staffName ?? null,
    approvedBy: e?.staffSignature?.staffName ?? null,
    approvedSig: e?.staffSignature?.id ?? null,
    correction: e?.correction?.reason ?? null,
    excuse: e?.excuse ? { status: e.excuse.status, note: e.excuse.note, fileName: e.excuse.fileName, reason: e.excuse.reason ?? "", entryKey: e._id } : null,
    late: !!e?.filledLaterAt,
    note: studentNotes.length ? studentNotes[studentNotes.length - 1].text : null,
    locked: isAdmin ? null : signedOffBy ? `Signed off by ${signedOffBy}` : teacherLock(date, now),
    edited: !!e?.history?.some((h) => h.reason && h.what.startsWith("admin:")),
    signedOffBy,
  };
}

/** Start, lunch start, lunch end, end: handwritten images, or the time an admin typed. Empty ones are left out. */
export function dayTimes(e: Pick<Entry, "startTime" | "endTime" | "startInkId" | "endInkId" | "lunchStartInkId" | "lunchEndInkId">) {
  return [
    { label: "Start", ink: e.startInkId ?? null, typed: e.startInkId ? "" : time12(e.startTime) },
    { label: "Lunch out", ink: e.lunchStartInkId ?? null, typed: "" },
    { label: "Lunch in", ink: e.lunchEndInkId ?? null, typed: "" },
    { label: "End", ink: e.endInkId ?? null, typed: e.endInkId ? "" : time12(e.endTime) },
  ].filter((t) => t.ink || t.typed);
}

export type RosterQuery = { from: string; to: string; teacherId?: string; program?: string };

/**
 * Every class day between `from` and `to` (Monday to Friday) for every active student in scope:
 * a teacher's own assigned students, or for admins everyone (optionally one teacher's).
 */
export async function loadRoster(staff: Staff, q: RosterQuery) {
  const { students, entries, staff: staffCol, approvals } = await cols();
  const isAdmin = staff.role === "ADMIN";
  const filter = {
    $and: [
      studentScope(staff),
      { active: true, startDate: { $lte: q.to }, endDate: { $gte: q.from } },
      isAdmin && q.teacherId ? (q.teacherId === "none" ? { $or: [{ teacherId: null }, { teacherId: { $exists: false } }] } : { teacherId: q.teacherId }) : {},
      q.program ? { courseName: q.program } : {},
    ],
  };
  const list = await students.find(filter, { projection: { name: 1, nameLower: 1, courseName: 1, startDate: 1, endDate: 1, classDays: 1, teacherId: 1 } })
    .sort({ nameLower: 1 }).limit(3000).toArray();
  const [rows, holidays, teachers] = await Promise.all([
    entries.find({ studentId: { $in: list.map((s) => s._id) }, date: { $gte: q.from, $lte: q.to } }).toArray(),
    holidaysBetween(q.from, q.to),
    staffCol.find({ _id: { $in: [...new Set(list.map((s) => s.teacherId).filter((x): x is string => !!x))] } }, { projection: { name: 1 } }).toArray(),
  ]);
  const months = [...new Set([q.from.slice(0, 7), q.to.slice(0, 7)])];
  const signed = new Map((await approvals.find({ studentId: { $in: list.map((s) => s._id) }, month: { $in: months } }, { projection: { staffName: 1 } }).toArray()).map((a) => [a._id, a.staffName]));
  const byKey = new Map(rows.map((e) => [e._id, e]));
  const teacherName = new Map(teachers.map((t) => [t._id, t.name]));
  const now = today();
  const out: RosterRow[] = [];
  for (let d = q.from; d <= q.to; d = addDays(d, 1)) {
    if (!isWeekday(d)) continue;
    for (const s of list) {
      if (!isClassDay(s, d)) continue;
      out.push(toRow(s, s.teacherId ? teacherName.get(s.teacherId) ?? "" : "", d, byKey.get(`${s._id}:${d}`) ?? null, holidays.has(d), now, isAdmin, signed.get(`${s._id}:${d.slice(0, 7)}`) ?? null));
    }
  }
  const programs = [...new Set(list.map((s) => s.courseName).filter(Boolean))].sort();
  return { rows: out, programs, studentCount: list.length };
}

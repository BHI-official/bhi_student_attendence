import { z } from "zod";
import { cols, newId, isDuplicateKey } from "@/db";
import { integrationAuthorized } from "@/lib/integration";
import { instructorTeachesClass } from "@/lib/authz";
import { audit } from "@/lib/audit";
import { attendanceChanges, dateProblem, enrolledOn } from "@/lib/attendance-rules";
import { TIME_RE, hoursFromTimes, timesProblem } from "@/lib/timesheet";

const bodySchema = z.object({
  classId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  recordedByEmail: z.string().email(),
  records: z.array(z.object({
    enrollmentId: z.string().uuid(),
    status: z.enum(["PRESENT", "ABSENT", "LATE", "EXCUSED", "HOLIDAY"]),
    /** Optional when start and end times are given: hours are then computed from the times. */
    hours: z.number().min(0).max(24).optional(),
    /** Omit to keep the note already on the record (e.g. one written by the instructor). */
    note: z.string().max(300).optional(),
    // Handwritten monthly sheet (DFS / Private): times as HH:MM, and the student's signature as a PNG data URL.
    startTime: z.string().regex(TIME_RE).optional(),
    lunchOut: z.string().regex(TIME_RE).optional(),
    lunchIn: z.string().regex(TIME_RE).optional(),
    endTime: z.string().regex(TIME_RE).optional(),
    studentSignature: z.string().regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/).max(300_000).optional(),
  })).min(1).max(500),
});

/** Accepts attendance from the existing attendance app, keyed by LMS class and enrollment IDs. */
export async function POST(req: Request) {
  if (!integrationAuthorized(req)) return new Response("Unauthorized", { status: 401 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid body", issues: parsed.error.issues }, { status: 400 });
  const { classId, date, recordedByEmail, records } = parsed.data;
  const { users, classes, enrollments, classSessions } = await cols();

  const recorder = await users.findOne({ email: recordedByEmail.toLowerCase() });
  // Same rules as signing in: disabled accounts and unapproved instructors can't record.
  const allowed = recorder && !recorder.disabledAt && !!recorder.emailVerifiedAt &&
    (recorder.role === "ADMIN" || (recorder.role === "INSTRUCTOR" && recorder.instructorStatus === "APPROVED"));
  if (!recorder || !allowed) return Response.json({ error: "Unknown recorder" }, { status: 400 });
  const klass = await classes.findOne({ _id: classId });
  if (!klass) return Response.json({ error: "Unknown class" }, { status: 400 });
  if (recorder.role === "INSTRUCTOR" && !(await instructorTeachesClass(recorder._id, classId))) {
    return Response.json({ error: "Recorder is not assigned to this class" }, { status: 403 });
  }
  const problem = dateProblem(klass, date, recorder.role);
  if (problem) return Response.json({ error: problem }, { status: 400 });
  const ens = new Map((await enrollments.find({ classId }).toArray()).map((e) => [e._id, e]));
  const bad = records.filter((r) => !ens.has(r.enrollmentId)).map((r) => r.enrollmentId);
  if (bad.length) return Response.json({ error: "Enrollments not in this class", enrollmentIds: bad }, { status: 400 });
  const notEnrolled = records.filter((r) => !enrolledOn(ens.get(r.enrollmentId)!, date)).map((r) => r.enrollmentId);
  if (notEnrolled.length) return Response.json({ error: "Students not enrolled on this date (withdrawn or completed)", enrollmentIds: notEnrolled }, { status: 400 });
  if (new Set(records.map((r) => r.enrollmentId)).size !== records.length) return Response.json({ error: "Duplicate enrollmentId in records" }, { status: 400 });

  const timeErrors = records.map((r) => ({ id: r.enrollmentId, problem: timesProblem(r) })).filter((x) => x.problem);
  if (timeErrors.length) return Response.json({ error: "Invalid times", details: timeErrors }, { status: 400 });

  const now = new Date();
  const set: Record<string, unknown> = {};
  const existing = (await classSessions.findOne({ classId, date }, { projection: { records: 1 } }))?.records ?? {};
  type M = { status: typeof records[number]["status"]; hours: number; note: string; startTime?: string; lunchOut?: string; lunchIn?: string; endTime?: string };
  const marks: Record<string, M> = {};
  for (const r of records) {
    const fromTimes = hoursFromTimes(r);
    const off = r.status === "ABSENT" || r.status === "HOLIDAY" || r.status === "EXCUSED";
    const mark: M = { status: r.status, hours: off ? 0 : Math.round((r.hours ?? fromTimes ?? 0) * 100) / 100, note: r.note !== undefined ? r.note.trim() : existing[r.enrollmentId]?.note ?? "" };
    for (const k of ["startTime", "lunchOut", "lunchIn", "endTime"] as const) if (r[k] !== undefined) mark[k] = r[k];
    marks[r.enrollmentId] = mark;
    // Field-by-field so values the app didn't send (e.g. an instructor's note) are kept.
    // Marked as staff-entered (source), so a student who checked in can no longer "Fill" over it.
    for (const [k, v] of Object.entries({ ...mark, minutes: Math.round(mark.hours * 60), source: "INTEGRATION", recordedById: recorder._id, updatedAt: now })) {
      set[`records.${r.enrollmentId}.${k}`] = v;
    }
    if (r.studentSignature) set[`records.${r.enrollmentId}.studentSignature`] = { imageDataUrl: r.studentSignature, signedAt: now, capturedById: recorder._id };
  }
  const before = await classSessions.findOne({ classId, date }, { projection: { records: 1 } });
  const changes = attendanceChanges(before?.records, marks);
  const upsert = () =>
    classSessions.updateOne({ classId, date }, { $set: set, $setOnInsert: { _id: newId(), classId, date, createdAt: now } }, { upsert: true });
  try {
    await upsert();
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;
    await upsert();
  }
  await audit(recorder._id, "attendance.integration", "class", classId, { date, count: records.length, changes, via: "integration" });
  return Response.json({ ok: true, saved: records.length });
}

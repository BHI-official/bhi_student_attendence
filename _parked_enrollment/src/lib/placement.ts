import "server-only";
import { cols, newId, isDuplicateKey, type Category, type Course, type Enrollment, type Klass } from "@/db";
import { todayLocal } from "@/lib/dates";

/**
 * Course enrollment and section placement.
 *
 * A student's course enrollment is an Enrollment row pointing at a section (class) of that course.
 * On approval the student is placed in an open section of the course they chose; if the course has
 * none yet, a "General section" is created so approval always results in a working enrollment.
 * Admins can then create more sections, move students and merge sections.
 *
 * History rule: rows are never deleted or re-pointed. Moving a student ends the old enrollment
 * (TRANSFERRED, with a link to the new one) and starts a new one. Attendance, monthly sign-offs,
 * biweekly sheets and progress reports stay keyed to the enrollment they were written under, with
 * the instructor who wrote them.
 */

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export const fundingFits = (klass: Pick<Klass, "fundingProgram">, category: Category | null) =>
  klass.fundingProgram === "MIXED" || (!!category && klass.fundingProgram === category);

/**
 * Finds or creates the course's default section. Safe under concurrency (unique class code).
 * It is a rolling section: when it gets near its end date it is extended, so a student approved a
 * year later is never placed in a section that has already ended. An archived default section is
 * never reused: a new one is made with a numbered code.
 */
export async function ensureDefaultSection(course: Course): Promise<Klass> {
  const { classes } = await cols();
  const today = todayLocal();
  const existing = await classes.findOne({ courseId: course._id, isDefaultSection: true, archived: false });
  if (existing) {
    if (existing.endDate < addDays(today, 90)) {
      const endDate = addDays(today, 365);
      await classes.updateOne({ _id: existing._id, endDate: existing.endDate }, { $set: { endDate } });
      return { ...existing, endDate };
    }
    return existing;
  }
  const base = `${course.name.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24).toUpperCase() || "COURSE"}-GEN-${course._id.slice(0, 4).toUpperCase()}`;
  for (let n = 1; n <= 20; n++) {
    const code = n === 1 ? base : `${base}-${n}`;
    const klass: Klass = {
      _id: newId(), courseId: course._id, code, cohort: "General section", startDate: today, endDate: addDays(today, 365),
      schedule: "", location: "", capacity: 1000, fundingProgram: "MIXED", archived: false, instructors: [],
      isDefaultSection: true, mergedIntoClassId: null, mergedAt: null, createdAt: new Date(),
    };
    try {
      await classes.insertOne(klass);
      return klass;
    } catch (e) {
      if (!isDuplicateKey(e)) throw e;
      // That code is taken: by an open default section created at the same moment (use it), or by an
      // archived one or another class (try the next number).
      const taken = await classes.findOne({ code });
      if (taken && taken.courseId === course._id && taken.isDefaultSection && !taken.archived) return taken;
    }
  }
  throw new Error(`Could not create a default section for ${course.name}`);
}

/** Picks the section an approved student joins: an open, funding-compatible section with room, else the default section. */
export async function pickSection(course: Course, category: Category | null): Promise<Klass> {
  const { classes, enrollments } = await cols();
  const today = todayLocal();
  const candidates = await classes
    .find({ courseId: course._id, archived: false, endDate: { $gte: today } })
    .sort({ isDefaultSection: 1, startDate: 1 })
    .toArray();
  for (const k of candidates) {
    if (!fundingFits(k, category)) continue;
    const n = await enrollments.countDocuments({ classId: k._id, status: "ACTIVE" });
    if (n < k.capacity) return k;
  }
  return ensureDefaultSection(course);
}

/** Starts (or reactivates) an enrollment of the student in a section. Returns the enrollment. */
export async function startEnrollment(studentId: string, klass: Klass, byId: string, movedFrom: string | null = null): Promise<Enrollment> {
  const { enrollments } = await cols();
  const existing = await enrollments.findOne({ studentId, classId: klass._id });
  if (existing?.status === "ACTIVE") return existing;
  const now = new Date();
  if (existing) {
    await enrollments.updateOne(
      { _id: existing._id },
      { $set: { status: "ACTIVE", endedAt: null, assignedById: byId, assignedAt: now, courseId: klass.courseId, movedFromEnrollmentId: movedFrom, endReason: null } },
    );
    return { ...existing, status: "ACTIVE", endedAt: null, assignedById: byId, assignedAt: now };
  }
  const row: Enrollment = {
    _id: newId(), studentId, classId: klass._id, courseId: klass.courseId, status: "ACTIVE", assignedById: byId, assignedAt: now, endedAt: null,
    movedFromEnrollmentId: movedFrom, movedToEnrollmentId: null, endReason: null,
  };
  try {
    await enrollments.insertOne(row);
    return row;
  } catch (e) {
    if (!isDuplicateKey(e)) throw e; // a double click inserted it first
    return (await enrollments.findOne({ studentId, classId: klass._id }))!;
  }
}

/** Enrolls an approved student in their chosen course. No-op if they're already active in a section of it. */
export async function enrollInCourse(studentId: string, course: Course, category: Category | null, byId: string) {
  const { enrollments, classes } = await cols();
  const sectionIds = (await classes.find({ courseId: course._id }, { projection: { _id: 1 } }).toArray()).map((k) => k._id);
  const already = await enrollments.findOne({ studentId, status: "ACTIVE", classId: { $in: sectionIds } });
  if (already) return { enrollment: already, klass: (await classes.findOne({ _id: already.classId }))!, created: false };
  const klass = await pickSection(course, category);
  const enrollment = await startEnrollment(studentId, klass, byId);
  return { enrollment, klass, created: true };
}

/**
 * Moves one active enrollment to another section. The old row is ended as TRANSFERRED (only if it is
 * still active, so a double click can't move twice) and linked to the new row.
 */
export async function moveEnrollment(enrollment: Enrollment, target: Klass, byId: string, reason: string) {
  const { enrollments } = await cols();
  if (enrollment.classId === target._id) return { ok: false as const, error: "The student is already in that section." };
  const ended = await enrollments.updateOne(
    { _id: enrollment._id, status: "ACTIVE" },
    { $set: { status: "TRANSFERRED", endedAt: new Date(), endReason: reason } },
  );
  if (!ended.modifiedCount) return { ok: false as const, error: "That enrollment is no longer active." };
  const next = await startEnrollment(enrollment.studentId, target, byId, enrollment._id);
  await enrollments.updateOne({ _id: enrollment._id }, { $set: { movedToEnrollmentId: next._id } });
  return { ok: true as const, enrollment: next };
}

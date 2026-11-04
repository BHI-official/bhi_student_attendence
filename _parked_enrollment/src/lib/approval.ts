import "server-only";
import { cols, type ApplicationStatus } from "@/db";
import { enrollInCourse } from "@/lib/placement";
import { approvalBlockedByPayment } from "@/lib/payment";
import { courseServes } from "@/lib/courses";
import { audit } from "@/lib/audit";
import { sendDecisionEmail, trySend } from "@/lib/email";
import { CATEGORY_LABELS } from "@/lib/forms/templates";

export const REVIEWABLE: ApplicationStatus[] = ["SUBMITTED", "RESUBMITTED"];

export type ApprovalResult =
  | { ok: true; message: string; courseName: string; classCode: string }
  | { ok: false; error: string };

/**
 * Approves an application and enrolls the student in a section of their chosen course. Used by an
 * admin's "Approve" and, for Private students, automatically when their online payment succeeds.
 * Every step is conditional, so running it twice (a double click, a repeated Stripe event) is safe.
 *
 * @param decidedById who the approval is recorded as (the admin, or the admin who requested the payment)
 * @param via         how it happened, for the audit log ("admin" or "stripe")
 */
export async function approveApplication(applicationId: string, decidedById: string, via: "admin" | "stripe"): Promise<ApprovalResult> {
  const { applications, users, courses } = await cols();
  const app = await applications.findOne({ _id: applicationId });
  if (!app) return { ok: false, error: "Application not found." };
  const student = await users.findOne({ _id: app.studentId });
  if (!student) return { ok: false, error: "Student not found." };
  if (approvalBlockedByPayment(app)) return { ok: false, error: "Tuition payment isn't settled yet. Send a payment request, or mark it paid or waived, before approving this Private application." };
  if (student.disabledAt) return { ok: false, error: "This student's account is disabled. Re-enable it first." };
  const course = app.courseId ? await courses.findOne({ _id: app.courseId }) : null;
  if (!course || course.archived) return { ok: false, error: "The student hasn't chosen an available course. Edit the application's course first." };
  if (!courseServes(course, app.category)) return { ok: false, error: `${course.name} isn't offered to ${app.category ? CATEGORY_LABELS[app.category] : "this program"}. Change the course first.` };

  const now = new Date();
  const res = await applications.updateOne(
    // Payment is re-checked in the same update: an admin can't approve while it was reset meanwhile.
    { _id: applicationId, status: { $in: REVIEWABLE }, ...(app.category === "PRIVATE" ? { paymentStatus: { $in: ["PAID", "WAIVED"] } } : {}) },
    { $set: { status: "APPROVED", decidedAt: now, decidedById, rejectionReason: null, updatedAt: now } },
  );
  if (!res.modifiedCount) return { ok: false, error: "Only pending applications can be approved. Reload to see the latest status." };
  await audit(via === "admin" ? decidedById : null, "application.approve", "application", applicationId, { courseId: course._id, via });

  let placed;
  try {
    placed = await enrollInCourse(app.studentId, course, app.category, decidedById);
  } catch (e) {
    console.error("[approve] placement failed", e);
    return { ok: false, error: `Approved, but the student couldn't be placed in ${course.name}. Assign a section from the student's page.` };
  }
  await audit(via === "admin" ? decidedById : null, "enrollment.assign", "class", placed.klass._id, { studentId: app.studentId, via: `approval:${via}`, courseId: course._id });
  const emailed = await trySend(() => sendDecisionEmail(student.email, student.name, "APPROVED", undefined, course.name));
  return {
    ok: true,
    courseName: course.name,
    classCode: placed.klass.code,
    message: `Approved and enrolled in ${course.name} (${placed.klass.code}${placed.klass.isDefaultSection ? ", default section" : ""}). ` +
      (emailed ? "The student was emailed." : "The approval email could not be sent; let the student know directly."),
  };
}

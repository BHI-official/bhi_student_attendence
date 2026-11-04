"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { cols, newId, isDuplicateKey, type Category, type User } from "@/db";
import { moveEnrollment, fundingFits } from "@/lib/placement";
import { formatUsd, parseUsdToCents } from "@/lib/payment";
import { approveApplication, REVIEWABLE } from "@/lib/approval";
import { closeCheckout, settleCheckoutSession, stripe, stripeEnabled } from "@/lib/tuition";
import { courseServes } from "@/lib/courses";
import { clientMeta } from "@/lib/session";
import { requireAdmin } from "@/lib/auth";
import { revokeAllSessions } from "@/lib/session";
import { audit } from "@/lib/audit";
import { invalid, formObject, type ActionState } from "@/lib/action";
import { ALL_SECTIONS, answersHash, enrollmentState, selectionUpdate, validateSelection } from "@/lib/enrollment";
import {
  sendClassAssignedEmail, sendCorrectionsEmail, sendDecisionEmail, sendInstructorClassEmail, sendInstructorCoursesEmail, sendInstructorDecisionEmail,
  sendInstructorInviteEmail, sendPaymentRequestEmail, sendPaymentVerifiedEmail, trySend,
} from "@/lib/email";
import { deleteFile } from "@/lib/storage";
import { INVITE_TTL_DAYS, newInviteToken } from "@/lib/invite";
import { canonicalEmail } from "@/lib/email-canonical";
import { randomBytes } from "node:crypto";
import { hashPassword } from "@/lib/password";
import { CATEGORY_LABELS, coerceRaw, getTemplate, schemaFor, sectionLabel } from "@/lib/forms/templates";

const uuid = z.string().uuid();

async function loadApp(id: string) {
  const { applications, users } = await cols();
  const app = await applications.findOne({ _id: id });
  const student = app ? await users.findOne({ _id: app.studentId }) : null;
  return app && student ? { app, student } : null;
}

// ---------- Applications ----------
// Status changes are conditional updates ({ status: { $in: allowed } }), so double clicks and
// two admins acting at once can't move an application twice.

/**
 * Approval enrolls the student in the course they chose (an open section, or the course's default
 * section). Private applications need a settled payment first (paid online, paid offline or waived).
 */
export async function approveApplicationAction(applicationId: string, _: ActionState): Promise<ActionState> {
  const admin = await requireAdmin();
  const r = await approveApplication(applicationId, admin._id, "admin");
  revalidatePath("/admin", "layout");
  return r.ok ? { ok: true, message: r.message } : { error: r.error };
}

export async function rejectApplicationAction(applicationId: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const reason = z.string().trim().min(5, "Give the student a reason (at least 5 characters)").max(2000).safeParse(fd.get("reason"));
  if (!reason.success) return { fieldErrors: { reason: reason.error.issues[0].message } };
  const row = await loadApp(applicationId);
  if (!row) return { error: "Application not found." };
  const { applications } = await cols();
  const res = await applications.updateOne(
    { _id: applicationId, status: { $in: [...REVIEWABLE, "CORRECTIONS_REQUESTED"] } },
    { $set: { status: "REJECTED", decidedAt: new Date(), decidedById: admin._id, rejectionReason: reason.data, updatedAt: new Date() } },
  );
  if (!res.modifiedCount) return { error: "This application can't be rejected in its current status." };
  await audit(admin._id, "application.reject", "application", applicationId, { reason: reason.data });
  // An open payment request can no longer be paid once the application is rejected.
  if (row.app.paymentRequest?.status === "OPEN") await cancelRequest(row.app._id, row.app.paymentRequest.id, admin._id, "application rejected");
  const emailed = await trySend(() => sendDecisionEmail(row.student.email, row.student.name, "REJECTED", reason.data));
  revalidatePath("/admin", "layout");
  return { ok: true, message: emailed ? "Application rejected and the student was emailed." : "Application rejected. The email could not be sent; contact the student directly." };
}

export async function requestCorrectionsAction(applicationId: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const row = await loadApp(applicationId);
  if (!row) return { error: "Application not found." };
  const allowed = ALL_SECTIONS(row.app);
  const sections = fd.getAll("sections").map(String).filter((s) => allowed.includes(s));
  const note = z.string().trim().min(5, "Explain what needs to change (at least 5 characters)").max(3000).safeParse(fd.get("note"));
  const errors: Record<string, string> = {};
  if (!sections.length) errors.sections = "Pick at least one section to unlock";
  if (!note.success) errors.note = note.error.issues[0].message;
  if (Object.keys(errors).length || !note.success) return { fieldErrors: errors };

  const { applications } = await cols();
  const res = await applications.updateOne(
    { _id: applicationId, status: { $in: REVIEWABLE } },
    {
      $set: { status: "CORRECTIONS_REQUESTED", updatedAt: new Date() },
      $push: { corrections: { _id: newId(), sections, note: note.data, requestedById: admin._id, createdAt: new Date(), resolvedAt: null } },
    },
  );
  if (!res.modifiedCount) return { error: "Corrections can only be requested on pending applications." };
  await audit(admin._id, "application.request_corrections", "application", applicationId, { sections, note: note.data });
  const emailed = await trySend(() => sendCorrectionsEmail(row.student.email, row.student.name, sections.map(sectionLabel), note.data));
  revalidatePath("/admin", "layout");
  return {
    ok: true,
    message: emailed ? "Correction request sent to the student." : "Corrections requested (the student sees them when signing in), but the email could not be sent.",
  };
}

/** Undo a mistaken rejection: the application goes back to the review queue. The reason stays in the audit log. */
export async function reopenApplicationAction(applicationId: string, _: ActionState): Promise<ActionState> {
  const admin = await requireAdmin();
  const { applications } = await cols();
  const before = await applications.findOne({ _id: applicationId }, { projection: { rejectionReason: 1 } });
  const res = await applications.updateOne(
    { _id: applicationId, status: "REJECTED" },
    { $set: { status: "SUBMITTED", decidedAt: null, decidedById: null, rejectionReason: null, updatedAt: new Date() } },
  );
  if (!res.modifiedCount) return { error: "Only rejected applications can be reopened." };
  await audit(admin._id, "application.reopen", "application", applicationId, { previousReason: before?.rejectionReason ?? null });
  revalidatePath("/admin", "layout");
  return { ok: true, message: "Application reopened and back in the review queue." };
}

// ---------- Private tuition payment ----------
// Private students submit without paying. After reviewing, an admin sends a payment request with the
// amount; the student pays online (Stripe) and is then approved automatically. Admins can also record
// an offline payment or waive it. Only PRIVATE applications match, so a funded student never gets one.

/** Marks a request cancelled (if it is still the current, open one) and stops its Stripe page. */
async function cancelRequest(applicationId: string, requestId: string, byId: string, reason: string): Promise<"CANCELLED" | "PAID" | "GONE"> {
  const { applications } = await cols();
  const app = await applications.findOne({ _id: applicationId, "paymentRequest.id": requestId });
  if (!app?.paymentRequest || app.paymentRequest.status !== "OPEN") return "GONE";
  // If the student already paid on the Stripe page, record the payment instead of cancelling it.
  if ((await closeCheckout(app.paymentRequest.checkoutSessionId)) === "PAID") {
    await settleCheckoutSession(await stripe().checkout.sessions.retrieve(app.paymentRequest.checkoutSessionId!), "return");
    return "PAID";
  }
  await applications.updateOne(
    { _id: applicationId, "paymentRequest.id": requestId, "paymentRequest.status": "OPEN" },
    {
      $set: {
        "paymentRequest.status": "CANCELLED", "paymentRequest.cancelledAt": new Date(), "paymentRequest.cancelledById": byId,
        "paymentRequest.cancelReason": reason, paymentStatus: "PENDING", updatedAt: new Date(),
      },
    },
  );
  return "CANCELLED";
}

/**
 * Admin, after reviewing a Private application: asks the student to pay `amount` online. The student
 * is emailed and sees the request on their status page. Sending a new amount replaces the open request.
 */
export async function requestPaymentAction(applicationId: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  if (!stripeEnabled()) return { error: "Online payment isn't set up yet (STRIPE_SECRET_KEY). Record the payment offline, or set up Stripe first." };
  const cents = parseUsdToCents(String(fd.get("amount") ?? ""));
  if (cents === null) return { fieldErrors: { amount: "Enter an amount in dollars between $0.50 and $50,000, e.g. 1500 or 1500.00" } };
  const note = z.string().trim().max(500).safeParse(fd.get("note") ?? "");
  if (!note.success) return { fieldErrors: { note: "500 characters at most" } };
  const row = await loadApp(applicationId);
  if (!row) return { error: "Application not found." };
  const { app, student } = row;
  if (app.category !== "PRIVATE") return { error: "Payment requests are for Private applications only." };
  if (!REVIEWABLE.includes(app.status)) return { error: "Send a payment request while the application is waiting for review." };
  if (app.paymentStatus === "PAID" || app.paymentStatus === "WAIVED") return { error: "Tuition is already settled for this application." };
  if (student.disabledAt) return { error: "This student's account is disabled. Re-enable it first." };

  // Replacing an open request: its payment page stops working first (unless the student just paid in it).
  const previous = app.paymentRequest?.status === "OPEN" ? app.paymentRequest : null;
  if (previous && (await cancelRequest(app._id, previous.id, admin._id, "replaced by a new request")) === "PAID") {
    revalidatePath("/admin", "layout");
    return { error: "The student had just paid the earlier request. The payment was recorded; check the application." };
  }
  const { applications, courses } = await cols();
  const fresh = await applications.findOne({ _id: app._id });
  const now = new Date();
  const request = {
    id: newId(), amountCents: cents, currency: "usd" as const, note: note.data, requestedById: admin._id, requestedAt: now,
    status: "OPEN" as const, checkoutSessionId: null, checkoutUrl: null, checkoutAttempts: 0,
  };
  const res = await applications.updateOne(
    { _id: app._id, category: "PRIVATE", status: { $in: REVIEWABLE }, paymentStatus: { $nin: ["PAID", "WAIVED"] }, updatedAt: fresh?.updatedAt },
    {
      $set: { paymentRequest: request, paymentStatus: "REQUESTED", updatedAt: now },
      ...(fresh?.paymentRequest ? { $push: { paymentRequestHistory: fresh.paymentRequest } } : {}),
    },
  );
  if (!res.modifiedCount) return { error: "The application changed meanwhile. Reload and try again." };
  await audit(admin._id, "application.payment_requested", "application", app._id, { amountCents: cents, requestId: request.id, replaced: previous?.id ?? null });
  const course = app.courseId ? await courses.findOne({ _id: app.courseId }, { projection: { name: 1 } }) : null;
  const emailed = await trySend(() => sendPaymentRequestEmail(student.email, student.name, formatUsd(cents), course?.name ?? "your course", note.data));
  revalidatePath("/admin", "layout");
  return { ok: true, message: `Payment request for ${formatUsd(cents)} sent.${emailed ? " The student was emailed." : " The email could not be sent; the student still sees it when signing in."}` };
}

/** Admin: withdraws the open payment request (the student's payment page stops working). */
export async function cancelPaymentRequestAction(applicationId: string, _: ActionState): Promise<ActionState> {
  const admin = await requireAdmin();
  const { applications } = await cols();
  const app = await applications.findOne({ _id: applicationId }, { projection: { paymentRequest: 1 } });
  if (app?.paymentRequest?.status !== "OPEN") return { error: "There is no open payment request." };
  const r = await cancelRequest(applicationId, app.paymentRequest.id, admin._id, "cancelled by admin");
  await audit(admin._id, "application.payment_request_cancelled", "application", applicationId, { requestId: app.paymentRequest.id, result: r });
  revalidatePath("/admin", "layout");
  if (r === "PAID") return { error: "The student had already paid, so the payment was recorded instead." };
  return { ok: true, message: "Payment request cancelled." };
}

/** Admin records a payment made offline (cash, check, bank transfer) or waives it, or resets it to unpaid. */
export async function setPaymentStatusAction(applicationId: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const status = z.enum(["PENDING", "PAID", "WAIVED"]).safeParse(fd.get("paymentStatus"));
  if (!status.success) return { error: "Invalid payment status." };
  const reference = z.string().trim().max(200).safeParse(fd.get("reference") ?? "");
  const settled = status.data !== "PENDING";
  const { applications } = await cols();
  const before = await applications.findOne({ _id: applicationId, category: "PRIVATE" }, { projection: { paymentStatus: 1, studentId: 1, paymentRequest: 1 } });
  if (!before) return { error: "Payment applies to Private applications only." };
  if (before.paymentRequest?.status === "PAID" && status.data !== "PAID") {
    return { error: "This tuition was paid online. Refund it in Stripe first if it must be undone." };
  }
  // An open online request is closed first, so the student can't also pay online.
  if (before.paymentRequest?.status === "OPEN") {
    const r = await cancelRequest(applicationId, before.paymentRequest.id, admin._id, `settled offline (${status.data.toLowerCase()})`);
    if (r === "PAID") {
      revalidatePath("/admin", "layout");
      return { error: "The student had just paid online, so that payment was recorded instead." };
    }
  }
  const res = await applications.updateOne(
    { _id: applicationId, category: "PRIVATE" },
    {
      $set: {
        paymentStatus: status.data, paymentVerifiedAt: settled ? new Date() : null, paymentVerifiedById: settled ? admin._id : null,
        ...(settled && reference.success && reference.data ? { paymentReference: reference.data } : {}), updatedAt: new Date(),
      },
    },
  );
  if (!res.matchedCount) return { error: "Payment applies to Private applications only." };
  await audit(admin._id, "application.payment_status", "application", applicationId, {
    from: before.paymentStatus, status: status.data, reference: reference.success ? reference.data : "",
  });
  let note = "";
  if (settled && before.paymentStatus !== status.data && (status.data === "PAID" || status.data === "WAIVED")) {
    const student = await (await cols()).users.findOne({ _id: before.studentId });
    if (student) note = (await trySend(() => sendPaymentVerifiedEmail(student.email, student.name, status.data as "PAID" | "WAIVED")))
      ? " The student was emailed." : " The email to the student could not be sent.";
  }
  revalidatePath("/admin", "layout");
  return { ok: true, message: `Payment marked ${status.data.toLowerCase()}.${note}` };
}

// ---------- Admin edits to an application ----------
// Every edit is audited with before/after values. Student signatures stay on record; forms an admin
// changed after signing are labelled as such on the review page and in the PDF.

export async function adminSetSelectionAction(applicationId: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const { applications } = await cols();
  const app = await applications.findOne({ _id: applicationId });
  if (!app) return { error: "Application not found." };
  const v = validateSelection({
    enrollmentType: String(fd.get("enrollmentType") ?? ""), fundingProgram: String(fd.get("fundingProgram") ?? ""), county: String(fd.get("county") ?? ""),
  });
  if (!v.ok) return { fieldErrors: { [v.field]: v.message } };
  const { set, unset, stale } = selectionUpdate(app, v.selection, v.category);
  const res = await applications.updateOne({ _id: app._id, updatedAt: app.updatedAt }, { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) });
  if (!res.matchedCount) return { error: "The application changed meanwhile. Reload and try again." };
  await Promise.all(stale.map((d) => deleteFile(d.storageKey)));
  await audit(admin._id, "application.admin_set_category", "application", app._id, {
    from: { category: app.category, county: app.county ?? null }, to: { category: v.category, county: v.selection.county }, removedForms: Object.keys(unset),
  });
  revalidatePath("/admin", "layout");
  return { ok: true, message: "Enrollment type and program updated." };
}

export async function adminSetCourseAction(applicationId: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const id = uuid.safeParse(fd.get("courseId"));
  if (!id.success) return { fieldErrors: { courseId: "Choose a course" } };
  const { applications, courses } = await cols();
  const app = await applications.findOne({ _id: applicationId });
  if (!app) return { error: "Application not found." };
  const course = await courses.findOne({ _id: id.data });
  if (!course || course.archived) return { fieldErrors: { courseId: "That course isn't available" } };
  if (!courseServes(course, app.category)) return { fieldErrors: { courseId: "That course isn't offered to this student's program" } };
  await applications.updateOne({ _id: app._id }, { $set: { courseId: course._id, updatedAt: new Date() } });
  await audit(admin._id, "application.admin_set_course", "application", app._id, { from: app.courseId ?? null, to: course._id });
  revalidatePath("/admin", "layout");
  return { ok: true, message: `Course set to ${course.name}.${app.status === "APPROVED" ? " The student's current enrollment is unchanged; move them from the class page if needed." : ""}` };
}

export async function adminSaveFormAction(applicationId: string, templateKey: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const { applications } = await cols();
  const app = await applications.findOne({ _id: applicationId });
  if (!app) return { error: "Application not found." };
  // Same server-side filter as the student: a Non-Private application has no fee forms to edit.
  const template = getTemplate(templateKey, app.category);
  if (!template) return { error: "This form isn't part of this application." };
  const values = coerceRaw(template, Object.fromEntries(template.fields.map((f) => [f.name, fd.get(f.name) ?? undefined])));
  const parsed = schemaFor(template).safeParse(values);
  if (!parsed.success) return invalid(parsed.error);
  const data = parsed.data as Record<string, unknown>;
  const before = app.forms?.[template.key]?.data ?? null;
  const now = new Date();
  const sig = app.signatures?.[template.key];
  const unchanged = before && answersHash(template.key, before as Record<string, unknown>) === answersHash(template.key, data);
  if (unchanged) return { ok: true, message: "No changes." };
  const res = await applications.updateOne({ _id: app._id, updatedAt: app.updatedAt }, {
    $set: {
      [`forms.${template.key}`]: {
        templateVersion: template.version, data, completedAt: app.forms?.[template.key]?.completedAt ?? now, updatedAt: now,
        // Only marked as an admin edit if a signature exists that the change now differs from.
        adminEditedAt: sig ? now : null, adminEditedById: admin._id,
      },
      updatedAt: now,
    },
  });
  if (!res.matchedCount) return { error: "The application changed meanwhile. Reload and try again." };
  const meta = await clientMeta();
  await audit(admin._id, "application.admin_edit_form", "application", app._id, { template: template.key, before, after: data, ip: meta.ip });
  revalidatePath("/admin", "layout");
  return { ok: true, message: `${template.title} saved. The change is recorded in the history.` };
}

// ---------- Class assignment ----------

const assignSchema = z.object({ studentId: uuid, classId: z.string().uuid("Choose a class") });

export async function assignStudentAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const parsed = assignSchema.safeParse(formObject(fd));
  if (!parsed.success) return invalid(parsed.error);
  const { studentId, classId } = parsed.data;
  const { applications, classes, courses, enrollments, users } = await cols();

  const app = await applications.findOne({ studentId });
  if (!app || app.status !== "APPROVED") return { error: "Only approved students can be assigned to a class." };
  const studentUser = await users.findOne({ _id: studentId }, { projection: { disabledAt: 1 } });
  if (!studentUser || studentUser.disabledAt) return { error: "This student's account is disabled. Re-enable it first." };
  const klass = await classes.findOne({ _id: classId });
  const course = klass ? await courses.findOne({ _id: klass.courseId }) : null;
  if (!klass || !course || klass.archived || course.archived) return { fieldErrors: { classId: "That class isn't available" } };

  // Funding must match: a Hudson County student billed under an EQISS or private class (or the
  // reverse) is a billing and compliance error. MIXED classes accept any category.
  const category = app.category;
  const classOk = klass.fundingProgram === "MIXED" || klass.fundingProgram === category;
  const courseOk = !course.fundingPrograms.length || (!!category && course.fundingPrograms.includes(category));
  if ((!classOk || !courseOk) && fd.get("fundingMismatch") !== "on") {
    return {
      error: `Funding mismatch: the student is ${category ? CATEGORY_LABELS[category] : "uncategorised"}, but this class is ` +
        `${klass.fundingProgram === "MIXED" ? "mixed" : CATEGORY_LABELS[klass.fundingProgram]}` +
        `${courseOk ? "" : " and the course isn't offered to that program"}. Tick "Allow funding mismatch" only if this is intended.`,
    };
  }

  const existing = await enrollments.findOne({ studentId, classId });
  if (existing?.status === "ACTIVE") return { error: "The student is already in this class." };
  const active = await enrollments.countDocuments({ classId, status: "ACTIVE" });
  if (active >= klass.capacity && fd.get("overCapacity") !== "on") {
    return { error: `This class is full (${klass.capacity}). Tick "Allow over capacity" to add anyway.` };
  }

  if (existing) {
    const res = await enrollments.updateOne(
      { _id: existing._id, status: { $ne: "ACTIVE" } },
      { $set: { status: "ACTIVE", endedAt: null, assignedById: admin._id, assignedAt: new Date() } },
    );
    if (!res.modifiedCount) return { error: "The student is already in this class." };
  } else {
    try {
      await enrollments.insertOne({ _id: newId(), studentId, classId, courseId: klass.courseId, status: "ACTIVE", assignedById: admin._id, assignedAt: new Date(), endedAt: null });
    } catch (e) {
      // The unique (studentId, classId) index stops a duplicate from a double click.
      if (isDuplicateKey(e)) return { error: "The student is already in this class." };
      throw e;
    }
  }

  await audit(admin._id, "enrollment.assign", "class", classId, { studentId, fundingOverride: !classOk || !courseOk });
  const student = await users.findOne({ _id: studentId });
  if (student) await sendClassAssignedEmail(student.email, student.name, `${course.name} (${klass.code})`).catch(() => undefined);
  revalidatePath("/admin", "layout");
  return { ok: true, message: `Assigned to ${course.name} (${klass.code}).` };
}

export async function endEnrollmentAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const id = uuid.safeParse(fd.get("enrollmentId"));
  const status = z.enum(["WITHDRAWN", "COMPLETED", "TRANSFERRED"]).safeParse(fd.get("status"));
  if (!id.success || !status.success) return { error: "Invalid request." };
  const { enrollments } = await cols();
  const res = await enrollments.updateOne({ _id: id.data, status: "ACTIVE" }, { $set: { status: status.data, endedAt: new Date() } });
  if (!res.modifiedCount) return { error: "That enrollment is no longer active." };
  await audit(admin._id, "enrollment.end", "enrollment", id.data, { status: status.data });
  revalidatePath("/admin", "layout");
  return { ok: true, message: "Enrollment updated. Attendance history is kept." };
}

// ---------- Courses and classes ----------

const PROGRAMS: Category[] = ["PRIVATE", "EQISS", "DFS"];
const courseSchema = z.object({
  name: z.string().trim().min(2, "Enter a course name").max(120),
  description: z.string().trim().max(2000).default(""),
});

export async function saveCourseAction(courseId: string | null, _: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const parsed = courseSchema.safeParse(formObject(fd));
  if (!parsed.success) return invalid(parsed.error);
  const fundingPrograms = fd.getAll("fundingPrograms").map(String).filter((p): p is Category => PROGRAMS.includes(p as Category));
  const { courses } = await cols();
  let id = courseId;
  if (courseId) {
    await courses.updateOne({ _id: courseId }, { $set: { ...parsed.data, fundingPrograms } });
  } else {
    id = newId();
    await courses.insertOne({ _id: id, ...parsed.data, fundingPrograms, archived: false, createdAt: new Date() });
  }
  await audit(admin._id, courseId ? "course.update" : "course.create", "course", id);
  revalidatePath("/admin/courses", "layout");
  if (!courseId) redirect(`/admin/courses/${id}`);
  return { ok: true, message: "Course saved." };
}

export async function archiveCourseAction(courseId: string, _: ActionState): Promise<ActionState> {
  const admin = await requireAdmin();
  const { courses } = await cols();
  const c = await courses.findOne({ _id: courseId });
  if (!c) return { error: "Course not found." };
  await courses.updateOne({ _id: courseId }, { $set: { archived: !c.archived } });
  await audit(admin._id, c.archived ? "course.unarchive" : "course.archive", "course", courseId);
  revalidatePath("/admin/courses", "layout");
  return { ok: true, message: c.archived ? "Course restored." : "Course archived. Existing classes and records are kept." };
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a date");
const classSchema = z
  .object({
    code: z.string().trim().min(2, "Enter a class code").max(40).regex(/^[A-Za-z0-9._-]+$/, "Use letters, numbers, dots, dashes or underscores"),
    cohort: z.string().trim().min(1, "Enter a cohort name").max(80),
    startDate: isoDate,
    endDate: isoDate,
    schedule: z.string().trim().max(200).default(""),
    location: z.string().trim().max(200).default(""),
    capacity: z.coerce.number().int("Whole number").min(1, "At least 1").max(500, "At most 500"),
    fundingProgram: z.enum(["MIXED", "PRIVATE", "EQISS", "DFS"]),
  })
  .refine((d) => d.endDate >= d.startDate, { path: ["endDate"], message: "End date must be on or after the start date" });

export async function saveClassAction(courseId: string, classId: string | null, _: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const parsed = classSchema.safeParse(formObject(fd));
  if (!parsed.success) return invalid(parsed.error);
  const { classes, courses } = await cols();
  if (!(await courses.findOne({ _id: courseId }, { projection: { _id: 1 } }))) return { error: "Course not found." };
  const dupe = await classes.findOne({ code: parsed.data.code }, { projection: { _id: 1 } });
  if (dupe && dupe._id !== classId) return { fieldErrors: { code: "Another class already uses this code" } };
  let id = classId;
  try {
    if (classId) {
      await classes.updateOne({ _id: classId }, { $set: parsed.data });
    } else {
      id = newId();
      await classes.insertOne({ _id: id, courseId, ...parsed.data, archived: false, instructors: [], createdAt: new Date() });
    }
  } catch (e) {
    if (isDuplicateKey(e)) return { fieldErrors: { code: "Another class already uses this code" } };
    throw e;
  }
  await audit(admin._id, classId ? "class.update" : "class.create", "class", id, { code: parsed.data.code });
  revalidatePath("/admin", "layout");
  if (!classId) redirect(`/admin/classes/${id}`);
  return { ok: true, message: "Class saved." };
}

export async function archiveClassAction(classId: string, _: ActionState): Promise<ActionState> {
  const admin = await requireAdmin();
  const { classes } = await cols();
  const c = await classes.findOne({ _id: classId });
  if (!c) return { error: "Class not found." };
  await classes.updateOne({ _id: classId }, { $set: { archived: !c.archived } });
  await audit(admin._id, c.archived ? "class.unarchive" : "class.archive", "class", classId);
  revalidatePath("/admin", "layout");
  return { ok: true, message: c.archived ? "Class restored." : "Class archived. Its roster, attendance and reports are kept." };
}

// ---------- Instructors ----------

/**
 * Assigns (or changes the role of) an instructor on a class. Shared by the class page and the
 * instructor page so both follow the same rules:
 * - only approved, enabled instructors; never an archived class or course;
 * - one lead per class: making someone lead while another lead exists needs "replaceLead",
 *   which turns the current lead into an assistant.
 */
async function assignInstructorToClass(adminId: string, classId: string, fd: FormData): Promise<ActionState> {
  const instructorId = uuid.safeParse(fd.get("instructorId"));
  const role = z.enum(["LEAD", "ASSISTANT"]).safeParse(fd.get("role") || "LEAD");
  if (!uuid.safeParse(classId).success) return { fieldErrors: { classId: "Choose a class" } };
  if (!instructorId.success) return { fieldErrors: { instructorId: "Choose an instructor" } };
  if (!role.success) return { error: "Invalid role." };
  const replaceLead = fd.get("replaceLead") === "on";
  const { users, classes, courses } = await cols();
  const inst = await users.findOne({ _id: instructorId.data });
  if (!inst || inst.role !== "INSTRUCTOR" || inst.instructorStatus !== "APPROVED" || inst.disabledAt) {
    return { fieldErrors: { instructorId: "Only approved instructors can be assigned" } };
  }
  // Compare-and-set on the whole instructors array: the write only applies if nobody changed the
  // list since we read it (retried a few times). Atomic, and needs no positional-operator support.
  let saved = false;
  let demoted: string | null = null;
  let klassName = "";
  for (let attempt = 0; attempt < 3 && !saved; attempt++) {
    const klass = await classes.findOne({ _id: classId });
    if (!klass) return { fieldErrors: { classId: "Class not found" } };
    const course = await courses.findOne({ _id: klass.courseId }, { projection: { name: 1, archived: 1 } });
    if (klass.archived || !course || course.archived) return { fieldErrors: { classId: "That class is archived" } };
    klassName = `${course.name} (${klass.code}, ${klass.cohort})`;
    const otherLead = klass.instructors.find((i) => i.role === "LEAD" && i.instructorId !== instructorId.data);
    if (role.data === "LEAD" && otherLead && !replaceLead) {
      const name = (await users.findOne({ _id: otherLead.instructorId }, { projection: { name: 1 } }))?.name ?? "another instructor";
      return { error: `${klassName} already has a lead instructor (${name}). Assign as assistant, or tick "Replace current lead".` };
    }
    demoted = role.data === "LEAD" && otherLead ? otherLead.instructorId : null;
    const exists = klass.instructors.some((i) => i.instructorId === instructorId.data);
    const updated = klass.instructors.map((i) =>
      i.instructorId === instructorId.data ? { ...i, role: role.data } : i.instructorId === demoted ? { ...i, role: "ASSISTANT" as const } : i);
    const next = exists ? updated : [...updated, { instructorId: instructorId.data, role: role.data, assignedAt: new Date() }];
    const res = await classes.updateOne({ _id: classId, instructors: klass.instructors }, { $set: { instructors: next } });
    saved = res.matchedCount === 1;
    if (saved && !exists) {
      await sendInstructorClassEmail(inst.email, inst.name, klassName, role.data, klass.startDate, klass.schedule).catch(() => undefined);
    }
  }
  if (!saved) return { error: "The class was being changed by someone else. Try again." };
  await audit(adminId, "class.assign_instructor", "class", classId, { instructorId: instructorId.data, role: role.data, demotedLead: demoted });
  revalidatePath("/admin", "layout");
  revalidatePath("/instructor", "layout");
  return { ok: true, message: `${inst.name} assigned to ${klassName} as ${role.data === "LEAD" ? "lead" : "assistant"}${demoted ? "; the previous lead is now an assistant" : ""}.` };
}

/** From the class page: the class is fixed, the instructor is chosen. */
export async function assignInstructorAction(classId: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  return assignInstructorToClass(admin._id, classId, fd);
}

/** From the instructor page: the instructor is fixed, the class is chosen. */
export async function assignClassToInstructorAction(instructorId: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  fd.set("instructorId", instructorId);
  return assignInstructorToClass(admin._id, String(fd.get("classId") ?? ""), fd);
}

export async function removeInstructorAction(classId: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const instructorId = uuid.safeParse(fd.get("instructorId"));
  if (!instructorId.success) return { error: "Invalid request." };
  const { classes } = await cols();
  const res = await classes.updateOne({ _id: classId }, { $pull: { instructors: { instructorId: instructorId.data } } });
  if (!res.modifiedCount) return { error: "That instructor isn't on this class." };
  await audit(admin._id, "class.remove_instructor", "class", classId, { instructorId: instructorId.data });
  revalidatePath("/admin", "layout");
  revalidatePath("/instructor", "layout");
  return { ok: true, message: "Instructor removed from the class." };
}

export async function decideInstructorAction(instructorId: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const decision = z.enum(["APPROVED", "REJECTED"]).safeParse(fd.get("decision"));
  if (!decision.success) return { error: "Invalid decision." };
  const { users, classes } = await cols();
  const inst = await users.findOneAndUpdate(
    { _id: instructorId, role: "INSTRUCTOR" },
    { $set: { instructorStatus: decision.data } },
    { returnDocument: "after" },
  );
  if (!inst) return { error: "Instructor not found." };
  if (decision.data === "REJECTED") {
    await classes.updateMany({ "instructors.instructorId": instructorId }, { $pull: { instructors: { instructorId } } });
    // Assignments are ended, not deleted, so the record of who taught what stays.
    await (await cols()).courseAssignments.updateMany({ instructorId, removedAt: null }, { $set: { removedAt: new Date(), removedById: admin._id } });
  }
  await audit(admin._id, `instructor.${decision.data.toLowerCase()}`, "user", instructorId);
  const emailed = await trySend(() => sendInstructorDecisionEmail(inst.email, inst.name, decision.data === "APPROVED"));
  revalidatePath("/admin", "layout");
  const base = decision.data === "APPROVED" ? "Instructor approved." : "Instructor rejected.";
  return { ok: true, message: `${base} ${emailed ? "They were emailed." : "The email could not be sent."}` };
}
// ---------- Instructor accounts (created by admins) ----------

const instructorSchema = z.object({
  name: z.string().trim().min(2, "Enter the instructor's full name").max(80),
  email: z.string().trim().toLowerCase().email("Enter a valid email address").max(160),
});

/**
 * Creates an approved instructor account and emails a one-time link to set a password.
 * Admins never see or choose the password.
 */
export async function createInstructorAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const parsed = instructorSchema.safeParse(formObject(fd));
  if (!parsed.success) return invalid(parsed.error);
  const { name, email } = parsed.data;
  const emailCanonical = canonicalEmail(email);
  const { users } = await cols();
  if (await users.findOne({ $or: [{ email }, { emailCanonical }] }, { projection: { _id: 1 } })) {
    return { fieldErrors: { email: "An account with this email already exists." } };
  }
  const invite = newInviteToken();
  const now = new Date();
  const user: User = {
    _id: newId(), name, email, emailCanonical,
    // Unusable random password: the account can't be signed into until the invite is accepted.
    passwordHash: await hashPassword(randomBytes(32).toString("base64url")),
    role: "INSTRUCTOR", instructorStatus: "APPROVED",
    emailVerifiedAt: null, disabledAt: null, passwordChangedAt: now, createdAt: now,
    inviteTokenHash: invite.hash, inviteExpiresAt: invite.expiresAt,
  };
  try {
    await users.insertOne(user);
  } catch (e) {
    if (isDuplicateKey(e)) return { fieldErrors: { email: "An account with this email already exists." } };
    throw e;
  }
  await audit(admin._id, "instructor.create", "user", user._id, { email });
  let emailed = true;
  await sendInstructorInviteEmail(email, name, invite.token, INVITE_TTL_DAYS).catch(() => { emailed = false; });
  revalidatePath("/admin", "layout");
  return emailed
    ? { ok: true, message: `${name} added. An invitation to set a password was emailed to ${email}.` }
    : { error: `${name} was added, but the invitation email failed. Use "Resend invite".` };
}

/** New invite link for an instructor who hasn't activated yet (the old link stops working). */
export async function resendInviteAction(instructorId: string, _: ActionState): Promise<ActionState> {
  const admin = await requireAdmin();
  const invite = newInviteToken();
  const { users } = await cols();
  const inst = await users.findOneAndUpdate(
    { _id: instructorId, role: "INSTRUCTOR", emailVerifiedAt: null, disabledAt: null },
    { $set: { inviteTokenHash: invite.hash, inviteExpiresAt: invite.expiresAt } },
    { returnDocument: "after" },
  );
  if (!inst) return { error: "Only instructors who haven't activated their account can be re-invited." };
  await audit(admin._id, "instructor.reinvite", "user", instructorId);
  try {
    await sendInstructorInviteEmail(inst.email, inst.name, invite.token, INVITE_TTL_DAYS);
  } catch {
    return { error: "The invitation email failed. Try again in a minute." };
  }
  revalidatePath("/admin", "layout");
  return { ok: true, message: `New invitation sent to ${inst.email}.` };
}
// ---------- Reports ----------

export async function reopenReportAction(reportId: string, _: ActionState): Promise<ActionState> {
  const admin = await requireAdmin();
  const { progressReports } = await cols();
  const r = await progressReports.findOne({ _id: reportId, status: "SUBMITTED" });
  if (!r) return { error: "Only submitted reports can be reopened." };
  // The submitted version (with its signature) is kept in revisions; the instructor signs again on resubmission.
  const res = await progressReports.updateOne(
    { _id: reportId, status: "SUBMITTED", updatedAt: r.updatedAt },
    {
      $set: { status: "DRAFT", submittedAt: null, signature: null, updatedAt: new Date() },
      $push: { revisions: { data: r.data, status: r.status, signature: r.signature ?? null, authorId: r.authorId, instructorName: r.instructorName, savedAt: r.updatedAt } },
    },
  );
  if (!res.modifiedCount) return { error: "Only submitted reports can be reopened." };
  await audit(admin._id, "report.reopen", "progress_report", reportId);
  revalidatePath("/admin", "layout");
  return { ok: true, message: "Report reopened for the instructor to edit." };
}

// ---------- Accounts ----------

/** Disable or re-enable a student or instructor. Disabling signs them out everywhere immediately. */
export async function setAccountDisabledAction(userId: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const disable = fd.get("disable") === "true";
  if (userId === admin._id) return { error: "You can't disable your own account." };
  const { users } = await cols();
  const res = await users.updateOne(
    { _id: userId, role: { $in: ["STUDENT", "INSTRUCTOR"] } },
    { $set: { disabledAt: disable ? new Date() : null } },
  );
  if (!res.matchedCount) return { error: "Account not found." };
  if (disable) await revokeAllSessions(userId);
  await audit(admin._id, disable ? "user.disable" : "user.enable", "user", userId);
  revalidatePath("/admin", "layout");
  return { ok: true, message: disable ? "Account disabled and signed out." : "Account re-enabled." };
}

// ---------- Instructor course assignments ----------

export async function assignCourseToInstructorAction(instructorId: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const courseId = uuid.safeParse(fd.get("courseId"));
  if (!courseId.success) return { fieldErrors: { courseId: "Choose a course" } };
  if (!uuid.safeParse(instructorId).success) return { error: "Invalid instructor." };
  const { users, courses, courseAssignments } = await cols();
  const inst = await users.findOne({ _id: instructorId, role: "INSTRUCTOR" });
  if (!inst || inst.instructorStatus !== "APPROVED" || inst.disabledAt) return { error: "Only approved, enabled instructors can be assigned courses." };
  const course = await courses.findOne({ _id: courseId.data });
  if (!course || course.archived) return { fieldErrors: { courseId: "That course isn't available" } };
  if (await courseAssignments.findOne({ instructorId, courseId: course._id, removedAt: null })) return { error: `${inst.name} is already assigned to ${course.name}.` };
  await courseAssignments.insertOne({ _id: newId(), instructorId, courseId: course._id, assignedById: admin._id, assignedAt: new Date(), removedAt: null, removedById: null });
  await audit(admin._id, "course.assign_instructor", "course", course._id, { instructorId });
  const emailed = await trySend(() => sendInstructorCoursesEmail(inst.email, inst.name, course.name));
  revalidatePath("/admin", "layout");
  revalidatePath("/instructor", "layout");
  return { ok: true, message: `${inst.name} assigned to ${course.name}.${emailed ? "" : " (The notification email could not be sent.)"}` };
}

/** Ends an assignment (kept for history). The instructor loses access; records they wrote are untouched. */
export async function removeCourseAssignmentAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const id = uuid.safeParse(fd.get("assignmentId"));
  if (!id.success) return { error: "Invalid request." };
  const { courseAssignments } = await cols();
  const a = await courseAssignments.findOneAndUpdate({ _id: id.data, removedAt: null }, { $set: { removedAt: new Date(), removedById: admin._id } });
  if (!a) return { error: "That assignment was already removed." };
  await audit(admin._id, "course.remove_instructor", "course", a.courseId, { instructorId: a.instructorId });
  revalidatePath("/admin", "layout");
  revalidatePath("/instructor", "layout");
  return { ok: true, message: "Assignment removed. Attendance, sign-offs and reports already recorded are kept." };
}

// ---------- Sections: move students and merge ----------

export async function moveStudentAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const enrollmentId = uuid.safeParse(fd.get("enrollmentId"));
  const targetId = uuid.safeParse(fd.get("targetClassId"));
  if (!enrollmentId.success) return { error: "Invalid request." };
  if (!targetId.success) return { fieldErrors: { targetClassId: "Choose a section" } };
  const { enrollments, classes, applications } = await cols();
  const e = await enrollments.findOne({ _id: enrollmentId.data, status: "ACTIVE" });
  if (!e) return { error: "That enrollment is no longer active." };
  const [from, target] = await Promise.all([classes.findOne({ _id: e.classId }), classes.findOne({ _id: targetId.data })]);
  if (!from || !target || target.archived) return { fieldErrors: { targetClassId: "That section isn't available" } };
  const changeCourse = from.courseId !== target.courseId;
  if (changeCourse && fd.get("allowCourseChange") !== "on") {
    return { error: "That section belongs to a different course. Tick \"Change course\" to move the student to another course." };
  }
  const app = await applications.findOne({ studentId: e.studentId }, { projection: { category: 1 } });
  if (!fundingFits(target, app?.category ?? null) && fd.get("fundingMismatch") !== "on") {
    return { error: "Funding mismatch: that section is for a different program. Tick \"Allow funding mismatch\" only if intended." };
  }
  const res = await moveEnrollment(e, target, admin._id, changeCourse ? "course change" : "section move");
  if (!res.ok) return { error: res.error };
  if (changeCourse) await applications.updateOne({ studentId: e.studentId }, { $set: { courseId: target.courseId, updatedAt: new Date() } });
  await audit(admin._id, "enrollment.move", "enrollment", e._id, { fromClassId: from._id, toClassId: target._id, newEnrollmentId: res.enrollment._id, changeCourse });
  revalidatePath("/admin", "layout");
  revalidatePath("/instructor", "layout");
  return { ok: true, message: `Moved to ${target.code}. Earlier attendance and reports stay with the previous section.` };
}

/** Merges other sections of the same course into this one: their active students move here and the old sections are archived. */
export async function mergeSectionsAction(targetClassId: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const sources = fd.getAll("sourceClassIds").map(String).filter((x) => uuid.safeParse(x).success && x !== targetClassId);
  if (!sources.length) return { fieldErrors: { sourceClassIds: "Pick at least one section to merge in" } };
  const { classes, enrollments } = await cols();
  const target = await classes.findOne({ _id: targetClassId });
  if (!target || target.archived) return { error: "This section is archived. Restore it before merging into it." };
  const list = await classes.find({ _id: { $in: sources } }).toArray();
  if (list.length !== sources.length || list.some((k) => k.courseId !== target.courseId || k.archived)) {
    return { error: "Only open sections of the same course can be merged." };
  }
  let moved = 0;
  const skipped: string[] = [];
  const kept: string[] = [];
  for (const k of list) {
    const active = await enrollments.find({ classId: k._id, status: "ACTIVE" }).toArray();
    for (const e of active) {
      const r = await moveEnrollment(e, target, admin._id, `merged into ${target.code}`);
      if (r.ok) moved++; else skipped.push(e.studentId);
    }
    // Only archive a section once nobody is left active in it; otherwise those students would be
    // stuck in a hidden class where no attendance can be taken.
    if (await enrollments.countDocuments({ classId: k._id, status: "ACTIVE" }, { limit: 1 })) {
      kept.push(k.code);
      continue;
    }
    await classes.updateOne({ _id: k._id }, { $set: { archived: true, mergedIntoClassId: target._id, mergedAt: new Date() } });
  }
  await audit(admin._id, "class.merge", "class", target._id, { sources, moved, skipped, keptOpen: kept });
  revalidatePath("/admin", "layout");
  revalidatePath("/instructor", "layout");
  const base = `${moved} student${moved === 1 ? "" : "s"} moved into ${target.code}.`;
  if (kept.length) {
    return { error: `${base} ${kept.join(", ")} still ${kept.length === 1 ? "has" : "have"} students who couldn't be moved, so ${kept.length === 1 ? "it was" : "they were"} left open. Move those students from the class page, then merge again.` };
  }
  return { ok: true, message: `${base} The merged section${list.length === 1 ? " is" : "s are"} archived with attendance, reports and instructors kept.` };
}

/** Course page: pick an instructor for this course. Same rules as assigning from the instructor's page. */
export async function assignInstructorToCourseAction(courseId: string, prev: ActionState, fd: FormData): Promise<ActionState> {
  const instructorId = uuid.safeParse(fd.get("instructorId"));
  if (!instructorId.success) return { fieldErrors: { instructorId: "Choose an instructor" } };
  fd.set("courseId", courseId);
  return assignCourseToInstructorAction(instructorId.data, prev, fd);
}

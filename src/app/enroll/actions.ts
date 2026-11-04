"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { cols, newId, type Application, type SubmissionSnapshot } from "@/db";
import { requireStudentStage } from "@/lib/auth";
import { clientMeta } from "@/lib/session";
import { audit } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";
import { putFile, deleteFile } from "@/lib/storage";
import { detectFileType, MAX_UPLOAD_BYTES, ALLOWED_BY_DOC, safeFileName } from "@/lib/file-validation";
import { notifyAdminsNewApplication, sendSubmissionReceivedEmail } from "@/lib/email";
import { courseServes } from "@/lib/courses";
import { invalid, type ActionState } from "@/lib/action";
import { coerceRaw, documentsFor, getTemplate, schemaFor, templatesFor, SECTION_CATEGORY, SECTION_COURSE, SECTION_DOCUMENTS } from "@/lib/forms/templates";
import { answersHash, canEdit, editableSections, enrollmentState, openCorrection, selectionUpdate, validateSelection } from "@/lib/enrollment";

/**
 * Every write below is conditioned on the application still being in the status we checked
 * (`status: application.status`), so a write can't land after the student has submitted.
 */
const editableFilter = (app: Application) => ({ _id: app._id, status: app.status });

/** Enrollment type (Private / Non-Private), Non-Private program (EQISS / One-Stop or DFS) and county. */
export async function setCategoryAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const { user, application } = await requireStudentStage("ENROLL");
  if (!canEdit(editableSections(application), SECTION_CATEGORY)) return { error: "Your enrollment type can't be changed right now." };
  const v = validateSelection({
    enrollmentType: String(fd.get("enrollmentType") ?? ""),
    fundingProgram: String(fd.get("fundingProgram") ?? ""),
    county: String(fd.get("county") ?? ""),
  });
  if (!v.ok) return { fieldErrors: { [v.field]: v.message } };
  const { selection, category } = v;
  if (category === application.category && selection.county === (application.county ?? null) && application.enrollmentType) redirect("/enroll");

  const { set, unset, stale, changedTrack } = selectionUpdate(application, selection, category);

  // A course that the new track can't take is cleared, so it must be chosen again.
  const { applications, courses } = await cols();
  if (application.courseId) {
    const course = await courses.findOne({ _id: application.courseId }, { projection: { fundingPrograms: 1, archived: 1 } });
    if (!course || course.archived || !courseServes(course, category)) set.courseId = null;
  }

  // During corrections only flagged sections are editable. A new track brings forms the student has
  // never filled in, so unlock all of them plus documents and course; otherwise they would be
  // required but locked and the student could never resubmit.
  const open = openCorrection(application);
  if (changedTrack && application.status === "CORRECTIONS_REQUESTED" && open) {
    set[`corrections.${application.corrections.length - 1}.sections`] = [
      // Only forms the new track adds (e.g. Private Forms); Common Forms already filled in stay locked.
      ...new Set([...open.sections, ...templatesFor(category).map((t) => t.key).filter((k) => !templatesFor(application.category).some((t) => t.key === k)),
        SECTION_DOCUMENTS, SECTION_COURSE]),
    ];
  }

  const res = await applications.updateOne(editableFilter(application), {
    $set: set,
    ...(Object.keys(unset).length ? { $unset: unset } : {}),
  });
  if (!res.matchedCount) return { error: "Your application changed. Reload the page and try again." };
  await Promise.all(stale.map((d) => deleteFile(d.storageKey)));
  await audit(user._id, "application.set_category", "application", application._id, { category, county: selection.county });
  revalidatePath("/enroll");
  redirect(set.courseId === null || !application.courseId ? "/enroll/course" : "/enroll");
}

/** Course choice during enrollment. Only active courses offered to the student's track are accepted. */
export async function setCourseAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const { user, application } = await requireStudentStage("ENROLL");
  if (!application.category) return { error: "Choose Private or Non-Private first." };
  if (!canEdit(editableSections(application), SECTION_COURSE)) return { error: "Your course can't be changed right now." };
  const id = z.string().uuid().safeParse(fd.get("courseId"));
  if (!id.success) return { fieldErrors: { courseId: "Choose a course" } };
  const { courses, applications } = await cols();
  const course = await courses.findOne({ _id: id.data });
  if (!course || course.archived || !courseServes(course, application.category)) {
    return { fieldErrors: { courseId: "That course isn't available for your program" } };
  }
  const res = await applications.updateOne(editableFilter(application), { $set: { courseId: course._id, updatedAt: new Date() } });
  if (!res.matchedCount) return { error: "Your application changed. Reload the page and try again." };
  await audit(user._id, "application.set_course", "application", application._id, { courseId: course._id });
  revalidatePath("/enroll");
  const after = { ...application, courseId: course._id };
  redirect(firstFormPath(after));
}

function firstFormPath(app: Application) {
  const s = enrollmentState(app);
  const open = s.forms.find((f) => !f.complete || !f.signed);
  return open ? `/enroll/forms/${open.template.key}` : "/enroll/documents";
}

const signatureSchema = z
  .string()
  .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/, "Sign in the box")
  .max(300_000, "Signature image is too large");

export async function saveFormAction(templateKey: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const { user, application } = await requireStudentStage("ENROLL");
  // The key is checked against the student's category on the server; fee forms don't exist for funded students.
  const template = getTemplate(templateKey, application.category);
  if (!template) return { error: "This form isn't part of your enrollment." };
  if (!canEdit(editableSections(application), template.key)) {
    return { error: "This section is locked. Only sections flagged for correction can be changed." };
  }
  if (enrollmentState(application).formsLocked) return { error: "Your tuition payment must be verified before you complete the forms." };

  const raw = Object.fromEntries(template.fields.map((f) => [f.name, fd.get(f.name) ?? undefined]));
  const values = coerceRaw(template, raw);
  const { applications } = await cols();
  const now = new Date();

  if (fd.get("intent") === "draft") {
    const draft: Record<string, unknown> = {};
    for (const f of template.fields) {
      const v = values[f.name];
      draft[f.name] = typeof v === "string" ? v.trim().slice(0, f.maxLength ?? 500) : v;
    }
    const saved = await applications.updateOne(editableFilter(application), {
      $set: { [`forms.${template.key}`]: { templateVersion: template.version, data: draft, completedAt: null, updatedAt: now }, updatedAt: now },
    });
    if (!saved.matchedCount) return { error: "Your application changed. Reload the page and try again." };
    revalidatePath("/enroll");
    return { ok: true, message: "Draft saved." };
  }

  const parsed = schemaFor(template).safeParse(values);
  if (!parsed.success) return invalid(parsed.error);
  const data = parsed.data as Record<string, unknown>;
  const hash = answersHash(template.key, data);
  const set: Record<string, unknown> = {
    [`forms.${template.key}`]: { templateVersion: template.version, data, completedAt: now, updatedAt: now },
    updatedAt: now,
  };

  if (template.requiresSignature) {
    const existing = application.signatures?.[template.key];
    const sigInput = String(fd.get("signature") ?? "");
    const signerName = String(fd.get("signerName") ?? "").trim().slice(0, 120);
    const stillValid = existing && existing.dataHash === hash && !sigInput;
    if (!stillValid) {
      const sig = signatureSchema.safeParse(sigInput);
      if (!sig.success) return { error: "Please sign this form.", fieldErrors: { signature: "Sign in the box" } };
      if (signerName.length < 2) return { fieldErrors: { signerName: "Type your full name" } };
      const meta = await clientMeta();
      set[`signatures.${template.key}`] = { imageDataUrl: sig.data, signerName, dataHash: hash, ip: meta.ip, userAgent: meta.userAgent, signedAt: now };
    }
  }

  const res = await applications.updateOne(editableFilter(application), { $set: set });
  if (!res.matchedCount) return { error: "Your application changed. Reload the page and try again." };
  if (set[`signatures.${template.key}`]) await audit(user._id, "application.sign", "application", application._id, { template: template.key });
  revalidatePath("/enroll");

  const list = templatesFor(application.category);
  const next = list[list.findIndex((t) => t.key === template.key) + 1];
  redirect(next ? `/enroll/forms/${next.key}` : "/enroll/documents");
}

export async function uploadDocumentAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const { user, application } = await requireStudentStage("ENROLL");
  if (!canEdit(editableSections(application), SECTION_DOCUMENTS)) return { error: "Documents are locked. Only sections flagged for correction can be changed." };
  if (enrollmentState(application).formsLocked) return { error: "Your tuition payment must be verified before you upload documents." };
  if (!(await rateLimit(`upload:${user._id}`, 30, 3600))) return { error: "Too many uploads. Try again later." };

  const type = String(fd.get("type") ?? "");
  const req = documentsFor(application.category).find((d) => d.type === type);
  if (!req) return { error: "Unknown document type." };
  const file = fd.get("file");
  const errKey = `file-${type}`;
  if (!(file instanceof File) || file.size === 0) return { fieldErrors: { [errKey]: "Choose a file" } };
  if (file.size > MAX_UPLOAD_BYTES) return { fieldErrors: { [errKey]: "Files must be 10 MB or smaller" } };

  const buf = Buffer.from(await file.arrayBuffer());
  const detected = detectFileType(buf);
  const allowed = ALLOWED_BY_DOC[type] ?? [];
  if (!detected || !allowed.includes(detected.ext)) return { fieldErrors: { [errKey]: `Upload a ${allowed.map((e) => e.toUpperCase()).join(", ")} file` } };
  if (application.documents.filter((d) => d.type === type).length >= 3) return { fieldErrors: { [errKey]: "Remove a file before adding another (3 max)" } };

  let key: string;
  try {
    key = await putFile(application._id, detected.ext, buf, detected.mime);
  } catch (e) {
    console.error("[upload] storage write failed", { applicationId: application._id, type }, e);
    return { error: "We couldn't save your file right now. Please try again in a few minutes or contact the office." };
  }
  const { applications } = await cols();
  const res = await applications.updateOne(editableFilter(application), {
    $push: { documents: { _id: newId(), type, storageKey: key, fileName: safeFileName(file.name), mimeType: detected.mime, size: buf.length, createdAt: new Date() } },
    $set: { updatedAt: new Date() },
  });
  if (!res.matchedCount) {
    await deleteFile(key);
    return { error: "Your application changed. Reload the page and try again." };
  }
  await audit(user._id, "application.upload", "application", application._id, { type, size: buf.length });
  revalidatePath("/enroll/documents");
  return { ok: true, message: `${req.label} uploaded.` };
}

export async function deleteDocumentAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const { user, application } = await requireStudentStage("ENROLL");
  if (!canEdit(editableSections(application), SECTION_DOCUMENTS)) return { error: "Documents are locked." };
  const id = z.string().uuid().safeParse(fd.get("id"));
  if (!id.success) return { error: "Unknown file." };
  const doc = application.documents.find((d) => d._id === id.data);
  if (!doc) return { error: "Unknown file." };
  const { applications } = await cols();
  const res = await applications.updateOne(editableFilter(application), { $pull: { documents: { _id: id.data } }, $set: { updatedAt: new Date() } });
  // If the application was submitted in another tab meanwhile, the update doesn't apply and the
  // file must stay on disk: the submitted application still points to it.
  if (!res.modifiedCount) return { error: "Your application changed. Reload the page and try again." };
  await deleteFile(doc.storageKey);
  await audit(user._id, "application.delete_document", "application", application._id, { type: doc.type });
  revalidatePath("/enroll/documents");
  return { ok: true, message: "File removed." };
}

export async function submitApplicationAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const { user, application } = await requireStudentStage("ENROLL");
  if (fd.get("confirm") !== "on") return { fieldErrors: { confirm: "Please confirm before submitting" } };
  const state = enrollmentState(application);
  if (!state.ready) return { error: `Before submitting: ${state.missing.join("; ")}.` };
  const { applications, users, courses } = await cols();
  // The course must still be open to this track (it may have been archived since it was chosen).
  const course = await courses.findOne({ _id: application.courseId! });
  if (!course || course.archived || !courseServes(course, application.category)) {
    return { error: "The course you chose is no longer available. Choose another course, then submit." };
  }

  const resubmit = application.status === "CORRECTIONS_REQUESTED";
  const now = new Date();
  const set: Record<string, unknown> = { status: resubmit ? "RESUBMITTED" : "SUBMITTED", submittedAt: now, updatedAt: now };
  const open = openCorrection(application);
  if (resubmit && open) set[`corrections.${application.corrections.length - 1}.resolvedAt`] = now;
  // Keep a copy of exactly what was sent, so a resubmission never erases the earlier version.
  const snapshot: SubmissionSnapshot = {
    submittedAt: now, kind: resubmit ? "RESUBMIT" : "SUBMIT", category: application.category, county: application.county ?? null,
    courseId: application.courseId ?? null, forms: application.forms, documentIds: application.documents.map((d) => d._id),
  };
  // Conditional on the status we read: a double click or a concurrent admin action can't apply twice.
  const res = await applications.updateOne({ _id: application._id, status: application.status }, { $set: set, $push: { submissions: snapshot } });
  if (!res.modifiedCount) return { error: "Your application status changed. Reload the page." };
  await audit(user._id, resubmit ? "application.resubmit" : "application.submit", "application", application._id);

  const admins = await users.find({ role: "ADMIN", disabledAt: null }, { projection: { email: 1 } }).toArray();
  await notifyAdminsNewApplication(admins.map((a) => a.email), user.name, application._id).catch(() => undefined);
  await sendSubmissionReceivedEmail(user.email, user.name, resubmit).catch(() => undefined);
  redirect("/application");
}

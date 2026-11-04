import Link from "next/link";
import { notFound } from "next/navigation";
import { cols } from "@/db";
import { requireAdmin } from "@/lib/auth";
import { env } from "@/lib/env";
import { ALL_SECTIONS, enrollmentState } from "@/lib/enrollment";
import { usersById } from "@/lib/queries";
import { describeEnrollment, sectionLabel, templatesFor, TEMPLATES, GROUP_LABELS } from "@/lib/forms/templates";
import { courseServes } from "@/lib/courses";
import { approvalBlockedByPayment } from "@/lib/payment";
import { CategoryForm } from "@/app/enroll/category-form";
import { AdminCourseForm } from "@/components/admin-app-edit";
import { Alert, Card, PageHeader, StatusBadge, fmtDate } from "@/components/ui";
import { ActionButton, CorrectionsForm, PaymentRequestForm, RejectForm } from "@/components/action-widgets";
import { formatUsd } from "@/lib/payment";
import { stripeEnabled } from "@/lib/tuition";
import {
  adminSetCourseAction, adminSetSelectionAction, approveApplicationAction, cancelPaymentRequestAction, rejectApplicationAction, reopenApplicationAction, requestCorrectionsAction,
  requestPaymentAction, setPaymentStatusAction,
} from "../../actions";

export default async function ApplicationDetail({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const { applications, users, auditLogs, courses } = await cols();
  const app = await applications.findOne({ _id: id });
  if (!app) notFound();
  const student = await users.findOne({ _id: app.studentId });
  if (!student) notFound();
  const state = enrollmentState(app);
  const corrections = [...app.corrections].reverse();
  const logs = await auditLogs.find({ entity: "application", entityId: app._id }).sort({ createdAt: -1 }).limit(30).toArray();
  const actors = await usersById(logs.map((l) => l.actorId).filter((x): x is string => !!x));
  const history = logs.map((log) => ({ log, actor: log.actorId ? actors.get(log.actorId)?.name : null }));

  const reviewable = app.status === "SUBMITTED" || app.status === "RESUBMITTED";
  const allCourses = await courses.find({}).sort({ name: 1 }).toArray();
  const course = allCourses.find((c) => c._id === app.courseId) ?? null;
  const courseOptions = allCourses.filter((c) => !c.archived && courseServes(c, app.category)).map((c) => ({ id: c._id, label: c.name }));
  const paymentBlocks = approvalBlockedByPayment(app);
  // Answers stored under form keys that aren't part of the current packet (e.g. from the earlier placeholder forms).
  const currentKeys = new Set(templatesFor(app.category).map((t) => t.key));
  const legacy = Object.entries(app.forms ?? {}).filter(([k]) => !currentKeys.has(k) && !(app.category !== "PRIVATE" && TEMPLATES.find((t) => t.key === k)?.containsFees));
  const submissions = [...(app.submissions ?? [])].reverse();
  const ctx = { tuitionUsd: env().PRIVATE_TUITION_USD };

  return (
    <>
      <Link href="/admin/applications" className="text-sm text-pine-700 underline">Applications</Link>
      <PageHeader
        title={student.name}
        description={<>{student.email}, {describeEnrollment(app)}, {course ? course.name : "no course chosen"}, submitted {fmtDate(app.submittedAt)} <StatusBadge status={app.status} /></>}
        actions={<a href={`/api/pdf/application/${app._id}`} className="rounded-md border border-line bg-white px-4 py-2 text-sm font-semibold">Download PDF</a>}
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="space-y-5">
          {!state.ready && (
            <Alert tone="warning">Incomplete: {state.missing.join("; ")}.</Alert>
          )}
          <Card title="Enrollment">
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <div><dt className="text-slate-500">Enrollment type</dt><dd className="font-medium">{app.enrollmentType === "PRIVATE" ? "Private" : app.enrollmentType === "NON_PRIVATE" ? "Non-Private" : "-"}</dd></div>
              <div><dt className="text-slate-500">Funding program</dt><dd className="font-medium">{app.fundingProgram === "EQISS" ? "EQISS / One-Stop" : app.fundingProgram === "DFS" ? "DFS (Department of Family Services)" : app.category === "PRIVATE" ? "Private (self-paying)" : "-"}</dd></div>
              <div><dt className="text-slate-500">County</dt><dd className="font-medium">{app.county ? describeEnrollment(app).split(", ")[1] : "-"}</dd></div>
              <div><dt className="text-slate-500">Course</dt><dd className="font-medium">{course ? `${course.name}${course.archived ? " (archived)" : ""}` : <span className="text-brick-600">Not chosen</span>}</dd></div>
            </dl>
          </Card>
          {state.forms.map((f, i) => {
            const sig = app.signatures?.[f.template.key];
            const newGroup = i === 0 || state.forms[i - 1].template.group !== f.template.group;
            return (
              <div key={f.template.key} className="space-y-2">
              {newGroup && <h2 className="pt-2 text-sm font-semibold uppercase tracking-wide text-slate-500">{GROUP_LABELS[f.template.group]}</h2>}
              <Card title={f.template.title} actions={<Link href={`/admin/applications/${app._id}/forms/${f.template.key}`} className="text-sm font-semibold text-pine-700 underline">Edit</Link>}>
                {f.template.intro && <p className="mb-4 rounded bg-mist p-3 text-sm text-slate-700">{f.template.intro(ctx)}</p>}
                <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                  {f.template.fields.map((fd) => (
                    <div key={fd.name}>
                      <dt className="text-slate-500">{fd.label}</dt>
                      <dd className="font-medium">{fd.type === "checkbox" ? (f.data[fd.name] === true ? "Yes" : "No") : String(f.data[fd.name] ?? "") || "-"}</dd>
                    </div>
                  ))}
                </dl>
                {f.template.requiresSignature && (
                  <div className="mt-4 border-t border-line pt-4">
                    {sig ? (
                      <>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={sig.imageDataUrl} alt={`Signature of ${sig.signerName}`} className="h-16 rounded border border-line bg-white" />
                        <p className="mt-1 text-xs text-slate-500">
                          {sig.signerName}, {sig.signedAt.toISOString().replace("T", " ").slice(0, 16)} UTC, IP {sig.ip ?? "-"}
                          {!f.signed && <span className="font-semibold text-brick-600"> (answers changed after signing)</span>}
                          {f.editedByAdmin && <span className="font-semibold text-marigold-700"> (edited by an admin after signing; see history)</span>}
                        </p>
                      </>
                    ) : (
                      <p className="text-sm font-semibold text-brick-600">Not signed</p>
                    )}
                  </div>
                )}
              </Card>
              </div>
            );
          })}
          <Card title="Documents and resume">
            <ul className="space-y-3 text-sm">
              {state.requirements.map(({ req, files }) => (
                <li key={req.type}>
                  <p className="font-medium">{req.label}{req.required && !files.length && <span className="text-brick-600"> (missing)</span>}</p>
                  {files.map((d) => (
                    <a key={d._id} href={`/api/files/${d._id}`} target="_blank" rel="noopener" className="block text-pine-700 underline">
                      {d.fileName} ({Math.ceil(d.size / 1024)} KB)
                    </a>
                  ))}
                </li>
              ))}
            </ul>
          </Card>
          {legacy.length > 0 && (
            <Card title="Answers from earlier form versions">
              <p className="mb-3 text-xs text-slate-500">Kept for the record. These forms are no longer part of the packet.</p>
              {legacy.map(([k, r]) => (
                <div key={k} className="mb-3 text-sm"><p className="font-medium">{k}</p>
                  <p className="text-slate-600">{Object.entries(r.data).map(([fk, v]) => `${fk}: ${String(v)}`).join("; ")}</p></div>
              ))}
            </Card>
          )}
          {submissions.length > 0 && (
            <Card title="Submission history">
              <ul className="space-y-2 text-sm">
                {submissions.map((sub, i) => (
                  <li key={i}>{sub.submittedAt.toISOString().slice(0, 16).replace("T", " ")} UTC: {sub.kind === "RESUBMIT" ? "resubmitted" : "submitted"} ·{" "}
                    {describeEnrollment(sub)} · {allCourses.find((c) => c._id === sub.courseId)?.name ?? "no course"} · {Object.keys(sub.forms ?? {}).length} forms, {sub.documentIds.length} files</li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <aside className="space-y-5">
          {reviewable && (
            <>
              <Card title="Approve">
                <p className="mb-3 text-sm text-slate-600">Approval enrolls the student in {course ? <strong>{course.name}</strong> : "their chosen course"} and opens their dashboard.</p>
                {paymentBlocks && <div className="mb-3"><Alert tone="warning">
                  {app.paymentStatus === "REQUESTED" ? "Waiting for the student's payment. They're approved automatically when it goes through." : "Tuition isn't settled yet. Send a payment request (Tuition payment, below)."}
                </Alert></div>}
                <ActionButton action={approveApplicationAction.bind(null, app._id)} label="Approve and enroll"
                  confirm={state.ready ? undefined : "This application looks incomplete. Approve anyway?"} />
              </Card>
              <Card title="Request corrections">
                <CorrectionsForm action={requestCorrectionsAction.bind(null, app._id)}
                  sections={ALL_SECTIONS(app).map((k) => ({ key: k, label: sectionLabel(k) }))} />
              </Card>
            </>
          )}
          {(reviewable || app.status === "CORRECTIONS_REQUESTED") && (
            <Card title="Reject"><RejectForm action={rejectApplicationAction.bind(null, app._id)} /></Card>
          )}
          {app.status === "APPROVED" && (
            <Card title="Enrollment">
              <Link href={`/admin/students/${student._id}`} className="font-semibold text-pine-700 underline">Student record, section and attendance</Link>
            </Card>
          )}
          {app.status === "REJECTED" && (
            <Card title="Rejected">
              {app.rejectionReason && <p className="mb-3 whitespace-pre-wrap text-sm">{app.rejectionReason}</p>}
              <ActionButton action={reopenApplicationAction.bind(null, app._id)} label="Reopen for review" variant="secondary"
                confirm="Move this application back to the review queue?" />
            </Card>
          )}
          {app.category === "PRIVATE" && (
            <Card title="Tuition payment">
              <p className="mb-3 text-sm">Status: <StatusBadge status={app.paymentStatus} /></p>
              {app.paymentRequest && (
                <div className="mb-4 rounded-md bg-mist p-3 text-sm">
                  <p><strong>{formatUsd(app.paymentRequest.amountCents)}</strong> requested {fmtDate(app.paymentRequest.requestedAt)}</p>
                  <p className="text-slate-600">
                    {app.paymentRequest.status === "OPEN" && (app.paymentRequest.checkoutSessionId ? "The student opened the payment page; not paid yet." : "Waiting for the student.")}
                    {app.paymentRequest.status === "PAID" && <>Paid online {fmtDate(app.paymentRequest.paidAt)}{app.paymentRequest.stripePaymentIntentId ? ` (Stripe ${app.paymentRequest.stripePaymentIntentId})` : ""}</>}
                    {app.paymentRequest.status === "CANCELLED" && `Cancelled${app.paymentRequest.cancelReason ? `: ${app.paymentRequest.cancelReason}` : ""}`}
                  </p>
                  {app.paymentRequest.note && <p className="mt-1 whitespace-pre-wrap">{app.paymentRequest.note}</p>}
                </div>
              )}
              {app.paymentReference && app.paymentRequest?.status !== "PAID" && <p className="mb-3 text-sm">Reference: <strong>{app.paymentReference}</strong></p>}
              {app.paymentVerifiedAt && <p className="mb-3 text-xs text-slate-500">Settled {fmtDate(app.paymentVerifiedAt)}</p>}

              {reviewable && app.paymentStatus !== "PAID" && app.paymentStatus !== "WAIVED" && (
                stripeEnabled() ? (
                  <div className="mb-4">
                    <PaymentRequestForm action={requestPaymentAction.bind(null, app._id)} replacing={app.paymentRequest?.status === "OPEN"}
                      defaultAmount={app.paymentRequest?.status === "OPEN" ? (app.paymentRequest.amountCents / 100).toFixed(2) : env().PRIVATE_TUITION_USD ? String(env().PRIVATE_TUITION_USD) : undefined} />
                    {app.paymentRequest?.status === "OPEN" && (
                      <div className="mt-2"><ActionButton action={cancelPaymentRequestAction.bind(null, app._id)} label="Cancel request" variant="secondary"
                        confirm="Cancel this payment request? The student's payment page stops working." /></div>
                    )}
                  </div>
                ) : <div className="mb-4"><Alert tone="info">Online payment isn't set up (Stripe keys). You can still record an offline payment below.</Alert></div>
              )}
              {!reviewable && app.paymentStatus !== "PAID" && app.paymentStatus !== "WAIVED" && (
                <p className="mb-4 text-xs text-slate-500">A payment request can be sent while the application is waiting for review.</p>
              )}

              {app.paymentRequest?.status !== "PAID" && (
                <details className="text-sm">
                  <summary className="cursor-pointer font-medium">Record an offline payment or waive</summary>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {(["PAID", "WAIVED", "PENDING"] as const).filter((s) => s !== app.paymentStatus).map((s) => (
                      <ActionButton key={s} action={setPaymentStatusAction.bind(null, app._id)} hidden={{ paymentStatus: s }} variant="secondary"
                        label={s === "PAID" ? "Mark paid offline" : s === "WAIVED" ? "Waive tuition" : "Back to unpaid"}
                        confirm={s === "PENDING" ? "Set tuition back to unpaid?" : `Set tuition to ${s.toLowerCase()}? Any open online request is cancelled.`} />
                    ))}
                  </div>
                </details>
              )}
            </Card>
          )}
          {corrections.length > 0 && (
            <Card title="Correction requests">
              <ul className="space-y-4 text-sm">
                {corrections.map((c) => (
                  <li key={c._id}>
                    <p className="font-medium">{fmtDate(c.createdAt)} {c.resolvedAt ? "(resubmitted)" : "(open)"}</p>
                    <p className="text-slate-600">{c.sections.map(sectionLabel).join(", ")}</p>
                    <p className="mt-1 whitespace-pre-wrap">{c.note}</p>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <details className="rounded-lg border border-line bg-white p-5">
            <summary className="cursor-pointer text-sm font-semibold">Edit enrollment type, program or course</summary>
            <div className="mt-4 space-y-6">
              <CategoryForm action={adminSetSelectionAction.bind(null, app._id)} submitLabel="Save enrollment type"
                current={{ enrollmentType: app.enrollmentType ?? null, fundingProgram: app.fundingProgram ?? null, county: app.county ?? null }} hasAnswers />
              <AdminCourseForm action={adminSetCourseAction.bind(null, app._id)} courses={courseOptions} current={app.courseId ?? null} />
            </div>
          </details>
          <Card title="History">
            <ul className="space-y-2 text-xs text-slate-600">
              {history.map(({ log, actor }) => (
                <li key={log._id}>{log.createdAt.toISOString().slice(0, 16).replace("T", " ")}: {log.action.replace("application.", "").replace(/_/g, " ")} by {actor ?? "system"}</li>
              ))}
            </ul>
          </Card>
        </aside>
      </div>
    </>
  );
}

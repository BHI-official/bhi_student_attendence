import type { Metadata } from "next";
import { cols } from "@/db";
import { requireStudentStage } from "@/lib/auth";
import { StudentShell } from "@/components/student-shell";
import { Alert, Card, PageHeader, StatusBadge, fmtDate } from "@/components/ui";
import { ActionButton } from "@/components/action-widgets";
import { startCheckoutAction } from "@/lib/actions/payment";
import { formatUsd } from "@/lib/payment";
import { requestOpen, stripeEnabled } from "@/lib/tuition";

export const metadata: Metadata = { title: "Application status" };
export const dynamic = "force-dynamic";

export default async function ApplicationStatusPage({ searchParams }: { searchParams: Promise<{ payment?: string }> }) {
  const { user, application } = await requireStudentStage("STATUS");
  const pending = application.status === "SUBMITTED" || application.status === "RESUBMITTED";
  const payDue = pending && requestOpen(application);
  const cancelled = (await searchParams).payment === "cancelled";
  const course = payDue && application.courseId ? await (await cols()).courses.findOne({ _id: application.courseId }, { projection: { name: 1 } }) : null;
  const step = application.status === "APPROVED" ? 3 : 2;
  // An approved student with no active class is either waiting for a first assignment or has finished/left one.
  const ended = application.status === "APPROVED"
    ? await (await cols()).enrollments.find({ studentId: user._id, status: { $ne: "ACTIVE" } }, { projection: { status: 1, endedAt: 1 } }).sort({ endedAt: -1 }).limit(1).next()
    : null;
  return (
    <StudentShell name={user.name} step={step}>
      <PageHeader title="Your application" description={<>Status: <StatusBadge status={application.status} /></>} />
      <div className="space-y-5">
        {payDue && application.paymentRequest && (
          <section aria-labelledby="pay-title" className="rounded-lg border-2 border-pine-600 bg-white p-6">
            <h2 id="pay-title" className="text-lg font-semibold">Tuition payment requested</h2>
            <p className="mt-1 text-sm text-slate-600">The office reviewed your application{course ? <> for <strong>{course.name}</strong></> : null}. Pay your tuition to complete your enrollment.</p>
            <p className="mt-4 text-3xl font-bold tabular-nums">{formatUsd(application.paymentRequest.amountCents)}</p>
            {application.paymentRequest.note && <p className="mt-3 whitespace-pre-wrap rounded-md bg-mist p-3 text-sm">{application.paymentRequest.note}</p>}
            {cancelled && <div className="mt-4"><Alert tone="warning">You left the payment page before paying. You can try again any time.</Alert></div>}
            <div className="mt-5">
              {stripeEnabled()
                ? <ActionButton action={startCheckoutAction} label={`Pay ${formatUsd(application.paymentRequest.amountCents)} securely`} />
                : <Alert tone="warning">Online payment is unavailable right now. Contact the office.</Alert>}
            </div>
            <p className="mt-3 text-xs text-slate-500">You pay on Stripe's secure page (card, Apple Pay or Google Pay). Your card details never reach BHI. As soon as the payment goes through, your dashboard opens.</p>
          </section>
        )}
        {pending && !payDue && (
          <Alert tone="info">
            <p className="font-semibold">Your application is waiting for approval.</p>
            <p className="mt-1">The admissions team reviews your forms and documents. We'll email you if anything needs to change, and again when you're approved.</p>
            {application.category === "PRIVATE" && application.paymentStatus !== "PAID" && application.paymentStatus !== "WAIVED" && (
              <p className="mt-1">After the review, you'll receive your tuition payment request by email and here. You can pay it online.</p>
            )}
          </Alert>
        )}
        {application.status === "APPROVED" && ended && (
          <Alert tone="info">
            <p className="font-semibold">{ended.status === "COMPLETED" ? "You've completed your class." : "You're not currently enrolled in a class."}</p>
            <p className="mt-1">Last class ended {fmtDate(ended.endedAt)}. Contact the office if you expected to be in a class.</p>
          </Alert>
        )}
        {application.status === "APPROVED" && !ended && (
          <Alert tone="success">
            <p className="font-semibold">You're approved.</p>
            <p className="mt-1">The office is placing you in your course section. Your dashboard opens as soon as that's done, and we'll email you.</p>
          </Alert>
        )}
        {application.status === "REJECTED" && (
          <Alert tone="error">
            <p className="font-semibold">Your application wasn't approved.</p>
            {application.rejectionReason && <p className="mt-1 whitespace-pre-wrap">{application.rejectionReason}</p>}
            <p className="mt-2">Contact the office if you have questions.</p>
          </Alert>
        )}
        <Card title="Details">
          <dl className="grid gap-4 text-sm sm:grid-cols-2">
            <div><dt className="text-slate-500">Submitted</dt><dd className="font-medium">{fmtDate(application.submittedAt)}</dd></div>
            <div><dt className="text-slate-500">Email</dt><dd className="font-medium">{user.email}</dd></div>
          </dl>
          <a href={`/api/pdf/application/${application._id}`} className="mt-5 inline-block text-sm font-semibold text-pine-700 underline">Download my application (PDF)</a>
        </Card>
      </div>
    </StudentShell>
  );
}

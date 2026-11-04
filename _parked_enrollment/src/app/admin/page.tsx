import type { Metadata } from "next";
import Link from "next/link";
import { cols } from "@/db";
import { requireAdmin } from "@/lib/auth";
import { describeEnrollment, pendingTemplates } from "@/lib/forms/templates";
import { eqissTextPending } from "@/lib/eqiss-text";
import { Alert } from "@/components/ui";
import { attendanceToDo, usersById } from "@/lib/queries";
import { Card, Empty, PageHeader, Stat, StatusBadge, fmtDate } from "@/components/ui";

export const metadata: Metadata = { title: "Admin dashboard" };

export default async function AdminDashboard() {
  await requireAdmin();
  const { applications, enrollments, users, classes, courses, courseAssignments } = await cols();
  const assigned = new Set(await enrollments.distinct("studentId", { status: "ACTIVE" }));
  const approvedIds: string[] = await applications.distinct("studentId", { status: "APPROVED" });
  const [pending, corrections, active, instructorsPending, activeClasses, noInstructor] = await Promise.all([
    applications.countDocuments({ status: { $in: ["SUBMITTED", "RESUBMITTED"] } }),
    applications.countDocuments({ status: "CORRECTIONS_REQUESTED" }),
    enrollments.countDocuments({ status: "ACTIVE" }),
    users.countDocuments({ role: "INSTRUCTOR", instructorStatus: "PENDING" }),
    classes.countDocuments({ archived: false }),
    classes.countDocuments({ archived: false, "instructors.0": { $exists: false } }),
  ]);
  const [paymentsToRequest, courseCount, coursesWithInstructor] = await Promise.all([
    applications.countDocuments({ category: "PRIVATE", status: { $in: ["SUBMITTED", "RESUBMITTED"] }, paymentStatus: "PENDING" }),
    courses.countDocuments({ archived: false }),
    courseAssignments.distinct("courseId", { removedAt: null }),
  ]);
  const pendingText = pendingTemplates();
  const unassigned = approvedIds.filter((id) => !assigned.has(id)).length;
  const queue = await applications.find({ status: { $in: ["SUBMITTED", "RESUBMITTED"] } }).sort({ submittedAt: 1 }).limit(8).toArray();
  const names = await usersById(queue.map((a) => a.studentId));
  const toConfirm = await attendanceToDo();
  const confirmClasses = new Map((await classes.find({ _id: { $in: toConfirm.map((t) => t.classId) } }, { projection: { code: 1 } }).toArray()).map((k) => [k._id, k.code]));

  return (
    <>
      <PageHeader title="Dashboard" />
      {(pendingText.length > 0 || eqissTextPending()) && (
        <div className="mb-6"><Alert tone="warning">
          <p className="font-semibold">Official wording still to be added before production</p>
          {pendingText.length > 0 && <p className="mt-1">Enrollment forms using placeholder fields: {pendingText.map((t) => t.title).join(", ")}.</p>}
          {eqissTextPending() && <p className="mt-1">EQISS biweekly report: customer and instructor certification statements.</p>}
          <p className="mt-1">See "Waiting on documents" in the README.</p>
        </Alert></div>
      )}
      {courseCount === 0 && <div className="mb-6"><Alert tone="info">No courses yet. <Link href="/admin/courses" className="underline">Add the BHI course list</Link> so students can choose a course when enrolling.</Alert></div>}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Applications to review" value={pending} href="/admin/applications?status=PENDING" />
        <Stat label="Waiting on student corrections" value={corrections} href="/admin/applications?status=CORRECTIONS_REQUESTED" />
        <Stat label="Private: payment to request" value={paymentsToRequest} href="/admin/applications?status=PAYMENT" />
        <Stat label="Approved, no section yet" value={unassigned} href="/admin/students?filter=unassigned" />
        <Stat label="Active class enrollments" value={active} href="/admin/students" />
        <Stat label="Approved students" value={approvedIds.length} href="/admin/students" />
        <Stat label="Courses with no instructor" value={Math.max(0, courseCount - coursesWithInstructor.length)} href="/admin/courses" />
        <Stat label="Active classes" value={activeClasses} href="/admin/courses" />
        <Stat label="Monthly reports" value="View" href="/admin/reports" />
        {instructorsPending > 0 && <Stat label="Older instructor sign-ups to approve" value={instructorsPending} href="/admin/instructors" />}
      </div>
      {toConfirm.length > 0 && (
        <div className="mt-8">
          <Card title={`Class days not completed or signed by instructors (${toConfirm.length})`} actions={<Link href="/admin/live" className="text-sm font-semibold text-pine-700 underline">Live attendance</Link>}>
            <ul className="divide-y divide-line text-sm">
              {toConfirm.slice(0, 10).map((t) => (
                <li key={`${t.classId}:${t.date}`} className="flex justify-between gap-3 py-2">
                  <Link href={`/admin/classes/${t.classId}`} className="font-semibold text-pine-700 underline">{confirmClasses.get(t.classId) ?? "Class"}</Link>
                  <span>{fmtDate(t.date)}: {[t.pending ? `${t.pending} not filled out` : "", t.unsigned ? "not signed" : ""].filter(Boolean).join(", ")}</span>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
      <div className="mt-8">
        <Card title="Oldest applications waiting" actions={<Link href="/admin/applications" className="text-sm font-semibold text-pine-700 underline">All applications</Link>}>
          {queue.length === 0 ? (
            <Empty>No applications are waiting for review.</Empty>
          ) : (
            <ul className="divide-y divide-line">
              {queue.map((app) => (
                <li key={app._id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div>
                    <Link href={`/admin/applications/${app._id}`} className="font-semibold text-pine-700 underline">{names.get(app.studentId)?.name ?? "Student"}</Link>
                    <p className="text-sm text-slate-600">{describeEnrollment(app)}, submitted {fmtDate(app.submittedAt)}</p>
                  </div>
                  <StatusBadge status={app.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}

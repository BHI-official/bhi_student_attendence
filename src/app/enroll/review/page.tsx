import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireStudentStage } from "@/lib/auth";
import { env } from "@/lib/env";
import { enrollmentState } from "@/lib/enrollment";
import { describeEnrollment } from "@/lib/forms/templates";
import { cols } from "@/db";
import { StatusBadge } from "@/components/ui";
import { StudentShell } from "@/components/student-shell";
import { Alert, Card, PageHeader } from "@/components/ui";
import { EnrollNav } from "../enroll-nav";
import { SubmitForm } from "./submit-form";

export const metadata: Metadata = { title: "Review and submit" };
export const dynamic = "force-dynamic";

export default async function ReviewPage() {
  const { user, application } = await requireStudentStage("ENROLL");
  if (!application.category) redirect("/enroll");
  const state = enrollmentState(application);
  const isPrivate = application.category === "PRIVATE";
  const { PRIVATE_TUITION_USD } = env();
  const course = application.courseId ? await (await cols()).courses.findOne({ _id: application.courseId }, { projection: { name: 1 } }) : null;

  return (
    <StudentShell name={user.name} step={1} nav={<EnrollNav app={application} active="review" />}>
      <PageHeader title="Review and submit" description={describeEnrollment(application)} />
      <div className="space-y-5">
        <Card title="Course" actions={<Link href="/enroll/course" className="text-sm font-semibold text-pine-700 underline">Change</Link>}>
          <p className="text-sm">{course ? <strong>{course.name}</strong> : <span className="font-semibold text-brick-600">Not chosen</span>}</p>
        </Card>
        {state.forms.map((f) => (
          <Card key={f.template.key} title={f.template.title}
            actions={<Link href={`/enroll/forms/${f.template.key}`} className="text-sm font-semibold text-pine-700 underline">Edit</Link>}>
            <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              {f.template.fields.map((fd) => (
                <div key={fd.name}>
                  <dt className="text-slate-500">{fd.label}</dt>
                  <dd className="font-medium">{fd.type === "checkbox" ? (f.data[fd.name] === true ? "Yes" : "No") : String(f.data[fd.name] ?? "") || "-"}</dd>
                </div>
              ))}
            </dl>
            {f.template.requiresSignature && <p className="mt-4 text-sm">{f.signed ? "Signed ✓" : <span className="font-semibold text-brick-600">Not signed</span>}</p>}
          </Card>
        ))}

        {isPrivate && (
          <Card title="Tuition and payment">
            <p className="text-sm">
              Program tuition: <strong>{PRIVATE_TUITION_USD > 0 ? `$${PRIVATE_TUITION_USD.toLocaleString("en-US")}` : "as stated in your tuition agreement"}</strong>.
            </p>
            <p className="mt-2 text-sm">You don't pay now. After the office reviews your application, you'll receive a payment request by email with the amount, and you can pay online.</p>
          </Card>
        )}

        <Card title="Submit">
          {state.ready ? (
            <SubmitForm resubmit={application.status === "CORRECTIONS_REQUESTED"} />
          ) : (
            <Alert tone="warning">
              <p className="font-semibold">Finish these before submitting:</p>
              <ul className="mt-2 list-disc pl-5">{state.missing.map((m) => <li key={m}>{m}</li>)}</ul>
            </Alert>
          )}
        </Card>
      </div>
    </StudentShell>
  );
}

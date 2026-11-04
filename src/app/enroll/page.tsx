import type { Metadata } from "next";
import Link from "next/link";
import { cols } from "@/db";
import { requireStudentStage } from "@/lib/auth";
import { canEdit, editableSections, enrollmentState, openCorrection } from "@/lib/enrollment";
import { describeEnrollment, SECTION_CATEGORY, sectionLabel } from "@/lib/forms/templates";
import { StudentShell } from "@/components/student-shell";
import { Alert, Card, LinkButton, PageHeader } from "@/components/ui";
import { CategoryForm } from "./category-form";
import { EnrollNav } from "./enroll-nav";

export const metadata: Metadata = { title: "Enrollment" };
export const dynamic = "force-dynamic";

export default async function EnrollPage() {
  const { user, application } = await requireStudentStage("ENROLL");
  const editable = editableSections(application);
  const correction = application.status === "CORRECTIONS_REQUESTED" ? openCorrection(application) : null;
  const state = application.category ? enrollmentState(application) : null;
  const firstOpen = state?.forms.find((f) => !f.complete || !f.signed);
  const course = application.courseId ? await (await cols()).courses.findOne({ _id: application.courseId }, { projection: { name: 1 } }) : null;
  const next = !state ? null
    : !application.courseId ? "/enroll/course"
    : firstOpen ? `/enroll/forms/${firstOpen.template.key}`
    : state.ready ? "/enroll/review" : "/enroll/documents";

  return (
    <StudentShell name={user.name} step={1} nav={<EnrollNav app={application} active="overview" />}>
      <PageHeader title="Enrollment" description="Choose your enrollment type and course, complete the forms, upload your resume and documents, then submit your application for review." />
      {correction && (
        <div className="mb-6">
          <Alert tone="warning">
            <p className="font-semibold">The admissions team asked you to update your application.</p>
            <p className="mt-1">Sections to update: {correction.sections.map(sectionLabel).join(", ")}</p>
            <p className="mt-2 whitespace-pre-wrap">{correction.note}</p>
            <p className="mt-2">Other sections are locked. When you're done, go to Review and submit to send it back.</p>
          </Alert>
        </div>
      )}
      <Card title="Enrollment type and program">
        {canEdit(editable, SECTION_CATEGORY) ? (
          <CategoryForm
            current={{ enrollmentType: application.enrollmentType ?? null, fundingProgram: application.fundingProgram ?? null, county: application.county ?? null }}
            hasAnswers={!!state?.forms.some((f) => Object.keys(f.data).length)} />
        ) : (
          <p className="text-sm">{describeEnrollment(application)} (locked)</p>
        )}
      </Card>
      {state && (
        <div className="mt-6 flex flex-wrap items-center gap-4">
          {next && <LinkButton href={next}>{state.forms.some((f) => f.complete) ? "Continue enrollment" : "Next"}</LinkButton>}
          <p className="text-sm text-slate-600">
            {course && <>Course: <strong>{course.name}</strong>. </>}
            {state.ready ? "Everything is complete. " : `${state.missing.length} item${state.missing.length === 1 ? "" : "s"} left. `}
            <Link href="/enroll/review" className="text-pine-700 underline">See what's left</Link>
          </p>
        </div>
      )}
    </StudentShell>
  );
}

import { notFound, redirect } from "next/navigation";
import { requireStudentStage } from "@/lib/auth";
import { env } from "@/lib/env";
import { canEdit, editableSections, enrollmentState } from "@/lib/enrollment";
import { getTemplate } from "@/lib/forms/templates";
import { StudentShell } from "@/components/student-shell";
import { Alert, Card, PageHeader, fmtDate } from "@/components/ui";
import { EnrollNav } from "../../enroll-nav";
import { FormStep } from "./form-step";
import { saveFormAction } from "../../actions";

export const dynamic = "force-dynamic";

export default async function FormPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const { user, application } = await requireStudentStage("ENROLL");
  // getTemplate filters by category, so funded students get a 404 for fee forms.
  const template = getTemplate(key, application.category);
  if (!template) notFound();

  const editable = editableSections(application);
  const locked = !canEdit(editable, template.key);
  const state = enrollmentState(application);
  const current = state.forms.find((f) => f.template.key === key)!;
  const sig = application.signatures?.[key];

  return (
    <StudentShell name={user.name} step={1} nav={<EnrollNav app={application} active={key} />}>
      <PageHeader title={template.title} />
      {locked && <div className="mb-5"><Alert tone="info">This section is locked while your application is being corrected. Only flagged sections can be changed.</Alert></div>}
      <Card>
        {template.intro && <p className="mb-6 max-w-2xl rounded-md bg-mist p-4 text-sm leading-relaxed">{template.intro({ tuitionUsd: env().PRIVATE_TUITION_USD })}</p>}
        {template.body && template.body.length > 0 && (
          <div className="mb-6 max-w-3xl space-y-3 text-sm leading-relaxed text-slate-800">
            {template.body.map((p, i) => <p key={i} className="whitespace-pre-wrap">{p}</p>)}
          </div>
        )}
        <FormStep
          action={saveFormAction.bind(null, template.key)}
          fields={template.fields}
          values={current.data}
          locked={locked}
          requiresSignature={template.requiresSignature}
          signature={sig && current.signed ? { name: sig.signerName, signedAt: fmtDate(sig.signedAt) } : null}
          defaultName={user.name}
        />
      </Card>
    </StudentShell>
  );
}

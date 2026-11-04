import type { Metadata } from "next";
import { requireStudentStage } from "@/lib/auth";
import { canEdit, editableSections, enrollmentState } from "@/lib/enrollment";
import { SECTION_DOCUMENTS } from "@/lib/forms/templates";
import { ALLOWED_BY_DOC } from "@/lib/file-validation";
import { StudentShell } from "@/components/student-shell";
import { Alert, Badge, Card, LinkButton, PageHeader } from "@/components/ui";
import { EnrollNav } from "../enroll-nav";
import { DeleteDoc, UploadForm } from "./doc-forms";
import { redirect } from "next/navigation";

export const metadata: Metadata = { title: "Documents" };
export const dynamic = "force-dynamic";

const ACCEPT: Record<string, string> = { pdf: ".pdf,application/pdf", docx: ".docx", doc: ".doc", png: ".png,image/png", jpg: ".jpg,.jpeg,image/jpeg" };

export default async function DocumentsPage() {
  const { user, application } = await requireStudentStage("ENROLL");
  if (!application.category) redirect("/enroll");
  const editable = editableSections(application);
  const locked = !canEdit(editable, SECTION_DOCUMENTS);
  const state = enrollmentState(application);

  return (
    <StudentShell name={user.name} step={1} nav={<EnrollNav app={application} active="documents" />}>
      <PageHeader title="Documents and resume" description="Files must be 10 MB or smaller. Your resume and photo ID are required." />
      {locked && <div className="mb-5"><Alert tone="info">Documents are locked while your application is being corrected.</Alert></div>}
      <div className="space-y-4">
        {state.requirements.map(({ req, files }) => (
          <Card key={req.type}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="font-semibold">{req.label}</h2>
                {req.help && <p className="text-sm text-slate-600">{req.help}</p>}
              </div>
              {req.required ? (files.length ? <Badge tone="pine">Uploaded</Badge> : <Badge tone="brick">Required</Badge>) : <Badge>Optional</Badge>}
            </div>
            {files.length > 0 && (
              <ul className="mt-3 divide-y divide-line rounded-md border border-line text-sm">
                {files.map((f) => (
                  <li key={f._id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <a href={`/api/files/${f._id}`} className="truncate text-pine-700 underline" target="_blank" rel="noopener">{f.fileName}</a>
                    {!locked && <DeleteDoc id={f._id} />}
                  </li>
                ))}
              </ul>
            )}
            {!locked && <UploadForm type={req.type} accept={(ALLOWED_BY_DOC[req.type] ?? []).map((e) => ACCEPT[e]).join(",")} />}
          </Card>
        ))}
      </div>
      <div className="mt-6"><LinkButton href="/enroll/review">Review and submit</LinkButton></div>
    </StudentShell>
  );
}

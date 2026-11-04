"use client";

import type { ReactNode } from "react";
import type { ActionState } from "@/lib/action";
import { ActionForm, Checkbox, Field, Submit, useFormCtx } from "./forms";
import type { ButtonVariant } from "./ui";

type Act = (prev: ActionState, fd: FormData) => Promise<ActionState>;

/** One-click action button (with optional hidden fields and confirmation). */
export function ActionButton({ action, label, variant = "primary", hidden, confirm }: { action: Act; label: string; variant?: ButtonVariant; hidden?: Record<string, string>; confirm?: string }) {
  return (
    <ActionForm action={action} confirm={confirm}>
      {hidden && Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <Submit variant={variant}>{label}</Submit>
    </ActionForm>
  );
}

export function RejectForm({ action }: { action: Act }) {
  return (
    <ActionForm action={action} className="space-y-3" confirm="Reject this application? The student will be emailed.">
      <Field name="reason" label="Reason shown to the student" type="textarea" rows={3} required />
      <Submit variant="danger">Reject application</Submit>
    </ActionForm>
  );
}

function SectionPicker({ sections }: { sections: { key: string; label: string }[] }) {
  const { state } = useFormCtx();
  return (
    <fieldset>
      <legend className="mb-2 text-sm font-medium">Sections the student may change</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {sections.map((s) => (
          <label key={s.key} className="flex items-center gap-2 rounded-md border border-line px-3 py-2 text-sm">
            <input type="checkbox" name="sections" value={s.key} className="accent-pine-700" /> {s.label}
          </label>
        ))}
      </div>
      {state.fieldErrors?.sections && <p className="mt-1 text-xs font-medium text-brick-600">{state.fieldErrors.sections}</p>}
    </fieldset>
  );
}

export function CorrectionsForm({ action, sections }: { action: Act; sections: { key: string; label: string }[] }) {
  return (
    <ActionForm action={action} className="space-y-4">
      <SectionPicker sections={sections} />
      <Field name="note" label="What needs to change (emailed to the student)" type="textarea" rows={4} required />
      <Submit variant="secondary">Send correction request</Submit>
    </ActionForm>
  );
}

export function AssignClassForm({ action, studentId, classes }: { action: Act; studentId: string; classes: { id: string; label: string }[] }) {
  return (
    <ActionForm action={action} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="studentId" value={studentId} />
      <div className="min-w-[240px] flex-1">
        <SelectById name="classId" label="Class" options={classes} />
      </div>
      <label className="flex items-center gap-2 pb-2 text-xs text-slate-600"><input type="checkbox" name="overCapacity" className="accent-pine-700" /> Allow over capacity</label>
      <label className="flex items-center gap-2 pb-2 text-xs text-slate-600"><input type="checkbox" name="fundingMismatch" className="accent-pine-700" /> Allow funding mismatch</label>
      <Submit>Assign</Submit>
    </ActionForm>
  );
}

export function SelectById({ name, label, options, defaultValue }: { name: string; label: string; options: { id: string; label: string }[]; defaultValue?: string }) {
  const { state } = useFormCtx();
  const err = state.fieldErrors?.[name];
  return (
    <div className="space-y-1.5">
      <label htmlFor={`s-${name}`} className="block text-sm font-medium">{label}</label>
      <select id={`s-${name}`} name={name} aria-invalid={!!err} defaultValue={defaultValue}
        className="block w-full rounded-md border border-line bg-white px-3 py-2 text-[0.95rem] focus:border-pine-600 focus:outline-none focus:ring-2 focus:ring-pine-100">
        <option value="">Choose...</option>
        {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
      {err && <p className="text-xs font-medium text-brick-600">{err}</p>}
    </div>
  );
}

function RoleFields() {
  return (
    <>
      <div className="space-y-1.5">
        <label htmlFor="role" className="block text-sm font-medium">Role</label>
        <select id="role" name="role" className="rounded-md border border-line bg-white px-3 py-2">
          <option value="LEAD">Lead</option>
          <option value="ASSISTANT">Assistant</option>
        </select>
      </div>
      <label className="flex items-center gap-2 pb-2 text-xs text-slate-600">
        <input type="checkbox" name="replaceLead" className="accent-pine-700" /> Replace current lead
      </label>
    </>
  );
}

/** Class page: pick an instructor for this class. */
export function AssignInstructorForm({ action, instructors }: { action: Act; instructors: { id: string; label: string }[] }) {
  return (
    <ActionForm action={action} className="flex flex-wrap items-end gap-3">
      <div className="min-w-[220px] flex-1"><SelectById name="instructorId" label="Instructor" options={instructors} /></div>
      <RoleFields />
      <Submit>Assign instructor</Submit>
    </ActionForm>
  );
}

/** Instructor page: pick a class (listed by course) for this instructor. */
export function AssignInstructorClassForm({ action, classes }: { action: Act; classes: { id: string; label: string }[] }) {
  return (
    <ActionForm action={action} className="flex flex-wrap items-end gap-3">
      <div className="min-w-[280px] flex-1"><SelectById name="classId" label="Course and class" options={classes} /></div>
      <RoleFields />
      <Submit>Assign to class</Submit>
    </ActionForm>
  );
}

export function CourseForm({ action, values, submitLabel }: { action: Act; values?: { name: string; description: string; fundingPrograms: string[] }; submitLabel: string }) {
  return (
    <ActionForm action={action} className="space-y-4">
      <Field name="name" label="Course name" required defaultValue={values?.name} maxLength={120} />
      <Field name="description" label="Description" type="textarea" rows={3} defaultValue={values?.description} />
      <fieldset>
        <legend className="mb-2 text-sm font-medium">Funding programs served <span className="font-normal text-slate-500">(none ticked = open to all)</span></legend>
        <div className="flex flex-wrap gap-3">
          {[["PRIVATE", "Private"], ["EQISS", "Non-Private: EQISS / One-Stop"], ["DFS", "Non-Private: DFS"]].map(([v, l]) => (
            <label key={v} className="flex items-center gap-2 rounded-md border border-line px-3 py-2 text-sm">
              <input type="checkbox" name="fundingPrograms" value={v} defaultChecked={values?.fundingPrograms.includes(v)} className="accent-pine-700" /> {l}
            </label>
          ))}
        </div>
      </fieldset>
      <Submit>{submitLabel}</Submit>
    </ActionForm>
  );
}

type ClassValues = { code: string; cohort: string; startDate: string; endDate: string; schedule: string; location: string; capacity: number; fundingProgram: string };

export function ClassForm({ action, values, submitLabel }: { action: Act; values?: ClassValues; submitLabel: string }) {
  return (
    <ActionForm action={action} className="grid gap-4 sm:grid-cols-2">
      <Field name="code" label="Class code" required defaultValue={values?.code} help="Unique, e.g. CNA-2026-FALL-A" maxLength={40} />
      <Field name="cohort" label="Cohort" required defaultValue={values?.cohort} help="e.g. Fall 2026" maxLength={80} />
      <Field name="startDate" label="Start date" type="date" required defaultValue={values?.startDate} />
      <Field name="endDate" label="End date" type="date" required defaultValue={values?.endDate} />
      <Field name="schedule" label="Schedule" defaultValue={values?.schedule} help="e.g. Mon-Thu 9:00-1:00" maxLength={200} />
      <Field name="location" label="Location or online" defaultValue={values?.location} maxLength={200} />
      <Field name="capacity" label="Capacity" type="number" required defaultValue={String(values?.capacity ?? 25)} />
      <Field name="fundingProgram" label="Funding program" type="select" required options={["MIXED", "PRIVATE", "EQISS", "DFS"]} defaultValue={values?.fundingProgram ?? "MIXED"}
        help="MIXED accepts every program. EQISS covers Hudson, Bergen and Somerset counties." />
      <div className="sm:col-span-2"><Submit>{submitLabel}</Submit></div>
    </ActionForm>
  );
}

export function Inline({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

export { Checkbox };
/** Admin creates an instructor account; the instructor sets their own password from the emailed link. */
export function AddInstructorForm({ action }: { action: (prev: ActionState, fd: FormData) => Promise<ActionState> }) {
  return (
    <ActionForm action={action} resetOnSuccess className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
      <Field name="name" label="Full name" autoComplete="off" required maxLength={80} />
      <Field name="email" label="Email" type="email" autoComplete="off" required />
      <Submit>Add and send invite</Submit>
    </ActionForm>
  );
}
/** Class page: move one student to another section (optionally of another course). */
export function MoveStudentForm({ action, enrollmentId, sections }: { action: Act; enrollmentId: string; sections: { id: string; label: string }[] }) {
  return (
    <ActionForm action={action} className="space-y-2" confirm="Move this student? Their records so far stay with this section.">
      <input type="hidden" name="enrollmentId" value={enrollmentId} />
      <SelectById name="targetClassId" label="Move to section" options={sections} />
      <div className="flex flex-wrap gap-3 text-xs text-slate-600">
        <label className="flex items-center gap-1"><input type="checkbox" name="allowCourseChange" className="accent-pine-700" /> Change course</label>
        <label className="flex items-center gap-1"><input type="checkbox" name="fundingMismatch" className="accent-pine-700" /> Allow funding mismatch</label>
      </div>
      <Submit variant="secondary">Move</Submit>
    </ActionForm>
  );
}

/** Class page: merge other sections of the same course into this one. */
export function MergeSectionsForm({ action, sections }: { action: Act; sections: { id: string; label: string }[] }) {
  return (
    <ActionForm action={action} className="space-y-3" confirm="Merge the selected sections into this one? Their students move here and the merged sections are archived with their records kept.">
      <MergePicker sections={sections} />
      <Submit variant="secondary">Merge into this section</Submit>
    </ActionForm>
  );
}
function MergePicker({ sections }: { sections: { id: string; label: string }[] }) {
  const { state } = useFormCtx();
  return (
    <fieldset>
      <legend className="mb-2 text-sm font-medium">Sections to merge in</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {sections.map((s) => (
          <label key={s.id} className="flex items-center gap-2 rounded-md border border-line px-3 py-2 text-sm">
            <input type="checkbox" name="sourceClassIds" value={s.id} className="accent-pine-700" /> {s.label}
          </label>
        ))}
      </div>
      {state.fieldErrors?.sourceClassIds && <p className="mt-1 text-xs font-medium text-brick-600">{state.fieldErrors.sourceClassIds}</p>}
    </fieldset>
  );
}

/** Instructor page: assign a course. */
export function AssignCourseForm({ action, courses }: { action: Act; courses: { id: string; label: string }[] }) {
  return (
    <ActionForm action={action} className="flex flex-wrap items-end gap-3">
      <div className="min-w-[260px] flex-1"><SelectById name="courseId" label="Course" options={courses} /></div>
      <Submit>Assign course</Submit>
    </ActionForm>
  );
}

/** Admin: send a Private student a tuition payment request (amount in dollars + optional note). */
export function PaymentRequestForm({ action, defaultAmount, replacing }: { action: Act; defaultAmount?: string; replacing: boolean }) {
  return (
    <ActionForm action={action} className="space-y-3"
      confirm={replacing ? "Replace the open request? The student's current payment page stops working." : "Send this payment request to the student by email?"}>
      <Field name="amount" label="Amount (USD)" inputMode="decimal" placeholder="1500.00" defaultValue={defaultAmount} required help="Dollars, e.g. 1500 or 1500.00" />
      <Field name="note" label="Note to the student (optional)" type="textarea" rows={2} maxLength={500} />
      <Submit>{replacing ? "Send new amount" : "Request payment"}</Submit>
    </ActionForm>
  );
}

"use client";

import { useActionState } from "react";
import type { ActionState } from "@/lib/action";
import { ActionForm, Field, Msg, Submit } from "@/components/forms";

type Act = (prev: ActionState, fd: FormData) => Promise<ActionState>;
export type StudentValues = { name: string; courseName: string; courseCode: string; courseDuration: string; caseManager: string; instructor: string; startDate: string; endDate: string; classDays: number[] };
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function StudentForm({ action, values, isNew, courses }: { action: Act; values?: StudentValues; isNew: boolean; courses: string[] }) {
  const v = values;
  return (
    <ActionForm action={action}>
      <div className="grid2">
        <Field name="name" label="Student name" defaultValue={v?.name} required />
        <Field name="courseName" label="Course name" defaultValue={v?.courseName}>
          <><input id="f-courseName" name="courseName" list="courses" defaultValue={v?.courseName} /><datalist id="courses">{courses.map((c) => <option key={c} value={c} />)}</datalist></>
        </Field>
        <Field name="courseCode" label="Course code" defaultValue={v?.courseCode} />
        <Field name="courseDuration" label="Course duration" defaultValue={v?.courseDuration} placeholder="6 months" />
        <Field name="caseManager" label="Case manager" defaultValue={v?.caseManager} />
        <Field name="instructor" label="Instructor" defaultValue={v?.instructor} />
        <Field name="startDate" label="Start date" type="date" defaultValue={v?.startDate} required />
        <Field name="endDate" label="End date" type="date" defaultValue={v?.endDate} required />
      </div>
      <fieldset className="field" style={{ border: 0, padding: 0 }}>
        <legend style={{ fontWeight: 700, fontSize: 15, marginBottom: 6 }}>Class days</legend>
        <div className="row">{DAYS.map((d, i) => (
          <label key={d}><input type="checkbox" className="chk" name="classDays" value={i + 1} defaultChecked={(v?.classDays ?? [1, 2, 3, 4, 5]).includes(i + 1)} /> {d}</label>
        ))}</div>
      </fieldset>
      {isNew && <Field name="pin" label="PIN (optional: leave empty for a random 4-digit PIN)" inputMode="numeric" />}
      <Submit>{isNew ? "Add student" : "Save changes"}</Submit>
    </ActionForm>
  );
}

/** Upload a CSV; shows each new student's PIN once, with a download so the office can hand them out. */
export function ImportForm({ action }: { action: Act }) {
  const [state, run, pending] = useActionState(action, {});
  const pins = (state.data as { pins?: { name: string; pin: string }[] } | undefined)?.pins ?? [];
  const csv = "name,pin\n" + pins.map((p) => `"${p.name.replace(/"/g, '""')}",${p.pin}`).join("\n");
  return (
    <form action={run}>
      <div className="field">
        <label htmlFor="csv">CSV file</label>
        <input id="csv" type="file" name="file" accept=".csv,text/csv" required />
      </div>
      <button className="btn" disabled={pending}>{pending ? "Importing…" : "Import students"}</button>
      <Msg state={state} />
      {pins.length > 0 && (
        <div className="panel" style={{ background: "#fff8d6" }}>
          <p><strong>Write these PINs down or download them now.</strong> They aren&apos;t shown again (you can reset a PIN later).</p>
          <a className="btn" download="student-pins.csv" href={`data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`}>Download PINs (CSV)</a>
          <table className="tbl" style={{ marginTop: 12 }}><thead><tr><th>Student</th><th>PIN</th></tr></thead>
            <tbody>{pins.map((p) => <tr key={p.name}><td>{p.name}</td><td><strong>{p.pin}</strong></td></tr>)}</tbody></table>
        </div>
      )}
    </form>
  );
}

export type ProfileValues = { phone: string; email: string; address: string; emergencyName: string; emergencyPhone: string; social: string };

/** Contact and social details on the profile (admins). */
export function ProfileForm({ action, values }: { action: Act; values: ProfileValues }) {
  return (
    <ActionForm action={action}>
      <div className="grid2">
        <Field name="phone" label="Phone" type="tel" defaultValue={values.phone} />
        <Field name="email" label="Email" type="email" defaultValue={values.email} />
        <Field name="emergencyName" label="Emergency contact" defaultValue={values.emergencyName} placeholder="Name and relationship" />
        <Field name="emergencyPhone" label="Emergency contact phone" type="tel" defaultValue={values.emergencyPhone} />
      </div>
      <Field name="address" label="Address" defaultValue={values.address} />
      <Field name="social" label="Social information" type="textarea" defaultValue={values.social} placeholder="Housing, transport, benefits, support needs, anything staff should know" />
      <Submit>Save profile</Submit>
    </ActionForm>
  );
}

/** Give a new PIN: typed by the admin, or random. */
export function PinForm({ action, name }: { action: Act; name: string }) {
  return (
    <ActionForm action={action} confirm={`Give ${name} a new PIN? The old one stops working.`}>
      <Field name="pin" label="New PIN (optional: leave empty for a random one)" inputMode="numeric" />
      <Submit>Give a new PIN</Submit>
    </ActionForm>
  );
}

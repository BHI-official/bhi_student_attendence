"use client";

import { useActionState, useState } from "react";
import type { ActionState } from "@/lib/action";
import { adminEditRowAction } from "@/actions/staff";
import { InkField, type InkValue } from "./Ink";
import { HandTimes } from "./HandTimes";
import { Msg } from "./forms";

export type DayValues = {
  date: string; status: "PRESENT" | "ABSENT" | "EXCUSED" | "HOLIDAY"; note: string; exists: boolean;
  /** The student signed this day themselves (their signature stays; staff can't sign in their place). */
  hasStudentSignature: boolean;
  /** An admin already signed this missed day (name), or null. */
  signedByAdmin?: string | null;
  /** The times on the day now (handwriting), shown above the boxes. */
  times: { label: string; ink: string | null; typed: string }[];
};

const BOXES = [["startInk", "Start time"], ["lunchStartInk", "Lunch out"], ["lunchEndInk", "Lunch in"], ["endInk", "End time"]] as const;

/**
 * An admin adds or corrects one day. A reason is required to change a day that already has
 * something on it; the original values stay in the day's history and the audit log.
 */
export function AdminDayEditor({ studentId, initial }: { studentId: string; initial: DayValues }) {
  const [status, setStatus] = useState(initial.status);
  const [ink, setInk] = useState<Record<string, InkValue>>({});
  const [sig, setSig] = useState<InkValue>(null);
  const [teacherSig, setTeacherSig] = useState<InkValue>(null);
  const [state, run, pending] = useActionState<ActionState, FormData>((prev, fd) => adminEditRowAction(studentId, String(fd.get("date") ?? ""), prev, fd), {});
  const fe = state.fieldErrors ?? {};
  return (
    <form action={run} className="dayeditor">
      <input type="hidden" name="date" value={initial.date} />
      <div className="grid3">
        <div className="field">
          <label htmlFor="ed-status">Status</label>
          <select id="ed-status" name="status" value={status} onChange={(e) => setStatus(e.target.value as DayValues["status"])}>
            <option value="PRESENT">Present</option>
            <option value="ABSENT">Absent</option>
            <option value="EXCUSED">Excused</option>
            <option value="HOLIDAY">Holiday / no class</option>
          </select>
          {fe.status && <span className="err">{fe.status}</span>}
        </div>
      </div>
      {status === "PRESENT" && (
        <div className="admin-times">
          {initial.times.length > 0 && <p className="small" style={{ margin: "0 0 6px" }}>Times now: <HandTimes times={initial.times} h={26} /></p>}
          <p className="small muted" style={{ margin: "0 0 8px" }}>To correct a time, write the right one by hand in its box. Boxes you leave empty keep the time that is there.</p>
          <div className="timegrid">
            {BOXES.map(([name, label]) => (
              <div key={name} className={`timecell${fe[name] ? " bad" : ""}`}>
                <InkField name={name} kind="time" label={label} title={`Correct ${label.toLowerCase()}`} hint="Write the correct time by hand." emptyText="Tap to write"
                  value={ink[name] ?? null} onChange={(v) => setInk((x) => ({ ...x, [name]: v }))} compact />
                {fe[name] && <span className="err">{fe[name]}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="grid2">
        <div className="field">
          <label htmlFor="ed-reason">Reason for the change{initial.exists ? "" : " (optional for a new day)"}</label>
          <input id="ed-reason" name="reason" placeholder="e.g. Student signed the paper sheet; times confirmed by the teacher" />
          {fe.reason && <span className="err">{fe.reason}</span>}
        </div>
        <div className="field">
          <label htmlFor="ed-note">Note on the sheet (optional)</label>
          <input id="ed-note" name="note" defaultValue={initial.note} maxLength={200} />
        </div>
      </div>
      {(status === "EXCUSED" || status === "ABSENT") && (
        <div className="field">
          <label htmlFor="ed-file">Excuse document (optional, PDF, JPG or PNG)</label>
          <input id="ed-file" type="file" name="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" />
          {fe.file && <span className="err">{fe.file}</span>}
        </div>
      )}
      {status === "PRESENT" && !initial.hasStudentSignature && (
        <div className="field adminsig">
          <div className="grid2">
            <div className={`field${fe.adminSignature ? " bad" : ""}`}>
              <InkField name="adminSignature" kind="signature" label="Admin signature: student column"
                title="Sign as admin in the student column" hint="Your own signature. It is shown with your name, never as the student's."
                value={sig} onChange={setSig} />
              {fe.adminSignature && <span className="err">{fe.adminSignature}</span>}
            </div>
            <div className={`field${fe.adminTeacherSignature ? " bad" : ""}`}>
              <InkField name="adminTeacherSignature" kind="signature" label="Admin signature: teacher column"
                title="Sign as admin in the teacher column" hint="Sign again here, separately. This one goes in the teacher signature column."
                value={teacherSig} onChange={setTeacherSig} />
              {fe.adminTeacherSignature && <span className="err">{fe.adminTeacherSignature}</span>}
            </div>
          </div>
          <p className="small muted" style={{ margin: "4px 0 0" }}>
            {initial.signedByAdmin
              ? `Signed by ${initial.signedByAdmin}. Saving any change removes those signatures, so sign both boxes again.`
              : "The student didn't sign this day, so only an admin can complete it. Write the start and end time (and both lunch times if there was a break), then sign both boxes: one for the student column and one for the teacher column. The day is approved and locked, and the sheet shows your name next to each signature."}
          </p>
        </div>
      )}
      <Msg state={state} />
      <button className="btn" disabled={pending}>{pending ? "Saving…" : sig && teacherSig && status === "PRESENT" ? "Sign and save day" : initial.exists ? "Save correction" : "Save day"}</button>
    </form>
  );
}

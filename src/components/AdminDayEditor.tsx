"use client";

import { useActionState, useState } from "react";
import type { ActionState } from "@/lib/action";
import { adminEditRowAction } from "@/actions/staff";
import { Msg } from "./forms";

export type DayValues = { date: string; status: "PRESENT" | "ABSENT" | "EXCUSED" | "HOLIDAY"; start: string; end: string; note: string; exists: boolean; hasStudentSignature: boolean };

/**
 * An admin adds or corrects one day. A reason is required to change a day that already has
 * something on it; the original values stay in the day's history and the audit log.
 */
export function AdminDayEditor({ studentId, initial }: { studentId: string; initial: DayValues }) {
  const [status, setStatus] = useState(initial.status);
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
        {status === "PRESENT" && (
          <>
            <div className="field">
              <label htmlFor="ed-start">Start time</label>
              <input id="ed-start" type="time" name="startTime" defaultValue={initial.start} />
              {fe.startTime && <span className="err">{fe.startTime}</span>}
            </div>
            <div className="field">
              <label htmlFor="ed-end">End time</label>
              <input id="ed-end" type="time" name="endTime" defaultValue={initial.end} />
              {fe.endTime && <span className="err">{fe.endTime}</span>}
            </div>
          </>
        )}
      </div>
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
        <p className="small muted">The student&apos;s signature can&apos;t be added by staff. The day shows “signature missing” until the student signs it (this week or last week), or stays recorded without it.</p>
      )}
      <Msg state={state} />
      <button className="btn" disabled={pending}>{pending ? "Saving…" : initial.exists ? "Save correction" : "Save day"}</button>
    </form>
  );
}

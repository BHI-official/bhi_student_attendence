"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ActionState } from "@/lib/action";
import type { Entry, MonthApproval, Student } from "@/lib/types";
import { LATE_ENTRY_FLAG_MINUTES, clockIn, hoursText, monthTitle, time12, toMinutes, usDate, type SheetRow } from "@/lib/sheet";
import { studentFillAction, studentStartAction } from "@/actions/student";
import { approveMonthAction, editRowAction, signRowsAction } from "@/actions/staff";
import { Msg } from "./forms";
import { TimeEntry, type SchoolClock } from "./TimeEntry";
import { Letterhead } from "./Brand";

type Props = {
  mode: "student" | "staff";
  student: Pick<Student, "_id" | "name" | "courseName" | "courseCode" | "courseDuration" | "caseManager" | "instructor" | "startDate" | "endDate">;
  month: string;
  rows: SheetRow[];
  totalMinutes: number;
  approval: MonthApproval | null;
  approvalCurrent: boolean;
  hasSavedSignature?: boolean;
  /** Staff mode: admins can add the student's signature on file while signing rows. */
  isAdmin?: boolean;
  studentHasSignature?: boolean;
  /** Signature images on this page, by id. */
  images: Record<string, string>;
  /** Student mode: the school's clock and the limits for typed times. */
  clock?: SchoolClock;
};

const STATUS_WORD: Record<string, string> = { ABSENT: "Absent", EXCUSED: "Excused", HOLIDAY: "Holiday" };
/** How many minutes after the fact the student typed this time (null if staff wrote it). */
const late = (e: Entry, which: "startTime" | "endTime") => (which === "startTime" ? e.startLateBy : e.endLateBy) ?? null;
/** "saved 9:12:03 am, typed 7 min later", for the "exact recorded times" view. */
const saved = (e: Entry, which: "startTime" | "endTime") => {
  const at = which === "startTime" ? e.startAt : e.endAt;
  const lag = late(e, which);
  if (!at || lag === null) return at ? `saved ${exact(at)}` : "written by staff";
  return `saved ${exact(at)}${lag > 0 ? `, ${lag} min later` : ""}`;
};
const exact = (d: Date | null) => (d ? new Date(d).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" }) : "");

export function PaperSheet(p: Props) {
  const router = useRouter();
  const [msg, setMsg] = useState<ActionState>({});
  const [pending, start] = useTransition();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [evidence, setEvidence] = useState(false);
  const [editing, setEditing] = useState<SheetRow | null>(null);
  const [typing, setTyping] = useState<"start" | "end" | null>(null);
  const [withStudent, setWithStudent] = useState(true);
  const staff = p.mode === "staff";
  const key = (date: string) => `${p.student._id}:${date}`;

  const run = (fn: () => Promise<ActionState>) =>
    start(async () => {
      try { setMsg((await fn()) ?? {}); } catch { setMsg({ error: "Something went wrong. Try again." }); }
      router.refresh();
    });

  // ----- Student: today's row (the student types their times) -----
  const todayRow = p.rows.find((r) => r.isToday);
  const studentCell = (r: SheetRow, col: "start" | "end") => {
    if (staff || !r.isToday || r.holiday || !p.clock) return null;
    const e = r.entry;
    if (e && e.status !== "PRESENT") return null;
    if (col === "start" && !e?.startTime) return <button className="fill go" disabled={pending} onClick={() => setTyping("start")}>Enter start time</button>;
    if (col === "end" && e?.startTime && !e.endTime) return <button className="fill go" disabled={pending} onClick={() => setTyping("end")}>Enter end time</button>;
    return null;
  };
  const startForEnd = (() => {
    const e = todayRow?.entry;
    if (!e?.startTime || !p.clock) return undefined;
    return { time: e.startTime, enteredAtMinutes: e.startAt ? toMinutes(clockIn(p.clock.tz, new Date(e.startAt), "end")) : null };
  })();

  // ----- Staff: sign selected rows -----
  const signable = (r: SheetRow) => !r.isFuture && !r.entry?.staffSignature && (!!r.holiday || (!!r.entry && (r.entry.status !== "PRESENT" || (!!r.entry.startTime && !!r.entry.endTime))));
  /** A present day with both times and no student signature: an admin can add it. */
  const missingStudent = (r: SheetRow) => !r.holiday && !!r.entry && r.entry.status === "PRESENT" && !!r.entry.startTime && !!r.entry.endTime && !r.entry.studentSignature;
  const pickedMissing = p.rows.filter((r) => picked.has(key(r.date)) && missingStudent(r)).length;
  const offerStudent = staff && !!p.isAdmin && pickedMissing > 0;
  const signPicked = () => {
    const fd = new FormData();
    fd.set("rows", JSON.stringify([...picked]));
    if (offerStudent && withStudent && p.studentHasSignature) fd.set("withStudentSignature", "1");
    run(async () => { const r = await signRowsAction({}, fd); if (r.ok) setPicked(new Set()); return r; });
  };
  const toggle = (k: string) => setPicked((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  const timeCell = (r: SheetRow, which: "startTime" | "endTime") => {
    const e = r.entry;
    const t = e?.[which];
    if (t) return (
      <>
        <span className="hand">{time12(t).replace(" ", "")}</span>
        {evidence && <span className="small muted" style={{ display: "block" }}>{saved(e!, which)}</span>}
        {staff && !evidence && (late(e!, which) ?? 0) >= LATE_ENTRY_FLAG_MINUTES && (
          <span className="tag warn no-print" style={{ display: "block", marginTop: 2 }} title={saved(e!, which)}>entered {late(e!, which)} min later</span>
        )}
      </>
    );
    return studentCell(r, which === "startTime" ? "start" : "end");
  };

  const s = p.student;
  return (
    <>
      <div className="no-print row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
        <label className="small"><input type="checkbox" className="chk" checked={evidence} onChange={(e) => setEvidence(e.target.checked)} /> Show when each time was saved</label>
        <Msg state={msg} />
      </div>

      <div className="desk">
        <article className="paper" aria-label={`Attendance sheet for ${s.name}, ${monthTitle(p.month)}`}>
          <Letterhead />
          <div className="paper-head">
            <div className="paper-title">INDIVIDUAL STUDENT ATTENDANCE SHEET</div>
          </div>
          <table className="info">
            <tbody>
              <tr><th>STUDENT NAME:</th><td>{s.name}</td><th>COURSE NAME:</th><td>{s.courseName}</td></tr>
              <tr><th>COURSE DURATION:</th><td>{s.courseDuration}</td><th>COURSE CODE:</th><td>{s.courseCode}</td></tr>
              <tr><th>CASE MANAGER:</th><td>{s.caseManager}</td><th>START DATE:</th><td>{usDate(s.startDate)}</td></tr>
              <tr><th>INSTRUCTOR:</th><td>{s.instructor}</td><th>END DATE:</th><td>{usDate(s.endDate)}</td></tr>
            </tbody>
          </table>
          <p className="month">MONTH: <b>{monthTitle(p.month).toUpperCase()}</b></p>

          <table className="days">
            <thead>
              <tr><th></th><th>DATE</th><th>START TIME</th><th>END TIME</th><th>HOURS</th><th>STUDENT SIGNATURE</th><th>STAFF SIGNATURE</th></tr>
            </thead>
            <tbody>
              {p.rows.length === 0 && <tr><td colSpan={7} className="muted">No class days in this month.</td></tr>}
              {p.rows.map((r) => {
                const e: Entry | null = r.entry;
                const k = key(r.date);
                const off = r.holiday || (e && e.status !== "PRESENT");
                const cls = [r.isToday && "today", r.holiday && "holiday", r.isFuture && "future", picked.has(k) && "pick"].filter(Boolean).join(" ");
                return (
                  <tr key={r.date} className={cls}>
                    <td className="day">
                      {staff && signable(r) && <input type="checkbox" className="chk no-print" aria-label={`Select ${usDate(r.date)}`} checked={picked.has(k)} onChange={() => toggle(k)} style={{ marginRight: 6, verticalAlign: "middle" }} />}
                      {r.weekdayName.toUpperCase()}
                    </td>
                    <td className="date">
                      {usDate(r.date)}
                      {staff && !r.isFuture && <><br /><button className="edit no-print" onClick={() => setEditing(r)}>Edit</button></>}
                    </td>
                    {off ? (
                      <td colSpan={3} className="span hand" style={{ textAlign: "center" }}>{r.holiday ? r.holiday : STATUS_WORD[e!.status]}{e?.note && !r.holiday ? ` (${e.note})` : ""}</td>
                    ) : (
                      <>
                        <td>{timeCell(r, "startTime")}</td>
                        <td>{timeCell(r, "endTime")}</td>
                        <td>{e?.minutes != null && <span className="hand">{hoursText(e.minutes)}</span>}</td>
                      </>
                    )}
                    <td>
                      {e?.studentSignature && p.images[e.studentSignature.id] && <img className="sig" src={p.images[e.studentSignature.id]} alt={`Student signature, ${usDate(r.date)}`} />}
                      {staff && e?.studentSignature?.addedBy && <span className="small muted no-print" style={{ display: "block" }}>added by {e.studentSignature.addedBy.staffName}</span>}
                    </td>
                    <td>{e?.staffSignature && p.images[e.staffSignature.id] && <img className="sig" src={p.images[e.staffSignature.id]} alt={`Signed by ${e.staffSignature.staffName}`} title={e.staffSignature.staffName} />}</td>
                  </tr>
                );
              })}
              <tr><td colSpan={4} style={{ textAlign: "right", fontWeight: 700 }}>TOTAL HOURS</td><td><span className="hand">{hoursText(p.totalMinutes) || "0"}</span></td><td colSpan={2}></td></tr>
            </tbody>
          </table>

          <table className="approve" style={{ marginTop: 16 }}>
            <tbody>
              <tr>
                <td style={{ width: "34%" }}><b>Approved by</b><br />STAFF NAME/POSITION:<br /><span className="hand">{p.approval ? `${p.approval.staffName}${p.approval.position ? `, ${p.approval.position}` : ""}` : ""}</span></td>
                <td style={{ width: "28%" }}>STAFF SIGNATURE:<br />{p.approval && p.images[p.approval.signatureId] && <img className="sig" src={p.images[p.approval.signatureId]} alt={`Signature of ${p.approval.staffName}`} />}</td>
                <td>COMMENTS:<br /><span className="hand" style={{ whiteSpace: "normal", fontSize: 20 }}>{p.approval?.comments}</span></td>
              </tr>
            </tbody>
          </table>
          {p.approval && !p.approvalCurrent && <p className="msg info no-print">A row changed after this month was approved. It needs approving again.</p>}
        </article>
      </div>

      {staff && <ApproveForm studentId={s._id} month={p.month} hasSaved={!!p.hasSavedSignature} approved={!!p.approval && p.approvalCurrent} />}

      {staff && picked.size > 0 && (
        <div className="sticky no-print">
          <strong>{picked.size} row{picked.size === 1 ? "" : "s"} selected</strong>
          {p.hasSavedSignature
            ? <button className="btn" disabled={pending} onClick={signPicked}>Sign {picked.size} with my signature</button>
            : <a className="btn" href="/staff/account">Put your signature on file first</a>}
          {offerStudent && p.hasSavedSignature && (p.studentHasSignature ? (
            <label className="small" title="Uses the student's signature on file. Recorded as added by you.">
              <input type="checkbox" className="chk" checked={withStudent} onChange={(e) => setWithStudent(e.target.checked)} />{" "}
              Also add student signature ({pickedMissing} row{pickedMissing === 1 ? "" : "s"})
            </label>
          ) : (
            <span className="small muted">{pickedMissing} row{pickedMissing === 1 ? " has" : "s have"} no student signature, and none is on file. <a href={`/staff/students/${s._id}`}>Add one</a></span>
          ))}
          <button className="btn ghost" onClick={() => setPicked(new Set())}>Clear selection</button>
        </div>
      )}
      {staff && picked.size === 0 && p.rows.some(signable) && (
        <p className="no-print"><button className="btn ghost" onClick={() => setPicked(new Set(p.rows.filter(signable).map((r) => key(r.date))))}>Select all rows ready for staff signature</button></p>
      )}

      {typing && p.clock && (
        <TimeEntry
          kind={typing} clock={p.clock} start={typing === "end" ? startForEnd : undefined}
          action={typing === "start" ? studentStartAction : studentFillAction}
          onCancel={() => setTyping(null)}
          onDone={(r) => { setTyping(null); setMsg(r); router.refresh(); }}
        />
      )}
      {editing && <EditRow studentId={s._id} row={editing} onClose={() => { setEditing(null); router.refresh(); }} />}
    </>
  );
}

function ApproveForm({ studentId, month, hasSaved, approved }: { studentId: string; month: string; hasSaved: boolean; approved: boolean }) {
  const router = useRouter();
  const comments = useRef<HTMLTextAreaElement>(null);
  const [msg, setMsg] = useState<ActionState>({});
  const [pending, start] = useTransition();
  const send = () => start(async () => {
    const fd = new FormData();
    fd.set("comments", comments.current?.value ?? "");
    setMsg(await approveMonthAction(studentId, month, {}, fd));
    router.refresh();
  });
  return (
    <section className="panel no-print" style={{ maxWidth: 980, margin: "16px auto" }}>
      <h2 style={{ marginTop: 0 }}>{approved ? "Approved" : "Approve this month"}</h2>
      <div className="field"><label htmlFor="cmt">Comments (optional)</label><textarea id="cmt" ref={comments} rows={2} /></div>
      {hasSaved
        ? <button className="btn" disabled={pending} onClick={send}>{approved ? "Approve again" : "Approve"} with my signature</button>
        : <a className="btn" href="/staff/account">Put your signature on file first</a>}
      <Msg state={msg} />
    </section>
  );
}

function EditRow({ studentId, row, onClose }: { studentId: string; row: SheetRow; onClose: () => void }) {
  const e = row.entry;
  const [state, setState] = useState<ActionState>({});
  const [pending, start] = useTransition();
  const [status, setStatus] = useState(e?.status ?? (row.holiday ? "HOLIDAY" : "PRESENT"));
  const submit = (ev: React.FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const fd = new FormData(ev.currentTarget);
    start(async () => {
      const r = await editRowAction(studentId, row.date, {}, fd);
      setState(r);
      if (r.ok) onClose();
    });
  };
  return (
    <div className="sigmodal" role="dialog" aria-modal="true" aria-label={`Edit ${usDate(row.date)}`}>
      <form className="panel" style={{ width: "min(520px, 100%)", margin: 0 }} onSubmit={submit}>
        <h2 style={{ marginTop: 0 }}>{row.weekdayName}, {usDate(row.date)}</h2>
        <div className="field">
          <label htmlFor="st">Status</label>
          <select id="st" name="status" value={status} onChange={(x) => setStatus(x.target.value as typeof status)}>
            <option value="PRESENT">Present</option><option value="ABSENT">Absent</option><option value="EXCUSED">Excused</option><option value="HOLIDAY">Holiday</option>
          </select>
        </div>
        {status === "PRESENT" && (
          <div className="grid2">
            <div className="field"><label htmlFor="s1">Start time</label><input id="s1" type="time" name="startTime" defaultValue={e?.startTime ?? ""} required />{state.fieldErrors?.startTime && <span className="err">{state.fieldErrors.startTime}</span>}</div>
            <div className="field"><label htmlFor="s2">End time</label><input id="s2" type="time" name="endTime" defaultValue={e?.endTime ?? ""} />{state.fieldErrors?.endTime && <span className="err">{state.fieldErrors.endTime}</span>}</div>
          </div>
        )}
        <div className="field"><label htmlFor="nt">Note (optional)</label><input id="nt" name="note" defaultValue={e?.note ?? ""} maxLength={200} /></div>
        <div className="field"><label htmlFor="rs">Reason for the change {e ? "" : "(optional)"}</label><input id="rs" name="reason" maxLength={200} placeholder="e.g. Forgot to tap End" />{state.fieldErrors?.reason && <span className="err">{state.fieldErrors.reason}</span>}</div>
        <p className="small muted">Saving removes the staff signature on this row, so it gets signed again. The student&apos;s signature stays.</p>
        {e && e.history.length > 0 && (
          <details className="small"><summary>Changes to this row ({e.history.length})</summary>
            <ul>{e.history.map((h, i) => <li key={i}>{new Date(h.at).toLocaleString("en-US")}: {h.what} by {h.byName} ({h.reason})</li>)}</ul>
          </details>
        )}
        <Msg state={state} />
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={pending}>{pending ? "Saving…" : "Save row"}</button>
        </div>
      </form>
    </div>
  );
}

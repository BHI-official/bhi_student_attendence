"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ActionState } from "@/lib/action";
import type { Entry, MonthApproval, Student } from "@/lib/types";
import { LATE_ENTRY_FLAG_MINUTES, clockIn, hoursText, monthTitle, time12, toMinutes, usDate, type SheetRow } from "@/lib/sheet";
import { studentFillAction, studentStartAction } from "@/actions/student";
import { approveMonthAction, editRowAction, fillStudentSignatureAction, fillStudentSignaturesAction, replaceRowSignatureAction, saveMySignatureAction, signRowsAction } from "@/actions/staff";
import { setStudentSignatureAction } from "@/actions/admin";
import { SignatureOnFile } from "./SignatureCapture";
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
<<<<<<< HEAD
  /** Staff mode: the student has a signature on file, so staff can fill it into rows. */
  studentHasSignature?: boolean;
  /** Staff mode: the signatures on file now (their images are in `images`), and who is signing. */
  studentSignatureId?: string | null;
  staffSignatureId?: string | null;
  staffName?: string;
=======
  /** Staff mode: admins can add the student's signature on file while signing rows. */
  isAdmin?: boolean;
  studentHasSignature?: boolean;
>>>>>>> 3e7ce88042cb3e940d814dd1e2ca3566f364165b
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
<<<<<<< HEAD
  const offerStudent = staff && pickedMissing > 0;
=======
  const offerStudent = staff && !!p.isAdmin && pickedMissing > 0;
>>>>>>> 3e7ce88042cb3e940d814dd1e2ca3566f364165b
  const signPicked = () => {
    const fd = new FormData();
    fd.set("rows", JSON.stringify([...picked]));
    if (offerStudent && withStudent && p.studentHasSignature) fd.set("withStudentSignature", "1");
    run(async () => { const r = await signRowsAction({}, fd); if (r.ok) setPicked(new Set()); return r; });
  };
  // ----- Staff: one tap in a signature cell -----
  const fillStudent = (r: SheetRow) => run(() => fillStudentSignatureAction(key(r.date)));
  const fillStaff = (r: SheetRow) => {
    const fd = new FormData();
    fd.set("rows", JSON.stringify([key(r.date)]));
    run(async () => { const res = await signRowsAction({}, fd); if (res.ok) setPicked((x) => { const n = new Set(x); n.delete(key(r.date)); return n; }); return res; });
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

      {staff && (
        <SignaturePanel
          studentId={s._id} studentName={s.name} staffName={p.staffName ?? "You"}
          studentSig={p.studentSignatureId ? p.images[p.studentSignatureId] ?? null : null}
          staffSig={p.staffSignatureId ? p.images[p.staffSignatureId] ?? null : null}
          pending={pending}
          studentFillable={p.rows.filter((r) => !r.isFuture && missingStudent(r)).map((r) => key(r.date))}
          staffFillable={p.rows.filter(signable).map((r) => key(r.date))}
          studentOutdated={p.studentSignatureId ? p.rows.filter((r) => r.entry?.studentSignature && r.entry.studentSignature.id !== p.studentSignatureId).map((r) => key(r.date)) : []}
          staffOutdated={p.staffSignatureId ? p.rows.filter((r) => r.entry?.staffSignature && r.entry.staffSignature.id !== p.staffSignatureId).map((r) => key(r.date)) : []}
          run={run}
        />
      )}

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
<<<<<<< HEAD
                      {staff && !r.isFuture && missingStudent(r) && (p.studentHasSignature
                        ? <button className="fill no-print" disabled={pending} onClick={() => fillStudent(r)} aria-label={`Fill student signature, ${usDate(r.date)}`}>Fill with signature</button>
                        : <a className="small no-print" href="#signatures">No signature on file</a>)}
                      {staff && e?.studentSignature && p.studentSignatureId && e.studentSignature.id !== p.studentSignatureId && (
                        <button className="edit no-print" disabled={pending} onClick={() => run(() => replaceRowSignatureAction(k, "student"))}>Use new signature</button>
                      )}
                    </td>
                    <td>
                      {e?.staffSignature && p.images[e.staffSignature.id] && <img className="sig" src={p.images[e.staffSignature.id]} alt={`Signed by ${e.staffSignature.staffName}`} title={e.staffSignature.staffName} />}
                      {staff && signable(r) && p.hasSavedSignature && (
                        <button className="fill no-print" disabled={pending} onClick={() => fillStaff(r)} aria-label={`Fill staff signature, ${usDate(r.date)}`}>Fill with my signature</button>
                      )}
                      {staff && e?.staffSignature && p.staffSignatureId && e.staffSignature.id !== p.staffSignatureId && (
                        <button className="edit no-print" disabled={pending} onClick={() => run(() => replaceRowSignatureAction(k, "staff"))}>Re-sign with mine</button>
                      )}
                    </td>
=======
                    </td>
                    <td>{e?.staffSignature && p.images[e.staffSignature.id] && <img className="sig" src={p.images[e.staffSignature.id]} alt={`Signed by ${e.staffSignature.staffName}`} title={e.staffSignature.staffName} />}</td>
>>>>>>> 3e7ce88042cb3e940d814dd1e2ca3566f364165b
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
<<<<<<< HEAD
            <span className="small muted">{pickedMissing} row{pickedMissing === 1 ? " has" : "s have"} no student signature, and none is on file. <a href="#signatures">Add one</a></span>
=======
            <span className="small muted">{pickedMissing} row{pickedMissing === 1 ? " has" : "s have"} no student signature, and none is on file. <a href={`/staff/students/${s._id}`}>Add one</a></span>
>>>>>>> 3e7ce88042cb3e940d814dd1e2ca3566f364165b
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

/**
 * Staff mode, above the sheet: both signatures on file, with one place to add or replace each
 * (photo or drawing) and to fill or update every row of this month in one tap.
 */
function SignaturePanel(p: {
  studentId: string; studentName: string; staffName: string;
  studentSig: string | null; staffSig: string | null; pending: boolean;
  studentFillable: string[]; staffFillable: string[]; studentOutdated: string[]; staffOutdated: string[];
  run: (fn: () => Promise<ActionState>) => void;
}) {
  const [open, setOpen] = useState<"student" | "staff" | null>(null);
  const n = (x: number, one: string) => `${x} ${one}${x === 1 ? "" : "s"}`;

  const fillStudentAll = () => p.run(() => fillStudentSignaturesAction(p.studentFillable));
  const fillStaffAll = () => {
    const fd = new FormData();
    fd.set("rows", JSON.stringify(p.staffFillable));
    p.run(() => signRowsAction({}, fd));
  };
  const updateAll = (which: "student" | "staff", keys: string[]) => {
    if (which === "staff" && !window.confirm(`Re-sign ${n(keys.length, "row")} with your signature? You become the staff member who signed them.`)) return;
    p.run(async () => {
      let done = 0; let last: ActionState = {};
      for (const k of keys) { last = await replaceRowSignatureAction(k, which); if (last.ok) done++; }
      return done ? { ok: true, message: `Updated the signature on ${n(done, "row")}.` } : last;
    });
  };

  const slot = (which: "student" | "staff") => {
    const isStudent = which === "student";
    const img = isStudent ? p.studentSig : p.staffSig;
    const fillable = isStudent ? p.studentFillable : p.staffFillable;
    const outdated = isStudent ? p.studentOutdated : p.staffOutdated;
    return (
      <div className="sigslot">
        <h3>{isStudent ? "Student signature" : "My signature"}</h3>
        <p className="small muted" style={{ margin: "0 0 8px" }}>{isStudent ? p.studentName : p.staffName}</p>
        <div className={`sigbox${img ? "" : " empty"}`}>
          {img ? <img src={img} alt={isStudent ? `Signature of ${p.studentName}` : "My signature"} /> : <span>No signature on file</span>}
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          {img && fillable.length > 0 && (
            <button className="btn" disabled={p.pending} onClick={isStudent ? fillStudentAll : fillStaffAll}>
              {isStudent ? `Fill ${n(fillable.length, "row")}` : `Sign ${n(fillable.length, "row")}`}
            </button>
          )}
          {img && outdated.length > 0 && (
            <button className="btn ghost" disabled={p.pending} onClick={() => updateAll(which, outdated)}>
              {isStudent ? `Update ${n(outdated.length, "older row")}` : `Re-sign ${n(outdated.length, "row")} with mine`}
            </button>
          )}
          <button className={`btn ${img ? "ghost" : ""}`} onClick={() => setOpen(open === which ? null : which)} aria-expanded={open === which}>
            {open === which ? "Close" : img ? "Replace" : "Add signature"}
          </button>
        </div>
        {img && fillable.length === 0 && outdated.length === 0 && <p className="small muted" style={{ marginBottom: 0 }}>Every row that can be signed this month is done.</p>}
        {open === which && (
          <div style={{ marginTop: 12 }}>
            <SignatureOnFile
              compact onSaved={() => setOpen(null)}
              action={isStudent ? setStudentSignatureAction.bind(null, p.studentId) : saveMySignatureAction}
              title={isStudent ? `Signature of ${p.studentName}` : "Draw your signature"}
              uploadLabel={isStudent ? "Upload photo of their signature" : "Upload photo of my signature"}
              drawLabel="Draw it"
            />
            <p className="small muted">Rows already signed keep their old signature until you update them.</p>
          </div>
        )}
      </div>
    );
  };

  return (
    <section id="signatures" className="panel no-print sigpanel" aria-label="Signatures on file">
      {slot("student")}
      {slot("staff")}
    </section>
  );
}

"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ActionState } from "@/lib/action";
import type { Entry, MonthApproval, Student } from "@/lib/types";
import { LATE_ENTRY_FLAG_MINUTES, clockIn, hoursText, monthTitle, time12, toMinutes, usDate, type SheetRow } from "@/lib/sheet";
import { studentCommentAction, studentFillAction, studentFillPastDayAction, studentRewriteTimeAction, studentSignRowAction, studentStartAction } from "@/actions/student";
import { addCommentAction, approveMonthAction, editRowAction, fillStudentSignatureAction, fillStudentSignaturesAction, replaceRowSignatureAction, saveMySignatureAction, signRowsAction } from "@/actions/staff";
import { setStudentSignatureAction } from "@/actions/admin";
import { SignatureOnFile } from "./SignatureCapture";
import { Msg } from "./forms";
import { TimeEntry, type SchoolClock } from "./TimeEntry";
import { Letterhead } from "./Brand";
import { InkField, InkPad, type InkValue } from "./Ink";

type Props = {
  /**
   * student: their own sheet. teacher: signs the staff signature on each row and comments; never
   * changes the student's entries. admin: corrections, and signs the "Approved by" section.
   */
  mode: "student" | "teacher" | "admin";
  student: Pick<Student, "_id" | "name" | "courseName" | "courseCode" | "courseDuration" | "caseManager" | "instructor" | "startDate" | "endDate">;
  month: string;
  rows: SheetRow[];
  totalMinutes: number;
  approval: MonthApproval | null;
  approvalCurrent: boolean;
  hasSavedSignature?: boolean;
  /** Staff mode: the student has a signature on file, so staff can fill it into rows. */
  studentHasSignature?: boolean;
  /** Staff mode: the signatures on file now (their images are in `images`), and who is signing. */
  studentSignatureId?: string | null;
  staffSignatureId?: string | null;
  staffName?: string;
  /** Signature images on this page, by id. */
  images: Record<string, string>;
  /** Student mode: the school's clock and the limits for typed times. */
  clock?: SchoolClock;
  /** Rows dated before this are locked (older than the editing window). Only admins change them. */
  firstOpenDate: string;
  editWindowDays: number;
  staffId?: string;
  /** Staff mode: what the "Approved by" form starts with (the account's name and position). */
  staffPosition?: string;
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
  /** Student: writing a saved time again (today, before staff sign). */
  const [rewriting, setRewriting] = useState<"start" | "end" | null>(null);
  /** A handwriting pad open for: signing rows as staff, or the student signing one of their days. */
  const [handFor, setHandFor] = useState<{ who: "staff"; keys: string[]; fromSelection: boolean } | { who: "student"; date: string } | null>(null);
  const [commentsFor, setCommentsFor] = useState<SheetRow | null>(null);
  /** Student: a past day they're filling in. */
  const [pastFor, setPastFor] = useState<SheetRow | null>(null);
  const staff = p.mode !== "student";
  const admin = p.mode === "admin";
  const key = (date: string) => `${p.student._id}:${date}`;
  /** Older than the editing window. Teachers can't sign or comment on these rows; admins can. */
  const locked = (r: SheetRow) => r.date < p.firstOpenDate;
  /** Admin: may change the student's side of the row (times, status, the student's signature). */
  const canChange = (r: SheetRow) => admin && !r.isFuture;
  /** Teacher: signs the staff column of any past row (each row is signed once, so nothing is replaced). */
  const canSignRow = (r: SheetRow) => p.mode === "teacher" && !r.isFuture;
  /** Admin or teacher: may comment (teachers only while the row is open). */
  const canComment = (r: SheetRow) => staff && !r.isFuture && (!locked(r) || admin);
  /** Student: a past class day with nothing recorded, still open, in a month not yet approved. */
  const canFillPast = (r: SheetRow) => !staff && !r.isToday && !r.isFuture && !locked(r) && !r.holiday && !r.entry && !p.approval;

  const run = (fn: () => Promise<ActionState>) =>
    start(async () => {
      try { setMsg((await fn()) ?? {}); } catch { setMsg({ error: "Something went wrong. Try again." }); }
      router.refresh();
    });

  // ----- Student: today's row (the student types their times) -----
  const todayRow = p.rows.find((r) => r.isToday);
  const studentCell = (r: SheetRow, col: "start" | "end") => {
    if (col === "start" && canFillPast(r)) return <button className="fill go no-print" disabled={pending} onClick={() => setPastFor(r)}>Fill in this day</button>;
    if (staff || !r.isToday || r.holiday || !p.clock) return null;
    const e = r.entry;
    if (e && e.status !== "PRESENT") return null;
    if (col === "start" && !e?.startTime) return <button className="fill go" disabled={pending} onClick={() => setTyping("start")}>Enter start time</button>;
    if (col === "end" && e?.startTime && !e.endTime) return <button className="fill go" disabled={pending} onClick={() => setTyping("end")}>Enter end time</button>;
    return null;
  };
  /** Student: their own time today can be written again until staff sign the row. */
  const canRewrite = (r: SheetRow) => !staff && r.isToday && !r.holiday && !!p.clock && !!r.entry && r.entry.status === "PRESENT" && !r.entry.staffSignature;
  /** Student: a day of theirs with both times but no signature yet, still open, not yet validated by staff. */
  const studentCanSign = (r: SheetRow) => !staff && !r.isFuture && !locked(r) && !r.holiday && !!r.entry && r.entry.status === "PRESENT"
    && !!r.entry.startTime && !!r.entry.endTime && !r.entry.studentSignature && !r.entry.staffSignature;
  const startForEnd = (() => {
    const e = todayRow?.entry;
    if (!e?.startTime || !p.clock) return undefined;
    return { time: e.startTime, enteredAtMinutes: e.startAt ? toMinutes(clockIn(p.clock.tz, new Date(e.startAt), "end")) : null };
  })();

  // ----- Staff: sign selected rows -----
  /** Holidays (on the list, or a row marked Holiday) are never signed, by anyone. */
  const isHoliday = (r: SheetRow) => !!r.holiday || r.entry?.status === "HOLIDAY";
  const signable = (r: SheetRow) => canSignRow(r) && !isHoliday(r) && !r.entry?.staffSignature && !!r.entry && (r.entry.status !== "PRESENT" || (!!r.entry.startTime && !!r.entry.endTime));
  /** A present day with both times and no student signature: staff can fill it. */
  const missingStudent = (r: SheetRow) => !r.holiday && !!r.entry && r.entry.status === "PRESENT" && !!r.entry.startTime && !!r.entry.endTime && !r.entry.studentSignature;
  /** Teacher: sign rows with the signature on file, or with one just written by hand. */
  const signRows = (keys: string[], handPng?: string) => {
    const fd = new FormData();
    fd.set("rows", JSON.stringify(keys));
    if (handPng) fd.set("signature", handPng);
    run(async () => { const r = await signRowsAction({}, fd); if (r.ok) setPicked((x) => { const n = new Set(x); keys.forEach((k) => n.delete(k)); return n; }); return r; });
  };
  const signPicked = () => signRows([...picked]);
  // ----- Staff: one tap in a signature cell -----
  const fillStudent = (r: SheetRow) => run(() => fillStudentSignatureAction(key(r.date)));
  const fillStaff = (r: SheetRow) => signRows([key(r.date)]);
  const onHand = (v: InkValue) => {
    const target = handFor;
    setHandFor(null);
    if (!v || !target) return;
    if (target.who === "staff") return signRows(target.keys, v.png);
    const fd = new FormData();
    fd.set("signature", v.png);
    run(() => studentSignRowAction(target.date, {}, fd));
  };
  const toggle = (k: string) => setPicked((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  const timeCell = (r: SheetRow, which: "startTime" | "endTime") => {
    const e = r.entry;
    const t = e?.[which];
    // The student's own handwriting when they wrote it; otherwise (older rows, staff corrections) the time itself.
    const inkId = which === "startTime" ? e?.startInkId : e?.endInkId;
    const ink = inkId ? p.images[inkId] : null;
    if (t) return (
      <>
        {ink
          ? <img className="timeink" src={ink} alt={`${which === "startTime" ? "Start" : "End"} time, handwritten. School clock: ${time12(t)}`} title={`School clock: ${time12(t)}`} />
          : <span className="hand">{time12(t).replace(" ", "")}</span>}
        {ink && (staff || evidence) && <span className="small muted no-print" style={{ display: "block" }}>clock {time12(t)}</span>}
        {staff && ink && e!.history?.some((h) => h.what.startsWith(`rewrote ${which === "startTime" ? "start" : "end"}`)) && (
          <span className="tag no-print" style={{ display: "block", marginTop: 2 }} title="The student wrote this time again after saving it. The earlier handwriting is in the audit log.">rewritten</span>
        )}
        {canRewrite(r) && (
          <button type="button" className="linkbtn small no-print" disabled={pending} onClick={() => setRewriting(which === "startTime" ? "start" : "end")}>Write again</button>
        )}
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
          studentId={s._id} studentName={s.name} staffName={p.staffName ?? "You"} mode={admin ? "student" : "staff"}
          studentSig={p.studentSignatureId ? p.images[p.studentSignatureId] ?? null : null}
          staffSig={p.staffSignatureId ? p.images[p.staffSignatureId] ?? null : null}
          pending={pending}
          studentFillable={p.rows.filter((r) => canChange(r) && missingStudent(r)).map((r) => key(r.date))}
          staffFillable={p.rows.filter((r) => signable(r) && !!p.hasSavedSignature).map((r) => key(r.date))}
          studentOutdated={p.studentSignatureId ? p.rows.filter((r) => !locked(r) && !isHoliday(r) && r.entry?.studentSignature && r.entry.studentSignature.id !== p.studentSignatureId).map((r) => key(r.date)) : []}
          // Only your own older signature is updated, and only on open rows: others' signatures (and history) stay.
          staffOutdated={p.staffSignatureId ? p.rows.filter((r) => !locked(r) && !isHoliday(r) && r.entry?.staffSignature && r.entry.staffSignature.staffId === p.staffId && r.entry.staffSignature.id !== p.staffSignatureId).map((r) => key(r.date)) : []}
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
                      {canChange(r) && <><br /><button className="edit no-print" onClick={() => setEditing(r)}>{locked(r) ? "Edit (locked)" : "Edit"}</button></>}
                      {staff && e?.filledLaterAt && (
                        <><br /><span className="tag warn no-print" title={`The student filled this day in on ${new Date(e.filledLaterAt).toLocaleString("en-US")}. Check the times before signing.`}>filled in later</span></>
                      )}
                      {staff && e && (canComment(r) || (e.comments?.length ?? 0) > 0) && (
                        <><br /><button className="cmt no-print" onClick={() => setCommentsFor(r)} aria-label={`Comments for ${usDate(r.date)}`}>
                          {(e.comments?.length ?? 0) ? `Comments (${e.comments!.length})` : "+ Comment"}
                        </button></>
                      )}
                      {!staff && (e?.comments?.length ?? 0) > 0 && <><br /><a className="cmt no-print" href="#comments">Note{e!.comments!.length === 1 ? "" : "s"} ({e!.comments!.length})</a></>}
                    </td>
                    {isHoliday(r) ? (
                      // Holiday: one open cell to the end of the row, no column lines.
                      <td colSpan={5} className="span hand" style={{ textAlign: "center", fontWeight: 700 }}>{r.holiday ?? (e?.note || STATUS_WORD.HOLIDAY)}</td>
                    ) : off ? (
                      <td colSpan={3} className="span hand" style={{ textAlign: "center" }}>{r.holiday ? r.holiday : STATUS_WORD[e!.status]}{e?.note && !r.holiday ? ` (${e.note})` : ""}</td>
                    ) : (
                      <>
                        <td>{timeCell(r, "startTime")}</td>
                        <td>{timeCell(r, "endTime")}</td>
                        <td>{e?.minutes != null && <span className="hand">{hoursText(e.minutes)}</span>}</td>
                      </>
                    )}
                    {!isHoliday(r) && <>
                    <td>
                      {e?.studentSignature && p.images[e.studentSignature.id] && <img className="sig" src={p.images[e.studentSignature.id]} alt={`Student signature, ${usDate(r.date)}`} />}
                      {studentCanSign(r) && (
                        <button className="fill go no-print" disabled={pending} onClick={() => setHandFor({ who: "student", date: r.date })}>Sign</button>
                      )}
                      {canChange(r) && missingStudent(r) && (p.studentHasSignature
                        ? <button className="fill no-print" disabled={pending} onClick={() => fillStudent(r)} aria-label={`Fill student signature, ${usDate(r.date)}`}>Fill with signature</button>
                        : <a className="small no-print" href="#signatures">No signature on file</a>)}
                      {admin && !locked(r) && e?.studentSignature && p.studentSignatureId && e.studentSignature.id !== p.studentSignatureId && (
                        <button className="edit no-print" disabled={pending} onClick={() => run(() => replaceRowSignatureAction(k, "student"))}>Use new signature</button>
                      )}
                    </td>
                    <td>
                      {e?.staffSignature && p.images[e.staffSignature.id] && <img className="sig" src={p.images[e.staffSignature.id]} alt={`Signed by ${e.staffSignature.staffName}`} title={e.staffSignature.staffName} />}
                      {signable(r) && p.hasSavedSignature && (
                        <button className="fill no-print" disabled={pending} onClick={() => fillStaff(r)} aria-label={`Fill staff signature, ${usDate(r.date)}`}>Fill with my signature</button>
                      )}
                      {signable(r) && (
                        <button className="edit no-print" style={{ display: "block", margin: "3px auto 0" }} disabled={pending} onClick={() => setHandFor({ who: "staff", keys: [k], fromSelection: false })} aria-label={`Sign by hand, ${usDate(r.date)}`}>Sign by hand</button>
                      )}
                    </td>
                    </>}
                  </tr>
                );
              })}
              <tr><td colSpan={4} style={{ textAlign: "right", fontWeight: 700 }}>TOTAL HOURS</td><td><span className="hand">{hoursText(p.totalMinutes) || "0"}</span></td><td colSpan={2}></td></tr>
            </tbody>
          </table>

          <table className="approve" style={{ marginTop: 16 }}>
            <tbody>
              <tr>
                <td style={{ width: "34%" }}><b>Approved by</b><br />STAFF NAME/POSITION:<br /><span className="hand">{p.approval ? `${p.approval.staffName}${p.approval.position ? `/${p.approval.position}` : ""}`.toUpperCase() : ""}</span></td>
                <td style={{ width: "28%" }}>STAFF SIGNATURE:<br />{p.approval && p.images[p.approval.signatureId] && <img className="sig" src={p.images[p.approval.signatureId]} alt={`Signature of ${p.approval.staffName}`} />}</td>
                <td>COMMENTS:<br /><span className="hand" style={{ whiteSpace: "normal", fontSize: 20 }}>{p.approval?.comments}</span>
                  {p.approval?.commentsInkId && p.images[p.approval.commentsInkId] && <img className="ink-note" src={p.images[p.approval.commentsInkId]} alt="Handwritten comments" />}</td>
              </tr>
            </tbody>
          </table>
          {p.approval && !p.approvalCurrent && <p className="msg info no-print">A row changed after this month was approved. It needs approving again.</p>}
          <MonthComments rows={p.rows} images={p.images} />
        </article>
      </div>

      {admin && (
        <ApproveForm
          studentId={s._id} month={p.month} hasSaved={!!p.hasSavedSignature} approved={!!p.approval && p.approvalCurrent}
          unsignedRows={p.rows.filter((r) => !r.isFuture && !isHoliday(r) && !!r.entry && !r.entry.staffSignature && (r.entry.status !== "PRESENT" || (!!r.entry.startTime && !!r.entry.endTime))).length}
          defaultName={p.approval?.staffId === p.staffId ? p.approval!.staffName : p.staffName ?? ""}
          defaultPosition={p.approval?.staffId === p.staffId ? p.approval!.position : p.staffPosition ?? ""}
        />
      )}
      {!staff && todayRow?.entry && !todayRow.holiday && (
        <section className="panel no-print" style={{ maxWidth: 980, margin: "16px auto" }}>
          <h2 style={{ marginTop: 0 }}>Add a note to today</h2>
          <p className="small muted">For example why you were late or left early. Type it, write it by hand, or both. Staff see it on your sheet.</p>
          <CommentForm onSubmit={(fd) => studentCommentAction({}, fd)} onSaved={() => router.refresh()} />
        </section>
      )}

      {p.mode === "teacher" && picked.size > 0 && (
        <div className="sticky no-print">
          <strong>{picked.size} row{picked.size === 1 ? "" : "s"} selected</strong>
          {p.hasSavedSignature && <button className="btn" disabled={pending} onClick={signPicked}>Sign {picked.size} with my signature</button>}
          <button className={p.hasSavedSignature ? "btn ghost" : "btn"} disabled={pending} onClick={() => setHandFor({ who: "staff", keys: [...picked], fromSelection: true })}>Sign {picked.size} by hand</button>
          <button className="btn ghost" onClick={() => setPicked(new Set())}>Clear selection</button>
        </div>
      )}
      {p.mode === "teacher" && picked.size === 0 && p.rows.some(signable) && (
        <p className="no-print"><button className="btn ghost" onClick={() => setPicked(new Set(p.rows.filter(signable).map((r) => key(r.date))))}>Select all rows ready for my signature</button></p>
      )}

      {typing && p.clock && (
        <TimeEntry
          kind={typing} clock={p.clock} start={typing === "end" ? startForEnd : undefined}
          action={typing === "start" ? studentStartAction : studentFillAction}
          onCancel={() => setTyping(null)}
          onDone={(r) => { setTyping(null); setMsg(r); router.refresh(); }}
        />
      )}
      {rewriting && p.clock && todayRow?.entry && (() => {
        const e = todayRow.entry;
        const time = rewriting === "start" ? e.startTime : e.endTime;
        const inkId = rewriting === "start" ? e.startInkId : e.endInkId;
        if (!time) return null;
        return (
          <TimeEntry
            kind={rewriting} clock={p.clock}
            rewrite={{ time, ink: inkId ? p.images[inkId] ?? null : null }}
            action={(prev, fd) => studentRewriteTimeAction(rewriting, prev, fd)}
            onCancel={() => setRewriting(null)}
            onDone={(r) => { setRewriting(null); setMsg(r); router.refresh(); }}
          />
        );
      })()}
      {pastFor && (
        <PastDayDialog row={pastFor} onCancel={() => setPastFor(null)} onDone={(r) => { setPastFor(null); setMsg(r); router.refresh(); }}
          submit={(fd) => studentFillPastDayAction(pastFor.date, {}, fd)} />
      )}
      {editing && <EditRow studentId={s._id} row={editing} locked={locked(editing)} onClose={() => { setEditing(null); router.refresh(); }} />}
      {commentsFor && (
        <CommentsDialog
          row={commentsFor} images={p.images} canAdd={canComment(commentsFor)}
          onSubmit={(fd) => addCommentAction(key(commentsFor.date), {}, fd)}
          onClose={() => { setCommentsFor(null); router.refresh(); }}
        />
      )}
      {handFor && (
        <InkPad
          kind="signature"
          title={handFor.who === "student" ? `Sign for ${usDate(handFor.date)}` : `Sign ${handFor.keys.length} row${handFor.keys.length === 1 ? "" : "s"} as ${p.staffName ?? "staff"}`}
          hint={handFor.who === "staff" ? "Your signature validates the attendance on these rows." : "Use your finger, a stylus or the mouse."}
          onCancel={() => setHandFor(null)}
          onDone={onHand}
          doneLabel={handFor.who === "staff" ? "Sign" : "Use this signature"}
        />
      )}
    </>
  );
}

/** Admin: the "Approved by" section at the bottom of the month. */
function ApproveForm({ studentId, month, hasSaved, approved, unsignedRows, defaultName, defaultPosition }: {
  studentId: string; month: string; hasSaved: boolean; approved: boolean;
  /** Rows the teacher hasn't signed yet: approving is still allowed, but the admin sees it first. */
  unsignedRows: number;
  defaultName: string; defaultPosition: string;
}) {
  const router = useRouter();
  const comments = useRef<HTMLTextAreaElement>(null);
  const name = useRef<HTMLInputElement>(null);
  const position = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<ActionState>({});
  const [pending, start] = useTransition();
  const [how, setHow] = useState<"file" | "hand">(hasSaved ? "file" : "hand");
  const [sig, setSig] = useState<InkValue>(null);
  const [ink, setInk] = useState<InkValue>(null);
  const send = () => start(async () => {
    const fd = new FormData();
    fd.set("comments", comments.current?.value ?? "");
    fd.set("staffName", name.current?.value ?? "");
    fd.set("position", position.current?.value ?? "");
    if (how === "hand") { if (!sig) { setMsg({ error: "Sign in the box first." }); return; } fd.set("signature", sig.png); }
    if (ink) fd.set("commentsInk", ink.png);
    const r = await approveMonthAction(studentId, month, {}, fd);
    setMsg(r);
    if (r.ok) { setSig(null); setInk(null); }
    router.refresh();
  });
  return (
    <section className="panel no-print" style={{ maxWidth: 980, margin: "16px auto" }}>
      <h2 style={{ marginTop: 0 }}>{approved ? "Approved" : "Approve this month"}</h2>
      <p className="small muted" style={{ marginTop: 0 }}>This fills in the “Approved by” section at the bottom of the sheet.</p>
      {unsignedRows > 0 && <p className="msg info">{unsignedRows} row{unsignedRows === 1 ? " isn’t" : "s aren’t"} signed by the teacher yet. You can approve now, or wait until the teacher has signed every row.</p>}
      <div className="grid2">
        <div className="field"><label htmlFor="apname">Staff name</label><input id="apname" ref={name} defaultValue={defaultName} maxLength={80} required autoComplete="name" />
          {msg.fieldErrors?.staffName && <span className="err">{msg.fieldErrors.staffName}</span>}</div>
        <div className="field"><label htmlFor="appos">Position</label><input id="appos" ref={position} defaultValue={defaultPosition} maxLength={60} placeholder="Instructor" /></div>
      </div>
      <div className="field"><label htmlFor="cmt">Comments (optional)</label><textarea id="cmt" ref={comments} rows={2} maxLength={600} /></div>
      <InkField kind="note" label="Handwritten comments (optional)" title="Write your comments" value={ink} onChange={setInk} compact />
      <fieldset className="field" style={{ border: 0, padding: 0 }}>
        <legend style={{ fontWeight: 700, fontSize: 15, marginBottom: 6 }}>Signature</legend>
        <div className="row">
          {hasSaved && <label><input type="radio" name="how" checked={how === "file"} onChange={() => setHow("file")} /> My signature on file</label>}
          <label><input type="radio" name="how" checked={how === "hand"} onChange={() => setHow("hand")} /> Sign by hand now</label>
        </div>
      </fieldset>
      {how === "hand" && <InkField kind="signature" label="Your signature" title="Sign to approve this month" value={sig} onChange={setSig} />}
      <button className="btn" disabled={pending || (how === "hand" && !sig)} onClick={send}>{pending ? "Approving…" : `${approved ? "Approve again" : "Approve"} with my signature`}</button>
      <Msg state={msg} />
    </section>
  );
}

/** Comments under the sheet (also printed): every comment on this month's rows, oldest first. */
function MonthComments({ rows, images }: { rows: SheetRow[]; images: Record<string, string> }) {
  const all = rows.flatMap((r) => (r.entry?.comments ?? []).map((c) => ({ ...c, date: r.date })));
  if (!all.length) return null;
  all.sort((a, b) => a.date.localeCompare(b.date) || new Date(a.at).getTime() - new Date(b.at).getTime());
  return (
    <section className="comments" id="comments" aria-label="Comments">
      <h3>COMMENTS</h3>
      <ul>
        {all.map((c) => (
          <li key={c.id}>
            <b>{usDate(c.date)}</b> – {c.byName}{c.byRole === "STUDENT" ? " (student)" : ""}: {c.text}
            {c.inkId && images[c.inkId] && <img className="ink-note" src={images[c.inkId]} alt={`Handwritten comment by ${c.byName}`} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Type a comment, write it by hand, or both. */
function CommentForm({ onSubmit, onSaved }: { onSubmit: (fd: FormData) => Promise<ActionState>; onSaved?: () => void }) {
  const [text, setText] = useState("");
  const [ink, setInk] = useState<InkValue>(null);
  const [msg, setMsg] = useState<ActionState>({});
  const [pending, start] = useTransition();
  const send = () => start(async () => {
    const fd = new FormData();
    fd.set("text", text);
    if (ink) fd.set("ink", ink.png);
    let r: ActionState;
    try { r = await onSubmit(fd); } catch { r = { error: "Couldn't save. Check the connection and try again." }; }
    setMsg(r);
    if (r.ok) { setText(""); setInk(null); onSaved?.(); }
  });
  return (
    <div>
      <div className="field"><label htmlFor="ctext">Type it</label><textarea id="ctext" rows={2} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} /></div>
      <InkField kind="note" label="Or write it by hand" title="Write your note" value={ink} onChange={setInk} compact />
      <button type="button" className="btn" disabled={pending || (!text.trim() && !ink)} onClick={send}>{pending ? "Saving…" : "Add note"}</button>
      <Msg state={msg} />
    </div>
  );
}

function CommentsDialog({ row, images, canAdd, onSubmit, onClose }: {
  row: SheetRow; images: Record<string, string>; canAdd: boolean; onSubmit: (fd: FormData) => Promise<ActionState>; onClose: () => void;
}) {
  const list = row.entry?.comments ?? [];
  return (
    <div className="sigmodal" role="dialog" aria-modal="true" aria-label={`Comments, ${usDate(row.date)}`} onKeyDown={(e) => { if (e.key === "Escape" && !document.querySelector(".inkmodal")) onClose(); }}>
      <div className="panel" style={{ width: "min(560px, 100%)", margin: 0, maxHeight: "100%", overflow: "auto" }}>
        <h2 style={{ marginTop: 0 }}>Comments · {row.weekdayName}, {usDate(row.date)}</h2>
        {list.length === 0 ? <p className="muted">No comments yet.</p> : (
          <ul className="cmtlist">
            {list.map((c) => (
              <li key={c.id}>
                <div className="small muted">{new Date(c.at).toLocaleString("en-US")} · {c.byName}{c.byRole === "STUDENT" ? " (student)" : ""}</div>
                {c.text && <div>{c.text}</div>}
                {c.inkId && images[c.inkId] && <img className="ink-note" src={images[c.inkId]} alt={`Handwritten comment by ${c.byName}`} />}
              </li>
            ))}
          </ul>
        )}
        {canAdd ? <CommentForm onSubmit={onSubmit} onSaved={onClose} /> : <p className="small muted">This row is locked. Only an admin can add comments to it.</p>}
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 8 }}><button type="button" className="btn ghost" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

/**
 * Student: fill in a past class day they forgot. Typed start and end time, their signature, and
 * optionally why it's late. Hours are shown as they type so mistakes are easy to spot.
 */
function PastDayDialog({ row, submit, onCancel, onDone }: {
  row: SheetRow; submit: (fd: FormData) => Promise<ActionState>; onCancel: () => void; onDone: (r: ActionState) => void;
}) {
  const [startTime, setStart] = useState("");
  const [endTime, setEnd] = useState("");
  const [note, setNote] = useState("");
  const [sig, setSig] = useState<InkValue>(null);
  const [state, setState] = useState<ActionState>({});
  const [pending, start] = useTransition();
  const minutes = startTime && endTime ? toMinutes(endTime) - toMinutes(startTime) : null;
  const send = (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!sig) { setState({ error: "Sign in the box before saving.", fieldErrors: { signature: "Sign here" } }); return; }
    const fd = new FormData();
    fd.set("startTime", startTime);
    fd.set("endTime", endTime);
    fd.set("note", note);
    fd.set("signature", sig.png);
    start(async () => {
      let r: ActionState;
      try { r = await submit(fd); } catch { r = { error: "Couldn't save. Check the connection and try again." }; }
      if (r.ok) onDone(r); else setState(r);
    });
  };
  return (
    <div className="sigmodal" role="dialog" aria-modal="true" aria-label={`Fill in ${usDate(row.date)}`}
      onKeyDown={(e) => { if (e.key === "Escape" && !document.querySelector(".inkmodal")) onCancel(); }}>
      <form className="panel" style={{ width: "min(520px, 100%)", margin: 0, maxHeight: "100%", overflow: "auto" }} onSubmit={send}>
        <h2 style={{ marginTop: 0 }}>{row.weekdayName}, {usDate(row.date)}</h2>
        <p className="small muted" style={{ marginTop: 0 }}>Enter the times you were in class that day. Your teacher reviews days filled in later before signing them.</p>
        <div className="grid2">
          <div className="field"><label htmlFor="pd1">Start time</label><input id="pd1" type="time" value={startTime} onChange={(e) => setStart(e.target.value)} required />
            {state.fieldErrors?.startTime && <span className="err">{state.fieldErrors.startTime}</span>}</div>
          <div className="field"><label htmlFor="pd2">End time</label><input id="pd2" type="time" value={endTime} onChange={(e) => setEnd(e.target.value)} required />
            {state.fieldErrors?.endTime && <span className="err">{state.fieldErrors.endTime}</span>}</div>
        </div>
        {minutes !== null && (
          <p className="small" aria-live="polite" style={{ marginTop: 0 }}>
            {minutes > 0 ? <>From {time12(startTime)} to {time12(endTime)}: <b>{hoursText(minutes)} hours</b></> : <span className="err">The end time must be after the start time.</span>}
          </p>
        )}
        <div className="field"><label htmlFor="pdn">Why are you filling it in now? (optional)</label>
          <textarea id="pdn" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. The tablet wasn't working" /></div>
        <InkField kind="signature" label="Your signature" title={`Sign for ${usDate(row.date)}`} value={sig} onChange={setSig} required />
        {state.fieldErrors?.signature && <span className="err">{state.fieldErrors.signature}</span>}
        <Msg state={{ error: state.error }} />
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
          <button className="btn" disabled={pending || !startTime || !endTime || !sig}>{pending ? "Saving…" : "Save and sign"}</button>
        </div>
      </form>
    </div>
  );
}

function EditRow({ studentId, row, locked, onClose }: { studentId: string; row: SheetRow; locked: boolean; onClose: () => void }) {
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
        {locked && <p className="msg info">This row is locked (older than the editing window). As an admin you can still change it; a reason is required and the change is recorded.</p>}
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
        <div className="field"><label htmlFor="rs">Reason for the change {e || locked ? "" : "(optional)"}</label><input id="rs" name="reason" maxLength={200} placeholder="e.g. Forgot to tap End" />{state.fieldErrors?.reason && <span className="err">{state.fieldErrors.reason}</span>}</div>
        <p className="small muted">Saving removes the teacher&apos;s signature on this row, so the teacher signs it again. The student&apos;s signature stays.</p>
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
 * Above the sheet: one signature on file (the student's for an admin, the teacher's own for a
 * teacher), signed by hand on the screen, and one tap to fill or update every row of this month.
 */
function SignaturePanel(p: {
  studentId: string; studentName: string; staffName: string;
  /** Which signature this panel manages: the admin manages the student's, the teacher their own. */
  mode: "student" | "staff";
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
    if (which === "staff" && !window.confirm(`Update ${n(keys.length, "row")} to your current signature?`)) return;
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
              {`Update ${n(outdated.length, "older row")}`}
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
              title={isStudent ? `${p.studentName}: sign your name` : "Sign your name"}
              drawLabel={isStudent ? "Student signs on the screen" : "Sign on the screen"}
            />
            <p className="small muted">Rows already signed keep their old signature until you update them.</p>
          </div>
        )}
      </div>
    );
  };

  return (
    <section id="signatures" className="panel no-print sigpanel" aria-label="Signatures on file">
      {slot(p.mode)}
    </section>
  );
}
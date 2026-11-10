"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ActionState } from "@/lib/action";
import { LATE_ENTRY_FLAG_MINUTES, hoursText, time12 } from "@/lib/sheet";
import { fillStudentSignatureAction, markAbsentAction, signRowsAction } from "@/actions/staff";
import { Msg } from "./forms";
import { InkPad } from "./Ink";

export type BoardRow = {
  id: string; name: string; course: string;
  status: string | null; start: string | null; end: string | null; minutes: number | null;
  /** Minutes after the fact the student typed each time (null if staff wrote it). */
  startLateBy: number | null; endLateBy: number | null;
  studentSigned: boolean; staffSigned: boolean;
  /** The student has a signature on file (staff can fill it into the row). */
  studentHasSignature: boolean;
};

/**
 * One day, every student with class that day: who started, ended, signed.
 * Teacher: signs many rows at once (the staff signature). Admin: watches the day, marks students
 * who never started as absent, and fills in a student's signature on file; admins don't sign rows.
 */
const isLate = (m: number | null) => m != null && m >= LATE_ENTRY_FLAG_MINUTES;

export function TodayBoard({ mode, date, month, rows, holiday, hasSaved, isToday, locked }: {
  mode: "admin" | "teacher";
  date: string; month: string; rows: BoardRow[]; holiday: string | null; hasSaved: boolean; isToday: boolean;
  /** Admin: this day can't be changed (never set for admins today; kept for safety). */
  locked: string | null;
}) {
  const teacher = mode === "teacher";
  const base = teacher ? "/teacher" : "/admin";
  const router = useRouter();
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<ActionState>({});
  const [pending, start] = useTransition();
  const [hand, setHand] = useState<string[] | null>(null);

  /** A present day with both times and no student signature: staff can fill it. */
  const missingStudent = (r: BoardRow) => !holiday && r.status === "PRESENT" && !!r.start && !!r.end && !r.studentSigned;
  /** Teacher: rows ready for their signature. Holidays are never signed. */
  const ready = (r: BoardRow) => teacher && !holiday && r.status !== "HOLIDAY" && !r.staffSigned && r.status !== null && (r.status !== "PRESENT" || (!!r.start && !!r.end));
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? rows.filter((r) => r.name.toLowerCase().includes(t) || r.course.toLowerCase().includes(t)) : rows;
  }, [rows, q]);
  const counts = {
    started: rows.filter((r) => r.start).length,
    ended: rows.filter((r) => r.end).length,
    studentSigned: rows.filter((r) => r.studentSigned).length,
    staffSigned: rows.filter((r) => r.staffSigned).length,
    notStarted: rows.filter((r) => !r.start && r.status === null).length,
    late: rows.filter((r) => isLate(r.startLateBy) || isLate(r.endLateBy)).length,
  };
  const run = (fn: () => Promise<ActionState>) => start(async () => {
    try { setMsg(await fn()); } catch { setMsg({ error: "Something went wrong. Try again." }); }
    router.refresh();
  });
  const sign = (handPng?: string) => {
    const fd = new FormData();
    fd.set("rows", JSON.stringify([...picked].map((id) => `${id}:${date}`)));
    if (handPng) fd.set("signature", handPng);
    run(async () => { const r = await signRowsAction({}, fd); if (r.ok) setPicked(new Set()); return r; });
  };
  const markAbsent = () => {
    const ids = rows.filter((r) => !r.start && r.status === null).map((r) => r.id);
    if (!window.confirm(`Mark ${ids.length} student${ids.length === 1 ? "" : "s"} with no start time as absent?`)) return;
    const fd = new FormData();
    fd.set("students", JSON.stringify(ids));
    run(() => markAbsentAction(date, {}, fd));
  };
  const fillStudent = (r: BoardRow) => run(() => fillStudentSignatureAction(`${r.id}:${date}`));
  const fillStaff = (r: BoardRow) => {
    const fd = new FormData();
    fd.set("rows", JSON.stringify([`${r.id}:${date}`]));
    run(async () => { const res = await signRowsAction({}, fd); if (res.ok) setPicked((x) => { const n = new Set(x); n.delete(r.id); return n; }); return res; });
  };
  const toggle = (id: string) => setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  /** Admin: fill the student's signature on file into a finished row. */
  const missingFillable = (r: BoardRow) => !teacher && !locked && missingStudent(r);
  const timeTd = (t: string | null, lateBy: number | null) => (
    <td>
      {t ? time12(t) : <span className="muted">–</span>}
      {t && isLate(lateBy) && <span className="tag warn" style={{ marginLeft: 6 }} title="The student typed this time after the fact">+{lateBy} min</span>}
    </td>
  );
  const tag = (ok: boolean, yes: string, no = "–") => <span className={`tag ${ok ? "ok" : ""}`}>{ok ? yes : no}</span>;

  return (
    <>
      {holiday && <p className="msg info">{holiday}: no class today, and no signatures needed.</p>}
      {locked && <p className="msg info">{locked}</p>}
      <p className="lead">
        {rows.length} with class · {counts.started} started · {counts.ended} ended · {counts.studentSigned} signed by student · {counts.staffSigned} signed by teacher
      </p>
      {counts.late > 0 && (
        <p className="msg info">{counts.late} row{counts.late === 1 ? " has a time" : "s have times"} typed {LATE_ENTRY_FLAG_MINUTES}+ minutes after the fact (marked <span className="tag warn">+min</span>). Check before signing.</p>
      )}
      <div className="row no-print" style={{ marginBottom: 12 }}>
        <input className="search" style={{ minHeight: 46, fontSize: 17, maxWidth: 360 }} placeholder="Find a student or course" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a student or course" />
        {teacher && <button className="btn ghost" onClick={() => setPicked(new Set(shown.filter(ready).map((r) => r.id)))}>Select all ready to sign ({shown.filter(ready).length})</button>}
        {!teacher && !holiday && !locked && counts.notStarted > 0 && (isToday ? new Date().getHours() >= 12 : true) && (
          <button className="btn ghost" disabled={pending} onClick={markAbsent}>Mark {counts.notStarted} not started as absent</button>
        )}
      </div>
      <Msg state={msg} />
      <div style={{ overflowX: "auto" }}>
        <table className="tbl">
          <thead><tr>{teacher && <th style={{ width: 40 }}><span className="sr-only">Select</span></th>}<th>Student</th><th>Course</th><th>Start</th><th>End</th><th>Hours</th><th>Student</th><th>Teacher</th></tr></thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.id}>
                {teacher && <td>{ready(r) && <input type="checkbox" className="chk" checked={picked.has(r.id)} onChange={() => toggle(r.id)} aria-label={`Select ${r.name}`} />}</td>}
                <td>{teacher ? <Link href={`/teacher/sheets/${r.id}/${month}`}>{r.name}</Link> : <><Link href={`/admin/students/${r.id}`}>{r.name}</Link> <Link className="small" href={`/admin/sheets/${r.id}/${month}`}>sheet</Link></>}</td>
                <td className="muted">{r.course}</td>
                {r.status && r.status !== "PRESENT"
                  ? <td colSpan={3}><span className="tag no">{r.status.toLowerCase()}</span></td>
                  : <>{timeTd(r.start, r.startLateBy)}{timeTd(r.end, r.endLateBy)}<td>{hoursText(r.minutes)}</td></>}
                <td>
                  {missingFillable(r)
                    ? (r.studentHasSignature
                      ? <button className="fill" style={{ minWidth: 150 }} disabled={pending} onClick={() => fillStudent(r)} aria-label={`Fill student signature for ${r.name}`}>Fill with signature</button>
                      : <Link className="small" href={`${base}/students/${r.id}`}>No signature on file</Link>)
                    : tag(r.studentSigned, "signed")}
                </td>
                <td>
                  {ready(r) && hasSaved
                    ? <button className="fill" style={{ minWidth: 170 }} disabled={pending} onClick={() => fillStaff(r)} aria-label={`Fill staff signature for ${r.name}`}>Fill with my signature</button>
                    : tag(r.staffSigned, "signed")}
                </td>
              </tr>
            ))}
            {shown.length === 0 && <tr><td colSpan={teacher ? 8 : 7} className="muted">{rows.length ? "No match." : "Nobody has class on this day."}</td></tr>}
          </tbody>
        </table>
      </div>

      {picked.size > 0 && (
        <div className="sticky">
          <strong>{picked.size} selected</strong>
          {hasSaved && <button className="btn" disabled={pending} onClick={() => sign()}>Sign {picked.size} with my signature</button>}
          <button className={hasSaved ? "btn ghost" : "btn"} disabled={pending} onClick={() => setHand([...picked])}>Sign {picked.size} by hand</button>
          <button className="btn ghost" onClick={() => setPicked(new Set())}>Clear</button>
        </div>
      )}
      {hand && (
        <InkPad
          kind="signature" title={`Sign ${hand.length} row${hand.length === 1 ? "" : "s"}`} hint="Your signature validates the attendance on these rows." doneLabel="Sign"
          onCancel={() => setHand(null)} onDone={(v) => { setHand(null); if (v) sign(v.png); }}
        />
      )}
    </>
  );
}
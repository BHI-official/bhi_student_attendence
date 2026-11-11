"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ActionState } from "@/lib/action";
import { signMonthsAction } from "@/actions/staff";
import { InkPad } from "./Ink";
import { Msg } from "./forms";

/**
 * The admin's "Approved by" at the bottom of the month: name/position (prefilled from her account),
 * optional comments, then a handwritten signature. Signs one student's month, or many at once.
 */
export function SignOffPanel({ month, monthName, studentIds, defaults, label, onDone }: {
  month: string; monthName: string; studentIds: string[]; defaults: { name: string; position: string };
  label?: string; onDone?: () => void;
}) {
  const router = useRouter();
  const { name, position } = defaults;
  const [comments, setComments] = useState("");
  const [pad, setPad] = useState(false);
  const [msg, setMsg] = useState<ActionState>({});
  const [pending, start] = useTransition();
  const n = studentIds.length;
  return (
    <div className="signoff">
      <p className="signer" id={`so-name-${month}`}>Approved by: <b>{name}{position ? ` / ${position}` : ""}</b></p>
      <div className="field"><label htmlFor={`so-c-${month}`}>Comments (optional)</label><input id={`so-c-${month}`} value={comments} onChange={(e) => setComments(e.target.value)} maxLength={600} /></div>
      <button type="button" className="btn" disabled={pending || !n} onClick={() => setPad(true)}>
        {pending ? "Signing…" : label ?? `Sign off ${monthName} for ${n} student${n === 1 ? "" : "s"}`}
      </button>
      <Msg state={msg} />
      {pad && (
        <InkPad kind="signature" title={`Approved by ${name}: ${monthName}${n > 1 ? `, ${n} students` : ""}`}
          hint="Your handwritten signature goes in the “Approved by” section at the bottom of each sheet."
          doneLabel="Sign off" onCancel={() => setPad(false)}
          onDone={(v) => {
            setPad(false);
            if (!v) return;
            start(async () => {
              const fd = new FormData();
              fd.set("month", month); fd.set("students", JSON.stringify(studentIds)); fd.set("signature", v.png);
              fd.set("comments", comments);
              const r = await signMonthsAction({}, fd);
              setMsg(r);
              if (r.ok) { onDone?.(); router.refresh(); }
            });
          }} />
      )}
    </div>
  );
}

export type SignOffRow = {
  id: string; name: string; program: string; teacher: string;
  approved: number; waiting: number; missing: number; absent: number; excused: number;
  signedBy: string | null; signedAt: string | null; current: boolean;
  /** Signed by someone who isn't the "Approved by" signer: needs the signer's signature. */
  byOther: boolean;
  /** The month (or the student's course) isn't over yet, so it can't be signed off. */
  notOver: boolean;
};

/** The month's list: tick students who are ready, then sign once. */
export function SignOffList({ rows, month, monthName, defaults, canSign }: { rows: SignOffRow[]; month: string; monthName: string; defaults: { name: string; position: string }; canSign: boolean }) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const ready = rows.filter((r) => !r.waiting && !r.notOver && (!r.signedBy || !r.current || r.byOther) && r.approved + r.absent + r.excused > 0);
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  return (
    <>
      <div className="row" style={{ alignItems: "center", marginBottom: 10 }}>
        <button type="button" className="btn ghost sm" onClick={() => setPicked(new Set(ready.map((r) => r.id)))} disabled={!canSign || !ready.length}>Tick all ready ({ready.length})</button>
        <button type="button" className="linkbtn" onClick={() => setPicked(new Set())} disabled={!picked.size}>Clear</button>
      </div>
      <div className="tablewrap">
        <table className="tbl">
          <thead><tr><th className="pick"><span className="sr-only">Tick</span></th><th>Student</th><th>Teacher</th><th>Signed by teacher</th><th>Waiting for teacher</th><th>Missing</th><th>Absent / excused</th><th>Approved by (admin)</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className={picked.has(r.id) ? "picked" : ""}>
                <td className="pick"><input type="checkbox" className="chk" checked={picked.has(r.id)} onChange={() => toggle(r.id)} disabled={!canSign || r.waiting > 0 || r.notOver} aria-label={`Tick ${r.name}`} /></td>
                <td><a href={`/admin/students/${r.id}?month=${month}#records`}><strong>{r.name}</strong></a><span className="small muted block">{r.program}</span></td>
                <td className="small">{r.teacher || <em>no teacher</em>}</td>
                <td>{r.approved}</td>
                <td>{r.waiting ? <span className="chip s-pending">{r.waiting} waiting</span> : <span className="muted">0</span>}</td>
                <td>{r.missing ? <span className="chip s-missing">{r.missing}</span> : <span className="muted">0</span>}</td>
                <td>{r.absent} / {r.excused}</td>
                <td>{r.notOver && !r.signedBy ? <span className="small muted">After the month ends</span> : r.signedBy ? <><span className={`chip ${r.current && !r.byOther ? "s-approved" : "s-needs_correction"}`}>{r.byOther ? "Needs your signature" : r.current ? "Signed" : "Changed since"}</span><span className="small muted block">{r.signedBy}, {r.signedAt}</span></> : <span className="muted">Not yet</span>}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={8} className="muted">No students had class this month.</td></tr>}
          </tbody>
        </table>
      </div>
      {canSign && (
        <div className="bulk on signoff-bar">
          <SignOffPanel month={month} monthName={monthName} studentIds={[...picked]} defaults={defaults} onDone={() => setPicked(new Set())} />
        </div>
      )}
    </>
  );
}

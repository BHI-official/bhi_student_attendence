"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ActionState } from "@/lib/action";
import type { RosterRow } from "@/lib/roster";
import { STATUS_LABEL, type DayStatus } from "@/lib/week";
import { WEEKDAY_NAMES, usDate, weekday } from "@/lib/sheet";
import { approveRowsAction, decideExcuseAction, markRowsAction, rejectRowAction } from "@/actions/staff";
import { InkPad } from "./Ink";
import { HandTimes } from "./HandTimes";
import { TakeAttendance } from "./TakeAttendance";
import { Msg } from "./forms";

type Filter = "action" | "all" | "MISSING" | "PENDING" | "NEEDS_CORRECTION" | "EXCUSE" | "APPROVED" | "ABSENT" | "LATE";

const needsAction = (r: RosterRow) => r.status === "PENDING" || r.excuse?.status === "PENDING" || (r.status === "MISSING" && !r.locked);
const FILTERS: [Filter, string, (r: RosterRow) => boolean][] = [
  ["action", "Needs action", needsAction],
  ["MISSING", "Missing signature", (r) => r.status === "MISSING"],
  ["PENDING", "Pending", (r) => r.status === "PENDING"],
  ["EXCUSE", "Excuses to review", (r) => r.excuse?.status === "PENDING"],
  ["NEEDS_CORRECTION", "Needs correction", (r) => r.status === "NEEDS_CORRECTION"],
  ["LATE", "Submitted late", (r) => r.late],
  ["APPROVED", "Approved", (r) => r.status === "APPROVED"],
  ["ABSENT", "Absent", (r) => r.status === "ABSENT"],
  ["all", "Everyone", () => true],
];

export function StatusChip({ status, mark }: { status: DayStatus; mark?: RosterRow["mark"] }) {
  const text = status === "MISSING" && mark === "PRESENT" ? "Present · signature missing" : STATUS_LABEL[status];
  return <span className={`chip s-${status.toLowerCase()}`}>{text}</span>;
}

/** One student's day as handwriting: times and signature, the way the paper sheet shows it. */
function Ink({ id, alt, h = 34 }: { id: string | null; alt: string; h?: number }) {
  // eslint-disable-next-line @next/next/no-img-element
  return id ? <img className="inkimg" src={`/api/ink/${id}`} alt={alt} height={h} loading="lazy" /> : null;
}

export function Roster({ rows, isAdmin, programs, grouped, takeDate }: { rows: RosterRow[]; isAdmin: boolean; programs: string[]; grouped: boolean; takeDate?: string | null }) {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("action");
  const [program, setProgram] = useState("");
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [signFor, setSignFor] = useState<string[] | null>(null);
  const [open, setOpen] = useState<{ key: string; kind: "reject" | "excuse" } | null>(null);
  const [msg, setMsg] = useState<ActionState>({});
  const [pending, start] = useTransition();

  const base = useMemo(() => {
    const t = q.trim().toLowerCase();
    return rows.filter((r) => (!program || r.program === program) && (!t || r.name.toLowerCase().includes(t)));
  }, [rows, program, q]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map(([k, , f]) => [k, base.filter(f).length])) as Record<Filter, number>, [base]);
  const shown = useMemo(() => base.filter(FILTERS.find(([k]) => k === filter)![2]), [base, filter]);
  const byKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows]);
  const chosen = [...picked].map((k) => byKey.get(k)).filter((r): r is RosterRow => !!r);
  const approvable = isAdmin ? [] : chosen.filter((r) => r.status === "PENDING" && !r.signedOffBy);
  const markable = chosen.filter((r) => !r.locked && (r.status === "MISSING" || r.status === "PENDING" || r.status === "ABSENT" || r.status === "NEEDS_CORRECTION"));

  const run = (act: (prev: ActionState, fd: FormData) => Promise<ActionState>, data: Record<string, string>, after?: () => void) =>
    start(async () => {
      const fd = new FormData();
      for (const [k, v] of Object.entries(data)) fd.set(k, v);
      const r = await act({}, fd);
      setMsg(r);
      if (r.ok) { after?.(); router.refresh(); }
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  const toggle = (k: string) => setPicked((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const allShownPicked = shown.length > 0 && shown.every((r) => picked.has(r.key));

  // Group the visible rows by day (week view), keeping the name order inside each day.
  const groups: [string, RosterRow[]][] = [];
  for (const r of shown) {
    const g = groups[groups.length - 1];
    if (g && g[0] === r.date) g[1].push(r); else groups.push([r.date, [r]]);
  }

  const waitingAll = rows.filter((r) => r.status === "PENDING" && !r.signedOffBy);
  return (
    <div className="roster">
      {takeDate && !isAdmin && <TakeAttendance key={takeDate} date={takeDate} rows={rows} />}
      {takeDate && !isAdmin && <h2 className="details-h">Details</h2>}
      <Msg state={msg} />
      <div className="filters" role="group" aria-label="Show">
        {FILTERS.map(([k, label]) => (
          <button key={k} type="button" className="filter" aria-pressed={filter === k} onClick={() => setFilter(k)}>
            {label} <b>{counts[k]}</b>
          </button>
        ))}
      </div>
      <div className="row tools">
        {programs.length > 1 && (
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="r-program">Program</label>
            <select id="r-program" value={program} onChange={(e) => setProgram(e.target.value)}>
              <option value="">All programs</option>{programs.map((p) => <option key={p}>{p}</option>)}
            </select>
          </div>
        )}
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="r-q">Find a student</label>
          <input id="r-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name" autoComplete="off" />
        </div>
      </div>

      <div className={`bulk${picked.size ? " on" : ""}`} aria-live="polite">
        <span><b>{picked.size}</b> selected</span>
        {!isAdmin && (
          <button type="button" className="btn" disabled={pending || !approvable.length} onClick={() => setSignFor(approvable.map((r) => r.key))}>
            Approve &amp; sign{approvable.length ? ` (${approvable.length})` : ""}
          </button>
        )}
        <button type="button" className="btn ghost" disabled={pending || !markable.length} onClick={() => run(markRowsAction, { rows: JSON.stringify(markable.map((r) => r.key)), mark: "PRESENT" }, () => setPicked(new Set()))}>Mark present</button>
        <button type="button" className="btn ghost" disabled={pending || !markable.length} onClick={() => run(markRowsAction, { rows: JSON.stringify(markable.map((r) => r.key)), mark: "ABSENT" }, () => setPicked(new Set()))}>Mark absent</button>
        {!isAdmin && waitingAll.length > 0 && (
          <button type="button" className="btn ghost" onClick={() => setPicked(new Set(waitingAll.map((r) => r.key)))}>Select all waiting for my signature ({waitingAll.length})</button>
        )}
        <button type="button" className="linkbtn" onClick={() => setPicked(new Set())} disabled={!picked.size}>Clear</button>
      </div>

      {shown.length === 0 ? (
        <p className="empty">{filter === "action" ? "Nothing needs your attention here. Switch to Everyone to see all students." : "No students in this list."}</p>
      ) : (
        <div className="tablewrap">
          <table className="tbl roster-tbl">
            <thead>
              <tr>
                <th className="pick"><input type="checkbox" className="chk" aria-label="Select everyone shown" checked={allShownPicked}
                  onChange={() => setPicked(allShownPicked ? new Set() : new Set(shown.map((r) => r.key)))} /></th>
                <th>Student</th>{!grouped && <th>Date</th>}<th>Times (written by the student)</th><th>Student signature</th><th>Status &amp; teacher signature</th><th>Actions</th>
              </tr>
            </thead>
            {groups.map(([date, list]) => (
              <tbody key={date}>
                {grouped && <tr className="dayhead"><th colSpan={6}>{WEEKDAY_NAMES[weekday(date)]}, {usDate(date)}</th></tr>}
                {list.map((r) => (
                  <RowView key={r.key} r={r} grouped={grouped} isAdmin={isAdmin} picked={picked.has(r.key)} onPick={() => toggle(r.key)} pending={pending}
                    open={open?.key === r.key ? open.kind : null} setOpen={(k) => setOpen(k ? { key: r.key, kind: k } : null)}
                    onApprove={() => setSignFor([r.key])}
                    onMark={(mark) => run(markRowsAction, { rows: JSON.stringify([r.key]), mark })}
                    onReject={(reason) => run(rejectRowAction.bind(null, r.key), { reason }, () => setOpen(null))}
                    onExcuse={(decision, reason) => run(decideExcuseAction.bind(null, r.key), { decision, reason }, () => setOpen(null))} />
                ))}
              </tbody>
            ))}
          </table>
        </div>
      )}

      {signFor && (
        <InkPad kind="signature"
          title={signFor.length === 1 ? `Sign to approve ${byKey.get(signFor[0])?.name ?? ""}, ${usDate(byKey.get(signFor[0])?.date ?? "")}` : `Sign to approve ${signFor.length} days`}
          hint="Check the student’s times and signature first. Your handwritten signature goes on each day you approve, in the teacher signature column."
          doneLabel="Approve and sign"
          onCancel={() => setSignFor(null)}
          onDone={(v) => {
            const keys = signFor;
            setSignFor(null);
            if (v) run(approveRowsAction, { rows: JSON.stringify(keys), signature: v.png }, () => setPicked(new Set()));
          }} />
      )}
    </div>
  );
}

function RowView({ r, grouped, isAdmin, picked, onPick, pending, open, setOpen, onApprove, onMark, onReject, onExcuse }: {
  r: RosterRow; grouped: boolean; isAdmin: boolean; picked: boolean; onPick: () => void; pending: boolean;
  open: "reject" | "excuse" | null; setOpen: (k: "reject" | "excuse" | null) => void;
  onApprove: () => void; onMark: (m: "PRESENT" | "ABSENT") => void; onReject: (reason: string) => void;
  onExcuse: (d: "APPROVED" | "REJECTED", reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const canMark = !r.locked && ["MISSING", "PENDING", "ABSENT", "NEEDS_CORRECTION"].includes(r.status);
  const canReject = (r.status === "PENDING") || (isAdmin && r.status === "APPROVED");
  const excuseUrl = r.excuse ? `/api/excuse/${encodeURIComponent(r.excuse.entryKey)}` : "";
  const highlight = r.status === "MISSING" ? " missing" : r.status === "PENDING" ? " pending" : "";
  return (
    <>
      <tr className={`rrow${highlight}${picked ? " picked" : ""}`}>
        <td className="pick"><input type="checkbox" className="chk" checked={picked} onChange={onPick} aria-label={`Select ${r.name}, ${usDate(r.date)}`} disabled={r.status === "HOLIDAY"} /></td>
        <td className="who">
          <strong>{isAdmin ? <Link href={`/admin/students/${r.studentId}`}>{r.name}</Link> : r.name}</strong>
          <span className="small muted">{r.program}{isAdmin && <> · {r.teacherName || <em>no teacher</em>}</>}</span>
        </td>
        {!grouped && <td className="nowrap">{usDate(r.date)}</td>}
        <td className="hours">{r.times.length ? <HandTimes times={r.times} /> : <span className="muted">—</span>}</td>
        <td className="sigcell">
          {r.sig ? <Ink id={r.sig} alt={`Signature of ${r.name}`} h={38} /> : r.status === "HOLIDAY" || r.status === "EXCUSED" || r.status === "ABSENT" ? <span className="muted">—</span> : <span className="nosig">No signature</span>}
        </td>
        <td>
          <StatusChip status={r.status} mark={r.mark} />
          {r.late && <span className="tag warn">submitted late</span>}
          {r.approvedBy && <span className="small muted block">signed by {r.approvedBy}</span>}
          {r.approvedSig && <Ink id={r.approvedSig} alt={`Signature of ${r.approvedBy}`} h={28} />}
          {r.signedOffBy && <span className="small muted block">Month signed off by {r.signedOffBy}</span>}
          {r.correction && r.status === "NEEDS_CORRECTION" && <span className="small block">“{r.correction}”</span>}
          {r.mark === "ABSENT" && r.status === "ABSENT" && r.markedByName && <span className="small muted block">marked by {r.markedByName}</span>}
          {r.excuse && <span className={`small block excuse-${r.excuse.status.toLowerCase()}`}>Excuse {r.excuse.status.toLowerCase()}</span>}
          {r.note && <span className="small block note">Student: “{r.note}”</span>}
        </td>
        <td className="acts">
          {!isAdmin && r.status === "PENDING" && !r.locked?.startsWith("Signed off") && <button type="button" className="btn sm" disabled={pending} onClick={onApprove}>Check &amp; sign</button>}
          {canReject && !r.locked?.startsWith("Signed off") && <button type="button" className="btn sm ghost" disabled={pending} onClick={() => setOpen(open === "reject" ? null : "reject")}>Send back</button>}
          {r.excuse?.status === "PENDING" || (isAdmin && r.excuse) ? <button type="button" className="btn sm ghost" onClick={() => setOpen(open === "excuse" ? null : "excuse")}>Review excuse</button> : null}
          {canMark && r.mark !== "PRESENT" && r.status !== "PENDING" && <button type="button" className="btn sm ghost" disabled={pending} onClick={() => onMark("PRESENT")}>Present</button>}
          {canMark && r.status !== "ABSENT" && <button type="button" className="btn sm ghost" disabled={pending} onClick={() => onMark("ABSENT")}>Absent</button>}
          {isAdmin && <Link className="btn sm ghost" href={`/admin/students/${r.studentId}?day=${r.date}#edit`}>Edit</Link>}
          {r.locked && !isAdmin && (r.status === "MISSING" || r.signedOffBy) && <span className="small muted">Locked</span>}
        </td>
      </tr>
      {open && (
        <tr className="rowpanel">
          <td colSpan={grouped ? 6 : 7}>
            {open === "reject" ? (
              <form className="inline-form" onSubmit={(e) => { e.preventDefault(); onReject(reason); }}>
                <label htmlFor={`why-${r.key}`}>What should {r.name.split(" ")[0]} fix? They see this and submit the day again.</label>
                <div className="row">
                  <input id={`why-${r.key}`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. End time should be 2:00 pm" required minLength={3} autoFocus />
                  <button className="btn" disabled={pending}>Send back</button>
                  <button type="button" className="btn ghost" onClick={() => setOpen(null)}>Cancel</button>
                </div>
              </form>
            ) : r.excuse && (
              <div className="excuse-review">
                <p style={{ margin: "0 0 8px" }}>
                  <a className="btn ghost sm" href={excuseUrl} target="_blank" rel="noreferrer">Open {r.excuse.fileName}</a>{" "}
                  {r.excuse.note ? <>Student wrote: “{r.excuse.note}”</> : <span className="muted">No explanation added.</span>}
                </p>
                {r.excuse.status !== "PENDING" && <p className="small">Currently <b>{r.excuse.status.toLowerCase()}</b>{r.excuse.reason ? `: ${r.excuse.reason}` : ""}.</p>}
                <form className="row" onSubmit={(e) => e.preventDefault()}>
                  <input aria-label="Reason (needed to reject)" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (needed to reject)" />
                  <button type="button" className="btn" disabled={pending} onClick={() => onExcuse("APPROVED", reason)}>Approve excuse</button>
                  <button type="button" className="btn ghost" disabled={pending} onClick={() => onExcuse("REJECTED", reason)}>Reject excuse</button>
                  <button type="button" className="btn ghost" onClick={() => setOpen(null)}>Close</button>
                </form>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

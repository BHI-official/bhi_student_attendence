"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ActionState } from "@/lib/action";
import type { RosterRow } from "@/lib/roster";
import { usDate } from "@/lib/sheet";
import { takeAttendanceAction } from "@/actions/staff";
import { InkPad } from "./Ink";
import { Msg } from "./forms";

/**
 * Take attendance for a whole day: tap who was absent, then sign once. Everyone else is present;
 * those who have signed are approved with that one signature.
 */
export function TakeAttendance({ date, rows: allRows }: { date: string; rows: RosterRow[] }) {
  // A teacher with more than one program/class can take each one separately.
  const programs = useMemo(() => [...new Set(allRows.map((r) => r.program).filter(Boolean))].sort(), [allRows]);
  const [program, setProgram] = useState("");
  const rows = program ? allRows.filter((r) => r.program === program) : allRows;
  const router = useRouter();
  const fixed = (r: RosterRow) => r.status === "APPROVED" || r.status === "EXCUSED" || r.status === "HOLIDAY" || !!r.signedOffBy;
  const [absent, setAbsent] = useState<Set<string>>(() => new Set(rows.filter((r) => r.status === "ABSENT").map((r) => r.key)));
  const [pad, setPad] = useState(false);
  const [msg, setMsg] = useState<ActionState>({});
  const [pending, start] = useTransition();
  const [q, setQ] = useState("");
  // After saving, the page reloads its data: show what was saved (who is absent now), keep the message.
  const saved = allRows.filter((r) => r.status === "ABSENT").map((r) => r.key).join();
  useEffect(() => { setAbsent(new Set(saved ? saved.split(",") : [])); }, [saved]);

  const c = useMemo(() => {
    const open = rows.filter((r) => !fixed(r));
    const present = open.filter((r) => !absent.has(r.key));
    return {
      absent: open.filter((r) => absent.has(r.key)).length,
      toApprove: present.filter((r) => r.status === "PENDING" || (r.status === "ABSENT" && !!r.sig && !r.correction)).length,
      notSigned: present.filter((r) => r.status === "MISSING" || (r.status === "ABSENT" && !r.sig)).length,
      sentBack: present.filter((r) => r.status === "NEEDS_CORRECTION").length,
      done: rows.filter((r) => r.status === "APPROVED").length,
    };
  }, [rows, absent, program]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (k: string) => setAbsent((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const shown = q.trim() ? rows.filter((r) => r.name.toLowerCase().includes(q.trim().toLowerCase())) : rows;
  const label = (r: RosterRow) =>
    r.status === "APPROVED" ? "approved ✓" : r.status === "EXCUSED" ? "excused" : r.status === "HOLIDAY" ? "holiday"
      : r.signedOffBy ? "month signed off" : absent.has(r.key) ? "absent" : r.status === "NEEDS_CORRECTION" ? "sent back"
      : r.sig ? "signed" : "not signed yet";

  return (
    <section className="take" aria-labelledby="take-h">
      <h2 id="take-h">Take attendance: {usDate(date)}</h2>
      <p className="small" style={{ marginTop: 0 }}>Tap everyone who was <b>absent</b>. Everyone else counts as present. Then sign once to save the whole {program ? "class" : "day"}.</p>
      {programs.length > 1 && (
        <div className="seg take-programs" role="group" aria-label="Program / class">
          <button type="button" aria-pressed={!program} onClick={() => setProgram("")}>All ({allRows.length})</button>
          {programs.map((p) => (
            <button key={p} type="button" aria-pressed={program === p} onClick={() => setProgram(p)}>{p} ({allRows.filter((r) => r.program === p).length})</button>
          ))}
        </div>
      )}
      {rows.length > 12 && <input className="take-find" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a student" aria-label="Find a student" autoComplete="off" />}
      <div className="take-grid" role="group" aria-label="Students: tap the absent ones">
        {shown.map((r) => (
          <button key={r.key} type="button" className={`take-btn${absent.has(r.key) ? " is-absent" : ""}${fixed(r) ? " is-fixed" : ""}${!r.sig && !fixed(r) && !absent.has(r.key) ? " no-sig" : ""}`}
            aria-pressed={absent.has(r.key)} disabled={fixed(r) || pending} onClick={() => toggle(r.key)}>
            <span className="tb-name">{r.name}</span>
            <span className="tb-state">{label(r)}</span>
          </button>
        ))}
      </div>
      <div className="take-bar">
        <p className="take-sum">
          <b>{c.toApprove}</b> to approve · <b>{c.absent}</b> absent
          {c.notSigned > 0 && <> · <b>{c.notSigned}</b> present but not signed yet</>}
          {c.sentBack > 0 && <> · <b>{c.sentBack}</b> sent back</>}
          {c.done > 0 && <> · {c.done} already approved</>}
        </p>
        <button type="button" className="btn big" disabled={pending || c.toApprove + c.absent + c.notSigned === 0} onClick={() => setPad(true)}>
          {pending ? "Saving…" : `Sign once and save${c.toApprove ? ` (approve ${c.toApprove})` : ""}`}
        </button>
      </div>
      <Msg state={msg} />
      {pad && (
        <InkPad kind="signature" title={`Sign for ${usDate(date)}${program ? `, ${program}` : ""}: approve ${c.toApprove}, ${c.absent} absent`}
          hint="Your handwritten signature goes in the teacher signature column of every student you approve."
          doneLabel="Sign and save" onCancel={() => setPad(false)}
          onDone={(v) => {
            setPad(false);
            if (!v) return;
            start(async () => {
              const fd = new FormData();
              fd.set("date", date); fd.set("absent", JSON.stringify([...absent].filter((k) => rows.some((r) => r.key === k)))); fd.set("signature", v.png);
              if (program) fd.set("program", program);
              const r = await takeAttendanceAction({}, fd);
              setMsg(r);
              if (r.ok) router.refresh();
            });
          }} />
      )}
    </section>
  );
}

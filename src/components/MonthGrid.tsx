import Link from "next/link";
import type { RosterRow } from "@/lib/roster";
import { STATUS_LABEL, type DayStatus } from "@/lib/week";
import { WEEKDAY_NAMES, usDate, weekday } from "@/lib/sheet";

const MARK: Record<DayStatus, string> = { APPROVED: "✓", PENDING: "P", NEEDS_CORRECTION: "C", MISSING: "M", ABSENT: "A", EXCUSED: "E", HOLIDAY: "H", UPCOMING: "" };

/**
 * A month at a glance: one row per student, one column per class day. Each cell is that day's
 * status; clicking it opens the day (to sign, mark or review). Totals on the right.
 */
export function MonthGrid({ rows, dates, dayHref, isAdmin }: { rows: RosterRow[]; dates: string[]; dayHref: (date: string) => string; isAdmin: boolean }) {
  const students = new Map<string, { id: string; name: string; program: string; teacher: string; days: Map<string, RosterRow> }>();
  for (const r of rows) {
    const s = students.get(r.studentId) ?? { id: r.studentId, name: r.name, program: r.program, teacher: r.teacherName, days: new Map() };
    s.days.set(r.date, r);
    students.set(r.studentId, s);
  }
  const list = [...students.values()].sort((a, b) => a.name.localeCompare(b.name));
  const count = (s: (typeof list)[number], k: DayStatus[]) => [...s.days.values()].filter((r) => k.includes(r.status)).length;
  return (
    <>
      <p className="legend small">
        {(["APPROVED", "PENDING", "MISSING", "NEEDS_CORRECTION", "ABSENT", "EXCUSED", "HOLIDAY"] as DayStatus[]).map((k) => (
          <span key={k}><span className={`mcell s-${k.toLowerCase()}`}>{MARK[k]}</span> {STATUS_LABEL[k]}</span>
        ))}
        <span>Click a day to open it.</span>
      </p>
      <div className="tablewrap">
        <table className="tbl monthgrid">
          <thead>
            <tr>
              <th className="mg-name">Student</th>
              {dates.map((d) => <th key={d} className="mg-day"><Link href={dayHref(d)}>{WEEKDAY_NAMES[weekday(d)].slice(0, 2)}<br />{d.slice(8)}</Link></th>)}
              <th title="Approved">✓</th><th title="Waiting for the teacher">P</th><th title="Missing">M</th><th title="Absent">A</th><th title="Excused">E</th>
            </tr>
          </thead>
          <tbody>
            {list.map((s) => (
              <tr key={s.id}>
                <td className="mg-name">
                  {isAdmin ? <Link href={`/admin/students/${s.id}`}><strong>{s.name}</strong></Link> : <strong>{s.name}</strong>}
                  <span className="small muted block">{s.program}{isAdmin && s.teacher ? ` · ${s.teacher}` : ""}</span>
                </td>
                {dates.map((d) => {
                  const r = s.days.get(d);
                  if (!r) return <td key={d} className="mg-cell"><span className="mcell s-none" title="No class">·</span></td>;
                  const title = `${r.name}, ${WEEKDAY_NAMES[weekday(d)]} ${usDate(d)}: ${STATUS_LABEL[r.status]}${r.approvedBy ? ` (signed by ${r.approvedBy})` : ""}${r.excuse ? `, excuse ${r.excuse.status.toLowerCase()}` : ""}`;
                  return (
                    <td key={d} className="mg-cell">
                      <Link href={dayHref(d)} className={`mcell s-${r.status.toLowerCase()}${r.excuse?.status === "PENDING" ? " has-excuse" : ""}`} title={title} aria-label={title}>{MARK[r.status]}</Link>
                    </td>
                  );
                })}
                <td className="mg-sum">{count(s, ["APPROVED"])}</td>
                <td className="mg-sum">{count(s, ["PENDING", "NEEDS_CORRECTION"])}</td>
                <td className="mg-sum">{count(s, ["MISSING"])}</td>
                <td className="mg-sum">{count(s, ["ABSENT"])}</td>
                <td className="mg-sum">{count(s, ["EXCUSED"])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

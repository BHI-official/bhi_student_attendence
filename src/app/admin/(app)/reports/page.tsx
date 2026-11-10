import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { studentScope } from "@/lib/access";
import { courseNames, thisMonth } from "@/lib/data";
import { thresholds } from "@/lib/policy";
import { MONTH_RE, hoursText, monthTitle, shiftMonth } from "@/lib/sheet";
import { classMonth } from "@/lib/classreport";

export const dynamic = "force-dynamic";
export const metadata = { title: "Reports" };

export default async function Reports({ searchParams }: { searchParams: Promise<{ month?: string; course?: string }> }) {
  const staff = await requireAdmin();
  const sp = await searchParams;
  const now = thisMonth();
  const month = MONTH_RE.test(sp.month ?? "") && sp.month! <= now ? sp.month! : now;
  const courses = await courseNames(studentScope(staff));
  const course = courses.includes(sp.course ?? "") ? sp.course! : "";
  const rows = await classMonth(studentScope(staff), month, course || undefined);
  const t = thresholds();
  const qs = new URLSearchParams({ month, ...(course ? { course } : {}) }).toString();
  const months = Array.from({ length: 12 }, (_, i) => shiftMonth(now, -i));
  const counts = { good: 0, attention: 0, poor: 0, none: 0 };
  rows.forEach((r) => counts[r.summary.level]++);
  return (
    <main className="wrap">
      <h1>Monthly attendance report</h1>
      <p className="lead">Every student with class days in the month, with their attendance and hours. Open a name for the full profile.</p>
      <form className="row no-print" style={{ margin: "8px 0 18px" }}>
        <div className="field" style={{ margin: 0 }}><label htmlFor="m">Month</label>
          <select id="m" name="month" defaultValue={month}>{months.map((m) => <option key={m} value={m}>{monthTitle(m)}</option>)}</select>
        </div>
        <div className="field" style={{ margin: 0 }}><label htmlFor="c">Class</label>
          <select id="c" name="course" defaultValue={course}><option value="">All my classes</option>{courses.map((c) => <option key={c}>{c}</option>)}</select>
        </div>
        <button className="btn ghost">Show</button>
        <a className="btn" href={`/api/reports/class?${qs}&type=summary`}>Download report (PDF)</a>
        <a className="btn ghost" href={`/api/reports/class?${qs}&type=sheets`}>All sheets for the month (PDF)</a>
      </form>
      <p className="row small">
        <span className="level good">{counts.good} good</span>
        <span className="level attention">{counts.attention} need attention</span>
        <span className="level poor">{counts.poor} poor</span>
        {counts.none > 0 && <span className="level none">{counts.none} nothing yet</span>}
      </p>
      <div style={{ overflowX: "auto" }}>
        <table className="tbl">
          <thead><tr><th>Student</th><th>Class</th><th>Status</th><th>Attendance</th><th>Present</th><th>Absent</th><th>Excused</th><th>Hours</th><th>Approved</th><th></th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><Link href={`/admin/students/${r.id}`}>{r.name}</Link></td>
                <td className="muted">{r.course}</td>
                <td>{r.status}</td>
                <td><span className={`level ${r.summary.level}`}>{r.summary.rate === null ? "—" : `${r.summary.rate}%`}</span></td>
                <td>{r.summary.present}</td>
                <td>{r.summary.absent + r.summary.missing}</td>
                <td>{r.summary.excused}</td>
                <td>{hoursText(r.summary.minutes) || "0"}</td>
                <td>{r.approved === "current" ? <span className="tag ok">yes</span> : r.approved === "outdated" ? <span className="tag warn">changed since</span> : <span className="muted">–</span>}</td>
                <td className="small"><Link href={`/admin/sheets/${r.id}/${month}`}>Sheet</Link> · <a href={`/api/report/${r.id}?month=${month}&format=pdf`}>PDF</a></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={10} className="muted">Nobody had class days in {monthTitle(month)}.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="small muted">Green at {t.goodPercent}% or more, orange from {t.attentionPercent}%, red below. Absent includes class days with nothing recorded.</p>
    </main>
  );
}

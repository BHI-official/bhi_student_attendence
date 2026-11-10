import Link from "next/link";
import { requireTeacher } from "@/lib/auth";
import { thisMonth } from "@/lib/data";
import { MONTH_RE, monthTitle, shiftMonth, usDate } from "@/lib/sheet";
import { APPROVAL_WORDS, reviewMonth } from "@/lib/teacher";

export const dynamic = "force-dynamic";
export const metadata = { title: "Students" };

/** The students enrolled in the teacher's courses for a month, with each sheet's review status. */
export default async function TeacherStudents({ searchParams }: { searchParams: Promise<{ course?: string; month?: string }> }) {
  const staff = await requireTeacher();
  const sp = await searchParams;
  const now = thisMonth();
  const month = MONTH_RE.test(sp.month ?? "") && sp.month! <= now ? sp.month! : now;
  const courses = [...staff.courses].sort();
  const course = courses.includes(sp.course ?? "") ? sp.course : undefined;
  const rows = await reviewMonth(staff, month, course);
  const qs = (m: string) => `?${new URLSearchParams({ ...(course ? { course } : {}), month: m })}`;
  const back = encodeURIComponent(`/teacher/students${qs(month)}`);
  const classReport = (type: "summary" | "sheets") => `/api/reports/class?${new URLSearchParams({ month, type, ...(course ? { course } : {}) })}`;
  return (
    <main className="wrap">
      <h1>{course ?? "All my courses"}</h1>
      <p className="lead">Students enrolled in {monthTitle(month)}. Open a sheet to sign the staff signature on each row and add comments. The admin approves the month.</p>
      <form className="row no-print" style={{ margin: "8px 0 18px" }}>
        <div className="field" style={{ margin: 0 }}><label htmlFor="c">Course</label>
          <select id="c" name="course" defaultValue={course ?? ""}><option value="">All my courses</option>{courses.map((c) => <option key={c}>{c}</option>)}</select>
        </div>
        <div className="field" style={{ margin: 0 }}><label htmlFor="m">Month</label><input id="m" type="month" name="month" defaultValue={month} max={now} /></div>
        <button className="btn ghost">Show</button>
        <span className="row" style={{ marginLeft: "auto" }}>
          <Link className="btn ghost" href={qs(shiftMonth(month, -1))}>‹ {monthTitle(shiftMonth(month, -1)).split(" ")[0]}</Link>
          {month < now && <Link className="btn ghost" href={qs(shiftMonth(month, 1))}>{monthTitle(shiftMonth(month, 1)).split(" ")[0]} ›</Link>}
        </span>
      </form>
      <div style={{ overflowX: "auto" }}>
        <table className="tbl">
          <thead><tr><th>Student</th>{!course && <th>Course</th>}<th>Status</th><th>Days present</th><th>Rows to sign</th><th>Filled in later</th><th>Month approval</th><th>Sheet</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td><Link href={`/teacher/sheets/${r.id}/${month}?back=${back}`}><strong>{r.name}</strong></Link><div className="small muted">{usDate(r.startDate)} – {usDate(r.endDate)}</div></td>
                {!course && <td className="muted">{r.course}</td>}
                <td><span className={`tag ${r.state === "Active" ? "ok" : ""}`}>{r.state}</span></td>
                <td>{r.present} <span className="muted small">of {r.recorded} recorded</span></td>
                <td>{r.toSign ? <span className="tag warn">{r.toSign}</span> : <span className="muted">0</span>}</td>
                <td>{r.filledLater ? <span className="tag warn" title="Filled in by the student after the day, not yet signed">{r.filledLater}</span> : <span className="muted">0</span>}</td>
                <td><span className={`tag ${r.approval === "approved" ? "ok" : r.approval === "outdated" ? "warn" : ""}`}>{APPROVAL_WORDS[r.approval]}</span>
                  {r.approver && <div className="small muted">{r.approver}</div>}</td>
                <td className="small"><Link href={`/teacher/sheets/${r.id}/${month}?back=${back}`}>Review</Link> · <a href={`/api/report/${r.id}?month=${month}&format=pdf`}>PDF</a></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={8} className="muted">{courses.length ? `No students enrolled in ${monthTitle(month)}.` : "No courses are assigned to you yet. Ask an admin."}</td></tr>}
          </tbody>
        </table>
      </div>
      {rows.length > 0 && (
        <p className="row small no-print" style={{ marginTop: 14 }}>
          <a href={classReport("summary")}>Download the month&apos;s class report (PDF)</a>
          <a href={classReport("sheets")}>Download every sheet for the month (PDF)</a>
        </p>
      )}
    </main>
  );
}

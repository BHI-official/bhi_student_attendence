import Link from "next/link";
import { cols } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { studentScope } from "@/lib/access";
import { courseNames, today } from "@/lib/data";
import { LEVEL_WORDS, enrollmentState, usDate } from "@/lib/sheet";
import { summaries } from "@/lib/summary";
import { importStudentsAction, saveStudentAction } from "@/actions/admin";
import { ImportForm, StudentForm } from "./StudentForms";

export const dynamic = "force-dynamic";
export const metadata = { title: "Students" };

export default async function Students({ searchParams }: { searchParams: Promise<{ q?: string; all?: string }> }) {
  const staff = await requireAdmin();
  const sp = await searchParams;
  const q = (sp.q ?? "").trim().slice(0, 60).toLowerCase();
  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const list = await (await cols()).students
    .find({ $and: [studentScope(staff), sp.all ? {} : { active: true }, q ? { $or: [{ nameLower: { $regex: esc } }, { courseName: { $regex: esc, $options: "i" } }] } : {}] },
      { projection: { name: 1, courseName: 1, startDate: 1, endDate: 1, classDays: 1, signatureId: 1, active: 1 } })
    .sort({ nameLower: 1 }).limit(500).toArray();
  const sums = await summaries(list);
  const now = today();
  const admin = staff.role === "ADMIN";
  return (
    <main className="wrap">
      <h1>Students</h1>
      <p className="lead">{list.length} shown. Tap a name to open the student&apos;s profile.</p>
      <form className="row" style={{ marginBottom: 16 }}>
        <input className="search" style={{ minHeight: 46, fontSize: 17, maxWidth: 380 }} name="q" defaultValue={sp.q} placeholder="Find a student or course" aria-label="Find a student or course" />
        <label className="small"><input type="checkbox" className="chk" name="all" value="1" defaultChecked={!!sp.all} /> Include inactive</label>
        <button className="btn ghost">Search</button>
      </form>
      <div style={{ overflowX: "auto" }}>
        <table className="tbl">
          <thead><tr><th>Student</th><th>Status</th><th>Attendance</th><th>Class</th><th>Dates</th><th></th></tr></thead>
          <tbody>
            {list.map((s) => (
              <tr key={s._id}>
                <td><Link href={`/admin/students/${s._id}`}><strong>{s.name}</strong></Link></td>
                <td>{(() => { const st = enrollmentState(s, now); return <span className={`tag ${st === "Active" ? "ok" : st === "Inactive" ? "no" : ""}`}>{st}</span>; })()}</td>
                <td>{(() => { const x = sums.get(s._id)!; return <span className={`level ${x.level}`} title={LEVEL_WORDS[x.level]}>{x.rate === null ? "—" : `${x.rate}%`}</span>; })()}</td>
                <td className="muted">{s.courseName}</td>
                <td className="small">{usDate(s.startDate)} – {usDate(s.endDate)}</td>
                <td><Link href={`/admin/students/${s._id}`}>Profile</Link></td>
              </tr>
            ))}
            {list.length === 0 && <tr><td colSpan={6} className="muted">No students found.</td></tr>}
          </tbody>
        </table>
      </div>
      {admin && (
        <>
          <h2>Add students from a spreadsheet</h2>
          <section className="panel">
            <p>Save your list as CSV with this first row (columns can be in any order; <code>pin</code> is optional):</p>
            <pre style={{ background: "#f3f5f9", padding: 10, overflowX: "auto" }}>name,courseName,courseCode,courseDuration,caseManager,instructor,startDate,endDate,pin{"\n"}Kevin Reid,SORA/Office Management,305-V,6 months,S. Nandi,Mr. Rakesh,04/01/2026,10/01/2026,</pre>
            <p className="small muted">Nothing is saved if any row has a problem. Students who already exist (same name) are skipped.</p>
            <ImportForm action={importStudentsAction} />
          </section>
          <h2>Add one student</h2>
          <section className="panel"><StudentForm action={saveStudentAction.bind(null, null)} isNew courses={await courseNames()} /></section>
        </>
      )}
    </main>
  );
}

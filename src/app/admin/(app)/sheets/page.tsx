import Link from "next/link";
import { cols } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { studentScope } from "@/lib/access";
import { thisMonth } from "@/lib/data";
import { monthTitle, shiftMonth } from "@/lib/sheet";

export const dynamic = "force-dynamic";
export const metadata = { title: "Monthly sheets" };
const PAGE = 50;

export default async function Sheets({ searchParams }: { searchParams: Promise<{ q?: string; page?: string; all?: string }> }) {
  const staff = await requireAdmin();
  const sp = await searchParams;
  const q = (sp.q ?? "").trim().slice(0, 60);
  const page = Math.max(1, Number(sp.page) || 1);
  const now = thisMonth();
  const months = [now, shiftMonth(now, -1), shiftMonth(now, -2)];
  const { students, approvals } = await cols();
  const where = {
    ...studentScope(staff),
    ...(sp.all ? {} : { active: true }),
    ...(q ? { $or: [{ nameLower: { $regex: q.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&") } }, { courseName: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" } }] } : {}),
  };
  const [total, list] = await Promise.all([
    students.countDocuments(where),
    students.find(where, { projection: { name: 1, courseName: 1, startDate: 1, endDate: 1 } }).sort({ nameLower: 1 }).skip((page - 1) * PAGE).limit(PAGE).toArray(),
  ]);
  const approved = new Set((await approvals.find({ studentId: { $in: list.map((s) => s._id) }, month: { $in: months } }, { projection: { _id: 1 } }).toArray()).map((a) => a._id));
  const qs = (p: number) => `?${new URLSearchParams({ ...(q ? { q } : {}), ...(sp.all ? { all: "1" } : {}), page: String(p) })}`;
  return (
    <main className="wrap">
      <h1>Monthly attendance sheets</h1>
      <p className="lead">Open a student&apos;s sheet to sign the “Approved by” section once the teacher has signed the rows. Each sheet downloads as a PDF like the paper form.</p>
      <form className="row no-print" style={{ marginBottom: 16 }}>
        <input className="search" style={{ minHeight: 46, fontSize: 17, maxWidth: 380 }} name="q" defaultValue={q} placeholder="Find a student or course" aria-label="Find a student or course" />
        <label className="small"><input type="checkbox" className="chk" name="all" value="1" defaultChecked={!!sp.all} /> Include removed students</label>
        <button className="btn ghost">Search</button>
      </form>
      <div style={{ overflowX: "auto" }}>
        <table className="tbl">
          <thead><tr><th>Student</th><th>Course</th>{months.map((m) => <th key={m}>{monthTitle(m)}</th>)}<th>Whole course</th></tr></thead>
          <tbody>
            {list.map((s) => (
              <tr key={s._id}>
                <td><Link href={`/admin/students/${s._id}`}>{s.name}</Link></td>
                <td className="muted">{s.courseName}</td>
                {months.map((m) => (
                  <td key={m}>
                    {m < s.startDate.slice(0, 7) || m > s.endDate.slice(0, 7) ? <span className="muted">–</span> : (
                      <><Link href={`/admin/sheets/${s._id}/${m}`}>View</Link> · <a href={`/api/report/${s._id}?month=${m}&format=pdf`}>PDF</a> · <a href={`/api/report/${s._id}?month=${m}&format=docx`}>DOCX</a>{approved.has(`${s._id}:${m}`) && <> <span className="tag ok">approved</span></>}</>
                    )}
                  </td>
                ))}
                <td><a href={`/api/report/${s._id}?month=all&format=pdf`}>PDF</a> · <a href={`/api/report/${s._id}?month=all&format=docx`}>DOCX</a></td>
              </tr>
            ))}
            {list.length === 0 && <tr><td colSpan={6} className="muted">{q ? "No student matches." : "No students yet. Add them under Students."}</td></tr>}
          </tbody>
        </table>
      </div>
      {total > PAGE && (
        <p className="row" style={{ marginTop: 14 }}>
          {page > 1 && <Link className="btn ghost" href={qs(page - 1)}>Previous</Link>}
          <span className="muted">Page {page} of {Math.ceil(total / PAGE)} ({total} students)</span>
          {page * PAGE < total && <Link className="btn ghost" href={qs(page + 1)}>Next</Link>}
        </p>
      )}
    </main>
  );
}

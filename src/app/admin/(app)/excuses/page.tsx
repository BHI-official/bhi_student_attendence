import Link from "next/link";
import { cols } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { teacherList } from "@/lib/data";
import { WEEKDAY_NAMES, usDate, weekday } from "@/lib/sheet";
import { env } from "@/lib/env";
import { ExcuseDecision } from "@/components/ExcuseDecision";

export const dynamic = "force-dynamic";
export const metadata = { title: "Excuses" };

const STATUSES = [["PENDING", "Waiting for review"], ["APPROVED", "Approved"], ["REJECTED", "Rejected"], ["all", "All"]] as const;

/** Every uploaded excuse, across all students, teachers and dates. Admins review or change decisions here. */
export default async function Excuses({ searchParams }: { searchParams: Promise<{ status?: string; teacher?: string; q?: string; done?: string }> }) {
  await requireAdmin();
  const sp = await searchParams;
  const status = STATUSES.some(([k]) => k === sp.status) ? sp.status! : "PENDING";
  const teachers = await teacherList();
  const { entries, students } = await cols();
  const q = (sp.q ?? "").trim().slice(0, 60).toLowerCase();
  const studentFilter = {
    ...(teachers.some((t) => t.id === sp.teacher) ? { teacherId: sp.teacher } : {}),
    ...(q ? { nameLower: { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") } } : {}),
  };
  const scoped = Object.keys(studentFilter).length ? (await students.find(studentFilter, { projection: { _id: 1 } }).toArray()).map((s) => s._id) : null;
  const list = await entries.find({
    excuse: { $ne: null }, ...(status === "all" ? {} : { "excuse.status": status }), ...(scoped ? { studentId: { $in: scoped } } : {}),
  }).sort({ "excuse.at": -1 }).limit(500).toArray();
  const people = new Map((await students.find({ _id: { $in: [...new Set(list.map((e) => e.studentId))] } }, { projection: { name: 1, courseName: 1, teacherId: 1 } }).toArray()).map((s) => [s._id, s]));
  const tName = new Map(teachers.map((t) => [t.id, t.name]));
  const counts = Object.fromEntries(await Promise.all(["PENDING", "APPROVED", "REJECTED"].map(async (k) => [k, await entries.countDocuments({ "excuse.status": k })])));
  const when = (d: Date) => new Date(d).toLocaleString("en-US", { month: "2-digit", day: "2-digit", hour: "numeric", minute: "2-digit", timeZone: env().APP_TIMEZONE });
  const link = (o: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ status, teacher: sp.teacher, q: sp.q, ...o })) if (v) p.set(k, v);
    return `/admin/excuses?${p}`;
  };
  return (
    <main className="wrap wide">
      <h1>Excuses</h1>
      <p className="lead">Every document students uploaded for an absence. An absence only becomes Excused once its excuse is approved; approved excused days don’t count against attendance. You can approve, reject or change any decision. To add an excuse for an older date, open the student and use “Add or correct any day”.</p>
      {sp.done && <p className="msg ok" role="status">{sp.done.slice(0, 200)}</p>}
      <div className="filters" role="group" aria-label="Show">
        {STATUSES.map(([k, label]) => (
          <Link key={k} className="filter" aria-pressed={status === k} href={link({ status: k })}>
            {label}{k !== "all" && <> <b>{counts[k] ?? 0}</b></>}
          </Link>
        ))}
      </div>
      <form className="row no-print" style={{ marginBottom: 12 }}>
        <input type="hidden" name="status" value={status} />
        <div className="field" style={{ margin: 0 }}><label htmlFor="eq">Student</label><input id="eq" name="q" defaultValue={sp.q} placeholder="Name" autoComplete="off" /></div>
        <div className="field" style={{ margin: 0 }}><label htmlFor="et">Teacher</label>
          <select id="et" name="teacher" defaultValue={sp.teacher ?? ""}><option value="">All teachers</option>{teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
        <button className="btn ghost">Show</button>
      </form>
      <div className="tablewrap">
        <table className="tbl">
          <thead><tr><th>Absent on</th><th>Student</th><th>Teacher</th><th>Document</th><th>Student wrote</th><th>Status</th><th>Decide</th></tr></thead>
          <tbody>
            {list.map((e) => {
              const st = people.get(e.studentId);
              const x = e.excuse!;
              return (
                <tr key={e._id}>
                  <td className="nowrap">{WEEKDAY_NAMES[weekday(e.date)].slice(0, 3)} {usDate(e.date)}<span className="small muted block">uploaded {when(x.at)}</span></td>
                  <td>{st ? <Link href={`/admin/students/${st._id}?day=${e.date}#edit`}><strong>{st.name}</strong></Link> : "?"}<span className="small muted block">{st?.courseName}</span></td>
                  <td className="small">{st?.teacherId ? tName.get(st.teacherId) ?? "" : <em>no teacher</em>}</td>
                  <td><a className="btn ghost sm" href={`/api/excuse/${encodeURIComponent(e._id)}`} target="_blank" rel="noreferrer">Open {x.fileName}</a></td>
                  <td className="small">{x.note || <span className="muted">—</span>}</td>
                  <td>
                    <span className={`chip ${x.status === "APPROVED" ? "s-excused" : x.status === "REJECTED" ? "s-absent" : "s-pending"}`}>{x.status === "PENDING" ? "Waiting" : x.status === "APPROVED" ? "Approved" : "Rejected"}</span>
                    {x.decidedBy && <span className="small muted block">by {x.decidedBy.name}{x.reason ? `: ${x.reason}` : ""}</span>}
                  </td>
                  <td><ExcuseDecision entryKey={e._id} status={x.status} /></td>
                </tr>
              );
            })}
            {list.length === 0 && <tr><td colSpan={7} className="muted">No excuses here.</td></tr>}
          </tbody>
        </table>
      </div>
    </main>
  );
}

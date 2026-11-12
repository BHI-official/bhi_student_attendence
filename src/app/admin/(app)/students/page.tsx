import Link from "next/link";
import { cols } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { adminList, courseNames, teacherList, today } from "@/lib/data";
import { LEVEL_WORDS, enrollmentState, usDate } from "@/lib/sheet";
import { summaries } from "@/lib/summary";
import { assignTeacherAction, bulkAssignTeacherAction, importStudentsAction, saveStudentAction } from "@/actions/admin";
import { ActionForm, Submit } from "@/components/forms";
import { ImportForm, StudentForm, TeacherOptions, TeacherSelect } from "./StudentForms";

export const dynamic = "force-dynamic";
export const metadata = { title: "Students & teachers" };

export default async function Students({ searchParams }: { searchParams: Promise<{ q?: string; all?: string; teacher?: string; program?: string }> }) {
  await requireAdmin();
  const sp = await searchParams;
  const q = (sp.q ?? "").trim().slice(0, 60).toLowerCase();
  const esc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const [teachers, admins] = await Promise.all([teacherList(), adminList()]);
  const teacherFilter = sp.teacher === "none" ? { $or: [{ teacherId: null }, { teacherId: { $exists: false } }] } : teachers.some((t) => t.id === sp.teacher) ? { teacherId: sp.teacher } : {};
  const programs = await courseNames();
  const program = programs.includes(sp.program ?? "") ? sp.program! : "";
  // Find matches a student's name, their program, or their teacher's name.
  const teacherMatch = q ? teachers.filter((t) => t.name.toLowerCase().includes(q)).map((t) => t.id) : [];
  const { students } = await cols();
  const list = await students
    .find({ $and: [sp.all ? {} : { active: true }, teacherFilter, program ? { courseName: program } : {}, q ? { $or: [{ nameLower: { $regex: esc } }, { courseName: { $regex: esc, $options: "i" } }, { teacherId: { $in: teacherMatch } }] } : {}] },
      { projection: { name: 1, courseName: 1, startDate: 1, endDate: 1, classDays: 1, active: 1, teacherId: 1 } })
    .sort({ nameLower: 1 }).limit(500).toArray();
  const sums = await summaries(list);
  const now = today();
  const teacherName = new Map(teachers.map((t) => [t.id, t.name]));
  const unassigned = list.filter((s) => !s.teacherId || !teacherName.has(s.teacherId)).length;
  const filtered = !!(q || sp.teacher || program || sp.all);
  const total = filtered ? await students.countDocuments(sp.all ? {} : { active: true }) : list.length;
  const adminNamed = q ? admins.filter((a) => a.name.toLowerCase().includes(q)) : [];
  return (
    <main className="wrap wide">
      <h1>Students &amp; teachers</h1>
      <p className="lead">Each student is on one teacher&apos;s roster. Changing a student&apos;s teacher only changes who manages them: their attendance, signatures and approvals stay exactly as they are, and days waiting for approval move to the new teacher.</p>
      <form className="row no-print" style={{ marginBottom: 16 }}>
        <div className="field" style={{ margin: 0 }}><label htmlFor="q">Find</label>
          <input id="q" name="q" defaultValue={sp.q} placeholder="Student, program or teacher" autoComplete="off" /></div>
        <div className="field" style={{ margin: 0 }}><label htmlFor="tf">Teacher</label>
          <select id="tf" name="teacher" defaultValue={sp.teacher ?? ""}><option value="">All</option><option value="none">Not assigned</option>{teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
        <div className="field" style={{ margin: 0 }}><label htmlFor="pf">Program</label>
          <select id="pf" name="program" defaultValue={program}><option value="">All</option>{programs.map((p) => <option key={p}>{p}</option>)}</select></div>
        <label className="small"><input type="checkbox" className="chk" name="all" value="1" defaultChecked={!!sp.all} /> Include inactive</label>
        <button className="btn ghost">Show</button>
        {filtered && <a className="btn ghost" href="/admin/students">Clear filters</a>}
      </form>
      {filtered && list.length > 0 && <p className="small muted">Showing {list.length} of {total} students. <a href="/admin/students">Show everyone</a></p>}
      {adminNamed.length > 0 && (
        <p className="msg info">{adminNamed.map((a) => a.name).join(", ")} {adminNamed.length === 1 ? "has" : "have"} an <b>admin</b> account, so no students can be assigned to {adminNamed.length === 1 ? "them" : "them"}. To give them a roster, change the role to Teacher on the <a href="/admin/team">Staff</a> page.</p>
      )}
      {teachers.length === 0 && <p className="msg warnmsg">There are no teacher accounts yet, so students can&apos;t be assigned. Add teachers on the <a href="/admin/team">Staff</a> page (role: Teacher).</p>}
      {unassigned > 0 && <p className="msg warnmsg">{unassigned} student{unassigned === 1 ? " has" : "s have"} no teacher yet, so {unassigned === 1 ? "they don't" : "they don't"} appear on any teacher&apos;s roster. Tick them and assign a teacher below.</p>}

      <ActionForm action={bulkAssignTeacherAction} id="bulk" className="panel bulkassign">
        <div className="row" style={{ alignItems: "center" }}>
          <span>Move the ticked students to</span>
          <select name="teacherId" aria-label="Teacher" defaultValue="">
            <TeacherOptions teachers={teachers} admins={admins} none="Not assigned" />
          </select>
          <Submit>Assign ticked students</Submit>
        </div>
      </ActionForm>

      <div className="tablewrap">
        <table className="tbl">
          <thead><tr><th className="pick"><span className="sr-only">Tick</span></th><th>Student</th><th>Program</th><th>Teacher</th><th>Attendance</th><th>Status</th><th>Dates</th></tr></thead>
          <tbody>
            {list.map((s) => {
              const st = enrollmentState(s, now);
              const x = sums.get(s._id)!;
              return (
                <tr key={s._id}>
                  <td className="pick"><input type="checkbox" className="chk" name="ids" value={s._id} form="bulk" aria-label={`Tick ${s.name}`} /></td>
                  <td><Link href={`/admin/students/${s._id}`}><strong>{s.name}</strong></Link></td>
                  <td className="muted">{s.courseName}</td>
                  <td>
                    <TeacherSelect action={assignTeacherAction.bind(null, s._id)} teachers={teachers} admins={admins} current={s.teacherId && teacherName.has(s.teacherId) ? s.teacherId : null} compact />
                    {s.teacherId && !teacherName.has(s.teacherId) && <span className="small err">Teacher account is off. Choose another.</span>}
                  </td>
                  <td><span className={`level ${x.level}`} title={LEVEL_WORDS[x.level]}>{x.rate === null ? "—" : `${x.rate}%`}</span></td>
                  <td><span className={`tag ${st === "Active" ? "ok" : st === "Inactive" ? "no" : ""}`}>{st}</span></td>
                  <td className="small nowrap">{usDate(s.startDate)} – {usDate(s.endDate)}</td>
                </tr>
              );
            })}
            {list.length === 0 && (
              <tr><td colSpan={7}>
                {filtered && total > 0
                  ? <>No students match these filters ({total} student{total === 1 ? "" : "s"} in total). <a href="/admin/students">Clear filters</a></>
                  : <span className="muted">No students yet. Add one below, or import a spreadsheet.</span>}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>

      <h2>Add one student</h2>
      <section className="panel"><StudentForm action={saveStudentAction.bind(null, null)} isNew courses={programs} teachers={teachers} admins={admins} /></section>

      <h2>Add students from a spreadsheet</h2>
      <section className="panel">
        <p>Save your list as CSV with this first row (columns in any order; <code>pin</code> and <code>teacherEmail</code> are optional):</p>
        <pre className="code">name,courseName,courseCode,courseDuration,caseManager,instructor,startDate,endDate,pin,teacherEmail{"\n"}Jennifer Quezada,Clinical Medical Assistant,CMA-1,6 months,S. Nandi,Dr. Saniya,04/01/2026,10/01/2026,,saniya@school.org</pre>
        <p className="small muted">Nothing is saved if any row has a problem. Students who already exist (same name) are skipped. <code>teacherEmail</code> puts the student on that teacher&apos;s roster.</p>
        <ImportForm action={importStudentsAction} />
      </section>
    </main>
  );
}

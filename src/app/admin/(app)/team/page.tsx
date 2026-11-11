import { cols } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { createStaffAction, resetStaffPasswordAction, setStaffActiveAction, setStaffDetailsAction, setStaffRoleAction, setStaffSignsOffAction } from "@/actions/admin";
import Link from "next/link";
import { ActionForm, Field, Submit } from "@/components/forms";

export const dynamic = "force-dynamic";
export const metadata = { title: "Teachers & admins" };

export default async function Team() {
  const me = await requireAdmin();
  const { staff, students } = await cols();
  const list = await staff.find({}, { projection: { passwordHash: 0, signatureId: 0 } }).sort({ name: 1 }).toArray();
  const counts = new Map((await students.aggregate<{ _id: string; n: number }>([{ $match: { active: true, teacherId: { $type: "string" } } }, { $group: { _id: "$teacherId", n: { $sum: 1 } } }]).toArray()).map((c) => [c._id, c.n]));
  return (
    <main className="wrap">
      <h1>Staff accounts</h1>
      <p className="lead">Teachers sign in at the teacher page and see one roster: the students assigned to them (assign students on the <Link href="/admin/students">Students &amp; teachers</Link> page). Admins sign in at the admin page and see everything. The “Teacher signature” on each day is always the student’s own teacher, signing by hand. The “Approved by” section at the bottom of each month is signed by the admin marked below (for example Mahek).</p>
      {list.map((s) => (
        <section key={s._id} className="panel">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div><strong>{s.name}</strong> <span className="muted">· {s.email} · {s.role === "ADMIN" ? "Admin" : "Teacher"}{s.position ? ` · ${s.position}` : ""}</span>{s.signsOff && <> <span className="tag ok">signs “Approved by”</span></>}{!s.active && <> <span className="tag no">turned off</span></>}</div>
            {s._id !== me._id && (
              <ActionForm action={setStaffActiveAction.bind(null, s._id)} confirm={s.active ? `Turn off ${s.name}'s account?` : undefined}>
                <input type="hidden" name="active" value={s.active ? "0" : "1"} /><Submit className="btn ghost">{s.active ? "Turn off" : "Turn on"}</Submit>
              </ActionForm>
            )}
          </div>
          {s.role === "TEACHER" && (
            <p className="small" style={{ margin: "8px 0 0" }}>
              <Link href={`/admin/students?teacher=${s._id}`}>{counts.get(s._id) ?? 0} assigned student{counts.get(s._id) === 1 ? "" : "s"}</Link>
              {" "}<Link href={`/admin?teacher=${s._id}`}>Open their roster</Link>
            </p>
          )}
          {s._id !== me._id && (
            <details style={{ marginTop: 8 }}><summary className="small">Change role</summary>
              <ActionForm action={setStaffRoleAction.bind(null, s._id)} confirm={`Make ${s.name} ${s.role === "ADMIN" ? "a teacher" : "an admin"}?`}>
                <input type="hidden" name="role" value={s.role === "ADMIN" ? "TEACHER" : "ADMIN"} />
                <p className="small muted">{s.role === "ADMIN" ? "Teachers see only the students assigned to them." : "Admins see every student. Students assigned to this account will need a new teacher."}</p>
                <Submit className="btn ghost">{s.role === "ADMIN" ? "Make teacher" : "Make admin"}</Submit>
              </ActionForm>
            </details>
          )}
          {s.role === "ADMIN" && (
            <ActionForm action={setStaffSignsOffAction.bind(null, s._id)} className="row" confirm={s.signsOff ? `Stop ${s.name} signing the “Approved by” section?` : undefined}>
              <input type="hidden" name="signsOff" value={s.signsOff ? "0" : "1"} />
              <p className="small" style={{ margin: "8px 0 0" }}>{s.signsOff ? "Signs the “Approved by” section at the bottom of each month." : "Doesn’t sign the “Approved by” section."}</p>
              <Submit className="btn ghost sm">{s.signsOff ? "Stop signing off months" : "Signs the Approved by section"}</Submit>
            </ActionForm>
          )}
          <details style={{ marginTop: 8 }}><summary className="small">Name and position (printed with their signature)</summary>
            <ActionForm action={setStaffDetailsAction.bind(null, s._id)}>
              <div className="grid2"><Field name="name" label="Name" defaultValue={s.name} required /><Field name="position" label="Position" defaultValue={s.position} /></div>
              <Submit className="btn ghost">Save</Submit>
            </ActionForm>
          </details>
          <details style={{ marginTop: 8 }}><summary className="small">Set a temporary password</summary>
            <ActionForm action={resetStaffPasswordAction.bind(null, s._id)}><Field name="password" label="Temporary password (10+ characters)" type="text" /><Submit className="btn ghost">Set password</Submit></ActionForm>
          </details>
        </section>
      ))}
      <h2>Add a teacher or admin</h2>
      <ActionForm action={createStaffAction} className="panel">
        <div className="grid2">
          <Field name="name" label="Name" required />
          <Field name="email" label="Email" type="email" required />
          <Field name="position" label="Position" placeholder="Instructor" />
          <Field name="role" label="Role"><select id="f-role" name="role" defaultValue="TEACHER"><option value="TEACHER">Teacher</option><option value="ADMIN">Admin</option></select></Field>
          <Field name="password" label="Temporary password (10+ characters)" type="text" required />
        </div>
        <div style={{ marginTop: 12 }}><Submit>Add account</Submit></div>
      </ActionForm>
    </main>
  );
}

import { cols } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { courseNames } from "@/lib/data";
import { createStaffAction, resetStaffPasswordAction, setStaffActiveAction, setStaffCoursesAction, setStaffRoleAction } from "@/actions/admin";
import { ActionForm, Field, Submit } from "@/components/forms";

export const dynamic = "force-dynamic";
export const metadata = { title: "Teachers & admins" };

function CoursePicks({ courses, picked }: { courses: string[]; picked: string[] }) {
  if (!courses.length) return <p className="small muted">No courses yet: they appear once students are added.</p>;
  return <div className="row" style={{ gap: "6px 16px" }}>{courses.map((c) => <label key={c} className="small"><input type="checkbox" className="chk" name="courses" value={c} defaultChecked={picked.includes(c)} /> {c}</label>)}</div>;
}

export default async function Team() {
  const me = await requireAdmin();
  const list = await (await cols()).staff.find({}, { projection: { passwordHash: 0, signatureId: 0 } }).sort({ name: 1 }).toArray();
  const courses = await courseNames();
  return (
    <main className="wrap">
      <h1>Teachers &amp; admins</h1>
      <p className="lead">Admins sign in at the admin page and see every student. Teachers sign in at the teacher page and see only the courses ticked for them: they sign the staff signature on each row and comment, but can&apos;t change a student&apos;s entries. Admins sign the “Approved by” section at the bottom of each month.</p>
      {list.map((s) => (
        <section key={s._id} className="panel">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div><strong>{s.name}</strong> <span className="muted">· {s.email} · {s.role === "ADMIN" ? "Admin" : "Teacher"}{s.position ? ` · ${s.position}` : ""}</span>{!s.active && <> <span className="tag no">turned off</span></>}</div>
            {s._id !== me._id && (
              <ActionForm action={setStaffActiveAction.bind(null, s._id)} confirm={s.active ? `Turn off ${s.name}'s account?` : undefined}>
                <input type="hidden" name="active" value={s.active ? "0" : "1"} /><Submit className="btn ghost">{s.active ? "Turn off" : "Turn on"}</Submit>
              </ActionForm>
            )}
          </div>
          {s.role === "TEACHER" && (
            <ActionForm action={setStaffCoursesAction.bind(null, s._id)}>
              <p className="small" style={{ margin: "10px 0 6px", fontWeight: 700 }}>Assigned courses</p>
              <CoursePicks courses={courses} picked={s.courses ?? []} />
              <div style={{ marginTop: 8 }}><Submit className="btn ghost">Save courses</Submit></div>
            </ActionForm>
          )}
          {s._id !== me._id && (
            <details style={{ marginTop: 8 }}><summary className="small">Change role</summary>
              <ActionForm action={setStaffRoleAction.bind(null, s._id)} confirm={`Make ${s.name} ${s.role === "ADMIN" ? "a teacher" : "an admin"}?`}>
                <input type="hidden" name="role" value={s.role === "ADMIN" ? "TEACHER" : "ADMIN"} />
                <p className="small muted">{s.role === "ADMIN" ? "Teachers sign each row of their courses' sheets." : "Admins sign the “Approved by” section at the bottom of each month."}</p>
                <Submit className="btn ghost">{s.role === "ADMIN" ? "Make teacher" : "Make admin"}</Submit>
              </ActionForm>
            </details>
          )}
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
          <Field name="position" label="Position (printed on “Approved by”)" placeholder="Instructor" />
          <Field name="role" label="Role"><select id="f-role" name="role" defaultValue="TEACHER"><option value="TEACHER">Teacher</option><option value="ADMIN">Admin</option></select></Field>
          <Field name="password" label="Temporary password (10+ characters)" type="text" required />
        </div>
        <p className="small" style={{ fontWeight: 700, margin: "4px 0 6px" }}>Assigned courses (teachers)</p>
        <CoursePicks courses={courses} picked={[]} />
        <div style={{ marginTop: 12 }}><Submit>Add account</Submit></div>
      </ActionForm>
    </main>
  );
}

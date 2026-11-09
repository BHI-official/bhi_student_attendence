import { cols } from "@/lib/db";
import { requireStaff } from "@/lib/auth";
import { courseNames, today } from "@/lib/data";
import { studentScope } from "@/lib/access";
import { editWindowDays, firstOpenDate } from "@/lib/policy";
import { usDate, weekday, WEEKDAY_NAMES } from "@/lib/sheet";
import { addHolidayAction, removeHolidayAction } from "@/actions/admin";
import { markCourseDayAction } from "@/actions/staff";
import { ActionForm, Field, Submit } from "@/components/forms";

export const dynamic = "force-dynamic";
export const metadata = { title: "Holidays and days off" };

export default async function Holidays() {
  const staff = await requireStaff();
  const from = `${today().slice(0, 4)}-01-01`;
  const { holidays, entries, students } = await cols();
  const list = await holidays.find({ _id: { $gte: from } }).sort({ _id: 1 }).toArray();
  const admin = staff.role === "ADMIN";
  const myCourses = admin ? await courseNames() : (await courseNames(studentScope(staff)));
  // Class days off already marked (rows marked Holiday / Excused by the class tool), from the start of the year.
  const ids = (await students.find({ ...studentScope(staff), active: true }, { projection: { _id: 1, courseName: 1 } }).toArray());
  const courseOf = new Map(ids.map((s) => [s._id, s.courseName]));
  const marked = await entries.find(
    { studentId: { $in: [...courseOf.keys()] }, date: { $gte: from }, status: { $in: ["HOLIDAY", "EXCUSED"] }, "history.reason": "class day off" },
    { projection: { studentId: 1, date: 1, status: 1, note: 1 } },
  ).toArray();
  const classDays = new Map<string, { date: string; course: string; status: string; note: string; count: number }>();
  for (const e of marked) {
    const course = courseOf.get(e.studentId) ?? "";
    const k = `${e.date}|${course}|${e.status}|${e.note}`;
    const x = classDays.get(k) ?? { date: e.date, course, status: e.status, note: e.note, count: 0 };
    x.count++;
    classDays.set(k, x);
  }
  const classList = [...classDays.values()].sort((a, b) => a.date.localeCompare(b.date) || a.course.localeCompare(b.course));

  return (
    <main className="wrap narrow">
      <h1>Holidays and days off</h1>
      <p className="lead">A holiday shows on every student&apos;s sheet across the time columns, like “Holiday” written on the paper. Nobody can start or sign that day.</p>

      <h2>School holidays</h2>
      {admin && (
        <ActionForm action={addHolidayAction} className="panel">
          <div className="grid2"><Field name="date" label="Date" type="date" required /><Field name="name" label="Name" placeholder="Labor Day" /></div>
          <Field name="note" label="Note (optional, printed on the sheet)" placeholder="School closed" />
          <Submit>Add holiday</Submit>
        </ActionForm>
      )}
      <table className="tbl">
        <thead><tr><th>Date</th><th>Holiday</th><th>Note</th>{admin && <th></th>}</tr></thead>
        <tbody>
          {list.map((h) => (
            <tr key={h._id}>
              <td>{WEEKDAY_NAMES[weekday(h._id)]}, {usDate(h._id)}</td><td>{h.name}</td><td className="muted">{h.note}</td>
              {admin && <td><ActionForm action={removeHolidayAction.bind(null, h._id)} confirm={`Remove ${h.name}?`}><Submit className="btn ghost">Remove</Submit></ActionForm></td>}
            </tr>
          ))}
          {list.length === 0 && <tr><td colSpan={4} className="muted">No holidays this year yet.</td></tr>}
        </tbody>
      </table>

      <h2>A day off for one class</h2>
      <p className="small muted">
        Marks the day on the sheet of every student in the class who has class that day, with your note. Days a student has already started are left as they are.
        {!admin && ` You can mark days from ${usDate(firstOpenDate())} on (rows older than ${editWindowDays()} days are locked).`}
      </p>
      {myCourses.length ? (
        <ActionForm action={markCourseDayAction} className="panel">
          <div className="grid2">
            <Field name="date" label="Date" type="date" required />
            <Field name="course" label="Class">
              <select id="f-course" name="course" required defaultValue="">
                <option value="" disabled>Choose a class</option>
                {myCourses.map((c) => <option key={c}>{c}</option>)}
              </select>
            </Field>
            <Field name="status" label="Mark as">
              <select id="f-status" name="status" defaultValue="HOLIDAY">
                <option value="HOLIDAY">Holiday (no class)</option>
                <option value="EXCUSED">Excused</option>
                <option value="REMOVE">Remove an earlier mark</option>
              </select>
            </Field>
            <Field name="note" label="Note (printed on the sheet)" placeholder="Instructor training day" />
          </div>
          <Submit>Save</Submit>
        </ActionForm>
      ) : <p className="msg info">No classes are assigned to you yet.</p>}
      {classList.length > 0 && (
        <table className="tbl">
          <thead><tr><th>Date</th><th>Class</th><th>Marked</th><th>Note</th><th>Students</th></tr></thead>
          <tbody>
            {classList.map((c) => (
              <tr key={`${c.date}|${c.course}|${c.status}|${c.note}`}>
                <td>{WEEKDAY_NAMES[weekday(c.date)]}, {usDate(c.date)}</td><td>{c.course}</td><td>{c.status.toLowerCase()}</td><td className="muted">{c.note}</td><td>{c.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

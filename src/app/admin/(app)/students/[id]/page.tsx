import Link from "next/link";
import { notFound } from "next/navigation";
import { EMPTY_PROFILE, cols } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { adminList, courseNames, teacherList, thisMonth, today } from "@/lib/data";
import { thresholds } from "@/lib/policy";
import { env } from "@/lib/env";
import { loadStudentNotes } from "@/lib/notes";
import {
  DATE_RE, LEVEL_WORDS, MONTH_RE, WEEKDAY_NAMES, attendanceSummary, enrollmentState, isClassDay, monthDates, monthTitle, shiftMonth, time12, usDate, weekday,
  type AttendanceSummary,
} from "@/lib/sheet";
import { STATUS_LABEL, dayStatus } from "@/lib/week";
import { assignTeacherAction, resetPinAction, saveStudentAction, saveStudentProfileAction, setStudentActiveAction } from "@/actions/admin";
import { ActionForm, Field, Submit } from "@/components/forms";
import { StudentNotes } from "@/components/StudentNotes";
import { AdminDayEditor } from "@/components/AdminDayEditor";
import { HandTimes } from "@/components/HandTimes";
import { SignOffPanel } from "@/components/SignOff";
import { dayTimes } from "@/lib/roster";
import { entriesHash } from "@/lib/hash";
import { adminMoveDayAction, removeMonthSignOffAction } from "@/actions/staff";
import { PinForm, ProfileForm, StudentForm, TeacherSelect } from "../StudentForms";

export const dynamic = "force-dynamic";
export const metadata = { title: "Student" };

const when = (d: Date) => new Date(d).toLocaleString("en-US", { month: "2-digit", day: "2-digit", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: env().APP_TIMEZONE });

function Level({ s }: { s: AttendanceSummary }) {
  return <span className={`level ${s.level}`}>{LEVEL_WORDS[s.level]}{s.rate !== null && `: ${s.rate}%`}</span>;
}

export default async function StudentProfilePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ month?: string; day?: string; moved?: string }> }) {
  const staff = await requireAdmin();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const { students, entries, holidays, assignments, approvals } = await cols();
  const s = await students.findOne({ _id: id });
  if (!s) notFound();
  const now = today();
  const [rows, hols, notes, teachers, periods] = await Promise.all([
    entries.find({ studentId: id }).toArray(),
    holidays.find({ _id: { $gte: s.startDate, $lte: s.endDate } }).toArray(),
    loadStudentNotes(id),
    teacherList(),
    assignments.find({ studentId: id }).sort({ from: -1 }).toArray(),
  ]);
  const holidayMap = new Map(hols.map((h) => [h._id, h.name]));
  const t = thresholds();
  const overall = attendanceSummary(s, rows, new Set(holidayMap.keys()), now, t);
  const state = enrollmentState(s, now);
  const profile = { ...EMPTY_PROFILE, ...(s.profile ?? {}) };
  const teacher = teachers.find((x) => x.id === s.teacherId) ?? null;
  const byDate = new Map(rows.map((e) => [e.date, e]));
  const pending = rows.filter((e) => e.status === "PRESENT" && e.studentSignature && !e.staffSignature).length;
  const excusesWaiting = rows.filter((e) => e.excuse?.status === "PENDING").length;

  // The month shown in the records table (newest first), and the day open in the editor.
  const lastMonth = s.endDate.slice(0, 7) < thisMonth() ? s.endDate.slice(0, 7) : thisMonth();
  const firstMonth = s.startDate.slice(0, 7);
  const editDay = DATE_RE.test(sp.day ?? "") && sp.day! <= now && sp.day! >= s.startDate && sp.day! <= s.endDate ? sp.day! : null;
  const month = editDay ? editDay.slice(0, 7) : MONTH_RE.test(sp.month ?? "") && sp.month! >= firstMonth && sp.month! <= lastMonth ? sp.month! : lastMonth;
  const days = monthDates(month).filter((d) => d <= now && d >= s.startDate && d <= s.endDate && weekday(d) <= 5 && (isClassDay(s, d) || byDate.has(d))).reverse();
  const editing = editDay ? byDate.get(editDay) ?? null : null;
  const signOff = await approvals.findOne({ _id: `${s._id}:${month}` });
  const signers = await (await cols()).staff.find({ role: "ADMIN", active: true, signsOff: true }, { projection: { name: 1 } }).toArray();
  const byOther = !!signOff && !signers.some((x) => x._id === signOff.staffId);
  const signOffCurrent = !!signOff && !byOther && signOff.entriesHash === entriesHash(rows.filter((e) => e.date.startsWith(month)));
  const monthLink = (m: string) => `/admin/students/${s._id}?month=${m}#records`;
  const contact: [string, string][] = [
    ["Phone", profile.phone], ["Email", profile.email], ["Address", profile.address],
    ["Emergency contact", [profile.emergencyName, profile.emergencyPhone].filter(Boolean).join(", ")],
  ];

  return (
    <main className="wrap wide">
      <Link href="/admin/students">All students</Link>

      <section className="panel" style={{ marginTop: 12 }} aria-labelledby="pname">
        <div className="profile-head">
          <div>
            <h1 id="pname">{s.name}</h1>
            <p className="row" style={{ margin: 0, alignItems: "center" }}>
              <span className={`tag ${state === "Active" ? "ok" : state === "Inactive" ? "no" : ""}`}>{state === "Inactive" ? "Inactive (not on the sign-in list)" : state}</span>
              <Level s={overall} />
              {pending > 0 && <span className="chip s-pending">{pending} pending</span>}
              {excusesWaiting > 0 && <span className="chip s-needs_correction">{excusesWaiting} excuse{excusesWaiting === 1 ? "" : "s"} to review</span>}
            </p>
          </div>
          <div className="row">
            <a className="btn ghost" href={`/api/report/${s._id}?month=all&format=pdf`}>Full report (PDF)</a>
            <a className="btn ghost" href={`/api/report/${s._id}?month=all&format=docx`}>Word</a>
          </div>
        </div>
        <dl className="facts" style={{ marginTop: 14 }}>
          <div><dt>Program / class</dt><dd>{s.courseName || "—"}{s.courseCode && ` (${s.courseCode})`}</dd></div>
          <div><dt>Course dates</dt><dd>{usDate(s.startDate)} – {usDate(s.endDate)}</dd></div>
          <div><dt>Class days</dt><dd>{s.classDays.filter((d) => d <= 5).map((d) => WEEKDAY_NAMES[d].slice(0, 3)).join(", ")}</dd></div>
          <div><dt>Days present</dt><dd>{overall.present}</dd></div>
          <div><dt>Absent</dt><dd>{overall.absent + overall.missing}{overall.missing ? ` (${overall.missing} missing)` : ""}</dd></div>
          <div><dt>Excused</dt><dd>{overall.excused}</dd></div>
        </dl>
        <p className="small muted" style={{ marginBottom: 0 }}>
          Attendance % = present ÷ (present + absent + days with nothing recorded). Approved excused days and holidays don&apos;t count against the student.
          Green at {t.goodPercent}% or more, orange from {t.attentionPercent}%.
        </p>
      </section>

      <h2>Teacher</h2>
      <section className="panel">
        <p style={{ marginTop: 0 }}>{teacher ? <>On <b>{teacher.name}</b>&apos;s roster.</> : <span className="err">Not assigned to a teacher, so not on any roster.</span>}</p>
        <TeacherSelect action={assignTeacherAction.bind(null, s._id)} teachers={teachers} admins={await adminList()} current={teacher?.id ?? null} />
        <p className="small muted">Changing the teacher keeps every record as it is. Days already approved keep the teacher who approved them. Days waiting for approval and new submissions go to the new teacher.</p>
        {periods.length > 0 && (
          <details>
            <summary>Assignment history ({periods.length})</summary>
            <table className="tbl" style={{ marginTop: 8 }}>
              <thead><tr><th>Teacher</th><th>From</th><th>Until</th><th>Changed by</th></tr></thead>
              <tbody>{periods.map((p) => <tr key={p._id}><td>{p.teacherName}</td><td>{when(p.from)}</td><td>{p.to ? when(p.to) : <b>now</b>}</td><td>{p.byName}</td></tr>)}</tbody>
            </table>
          </details>
        )}
      </section>

      <h2 id="records">Attendance records</h2>
      {editDay && (
        <section className="panel editpanel" id="edit">
          <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ margin: 0 }}>{editing ? "Correct" : "Add"} {WEEKDAY_NAMES[weekday(editDay)]}, {usDate(editDay)}</h3>
            <Link href={monthLink(month)} className="small">Close</Link>
          </div>
          {editing && sp.moved && DATE_RE.test(sp.moved) && (
            <p className="msg ok">Moved here from {usDate(sp.moved)}. The student&apos;s signature and handwritten times moved with it{editing.staffSignature ? "" : "; the teacher signs it again"}.</p>
          )}
          {editing && (
            <p className="small">
              Now: <b>{STATUS_LABEL[dayStatus(editing, holidayMap.has(editDay), editDay, now)]}</b>
              {editing.status === "PRESENT" && editing.startTime ? `, ${time12(editing.startTime)}–${time12(editing.endTime)}` : ""}
              {editing.studentSignature ? ", signed by the student" : ", no student signature"}
              {editing.staffSignature ? `, approved by ${editing.staffSignature.staffName} (a change removes the approval)` : ""}.
            </p>
          )}
          <AdminDayEditor key={editDay} studentId={s._id} initial={{
            date: editDay, status: editing?.status ?? "PRESENT", start: editing?.startTime ?? "", end: editing?.endTime ?? "", note: editing?.note ?? "",
            exists: !!editing, hasStudentSignature: !!editing?.studentSignature,
          }} />
          {editing && (
            <details style={{ marginTop: 12 }}>
              <summary>Wrong date? Move this day to another date</summary>
              <ActionForm action={adminMoveDayAction.bind(null, s._id, editDay)} className="movedate">
                <p className="small muted" style={{ marginTop: 6 }}>Everything moves with it, including the student&apos;s own signature and handwritten times. The teacher signs it again.</p>
                <div className="grid2">
                  <Field name="to" label="Correct date" type="date" required />
                  <Field name="reason" label="Reason" placeholder="e.g. Signed Tuesday's row for Monday" required />
                </div>
                <Submit className="btn ghost">Move</Submit>
              </ActionForm>
            </details>
          )}
          {editing && editing.history.length > 0 && (
            <details style={{ marginTop: 12 }} open>
              <summary>Changes to this day ({editing.history.length})</summary>
              <ol className="changes">
                {[...editing.history].reverse().map((h, i) => <li key={i}><b>{when(h.at)}</b> {h.byName}: {h.what}{h.reason ? <span className="muted"> — {h.reason}</span> : null}</li>)}
              </ol>
            </details>
          )}
        </section>
      )}
      <form className="row no-print" style={{ marginBottom: 12 }} action={`/admin/students/${s._id}`}>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="pick-day">Add or correct any day</label>
          <input id="pick-day" type="date" name="day" min={s.startDate} max={now < s.endDate ? now : s.endDate} defaultValue={editDay ?? ""} required />
        </div>
        <button className="btn ghost">Open day</button>
        <span className="row" style={{ marginLeft: "auto", alignItems: "center" }}>
          {month > firstMonth && <Link className="btn ghost sm" href={monthLink(shiftMonth(month, -1))} aria-label="Previous month">‹</Link>}
          <strong>{monthTitle(month)}</strong>
          {month < lastMonth && <Link className="btn ghost sm" href={monthLink(shiftMonth(month, 1))} aria-label="Next month">›</Link>}
          <a className="btn ghost sm" href={`/api/report/${s._id}?month=${month}&format=pdf`}>PDF</a>
        </span>
      </form>
      <div className="tablewrap">
        <table className="tbl records">
          <thead><tr><th>Day</th><th>Status</th><th>Times</th><th>Student signature</th><th>Teacher signature</th><th>Excuse</th><th></th></tr></thead>
          <tbody>
            {days.map((d) => {
              const e = byDate.get(d) ?? null;
              const st = dayStatus(e, holidayMap.has(d), d, now);
              const present = e?.status === "PRESENT";
              return (
                <tr key={d} className={`${st === "MISSING" ? "missing" : ""}${d === editDay ? " picked" : ""}`}>
                  <td className="nowrap">{WEEKDAY_NAMES[weekday(d)].slice(0, 3)} {usDate(d)}</td>
                  <td><span className={`chip s-${st.toLowerCase()}`}>{st === "MISSING" && e?.status === "PRESENT" ? "Present · signature missing" : STATUS_LABEL[st]}</span>
                    {e?.history?.some((h) => h.what.startsWith("admin:")) && <span className="tag">edited</span>}</td>
                  <td>{present ? <HandTimes times={dayTimes(e!)} h={22} /> : null}</td>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <td>{e?.studentSignature ? <img className="inkimg" src={`/api/ink/${e.studentSignature.id}`} alt="Student signature" height={30} loading="lazy" /> : st === "MISSING" ? <span className="nosig">Missing</span> : ""}</td>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <td className="small">{e?.staffSignature ? <><img className="inkimg" src={`/api/ink/${e.staffSignature.id}`} alt="" height={24} loading="lazy" /><span className="muted">{e.staffSignature.staffName}</span></> : ""}</td>
                  <td className="small">{e?.excuse ? <a href={`/api/excuse/${encodeURIComponent(e._id)}`} target="_blank" rel="noreferrer">{e.excuse.status.toLowerCase()}</a> : ""}</td>
                  <td><Link className="btn ghost sm" href={`/admin/students/${s._id}?day=${d}#edit`}>{e ? "Edit" : "Add"}</Link></td>
                </tr>
              );
            })}
            {days.length === 0 && <tr><td colSpan={7} className="muted">No class days in {monthTitle(month)} yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <section className="panel approvedby" aria-label={`Approved by, ${monthTitle(month)}`}>
        <h3>Approved by: {monthTitle(month)}</h3>
        {signOff ? (
          <>
            <p>{signOff.staffName}{signOff.position ? `, ${signOff.position}` : ""} on {signOff.signedAt.toLocaleDateString("en-US")}
              {byOther ? <span className="chip s-needs_correction" style={{ marginLeft: 8 }}>Not signed by {signers.map((x) => x.name).join(" or ") || "the sign-off admin"}. Sign again.</span>
                : !signOffCurrent && <span className="chip s-needs_correction" style={{ marginLeft: 8 }}>Days changed since. Sign again.</span>}</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="inkimg big" src={`/api/ink/${signOff.signatureId}`} alt={`Signature of ${signOff.staffName}`} height={50} />
            {signOff.comments && <p className="small">Comments: {signOff.comments}</p>}
            <ActionForm action={removeMonthSignOffAction.bind(null, s._id, month)} confirm="Remove the sign-off? The month opens again for the student and teacher." className="row">
              <Submit className="btn ghost sm">Remove sign-off</Submit>
            </ActionForm>
          </>
        ) : <p className="muted small" style={{ marginTop: 0 }}>Not signed off yet.</p>}
        {!staff.signsOff ? <p className="small muted">Only {signers.map((x) => x.name).join(" or ") || "the admin set on the Staff page"} sign{signers.length === 1 ? "s" : ""} this section.</p>
          : month >= thisMonth() && s.endDate >= now ? <p className="small muted">The month is signed off once it is over.</p> : (!signOff || !signOffCurrent) && (
          <SignOffPanel month={month} monthName={monthTitle(month)} studentIds={[s._id]} defaults={{ name: staff.name, position: staff.position }}
            label={signOff ? "Sign again" : `Sign off ${monthTitle(month)}`} />
        )}
      </section>

      <StudentNotes studentId={s._id} studentName={s.name} notes={notes} staff={staff} today={now} />

      <h2>Contact and social information</h2>
      <section className="panel">
        <dl className="facts">
          {contact.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v || <span className="muted" style={{ fontWeight: 400 }}>Not added</span>}</dd></div>)}
        </dl>
        <p style={{ whiteSpace: "pre-wrap", marginBottom: 0 }}><span className="small muted">Social information</span><br />{profile.social || <span className="muted">Not added</span>}</p>
        <details style={{ marginTop: 12 }}><summary>Edit contact and social information</summary>
          <div style={{ marginTop: 10 }}><ProfileForm action={saveStudentProfileAction.bind(null, s._id)} values={profile} /></div>
        </details>
      </section>

      <h2>PIN</h2>
      <section className="panel">
        <p className="small muted">Students sign in by tapping their name and entering their PIN. Every active student has a different PIN.</p>
        {!s.pinKey && <p className="msg info">This PIN was set before PINs had to be unique. Give a new PIN to make sure no other student has the same one.</p>}
        <PinForm action={resetPinAction.bind(null, s._id)} name={s.name} />
      </section>

      <h2>Student details</h2>
      <section className="panel">
        <StudentForm action={saveStudentAction.bind(null, s._id)} isNew={false} courses={await courseNames()} values={{ name: s.name, courseName: s.courseName, courseCode: s.courseCode, courseDuration: s.courseDuration, caseManager: s.caseManager, instructor: s.instructor, startDate: s.startDate, endDate: s.endDate, classDays: s.classDays }} />
      </section>
      <section className="panel">
        <ActionForm action={setStudentActiveAction.bind(null, s._id)} confirm={s.active ? `Mark ${s.name} inactive? They're removed from the sign-in list and rosters; their records are kept.` : undefined}>
          <input type="hidden" name="active" value={s.active ? "0" : "1"} />
          <Submit className={s.active ? "btn danger" : "btn"}>{s.active ? "Mark inactive (remove from sign-in list)" : "Mark active (back on sign-in list)"}</Submit>
        </ActionForm>
      </section>
    </main>
  );
}

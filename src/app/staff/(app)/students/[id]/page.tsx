import Link from "next/link";
import { notFound } from "next/navigation";
import { EMPTY_PROFILE, cols } from "@/lib/db";
import { requireStaff } from "@/lib/auth";
import { canSee } from "@/lib/access";
import { courseNames, thisMonth, today } from "@/lib/data";
import { entriesHash } from "@/lib/hash";
import { thresholds } from "@/lib/policy";
import { signatureImages } from "@/lib/signatures";
import {
  LEVEL_WORDS, WEEKDAY_NAMES, attendanceSummary, enrollmentState, hoursText, monthTitle, shiftMonth, usDate, type AttendanceSummary,
} from "@/lib/sheet";
import { resetPinAction, saveStudentAction, saveStudentProfileAction, setStudentActiveAction, setStudentSignatureAction } from "@/actions/admin";
import { ActionForm, Submit } from "@/components/forms";
import { SignatureOnFile } from "@/components/SignatureCapture";
import { PinForm, ProfileForm, StudentForm } from "../StudentForms";

export const dynamic = "force-dynamic";
export const metadata = { title: "Student profile" };

function Level({ s, big }: { s: AttendanceSummary; big?: boolean }) {
  return (
    <span className={`level ${s.level}`} style={big ? { fontSize: 20 } : undefined}>
      {LEVEL_WORDS[s.level]}{s.rate !== null && ` · ${s.rate}%`}
    </span>
  );
}

export default async function StudentProfilePage({ params }: { params: Promise<{ id: string }> }) {
  const staff = await requireStaff();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const { students, entries, holidays, approvals } = await cols();
  const s = await students.findOne({ _id: id });
  if (!s || !canSee(staff, s)) notFound();
  const now = today();
  const admin = staff.role === "ADMIN";
  const [rows, hols, apps, sigs] = await Promise.all([
    entries.find({ studentId: id }).toArray(),
    holidays.find({ _id: { $gte: s.startDate, $lte: s.endDate } }, { projection: { _id: 1 } }).toArray(),
    approvals.find({ studentId: id }).toArray(),
    signatureImages([s.signatureId]),
  ]);
  const holidaySet = new Set(hols.map((h) => h._id));
  const t = thresholds();
  const overall = attendanceSummary(s, rows, holidaySet, now, t);
  const state = enrollmentState(s, now);
  const profile = { ...EMPTY_PROFILE, ...(s.profile ?? {}) };
  const sig = sigs[s.signatureId ?? ""];

  // Month by month, newest first, from the first month of the course to now (or the end of the course).
  const lastMonth = s.endDate.slice(0, 7) < thisMonth() ? s.endDate.slice(0, 7) : thisMonth();
  const months: { month: string; sum: AttendanceSummary; approval: "current" | "outdated" | null; approver: string | null }[] = [];
  for (let m = lastMonth; m >= s.startDate.slice(0, 7); m = shiftMonth(m, -1)) {
    const first = `${m}-01`, last = `${m}-31`;
    const inMonth = rows.filter((e) => e.date >= first && e.date <= last);
    const sum = attendanceSummary({ ...s, startDate: s.startDate > first ? s.startDate : first, endDate: s.endDate < last ? s.endDate : last }, inMonth, holidaySet, now, t);
    const a = apps.find((x) => x.month === m);
    months.push({ month: m, sum, approval: a ? (a.entriesHash === entriesHash(inMonth) ? "current" : "outdated") : null, approver: a?.staffName ?? null });
  }
  const recent = rows.filter((e) => e.date <= now).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 10);
  const contact: [string, string][] = [
    ["Phone", profile.phone], ["Email", profile.email], ["Address", profile.address],
    ["Emergency contact", [profile.emergencyName, profile.emergencyPhone].filter(Boolean).join(", ")],
  ];

  return (
    <main className="wrap">
      <Link href="/staff/students">All students</Link>

      <section className="panel" style={{ marginTop: 12 }} aria-labelledby="pname">
        <div className="profile-head">
          <div>
            <h1 id="pname">{s.name}</h1>
            <p className="row" style={{ margin: 0 }}>
              <span className={`tag ${state === "Active" ? "ok" : state === "Inactive" ? "no" : ""}`}>{state === "Inactive" ? "Inactive (removed from sign-in list)" : state}</span>
              <Level s={overall} big />
            </p>
          </div>
          <div className="row">
            <Link className="btn" href={`/staff/sheets/${s._id}/${lastMonth}`}>Open {monthTitle(lastMonth).split(" ")[0]}&apos;s sheet</Link>
            <a className="btn ghost" href={`/api/report/${s._id}?month=all&format=pdf`}>Full report (PDF)</a>
            <a className="btn ghost" href={`/api/report/${s._id}?month=all&format=docx`}>Word</a>
          </div>
        </div>
        <dl className="facts" style={{ marginTop: 14 }}>
          <div><dt>Class</dt><dd>{s.courseName || "—"}{s.courseCode && ` (${s.courseCode})`}</dd></div>
          <div><dt>Start / enrollment date</dt><dd>{usDate(s.startDate)}</dd></div>
          <div><dt>End / completion date</dt><dd>{usDate(s.endDate)}</dd></div>
          <div><dt>Class days</dt><dd>{s.classDays.map((d) => WEEKDAY_NAMES[d].slice(0, 3)).join(", ")}</dd></div>
          <div><dt>Course duration</dt><dd>{s.courseDuration || "—"}</dd></div>
          <div><dt>Instructor</dt><dd>{s.instructor || "—"}</dd></div>
          <div><dt>Case manager</dt><dd>{s.caseManager || "—"}</dd></div>
          <div><dt>Signature on file</dt><dd>{s.signatureId ? "Yes" : "Not yet"}</dd></div>
        </dl>
      </section>

      <h2>Attendance so far</h2>
      <section className="panel">
        <div className="stats">
          <div className="stat"><b><span className={`level ${overall.level}`}>{overall.rate === null ? "—" : `${overall.rate}%`}</span></b><span>attendance</span></div>
          <div className="stat"><b>{overall.present}</b><span>days present</span></div>
          <div className="stat"><b>{overall.absent + overall.missing}</b><span>days absent{overall.missing ? ` (${overall.missing} not recorded)` : ""}</span></div>
          <div className="stat"><b>{overall.excused}</b><span>excused</span></div>
          <div className="stat"><b>{overall.holidays}</b><span>holidays</span></div>
          <div className="stat"><b>{hoursText(overall.minutes) || "0"}</b><span>hours</span></div>
        </div>
        {overall.rate !== null && <div className="ratebar" role="img" aria-label={`${overall.rate}% attendance`}><i className={overall.level} style={{ width: `${overall.rate}%` }} /></div>}
        <p className="small muted" style={{ marginBottom: 0 }}>
          Green at {t.goodPercent}% or more, orange from {t.attentionPercent}%, red below. Holidays and excused days don&apos;t count against the student;
          class days with nothing recorded count as absent. Today counts once something is recorded.
        </p>
      </section>

      <h2>Attendance history</h2>
      <div style={{ overflowX: "auto" }}>
        <table className="tbl">
          <thead><tr><th>Month</th><th>Attendance</th><th>Present</th><th>Absent</th><th>Excused</th><th>Hours</th><th>Approved</th><th></th></tr></thead>
          <tbody>
            {months.map(({ month, sum, approval, approver }) => (
              <tr key={month}>
                <td>{monthTitle(month)}</td>
                <td><Level s={sum} /></td>
                <td>{sum.present}</td>
                <td>{sum.absent + sum.missing}{sum.missing ? <span className="small muted"> ({sum.missing} not recorded)</span> : null}</td>
                <td>{sum.excused}</td>
                <td>{hoursText(sum.minutes) || "0"}</td>
                <td>{approval === "current" ? <span className="tag ok">{approver}</span> : approval === "outdated" ? <span className="tag warn">changed since</span> : <span className="muted">–</span>}</td>
                <td className="small"><Link href={`/staff/sheets/${s._id}/${month}`}>View</Link> · <a href={`/api/report/${s._id}?month=${month}&format=pdf`}>PDF</a></td>
              </tr>
            ))}
            {months.length === 0 && <tr><td colSpan={8} className="muted">The course hasn&apos;t started yet.</td></tr>}
          </tbody>
        </table>
      </div>
      {recent.length > 0 && (
        <details style={{ margin: "10px 0 20px" }}>
          <summary>Last {recent.length} recorded days</summary>
          <ul className="small">
            {recent.map((e) => <li key={e._id}>{WEEKDAY_NAMES[new Date(`${e.date}T12:00:00Z`).getUTCDay() || 7]}, {usDate(e.date)}: {e.status.toLowerCase()}{e.minutes ? `, ${hoursText(e.minutes)} h` : ""}{e.note ? ` (${e.note})` : ""}{e.comments?.length ? ` · ${e.comments.length} comment${e.comments.length === 1 ? "" : "s"}` : ""}</li>)}
          </ul>
        </details>
      )}

      <h2>Contact and social information</h2>
      <section className="panel">
        <dl className="facts">
          {contact.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v || <span className="muted" style={{ fontWeight: 400 }}>Not added</span>}</dd></div>)}
        </dl>
        <p style={{ whiteSpace: "pre-wrap", marginBottom: 0 }}><span className="small muted">Social information</span><br />{profile.social || <span className="muted">Not added</span>}</p>
        {admin && (
          <details style={{ marginTop: 12 }}><summary>Edit contact and social information</summary>
            <div style={{ marginTop: 10 }}><ProfileForm action={saveStudentProfileAction.bind(null, s._id)} values={profile} /></div>
          </details>
        )}
      </section>

      <h2>Signature on file</h2>
      <section className="panel">
        {sig ? (
          <>
            <div style={{ background: "#fff", border: "1.5px solid var(--line)", borderRadius: 10, padding: 14, display: "inline-block" }}><img src={sig} alt={`Signature of ${s.name}`} style={{ maxHeight: 90 }} /></div>
            <p className="small muted">The student signs each day by hand. This copy (their first handwritten signature, unless replaced) lets staff add it to a day the student forgot to sign. Replacing it doesn&apos;t change days already signed.</p>
            <ActionForm action={setStudentSignatureAction.bind(null, s._id)} confirm="Remove this signature on file? Days already signed keep their signature.">
              <input type="hidden" name="clear" value="1" /><Submit className="btn ghost">Remove signature on file</Submit>
            </ActionForm>
          </>
        ) : <p>No signature on file yet. It is saved the first time the student signs a day, or you can add it here from a photo of their signature on paper.</p>}
        <details style={{ marginTop: 10 }}><summary>{sig ? "Replace it here" : "Add it here"}</summary>
          <div style={{ marginTop: 10 }}><SignatureOnFile action={setStudentSignatureAction.bind(null, s._id)} title={`Signature of ${s.name}`} /></div>
        </details>
      </section>

      <h2>PIN</h2>
      <section className="panel">
        <p className="small muted">Students sign in by tapping their name and entering their PIN. Every active student has a different PIN.</p>
        {!s.pinKey && <p className="msg info">This PIN was set before PINs had to be unique. Give a new PIN to make sure no other student has the same one.</p>}
        {admin ? <PinForm action={resetPinAction.bind(null, s._id)} name={s.name} /> : <p className="small">Ask an admin to give a new PIN.</p>}
      </section>

      {admin && (
        <>
          <h2>Details on the sheet</h2>
          <section className="panel">
            <StudentForm action={saveStudentAction.bind(null, s._id)} isNew={false} courses={await courseNames()} values={{ name: s.name, courseName: s.courseName, courseCode: s.courseCode, courseDuration: s.courseDuration, caseManager: s.caseManager, instructor: s.instructor, startDate: s.startDate, endDate: s.endDate, classDays: s.classDays }} />
          </section>
          <section className="panel">
            <ActionForm action={setStudentActiveAction.bind(null, s._id)} confirm={s.active ? `Mark ${s.name} inactive? They're removed from the sign-in list; their sheets are kept.` : undefined}>
              <input type="hidden" name="active" value={s.active ? "0" : "1"} />
              <Submit className={s.active ? "btn danger" : "btn"}>{s.active ? "Mark inactive (remove from sign-in list)" : "Mark active (back on sign-in list)"}</Submit>
            </ActionForm>
          </section>
        </>
      )}
    </main>
  );
}

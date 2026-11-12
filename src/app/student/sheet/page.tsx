import Link from "next/link";
import { redirect } from "next/navigation";
import { cols } from "@/lib/db";
import { currentStudent } from "@/lib/auth";
import { holidaysBetween, thisMonth, today } from "@/lib/data";
import { MONTH_RE, WEEKDAY_NAMES, addDays, isClassDay, monthDates, monthTitle, shiftMonth, usDate, weekday } from "@/lib/sheet";
import { dayTimes } from "@/lib/roster";
import { HandTimes } from "@/components/HandTimes";
import { STATUS_LABEL, dayStatus, mondayOf, openFrom, shortDay, studentCanExcuse, studentCanSubmit, weekDates } from "@/lib/week";
import { studentSignOutAction } from "@/actions/student";
import { StudentDays, type StudentDay, type StudentWeek } from "@/components/StudentDays";
import { AutoRefresh, IdleSignOut } from "@/components/Idle";

export const dynamic = "force-dynamic";
export const metadata = { title: "My attendance" };

export default async function MyAttendance({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const student = await currentStudent();
  if (!student) redirect("/student");
  const now = today();
  const thisMon = mondayOf(now), lastMon = addDays(thisMon, -7);
  const from = lastMon, to = addDays(thisMon, 4);
  const { entries, staff, approvals } = await cols();
  const [rows, holidays, teacher, signoffs] = await Promise.all([
    entries.find({ studentId: student._id, date: { $gte: from, $lte: to } }).toArray(),
    holidaysBetween(from, to),
    student.teacherId ? staff.findOne({ _id: student.teacherId }, { projection: { name: 1 } }) : null,
    approvals.find({ studentId: student._id }, { projection: { month: 1, staffName: 1 } }).toArray(),
  ]);
  const signedBy = new Map(signoffs.map((a) => [a.month, a.staffName]));
  const byDate = new Map(rows.map((e) => [e.date, e]));
  const open = openFrom(now);
  const day = (date: string): StudentDay => {
    const e = byDate.get(date) ?? null;
    const holiday = holidays.get(date) ?? null;
    const classDay = isClassDay(student, date);
    const status = dayStatus(e, !!holiday, date, now);
    const signedOffBy = signedBy.get(date.slice(0, 7)) ?? null;
    const editable = classDay && !holiday && date <= now && date >= open && !signedOffBy;
    const present = e?.status === "PRESENT";
    return {
      date, label: shortDay(date), isToday: date === now, classDay, holiday,
      status, times: present ? dayTimes(e!) : [], sig: e?.studentSignature?.id ?? null,
      approvedBy: e?.staffSignature?.staffName ?? null, approvedSig: e?.staffSignature?.id ?? null, signedOffBy, correction: e?.correction?.reason ?? null,
      markedPresent: present && !e?.studentSignature,
      excuse: e?.excuse ? { status: e.excuse.status, fileName: e.excuse.fileName, reason: e.excuse.reason ?? "" } : null,
      canSubmit: editable && studentCanSubmit(status),
      canExcuse: editable && studentCanExcuse(status) && !(present && !e?.studentSignature && e?.markedBy?.mark === "PRESENT") && e?.excuse?.status !== "APPROVED",
    };
  };
  const weeks: StudentWeek[] = [
    { title: "This week", sub: `${shortDay(thisMon)} – ${shortDay(addDays(thisMon, 4))}`, days: weekDates(thisMon).map(day) },
    { title: "Last week", sub: `${shortDay(lastMon)} – ${shortDay(addDays(lastMon, 4))}`, days: weekDates(lastMon).map(day) },
  ];
  const missing = weeks.flatMap((w) => w.days).filter((d) => d.classDay && !d.isToday && (d.status === "MISSING" || d.status === "NEEDS_CORRECTION") && d.canSubmit);

  // Earlier attendance, one month at a time, read-only.
  const asked = (await searchParams).month ?? "";
  const firstMonth = student.startDate.slice(0, 7);
  const month = MONTH_RE.test(asked) && asked <= thisMonth() && asked >= firstMonth ? asked : thisMonth();
  const [monthRows, monthHolidays, signOff] = await Promise.all([
    entries.find({ studentId: student._id, date: { $gte: `${month}-01`, $lte: `${month}-31` } }).toArray(),
    holidaysBetween(`${month}-01`, `${month}-31`),
    approvals.findOne({ _id: `${student._id}:${month}` }),
  ]);
  const monthBy = new Map(monthRows.map((e) => [e.date, e]));
  const history = monthDates(month).filter((d) => d <= now && isClassDay(student, d)).reverse().map((d) => {
    const e = monthBy.get(d) ?? null;
    return { date: d, e, status: dayStatus(e, monthHolidays.has(d), d, now), locked: d < open || !!e?.staffSignature || !!signOff };
  });

  return (
    <main className="wrap student-wrap">
      <IdleSignOut action={studentSignOutAction} minutes={5} />
      {/* The teacher's approvals show up here by themselves. */}
      <AutoRefresh seconds={20} />
      <div className="studenthead">
        <div>
          <h1>Hi, {student.name.split(" ")[0]}</h1>
          <p className="lead">{student.courseName || "Your class"}{teacher ? <>, with {teacher.name}</> : null}</p>
        </div>
        <form action={studentSignOutAction}><button className="btn ghost">Done, sign out</button></form>
      </div>

      {missing.length > 0 ? (
        <p className="msg warnmsg" role="note">
          {missing.length === 1 ? "1 day needs" : `${missing.length} days need`} your signature: {missing.map((d) => d.label).join(", ")}.
        </p>
      ) : (
        <p className="msg ok">You&apos;re all caught up.</p>
      )}

      <StudentDays weeks={weeks} teacherName={teacher?.name ?? null} />
      <p className="small muted">You can fill in this week and last week. Older days and approved days are locked; ask an admin if something is wrong.</p>

      <section className="history" aria-labelledby="hist">
        <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
          <h2 id="hist" style={{ margin: 0 }}>All my attendance</h2>
          <div className="row" style={{ alignItems: "center" }}>
            {month > firstMonth && <Link className="btn ghost sm" href={`/student/sheet?month=${shiftMonth(month, -1)}#hist`} aria-label="Previous month">‹</Link>}
            <strong>{monthTitle(month)}</strong>
            {month < thisMonth() && <Link className="btn ghost sm" href={`/student/sheet?month=${shiftMonth(month, 1)}#hist`} aria-label="Next month">›</Link>}
            <a className="btn ghost sm" href={`/api/report/${student._id}?month=${month}&format=pdf`}>Download PDF</a>
          </div>
        </div>
        <div className="tablewrap">
          <table className="tbl">
            <thead><tr><th>Day</th><th>Status</th><th>Times</th><th>Your signature</th><th>Teacher signature</th></tr></thead>
            <tbody>
              {history.map(({ date, e, status, locked }) => (
                <tr key={date} className={status === "MISSING" ? "missing" : ""}>
                  <td className="nowrap">{WEEKDAY_NAMES[weekday(date)].slice(0, 3)} {usDate(date)}</td>
                  <td><span className={`chip s-${status.toLowerCase()}`}>{status === "MISSING" ? "Not signed" : STATUS_LABEL[status]}</span></td>
                  <td>{e?.status === "PRESENT" ? <HandTimes times={dayTimes(e)} h={22} /> : null}</td>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <td>{e?.studentSignature ? <img className="inkimg" src={`/api/ink/${e.studentSignature.id}`} alt="Your signature" height={26} /> : status === "MISSING" ? <span className="nosig">Not signed</span> : ""}</td>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <td>{e?.staffSignature ? <img className="inkimg" src={`/api/ink/${e.staffSignature.id}`} alt={`Signature of ${e.staffSignature.staffName}`} height={26} /> : <span className="small muted">{locked ? "Locked" : ""}</span>}</td>
                </tr>
              ))}
              {history.length === 0 && <tr><td colSpan={5} className="muted">No class days yet this month.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="approvedby">
          <h3>Approved by</h3>
          {signOff ? (
            <>
              <p>{signOff.staffName}{signOff.position ? `, ${signOff.position}` : ""} on {signOff.signedAt.toLocaleDateString("en-US")}</p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className="inkimg big" src={`/api/ink/${signOff.signatureId}`} alt={`Signature of ${signOff.staffName}`} height={50} />
              {signOff.comments && <p className="small">Comments: {signOff.comments}</p>}
            </>
          ) : <p className="muted small">Not signed off yet. The admin signs at the end of the month.</p>}
        </div>
      </section>
    </main>
  );
}

import Link from "next/link";
import { requireStaff } from "@/lib/auth";
import { studentScope } from "@/lib/access";
import { courseNames, loadDay, today } from "@/lib/data";
import { DATE_RE, WEEKDAY_NAMES, usDate, weekday } from "@/lib/sheet";
import { TodayBoard } from "@/components/TodayBoard";
import { AutoRefresh } from "@/components/Idle";
import { lockedFor } from "@/lib/policy";

export const dynamic = "force-dynamic";
export const metadata = { title: "Today" };

export default async function StaffToday({ searchParams }: { searchParams: Promise<{ date?: string; course?: string }> }) {
  const staff = await requireStaff();
  const sp = await searchParams;
  const now = today();
  const date = DATE_RE.test(sp.date ?? "") && sp.date! <= now ? sp.date! : now;
  const courses = await courseNames(studentScope(staff));
  const course = courses.includes(sp.course ?? "") ? sp.course : undefined;
  const day = await loadDay(date, studentScope(staff), course);
  return (
    <main className="wrap">
      {date === now && <AutoRefresh seconds={15} />}
      {staff.role === "TEACHER" && !staff.courses.length && <p className="msg info">No courses are assigned to you yet. Ask an admin to add your courses.</p>}
      <h1>{date === now ? "Today" : WEEKDAY_NAMES[weekday(date)]}, {usDate(date)}</h1>
      <form className="row no-print" style={{ margin: "8px 0 18px" }}>
        <div className="field" style={{ margin: 0 }}><label htmlFor="d">Day</label><input id="d" type="date" name="date" defaultValue={date} max={now} /></div>
        <div className="field" style={{ margin: 0 }}><label htmlFor="c">Course</label>
          <select id="c" name="course" defaultValue={course ?? ""}><option value="">All courses</option>{courses.map((c) => <option key={c}>{c}</option>)}</select>
        </div>
        <button className="btn ghost">Show</button>
        {date !== now && <Link className="btn ghost" href="/staff">Back to today</Link>}
      </form>
      <TodayBoard key={`${date}:${course ?? ""}`} date={date} month={date.slice(0, 7)} holiday={day.holiday} hasSaved={!!staff.signatureId} isToday={date === now} locked={lockedFor(staff, date)}
        rows={day.rows.map(({ student: s, entry: e }) => ({
          id: s._id, name: s.name, course: s.courseName, status: e?.status ?? null, start: e?.startTime ?? null, end: e?.endTime ?? null,
          minutes: e?.minutes ?? null, startLateBy: e?.startLateBy ?? null, endLateBy: e?.endLateBy ?? null, studentSigned: !!e?.studentSignature, staffSigned: !!e?.staffSignature, studentHasSignature: !!s.signatureId,
        }))} />
    </main>
  );
}

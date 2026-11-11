import Link from "next/link";
import type { Staff } from "@/lib/types";
import { teacherList, today } from "@/lib/data";
import { loadRoster } from "@/lib/roster";
import { DATE_RE, WEEKDAY_NAMES, addDays, usDate, weekday } from "@/lib/sheet";
import { isWeekday, mondayOf, openFrom, weekTitle } from "@/lib/week";
import { AutoRefresh } from "./Idle";
import { Roster } from "./Roster";

export type RosterParams = { view?: string; date?: string; teacher?: string; program?: string };

/** The attendance roster: a teacher's own students, or (admins) everyone, for one day or one week. */
export async function RosterPage({ staff, sp, base }: { staff: Staff; sp: RosterParams; base: string }) {
  const now = today();
  const isAdmin = staff.role === "ADMIN";
  const view = sp.view === "day" ? "day" : "week";
  let date = DATE_RE.test(sp.date ?? "") && sp.date! <= now ? sp.date! : now;
  if (view === "day" && !isWeekday(date)) date = addDays(mondayOf(date), 4); // a weekend shows that Friday
  const monday = mondayOf(date);
  const from = view === "day" ? date : monday;
  const to = view === "day" ? date : addDays(monday, 4) < now ? addDays(monday, 4) : now;
  const teachers = isAdmin ? await teacherList() : [];
  const teacherId = isAdmin && (sp.teacher === "none" || teachers.some((t) => t.id === sp.teacher)) ? sp.teacher : undefined;
  const { rows, programs, studentCount } = await loadRoster(staff, { from, to, teacherId, program: sp.program || undefined });

  const link = (o: Partial<RosterParams>) => {
    const p = new URLSearchParams();
    const v = { view, date, teacher: teacherId, ...o };
    for (const [k, x] of Object.entries(v)) if (x) p.set(k, x);
    return `${base}?${p}`;
  };
  const prevDay = (() => { let d = addDays(date, -1); while (!isWeekday(d)) d = addDays(d, -1); return d; })();
  const nextDay = (() => { let d = addDays(date, 1); while (!isWeekday(d)) d = addDays(d, 1); return d; })();
  const oldest = openFrom(now);
  const title = view === "day" ? `${date === now ? "Today, " : ""}${WEEKDAY_NAMES[weekday(date)]} ${usDate(date)}` : `${monday === mondayOf(now) ? "This week" : monday === addDays(mondayOf(now), -7) ? "Last week" : weekTitle(monday)}`;

  return (
    <main className="wrap wide">
      {from <= now && to >= now && <AutoRefresh seconds={30} />}
      <div className="rosterhead">
        <div>
          <h1>{isAdmin ? "All attendance" : "My attendance roster"}</h1>
          <p className="lead" style={{ marginBottom: 0 }}>
            {isAdmin
              ? `${studentCount} student${studentCount === 1 ? "" : "s"}${teacherId ? "" : " across all teachers"}.`
              : `${studentCount} student${studentCount === 1 ? "" : "s"} assigned to you.`}{" "}
            {isAdmin ? "Each day is checked and signed by the student’s own teacher. You can send a day back or correct it." : "Check each day’s times and signature, then sign. Tick several to sign them with one signature."}
          </p>
        </div>
      </div>

      <nav className="viewbar no-print" aria-label="Choose the day or week">
        <div className="seg" role="group" aria-label="View">
          <Link href={link({ view: "day" })} aria-current={view === "day" ? "page" : undefined}>Day</Link>
          <Link href={link({ view: "week" })} aria-current={view === "week" ? "page" : undefined}>Week</Link>
        </div>
        <div className="stepper">
          <Link className="btn ghost sm" href={link({ date: view === "day" ? prevDay : addDays(monday, -7) })} aria-label={view === "day" ? "Previous day" : "Previous week"}>‹</Link>
          <strong>{title}</strong>
          {(view === "day" ? nextDay <= now : addDays(monday, 7) <= now)
            ? <Link className="btn ghost sm" href={link({ date: view === "day" ? nextDay : addDays(monday, 7) })} aria-label={view === "day" ? "Next day" : "Next week"}>›</Link>
            : <span className="btn ghost sm" aria-disabled="true">›</span>}
          {date !== now && <Link className="small" href={link({ date: now })}>Back to {view === "day" ? "today" : "this week"}</Link>}
        </div>
        {isAdmin && (
          <form className="row" action={base}>
            <input type="hidden" name="view" value={view} />
            <input type="hidden" name="date" value={date} />
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="t">Teacher</label>
              <select id="t" name="teacher" defaultValue={teacherId ?? ""}>
                <option value="">All teachers</option>
                <option value="none">Not assigned</option>
                {teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <button className="btn ghost">Show</button>
          </form>
        )}
      </nav>
      {!isAdmin && from < oldest && <p className="msg info">Days before {usDate(oldest)} are locked for changes. You can still approve or send back days that are waiting for you. Ask an admin to correct anything else.</p>}

      {studentCount === 0 ? (
        <p className="empty">{isAdmin ? "No students match." : "No students are assigned to you yet. An admin assigns students to teachers."}</p>
      ) : (
        <Roster key={`${from}:${to}:${teacherId ?? ""}`} rows={rows} isAdmin={isAdmin} programs={programs} grouped={view === "week"} />
      )}
    </main>
  );
}

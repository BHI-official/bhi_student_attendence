import Link from "next/link";
import { redirect } from "next/navigation";
import { currentStudent } from "@/lib/auth";
import { loadSheet, missedDays, rowsForStudent, sheetHeader, thisMonth, timeRules } from "@/lib/data";
import { editWindowDays, firstOpenDate } from "@/lib/policy";
import { env } from "@/lib/env";
import { MONTH_RE, monthTitle, shiftMonth, usDate } from "@/lib/sheet";
import { studentSignOutAction } from "@/actions/student";
import { PaperSheet } from "@/components/PaperSheet";
import { IdleSignOut } from "@/components/Idle";

export const dynamic = "force-dynamic";
export const metadata = { title: "My sheet" };

export default async function MySheet({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const student = await currentStudent();
  if (!student) redirect("/student");
  const asked = (await searchParams).month ?? "";
  const now = thisMonth();
  const month = MONTH_RE.test(asked) && asked <= now && asked >= student.startDate.slice(0, 7) ? asked : now;
  const sheet = (await loadSheet(student._id, month))!;
  const todayRow = sheet.rows.find((r) => r.isToday);
  const e = todayRow?.entry;
  const hint = !todayRow ? null
    : todayRow.holiday ? `Today is a holiday (${todayRow.holiday}).`
    : e && e.status !== "PRESENT" ? `Today is marked ${e.status.toLowerCase()}. Ask a staff member if that's wrong.`
    : !e?.startTime ? "Today: tap “Enter start time” when you arrive and write the time by hand."
    : !e.endTime ? "Today: when class is over, tap “Enter end time”, write the time by hand and sign."
    : "You're done for today.";
  // Earlier class days they forgot, which they can still fill in (inside the editing window).
  const missed = await missedDays(student, firstOpenDate());
  const missedElsewhere = missed.filter((d) => d.slice(0, 7) !== month);
  return (
    <main className="wrap" style={{ maxWidth: 1040 }}>
      <IdleSignOut action={studentSignOutAction} />
      <div className="row no-print" style={{ justifyContent: "space-between", marginBottom: 14 }}>
        <form action={studentSignOutAction}><button className="btn ghost">Done, sign out</button></form>
        <div className="row">
          {month > student.startDate.slice(0, 7) && <Link className="btn ghost" href={`/student/sheet?month=${shiftMonth(month, -1)}`}>‹ {monthTitle(shiftMonth(month, -1)).split(" ")[0]}</Link>}
          <strong>{monthTitle(month)}</strong>
          {month < now && <Link className="btn ghost" href={`/student/sheet?month=${shiftMonth(month, 1)}`}>{monthTitle(shiftMonth(month, 1)).split(" ")[0]} ›</Link>}
          <a className="btn" href={`/api/report/${student._id}?month=${month}&format=pdf`}>Download PDF</a>
          <a className="btn ghost" href={`/api/report/${student._id}?month=${month}&format=docx`}>Download Word (DOCX)</a>
        </div>
      </div>
      {month === now && hint && <p className="msg info no-print">{hint}</p>}
      {missed.length > 0 && (
        <p className="msg info no-print">
          {missed.length === 1 ? `${usDate(missed[0])} has` : `${missed.length} earlier class days have`} nothing recorded.
          {" "}Tap “Fill in this day” on the sheet to add your times and sign. You can do this for up to {editWindowDays()} days.
          {missedElsewhere.length > 0 && <> <Link href={`/student/sheet?month=${missedElsewhere[0].slice(0, 7)}`}>Open {monthTitle(missedElsewhere[0].slice(0, 7))}</Link></>}
        </p>
      )}
      <PaperSheet mode="student" student={sheetHeader(student)} month={month} rows={rowsForStudent(sheet.rows)} firstOpenDate={firstOpenDate()} editWindowDays={editWindowDays()} totalMinutes={sheet.totalMinutes} approval={sheet.approval} approvalCurrent={sheet.approvalCurrent} images={sheet.images}
        clock={month === now ? { tz: env().APP_TIMEZONE, serverNow: Date.now(), rules: timeRules() } : undefined} />
    </main>
  );
}

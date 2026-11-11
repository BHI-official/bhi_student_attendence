import { cols } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { holidaysBetween, teacherList, thisMonth, today } from "@/lib/data";
import { entriesHash } from "@/lib/hash";
import { MONTH_RE, isClassDay, monthDates, monthTitle, shiftMonth } from "@/lib/sheet";
import { dayStatus } from "@/lib/week";
import { SignOffList, type SignOffRow } from "@/components/SignOff";

export const dynamic = "force-dynamic";
export const metadata = { title: "Monthly sign-off" };

/** The admin signs the "Approved by" section at the bottom of each student's month, many at once. */
export default async function SignOffPage({ searchParams }: { searchParams: Promise<{ month?: string; teacher?: string }> }) {
  const staff = await requireAdmin();
  const sp = await searchParams;
  const now = thisMonth();
  // Months are signed off once they are over, so the page opens on last month.
  const month = MONTH_RE.test(sp.month ?? "") && sp.month! <= now ? sp.month! : shiftMonth(now, -1);
  const teachers = await teacherList();
  const teacherId = teachers.some((t) => t.id === sp.teacher) ? sp.teacher : undefined;
  const { students, entries, approvals, staff: staffCol } = await cols();
  const signers = await staffCol.find({ role: "ADMIN", active: true, signsOff: true }, { projection: { name: 1 } }).toArray();
  const signerIds = new Set(signers.map((x) => x._id));
  const first = `${month}-01`, last = `${month}-31`;
  const list = await students.find({ active: true, startDate: { $lte: last }, endDate: { $gte: first }, ...(teacherId ? { teacherId } : {}) }).sort({ nameLower: 1 }).limit(2000).toArray();
  const ids = list.map((s) => s._id);
  const [rows, apps, holidays] = await Promise.all([
    entries.find({ studentId: { $in: ids }, date: { $gte: first, $lte: last } }).toArray(),
    approvals.find({ studentId: { $in: ids }, month }).toArray(),
    holidaysBetween(first, last),
  ]);
  const by = new Map<string, typeof rows>();
  for (const e of rows) (by.get(e.studentId) ?? by.set(e.studentId, []).get(e.studentId)!).push(e);
  const appBy = new Map(apps.map((a) => [a.studentId, a]));
  const tName = new Map(teachers.map((t) => [t.id, t.name]));
  const d = today();
  const out: SignOffRow[] = list.map((s) => {
    const mine = by.get(s._id) ?? [];
    const byDate = new Map(mine.map((e) => [e.date, e]));
    const c = { approved: 0, waiting: 0, missing: 0, absent: 0, excused: 0 };
    for (const date of monthDates(month)) {
      if (date > d || !isClassDay(s, date)) continue;
      const st = dayStatus(byDate.get(date), holidays.has(date), date, d);
      if (st === "APPROVED") c.approved++;
      else if (st === "PENDING" || st === "NEEDS_CORRECTION") c.waiting++;
      else if (st === "MISSING") c.missing++;
      else if (st === "ABSENT") c.absent++;
      else if (st === "EXCUSED") c.excused++;
    }
    const a = appBy.get(s._id);
    return {
      id: s._id, name: s.name, program: s.courseName, teacher: s.teacherId ? tName.get(s.teacherId) ?? "" : "", ...c,
      notOver: month >= now && s.endDate >= d,
      byOther: !!a && !signerIds.has(a.staffId),
      signedBy: a?.staffName ?? null, signedAt: a ? a.signedAt.toLocaleDateString("en-US") : null, current: !!a && a.entriesHash === entriesHash(mine),
    };
  });
  const months = Array.from({ length: 12 }, (_, i) => shiftMonth(now, -i));
  return (
    <main className="wrap wide">
      <h1>Monthly sign-off</h1>
      <p className="lead">Sign the “Approved by” section at the bottom of each student’s attendance sheet. Tick the students who are ready, then sign once by hand. Months signed by anyone else show “Needs your signature”: sign them again to replace it. A month is signed off once it is over. Students with days still waiting for their teacher can’t be signed off yet. A signed month is locked for students and teachers.</p>
      <form className="row no-print" style={{ marginBottom: 14 }}>
        <div className="field" style={{ margin: 0 }}><label htmlFor="m">Month</label>
          <select id="m" name="month" defaultValue={month}>{months.map((m) => <option key={m} value={m}>{monthTitle(m)}</option>)}</select></div>
        <div className="field" style={{ margin: 0 }}><label htmlFor="t">Teacher</label>
          <select id="t" name="teacher" defaultValue={teacherId ?? ""}><option value="">All teachers</option>{teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></div>
        <button className="btn ghost">Show</button>
      </form>
      {!staff.signsOff && (
        <p className="msg warnmsg">
          {signers.length
            ? <>Only {signers.map((x) => x.name).join(" or ")} sign{signers.length === 1 ? "s" : ""} the “Approved by” section. You can see the list but not sign.</>
            : <>Nobody is set to sign the “Approved by” section yet. On the <a href="/admin/team">Staff</a> page, open Mahek&apos;s account and turn on “Signs the Approved by section”.</>}
        </p>
      )}
      <SignOffList canSign={!!staff.signsOff} key={`${month}:${teacherId ?? ""}`} rows={out} month={month} monthName={monthTitle(month)} defaults={{ name: staff.name, position: staff.position }} />
    </main>
  );
}

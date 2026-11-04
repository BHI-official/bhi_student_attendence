import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/auth";
import { canSee } from "@/lib/access";
import { loadSheet, sheetHeader, thisMonth } from "@/lib/data";
import { MONTH_RE, monthTitle, shiftMonth } from "@/lib/sheet";
import { PaperSheet } from "@/components/PaperSheet";

export const dynamic = "force-dynamic";

export default async function StaffSheet({ params }: { params: Promise<{ studentId: string; month: string }> }) {
  const staff = await requireStaff();
  const { studentId, month } = await params;
  if (!/^[0-9a-f-]{36}$/.test(studentId) || !MONTH_RE.test(month)) notFound();
  const sheet = await loadSheet(studentId, month);
  if (!sheet || !canSee(staff, sheet.student)) notFound();
  const s = sheet.student;
  const prev = shiftMonth(month, -1), next = shiftMonth(month, 1);
  return (
    <main className="wrap" style={{ maxWidth: 1040 }}>
      <div className="row no-print" style={{ justifyContent: "space-between", marginBottom: 14 }}>
        <Link href="/staff/sheets">All sheets</Link>
        <div className="row">
          {prev >= s.startDate.slice(0, 7) && <Link className="btn ghost" href={`/staff/sheets/${s._id}/${prev}`}>‹ {monthTitle(prev).split(" ")[0]}</Link>}
          <strong>{monthTitle(month)}</strong>
          {next <= thisMonth() && next <= s.endDate.slice(0, 7) && <Link className="btn ghost" href={`/staff/sheets/${s._id}/${next}`}>{monthTitle(next).split(" ")[0]} ›</Link>}
          <a className="btn" href={`/api/report/${s._id}?month=${month}&format=pdf`}>PDF</a>
          <a className="btn ghost" href={`/api/report/${s._id}?month=${month}&format=docx`}>Word (DOCX)</a>
          <Link className="btn ghost" href={`/staff/students/${s._id}`}>Student details</Link>
        </div>
      </div>
      <PaperSheet mode="staff" student={sheetHeader(s)} month={month} rows={sheet.rows} totalMinutes={sheet.totalMinutes}
        approval={sheet.approval} approvalCurrent={sheet.approvalCurrent} hasSavedSignature={!!staff.signatureId} images={sheet.images}
        isAdmin={staff.role === "ADMIN"} studentHasSignature={!!s.signatureId} />
    </main>
  );
}

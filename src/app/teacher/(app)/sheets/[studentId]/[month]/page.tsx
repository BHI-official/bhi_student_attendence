import Link from "next/link";
import { notFound } from "next/navigation";
import { requireTeacher } from "@/lib/auth";
import { canSee } from "@/lib/access";
import { loadSheet, sheetHeader, thisMonth } from "@/lib/data";
import { MONTH_RE, monthTitle, shiftMonth } from "@/lib/sheet";
import { PaperSheet } from "@/components/PaperSheet";
import { signatureImages } from "@/lib/signatures";
import { editWindowDays, firstOpenDate } from "@/lib/policy";

export const dynamic = "force-dynamic";
export const metadata = { title: "Review sheet" };

/**
 * A teacher reviews one student's month: they sign the staff signature on each row and comment. The
 * "Approved by" section is the admin's. The student's own entries are shown but can't be changed here.
 */
export default async function TeacherSheet({ params, searchParams }: { params: Promise<{ studentId: string; month: string }>; searchParams: Promise<{ back?: string }> }) {
  const staff = await requireTeacher();
  const { studentId, month } = await params;
  if (!/^[0-9a-f-]{36}$/.test(studentId) || !MONTH_RE.test(month)) notFound();
  const sheet = await loadSheet(studentId, month);
  if (!sheet || !canSee(staff, sheet.student)) notFound();
  const s = sheet.student;
  const raw = (await searchParams).back ?? "";
  // Only ever link back inside the teacher portal.
  const back = raw.startsWith("/teacher/students") ? raw : `/teacher/students?${new URLSearchParams({ course: s.courseName, month })}`;
  const prev = shiftMonth(month, -1), next = shiftMonth(month, 1);
  const onFile = await signatureImages([staff.signatureId]);
  const later = sheet.rows.filter((r) => r.entry?.filledLaterAt && !r.entry.staffSignature).length;
  return (
    <main className="wrap" style={{ maxWidth: 1040 }}>
      <div className="row no-print" style={{ justifyContent: "space-between", marginBottom: 14 }}>
        <Link href={back}>Back to students</Link>
        <div className="row">
          {prev >= s.startDate.slice(0, 7) && <Link className="btn ghost" href={`/teacher/sheets/${s._id}/${prev}`}>‹ {monthTitle(prev).split(" ")[0]}</Link>}
          <strong>{monthTitle(month)}</strong>
          {next <= thisMonth() && next <= s.endDate.slice(0, 7) && <Link className="btn ghost" href={`/teacher/sheets/${s._id}/${next}`}>{monthTitle(next).split(" ")[0]} ›</Link>}
          <a className="btn" href={`/api/report/${s._id}?month=${month}&format=pdf`}>PDF</a>
          <a className="btn ghost" href={`/api/report/${s._id}?month=${month}&format=docx`}>Word (DOCX)</a>
        </div>
      </div>
      <p className="msg info no-print">
        Sign the staff signature on each row and add comments. The admin signs the “Approved by” section at the bottom. The student&apos;s times and signatures are theirs: if something is wrong, add a comment and ask an admin to correct it.
        {later > 0 && <> {later} day{later === 1 ? " was" : "s were"} filled in later by the student: check {later === 1 ? "it" : "them"} before signing.</>}
      </p>
      <PaperSheet mode="teacher" student={sheetHeader(s)} month={month} rows={sheet.rows} totalMinutes={sheet.totalMinutes}
        approval={sheet.approval} approvalCurrent={sheet.approvalCurrent} hasSavedSignature={!!staff.signatureId} images={{ ...sheet.images, ...onFile }}
        studentHasSignature={false} studentSignatureId={null} staffSignatureId={staff.signatureId} staffName={staff.name}
        staffId={staff._id} staffPosition={staff.position} firstOpenDate={firstOpenDate()} editWindowDays={editWindowDays()} />
    </main>
  );
}

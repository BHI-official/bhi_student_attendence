import { currentStaff } from "@/lib/auth";
import { studentScope } from "@/lib/access";
import { audit } from "@/lib/db";
import { thisMonth } from "@/lib/data";
import { MONTH_RE, monthTitle } from "@/lib/sheet";
import { buildMonthSummaryPdf, buildPdfMany, loadReport, type Report } from "@/lib/report";
import { classMonth } from "@/lib/classreport";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A class's month: ?month=YYYY-MM&course=...&type=summary (one line per student) or type=sheets
 * (every student's sheet for the month, in one PDF). Staff only; teachers get their own courses.
 */
export async function GET(req: Request) {
  const staff = await currentStaff();
  if (!staff) return new Response("Sign in to download this report.", { status: 401 });
  const q = new URL(req.url).searchParams;
  const month = q.get("month") ?? "";
  const course = (q.get("course") ?? "").slice(0, 120);
  const type = q.get("type") === "sheets" ? "sheets" : "summary";
  if (!MONTH_RE.test(month) || month > thisMonth()) return new Response("Choose a month.", { status: 400 });
  if (course && staff.role !== "ADMIN" && !staff.courses.includes(course)) return new Response("Not found", { status: 404 });

  const rows = await classMonth(studentScope(staff), month, course || undefined);
  let body: Uint8Array;
  if (type === "summary") {
    body = await buildMonthSummaryPdf(month, course, rows);
  } else {
    if (rows.length > 200) return new Response("Too many students for one file. Choose a class.", { status: 400 });
    const reports: Report[] = [];
    for (const r of rows) { const rep = await loadReport(r.id, month); if (rep) reports.push(rep); }
    body = await buildPdfMany(reports, `Attendance sheets: ${monthTitle(month)}${course ? `, ${course}` : ""}`);
  }
  await audit(staff._id, "report.class_download", course || "all", { month, type, students: rows.length });
  const safe = (course || "all classes").replace(/[^A-Za-z0-9 _-]/g, "").trim() || "class";
  const name = `${type === "summary" ? "Monthly report" : "Sheets"} - ${safe} - ${month}.pdf`;
  return new Response(new Uint8Array(body), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "private, no-store" },
  });
}

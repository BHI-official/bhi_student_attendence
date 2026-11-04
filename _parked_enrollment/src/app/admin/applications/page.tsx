import type { Metadata } from "next";
import Link from "next/link";
import { formatUsd } from "@/lib/payment";
import type { Filter } from "mongodb";
import { cols, type Application, type ApplicationStatus } from "@/db";
import { requireAdmin } from "@/lib/auth";
import { CATEGORIES, CATEGORY_LABELS, COUNTIES, COUNTY_LABELS, describeEnrollment } from "@/lib/forms/templates";
import { coursesById, regexSafe, usersById } from "@/lib/queries";
import { Empty, PageHeader, StatusBadge, Table, Td, fmtDate, cx } from "@/components/ui";

export const metadata: Metadata = { title: "Applications" };

const FILTERS: { key: string; label: string; statuses: ApplicationStatus[] | null; payment?: "TO_REQUEST" | "REQUESTED" }[] = [
  { key: "PENDING", label: "Pending review", statuses: ["SUBMITTED", "RESUBMITTED"] },
  { key: "PAYMENT", label: "Private: payment to request", statuses: ["SUBMITTED", "RESUBMITTED"], payment: "TO_REQUEST" },
  { key: "AWAITING_PAYMENT", label: "Private: awaiting payment", statuses: ["SUBMITTED", "RESUBMITTED"], payment: "REQUESTED" },
  { key: "CORRECTIONS_REQUESTED", label: "Resubmission required", statuses: ["CORRECTIONS_REQUESTED"] },
  { key: "APPROVED", label: "Approved", statuses: ["APPROVED"] },
  { key: "REJECTED", label: "Rejected", statuses: ["REJECTED"] },
  { key: "DRAFT", label: "Draft (in progress)", statuses: ["DRAFT"] },
  { key: "ALL", label: "All", statuses: null },
];
const PAGE = 50;

type SP = { status?: string; q?: string; category?: string; county?: string; course?: string; page?: string };

export default async function ApplicationsPage({ searchParams }: { searchParams: Promise<SP> }) {
  await requireAdmin();
  const sp = await searchParams;
  const filter = FILTERS.find((f) => f.key === sp.status) ?? FILTERS[0];
  const q = (sp.q ?? "").trim().slice(0, 80);
  const page = Math.max(1, Math.min(1000, Number(sp.page) || 1));
  const { applications, users, courses } = await cols();
  const where: Filter<Application> = {};
  if (filter.statuses) where.status = { $in: filter.statuses };
  if (filter.payment) Object.assign(where, { category: "PRIVATE", paymentStatus: filter.payment === "REQUESTED" ? "REQUESTED" : "PENDING" });
  const category = CATEGORIES.find((c) => c === sp.category);
  if (category && !filter.payment) where.category = category;
  const county = COUNTIES.find((c) => c === sp.county);
  if (county) where.county = county;
  if (sp.course && /^[0-9a-f-]{36}$/.test(sp.course)) where.courseId = sp.course;
  if (q) {
    const rx = { $regex: regexSafe(q), $options: "i" };
    const matches = await users.find({ role: "STUDENT", $or: [{ name: rx }, { email: rx }] }, { projection: { _id: 1 } }).limit(500).toArray();
    where.studentId = { $in: matches.map((u) => u._id) };
  }
  const total = await applications.countDocuments(where);
  const rows = await applications.find(where, { projection: { forms: 0, signatures: 0, submissions: 0 } }).sort({ updatedAt: -1 }).skip((page - 1) * PAGE).limit(PAGE).toArray();
  const people = await usersById(rows.map((r) => r.studentId));
  const courseMap = await coursesById(rows.map((r) => r.courseId).filter((x): x is string => !!x));
  const allCourses = await courses.find({}, { projection: { name: 1, archived: 1 } }).sort({ name: 1 }).toArray();
  const qs = (extra: Record<string, string | number>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ status: filter.key, q, category: sp.category ?? "", county: sp.county ?? "", course: sp.course ?? "", ...extra })) if (v) p.set(k, String(v));
    return `/admin/applications?${p}`;
  };
  const sel = "rounded-md border border-line bg-white px-3 py-2 text-sm";

  return (
    <>
      <PageHeader title="Applications" description={`${total} matching`} />
      <div className="mb-4 flex flex-wrap gap-2" role="tablist">
        {FILTERS.map((f) => (
          <Link key={f.key} href={qs({ status: f.key, page: "" })} role="tab" aria-selected={f.key === filter.key}
            className={cx("rounded-md border px-3 py-1.5 text-sm", f.key === filter.key ? "border-pine-700 bg-pine-700 text-white" : "border-line bg-white hover:bg-mist")}>
            {f.label}
          </Link>
        ))}
      </div>
      <form className="mb-4 flex flex-wrap gap-2">
        <input type="hidden" name="status" value={filter.key} />
        <input name="q" defaultValue={q} placeholder="Search name or email" aria-label="Search name or email" className="w-64 rounded-md border border-line px-3 py-2 text-sm" />
        <select name="category" defaultValue={sp.category ?? ""} aria-label="Enrollment type and program" className={sel}>
          <option value="">All types and programs</option>
          {CATEGORIES.map((k) => <option key={k} value={k}>{CATEGORY_LABELS[k]}</option>)}
        </select>
        <select name="county" defaultValue={sp.county ?? ""} aria-label="County" className={sel}>
          <option value="">All counties</option>
          {COUNTIES.map((k) => <option key={k} value={k}>{COUNTY_LABELS[k]}</option>)}
        </select>
        <select name="course" defaultValue={sp.course ?? ""} aria-label="Course" className={sel}>
          <option value="">All courses</option>
          {allCourses.map((c) => <option key={c._id} value={c._id}>{c.name}{c.archived ? " (archived)" : ""}</option>)}
        </select>
        <button className="rounded-md border border-line bg-white px-3 py-2 text-sm font-semibold">Filter</button>
      </form>
      {rows.length === 0 ? (
        <Empty>No applications match.</Empty>
      ) : (
        <Table head={["Student", "Enrollment", "Course", "Status", "Payment", "Submitted", ""]}>
          {rows.map((app) => {
            const u = people.get(app.studentId);
            return (
              <tr key={app._id}>
                <Td><p className="font-semibold">{u?.name}</p><p className="text-slate-500">{u?.email}</p></Td>
                <Td>{describeEnrollment(app)}</Td>
                <Td>{app.courseId ? courseMap.get(app.courseId)?.name ?? "-" : "-"}</Td>
                <Td><StatusBadge status={app.status} /></Td>
                <Td>{app.category === "PRIVATE" ? <><StatusBadge status={app.paymentStatus} />{app.paymentStatus === "REQUESTED" && app.paymentRequest && <span className="block text-xs text-slate-600">{formatUsd(app.paymentRequest.amountCents)}</span>}</> : <span className="text-slate-400">n/a</span>}</Td>
                <Td>{fmtDate(app.submittedAt)}</Td>
                <Td><Link href={`/admin/applications/${app._id}`} className="font-semibold text-pine-700 underline">Open</Link></Td>
              </tr>
            );
          })}
        </Table>
      )}
      {total > PAGE && (
        <nav aria-label="Pages" className="mt-4 flex items-center gap-3 text-sm">
          {page > 1 && <Link href={qs({ page: page - 1 })} className="underline">Previous</Link>}
          <span>Page {page} of {Math.ceil(total / PAGE)}</span>
          {page * PAGE < total && <Link href={qs({ page: page + 1 })} className="underline">Next</Link>}
        </nav>
      )}
    </>
  );
}

import Link from "next/link";
import { requireTeacher } from "@/lib/auth";
import { thisMonth } from "@/lib/data";
import { monthTitle, shiftMonth } from "@/lib/sheet";
import { reviewMonth, type ReviewRow } from "@/lib/teacher";

export const dynamic = "force-dynamic";
export const metadata = { title: "My courses" };

const sum = (rows: ReviewRow[], f: (r: ReviewRow) => number) => rows.reduce((t, r) => t + f(r), 0);
const studentsLink = (course: string, month?: string) => `/teacher/students?${new URLSearchParams({ course, ...(month ? { month } : {}) })}`;

/** The teacher's home: each assigned course, with what is left to review. */
export default async function MyCourses() {
  const staff = await requireTeacher();
  const now = thisMonth(), last = shiftMonth(now, -1);
  const [cur, prev] = await Promise.all([reviewMonth(staff, now), reviewMonth(staff, last)]);
  const courses = [...staff.courses].sort();
  return (
    <main className="wrap">
      <h1>My courses</h1>
      {courses.length === 0 ? (
        <p className="msg info">No courses are assigned to you yet. Ask an admin to add your courses.</p>
      ) : (
        <>
          <p className="lead">Open a course to see its students and sign their attendance sheets row by row. The admin signs the “Approved by” section at the bottom of each month.</p>
          <div style={{ overflowX: "auto" }}>
            <table className="tbl">
              <thead>
                <tr><th>Course</th><th>Students in {monthTitle(now).split(" ")[0]}</th><th>Rows to sign</th><th>Filled in later</th><th>{monthTitle(last)} approved</th></tr>
              </thead>
              <tbody>
                {courses.map((c) => {
                  const a = cur.filter((r) => r.course === c), b = prev.filter((r) => r.course === c);
                  const toSign = sum(a, (r) => r.toSign) + sum(b, (r) => r.toSign);
                  const later = sum(a, (r) => r.filledLater) + sum(b, (r) => r.filledLater);
                  const approved = b.filter((r) => r.approval === "approved").length;
                  return (
                    <tr key={c}>
                      <td><Link href={studentsLink(c)}><strong>{c}</strong></Link></td>
                      <td>{a.length}</td>
                      <td>{toSign ? <span className="tag warn">{toSign}</span> : <span className="muted">0</span>}</td>
                      <td>{later ? <span className="tag warn">{later}</span> : <span className="muted">0</span>}</td>
                      <td>{b.length ? <Link href={studentsLink(c, last)}>{approved} of {b.length}</Link> : <span className="muted">–</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="small muted">Rows to sign counts finished days this month and last month that don&apos;t have your signature yet.</p>
        </>
      )}
    </main>
  );
}

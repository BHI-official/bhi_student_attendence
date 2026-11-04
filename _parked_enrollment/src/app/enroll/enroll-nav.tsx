import Link from "next/link";
import type { Application } from "@/db";
import { enrollmentState } from "@/lib/enrollment";
import { GROUP_LABELS, type TemplateGroup } from "@/lib/forms/templates";
import { cx } from "@/components/ui";

type Item = { key: string; href: string; label: string; done: boolean; locked?: boolean; group?: string };

export function EnrollNav({ app, active }: { app: Application; active: string }) {
  if (!app.category) return null;
  const s = enrollmentState(app);
  const docsDone = s.requirements.every((r) => !r.req.required || r.files.length > 0);
  const items: Item[] = [
    { key: "overview", href: "/enroll", label: "Enrollment type", done: true },
    { key: "course", href: "/enroll/course", label: "Course", done: !!app.courseId },
  ];
  let lastGroup: TemplateGroup | null = null;
  for (const f of s.forms) {
    const g = f.template.group;
    items.push({
      key: f.template.key, href: `/enroll/forms/${f.template.key}`, label: f.template.title, done: f.complete && f.signed, locked: s.formsLocked,
      group: g !== lastGroup ? GROUP_LABELS[g] : undefined,
    });
    lastGroup = g;
  }
  items.push({ key: "documents", href: "/enroll/documents", label: "Resume and documents", done: docsDone, locked: s.formsLocked });
  items.push({ key: "review", href: "/enroll/review", label: "Review and submit", done: false });
  return (
    <nav aria-label="Enrollment sections" className="rounded-lg border border-line bg-white p-2 text-sm">
      {items.map((i) => (
        <div key={i.key}>
          {i.group && <p className="px-3 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-slate-500">{i.group}</p>}
          <Link href={i.href} aria-current={active === i.key ? "page" : undefined}
            className={cx("flex items-center justify-between gap-2 rounded px-3 py-2", active === i.key ? "bg-pine-50 font-semibold text-pine-800" : i.locked ? "text-slate-400" : "text-slate-700 hover:bg-mist")}>
            <span>{i.label}</span>
            {i.done && i.key !== "overview" && <span className="text-pine-600" aria-label="complete">✓</span>}
            {i.locked && !i.done && <span aria-label="locked until payment is verified" title="Opens after payment is verified">🔒</span>}
          </Link>
        </div>
      ))}
    </nav>
  );
}

import Link from "next/link";
import type { ReactNode } from "react";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
      <div>
        <h1 className="text-[1.75rem] font-semibold leading-tight tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-[0.95rem] text-slate-600">{description}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ children, className, title, actions }: { children: ReactNode; className?: string; title?: string; actions?: ReactNode }) {
  return (
    <section className={cx("rounded-lg border border-line bg-white", className)}>
      {title && (
        <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
          <h2 className="text-[0.95rem] font-semibold text-ink">{title}</h2>
          {actions}
        </div>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

const btn = {
  primary: "bg-pine-700 text-white hover:bg-pine-800 disabled:bg-slate-400",
  secondary: "border border-line bg-white text-ink hover:bg-mist",
  danger: "bg-brick-600 text-white hover:brightness-95",
  ghost: "text-pine-700 hover:bg-pine-50",
};
export type ButtonVariant = keyof typeof btn;
export const buttonClass = (v: ButtonVariant = "primary", extra?: string) =>
  cx("inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pine-600 disabled:cursor-not-allowed", btn[v], extra);

export function LinkButton({ href, children, variant = "primary" }: { href: string; children: ReactNode; variant?: ButtonVariant }) {
  return <Link href={href} className={buttonClass(variant)}>{children}</Link>;
}

const tones = {
  neutral: "bg-slate-100 text-slate-700",
  pine: "bg-pine-100 text-pine-800",
  marigold: "bg-marigold-100 text-marigold-700",
  brick: "bg-brick-100 text-brick-600",
};
export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: keyof typeof tones }) {
  return <span className={cx("inline-flex items-center rounded px-2 py-0.5 text-xs font-semibold", tones[tone])}>{children}</span>;
}

const STATUS: Record<string, { label: string; tone: keyof typeof tones }> = {
  DRAFT: { label: "Draft", tone: "neutral" },
  SUBMITTED: { label: "Pending", tone: "marigold" },
  RESUBMITTED: { label: "Pending (resubmitted)", tone: "marigold" },
  CORRECTIONS_REQUESTED: { label: "Corrections requested", tone: "brick" },
  APPROVED: { label: "Approved", tone: "pine" },
  REJECTED: { label: "Rejected", tone: "brick" },
  PENDING: { label: "Pending", tone: "marigold" },
  REQUESTED: { label: "Payment requested", tone: "marigold" },
  PAID: { label: "Paid", tone: "pine" },
  WAIVED: { label: "Waived", tone: "neutral" },
  ACTIVE: { label: "Active", tone: "pine" },
  COMPLETED: { label: "Completed", tone: "neutral" },
  WITHDRAWN: { label: "Withdrawn", tone: "neutral" },
  TRANSFERRED: { label: "Transferred", tone: "neutral" },
};
export function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, tone: "neutral" as const };
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function Alert({ tone = "info", children }: { tone?: "info" | "error" | "success" | "warning"; children: ReactNode }) {
  const t = {
    info: "border-pine-100 bg-pine-50 text-pine-900",
    error: "border-brick-100 bg-brick-100/50 text-brick-600",
    success: "border-pine-100 bg-pine-50 text-pine-800",
    warning: "border-marigold-100 bg-marigold-100/60 text-marigold-700",
  }[tone];
  return <div role={tone === "error" ? "alert" : "status"} className={cx("rounded-md border px-4 py-3 text-sm", t)}>{children}</div>;
}

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line px-6 py-10 text-center text-sm text-slate-600">
      <p>{children}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-white">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead className="bg-mist text-xs font-semibold text-slate-600">
          <tr>{head.map((h) => <th key={h} className="px-4 py-2.5">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  );
}

export const Td = ({ children, className }: { children?: ReactNode; className?: string }) => (
  <td className={cx("px-4 py-3 align-top", className)}>{children}</td>
);

export function Stat({ label, value, href }: { label: string; value: number | string; href?: string }) {
  const body = (
    <>
      <div className="text-3xl font-semibold tabular-nums text-ink">{value}</div>
      <div className="mt-1 text-sm text-slate-600">{label}</div>
    </>
  );
  return href ? (
    <Link href={href} className="block rounded-lg border border-line bg-white p-5 hover:border-pine-600">{body}</Link>
  ) : (
    <div className="rounded-lg border border-line bg-white p-5">{body}</div>
  );
}

export function fmtDate(d: Date | string | null | undefined) {
  if (!d) return "-";
  const date = typeof d === "string" ? new Date(d.length === 10 ? d + "T00:00:00" : d) : d;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

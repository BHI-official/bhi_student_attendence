"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function StaffNav({ admin }: { admin: boolean }) {
  const path = usePathname();
  const items = [
    ["/staff", "Today"], ["/staff/sheets", "Monthly sheets"], ["/staff/students", "Students"], ["/staff/reports", "Reports"], ["/staff/holidays", "Holidays"],
    ...(admin ? [["/staff/team", "Staff accounts"]] : []), ["/staff/account", "My account"],
  ];
  return (
    <nav className="nav" aria-label="Staff">
      {items.map(([href, label]) => {
        const on = href === "/staff" ? path === "/staff" : path.startsWith(href);
        return <Link key={href} href={href} aria-current={on ? "page" : undefined}>{label}</Link>;
      })}
    </nav>
  );
}

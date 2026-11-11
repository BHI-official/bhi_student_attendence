"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Navigation for a portal: the first item is its home page (matched exactly), the rest by prefix. */
export function PortalNav({ label, items }: { label: string; items: [href: string, text: string][] }) {
  const path = usePathname();
  const home = items[0]?.[0];
  return (
    <nav className="nav" aria-label={label}>
      {items.map(([href, text]) => {
        const on = href === home ? path === home : path.startsWith(href);
        return <Link key={href} href={href} aria-current={on ? "page" : undefined}>{text}</Link>;
      })}
    </nav>
  );
}

export function AdminNav() {
  return (
    <PortalNav label="Admin" items={[
      ["/admin", "Attendance"], ["/admin/sign-off", "Monthly sign-off"], ["/admin/students", "Students"], ["/admin/reports", "Reports"],
      ["/admin/holidays", "Holidays"], ["/admin/team", "Staff"], ["/admin/account", "My account"],
    ]} />
  );
}

export function TeacherNav() {
  return <PortalNav label="Teacher" items={[["/teacher", "My roster"], ["/teacher/account", "My account"]]} />;
}

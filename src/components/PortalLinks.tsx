import Link from "next/link";

const LINKS = [
  { href: "/student", who: "student", text: "Student? Find your name here", sub: "Sign your attendance for today, this week or last week" },
  { href: "/teacher/login", who: "teacher", text: "Teacher? Sign in here", sub: "Your roster: approve attendance and excuses" },
  { href: "/admin/login", who: "admin", text: "Admin? Sign in here", sub: "All attendance, students and teacher assignments" },
] as const;

/** The big "who are you?" buttons. `except` hides the portal the person is already on. */
export function PortalLinks({ except, compact }: { except?: "student" | "teacher" | "admin"; compact?: boolean }) {
  return (
    <nav className={`portal-links${compact ? " compact" : ""}`} aria-label="Choose who you are">
      {LINKS.filter((l) => l.who !== except).map((l) => (
        <Link key={l.href} href={l.href} className={`portal-link p-${l.who}`}>
          <span className="pl-text">{l.text}</span>
          {!compact && <span className="pl-sub">{l.sub}</span>}
        </Link>
      ))}
    </nav>
  );
}

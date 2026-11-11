import Link from "next/link";
import { BrandMark } from "@/components/Brand";

export default function StudentLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="bar">
        <BrandMark href="/student" subtitle="Student attendance" />
        <nav className="nav" aria-label="Staff sign-in">
          <Link className="btn ghost sm" href="/teacher/login">Teacher? Sign in here</Link>
          <Link className="btn ghost sm" href="/admin/login">Admin</Link>
        </nav>
      </header>
      {children}
    </>
  );
}

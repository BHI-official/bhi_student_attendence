import Link from "next/link";
import { BrandMark } from "@/components/Brand";

export default function StudentLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="bar">
        <BrandMark href="/student" subtitle="Student attendance sheet" />
        <nav className="nav" aria-label="Staff sign-in"><Link href="/teacher">Teachers</Link><Link href="/admin">Admin</Link></nav>
      </header>
      {children}
    </>
  );
}

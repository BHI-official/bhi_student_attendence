import { requireAdmin } from "@/lib/auth";
import { adminLogoutAction } from "@/actions/staff";
import { AdminNav } from "@/components/PortalNav";
import { BrandMark } from "@/components/Brand";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const staff = await requireAdmin();
  return (
    <>
      <header className="bar">
        <BrandMark href="/admin" subtitle="Attendance · admin" />
        <AdminNav />
        <form action={adminLogoutAction}><button className="btn ghost" title={`Signed in as ${staff.name}`}>Sign out</button></form>
      </header>
      {children}
    </>
  );
}

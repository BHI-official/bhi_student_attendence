import { requireTeacher } from "@/lib/auth";
import { teacherLogoutAction } from "@/actions/staff";
import { TeacherNav } from "@/components/PortalNav";
import { BrandMark } from "@/components/Brand";

export default async function TeacherLayout({ children }: { children: React.ReactNode }) {
  const staff = await requireTeacher();
  return (
    <>
      <header className="bar">
        <BrandMark href="/teacher" subtitle="Attendance · teacher" />
        <TeacherNav />
        <form action={teacherLogoutAction}><button className="btn ghost" title={`Signed in as ${staff.name}`}>Sign out</button></form>
      </header>
      {children}
    </>
  );
}

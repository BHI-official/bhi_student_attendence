import { redirect } from "next/navigation";
import { PORTAL, currentStaff } from "@/lib/auth";
import { teacherLoginAction } from "@/actions/staff";
import { StaffLogin } from "@/components/StaffLogin";

export const dynamic = "force-dynamic";
export const metadata = { title: "Teacher sign-in" };

export default async function TeacherLogin() {
  const staff = await currentStaff();
  if (staff) redirect(PORTAL[staff.role].home);
  return <StaffLogin title="Teacher sign-in" lead="Open your roster to take attendance, check signatures and approve them." action={teacherLoginAction} who="teacher" />;
}

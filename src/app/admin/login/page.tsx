import { redirect } from "next/navigation";
import { PORTAL, currentStaff } from "@/lib/auth";
import { adminLoginAction } from "@/actions/staff";
import { StaffLogin } from "@/components/StaffLogin";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin sign-in" };

export default async function AdminLogin() {
  const staff = await currentStaff();
  if (staff) redirect(PORTAL[staff.role].home);
  return <StaffLogin title="Admin sign-in" lead="For the office: all attendance, students and teacher assignments, corrections and excuses." action={adminLoginAction} who="admin" />;
}

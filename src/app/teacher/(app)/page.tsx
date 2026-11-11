import { requireTeacher } from "@/lib/auth";
import { RosterPage, type RosterParams } from "@/components/RosterPage";

export const dynamic = "force-dynamic";
export const metadata = { title: "My roster" };

export default async function TeacherRoster({ searchParams }: { searchParams: Promise<RosterParams> }) {
  const staff = await requireTeacher();
  return <RosterPage staff={staff} sp={await searchParams} base="/teacher" />;
}

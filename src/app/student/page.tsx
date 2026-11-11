import { redirect } from "next/navigation";
import { cols } from "@/lib/db";
import { currentStudent } from "@/lib/auth";
import { today } from "@/lib/data";
import { StudentPicker } from "@/components/StudentPicker";

export const dynamic = "force-dynamic";
export const metadata = { title: "Find your name" };

export default async function StudentHome() {
  if (await currentStudent()) redirect("/student/sheet");
  const date = today();
  // Students currently enrolled (course dates include today, give or take a week).
  const list = await (await cols()).students
    .find({ active: true, endDate: { $gte: date } }, { projection: { name: 1, courseName: 1, nameLower: 1 } })
    .sort({ nameLower: 1 })
    .toArray();
  return (
    <main className="wrap">
      <p className="welcome">Welcome to Bright Horizon Institute</p>
      <h1>Find your name</h1>
      <p className="lead">Then enter your PIN to sign your attendance.</p>
      <StudentPicker students={list.map((s) => ({ id: s._id, name: s.name, course: s.courseName }))} />
    </main>
  );
}

"use server";

import { revalidatePath } from "next/cache";
import { audit, cols, newId, rateLimit, type StudentNote } from "@/lib/db";
import { requireStaff } from "@/lib/auth";
import { canSee } from "@/lib/access";
import { today } from "@/lib/data";
import { DATE_RE, addDays, usDate } from "@/lib/sheet";
import type { ActionState } from "@/lib/action";

const MAX_NOTE = 2000;

const refresh = () => { revalidatePath("/admin", "layout"); revalidatePath("/teacher", "layout"); };

/**
 * An admin, or a teacher of the student's course, adds a dated note to the student. Staff-only:
 * the student never sees notes. The date is the day the note is about (today unless changed).
 */
export async function addStudentNoteAction(studentId: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const staff = await requireStaff();
  if (!/^[0-9a-f-]{36}$/.test(studentId)) return { error: "Student not found." };
  const student = await (await cols()).students.findOne({ _id: studentId }, { projection: { courseName: 1 } });
  if (!student || !canSee(staff, student)) return { error: "Student not found." };
  if (!(await rateLimit(`note:${staff._id}`, 60, 600))) return { error: "Too many notes in a short time. Wait a few minutes." };

  const text = String(fd.get("text") ?? "").trim();
  if (!text) return { error: "Write the note first.", fieldErrors: { text: "Write the note first." } };
  if (text.length > MAX_NOTE) return { error: `Keep the note under ${MAX_NOTE} characters.`, fieldErrors: { text: `Under ${MAX_NOTE} characters, please.` } };
  const date = String(fd.get("date") ?? "").trim() || today();
  // A note can be about a past day or a planned one (e.g. an upcoming absence), within reason.
  if (!DATE_RE.test(date) || date < "2000-01-01" || date > addDays(today(), 366)) {
    return { error: "Choose a valid date.", fieldErrors: { date: "Choose a valid date." } };
  }

  const note: StudentNote = {
    _id: newId(), studentId, date, text, byId: staff._id, byName: staff.name, byRole: staff.role, createdAt: new Date(),
  };
  await (await cols()).notes.insertOne(note);
  await audit(staff._id, "staff.add_student_note", studentId, { noteId: note._id, date });
  refresh();
  return { ok: true, message: `Note added for ${usDate(date)}.` };
}

/** The author deletes their own note; admins can delete any note. The deletion is audited with the text. */
export async function deleteStudentNoteAction(noteId: string, _: ActionState, __: FormData): Promise<ActionState> {
  const staff = await requireStaff();
  const { notes, students } = await cols();
  const note = await notes.findOne({ _id: noteId });
  if (!note) return { ok: true, message: "Note deleted." };
  const student = await students.findOne({ _id: note.studentId }, { projection: { courseName: 1 } });
  if (!student || !canSee(staff, student)) return { error: "Note not found." };
  if (staff.role !== "ADMIN" && note.byId !== staff._id) return { error: "You can only delete your own notes. Ask an admin." };
  await notes.deleteOne({ _id: noteId });
  await audit(staff._id, "staff.delete_student_note", note.studentId, { noteId, date: note.date, by: note.byName, text: note.text });
  refresh();
  return { ok: true, message: "Note deleted." };
}

import "server-only";
import { cols } from "./db";

/** A student's notes, newest day first (and newest written first on the same day). */
export const loadStudentNotes = async (studentId: string) =>
  (await cols()).notes.find({ studentId }).sort({ date: -1, createdAt: -1 }).limit(500).toArray();

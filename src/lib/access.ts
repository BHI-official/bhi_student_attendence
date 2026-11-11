import "server-only";
import type { Filter } from "mongodb";
import type { Staff, Student } from "./types";

/** Admins see every student; a teacher sees only the students assigned to them. */
export const canSee = (staff: Pick<Staff, "_id" | "role">, student: Pick<Student, "teacherId">) =>
  staff.role === "ADMIN" || (!!student.teacherId && student.teacherId === staff._id);

/** The same rule as a database filter, added to every student query a teacher makes. */
export const studentScope = (staff: Pick<Staff, "_id" | "role">): Filter<Student> =>
  staff.role === "ADMIN" ? {} : { teacherId: staff._id };

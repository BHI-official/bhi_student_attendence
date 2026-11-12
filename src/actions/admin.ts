"use server";

import { revalidatePath } from "next/cache";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { EMPTY_PROFILE, audit, cols, isDuplicateKey, newId, type Staff, type Student, type StudentProfile } from "@/lib/db";
import { requireAdmin } from "@/lib/auth";
import { DATE_RE, parseDate, parseStudentsCsv, type StudentInput } from "@/lib/sheet";
import { PIN_RE, weakPin } from "@/lib/pin";
import { freePin, pinKey, pinTaken } from "@/lib/pins";
import type { ActionState } from "@/lib/action";

const refresh = () => { revalidatePath("/admin", "layout"); revalidatePath("/teacher", "layout"); revalidatePath("/student", "layout"); };
/** Checks a PIN typed by staff. Returns a message, or null if it can be used. */
async function typedPinProblem(pin: string, exceptStudentId?: string) {
  if (!PIN_RE.test(pin)) return "4 to 6 digits";
  if (weakPin(pin)) return "Too easy to guess (like 1234 or 0000). Choose another";
  if (await pinTaken(pin, exceptStudentId)) return "Another student already has this PIN. Choose another";
  return null;
}
const DEFAULT_DAYS = [1, 2, 3, 4, 5];

function studentFields(fd: FormData): { value?: Omit<StudentInput, "pin" | "teacherEmail"> & { classDays: number[] }; errors?: Record<string, string> } {
  const get = (k: string) => String(fd.get(k) ?? "").trim();
  const errors: Record<string, string> = {};
  const name = get("name").replace(/\s+/g, " ");
  if (name.length < 2) errors.name = "Enter the student's full name";
  const startDate = parseDate(get("startDate"));
  const endDate = parseDate(get("endDate"));
  if (!startDate) errors.startDate = "Enter the start date";
  if (!endDate) errors.endDate = "Enter the end date";
  if (startDate && endDate && endDate < startDate) errors.endDate = "End date must be after the start date";
  const classDays = [...new Set(fd.getAll("classDays").map(Number).filter((d) => d >= 1 && d <= 5))].sort();
  if (!classDays.length) errors.classDays = "Choose at least one class day";
  if (Object.keys(errors).length) return { errors };
  return {
    value: {
      name, courseName: get("courseName").slice(0, 120), courseCode: get("courseCode").slice(0, 40), courseDuration: get("courseDuration").slice(0, 60),
      caseManager: get("caseManager").slice(0, 120), instructor: get("instructor").slice(0, 120), startDate: startDate!, endDate: endDate!, classDays,
    },
  };
}

/** Add or edit one student. A new student gets the PIN typed in, or a random 4-digit PIN shown once. */
export async function saveStudentAction(studentId: string | null, _: ActionState, fd: FormData): Promise<ActionState> {
  const staff = await requireAdmin();
  const f = studentFields(fd);
  if (!f.value) return { fieldErrors: f.errors };
  const { students } = await cols();
  if (studentId) {
    const res = await students.updateOne({ _id: studentId }, { $set: { ...f.value, nameLower: f.value.name.toLowerCase() } });
    if (!res.matchedCount) return { error: "Student not found." };
    await audit(staff._id, "admin.edit_student", studentId, f.value);
    refresh();
    return { ok: true, message: "Saved." };
  }
  const typed = String(fd.get("pin") ?? "").trim();
  if (typed) {
    const problem = await typedPinProblem(typed);
    if (problem) return { fieldErrors: { pin: problem } };
  }
  const teacherId = String(fd.get("teacherId") ?? "");
  const teacher = teacherId ? await activeTeacher(teacherId) : null;
  if (teacherId && !teacher) return { fieldErrors: { teacherId: "Choose a teacher from the list" } };
  const pin = typed || (await freePin());
  const s: Student = {
    _id: newId(), ...f.value, nameLower: f.value.name.toLowerCase(), pinHash: await bcrypt.hash(pin, 10), pinKey: pinKey(pin),
    teacherId: null, profile: { ...EMPTY_PROFILE }, active: true, createdAt: new Date(),
  };
  try {
    await students.insertOne(s);
  } catch (e) {
    if (isDuplicateKey(e)) return { fieldErrors: { pin: "Another student just got this PIN. Try again." } };
    throw e;
  }
  await audit(staff._id, "admin.add_student", s._id, { name: s.name });
  if (teacher) await setTeacher(s, teacher, staff);
  refresh();
  return { ok: true, message: `${s.name} added. Their PIN is ${pin}. Give it to them now; it isn't shown again.`, data: { id: s._id, pin } };
}

/**
 * Imports many students from a CSV file (header row + one row per student). Nothing is saved if any
 * row has a problem, so a file is never half-imported. Returns each new student's PIN once.
 */
export async function importStudentsAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const staff = await requireAdmin();
  const file = fd.get("file");
  if (!(file instanceof File) || !file.size) return { error: "Choose a CSV file." };
  if (file.size > 2_000_000) return { error: "The file is too big (2 MB max)." };
  const { students: rows, errors } = parseStudentsCsv(await file.text());
  if (errors.length) return { error: `Nothing was imported. Fix these and try again: ${errors.slice(0, 8).join(" ")}${errors.length > 8 ? ` (${errors.length - 8} more)` : ""}` };
  if (!rows.length) return { error: "The file has no students." };
  if (rows.length > 2000) return { error: "Import at most 2,000 students at a time." };
  const { students } = await cols();
  const existing = new Set((await students.find({ nameLower: { $in: rows.map((r) => r.name.toLowerCase()) }, active: true }, { projection: { nameLower: 1 } }).toArray()).map((s) => s.nameLower));
  const skip = rows.filter((r) => existing.has(r.name.toLowerCase()));
  const add = rows.filter((r) => !existing.has(r.name.toLowerCase()));
  // PINs typed in the file must be unique (in the file and among active students), and not trivial.
  const typedSeen = new Map<string, string>();
  const pinErrors: string[] = [];
  for (const r of add) {
    if (!r.pin) continue;
    if (weakPin(r.pin)) pinErrors.push(`${r.name}: PIN ${r.pin} is too easy to guess.`);
    else if (typedSeen.has(r.pin)) pinErrors.push(`${r.name}: same PIN as ${typedSeen.get(r.pin)}.`);
    else if (await pinTaken(r.pin)) pinErrors.push(`${r.name}: PIN ${r.pin} is already used by another student.`);
    typedSeen.set(r.pin, r.name);
  }
  if (pinErrors.length) return { error: `Nothing was imported. Every student needs their own PIN: ${pinErrors.slice(0, 8).join(" ")}${pinErrors.length > 8 ? ` (${pinErrors.length - 8} more)` : ""} Leave the pin column empty to get random ones.` };
  // Optional teacherEmail column: the teacher whose roster the student goes on.
  const { staff: staffCol } = await cols();
  const emails = [...new Set(add.map((r) => r.teacherEmail).filter(Boolean))];
  const teachers = new Map((await staffCol.find({ email: { $in: emails }, role: "TEACHER", active: true }).toArray()).map((t) => [t.email, t]));
  const unknown = emails.filter((e) => !teachers.has(e));
  if (unknown.length) {
    const admins = (await staffCol.find({ email: { $in: unknown }, role: "ADMIN" }, { projection: { email: 1 } }).toArray()).map((x) => x.email);
    const list = (xs: string[]) => `${xs.slice(0, 5).join(", ")}${xs.length > 5 ? "…" : ""}`;
    const missing = unknown.filter((e) => !admins.includes(e));
    return {
      error: "Nothing was imported. "
        + (admins.length ? `${list(admins)} ${admins.length === 1 ? "is an admin account" : "are admin accounts"}; only teacher accounts can have students (change the role on the Staff page). ` : "")
        + (missing.length ? `No active teacher has the email ${list(missing)}. Add the teacher first, or leave teacherEmail empty.` : ""),
    };
  }
  const used = new Set(typedSeen.keys());
  const pins: { name: string; pin: string }[] = [];
  const docs: Student[] = [];
  for (const r of add) {
    const pin = r.pin || (await freePin(used));
    used.add(pin);
    pins.push({ name: r.name, pin });
    docs.push({
      _id: newId(), name: r.name, nameLower: r.name.toLowerCase(), pinHash: await bcrypt.hash(pin, 10), pinKey: pinKey(pin), courseName: r.courseName, courseCode: r.courseCode,
      courseDuration: r.courseDuration, caseManager: r.caseManager, instructor: r.instructor, startDate: r.startDate, endDate: r.endDate,
      classDays: DEFAULT_DAYS, teacherId: null, profile: { ...EMPTY_PROFILE }, active: true, createdAt: new Date(),
    });
  }
  if (docs.length) {
    try {
      // ordered: false would leave a half-imported file; ordered stops at the first problem and we undo it.
      await students.insertMany(docs);
    } catch (e) {
      await students.deleteMany({ _id: { $in: docs.map((d) => d._id) } });
      if (isDuplicateKey(e)) return { error: "Nothing was imported: a PIN was given to another student at the same moment. Import the file again." };
      throw e;
    }
  }
  for (const [i, d] of docs.entries()) {
    const t = add[i].teacherEmail ? teachers.get(add[i].teacherEmail) : null;
    if (t) await setTeacher(d, t, staff);
  }
  await audit(staff._id, "admin.import_students", "students", { added: docs.length, skipped: skip.length });
  refresh();
  return {
    ok: true,
    message: `${docs.length} student${docs.length === 1 ? "" : "s"} imported.${skip.length ? ` ${skip.length} already existed and were skipped: ${skip.slice(0, 5).map((s) => s.name).join(", ")}${skip.length > 5 ? "…" : ""}.` : ""}`,
    data: { pins },
  };
}

/**
 * New PIN for a student (forgot it, or their PIN is from before PINs were unique). Admins only.
 * The admin can type one, or leave it empty for a random one. Shown once.
 */
export async function resetPinAction(studentId: string, _: ActionState, fd?: FormData): Promise<ActionState> {
  const staff = await requireAdmin();
  const { students } = await cols();
  const student = await students.findOne({ _id: studentId });
  if (!student) return { error: "Student not found." };
  const typed = String(fd?.get("pin") ?? "").trim();
  if (typed) {
    const problem = await typedPinProblem(typed, studentId);
    if (problem) return { fieldErrors: { pin: problem } };
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const pin = typed || (await freePin());
    try {
      await students.updateOne({ _id: studentId }, { $set: { pinHash: await bcrypt.hash(pin, 10), pinKey: pinKey(pin) } });
    } catch (e) {
      if (isDuplicateKey(e) && !typed) continue; // someone else got it a moment ago: pick another
      if (isDuplicateKey(e)) return { fieldErrors: { pin: "Another student already has this PIN. Choose another" } };
      throw e;
    }
    await audit(staff._id, "admin.reset_pin", studentId);
    refresh();
    return { ok: true, message: `New PIN for ${student.name}: ${pin}. Give it to them now; it isn't shown again.` };
  }
  return { error: "Couldn't set a new PIN. Try again." };
}

export async function setStudentActiveAction(studentId: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const staff = await requireAdmin();
  const active = fd.get("active") === "1";
  try {
    const res = await (await cols()).students.updateOne({ _id: studentId }, { $set: { active } });
    if (!res.matchedCount) return { error: "Student not found." };
  } catch (e) {
    // Back on the list, but a student added since then has the same PIN.
    if (isDuplicateKey(e)) return { error: "Another active student now has this student's PIN. Give them a new PIN first, then put them back on the list." };
    throw e;
  }
  await audit(staff._id, active ? "admin.reactivate_student" : "admin.deactivate_student", studentId);
  refresh();
  return { ok: true, message: active ? "Student is active again." : "Student removed from the sign-in list. Their sheets are kept." };
}

export async function addHolidayAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const staff = await requireAdmin();
  const date = parseDate(String(fd.get("date") ?? ""));
  const name = String(fd.get("name") ?? "").trim().slice(0, 60) || "Holiday";
  const note = String(fd.get("note") ?? "").trim().slice(0, 120);
  if (!date || !DATE_RE.test(date)) return { fieldErrors: { date: "Choose a date" } };
  await (await cols()).holidays.updateOne({ _id: date }, { $set: { name, note } }, { upsert: true });
  await audit(staff._id, "admin.add_holiday", date, { name, note });
  refresh();
  return { ok: true, message: "Holiday added. It shows on every student's sheet." };
}

export async function removeHolidayAction(date: string, _: ActionState): Promise<ActionState> {
  const staff = await requireAdmin();
  await (await cols()).holidays.deleteOne({ _id: date });
  await audit(staff._id, "admin.remove_holiday", date);
  refresh();
  return { ok: true, message: "Holiday removed." };
}

const staffSchema = z.object({
  name: z.string().trim().min(2, "Enter the name").max(80),
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  position: z.string().trim().max(80).default(""),
  role: z.enum(["ADMIN", "TEACHER"]),
  password: z.string().min(10, "At least 10 characters"),
});

/** Admin creates a teacher or admin account with a temporary password (they change it after signing in). */
export async function createStaffAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const p = staffSchema.safeParse(Object.fromEntries(fd));
  if (!p.success) return { fieldErrors: Object.fromEntries(p.error.issues.map((i) => [String(i.path[0]), i.message])) };
  try {
    await (await cols()).staff.insertOne({
      _id: newId(), name: p.data.name, email: p.data.email, position: p.data.position, role: p.data.role,
      passwordHash: await bcrypt.hash(p.data.password, 12), active: true, createdAt: new Date(),
    });
  } catch (e) {
    if (isDuplicateKey(e)) return { fieldErrors: { email: "That email already has an account" } };
    throw e;
  }
  await audit(admin._id, "admin.create_staff", p.data.email);
  refresh();
  return { ok: true, message: `${p.data.name} can now sign in on the ${p.data.role === "ADMIN" ? "admin (/admin/login)" : "teacher (/teacher/login)"} page with ${p.data.email} and the temporary password.` };
}

export async function setStaffActiveAction(staffId: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  if (staffId === admin._id) return { error: "You can't turn off your own account." };
  const active = fd.get("active") === "1";
  await (await cols()).staff.updateOne({ _id: staffId }, { $set: { active } });
  await audit(admin._id, active ? "admin.enable_staff" : "admin.disable_staff", staffId);
  refresh();
  return { ok: true, message: active ? "Account turned on." : "Account turned off." };
}

/**
 * Admin: make an account a teacher or an admin (for example Mahek, who signs the month as admin).
 * Not your own account, so the school always keeps at least one admin. Signatures already on rows
 * and approvals stay as they are; the change only decides what the account does from now on.
 */
export async function setStaffRoleAction(staffId: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  if (staffId === admin._id) return { error: "You can't change your own role." };
  const role = z.enum(["ADMIN", "TEACHER"]).safeParse(fd.get("role"));
  if (!role.success) return { error: "Choose teacher or admin." };
  const { staff } = await cols();
  const before = await staff.findOne({ _id: staffId }, { projection: { role: 1, name: 1 } });
  if (!before) return { error: "Account not found." };
  if (before.role === role.data) return { ok: true, message: "Nothing changed." };
  await staff.updateOne({ _id: staffId }, { $set: { role: role.data, ...(role.data === "TEACHER" ? { signsOff: false } : {}) } });
  await audit(admin._id, "admin.set_role", staffId, { from: before.role, to: role.data });
  refresh();
  return { ok: true, message: `${before.name} is now ${role.data === "ADMIN" ? "an admin: they sign in on the admin page and see every student" : "a teacher: they sign in on the teacher page and see the students assigned to them"}.` };
}


/** Admin sets a new temporary password for a staff member who forgot theirs. */
export async function resetStaffPasswordAction(staffId: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const password = String(fd.get("password") ?? "");
  if (password.length < 10) return { fieldErrors: { password: "At least 10 characters" } };
  const res = await (await cols()).staff.updateOne({ _id: staffId }, { $set: { passwordHash: await bcrypt.hash(password, 12) } });
  if (!res.matchedCount) return { error: "Account not found." };
  await audit(admin._id, "admin.reset_staff_password", staffId);
  return { ok: true, message: "Temporary password set. They're signed out everywhere and can sign in with it." };
}



const profileSchema = z.object({
  phone: z.string().trim().max(40).default(""),
  email: z.union([z.literal(""), z.string().trim().toLowerCase().email("Enter a valid email")]).default(""),
  address: z.string().trim().max(200).default(""),
  emergencyName: z.string().trim().max(120).default(""),
  emergencyPhone: z.string().trim().max(40).default(""),
  social: z.string().trim().max(2000).default(""),
});

/** Contact and social details on the student profile. Admins only. */
export async function saveStudentProfileAction(studentId: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const staff = await requireAdmin();
  const get = (k: string) => String(fd.get(k) ?? "");
  const p = profileSchema.safeParse({ phone: get("phone"), email: get("email").trim(), address: get("address"), emergencyName: get("emergencyName"), emergencyPhone: get("emergencyPhone"), social: get("social") });
  if (!p.success) return { fieldErrors: Object.fromEntries(p.error.issues.map((i) => [String(i.path[0]), i.message])) };
  const profile: StudentProfile = p.data;
  const res = await (await cols()).students.updateOne({ _id: studentId }, { $set: { profile } });
  if (!res.matchedCount) return { error: "Student not found." };
  await audit(staff._id, "admin.edit_student_profile", studentId, { fields: Object.keys(profile).filter((k) => profile[k as keyof StudentProfile]) });
  refresh();
  return { ok: true, message: "Profile saved." };
}

// ---------- Teacher assignment ----------

async function activeTeacher(id: string) {
  if (!z.string().uuid().safeParse(id).success) return null;
  return (await cols()).staff.findOne({ _id: id, role: "TEACHER", active: true });
}

/**
 * Puts a student on a teacher's roster (or on nobody's). Only the student's teacher changes: their
 * attendance rows, signatures, hours and approvals are never touched. Days already approved keep
 * the teacher who approved them; pending days simply show on the new teacher's roster, and new
 * submissions go there too. Each change closes the previous assignment period and opens a new one,
 * so the history of who managed the student, and when, is kept.
 */
async function setTeacher(student: Pick<Student, "_id" | "name"> & { teacherId?: string | null }, teacher: Pick<Staff, "_id" | "name"> | null, by: Pick<Staff, "_id" | "name">) {
  const { students, assignments } = await cols();
  const now = new Date();
  await students.updateOne({ _id: student._id }, { $set: { teacherId: teacher?._id ?? null } });
  await assignments.updateMany({ studentId: student._id, to: null }, { $set: { to: now } });
  if (teacher) {
    await assignments.insertOne({ _id: newId(), studentId: student._id, teacherId: teacher._id, teacherName: teacher.name, from: now, to: null, byId: by._id, byName: by.name });
  }
  await audit(by._id, "admin.assign_teacher", student._id, { from: student.teacherId ?? null, to: teacher?._id ?? null, toName: teacher?.name ?? null });
}

/** How many of a student's days are waiting for approval (they move to the new teacher). */
const pendingCount = async (studentId: string) =>
  (await cols()).entries.countDocuments({ studentId, status: "PRESENT", staffSignature: null, studentSignature: { $ne: null } });

/** Admin: put one student on a teacher's roster, or change their teacher. */
export async function assignTeacherAction(studentId: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const teacherId = String(fd.get("teacherId") ?? "");
  const { students } = await cols();
  const student = await students.findOne({ _id: studentId });
  if (!student) return { error: "Student not found." };
  const teacher = teacherId ? await activeTeacher(teacherId) : null;
  if (teacherId && !teacher) return { error: "Choose a teacher from the list." };
  if ((student.teacherId ?? null) === (teacher?._id ?? null)) return { ok: true, message: "Nothing changed." };
  await setTeacher(student, teacher, admin);
  refresh();
  const pending = await pendingCount(student._id);
  return {
    ok: true,
    message: teacher
      ? `${student.name} is now on ${teacher.name}'s roster.${pending ? ` ${pending} pending day${pending === 1 ? "" : "s"} moved with them.` : ""} Their attendance records are unchanged.`
      : `${student.name} is no longer assigned to a teacher. Their attendance records are unchanged.`,
  };
}

/** Admin: put many students on one teacher's roster at once (ticked on the Students page). */
export async function bulkAssignTeacherAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const ids = z.array(z.string().uuid()).min(1).max(2000).safeParse(fd.getAll("ids").map(String));
  if (!ids.success) return { error: "Tick the students to assign first." };
  const teacherId = String(fd.get("teacherId") ?? "");
  const teacher = teacherId ? await activeTeacher(teacherId) : null;
  if (teacherId && !teacher) return { error: "Choose a teacher from the list." };
  let moved = 0;
  for (const s of await (await cols()).students.find({ _id: { $in: ids.data } }).toArray()) {
    if ((s.teacherId ?? null) === (teacher?._id ?? null)) continue;
    await setTeacher(s, teacher, admin);
    moved++;
  }
  refresh();
  return { ok: true, message: moved ? `${moved} student${moved === 1 ? "" : "s"} ${teacher ? `moved to ${teacher.name}'s roster` : "unassigned"}. Attendance records are unchanged.` : "Nothing changed." };
}

// ---------- Staff details and the "Approved by" signer ----------

/** Admin: a staff member's name and position, as printed on the sheet ("STAFF NAME/POSITION"). */
export async function setStaffDetailsAction(staffId: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const name = String(fd.get("name") ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
  const position = String(fd.get("position") ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
  if (name.length < 2) return { fieldErrors: { name: "Enter the name" } };
  const res = await (await cols()).staff.updateOne({ _id: staffId }, { $set: { name, position } });
  if (!res.matchedCount) return { error: "Account not found." };
  await audit(admin._id, "admin.set_staff_details", staffId, { name, position });
  refresh();
  return { ok: true, message: "Saved. New signatures use this name and position; earlier ones keep theirs." };
}

/**
 * Admin: choose who signs the "Approved by" section at the bottom of each month (for example Mahek).
 * Admin accounts only. Only these accounts can sign off months.
 */
export async function setStaffSignsOffAction(staffId: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const admin = await requireAdmin();
  const on = fd.get("signsOff") === "1";
  const { staff } = await cols();
  const s = await staff.findOne({ _id: staffId }, { projection: { role: 1, name: 1 } });
  if (!s) return { error: "Account not found." };
  if (on && s.role !== "ADMIN") return { error: "Only an admin account can sign the “Approved by” section." };
  await staff.updateOne({ _id: staffId }, { $set: { signsOff: on } });
  await audit(admin._id, on ? "admin.signs_off_on" : "admin.signs_off_off", staffId);
  refresh();
  return { ok: true, message: on ? `${s.name} now signs the “Approved by” section of each month.` : `${s.name} no longer signs off months.` };
}

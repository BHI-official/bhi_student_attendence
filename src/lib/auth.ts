import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SignJWT, jwtVerify } from "jose";
import { cols, type Staff, type Student } from "./db";
import { env } from "./env";

const STAFF_COOKIE = "bhi_att_staff";
const STUDENT_COOKIE = "bhi_att_student";
const STAFF_HOURS = 12;
/** Students often share a tablet, so their session is short; the page also signs out after inactivity. */
export const STUDENT_MINUTES = 15;

const key = () => new TextEncoder().encode(env().SESSION_SECRET);
const secure = () => env().NODE_ENV === "production";

async function sign(claims: Record<string, string>, seconds: number) {
  return new SignJWT(claims).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + seconds).sign(key());
}
async function read(name: string) {
  const token = (await cookies()).get(name)?.value;
  if (!token) return null;
  try {
    return (await jwtVerify(token, key(), { algorithms: ["HS256"] })).payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------- Staff ----------

export async function startStaffSession(staff: Staff) {
  // The password hash's tail is in the token: changing a password signs out every other session.
  const token = await sign({ sid: staff._id, pv: staff.passwordHash.slice(-12) }, STAFF_HOURS * 3600);
  (await cookies()).set(STAFF_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: secure(), path: "/", maxAge: STAFF_HOURS * 3600 });
}
export async function endStaffSession() {
  (await cookies()).delete(STAFF_COOKIE);
}
export async function currentStaff(): Promise<Staff | null> {
  const c = await read(STAFF_COOKIE);
  if (!c || typeof c.sid !== "string") return null;
  const staff = await (await cols()).staff.findOne({ _id: c.sid, active: true });
  return staff && staff.passwordHash.slice(-12) === c.pv ? staff : null;
}
/** Where each portal signs in, and its home page. */
export const PORTAL = {
  ADMIN: { home: "/admin", login: "/admin/login" },
  TEACHER: { home: "/teacher", login: "/teacher/login" },
} as const;

/**
 * Any signed-in admin or teacher. Used by actions both roles may take (sign the staff column,
 * comment, approve a month, their own account). Pages use requireAdmin / requireTeacher.
 */
export async function requireStaff(): Promise<Staff> {
  const staff = await currentStaff();
  if (!staff) redirect(PORTAL.ADMIN.login);
  return staff;
}
/** Admins only. A teacher who reaches an admin page is sent to the teacher portal. */
export async function requireAdmin(): Promise<Staff> {
  const staff = await currentStaff();
  if (!staff) redirect(PORTAL.ADMIN.login);
  if (staff.role !== "ADMIN") redirect(PORTAL.TEACHER.home);
  return staff;
}
/** Teachers only. An admin who reaches a teacher page is sent to the admin portal. */
export async function requireTeacher(): Promise<Staff> {
  const staff = await currentStaff();
  if (!staff) redirect(PORTAL.TEACHER.login);
  if (staff.role !== "TEACHER") redirect(PORTAL.ADMIN.home);
  return staff;
}

// ---------- Student ----------

export async function startStudentSession(studentId: string) {
  const token = await sign({ st: studentId }, STUDENT_MINUTES * 60);
  (await cookies()).set(STUDENT_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: secure(), path: "/", maxAge: STUDENT_MINUTES * 60 });
}
export async function endStudentSession() {
  (await cookies()).delete(STUDENT_COOKIE);
}
export async function currentStudent(): Promise<Student | null> {
  const c = await read(STUDENT_COOKIE);
  if (!c || typeof c.st !== "string") return null;
  return (await cols()).students.findOne({ _id: c.st, active: true });
}

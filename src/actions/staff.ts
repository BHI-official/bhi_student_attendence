"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { Binary } from "mongodb";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { audit, cols, newId, rateLimit, type Entry, type EntryStatus, type Excuse, type RowComment, type Staff } from "@/lib/db";
import { PORTAL, endStaffSession, requireStaff, startStaffSession } from "@/lib/auth";
import { holidaysBetween, thisMonth, today } from "@/lib/data";
import { DATE_RE, MONTH_RE, addDays, isClassDay, monthTitle, usDate } from "@/lib/sheet";
import { entriesHash } from "@/lib/hash";
import { canSee } from "@/lib/access";
import { loadRoster } from "@/lib/roster";
import { checkSignaturePng, checkTimePng, saveSignature } from "@/lib/signatures";
import { EXCUSE_MAX_BYTES, STATUS_LABEL, dayStatus, isWeekday, safeFileName, sniffExcuse, teacherLock } from "@/lib/week";
import type { ActionState } from "@/lib/action";

const refresh = () => { revalidatePath("/admin", "layout"); revalidatePath("/teacher", "layout"); revalidatePath("/student", "layout"); };

/**
 * Admins and teachers each have their own sign-in page. The password is checked first, so the
 * "wrong page" hint only appears to someone who already knows the password.
 */
async function signIn(role: "ADMIN" | "TEACHER", fd: FormData): Promise<ActionState> {
  const email = String(fd.get("email") ?? "").trim().toLowerCase();
  const password = String(fd.get("password") ?? "");
  if (!email || !password) return { error: "Enter your email and password." };
  if (!(await rateLimit(`login:${email}`, 8, 900))) return { error: "Too many tries. Wait 15 minutes." };
  const staff = await (await cols()).staff.findOne({ email, active: true });
  if (!staff || !(await bcrypt.compare(password, staff.passwordHash))) return { error: "Email or password is incorrect." };
  if (staff.role !== role) {
    return { error: staff.role === "ADMIN" ? "This is an admin account. Use the admin sign-in page." : "This is a teacher account. Use the teacher sign-in page." };
  }
  await startStaffSession(staff);
  await audit(staff._id, role === "ADMIN" ? "admin.login" : "teacher.login", staff._id);
  redirect(PORTAL[role].home);
}
export async function adminLoginAction(_: ActionState, fd: FormData) { return signIn("ADMIN", fd); }
export async function teacherLoginAction(_: ActionState, fd: FormData) { return signIn("TEACHER", fd); }

export async function adminLogoutAction() {
  await endStaffSession();
  redirect(PORTAL.ADMIN.login);
}
export async function teacherLogoutAction() {
  await endStaffSession();
  redirect(PORTAL.TEACHER.login);
}

// ---------- The roster: approve, send back, present / absent, excuses ----------

const entries = async () => (await cols()).entries;
const ROW_KEY = /^[0-9a-f-]{36}:\d{4}-\d{2}-\d{2}$/;
const rowKeys = (raw: unknown) => {
  try {
    const p = z.array(z.string().regex(ROW_KEY)).min(1).max(3000).safeParse(JSON.parse(String(raw ?? "[]")));
    return p.success ? [...new Set(p.data)] : null;
  } catch {
    return null;
  }
};

/** The student and row behind a roster key, if this staff member may act on it. */
async function rowFor(staff: Staff, key: string) {
  const [studentId, date] = [key.slice(0, 36), key.slice(37)];
  const { students, entries } = await cols();
  const student = await students.findOne({ _id: studentId });
  if (!student || !canSee(staff, student)) return { ok: false, error: "not one of your students" } as const;
  if (date > today()) return { ok: false, error: `${usDate(date)} hasn't happened yet` } as const;
  const holiday = (await holidaysBetween(date, date)).has(date);
  const entry = await entries.findOne({ _id: key });
  // Once the admin has signed off the month, only admins change it.
  const signed = await (await cols()).approvals.findOne({ _id: `${studentId}:${date.slice(0, 7)}` }, { projection: { staffName: 1 } });
  if (signed && staff.role !== "ADMIN") return { ok: false, error: `${student.name}'s ${monthTitle(date.slice(0, 7))} is signed off by ${signed.staffName}` } as const;
  return { ok: true, student, date, entry, holiday, status: dayStatus(entry, holiday, date, today()) } as const;
}

const summarize = (done: number, verb: string, problems: string[]) => {
  const extra = problems.length ? ` Skipped: ${problems.slice(0, 4).join("; ")}${problems.length > 4 ? ` and ${problems.length - 4} more` : ""}.` : "";
  return done ? { ok: true, message: `${verb} ${done} day${done === 1 ? "" : "s"}.${extra}` } : { error: `Nothing changed.${extra}` };
};

type Row = Extract<Awaited<ReturnType<typeof rowFor>>, { ok: true }>;
type StaffSig = { id: string; at: Date; staffId: string; staffName: string };

/** Approve one signed day with the teacher's signature. Returns why not, or null when done. */
async function approveOne(staff: Staff, key: string, r: Row, signature: StaffSig, now: Date): Promise<string | null> {
  const who = `${r.student.name} ${usDate(r.date)}`;
  const e = r.entry;
  if (r.status === "APPROVED") return `${who} is already approved`;
  if (!e || e.status !== "PRESENT" || !e.studentSignature) return `${who} has no signed submission`;
  const res = await (await entries()).updateOne(
    { _id: key, staffSignature: null, status: "PRESENT", "studentSignature.id": e.studentSignature.id },
    {
      $set: { staffSignature: signature, correction: null, updatedAt: now },
      $push: { history: { at: now, byId: staff._id, byName: staff.name, what: "checked and signed by teacher", reason: "" } },
    },
  );
  return res.modifiedCount ? null : `${who} changed in the meantime`;
}

/** Mark one day present or absent. Returns why not, or null when done. */
async function markOne(staff: Staff, key: string, r: Row, mark: "PRESENT" | "ABSENT", now: Date): Promise<string | null> {
  const who = `${r.student.name} ${usDate(r.date)}`;
  if (staff.role !== "ADMIN" && teacherLock(r.date, today())) return `${who} is locked`;
  if (!isClassDay(r.student, r.date)) return `${who} isn't a class day`;
  if (r.status === "HOLIDAY") return `${who} is a holiday`;
  if (r.status === "APPROVED") return `${who} is approved (an admin can change it)`;
  if (r.status === "EXCUSED") return `${who} is excused (an admin can change it)`;
  const col = await entries();
  const markedBy = { staffId: staff._id, staffName: staff.name, at: now, mark };
  const history = { at: now, byId: staff._id, byName: staff.name, what: `marked ${mark === "PRESENT" ? "present" : "absent"}`, reason: "" };
  if (!r.entry) {
    const row: Entry = {
      _id: key, studentId: r.student._id, date: r.date, status: mark, startAt: null, endAt: null, startTime: null, endTime: null, minutes: null,
      studentSignature: null, staffSignature: null, correction: null, markedBy, excuse: null, note: "", comments: [], history: [history], updatedAt: now,
    };
    try { await col.insertOne(row); return null; } catch { return `${who} changed in the meantime`; }
  }
  if (r.entry.status === mark && r.entry.markedBy?.mark === mark) return null;
  const res = await col.updateOne(
    { _id: key, updatedAt: r.entry.updatedAt, staffSignature: null, status: { $in: ["PRESENT", "ABSENT"] } },
    { $set: { status: mark, markedBy, updatedAt: now }, $push: { history } },
  );
  return res.modifiedCount ? null : `${who} changed in the meantime`;
}

/**
 * Approve signed attendance: the student's assigned teacher verifies and signs by hand. One signature
 * covers every day they ticked, and is stored on each of those days. Only days the student has
 * signed can be approved. Pending days can be approved at any time (they wait for this teacher).
 */
export async function approveRowsAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const staff = await requireStaff();
  // The teacher signature column is the student's own teacher's handwritten signature, nobody else's.
  if (staff.role !== "TEACHER") return { error: "Only the student's teacher signs the teacher signature column. Admins can send a day back or correct it." };
  const keys = rowKeys(fd.get("rows"));
  if (!keys) return { error: "Choose the days to approve." };
  const sig = checkSignaturePng(fd.get("signature"));
  if ("error" in sig) return { error: "Sign by hand to approve." };
  const now = new Date();
  const sigId = await saveSignature("STAFF", staff._id, sig.png, "DRAWN", staff._id);
  const signature = { id: sigId, at: now, staffId: staff._id, staffName: staff.name };
  let done = 0;
  const problems: string[] = [];
  for (const key of keys) {
    const r = await rowFor(staff, key);
    const problem = r.ok ? await approveOne(staff, key, r, signature, now) : r.error;
    if (problem) problems.push(problem); else done++;
  }
  await audit(staff._id, "staff.approve", "entries", { approved: done, skipped: problems.length, signatureId: sigId, rows: keys.length });
  refresh();
  return summarize(done, "Approved and signed", problems);
}

/**
 * Send a submission back to the student: "Needs correction", with the reason they see. The
 * student fills the day in again (and signs again). Teachers: days not approved yet. Admins can
 * also reopen an approved day; the approval is kept in the row's history.
 */
export async function rejectRowAction(key: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const staff = await requireStaff();
  if (!ROW_KEY.test(key)) return { error: "Invalid day." };
  const reason = String(fd.get("reason") ?? "").trim().slice(0, 300);
  if (reason.length < 3) return { error: "Tell the student what to fix.", fieldErrors: { reason: "Tell the student what to fix." } };
  const r = await rowFor(staff, key);
  if (!r.ok) return { error: `This day is ${r.error}.` };
  const e = r.entry;
  if (!e || e.status !== "PRESENT" || !e.studentSignature) return { error: "There is no signed submission to send back." };
  if (e.staffSignature && staff.role !== "ADMIN") return { error: `Already approved by ${e.staffSignature.staffName}. Ask an admin.` };
  const now = new Date();
  const comment: RowComment = { id: newId(), at: now, byId: staff._id, byName: staff.name, byRole: staff.role, text: `Needs correction: ${reason}`, inkId: null };
  const res = await (await entries()).updateOne(
    { _id: key, updatedAt: e.updatedAt },
    {
      $set: { correction: { byId: staff._id, byName: staff.name, at: now, reason }, staffSignature: null, updatedAt: now },
      $push: {
        history: { at: now, byId: staff._id, byName: staff.name, what: `sent back to student${e.staffSignature ? ` (approval by ${e.staffSignature.staffName} removed)` : ""}`, reason },
        comments: comment,
      },
    },
  );
  if (!res.modifiedCount) return { error: "This day changed in the meantime. Reload the page." };
  await audit(staff._id, "staff.reject", key, { reason, removedApproval: e.staffSignature ?? null });
  refresh();
  return { ok: true, message: `Sent back to ${r.student.name} for ${usDate(r.date)}.` };
}
/**
 * Taking attendance: mark students Present or Absent for days. Marking present is not approving:
 * a student who hasn't signed stays "signature missing" until they do. Teachers: this week and
 * last week, not approved or excused days. Times and signatures the student wrote are kept.
 */
export async function markRowsAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const staff = await requireStaff();
  const keys = rowKeys(fd.get("rows"));
  if (!keys) return { error: "Choose the students to mark." };
  const mark = z.enum(["PRESENT", "ABSENT"]).safeParse(fd.get("mark"));
  if (!mark.success) return { error: "Choose present or absent." };
  const now = new Date();
  let done = 0;
  const problems: string[] = [];
  for (const key of keys) {
    const r = await rowFor(staff, key);
    const problem = r.ok ? await markOne(staff, key, r, mark.data, now) : r.error;
    if (problem) problems.push(problem); else done++;
  }
  await audit(staff._id, "staff.mark", "entries", { mark: mark.data, marked: done, skipped: problems.length });
  refresh();
  return summarize(done, `Marked ${mark.data === "PRESENT" ? "present" : "absent"}:`, problems);
}

/**
 * The whole class for one day, with one handwritten signature. The teacher taps who was absent;
 * everyone else on their roster that day counts as present. Absent ones are marked absent; present
 * ones who have signed are approved with the teacher's signature; present ones who haven't signed
 * yet are marked present and listed (their day shows "signature missing" until they sign, then it
 * waits for the teacher again). The list of students comes from the teacher's roster on the
 * server, never from the browser.
 */
export async function takeAttendanceAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const staff = await requireStaff();
  if (staff.role !== "TEACHER") return { error: "Only the students' teacher takes attendance and signs." };
  const date = String(fd.get("date") ?? "");
  if (!DATE_RE.test(date)) return { error: "Choose a day." };
  const lock = teacherLock(date, today());
  if (lock) return { error: lock };
  let absent: string[] = [];
  try {
    const p = z.array(z.string().regex(ROW_KEY)).max(3000).safeParse(JSON.parse(String(fd.get("absent") ?? "[]")));
    if (!p.success) return { error: "Reload the page and try again." };
    absent = p.data;
  } catch { return { error: "Reload the page and try again." }; }
  const sig = checkSignaturePng(fd.get("signature"));
  if ("error" in sig) return { error: "Sign by hand to save the day." };

  // Optionally one program/class only (a teacher with two classes takes each one separately).
  const program = String(fd.get("program") ?? "").trim().slice(0, 120) || undefined;
  const { rows } = await loadRoster(staff, { from: date, to: date, program });
  if (!rows.length) return { error: `No students${program ? ` in ${program}` : ""} are on your roster for ${usDate(date)}.` };
  const absentSet = new Set(absent.filter((k) => rows.some((r) => r.key === k)));
  const now = new Date();
  const sigId = await saveSignature("STAFF", staff._id, sig.png, "DRAWN", staff._id);
  const signature = { id: sigId, at: now, staffId: staff._id, staffName: staff.name };
  const out = { approved: 0, absent: 0, notSigned: [] as string[], sentBack: [] as string[], problems: [] as string[] };

  for (const row of rows) {
    if (row.status === "HOLIDAY" || row.status === "EXCUSED") continue;
    const first = await rowFor(staff, row.key);
    if (!first.ok) { out.problems.push(first.error); continue; }
    if (absentSet.has(row.key)) {
      if (first.status === "ABSENT") { out.absent++; continue; }
      const p = await markOne(staff, row.key, first, "ABSENT", now);
      if (p) out.problems.push(p); else out.absent++;
      continue;
    }
    if (first.status === "APPROVED") continue;
    if (first.status === "NEEDS_CORRECTION") { out.sentBack.push(row.name); continue; }
    // Present. Someone marked absent before is present now; someone not marked yet is marked present.
    let r = first;
    if (r.status === "ABSENT" || (r.status === "MISSING" && r.entry?.markedBy?.mark !== "PRESENT")) {
      const p = await markOne(staff, row.key, r, "PRESENT", now);
      if (p) { out.problems.push(p); continue; }
      const again = await rowFor(staff, row.key);
      if (!again.ok) { out.problems.push(again.error); continue; }
      r = again;
    }
    if (r.status === "PENDING") {
      const p = await approveOne(staff, row.key, r, signature, now);
      if (p) out.problems.push(p); else out.approved++;
    } else if (r.status === "MISSING") out.notSigned.push(row.name);
  }

  await audit(staff._id, "staff.take_attendance", date, {
    signatureId: sigId, program: program ?? null, approved: out.approved, absent: out.absent, notSigned: out.notSigned.length, sentBack: out.sentBack.length, problems: out.problems.length,
  });
  refresh();
  let message = `${usDate(date)}${program ? `, ${program}` : ""} saved: ${out.approved} approved and signed, ${out.absent} absent.`;
  if (out.notSigned.length) message += ` Present but the student hasn't signed yet: ${out.notSigned.join(", ")}. Their day comes back to you to sign once they sign.`;
  if (out.sentBack.length) message += ` Sent back, waiting for the student: ${out.sentBack.join(", ")}.`;
  if (out.problems.length) message += ` Not changed: ${out.problems.slice(0, 4).join("; ")}${out.problems.length > 4 ? ` and ${out.problems.length - 4} more` : ""}.`;
  return { ok: true, message };
}

/**
 * Approve or reject an uploaded excuse. Approved: the day becomes Excused (it no longer counts
 * against the student). Rejected: it stays Absent, with the reason. Teachers decide pending
 * excuses; admins can also change a decision.
 */
export async function decideExcuseAction(key: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const staff = await requireStaff();
  if (!ROW_KEY.test(key)) return { error: "Invalid day." };
  const decision = z.enum(["APPROVED", "REJECTED"]).safeParse(fd.get("decision"));
  if (!decision.success) return { error: "Choose approve or reject." };
  const reason = String(fd.get("reason") ?? "").trim().slice(0, 300);
  const r = await rowFor(staff, key);
  if (!r.ok) return { error: `This day is ${r.error}.` };
  const e = r.entry;
  if (!e?.excuse) return { error: "There is no excuse for this day." };
  if (e.excuse.status !== "PENDING" && staff.role !== "ADMIN") return { error: `This excuse was already ${e.excuse.status.toLowerCase()}. Ask an admin to change it.` };
  if (e.excuse.status === decision.data) return { ok: true, message: "Nothing changed." };
  if (decision.data === "REJECTED" && reason.length < 3) return { error: "Say why the excuse is rejected.", fieldErrors: { reason: "Say why." } };
  const now = new Date();
  const status: EntryStatus = decision.data === "APPROVED" ? "EXCUSED" : "ABSENT";
  const res = await (await entries()).updateOne(
    { _id: key, updatedAt: e.updatedAt },
    {
      $set: {
        status, updatedAt: now,
        "excuse.status": decision.data, "excuse.decidedBy": { id: staff._id, name: staff.name, role: staff.role }, "excuse.decidedAt": now, "excuse.reason": reason,
      },
      $push: { history: { at: now, byId: staff._id, byName: staff.name, what: `excuse ${decision.data.toLowerCase()} (was ${e.excuse.status.toLowerCase()})`, reason } },
    },
  );
  if (!res.modifiedCount) return { error: "This day changed in the meantime. Reload the page." };
  await audit(staff._id, decision.data === "APPROVED" ? "staff.approve_excuse" : "staff.reject_excuse", key, { from: e.excuse.status, reason, fileId: e.excuse.fileId });
  refresh();
  return { ok: true, message: decision.data === "APPROVED" ? `Excuse approved: ${r.student.name}, ${usDate(r.date)} is now Excused.` : `Excuse rejected: ${usDate(r.date)} stays Absent.` };
}

// ---------- Admin: "Approved by" at the bottom of the month ----------

/**
 * The admin (for example Mahek) signs off students' months: the "Approved by" section at the bottom
 * of the sheet, with her name, position, a handwritten signature and optional comments. One
 * signature can sign off many students at once. A student is skipped while any of their days that
 * month still wait for the teacher (Pending or Needs correction). Signing again replaces the
 * earlier sign-off, which is kept in the audit log. A signed month is closed for students and
 * teachers; if an admin changes a day afterwards, the sign-off shows as out of date.
 */
export async function signMonthsAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const staff = await requireStaff();
  if (staff.role !== "ADMIN" || !staff.signsOff) return { error: "Only the admin who signs the “Approved by” section (set on the Staff page) can sign off months." };
  const month = String(fd.get("month") ?? "");
  if (!MONTH_RE.test(month) || month > thisMonth()) return { error: "Choose a month." };
  let ids: string[] = [];
  try {
    const p = z.array(z.string().uuid()).min(1).max(2000).safeParse(JSON.parse(String(fd.get("students") ?? "[]")));
    if (p.success) ids = [...new Set(p.data)];
  } catch { /* handled below */ }
  if (!ids.length) return { error: "Choose the students to sign off." };
  const sig = checkSignaturePng(fd.get("signature"));
  if ("error" in sig) return { error: "Sign by hand to sign off the month." };
  // Always the signer's own name and position from her account: nothing typed in can change who it says.
  const staffName = staff.name, position = staff.position;
  const comments = String(fd.get("comments") ?? "").trim().slice(0, 600);
  const { students, entries, approvals } = await cols();
  const now = new Date();
  const signatureId = await saveSignature("STAFF", staff._id, sig.png, "DRAWN", staff._id);
  const holidays = await holidaysBetween(`${month}-01`, `${month}-31`);
  let done = 0;
  const problems: string[] = [];
  for (const s of await students.find({ _id: { $in: ids } }).toArray()) {
    // Signed at the end of the month, like the paper sheet (or once the student's course has ended).
    if (month >= thisMonth() && s.endDate >= today()) { problems.push(`${s.name}: ${monthTitle(month)} isn't over yet`); continue; }
    const list = await entries.find({ studentId: s._id, date: { $gte: `${month}-01`, $lte: `${month}-31` } }).toArray();
    const waiting = list.filter((e) => ["PENDING", "NEEDS_CORRECTION"].includes(dayStatus(e, holidays.has(e.date), e.date, today()))).length;
    if (waiting) { problems.push(`${s.name}: ${waiting} day${waiting === 1 ? "" : "s"} still waiting for the teacher`); continue; }
    if (!list.length) { problems.push(`${s.name}: nothing recorded`); continue; }
    const id = `${s._id}:${month}`;
    const existing = await approvals.findOne({ _id: id });
    await approvals.updateOne(
      { _id: id },
      { $set: { studentId: s._id, month, staffId: staff._id, staffName, position, signatureId, comments, commentsInkId: null, entriesHash: entriesHash(list), signedAt: now } },
      { upsert: true },
    );
    await audit(staff._id, "admin.sign_month", id, {
      staffName, position, signatureId, rows: list.length,
      replaced: existing ? { staffId: existing.staffId, staffName: existing.staffName, signatureId: existing.signatureId, signedAt: existing.signedAt } : null,
    });
    done++;
  }
  refresh();
  const extra = problems.length ? ` Not signed: ${problems.slice(0, 4).join("; ")}${problems.length > 4 ? ` and ${problems.length - 4} more` : ""}.` : "";
  return done ? { ok: true, message: `Signed off ${monthTitle(month)} for ${done} student${done === 1 ? "" : "s"}.${extra}` } : { error: `Nothing was signed.${extra}` };
}

/** The admin takes a month's sign-off off again (to let the student or teacher fix something). Kept in the audit log. */
export async function removeMonthSignOffAction(studentId: string, month: string, _: ActionState, __: FormData): Promise<ActionState> {
  const staff = await requireStaff();
  if (staff.role !== "ADMIN") return { error: "Only an admin can do this." };
  if (!z.string().uuid().safeParse(studentId).success || !MONTH_RE.test(month)) return { error: "Invalid month." };
  const gone = await (await cols()).approvals.findOneAndDelete({ _id: `${studentId}:${month}` });
  if (!gone) return { ok: true, message: "This month isn't signed off." };
  await audit(staff._id, "admin.remove_month_sign_off", `${studentId}:${month}`, { removed: gone });
  refresh();
  return { ok: true, message: `Sign-off for ${monthTitle(month)} removed. The month is open again.` };
}

// ---------- Admin corrections ----------

/**
 * An admin corrects or adds one day: status, times, a note, and optionally a document for an
 * excused absence. Works on any date. The original values are kept in the row's history and the
 * audit log. The student's own signature is never written or imitated: a day an admin records as
 * present without the student's signature stays "signature missing". Changing a day takes its
 * approval off, so it is approved again.
 */
export async function adminEditRowAction(studentId: string, date: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const staff = await requireStaff();
  if (staff.role !== "ADMIN") return { error: "Only an admin can correct attendance. Send the day back to the student instead." };
  if (!z.string().uuid().safeParse(studentId).success || !DATE_RE.test(date)) return { error: "Invalid day." };
  if (date > today()) return { error: "You can't record a future date." };
  const status = z.enum(["PRESENT", "ABSENT", "EXCUSED", "HOLIDAY"]).safeParse(fd.get("status"));
  if (!status.success) return { fieldErrors: { status: "Choose a status" } };
  const note = String(fd.get("note") ?? "").trim().slice(0, 200);
  const reason = String(fd.get("reason") ?? "").trim().slice(0, 300);
  const present = status.data === "PRESENT";
  // Corrected times are written by hand, like everything else on the sheet. Each box the admin writes
  // in replaces that one time; a box left empty keeps what is there. Nothing is typed.
  const INK = [["startInk", "startInkId", "start time"], ["lunchStartInk", "lunchStartInkId", "lunch out"], ["lunchEndInk", "lunchEndInkId", "lunch in"], ["endInk", "endInkId", "end time"]] as const;
  const inks: { field: (typeof INK)[number][1]; label: string; png: string }[] = [];
  const inkErrors: Record<string, string> = {};
  if (present) {
    for (const [name, field, label] of INK) {
      const raw = String(fd.get(name) ?? "");
      if (!raw) continue;
      const r = checkTimePng(raw);
      if ("error" in r) inkErrors[name] = r.error; else inks.push({ field, label, png: r.png });
    }
  }
  if (Object.keys(inkErrors).length) return { fieldErrors: inkErrors };
  // An optional document (an excuse for an older date, a note handed in on paper).
  const file = fd.get("file");
  let upload: { buf: Uint8Array; mime: NonNullable<ReturnType<typeof sniffExcuse>>; name: string } | null = null;
  if (file instanceof File && file.size) {
    if (file.size > EXCUSE_MAX_BYTES) return { fieldErrors: { file: "4 MB max." } };
    const buf = new Uint8Array(await file.arrayBuffer());
    const mime = sniffExcuse(buf);
    if (!mime) return { fieldErrors: { file: "Only PDF, JPG or PNG." } };
    upload = { buf, mime, name: safeFileName(file.name, mime) };
  }

  const { entries: col, students, excuseFiles } = await cols();
  const student = await students.findOne({ _id: studentId });
  if (!student) return { error: "Student not found." };
  if (date < student.startDate || date > student.endDate) return { error: `${usDate(date)} is outside ${student.name}'s course dates.` };
  const id = `${studentId}:${date}`;
  const before = await col.findOne({ _id: id });
  const changed = !before || before.status !== status.data || inks.length > 0 || (before.note ?? "") !== note || !!upload;
  if (!changed) return { ok: true, message: "Nothing changed." };
  if (before && reason.length < 3) return { fieldErrors: { reason: "Say why you're changing this day" } };
  const now = new Date();
  let excuse: Excuse | null | undefined = undefined;
  if (upload) {
    const fileId = newId();
    await excuseFiles.insertOne({ _id: fileId, studentId, date, name: upload.name, mime: upload.mime, size: upload.buf.length, data: new Binary(Buffer.from(upload.buf)), at: now });
    excuse = {
      fileId, fileName: upload.name, mime: upload.mime, size: upload.buf.length, note: note || reason, at: now,
      status: status.data === "EXCUSED" ? "APPROVED" : "PENDING",
      decidedBy: status.data === "EXCUSED" ? { id: staff._id, name: staff.name, role: staff.role } : null, decidedAt: status.data === "EXCUSED" ? now : null, reason: "",
    };
  } else if (status.data === "EXCUSED" && before?.excuse && before.excuse.status !== "APPROVED") {
    excuse = { ...before.excuse, status: "APPROVED", decidedBy: { id: staff._id, name: staff.name, role: staff.role }, decidedAt: now };
  }
  const word = (st: EntryStatus) => (st === "PRESENT" ? "Present" : STATUS_LABEL[st]);
  // The admin's handwriting, saved as the admin's (the student's own stays in the history and audit log).
  const newInk: Record<string, string> = {};
  for (const i of inks) newInk[i.field] = await saveSignature("STAFF", staff._id, i.png, "DRAWN", staff._id, "TIME");
  // The earlier handwriting stays in the audit log (with its image), so the history line stays readable.
  const replaced = inks.map((i) => i.label);
  const after = { status: status.data, minutes: null, note, ...(present ? {} : { startTime: null, endTime: null }) };
  const what = `admin: ${before ? word(before.status) : "nothing recorded"} → ${word(status.data)}`
    + (replaced.length ? `; rewrote by hand: ${replaced.join(", ")} (the earlier handwriting is kept)` : "")
    + (before?.staffSignature ? ` (approval by ${before.staffSignature.staffName} removed)` : "") + (upload ? `; document ${upload.name}` : "");
  const setFields: Record<string, unknown> = {
    ...after, staffSignature: null, correction: null, updatedAt: now,
    // Each rewritten time replaces the old one (a typed time from earlier is dropped with it).
    ...newInk,
    ...(newInk.startInkId ? { startTime: null } : {}), ...(newInk.endInkId ? { endTime: null } : {}),
    ...(excuse !== undefined ? { excuse } : {}),
  };
  const onInsert: Record<string, unknown> = {
    studentId, date, startAt: null, endAt: null, studentSignature: null, markedBy: null, comments: [], excuse: null,
    startTime: null, endTime: null, startInkId: null, endInkId: null, lunchStartInkId: null, lunchEndInkId: null,
  };
  for (const k of Object.keys(setFields)) delete onInsert[k];
  await col.updateOne(
    { _id: id },
    { $set: setFields, $setOnInsert: onInsert, $push: { history: { at: now, byId: staff._id, byName: staff.name, what, reason: reason || "added by admin" } } },
    { upsert: true },
  );
  await audit(staff._id, before ? "admin.edit_day" : "admin.add_day", id, {
    reason,
    before: before ? {
      status: before.status, startTime: before.startTime, endTime: before.endTime, minutes: before.minutes, note: before.note,
      startInkId: before.startInkId ?? null, endInkId: before.endInkId ?? null, lunchStartInkId: before.lunchStartInkId ?? null, lunchEndInkId: before.lunchEndInkId ?? null, staffSignature: before.staffSignature ?? null, excuse: before.excuse ? { ...before.excuse } : null,
    } : null,
    after: { ...after, rewrote: newInk }, document: upload?.name ?? null,
  });
  refresh();
  return { ok: true, message: `${student.name}, ${usDate(date)} saved.${present && !before?.studentSignature ? " The student's signature stays missing until they sign." : ""}` };
}

/** A day off for one class: marks the day Holiday or Excused for everyone in the course. Admins only. */
export async function markCourseDayAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const staff = await requireStaff();
  if (staff.role !== "ADMIN") return { error: "Only an admin can mark a class day off." };
  const date = String(fd.get("date") ?? "");
  const course = String(fd.get("course") ?? "").trim();
  const mode = z.enum(["HOLIDAY", "EXCUSED", "REMOVE"]).safeParse(fd.get("status"));
  const note = String(fd.get("note") ?? "").trim().slice(0, 120);
  if (!DATE_RE.test(date)) return { fieldErrors: { date: "Choose a date" } };
  if (date > addDays(today(), 366)) return { fieldErrors: { date: "Choose a date within the next year" } };
  if (!course) return { fieldErrors: { course: "Choose a class" } };
  if (!mode.success) return { fieldErrors: { status: "Choose what to mark" } };
  if (mode.data !== "REMOVE" && note.length < 2) return { fieldErrors: { note: "Add a short note (it's written on the sheet)" } };
  if ((await holidaysBetween(date, date)).get(date)) return { error: "That date is already a school-wide holiday." };
  const { entries, students } = await cols();
  const list = (await students.find({ courseName: course, active: true, startDate: { $lte: date }, endDate: { $gte: date } }).toArray()).filter((s) => isClassDay(s, date));
  if (!list.length) return { error: `Nobody in ${course} has class on ${usDate(date)}.` };
  const now = new Date();
  let changed = 0;
  const kept: string[] = [];
  for (const st of list) {
    const id = `${st._id}:${date}`;
    if (mode.data === "REMOVE") {
      // Only rows this tool made (every change in their history is a class day off) and nothing else recorded.
      const gone = await entries.findOneAndDelete({
        _id: id, status: { $in: ["HOLIDAY", "EXCUSED"] }, startTime: null, staffSignature: null, studentSignature: null,
        "comments.0": { $exists: false }, history: { $not: { $elemMatch: { reason: { $ne: "class day off" } } } },
      });
      if (gone) { changed++; await audit(staff._id, "staff.course_day_removed", id, { removed: gone }); }
      continue;
    }
    const status = mode.data as EntryStatus;
    const history = { at: now, byId: staff._id, byName: staff.name, what: `class marked ${status.toLowerCase()}: ${note}`, reason: "class day off" };
    const res = await entries.updateOne(
      { _id: id },
      {
        $setOnInsert: {
          studentId: st._id, date, status, note, startAt: null, endAt: null, startTime: null, endTime: null, minutes: null,
          studentSignature: null, staffSignature: null, comments: [], history: [history], updatedAt: now,
        },
      },
      { upsert: true },
    );
    if (res.upsertedCount) { changed++; continue; }
    // A row exists: change it only if nothing was recorded on it yet.
    const upd = await entries.updateOne(
      { _id: id, startTime: null, staffSignature: null },
      { $set: { status, note, minutes: null, endTime: null, updatedAt: now }, $push: { history } },
    );
    if (upd.modifiedCount) changed++; else kept.push(st.name);
  }
  await audit(staff._id, "staff.course_day", `${course}:${date}`, { mode: mode.data, note, changed, kept: kept.length });
  refresh();
  if (mode.data === "REMOVE") return { ok: true, message: `Removed from ${changed} student${changed === 1 ? "" : "s"}' sheets.` };
  return {
    ok: true,
    message: `${usDate(date)} marked ${mode.data.toLowerCase()} for ${changed} student${changed === 1 ? "" : "s"} in ${course}.` +
      (kept.length ? ` Left as recorded (already started or signed): ${kept.slice(0, 5).join(", ")}${kept.length > 5 ? "…" : ""}.` : ""),
  };
}

export async function changePasswordAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const staff = await requireStaff();
  const current = String(fd.get("current") ?? "");
  const next = String(fd.get("next") ?? "");
  if (!(await bcrypt.compare(current, staff.passwordHash))) return { fieldErrors: { current: "That isn't your current password" } };
  if (next.length < 10) return { fieldErrors: { next: "Use at least 10 characters" } };
  const hash = await bcrypt.hash(next, 12);
  await (await cols()).staff.updateOne({ _id: staff._id }, { $set: { passwordHash: hash } });
  await startStaffSession({ ...staff, passwordHash: hash });
  await audit(staff._id, "staff.change_password", staff._id);
  return { ok: true, message: "Password changed. Other devices are signed out." };
}
/**
 * An admin moves a day's record to the correct date (for example the student signed Tuesday's row
 * for Monday). Everything moves with it: the student's own handwriting and signature (never
 * redrawn), the excuse, comments and the full history, plus a history line saying who moved it,
 * from which date, when and why. The target date must be empty. The teacher's approval comes off,
 * so the teacher checks and signs the moved day again. The original is kept in the audit log.
 */
export async function adminMoveDayAction(studentId: string, from: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const staff = await requireStaff();
  if (staff.role !== "ADMIN") return { error: "Only an admin can move a day to another date." };
  const to = String(fd.get("to") ?? "");
  const reason = String(fd.get("reason") ?? "").trim().slice(0, 300);
  if (!z.string().uuid().safeParse(studentId).success || !DATE_RE.test(from)) return { error: "Invalid day." };
  if (!DATE_RE.test(to)) return { fieldErrors: { to: "Choose the correct date" } };
  if (to === from) return { fieldErrors: { to: "Choose a different date" } };
  if (to > today()) return { fieldErrors: { to: "That date hasn't happened yet" } };
  if (!isWeekday(to)) return { fieldErrors: { to: "Attendance is Monday to Friday" } };
  if (reason.length < 3) return { fieldErrors: { reason: "Say why the date is wrong" } };
  const { entries: col, students } = await cols();
  const student = await students.findOne({ _id: studentId });
  if (!student) return { error: "Student not found." };
  if (to < student.startDate || to > student.endDate) return { fieldErrors: { to: `Outside ${student.name}'s course dates` } };
  const before = await col.findOne({ _id: `${studentId}:${from}` });
  if (!before) return { error: `Nothing is recorded on ${usDate(from)}.` };
  const target = `${studentId}:${to}`;
  if (await col.findOne({ _id: target }, { projection: { _id: 1 } })) return { fieldErrors: { to: `${usDate(to)} already has a record. Correct that day first.` } };
  const now = new Date();
  const moved: Entry = {
    ...before, _id: target, date: to, staffSignature: null, correction: null, updatedAt: now,
    history: [...before.history, {
      at: now, byId: staff._id, byName: staff.name,
      what: `admin: moved from ${usDate(from)} to ${usDate(to)}${before.staffSignature ? ` (approval by ${before.staffSignature.staffName} removed)` : ""}`, reason,
    }],
  };
  try {
    await col.insertOne(moved);
  } catch {
    return { error: `${usDate(to)} was just filled from another screen. Reload the page.` };
  }
  const del = await col.deleteOne({ _id: before._id, updatedAt: before.updatedAt });
  if (!del.deletedCount) {
    await col.deleteOne({ _id: target });
    return { error: `${usDate(from)} changed in the meantime. Reload the page.` };
  }
  await audit(staff._id, "admin.move_day", target, {
    from, to, reason,
    before: {
      status: before.status, startTime: before.startTime, endTime: before.endTime, studentSignature: before.studentSignature ?? null,
      staffSignature: before.staffSignature ?? null, excuse: before.excuse ? { ...before.excuse } : null,
    },
  });
  refresh();
  // Open the day at its new date: the editor there shows it, with "moved from …" in its history.
  redirect(`/admin/students/${studentId}?day=${to}&moved=${from}#edit`);
}

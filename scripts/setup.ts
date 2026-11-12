/**
 * One-time (and safe to repeat) database setup:
 *   npm run setup
 * Creates the indexes the app relies on and, if there is no admin yet, the first admin account.
 * Reads MONGODB_URI from .env.local / .env, or the environment.
 */
import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { MongoClient } from "mongodb";
import bcrypt from "bcryptjs";

config({ path: ".env.local" });
config();

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("Set MONGODB_URI in .env.local first.");
  const client = await MongoClient.connect(uri);
  const db = client.db(process.env.MONGODB_DB || undefined);
  const idx = (c: string, spec: Record<string, 1 | -1>, opts: Record<string, unknown> = {}) => db.collection(c).createIndex(spec, opts);
  await idx("staff", { email: 1 }, { unique: true });
  await idx("students", { nameLower: 1 });
  await idx("students", { active: 1, endDate: 1 });
  await idx("students", { courseName: 1 });
  await idx("students", { teacherId: 1, nameLower: 1 });
  await idx("teacher_assignments", { studentId: 1, from: -1 });
  await idx("excuse_files", { studentId: 1, date: 1 });
  // Two active students can never share a PIN (students whose PIN predates this have no pinKey).
  await idx("students", { pinKey: 1 }, { unique: true, name: "unique_active_pin", partialFilterExpression: { active: true, pinKey: { $type: "string" } } });
  await idx("entries", { studentId: 1, date: 1 });
  await idx("entries", { date: 1 });
  await idx("signatures", { ownerId: 1, createdAt: -1 });
  await idx("month_approvals", { studentId: 1, month: 1 });
  await idx("student_notes", { studentId: 1, date: -1, createdAt: -1 });
  await idx("audit_logs", { target: 1, at: -1 });
  await idx("rate_limits", { expiresAt: 1 }, { expireAfterSeconds: 0 });
  console.log("Indexes ready.");
  const oldPins = await db.collection("students").countDocuments({ active: true, pinKey: { $not: { $type: "string" } } });
  if (oldPins) console.log(`${oldPins} active student(s) have a PIN from before PINs were unique. Give them a new PIN (student profile → PIN) to be sure it's theirs alone.`);

  const staff = db.collection("staff");

  // Upgrade: teachers used to see students by course. Each student now has one teacher (their
  // roster). Students without one are put on the roster of the teacher who had their course, when
  // exactly one active teacher did. Attendance rows are not touched.
  const students = db.collection("students");
  const teachers = await staff.find({ role: "TEACHER", active: true }).toArray();
  const unassigned = await students.find({ active: true, $or: [{ teacherId: null }, { teacherId: { $exists: false } }] }).toArray();
  let moved = 0;
  const unclear: string[] = [];
  for (const st of unassigned) {
    const match = teachers.filter((t) => Array.isArray(t.courses) && t.courses.includes(st.courseName));
    if (match.length !== 1) { unclear.push(`${st.name} (${st.courseName || "no course"}: ${match.length ? `${match.length} teachers` : "no teacher"})`); continue; }
    const now = new Date();
    await students.updateOne({ _id: st._id }, { $set: { teacherId: match[0]._id } });
    await db.collection("teacher_assignments").insertOne({
      _id: randomUUID() as never, studentId: st._id, teacherId: match[0]._id, teacherName: match[0].name, from: now, to: null, byId: "setup", byName: "Setup (from course)",
    });
    moved++;
  }
  if (moved) console.log(`${moved} student(s) put on their course teacher's roster.`);
  if (unclear.length) console.log(`${unclear.length} student(s) need a teacher (Admin → Students & teachers):\n  ${unclear.slice(0, 20).join("\n  ")}${unclear.length > 20 ? "\n  …" : ""}`);

  if (await staff.countDocuments({ role: "ADMIN", active: true })) {
    console.log("An admin account already exists.");
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const name = process.env.ADMIN_NAME || (await rl.question("Admin name: ")).trim();
    const email = (process.env.ADMIN_EMAIL || (await rl.question("Admin email: "))).trim().toLowerCase();
    const position = (process.env.ADMIN_POSITION ?? (await rl.question("Admin position, printed with their signature (e.g. Asst. Director): "))).trim() || "Admin";
    const password = process.env.ADMIN_PASSWORD || (await rl.question("Admin password (10+ characters): "));
    rl.close();
    if (name.length < 2 || !email.includes("@") || password.length < 10) throw new Error("Name, a valid email and a 10+ character password are required.");
    await staff.insertOne({
      _id: randomUUID() as never, name, email, position, role: "ADMIN", passwordHash: await bcrypt.hash(password, 12),
      active: true, createdAt: new Date(),
    });
    console.log(`Admin created: ${email}. Sign in at /admin/login.`);
  }
  // The "Approved by" section at the bottom of each month is signed by one chosen admin (Mahek).
  // If nobody is chosen yet and an active admin named Mahek exists, she is chosen.
  if (!(await staff.countDocuments({ role: "ADMIN", active: true, signsOff: true }))) {
    const mahek = await staff.find({ role: "ADMIN", active: true, name: { $regex: "mahek", $options: "i" } }).toArray();
    if (mahek.length === 1) {
      await staff.updateOne({ _id: mahek[0]._id }, { $set: { signsOff: true } });
      console.log(`${mahek[0].name} now signs the "Approved by" section of each month.`);
    } else {
      console.log(`Nobody signs the "Approved by" section yet: Admin → Staff → choose the admin → "Signs the Approved by section".`);
    }
  }
  const signerIds = (await staff.find({ signsOff: true, active: true }).toArray()).map((x) => x._id);
  const other = await db.collection("month_approvals").countDocuments({ staffId: { $nin: signerIds } });
  if (other) console.log(`${other} month sign-off(s) were signed by someone else. They show "Needs your signature" on Admin → Monthly sign-off for the signer to sign again.`);

  await client.close();
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

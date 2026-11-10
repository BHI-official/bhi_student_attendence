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
  // Two active students can never share a PIN (students whose PIN predates this have no pinKey).
  await idx("students", { pinKey: 1 }, { unique: true, name: "unique_active_pin", partialFilterExpression: { active: true, pinKey: { $type: "string" } } });
  await idx("entries", { studentId: 1, date: 1 });
  await idx("entries", { date: 1 });
  await idx("signatures", { ownerId: 1, createdAt: -1 });
  await idx("month_approvals", { studentId: 1, month: 1 });
  await idx("audit_logs", { target: 1, at: -1 });
  await idx("rate_limits", { expiresAt: 1 }, { expireAfterSeconds: 0 });
  console.log("Indexes ready.");
  const oldPins = await db.collection("students").countDocuments({ active: true, pinKey: { $not: { $type: "string" } } });
  if (oldPins) console.log(`${oldPins} active student(s) have a PIN from before PINs were unique. Give them a new PIN (student profile → PIN) to be sure it's theirs alone.`);

  const staff = db.collection("staff");
  if (await staff.countDocuments({ role: "ADMIN", active: true })) {
    console.log("An admin account already exists. Nothing else to do.");
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const name = process.env.ADMIN_NAME || (await rl.question("Admin name: ")).trim();
    const email = (process.env.ADMIN_EMAIL || (await rl.question("Admin email: "))).trim().toLowerCase();
    const password = process.env.ADMIN_PASSWORD || (await rl.question("Admin password (10+ characters): "));
    rl.close();
    if (name.length < 2 || !email.includes("@") || password.length < 10) throw new Error("Name, a valid email and a 10+ character password are required.");
    await staff.insertOne({
      _id: randomUUID() as never, name, email, position: "Admin", role: "ADMIN", courses: [], passwordHash: await bcrypt.hash(password, 12),
      signatureId: null, active: true, createdAt: new Date(),
    });
    console.log(`Admin created: ${email}. Sign in at /admin/login.`);
  }
  await client.close();
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

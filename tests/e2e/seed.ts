/**
 * Demo data for the browser walkthrough (tests/e2e/walkthrough.py). Wipes the bhi_e2e database.
 *   MONGODB_URI=mongodb://127.0.0.1:27017/bhi_e2e npx tsx tests/e2e/seed.ts
 * Admin: admin@bhi.test / password-123456. Teachers: saniya@bhi.test, omar@bhi.test (same password).
 * Students (PIN): Jennifer Quezada 2468, Alexandra Mendez 3579, Maria Lopez 8023.
 */
import { randomUUID, createHmac } from "node:crypto";
import zlib from "node:zlib";
import { MongoClient } from "mongodb";
import bcrypt from "bcryptjs";

const URI = process.env.MONGODB_URI ?? "";
if (!/\/bhi_e2e\b/.test(URI)) throw new Error("MONGODB_URI must name the bhi_e2e database.");
const SECRET = process.env.SESSION_SECRET ?? "";
const pinKey = (pin: string) => createHmac("sha256", `bhi-pin:${SECRET}`).update(pin).digest("hex");
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** A small blue wavy PNG standing in for handwriting. */
function inkPng(w: number, h: number, seed: number) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let x = 0; x < w; x++) {
    const y0 = Math.round(h / 2 + Math.sin((x + seed * 7) / (5 + seed)) * (h / 3));
    for (let dy = -1; dy <= 1; dy++) { const y = y0 + dy; if (y >= 0 && y < h) raw.set([28, 63, 170, 255], y * (w * 4 + 1) + 1 + x * 4); }
  }
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Buffer) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

async function main() {
  const client = await MongoClient.connect(URI);
  const db = client.db();
  await db.dropDatabase();
  await db.collection("staff").createIndex({ email: 1 }, { unique: true });
  const hash = await bcrypt.hash("password-123456", 10);
  const now = new Date();
  const ids = { admin: randomUUID(), saniya: randomUUID(), omar: randomUUID(), pratip: randomUUID() };
  await db.collection("staff").insertMany([
    { _id: ids.admin, name: "Mahek", email: "admin@bhi.test", position: "Asst. Director", role: "ADMIN", signsOff: true, passwordHash: hash, active: true, createdAt: now },
    { _id: ids.pratip, name: "Pratip Kayal", email: "pratip@bhi.test", position: "Instructor", role: "ADMIN", passwordHash: hash, active: true, createdAt: now },
    { _id: ids.saniya, name: "Dr. Saniya", email: "saniya@bhi.test", position: "Instructor", role: "TEACHER", passwordHash: hash, active: true, createdAt: now },
    { _id: ids.omar, name: "Omar Haddad", email: "omar@bhi.test", position: "Instructor", role: "TEACHER", passwordHash: hash, active: true, createdAt: now },
  ] as never[]);
  const start = ymd(new Date(Date.now() - 90 * 864e5)), end = ymd(new Date(Date.now() + 90 * 864e5));
  const students = [
    ["Jennifer Quezada", "2468", ids.saniya], ["Alexandra Mendez", "3579", ids.saniya], ["Maria Lopez", "8023", ids.saniya], ["Kevin Reid", "4813", null],
  ] as const;
  // Handwriting images for last month's demo rows.
  const ink = async (ownerType: string, ownerId: string, seed: number, kind = "TIME") => {
    const _id = randomUUID();
    await db.collection("signatures").insertOne({ _id, ownerType, ownerId, png: inkPng(kind === "TIME" ? 70 : 160, kind === "TIME" ? 28 : 50, seed), source: "DRAWN", kind, createdAt: now, createdBy: ownerId } as never);
    return _id;
  };
  const teacherSig = await ink("STAFF", ids.saniya, 9, "SIGNATURE");
  const m = new Date(); m.setUTCDate(1); m.setUTCMonth(m.getUTCMonth() - 1);
  const lastMonthDays: string[] = [];
  for (const d = new Date(m); d.getUTCMonth() === m.getUTCMonth(); d.setUTCDate(d.getUTCDate() + 1)) if (d.getUTCDay() >= 1 && d.getUTCDay() <= 5) lastMonthDays.push(ymd(d));
  for (const [name, pin, teacherId] of students) {
    const _id = randomUUID();
    await db.collection("students").insertOne({
      _id, name, nameLower: name.toLowerCase(), pinHash: await bcrypt.hash(pin, 10), pinKey: pinKey(pin), courseName: "Clinical Medical Assistant",
      courseCode: "CMA", courseDuration: "6 months", caseManager: "S. Nandi", instructor: "Dr. Saniya", startDate: start, endDate: end,
      classDays: [1, 2, 3, 4, 5], teacherId, profile: {}, active: true, createdAt: now,
    } as never);
    // Last month, filled in and signed by the student, checked and signed by the teacher (Jennifer: one day still pending).
    if (teacherId) {
      const [t1, t2, t3, t4, sig] = [await ink("STUDENT", _id, 1), await ink("STUDENT", _id, 2), await ink("STUDENT", _id, 3), await ink("STUDENT", _id, 4), await ink("STUDENT", _id, 5, "SIGNATURE")];
      await db.collection("entries").insertMany(lastMonthDays.map((date, i) => ({
        _id: `${_id}:${date}`, studentId: _id, date, status: "PRESENT", startTime: null, endTime: null, minutes: null,
        startInkId: t1, lunchStartInkId: t2, lunchEndInkId: t3, endInkId: t4, studentSignature: { id: sig, at: now },
        staffSignature: name === "Jennifer Quezada" && i === lastMonthDays.length - 1 ? null : { id: teacherSig, at: now, staffId: ids.saniya, staffName: "Dr. Saniya" },
        correction: null, markedBy: null, excuse: null, note: "", comments: [], history: [], updatedAt: now,
      })) as never[]);
    }
    // Like old data: Maria's last month was signed off by another admin (Pratip), so Mahek must sign it again.
    if (name === "Maria Lopez") {
      await db.collection("month_approvals").insertOne({
        _id: `${_id}:${lastMonthDays[0].slice(0, 7)}`, studentId: _id, month: lastMonthDays[0].slice(0, 7), staffId: ids.pratip, staffName: "Pratip Kayal", position: "Instructor",
        signatureId: await ink("STAFF", ids.pratip, 6, "SIGNATURE"), comments: "", commentsInkId: null, entriesHash: "old", signedAt: now,
      } as never);
    }
    if (teacherId) await db.collection("teacher_assignments").insertOne({ _id: randomUUID(), studentId: _id, teacherId, teacherName: "Dr. Saniya", from: now, to: null, byId: ids.admin, byName: "Mahek" } as never);
  }
  console.log("Seeded.");
  await client.close();
}
main().catch((e) => { console.error(e); process.exit(1); });

// Seeds the throwaway database bhi_e2e for tests/e2e/walkthrough.py (Playwright, Python). Wipes bhi_e2e.
import { MongoClient } from "mongodb";
import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import { pinFingerprint } from "../../src/lib/pin";
import { addDays, clockIn, todayIn } from "../../src/lib/sheet";
const SECRET = "e2e-secret-e2e-secret-e2e-secret-e2e-secret";
(async () => {
  const c = await MongoClient.connect("mongodb://127.0.0.1:27017/bhi_e2e"); const db = c.db();
  await db.dropDatabase();
  await db.collection("students").createIndex({ pinKey: 1 }, { unique: true, partialFilterExpression: { active: true, pinKey: { $type: "string" } } });
  const today = todayIn("America/New_York"), now = new Date();
  const pw = await bcrypt.hash("password-123456", 4);
  const mahekSig = randomUUID();

  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAANwAAABGCAYAAACnp/qkAAADGklEQVR4nO3dy3HcMBBFUchxKBdnoSCdhXJRHvaKVTCLxI/oL+/ZeGNr0AM8NgHOyKUAAAAAAAAAAAAAAAAAAAAAAACo+Pz956/1GIDdflkP4MoRtjp0BBAZfFgP4KwVrJ/vL3fjBWa46nC9LkaXQ3SuAgdk5yZwV93r5/vr43wbGa3LsQ9FzUXgsi7E+vDn6iAI72MeuLsFWHe2iF2uNcYI44cM08CNhC2ikUARuncyC9xs2CJ2udpVXdFqwHMmgcva2Uq5P/yp/+z9/ejYr94zWeCtRTn7bz2FdPRC8qR+7/jgQpv6G/B0sXkN3GzXzhi62Y4Wvd4VqgXvupX0FrrVurKEbsetY8S6V6jt4bLu257UlWFP17uFnNkq1M8rs1JZ7BJh89DlpDr2ys+wsLpfe/Otp3ghUp3Na+BWxxEtdJIXmxbP78kI0cFL30Zahk4iIFFCp3UR7fH43vSoB27nm2QVOMkLiefQaR/5Zwyg2AC1Fo526DQOfzyGzvr5WpbwiQxK80RSM3CWdUm9zupYDl72zi2ewqd2G6AZBM3bG+2Aay+eCI9zIgVw6wtbTY504CwXnWXoIoTtzHv4RPcdpdgtjkx7Ku3X93YLucpj+ESO5w+Wi1Lq0cPOn+1xHFnCdsVDAFMvSqnnQp4OL6Q7ucTreGAVvsefpfQStt28he3utXd99rBVb4b5PDvqCrWH87god3Q5j3XVdl/kvNerTfI8YLnDZZ2kCHXt6nStT+d7qlebZPfb9kHbUvxM0uoVyntdZzu/Ob/yMzBvusNFW5RPea5rtdMRNjtbvkrhcZJmu1zkw5+ZsUeaw4wen1JmmKjo3zIe7XSEzd7yL+8pxf9EjXS5TIvwbo64hfRjqMNF7wB3MoWtlPk9XdQ6I+sGLvKiPI+xriVyXS2j449eZ1TdwF09j4g+WVnDdmjVkfWTI1FMn1JGnKyRW+KIdfV4+EVL+N8rJqAXuOwLMeqFMiPz/x9Ow9sX29vr9+QVgWthMULTawJ3FSzCBgg69nJZnysCAAAAAAAAAAAAAAAAAAAAAFBKKeUflIieaJWPtbcAAAAASUVORK5CYII=";
  await db.collection("staff").insertMany([
    { _id: randomUUID(), name: "Ada Admin", email: "admin@x.test", position: "Director", role: "ADMIN", courses: [], passwordHash: pw, signatureId: null, active: true, createdAt: now },
    { _id: "teacher-1", name: "Tom Teacher", email: "tom@x.test", position: "Instructor", role: "TEACHER", courses: ["Office"], passwordHash: pw, signatureId: null, active: true, createdAt: now },
  ] as any[]);
  const mk = async (name: string, pin: string) => ({
    _id: randomUUID(), name, nameLower: name.toLowerCase(), pinHash: await bcrypt.hash(pin, 4), pinKey: pinFingerprint(pin, SECRET), signatureId: null,
    courseName: "Office", courseCode: "305-V", courseDuration: "6 months", caseManager: "S. Nandi", instructor: "Mr. Rakesh",
    startDate: addDays(today, -40), endDate: addDays(today, 60), classDays: [1, 2, 3, 4, 5, 6, 7], active: true, createdAt: now,
    profile: { phone: "201-555-0100", email: "", address: "", emergencyName: "", emergencyPhone: "", social: "Takes the 80 bus" },
  });
  const kevin = await mk("Kevin Reid", "2468"), maria = await mk("Maria Lopez", "1357");
  await db.collection("students").insertMany([kevin, maria] as any[]);
  const startAt = new Date(Date.now() - 30 * 60000);
  const base = { status: "PRESENT", endAt: null, minutes: null, startLateBy: 0, endLateBy: null, studentSignature: null, staffSignature: null, note: "", history: [], comments: [], updatedAt: now };
  const d10 = addDays(today, -10), d2 = addDays(today, -2);
  await db.collection("signatures").insertOne({ _id: mahekSig, ownerType: "STAFF", ownerId: "mahek", png, source: "UPLOAD", createdAt: now, createdBy: "mahek" } as any);
  await db.collection("entries").insertMany([
    { _id: `${kevin._id}:${today}`, studentId: kevin._id, date: today, ...base, startAt, startTime: clockIn("America/New_York", startAt, "start"), endTime: null },
    { _id: `${kevin._id}:${d10}`, studentId: kevin._id, date: d10, ...base, startAt: null, startTime: "09:00", endTime: "15:00", minutes: 360, staffSignature: { id: mahekSig, at: now, staffId: "mahek", staffName: "Mahek" } },
    { _id: `${kevin._id}:${d2}`, studentId: kevin._id, date: d2, ...base, startAt: null, startTime: "09:00", endTime: "15:00", minutes: 360 },
  ] as any[]);
  console.log("seeded", today, kevin._id);
  await c.close();
})();

/**
 * Creates one admin account.
 *   npm run seed-admin
 * Uses MONGODB_URI from .env.local / .env. Asks for name, email, position, password (hidden) and
 * whether this admin signs the "Approved by" section at the bottom of each month (Mahek: yes).
 * Without prompts: ADMIN_NAME, ADMIN_EMAIL, ADMIN_POSITION, ADMIN_PASSWORD, ADMIN_SIGNS_OFF=yes|no.
 */
import { config } from "dotenv";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import bcrypt from "bcryptjs";
import { MongoClient } from "mongodb";

config({ path: ".env.local" });
config();

/** Reads a line without showing what is typed (for the password, at a keyboard). */
function hidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    let value = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off("data", onData);
          process.stdout.write("\n"); return resolve(value);
        }
        if (ch === "\u0003") process.exit(1); // Ctrl+C
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1); else value += ch;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("Set MONGODB_URI in .env.local first.");
  const env = process.env;
  // One line per answer, whether typed at a keyboard or piped in.
  const rl = createInterface({ input: process.stdin, terminal: false });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (q: string, v?: string) => {
    if (v !== undefined) return v.trim();
    process.stdout.write(q);
    const next = await lines.next();
    if (next.done) throw new Error("No answer given. Nothing was changed.");
    return next.value.trim();
  };
  const name = (await ask("Name: ", env.ADMIN_NAME)).replace(/\s+/g, " ");
  const email = (await ask("Email: ", env.ADMIN_EMAIL)).toLowerCase();
  const position = (await ask("Position (printed with their signature, e.g. Asst. Director): ", env.ADMIN_POSITION)).replace(/\s+/g, " ") || "Admin";
  const signsOff = /^y/i.test(await ask("Signs the \"Approved by\" section of each month? (y/n): ", env.ADMIN_SIGNS_OFF));
  let password = env.ADMIN_PASSWORD;
  if (password === undefined && process.stdin.isTTY) { rl.close(); password = await hidden("Password (10+ characters): "); }
  else if (password === undefined) password = await ask("Password (10+ characters): ");
  rl.close();

  if (name.length < 2) throw new Error("Enter a name.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid email.");
  if (password.length < 10) throw new Error("The password must be at least 10 characters.");

  const client = await MongoClient.connect(uri);
  const staff = client.db(process.env.MONGODB_DB || undefined).collection("staff");
  await staff.createIndex({ email: 1 }, { unique: true });
  if (await staff.findOne({ email })) {
    await client.close();
    throw new Error(`An account with ${email} already exists. Nothing was changed.`);
  }
  await staff.insertOne({
    _id: randomUUID() as never, name, email, position, role: "ADMIN", signsOff,
    passwordHash: await bcrypt.hash(password, 12), active: true, createdAt: new Date(),
  });
  await client.close();
  console.log(`Admin created: ${name} (${email})${signsOff ? ", signs \"Approved by\"" : ""}. Sign in at /admin/login.`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

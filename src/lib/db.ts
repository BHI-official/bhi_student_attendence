import "server-only";
import dns from "node:dns";
import { randomUUID } from "node:crypto";
import { MongoClient, type Collection } from "mongodb";
import { env } from "./env";
import type { AuditLog, Entry, Holiday, MonthApproval, SignatureDoc, Staff, Student } from "./types";

export * from "./types";

// Local fix: this PC's DNS refuses the SRV lookup that mongodb+srv:// needs, so on the dev
// machine ask Google / Cloudflare DNS instead. Production (Vercel) keeps its normal DNS.
if (process.env.NODE_ENV !== "production") {
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
}

const g = globalThis as unknown as { mongo?: Promise<MongoClient> };

function client() {
  if (!g.mongo) {
    g.mongo = MongoClient.connect(env().MONGODB_URI, { maxPoolSize: 10, serverSelectionTimeoutMS: 10_000 }).catch((e) => {
      g.mongo = undefined; // retry next time instead of caching a failed connection
      throw e;
    });
  }
  return g.mongo;
}

export async function cols() {
  const db = (await client()).db(env().MONGODB_DB || undefined);
  return {
    staff: db.collection<Staff>("staff"),
    students: db.collection<Student>("students"),
    entries: db.collection<Entry>("entries"),
    holidays: db.collection<Holiday>("holidays"),
    approvals: db.collection<MonthApproval>("month_approvals"),
    signatures: db.collection<SignatureDoc>("signatures"),
    audit: db.collection<AuditLog>("audit_logs"),
    limits: db.collection<{ _id: string; count: number; expiresAt: Date }>("rate_limits"),
  };
}

export const newId = () => randomUUID();
export const isDuplicateKey = (e: unknown) => !!e && typeof e === "object" && (e as { code?: number }).code === 11000;

export async function audit(actor: string, action: string, target: string, meta: Record<string, unknown> = {}) {
  await (await cols()).audit.insertOne({ _id: newId(), at: new Date(), actor, action, target, meta });
}

/** Fixed-window limiter in MongoDB. Returns true when allowed. */
export async function rateLimit(key: string, limit: number, windowSeconds: number) {
  const window = Math.floor(Date.now() / 1000 / windowSeconds);
  const doc = await (await cols()).limits.findOneAndUpdate(
    { _id: `${key}:${window}` },
    { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date((window + 2) * windowSeconds * 1000) } },
    { upsert: true, returnDocument: "after" },
  );
  return (doc?.count ?? 1) <= limit;
}

/**
 * Deletes ALL data in the database (every collection). Nothing is recreated.
 *   npm run clear-db
 * Uses MONGODB_URI from .env.local / .env. Asks you to type the database name first.
 */
import { config } from "dotenv";
import { createInterface } from "node:readline/promises";
import { MongoClient } from "mongodb";

config({ path: ".env.local" });
config();

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("Set MONGODB_URI in .env.local first.");
  const client = await MongoClient.connect(uri);
  const db = client.db(process.env.MONGODB_DB || undefined);
  const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name).filter((n) => !n.startsWith("system."));
  console.log(`Database "${db.databaseName}":`);
  for (const n of names.sort()) console.log(`  ${n}: ${await db.collection(n).countDocuments()}`);
  if (!names.length) { console.log("  already empty"); await client.close(); return; }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const typed = await rl.question(`Type "${db.databaseName}" to delete all of it: `);
  rl.close();
  if (typed.trim() !== db.databaseName) { console.log("Stopped. Nothing deleted."); await client.close(); return; }

  for (const n of names) await db.collection(n).drop();
  console.log(`Done. "${db.databaseName}" is empty.`);
  await client.close();
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });

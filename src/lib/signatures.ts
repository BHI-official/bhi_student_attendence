import "server-only";
import { cols, newId, type SignatureDoc } from "./db";
import { checkInkPng } from "./png";

/** A signature image from the browser (photo cleaned up, or drawn). Returns the data URL, or a message. */
export const checkSignaturePng = (input: unknown) => checkInkPng(input, "SIGNATURE");
/** Handwriting written into a note or comment field. */
export const checkNotePng = (input: unknown) => checkInkPng(input, "NOTE");
/** A start or end time the student wrote by hand. */
export const checkTimePng = (input: unknown) => checkInkPng(input, "TIME");

/**
 * Stores a signature or handwriting image once. Images are never deleted or changed: rows point
 * at the exact image they were signed with, so historical records keep their signatures.
 */
export async function saveSignature(
  ownerType: SignatureDoc["ownerType"], ownerId: string, png: string, source: SignatureDoc["source"], createdBy: string, kind: SignatureDoc["kind"] = "SIGNATURE",
) {
  const doc: SignatureDoc = { _id: newId(), ownerType, ownerId, png, source, kind, createdAt: new Date(), createdBy };
  await (await cols()).signatures.insertOne(doc);
  return doc._id;
}

/** id -> PNG for the signatures a page shows. */
export async function signatureImages(ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return {} as Record<string, string>;
  const docs = await (await cols()).signatures.find({ _id: { $in: unique } }, { projection: { png: 1 } }).toArray();
  return Object.fromEntries(docs.map((d) => [d._id, d.png])) as Record<string, string>;
}

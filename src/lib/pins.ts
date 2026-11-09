import "server-only";
import { cols } from "./db";
import { env } from "./env";
import { pinFingerprint, uniquePin } from "./pin";

export const pinKey = (pin: string) => pinFingerprint(pin, env().SESSION_SECRET);

/** Is this PIN already used by another active student? */
export async function pinTaken(pin: string, exceptStudentId?: string) {
  const found = await (await cols()).students.findOne(
    { pinKey: pinKey(pin), active: true, ...(exceptStudentId ? { _id: { $ne: exceptStudentId } } : {}) },
    { projection: { _id: 1 } },
  );
  return !!found;
}

/** A random PIN no active student has, also avoiding PINs in `alsoAvoid` (e.g. earlier rows of an import). */
export const freePin = (alsoAvoid: Set<string> = new Set()) => uniquePin(async (p) => alsoAvoid.has(p) || (await pinTaken(p)));

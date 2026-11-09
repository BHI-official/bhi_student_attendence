// PIN rules. Pure (the secret is passed in), so they can be unit-tested.
import { createHmac, randomInt } from "node:crypto";

export const PIN_RE = /^\d{4,6}$/;

/**
 * A keyed fingerprint of a PIN. Stored next to the bcrypt hash with a unique index, so two active
 * students can never have the same PIN. Login still checks the bcrypt hash; this is only for
 * uniqueness. Without the secret, the fingerprint says nothing about the PIN.
 */
export function pinFingerprint(pin: string, secret: string) {
  return createHmac("sha256", `bhi-pin:${secret}`).update(pin).digest("hex");
}

/** PINs that are too easy to guess are refused when staff type one in. */
export function weakPin(pin: string) {
  if (/^(\d)\1+$/.test(pin)) return true; // 0000, 111111
  const asc = "01234567890", desc = "09876543210";
  return asc.includes(pin) || desc.includes(pin); // 1234, 4321, 123456
}

/**
 * A new random PIN that `isTaken` says is free. Starts with 4 digits and moves to 5 or 6 digits
 * only if 4-digit PINs keep colliding (a very large school). Never returns a weak PIN.
 */
export async function uniquePin(isTaken: (pin: string) => Promise<boolean> | boolean, rand: (max: number) => number = randomInt) {
  for (const digits of [4, 5, 6]) {
    for (let i = 0; i < 40; i++) {
      const pin = String(rand(10 ** digits)).padStart(digits, "0");
      if (weakPin(pin)) continue;
      if (!(await isTaken(pin))) return pin;
    }
  }
  throw new Error("Couldn't find a free PIN. Try again.");
}

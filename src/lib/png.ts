// Pure checks on PNG images sent from the browser (signatures and handwriting). No database, so it
// can be unit-tested.

export type InkKind = "SIGNATURE" | "NOTE" | "TIME";

/** Size limits: a signature is a small strip; a handwritten note can be a few lines. */
export const INK_LIMITS: Record<InkKind, { maxBytes: number; minW: number; minH: number; maxW: number; maxH: number }> = {
  SIGNATURE: { maxBytes: 300_000, minW: 40, minH: 15, maxW: 1200, maxH: 600 },
  NOTE: { maxBytes: 700_000, minW: 30, minH: 15, maxW: 1600, maxH: 1000 },
  TIME: { maxBytes: 300_000, minW: 40, minH: 15, maxW: 1200, maxH: 600 },
};

/**
 * Checks an image really is a reasonable PNG of the right size (the browser has already cropped
 * and scaled it). Returns the data URL, or a message to show.
 */
export function checkInkPng(input: unknown, kind: InkKind = "SIGNATURE"): { png: string } | { error: string } {
  const s = typeof input === "string" ? input : "";
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(s);
  const what = kind === "SIGNATURE" ? "signature" : kind === "TIME" ? "handwritten time" : "handwriting";
  if (!m) return { error: kind === "SIGNATURE" ? "Add a signature first." : kind === "TIME" ? "Write the time in the box first." : "Write something first." };
  const lim = INK_LIMITS[kind];
  // Decoded size without decoding: 3 bytes per 4 base64 characters.
  if ((m[1].length * 3) / 4 > lim.maxBytes) return { error: `The ${what} image is too large.` };
  const buf = Buffer.from(m[1], "base64");
  if (buf.length > lim.maxBytes) return { error: `The ${what} image is too large.` };
  // PNG magic bytes, then the IHDR chunk with width and height.
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a || buf.toString("ascii", 12, 16) !== "IHDR") {
    return { error: "That isn't a valid image." };
  }
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  if (w > lim.maxW || h > lim.maxH) return { error: `The ${what} image is too large.` };
  if (w < lim.minW || h < lim.minH) {
    return { error: kind === "SIGNATURE" ? "The signature is too small to read. Write it bigger and try again." : kind === "TIME" ? "The time is too small to read. Write it bigger." : "The handwriting is too small to read. Write it bigger." };
  }
  return { png: s };
}

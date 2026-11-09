"use client";

import { InkPad } from "./Ink";

/**
 * Full-screen signature box, used when putting a signature on file. Big on purpose: students and
 * staff sign with a finger on a phone or tablet. Returns a PNG (data URL) through onSave.
 */
export function SignatureModal({ title, onSave, onCancel }: { title: string; onSave: (png: string) => void; onCancel: () => void }) {
  return <InkPad kind="signature" title={title} onCancel={onCancel} onDone={(v) => (v ? onSave(v.png) : onCancel())} />;
}

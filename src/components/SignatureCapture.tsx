"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ActionState } from "@/lib/action";
import { SignatureModal } from "./SignaturePad";
import { Msg } from "./forms";

/**
 * Turns a photo of a signature on paper into a clean signature image: the paper becomes
 * transparent, the ink stays, and it is cropped and scaled down. Otsu's method picks the
 * ink/paper threshold from the photo itself, so it copes with shadows and off-white paper.
 */
export async function cleanSignaturePhoto(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, bad) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => bad(new Error("That file isn't a picture we can read. Use a JPG or PNG photo."));
      i.src = url;
    });
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale)), h = Math.max(1, Math.round(img.naturalHeight * scale));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.fillStyle = "#fff"; // transparent PNGs: treat empty areas as paper
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h);
    const lum = new Uint8Array(w * h);
    const hist = new Array(256).fill(0);
    for (let i = 0; i < w * h; i++) {
      const v = Math.round(0.299 * px.data[i * 4] + 0.587 * px.data[i * 4 + 1] + 0.114 * px.data[i * 4 + 2]);
      lum[i] = v; hist[v]++;
    }
    // Otsu threshold
    let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0, wB = 0, best = 0, threshold = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue;
      const wF = w * h - wB; if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) ** 2;
      if (between > best) { best = between; threshold = t; }
    }
    threshold = Math.min(threshold, 170); // never treat light grey paper as ink
    let x0 = w, y0 = h, x1 = -1, y1 = -1, ink = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, v = lum[i];
      if (v < threshold) {
        // Darker = more opaque; keep the pen colour.
        px.data[i * 4 + 3] = Math.min(255, Math.round(((threshold - v) / Math.max(1, threshold)) * 255 * 1.6) + 60);
        ink++;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      } else px.data[i * 4 + 3] = 0;
    }
    if (ink < 80 || x1 - x0 < 30) throw new Error("We couldn't find a signature in that photo. Sign in dark pen on white paper and take the photo close up.");
    if (ink > w * h * 0.35) throw new Error("The photo is too dark to separate the signature from the paper. Take it in better light, on plain white paper.");
    ctx.putImageData(px, 0, 0);
    const pad = 10, cw = x1 - x0 + pad * 2, ch = y1 - y0 + pad * 2;
    const s = Math.min(1, 480 / cw, 160 / ch);
    const out = document.createElement("canvas");
    out.width = Math.max(40, Math.round(cw * s)); out.height = Math.max(15, Math.round(ch * s));
    out.getContext("2d")!.drawImage(c, x0 - pad, y0 - pad, cw, ch, 0, 0, out.width, out.height);
    return out.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Put a signature on file: upload a photo of it, or draw it. Shows a preview before saving. */
export function SignatureOnFile({ action, title, extra, uploadLabel = "Upload a photo of my signature", drawLabel = "Draw it instead", compact = false, onSaved }: {
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>; title: string; extra?: Record<string, string>;
  uploadLabel?: string; drawLabel?: string;
  /** Smaller buttons, for use inside another panel. */
  compact?: boolean;
  onSaved?: () => void;
}) {
  const size = compact ? "" : " big";
  const router = useRouter();
  const [png, setPng] = useState<string | null>(null);
  const [source, setSource] = useState<"UPLOAD" | "DRAWN">("UPLOAD");
  const [draw, setDraw] = useState(false);
  const [msg, setMsg] = useState<ActionState>({});
  const [busy, setBusy] = useState(false);
  const [pending, start] = useTransition();

  const pick = async (f: File | undefined) => {
    if (!f) return;
    setMsg({}); setBusy(true);
    try { setPng(await cleanSignaturePhoto(f)); setSource("UPLOAD"); }
    catch (e) { setMsg({ error: e instanceof Error ? e.message : "Couldn't read that photo." }); }
    finally { setBusy(false); }
  };
  const save = () => start(async () => {
    const fd = new FormData();
    fd.set("signature", png!); fd.set("source", source);
    for (const [k, v] of Object.entries(extra ?? {})) fd.set(k, v);
    const r = await action({}, fd);
    setMsg(r);
    if (r.ok) { setPng(null); router.refresh(); onSaved?.(); }
  });

  return (
    <div>
      {!png ? (
        <div className="row">
          <label className={`btn${size}`} style={{ cursor: "pointer" }}>
            {busy ? "Reading photo…" : uploadLabel}
            <input type="file" accept="image/*" capture="environment" hidden onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
          </label>
          <button type="button" className={`btn ghost${size}`} onClick={() => setDraw(true)}>{drawLabel}</button>
        </div>
      ) : (
        <div>
          <p className="small muted">This is how it will appear on the sheet:</p>
          <div style={{ background: "#fff", border: "1.5px solid var(--line)", borderRadius: 10, padding: 16, display: "inline-block" }}>
            <img src={png} alt="Signature preview" style={{ maxHeight: compact ? 80 : 120, maxWidth: "100%" }} />
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn" disabled={pending} onClick={save}>{pending ? "Saving…" : "Use this signature"}</button>
            <button className="btn ghost" onClick={() => setPng(null)}>Try again</button>
          </div>
        </div>
      )}
      <Msg state={msg} />
      {draw && <SignatureModal title={title} onCancel={() => setDraw(false)} onSave={(p) => { setDraw(false); setPng(p); setSource("DRAWN"); }} />}
    </div>
  );
}

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ActionState } from "@/lib/action";
import { SignatureModal } from "./SignaturePad";
import { Msg } from "./forms";

/**
 * Put a signature on file by signing on the screen (finger, stylus or mouse) in the handwriting
 * canvas. Shows a preview before saving. There is no photo upload: every signature is handwritten.
 */
export function SignatureOnFile({ action, title, extra, drawLabel = "Sign on the screen", compact = false, onSaved }: {
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>; title: string; extra?: Record<string, string>;
  drawLabel?: string;
  /** Smaller buttons, for use inside another panel. */
  compact?: boolean;
  onSaved?: () => void;
}) {
  const size = compact ? "" : " big";
  const router = useRouter();
  const [png, setPng] = useState<string | null>(null);
  const [draw, setDraw] = useState(false);
  const [msg, setMsg] = useState<ActionState>({});
  const [pending, start] = useTransition();

  const save = () => start(async () => {
    const fd = new FormData();
    fd.set("signature", png!);
    for (const [k, v] of Object.entries(extra ?? {})) fd.set(k, v);
    const r = await action({}, fd);
    setMsg(r);
    if (r.ok) { setPng(null); router.refresh(); onSaved?.(); }
  });

  return (
    <div>
      {!png ? (
        <button type="button" className={`btn${size}`} onClick={() => setDraw(true)}>{drawLabel}</button>
      ) : (
        <div>
          <p className="small muted">This is how it will appear on the sheet:</p>
          <div style={{ background: "#fff", border: "1.5px solid var(--line)", borderRadius: 10, padding: 16, display: "inline-block" }}>
            <img src={png} alt="Signature preview" style={{ maxHeight: compact ? 80 : 120, maxWidth: "100%" }} />
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn" disabled={pending} onClick={save}>{pending ? "Saving…" : "Use this signature"}</button>
            <button className="btn ghost" onClick={() => { setPng(null); setDraw(true); }}>Sign again</button>
          </div>
        </div>
      )}
      <Msg state={msg} />
      {draw && <SignatureModal title={title} onCancel={() => setDraw(false)} onSave={(p) => { setDraw(false); setPng(p); }} />}
    </div>
  );
}

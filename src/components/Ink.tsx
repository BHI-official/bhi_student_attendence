"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Handwriting for every field that needs it: signatures, and handwritten notes and comments.
 *
 *   <InkField>  the small "bubble" on the form. Tapping it opens the pad; what was written shows
 *               in the bubble afterwards, and is sent with the form (hidden input, PNG data URL).
 *   <InkPad>    the enlarged writing area that covers the screen. Finger, stylus or mouse.
 *
 * Strokes are kept as points (not pixels), so the drawing survives the tablet being rotated,
 * can be undone and redone stroke by stroke, and reopening the field continues the same drawing.
 */

export type InkKind = "signature" | "note";
type Pt = { x: number; y: number; p: number };
/** Points are in a fixed coordinate space: x and y are measured in thousandths of the pad's width. */
type Stroke = Pt[];
export type InkValue = { png: string; strokes: Stroke[] } | null;

const INK = "#1c3faa";
/** Output size limits; the server checks the same limits (src/lib/png.ts). */
const OUT = { signature: { maxW: 480, maxH: 160, minW: 40, minH: 15 }, note: { maxW: 1200, maxH: 600, minW: 30, minH: 15 } } as const;

function drawStrokes(ctx: CanvasRenderingContext2D, strokes: Stroke[], scale: number) {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  for (const s of strokes) drawStroke(ctx, s, scale, 0);
}

/** Draws a stroke from point `from` on, with smoothed curves and pressure-based width. */
function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke, scale: number, from: number) {
  const width = (p: number) => Math.max(1.4, (2.2 + p * 2.6) * Math.max(0.6, scale / 0.9));
  if (s.length === 1) {
    ctx.beginPath();
    ctx.arc(s[0].x * scale, s[0].y * scale, width(s[0].p) / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  for (let i = Math.max(1, from); i < s.length; i++) {
    const a = s[i - 1], b = s[i];
    const prev = s[i - 2] ?? a;
    // Quadratic curve through midpoints: smooth lines from jittery touch input.
    const m0 = { x: (prev.x + a.x) / 2, y: (prev.y + a.y) / 2 };
    const m1 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    ctx.beginPath();
    ctx.lineWidth = width((a.p + b.p) / 2);
    ctx.moveTo(m0.x * scale, m0.y * scale);
    ctx.quadraticCurveTo(a.x * scale, a.y * scale, m1.x * scale, m1.y * scale);
    ctx.stroke();
    if (i === s.length - 1) {
      ctx.beginPath();
      ctx.moveTo(m1.x * scale, m1.y * scale);
      ctx.lineTo(b.x * scale, b.y * scale);
      ctx.stroke();
    }
  }
}

/** Crops the drawing to the ink, adds a margin and scales it to fit the output limits. */
function exportPng(strokes: Stroke[], kind: InkKind): string | null {
  const pts = strokes.flat();
  if (!pts.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  const lim = OUT[kind];
  const pad = 14; // in drawing units, also covers the line width
  const w = x1 - x0 + pad * 2, h = y1 - y0 + pad * 2;
  // Draw at 1 px per unit (the pad is 1000 units wide), shrinking to the limits if needed.
  const s = Math.min(1, lim.maxW / w, lim.maxH / h);
  const out = document.createElement("canvas");
  out.width = Math.max(lim.minW, Math.round(w * s));
  out.height = Math.max(lim.minH, Math.round(h * s));
  const ctx = out.getContext("2d")!;
  // Centre the ink if the image was padded up to the minimum size.
  ctx.translate((out.width - w * s) / 2, (out.height - h * s) / 2);
  ctx.translate((-x0 + pad) * s, (-y0 + pad) * s);
  drawStrokes(ctx, strokes, s);
  return out.toDataURL("image/png");
}

/** Has the person actually written something (not a stray tap)? */
function inkExtent(strokes: Stroke[]) {
  const pts = strokes.flat();
  if (!pts.length) return 0;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
}

/**
 * The enlarged writing area. Covers the screen so writing with a finger is easy, and keeps the page
 * underneath from scrolling. When a stylus is in use, touches from the hand resting on the screen
 * are ignored.
 */
export function InkPad({ kind, title, hint, initial, onDone, onCancel, doneLabel }: {
  kind: InkKind; title: string; hint?: string; initial?: Stroke[];
  onDone: (v: InkValue) => void; onCancel: () => void; doneLabel?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [strokes, setStrokes] = useState<Stroke[]>(() => initial ?? []);
  const [undone, setUndone] = useState<Stroke[]>([]);
  const [tooSmall, setTooSmall] = useState(false);
  const live = useRef<{ id: number; stroke: Stroke } | null>(null);
  const penSeen = useRef(false);
  const scale = useRef(1); // CSS px per drawing unit
  const strokesRef = useRef(strokes);
  strokesRef.current = strokes;
  const titleId = useId();

  const redraw = useCallback(() => {
    const c = canvas.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    drawStrokes(ctx, strokesRef.current, scale.current);
    if (live.current) drawStrokes(ctx, [live.current.stroke], scale.current);
  }, []);

  // Size the canvas to its box (and again on rotate / resize), keeping the drawing.
  useLayoutEffect(() => {
    const c = canvas.current!;
    const fit = () => {
      const r = c.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
      c.width = Math.round(r.width * dpr);
      c.height = Math.round(r.height * dpr);
      scale.current = r.width / 1000;
      redraw();
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(c);
    return () => ro.disconnect();
  }, [redraw]);

  useEffect(() => { redraw(); }, [strokes, redraw]);

  // Lock page scroll, close on Escape, undo / redo from the keyboard, focus inside the dialog.
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const prevFocus = document.activeElement as HTMLElement | null;
    box.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onCancel(); }
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      if (mod && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) { e.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("keydown", key); document.body.style.overflow = prevOverflow; prevFocus?.focus?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onCancel]);

  const point = (e: PointerEvent | React.PointerEvent): Pt => {
    const r = canvas.current!.getBoundingClientRect();
    // Mice and fingers report 0 or 0.5; only a stylus gives real pressure.
    const p = e.pointerType === "pen" && e.pressure > 0 ? e.pressure : 0.5;
    return { x: (e.clientX - r.left) / scale.current, y: (e.clientY - r.top) / scale.current, p };
  };

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === "pen") penSeen.current = true;
    else if (e.pointerType === "touch" && penSeen.current) return; // palm resting on the screen
    if (e.button > 0) return;
    if (live.current) return; // one stroke at a time (ignore a second finger)
    e.preventDefault();
    canvas.current!.setPointerCapture(e.pointerId);
    live.current = { id: e.pointerId, stroke: [point(e)] };
    setTooSmall(false);
    redraw();
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const l = live.current;
    if (!l || l.id !== e.pointerId) return;
    e.preventDefault();
    const events = typeof e.nativeEvent.getCoalescedEvents === "function" ? e.nativeEvent.getCoalescedEvents() : [];
    const from = l.stroke.length;
    for (const ev of events.length ? events : [e.nativeEvent]) {
      const pt = point(ev);
      const last = l.stroke[l.stroke.length - 1];
      if (Math.hypot(pt.x - last.x, pt.y - last.y) >= 0.6) l.stroke.push(pt);
    }
    const c = canvas.current!;
    const ctx = c.getContext("2d")!;
    ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = INK; ctx.fillStyle = INK;
    if (l.stroke.length > from) drawStroke(ctx, l.stroke, scale.current, Math.max(1, from - 1));
  };
  const up = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const l = live.current;
    if (!l || l.id !== e.pointerId) return;
    live.current = null;
    setStrokes((s) => [...s, l.stroke]);
    setUndone([]);
  };

  // Undo / redo read the current lists from refs, so the keyboard shortcuts never see stale state.
  const undoneRef = useRef(undone);
  undoneRef.current = undone;
  function undo() {
    const s = strokesRef.current;
    if (!s.length) return;
    setUndone([...undoneRef.current, s[s.length - 1]]);
    setStrokes(s.slice(0, -1));
    setTooSmall(false);
  }
  function redo() {
    const u = undoneRef.current;
    if (!u.length) return;
    setStrokes([...strokesRef.current, u[u.length - 1]]);
    setUndone(u.slice(0, -1));
  }
  const clear = () => { setUndone([...undoneRef.current, ...[...strokesRef.current].reverse()]); setStrokes([]); setTooSmall(false); };

  const done = () => {
    if (!strokes.length) { onDone(null); return; }
    // A signature has to be big enough to read on the printed sheet.
    if (inkExtent(strokes) < (kind === "signature" ? 60 : 25)) { setTooSmall(true); return; }
    const png = exportPng(strokes, kind);
    onDone(png ? { png, strokes } : null);
  };

  const empty = strokes.length === 0;
  return createPortal(
    <div className="inkmodal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className={`inkbox ${kind}`} ref={box} tabIndex={-1}>
        <header>
          <h2 id={titleId}>{title}</h2>
          {hint && <p>{hint}</p>}
        </header>
        <div className="inkarea">
          <canvas
            ref={canvas}
            onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
            onContextMenu={(e) => e.preventDefault()}
            role="img"
            aria-label={kind === "signature" ? "Signature area. Write your signature with your finger, a stylus or the mouse." : "Writing area. Write with your finger, a stylus or the mouse."}
          />
          {kind === "signature" && <span className="inkline" aria-hidden><span>✕</span></span>}
          {empty && <span className="inkempty" aria-hidden>{kind === "signature" ? "Sign here" : "Write here"}</span>}
        </div>
        {tooSmall && <p className="msg err inkmsg" role="alert">{kind === "signature" ? "That's too small to read. Write your signature bigger, across the line." : "That's too small to read. Write bigger."}</p>}
        <footer>
          <div className="row">
            <button type="button" className="btn ghost" onClick={undo} disabled={empty} aria-keyshortcuts="Control+Z">Undo</button>
            <button type="button" className="btn ghost" onClick={redo} disabled={!undone.length} aria-keyshortcuts="Control+Y">Redo</button>
            <button type="button" className="btn ghost" onClick={clear} disabled={empty}>Clear</button>
          </div>
          <div className="row">
            <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
            <button type="button" className="btn" onClick={done} disabled={empty && !initial?.length}>{doneLabel ?? (kind === "signature" ? "Use this signature" : "Done")}</button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/**
 * A handwriting field on a form: shows what was written, and opens the enlarged pad when tapped.
 * Works controlled (value + onChange) or inside a plain <form> (the PNG is sent as `name`).
 */
export function InkField({ name, kind = "signature", label, title, hint, value, onChange, required, disabled, compact, emptyText }: {
  name?: string; kind?: InkKind; label?: string; title?: string; hint?: string;
  value?: InkValue; onChange?: (v: InkValue) => void;
  required?: boolean; disabled?: boolean; compact?: boolean;
  /** Text in the empty bubble. */
  emptyText?: string;
}) {
  const [own, setOwn] = useState<InkValue>(null);
  const v = value !== undefined ? value : own;
  const set = (x: InkValue) => { if (value === undefined) setOwn(x); onChange?.(x); };
  const [open, setOpen] = useState(false);
  const id = useId();
  const close = useCallback(() => setOpen(false), []);
  const what = kind === "signature" ? "signature" : "handwriting";
  return (
    <div className={`inkfield${compact ? " compact" : ""}`}>
      {label && <label htmlFor={id}>{label}{required && <span className="muted"> (required)</span>}</label>}
      <button
        id={id} type="button" className={`inkbubble ${kind}${v ? " filled" : ""}`} disabled={disabled}
        onClick={() => setOpen(true)}
        aria-label={v ? `${label ?? title ?? "Handwriting"}: written. Tap to change it.` : `${label ?? title ?? "Handwriting"}: tap to write`}
      >
        {v ? <img src={v.png} alt="" /> : <span>{emptyText ?? (kind === "signature" ? "Tap to sign" : "Tap to write")}</span>}
      </button>
      {v && !disabled && (
        <button type="button" className="linkbtn small" onClick={() => set(null)}>Clear {what}</button>
      )}
      {name && <input type="hidden" name={name} value={v?.png ?? ""} />}
      {open && (
        <InkPad
          kind={kind}
          title={title ?? label ?? (kind === "signature" ? "Sign here" : "Write here")}
          hint={hint}
          initial={v?.strokes}
          onCancel={close}
          onDone={(x) => { set(x); setOpen(false); }}
        />
      )}
    </div>
  );
}

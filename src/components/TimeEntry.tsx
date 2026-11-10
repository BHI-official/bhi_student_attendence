"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import type { ActionState } from "@/lib/action";
import { checkTypedTime, clockIn, time12, toMinutes, type TimeRules } from "@/lib/sheet";
import { InkCanvas, InkField, exportPng, inkExtent, type InkValue, type Stroke } from "./Ink";

/** The school's clock, kept in step with the server rather than the tablet's own (possibly wrong) clock. */
export type SchoolClock = { tz: string; serverNow: number; rules: TimeRules };

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

function useSchoolMinutes(clock: SchoolClock) {
  // Offset between this device and the server, measured once when the page arrived.
  const offset = useRef<number | null>(null);
  if (offset.current === null) offset.current = clock.serverNow - Date.now();
  const read = () => toMinutes(clockIn(clock.tz, new Date(Date.now() + (offset.current ?? 0)), "end"));
  const [mins, setMins] = useState(read);
  useEffect(() => {
    const id = setInterval(() => setMins(read()), 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clock.tz]);
  return mins;
}

/** Smallest handwriting we accept for a time, in drawing units (the box is 1000 wide). */
const MIN_TIME_INK = 40;

/**
 * Student writes their start or end time by hand, right in the dialog, like on the paper sheet.
 * The handwriting is what the sheet shows. The server records its own clock reading alongside it,
 * and the hours come from that, so the hours are always the school clock's.
 */
export function TimeEntry({ kind, clock, start, action, onDone, onCancel, rewrite }: {
  kind: "start" | "end";
  clock: SchoolClock;
  /** Writing a saved time again: the time the school clock recorded, and the handwriting so far. */
  rewrite?: { time: string; ink: string | null };
  start?: { time: string; enteredAtMinutes: number | null };
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>;
  onDone: (r: ActionState) => void;
  onCancel: () => void;
}) {
  const now = useSchoolMinutes(clock);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, run] = useTransition();
  /** End of day: the student signs by hand too. */
  const [signature, setSignature] = useState<InkValue>(null);
  const needsSignature = kind === "end" && !rewrite;
  const word = kind === "start" ? "start" : "end";
  const firstButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { firstButton.current?.focus(); }, []);

  // Same checks the server makes on its clock reading (e.g. a day that's too short).
  // (Rewriting doesn't change the recorded time, so there's nothing to check.)
  const timing = rewrite ? ({ ok: true } as const) : checkTypedTime(kind, hhmm(now), now, clock.rules, start);
  const written = strokes.length > 0;

  const save = () => run(async () => {
    if (!written) { setError(`Write your ${word} time in the box first.`); return; }
    if (inkExtent(strokes) < MIN_TIME_INK) { setError("That's too small to read. Write the time bigger, across the box."); return; }
    const png = exportPng(strokes, "time");
    if (!png) { setError(`Write your ${word} time in the box first.`); return; }
    const fd = new FormData();
    fd.set("timeInk", png);
    if (needsSignature) {
      if (!signature) { setError("Sign in the signature box first."); return; }
      fd.set("signature", signature.png);
    }
    let r: ActionState;
    try { r = await action({}, fd); } catch { r = { error: "Couldn't save. Check the connection and try again." }; }
    if (r.error) { setError(r.error); return; }
    onDone(r);
  });

  return (
    <div className="sigmodal" role="dialog" aria-modal="true" aria-labelledby="te-title" onKeyDown={(e) => { if (e.key === "Escape" && !pending && !document.querySelector(".inkmodal")) onCancel(); }}>
      <div className="panel timebox">
        <h2 id="te-title">{rewrite ? `Write your ${word} time again` : kind === "start" ? "When did you arrive?" : "When did class end for you?"}</h2>
        {rewrite ? (
          <div className="rewrite-was">
            {rewrite.ink && <span className="small muted">You wrote:</span>}
            {rewrite.ink && <img className="timeink" src={rewrite.ink} alt={`Your handwritten ${word} time`} />}
            <span className="small">The school clock recorded <strong>{time12(rewrite.time)}</strong>.</span>
          </div>
        ) : (
          <p className="clocknow" aria-live="off">It&apos;s <strong>{time12(hhmm(now))}</strong> now</p>
        )}

        <div className="field">
          <span className="timepad-label" id="te-label">{rewrite ? `Write the right ${word} time` : `Write your ${word} time`}</span>
          <div className={`timepad${written ? " written" : ""}`}>
            <InkCanvas
              strokes={strokes}
              onStroke={(s) => { setStrokes((x) => [...x, s]); setError(null); }}
              label={`Write your ${word} time here with your finger, a stylus or the mouse.`}
            />
            {!written && <span className="timepad-ghost" aria-hidden>{time12(rewrite?.time ?? hhmm(now)).replace(" ", "")}</span>}
          </div>
          <div className="row timepad-tools">
            <span id="te-help" className="small muted">Write it like you would on the paper sheet.</span>
            <span className="row" style={{ gap: 6 }}>
              <button ref={firstButton} type="button" className="btn ghost small" disabled={!written || pending} onClick={() => setStrokes((x) => x.slice(0, -1))}>Undo</button>
              <button type="button" className="btn ghost small" disabled={!written || pending} onClick={() => setStrokes([])}>Clear</button>
            </span>
          </div>
        </div>

        {kind === "end" && start && !rewrite && timing.ok && (
          <p className="small">You started at {time12(start.time)}. By the school clock that&apos;s {Math.floor((now - toMinutes(start.time)) / 60)} h {(now - toMinutes(start.time)) % 60} min so far.</p>
        )}
        {needsSignature && (
          <InkField
            kind="signature" label="Your signature" required compact={false}
            title="Sign for today" hint="Use your finger, a stylus or the mouse. Undo or clear if you want to try again."
            value={signature} onChange={(v) => { setSignature(v); setError(null); }}
          />
        )}
        <p className="small muted">
          {rewrite
            ? <>Only your handwriting changes. The school clock time ({time12(rewrite.time)}) and your hours stay the same, and staff can see that you rewrote it.</>
            : <>The school clock time ({time12(hhmm(now))}) is saved with your handwriting and used for your hours. You can write it again today, until your teacher signs your row.</>}
        </p>
        {!timing.ok && <p className="msg err" role="alert">{timing.error}</p>}
        {error && <p className="msg err" role="alert">{error}</p>}
        <div className="row" style={{ justifyContent: "flex-end", marginTop: 16 }}>
          <button type="button" className="btn ghost" disabled={pending} onClick={onCancel}>Cancel</button>
          <button type="button" className="btn" disabled={pending || !timing.ok || !written || (needsSignature && !signature)} onClick={save}>
            {pending ? "Saving…" : rewrite ? `Save new ${word} time` : needsSignature ? "Save end time and signature" : "Save start time"}
          </button>
        </div>
      </div>
    </div>
  );
}

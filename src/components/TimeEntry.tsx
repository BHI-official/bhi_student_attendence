"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import type { ActionState } from "@/lib/action";
import { checkTypedTime, clockIn, time12, toMinutes, type TimeRules } from "@/lib/sheet";
import { InkField, type InkValue } from "./Ink";

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

/**
 * Student types their start or end time. Shows the school's time now, checks the time with the same
 * rules the server uses, then asks the student to confirm before saving. The server checks again.
 */
export function TimeEntry({ kind, clock, start, action, onDone, onCancel }: {
  kind: "start" | "end";
  clock: SchoolClock;
  start?: { time: string; enteredAtMinutes: number | null };
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>;
  onDone: (r: ActionState) => void;
  onCancel: () => void;
}) {
  const now = useSchoolMinutes(clock);
  const [value, setValue] = useState(() => hhmm(now));
  const [step, setStep] = useState<"type" | "confirm">("type");
  const [error, setError] = useState<string | null>(null);
  const [pending, run] = useTransition();
  /** End of day: the student signs by hand before saving. */
  const [signature, setSignature] = useState<InkValue>(null);
  const needsSignature = kind === "end";
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);

  const earliest = Math.max(0, now - clock.rules.windowMinutes);
  const check = () => checkTypedTime(kind, value, now, clock.rules, start);
  const word = kind === "start" ? "start" : "end";

  const review = (ev: React.FormEvent) => {
    ev.preventDefault();
    const c = check();
    if (!c.ok) { setError(c.error); return; }
    setError(null);
    setValue(c.time);
    setStep("confirm");
  };
  const save = () => run(async () => {
    const fd = new FormData();
    fd.set("time", value);
    if (needsSignature) {
      if (!signature) { setError("Sign in the box first."); return; }
      fd.set("signature", signature.png);
    }
    let r: ActionState;
    try { r = await action({}, fd); } catch { r = { error: "Couldn't save. Check the connection and try again." }; }
    // A signature problem keeps the student on this step; a time problem goes back to the time.
    if (r.error) { setError(r.error); if (!r.fieldErrors?.signature) setStep("type"); return; }
    onDone(r);
  });

  const typed = check();
  return (
    <div className="sigmodal" role="dialog" aria-modal="true" aria-labelledby="te-title" onKeyDown={(e) => { if (e.key === "Escape" && !pending && !document.querySelector(".inkmodal")) onCancel(); }}>
      <div className="panel timebox">
        <h2 id="te-title">{kind === "start" ? "When did you arrive?" : "When did class end for you?"}</h2>
        <p className="clocknow" aria-live="off">It&apos;s <strong>{time12(hhmm(now))}</strong> now</p>

        {step === "type" ? (
          <form onSubmit={review} noValidate>
            <div className="field">
              <label htmlFor="te-time">Your {word} time</label>
              <input
                ref={input} id="te-time" type="time" step={60} value={value} required
                onChange={(e) => { setValue(e.target.value); setError(null); }}
                aria-invalid={!!error} aria-describedby="te-help"
                className="timein"
              />
              <span id="te-help" className="small muted">
                Any time from {time12(hhmm(earliest))} to {time12(hhmm(now))}.
                {kind === "end" && start && <> You started at {time12(start.time)}.</>}
              </span>
            </div>
            <button type="button" className="btn ghost" onClick={() => { setValue(hhmm(now)); setError(null); }}>Use the time now ({time12(hhmm(now))})</button>
            {error && <p className="msg err" role="alert">{error}</p>}
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 16 }}>
              <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
              <button className="btn">Next</button>
            </div>
          </form>
        ) : (
          <div>
            <p className="confirmline">
              {kind === "start" ? "Start time" : "End time"}: <span className="hand">{time12(value)}</span>
            </p>
            {kind === "end" && start && typed.ok && (
              <p>{time12(start.time)} to {time12(value)}, which is {Math.floor((toMinutes(value) - toMinutes(start.time)) / 60)} h {(toMinutes(value) - toMinutes(start.time)) % 60} min.</p>
            )}
            {needsSignature && (
              <InkField
                kind="signature" label="Your signature" required compact={false}
                title="Sign for today" hint="Use your finger, a stylus or the mouse. Undo or clear if you want to try again."
                value={signature} onChange={(v) => { setSignature(v); setError(null); }}
              />
            )}
            <p className="small muted">You can&apos;t change this yourself after saving. If it&apos;s wrong later, a staff member can correct it.</p>
            {!typed.ok && <p className="msg err" role="alert">{typed.error}</p>}
            {error && <p className="msg err" role="alert">{error}</p>}
            <div className="row" style={{ justifyContent: "flex-end", marginTop: 16 }}>
              <button type="button" className="btn ghost" disabled={pending} onClick={() => setStep("type")}>Change it</button>
              <button type="button" className="btn" disabled={pending || !typed.ok || (needsSignature && !signature)} onClick={save}>{pending ? "Saving…" : needsSignature ? "Save end time and signature" : `Save ${word} time`}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

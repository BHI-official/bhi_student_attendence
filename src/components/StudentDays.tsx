"use client";

import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { ActionState } from "@/lib/action";
import { STATUS_LABEL, type DayStatus } from "@/lib/week";
import { submitDayAction, uploadExcuseAction } from "@/actions/student";
import { InkField, type InkValue } from "./Ink";
import { HandTimes } from "./HandTimes";
import { Msg } from "./forms";

export type StudentDay = {
  date: string;
  label: string;
  isToday: boolean;
  classDay: boolean;
  holiday: string | null;
  status: DayStatus;
  times: { label: string; ink: string | null; typed: string }[];
  sig: string | null;
  approvedBy: string | null;
  approvedSig: string | null;
  signedOffBy: string | null;
  correction: string | null;
  markedPresent: boolean;
  excuse: { status: "PENDING" | "APPROVED" | "REJECTED"; fileName: string; reason: string } | null;
  canSubmit: boolean;
  canExcuse: boolean;
};
export type StudentWeek = { title: string; sub: string; days: StudentDay[] };

const STUDENT_WORDS: Partial<Record<DayStatus, string>> = { MISSING: "Not signed yet", ABSENT: "Absent" };

function Img({ id, alt, h }: { id: string | null; alt: string; h: number }) {
  // eslint-disable-next-line @next/next/no-img-element
  return id ? <img className="inkimg" src={`/api/ink/${id}`} alt={alt} height={h} /> : null;
}

/** This week and last week, one card per day. Tap a day to fill it in and sign it. */
export function StudentDays({ weeks, teacherName }: { weeks: StudentWeek[]; teacherName: string | null }) {
  const [open, setOpen] = useState<{ date: string; kind: "fill" | "excuse" } | null>(null);
  const [done, setDone] = useState<{ title: string; message: string } | null>(null);
  const router = useRouter();
  const finish = (message: string) => {
    setDone({ title: open?.kind === "excuse" ? "Excuse uploaded" : "Attendance submitted", message });
    setOpen(null);
    router.refresh();
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  return (
    <>
      {done && (
        <div className="confirm" role="status">
          <span className="tick" aria-hidden>✓</span>
          <div><strong>{done.title}</strong><p>{done.message}</p></div>
          <button type="button" className="linkbtn" onClick={() => setDone(null)}>Close</button>
        </div>
      )}
      {weeks.map((w) => (
        <section key={w.title} className="week" aria-label={w.title}>
          <h2>{w.title} <span className="sub">{w.sub}</span></h2>
          <ol className="days">
            {w.days.map((d) => {
              const isOpen = open?.date === d.date;
              const tone = !d.classDay || d.status === "UPCOMING" || d.status === "HOLIDAY" ? "quiet" : d.status.toLowerCase();
              return (
                <li key={d.date} className={`day t-${tone}${d.isToday ? " today" : ""}${isOpen ? " open" : ""}`}>
                  <div className="dayline">
                    <div className="when">
                      <strong>{d.label}</strong>
                      {d.isToday && <span className="small">Today</span>}
                    </div>
                    <div className="what">
                      {!d.classDay ? <span className="muted">No class</span>
                        : d.holiday ? <span className="muted">Holiday: {d.holiday}</span>
                        : d.status === "UPCOMING" ? <span className="muted">Upcoming</span>
                        : <span className={`chip s-${d.status.toLowerCase()}`}>{STUDENT_WORDS[d.status] ?? STATUS_LABEL[d.status]}</span>}
                      {d.status !== "ABSENT" && d.status !== "EXCUSED" && <HandTimes times={d.times} h={26} />}
                      {d.sig && d.status !== "ABSENT" && <span className="ht"><span className="ht-label">Your signature</span><Img id={d.sig} alt="Your signature" h={34} /></span>}
                      {d.approvedSig && d.status === "APPROVED" && <span className="ht"><span className="ht-label">Teacher</span><Img id={d.approvedSig} alt={`Signature of ${d.approvedBy}`} h={34} /></span>}
                    </div>
                    <div className="go">
                      {d.canSubmit && !isOpen && (
                        <button type="button" className="btn" onClick={() => setOpen({ date: d.date, kind: "fill" })}>
                          {d.status === "MISSING" ? "Fill in & sign" : d.status === "NEEDS_CORRECTION" ? "Fix & sign again" : "Change & sign again"}
                        </button>
                      )}
                      {d.canExcuse && !isOpen && (
                        <button type="button" className={d.status === "ABSENT" ? "btn" : "linkbtn small"} onClick={() => setOpen({ date: d.date, kind: "excuse" })}>
                          {d.excuse ? "Upload a new excuse" : d.status === "ABSENT" ? "Upload excuse" : "Absent? Upload excuse"}
                        </button>
                      )}
                    </div>
                  </div>
                  {(d.correction || d.approvedBy || d.excuse || d.signedOffBy || (d.markedPresent && d.status === "MISSING")) && (
                    <div className="daynotes">
                      {d.status === "NEEDS_CORRECTION" && d.correction && <p className="needs"><b>Your teacher says:</b> {d.correction}</p>}
                      {d.status === "APPROVED" && d.approvedBy && <p className="small muted">Checked and signed by {d.approvedBy}. Locked.</p>}
                      {d.signedOffBy && d.status !== "APPROVED" && <p className="small muted">This month is signed off by {d.signedOffBy}. Locked.</p>}
                      {d.markedPresent && d.status === "MISSING" && <p className="small">You were marked present. Please fill in your times and sign.</p>}
                      {d.excuse && (
                        <p className="small">
                          Excuse ({d.excuse.fileName}): <b>{d.excuse.status === "PENDING" ? "waiting for your teacher" : d.excuse.status.toLowerCase()}</b>
                          {d.excuse.reason ? ` – ${d.excuse.reason}` : ""}
                        </p>
                      )}
                    </div>
                  )}
                  {isOpen && open.kind === "fill" && <DayForm day={d} teacherName={teacherName} onCancel={() => setOpen(null)} onDone={finish} />}
                  {isOpen && open.kind === "excuse" && <ExcuseForm day={d} onCancel={() => setOpen(null)} onDone={finish} />}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </>
  );
}

/** The four times, written by hand, in the order of the paper sheet. */
const TIMES = [
  { name: "startInk", label: "Start time", title: "Write the time you arrived", empty: "Tap to write", required: true },
  { name: "lunchStartInk", label: "Lunch start", title: "Write the time your lunch break started", empty: "Tap to write", required: false },
  { name: "lunchEndInk", label: "Lunch end", title: "Write the time your lunch break ended", empty: "Tap to write", required: false },
  { name: "endInk", label: "End time", title: "Write the time you left", empty: "Tap to write", required: true },
] as const;

/**
 * Fill in one day, all by hand: start, lunch start, lunch end, end, then sign. The button is never
 * greyed out: if something is missing, pressing it says exactly what.
 */
function DayForm({ day, teacherName, onCancel, onDone }: { day: StudentDay; teacherName: string | null; onCancel: () => void; onDone: (m: string) => void }) {
  const [state, run, pending] = useActionState<ActionState, FormData>(submitDayAction.bind(null, day.date), {});
  const [ink, setInk] = useState<Record<string, InkValue>>({});
  const [sig, setSig] = useState<InkValue>(null);
  const [missing, setMissing] = useState<string[]>([]);
  useEffect(() => { if (state.ok && state.message) onDone(state.message); }, [state, onDone]);
  const fe = state.fieldErrors ?? {};
  const check = (e: React.FormEvent) => {
    const m: string[] = [];
    if (!ink.startInk) m.push("write your start time");
    if (!!ink.lunchStartInk !== !!ink.lunchEndInk) m.push(ink.lunchStartInk ? "write your lunch end time" : "write your lunch start time");
    if (!ink.endInk) m.push("write your end time");
    if (!sig) m.push("sign");
    setMissing(m);
    if (m.length) e.preventDefault();
  };
  return (
    <form action={run} onSubmit={check} className="dayform">
      {day.status === "NEEDS_CORRECTION" && day.correction && <p className="needs"><b>Your teacher says:</b> {day.correction}</p>}
      <p className="small muted" style={{ marginTop: 0 }}>Write each time by hand, like on the paper sheet. Skip both lunch boxes if you had no lunch break.</p>
      <div className="timegrid">
        {TIMES.map((t) => (
          <div key={t.name} className={`timecell${fe[t.name] ? " bad" : ""}`}>
            <InkField name={t.name} kind="time" label={t.label} title={t.title} hint="For example 9:00 or 12:30" emptyText={t.empty}
              value={ink[t.name] ?? null} onChange={(v) => setInk((x) => ({ ...x, [t.name]: v }))} compact />
            {!t.required && <span className="small muted">if you had lunch</span>}
            {fe[t.name] && <span className="err">{fe[t.name]}</span>}
          </div>
        ))}
      </div>
      <InkField name="signature" kind="signature" label="Your signature for this day" title={`Sign for ${day.label}`} hint="A new signature for each day." value={sig} onChange={setSig} />
      {fe.signature && <span className="err">{fe.signature}</span>}
      <div className="field" style={{ marginTop: 12 }}>
        <label htmlFor={`note-${day.date}`}>Note for your teacher (optional)</label>
        <textarea id={`note-${day.date}`} name="note" rows={2} maxLength={500} placeholder={day.isToday ? "" : "e.g. I forgot to sign on the day"} />
      </div>
      {missing.length > 0 && <p className="msg err" role="alert">Before you submit, please {missing.join(", ")}.</p>}
      <Msg state={state.ok ? {} : state} />
      <div className="row">
        <button className="btn big" disabled={pending}>{pending ? "Saving…" : "Submit attendance"}</button>
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
      <p className="small muted">It goes to {teacherName ?? "your teacher"}, who checks it and signs.</p>
    </form>
  );
}

/** Upload a doctor's note or other document for an absence. */
function ExcuseForm({ day, onCancel, onDone }: { day: StudentDay; onCancel: () => void; onDone: (m: string) => void }) {
  const [state, run, pending] = useActionState<ActionState, FormData>(uploadExcuseAction.bind(null, day.date), {});
  const [file, setFile] = useState<File | null>(null);
  useEffect(() => { if (state.ok && state.message) onDone(state.message); }, [state, onDone]);
  const tooBig = !!file && file.size > 4 * 1024 * 1024;
  return (
    <form action={run} className="dayform">
      <h3>Excuse for {day.label}</h3>
      <p className="small">Upload a doctor&apos;s note or other document (PDF, JPG or PNG, up to 4 MB). Your teacher reviews it. The day stays Absent until it&apos;s approved.</p>
      <div className="field">
        <label htmlFor={`file-${day.date}`}>Document</label>
        <input id={`file-${day.date}`} type="file" name="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" required
          onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        {tooBig && <span className="err">That file is bigger than 4 MB.</span>}
        {state.fieldErrors?.file && <span className="err">{state.fieldErrors.file}</span>}
      </div>
      <div className="field">
        <label htmlFor={`why-${day.date}`}>Explanation (optional)</label>
        <textarea id={`why-${day.date}`} name="note" rows={2} maxLength={500} placeholder="e.g. I was sick" />
      </div>
      <Msg state={state.ok ? {} : state} />
      <div className="row">
        <button className="btn big" disabled={pending || !file || tooBig}>{pending ? "Uploading…" : "Upload excuse"}</button>
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

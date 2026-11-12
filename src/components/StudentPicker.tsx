"use client";

import { useMemo, useState } from "react";
import Link from "next/link";

type S = { id: string; name: string; course: string };

/** Find your name among hundreds: type a few letters, or tap the first letter of your first name. */
export function StudentPicker({ students }: { students: S[] }) {
  const [q, setQ] = useState("");
  const [letter, setLetter] = useState("");
  const letters = useMemo(() => [...new Set(students.map((s) => s.name[0]?.toUpperCase()).filter(Boolean))].sort(), [students]);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return students.filter((s) => (t ? s.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(t)) || s.name.toLowerCase().includes(t) : !letter || s.name.toUpperCase().startsWith(letter)));
  }, [students, q, letter]);
  return (
    <>
      <label htmlFor="who" className="small muted">Type your first or last name</label>
      <input id="who" className="search" value={q} autoComplete="off" autoFocus placeholder="e.g. Kevin"
        onChange={(e) => { setQ(e.target.value); setLetter(""); }} />
      <div className="letters" role="group" aria-label="First letter of your first name">
        {letters.map((l) => (
          <button key={l} type="button" aria-pressed={letter === l} onClick={() => { setLetter(letter === l ? "" : l); setQ(""); }}>{l}</button>
        ))}
      </div>
      {students.length === 0 ? (
        <p className="msg info">No students have been added yet. Please ask the office.</p>
      ) : !q && !letter && students.length > 24 ? (
        <p className="muted">Start typing your name, or tap a letter.</p>
      ) : shown.length === 0 ? (
        <p className="msg info">No name matches “{q}”. Check the spelling, or ask a staff member.</p>
      ) : (
        <div className="names">
          {shown.slice(0, 60).map((s) => (
            <Link key={s.id} href={`/student/${s.id}`} className="name"><strong>{s.name}</strong><span>{s.course}</span></Link>
          ))}
        </div>
      )}
    </>
  );
}

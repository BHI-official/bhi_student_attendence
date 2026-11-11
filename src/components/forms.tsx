"use client";

import { createContext, useActionState, useContext, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import type { ActionState } from "@/lib/action";

type Act = (prev: ActionState, fd: FormData) => Promise<ActionState>;
const Ctx = createContext<ActionState>({});

/** A form wired to a server action, showing its result message. */
export function ActionForm({ action, children, confirm, className, hideMessage, id }: { action: Act; children: ReactNode; confirm?: string; className?: string; hideMessage?: boolean; id?: string }) {
  const [state, run] = useActionState(action, {});
  return (
    <Ctx.Provider value={state}>
      <form id={id} action={run} className={className} onSubmit={(e) => { if (confirm && !window.confirm(confirm)) e.preventDefault(); }}>
        {children}
        {!hideMessage && <Msg state={state} />}
      </form>
    </Ctx.Provider>
  );
}
export const useFormResult = () => useContext(Ctx);

export function Msg({ state }: { state: ActionState }) {
  if (state.error) return <p className="msg err" role="alert">{state.error}</p>;
  if (state.ok && state.message) return <p className="msg ok" role="status">{state.message}</p>;
  return null;
}

export function Submit({ children, className = "btn", disabled }: { children: ReactNode; className?: string; disabled?: boolean }) {
  const { pending } = useFormStatus();
  return <button type="submit" className={className} disabled={pending || disabled}>{pending ? "Working…" : children}</button>;
}

export function Field({ name, label, type = "text", defaultValue, required, placeholder, inputMode, children }: {
  name: string; label: string; type?: string; defaultValue?: string; required?: boolean; placeholder?: string;
  inputMode?: "numeric" | "text" | "email"; children?: ReactNode;
}) {
  const err = useContext(Ctx).fieldErrors?.[name];
  return (
    <div className="field">
      <label htmlFor={`f-${name}`}>{label}</label>
      {children ?? (type === "textarea"
        ? <textarea id={`f-${name}`} name={name} defaultValue={defaultValue} rows={3} placeholder={placeholder} />
        : <input id={`f-${name}`} name={name} type={type} defaultValue={defaultValue} required={required} placeholder={placeholder} inputMode={inputMode} aria-invalid={!!err} />)}
      {err && <span className="err">{err}</span>}
    </div>
  );
}

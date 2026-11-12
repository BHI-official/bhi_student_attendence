"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ActionState } from "@/lib/action";
import { decideExcuseAction } from "@/actions/staff";
import { Msg } from "./forms";

/** Approve or reject one excuse (admins can also change an earlier decision). */
export function ExcuseDecision({ entryKey, status }: { entryKey: string; status: "PENDING" | "APPROVED" | "REJECTED" }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<ActionState>({});
  const [pending, start] = useTransition();
  const decide = (decision: "APPROVED" | "REJECTED") => start(async () => {
    const fd = new FormData();
    fd.set("decision", decision); fd.set("reason", reason);
    const r = await decideExcuseAction.bind(null, entryKey)({}, fd);
    if (!r.ok) { setMsg(r); return; }
    // Show the list the excuse now belongs to, with the confirmation at the top.
    router.push(`/admin/excuses?status=${decision}&done=${encodeURIComponent(r.message ?? "Saved.")}`);
  });
  return (
    <div className="excuse-decide">
      <div className="row">
        <input aria-label="Reason (needed to reject)" placeholder="Reason (needed to reject)" value={reason} onChange={(e) => setReason(e.target.value)} />
        {status !== "APPROVED" && <button type="button" className="btn sm" disabled={pending} onClick={() => decide("APPROVED")}>{status === "REJECTED" ? "Change to approved" : "Approve"}</button>}
        {status !== "REJECTED" && <button type="button" className="btn sm ghost" disabled={pending} onClick={() => decide("REJECTED")}>{status === "APPROVED" ? "Change to rejected" : "Reject"}</button>}
      </div>
      <Msg state={msg} />
    </div>
  );
}

import "server-only";
import { createHash } from "node:crypto";
import type { Entry } from "./types";

/** What a month approval covers. Any later change to a row makes it differ, so the approval shows as outdated. */
export function entriesHash(entries: Entry[]) {
  const rows = [...entries].sort((a, b) => a.date.localeCompare(b.date)).map((e) => [
    e.date, e.status, e.startTime ?? "", e.endTime ?? "", e.minutes ?? "", !!e.studentSignature, !!e.staffSignature, e.note ?? "",
    // Handwritten times only when there are some, so approvals of older rows stay current.
    ...(e.startInkId || e.endInkId ? [e.startInkId ?? "", e.endInkId ?? ""] : []),
  ]);
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}


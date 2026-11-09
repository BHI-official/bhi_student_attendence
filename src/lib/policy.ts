import "server-only";
import { env } from "./env";
import { today } from "./data";
import { addDays, editWindow, usDate, type AttendanceThresholds } from "./sheet";
import type { Staff } from "./types";

/** Teachers can change a row for this many days after its class day; then only admins. */
export const editWindowDays = () => env().EDIT_WINDOW_DAYS;

/** The earliest class day that is still open for teachers (and for the student to sign). */
export const firstOpenDate = () => addDays(today(), -editWindowDays());

export const isLocked = (date: string) => editWindow(date, today(), editWindowDays()).locked;

/** null when this staff member may change the row for `date`, otherwise the reason they can't. */
export function lockedFor(staff: Pick<Staff, "role">, date: string): string | null {
  if (staff.role === "ADMIN" || !isLocked(date)) return null;
  return `${usDate(date)} is locked: rows can be changed for ${editWindowDays()} days after the class day. Ask an admin.`;
}

export const thresholds = (): AttendanceThresholds => ({ goodPercent: env().ATTENDANCE_GOOD_PERCENT, attentionPercent: env().ATTENDANCE_ATTENTION_PERCENT });

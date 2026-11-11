import "server-only";
import { env } from "./env";
import type { AttendanceThresholds } from "./sheet";

export const thresholds = (): AttendanceThresholds => ({ goodPercent: env().ATTENDANCE_GOOD_PERCENT, attentionPercent: env().ATTENDANCE_ATTENTION_PERCENT });

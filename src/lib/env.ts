import { z } from "zod";

const schema = z.object({
  MONGODB_URI: z.string().regex(/^mongodb(\+srv)?:\/\//, "MONGODB_URI must start with mongodb:// or mongodb+srv://"),
  MONGODB_DB: z.string().optional(),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  APP_TIMEZONE: z.string().default("America/New_York"),
  /** The shortest and longest day a student can record. */
  MIN_CLASS_MINUTES: z.coerce.number().int().min(1).max(240).default(5),
  MAX_CLASS_MINUTES: z.coerce.number().int().min(60).max(1440).default(720),
  /** Attendance colours on the profile: at or above GOOD is green, at or above ATTENTION is orange, below is red. */
  ATTENDANCE_GOOD_PERCENT: z.coerce.number().min(1).max(100).default(90),
  ATTENDANCE_ATTENTION_PERCENT: z.coerce.number().min(0).max(100).default(75),
  NODE_ENV: z.string().default("development"),
});

let cached: z.infer<typeof schema> | null = null;

/** Validated settings. Fails with a clear message on first use if something is missing. */
export function env() {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  if (parsed.data.ATTENDANCE_ATTENTION_PERCENT > parsed.data.ATTENDANCE_GOOD_PERCENT) {
    throw new Error("Invalid environment: ATTENDANCE_ATTENTION_PERCENT must not be above ATTENDANCE_GOOD_PERCENT");
  }
  cached = parsed.data;
  return cached;
}

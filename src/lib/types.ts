/** Data model. Everything is keyed so it can't be duplicated (one entry per student per date). */

export type Role = "ADMIN" | "TEACHER";

export type Staff = {
  _id: string;
  name: string;
  email: string;
  position: string; // e.g. "Asst. Director", printed on "Approved by"
  role: Role;
  /** Teachers see only students of these courses (by course name). Admins see everyone. */
  courses: string[];
  passwordHash: string;
  /** The handwritten signature on file, used to sign rows (teachers) and month approvals (admins). */
  signatureId: string | null;
  active: boolean;
  createdAt: Date;
};

/** Contact and social details shown on the student profile. All optional. */
export type StudentProfile = {
  phone: string;
  email: string;
  address: string;
  emergencyName: string;
  emergencyPhone: string;
  /** Free text: social / case notes the office wants on the profile (housing, transport, benefits...). */
  social: string;
};
export const EMPTY_PROFILE: StudentProfile = { phone: "", email: "", address: "", emergencyName: "", emergencyPhone: "", social: "" };

export type Student = {
  _id: string;
  name: string;
  nameLower: string;
  pinHash: string;
  /**
   * Keyed fingerprint of the PIN (HMAC), used only to keep PINs unique among active students.
   * null for students whose PIN was set before PINs were made unique (give them a new PIN).
   */
  pinKey?: string | null;
  /** The student's handwritten signature on file, applied to each day they fill out. */
  signatureId: string | null;
  courseName: string;
  courseCode: string;
  courseDuration: string;
  caseManager: string;
  instructor: string;
  startDate: string; // YYYY-MM-DD
  endDate: string;
  /** Class weekdays, 1 = Monday ... 7 = Sunday. */
  classDays: number[];
  profile?: StudentProfile;
  active: boolean;
  createdAt: Date;
};

export type EntryStatus = "PRESENT" | "ABSENT" | "EXCUSED" | "HOLIDAY";

/**
 * A signature image, stored once. Rows point to the version that was on file when they were
 * signed, so replacing a signature later never changes past rows.
 */
export type SignatureDoc = {
  _id: string;
  ownerType: "STUDENT" | "STAFF";
  ownerId: string;
  png: string; // data:image/png;base64,...
  /** Always DRAWN now (signed on the screen). UPLOAD only on older records from when photos were allowed. */
  source: "UPLOAD" | "DRAWN";
  /**
   * A signature, handwriting written into a note / comment field, or a start / end time the
   * student wrote by hand. Missing = signature.
   */
  kind?: "SIGNATURE" | "NOTE" | "TIME";
  createdAt: Date;
  createdBy: string; // who put it on file (the person, or the admin whose screen the student signed on)
};
export type Signature = {
  id: string;
  at: Date;
  /** Set when an admin added the student's signature on file to the row (not the student). */
  addedBy?: { staffId: string; staffName: string } | null;
};
export type StaffSignature = Signature & { staffId: string; staffName: string };

export type Change = { at: Date; byId: string; byName: string; what: string; reason: string };

/**
 * A comment on one row (one student, one day). Comments are added, never edited, and don't change
 * the row's times or signatures, so they don't undo a staff signature or a month approval.
 */
export type RowComment = {
  id: string;
  at: Date;
  byId: string;
  byName: string;
  byRole: "ADMIN" | "TEACHER" | "STUDENT";
  text: string;
  /** Handwriting written with the comment (a SignatureDoc of kind NOTE), if any. */
  inkId: string | null;
};

/** One row of the paper sheet: one student, one date. _id = `${studentId}:${date}`. */
export type Entry = {
  _id: string;
  studentId: string;
  date: string;
  status: EntryStatus;
  startAt: Date | null; // exact server time the student saved their start time
  endAt: Date | null; // exact server time the student saved their end time
  startTime: string | null; // HH:MM shown on the sheet (typed by the student, checked by the server)
  endTime: string | null;
  /**
   * The start / end time as the student wrote it by hand (a SignatureDoc of kind TIME). This is
   * what the sheet shows, like the paper. startTime / endTime hold the school clock's reading at
   * that moment, which the hours are worked out from. Cleared when staff correct the time;
   * missing on rows from before handwritten times.
   */
  startInkId?: string | null;
  endInkId?: string | null;
  /**
   * How many minutes before saving the typed time was (0 = typed "now"). Lets staff see rows
   * entered after the fact. null when staff wrote the time, or for rows from before typed times.
   */
  startLateBy?: number | null;
  endLateBy?: number | null;
  /**
   * Set when the student filled in a past class day afterwards (they forgot on the day). The times
   * are as the student typed them, so the row is flagged for the teacher's review. Missing = no.
   */
  filledLaterAt?: Date | null;
  minutes: number | null;
  studentSignature: Signature | null;
  staffSignature: StaffSignature | null;
  note: string;
  history: Change[];
  /** Comments from staff (and the student on their own day). Older rows have none. */
  comments?: RowComment[];
  updatedAt: Date;
};

export type Holiday = { _id: string /* date */; name: string; /** Optional note shown with the holiday. */ note?: string };

/** "Approved by" block at the bottom of a month. _id = `${studentId}:${month}`. */
export type MonthApproval = {
  _id: string;
  studentId: string;
  month: string; // YYYY-MM
  staffId: string;
  staffName: string;
  position: string;
  signatureId: string;
  comments: string;
  /** Handwritten comments (a SignatureDoc of kind NOTE), if the approver wrote them by hand. */
  commentsInkId?: string | null;
  entriesHash: string;
  signedAt: Date;
};

export type AuditLog = { _id: string; at: Date; actor: string; action: string; target: string; meta: Record<string, unknown> };

/**
 * A dated note about a student, written by an admin or a teacher (e.g. "Called about absences,
 * back Monday"). Staff-only: never shown to the student or printed on the sheet.
 */
export type StudentNote = {
  _id: string;
  studentId: string;
  /** The day the note is about (YYYY-MM-DD). Defaults to the day it was written. */
  date: string;
  text: string;
  byId: string;
  byName: string;
  byRole: Role;
  createdAt: Date;
};

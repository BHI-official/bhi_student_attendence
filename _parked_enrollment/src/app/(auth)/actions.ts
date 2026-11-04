"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { cols, newId, newApplication, isDuplicateKey, type User } from "@/db";
import { env } from "@/lib/env";
import { hashPassword, verifyPassword, passwordSchema, DUMMY_HASH } from "@/lib/password";
import { createSession, destroySession, getSessionUser, revokeAllSessions, clientMeta } from "@/lib/session";
import { issueOtp, verifyOtp, OTP_MAX_ATTEMPTS } from "@/lib/otp";
import { notifyAdminsInstructorSignup, sendOtpEmail } from "@/lib/email";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import { homePath } from "@/lib/auth";
import { invalid, formObject, type ActionState } from "@/lib/action";
import { canonicalEmail } from "@/lib/email-canonical";
import { inviteHash, isWellFormedToken } from "@/lib/invite";

const emailSchema = z.string().trim().toLowerCase().email("Enter a valid email address").max(160);

const registerSchema = z
  .object({
    name: z.string().trim().min(2, "Enter your full name").max(80),
    email: emailSchema,
    password: passwordSchema,
    confirm: z.string(),
  })
  .refine((d) => d.password === d.confirm, { path: ["confirm"], message: "Passwords don't match" });

/**
 * Student sign-up. Always creates a STUDENT, whatever the form sends. Instructors use
 * registerInstructorAction (pending until an admin approves) or are invited by an admin.
 */
export async function registerAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return createAccount("STUDENT", fd);
}

/** Instructor sign-up. The account starts PENDING and has no teaching access until an admin approves it. */
export async function registerInstructorAction(_: ActionState, fd: FormData): Promise<ActionState> {
  return createAccount("INSTRUCTOR", fd);
}

async function createAccount(role: "STUDENT" | "INSTRUCTOR", fd: FormData): Promise<ActionState> {
  const parsed = registerSchema.safeParse(formObject(fd));
  if (!parsed.success) return invalid(parsed.error);
  const { name, email, password } = parsed.data;

  // googlemail.com is the same Gmail service (older/regional accounts), so it counts as Gmail.
  if (role === "STUDENT" && env().REQUIRE_GMAIL && !canonicalEmail(email).endsWith("@gmail.com")) {
    return { fieldErrors: { email: "Use your Gmail address (ends with @gmail.com)" } };
  }
  const { ip } = await clientMeta();
  if (!(await rateLimit(`register:${ip}`, 10, 3600))) return { error: "Too many sign-ups from this network. Try again in an hour." };

  const { users, applications } = await cols();
  const emailCanonical = canonicalEmail(email);
  // Gmail aliases (dots, +tags, googlemail.com) reach the same inbox, so they count as the same account.
  if (await users.findOne({ $or: [{ email }, { emailCanonical }] }, { projection: { _id: 1 } })) {
    return { fieldErrors: { email: "An account with this email already exists. Sign in instead." } };
  }
  const now = new Date();
  const user: User = {
    _id: newId(), name, email, emailCanonical, passwordHash: await hashPassword(password),
    role, instructorStatus: role === "INSTRUCTOR" ? "PENDING" : null,
    emailVerifiedAt: null, disabledAt: null, passwordChangedAt: now, createdAt: now,
  };
  try {
    await users.insertOne(user);
  } catch (e) {
    // Unique index on email catches two sign-ups racing with the same address.
    if (isDuplicateKey(e)) return { fieldErrors: { email: "An account with this email already exists. Sign in instead." } };
    throw e;
  }
  if (role === "STUDENT") {
    try {
      await applications.insertOne(newApplication(user._id));
    } catch (e) {
      await users.deleteOne({ _id: user._id }); // keep the two in step without a transaction
      throw e;
    }
  }
  await audit(user._id, "user.register", "user", user._id, { role: user.role });
  if (role === "INSTRUCTOR") {
    const admins = await users.find({ role: "ADMIN", disabledAt: null }, { projection: { email: 1 } }).toArray();
    await notifyAdminsInstructorSignup(admins.map((a) => a.email), name, user._id).catch(() => undefined);
  }

  const otp = await issueOtp(user._id, "VERIFY_EMAIL");
  if (otp.ok) await sendOtpEmail(email, name, otp.code, "VERIFY_EMAIL");
  await createSession(user);
  redirect("/verify");
}

export async function verifyEmailAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.emailVerifiedAt) redirect(await homePath(user));
  if (!(await rateLimit(`verify:${user._id}`, 20, 3600))) return { error: "Too many attempts. Try again later." };

  const code = String(fd.get("code") ?? "").replace(/\s/g, "");
  const result = await verifyOtp(user._id, "VERIFY_EMAIL", code);
  switch (result) {
    case "OK":
      await (await cols()).users.updateOne({ _id: user._id }, { $set: { emailVerifiedAt: new Date() } });
      await audit(user._id, "user.verify_email", "user", user._id);
      redirect(await homePath({ ...user, emailVerifiedAt: new Date() }));
    case "EXPIRED":
      return { fieldErrors: { code: "This code has expired. Send a new one." } };
    case "TOO_MANY_ATTEMPTS":
      return { fieldErrors: { code: `Too many wrong tries (${OTP_MAX_ATTEMPTS}). Send a new code.` } };
    case "NO_CODE":
      return { fieldErrors: { code: "No active code. Send a new one." } };
    default:
      return { fieldErrors: { code: "That code isn't right. Check the email and try again." } };
  }
}

export async function resendVerificationAction(_: ActionState): Promise<ActionState> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.emailVerifiedAt) redirect(await homePath(user));
  const otp = await issueOtp(user._id, "VERIFY_EMAIL");
  if (!otp.ok) {
    return otp.reason === "COOLDOWN"
      ? { error: `Wait ${otp.retryAfter} seconds before requesting another code.` }
      : { error: "You've requested too many codes. Try again in an hour." };
  }
  await sendOtpEmail(user.email, user.name, otp.code, "VERIFY_EMAIL");
  return { ok: true, message: `We sent a new code to ${user.email}.` };
}

/**
 * Finds an account by the address typed. Exact match first; otherwise the same Gmail mailbox written
 * differently (dots, +tags, googlemail.com), which registration already treats as the same account.
 */
async function findUserByEmail(email: string) {
  const { users } = await cols();
  return (await users.findOne({ email })) ?? (await users.findOne({ emailCanonical: canonicalEmail(email) }));
}

const loginSchema = z.object({ email: emailSchema, password: z.string().min(1, "Enter your password").max(128) });

export async function loginAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const parsed = loginSchema.safeParse(formObject(fd));
  if (!parsed.success) return invalid(parsed.error);
  const { email, password } = parsed.data;
  const { ip } = await clientMeta();
  const okIp = await rateLimit(`login-ip:${ip}`, 30, 900);
  const okEmail = await rateLimit(`login-email:${canonicalEmail(email)}`, 8, 900);
  if (!okIp || !okEmail) return { error: "Too many sign-in attempts. Wait 15 minutes and try again." };

  const user = await findUserByEmail(email);
  const valid = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !valid || user.disabledAt) {
    await audit(user?._id ?? null, "user.login_failed", "user", user?._id ?? null, { email, ip });
    return { error: "Email or password is incorrect." };
  }
  await createSession(user);
  await audit(user._id, "user.login", "user", user._id, { ip });
  if (!user.emailVerifiedAt) {
    const otp = await issueOtp(user._id, "VERIFY_EMAIL");
    if (otp.ok) await sendOtpEmail(user.email, user.name, otp.code, "VERIFY_EMAIL");
    redirect("/verify");
  }
  redirect(await homePath(user));
}

export async function logoutAction() {
  await destroySession();
  redirect("/login");
}

export async function forgotPasswordAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const parsed = z.object({ email: emailSchema }).safeParse(formObject(fd));
  if (!parsed.success) return invalid(parsed.error);
  const { email } = parsed.data;
  const { ip } = await clientMeta();
  if (!(await rateLimit(`forgot-ip:${ip}`, 10, 3600))) return { error: "Too many requests. Try again later." };

  const user = await findUserByEmail(email);
  if (user && !user.disabledAt) {
    const otp = await issueOtp(user._id, "RESET_PASSWORD");
    if (otp.ok) await sendOtpEmail(user.email, user.name, otp.code, "RESET_PASSWORD");
  }
  // Same response whether or not the account exists, so emails can't be discovered this way.
  redirect(`/reset-password?email=${encodeURIComponent(email)}`);
}

const resetSchema = z
  .object({ email: emailSchema, code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code"), password: passwordSchema, confirm: z.string() })
  .refine((d) => d.password === d.confirm, { path: ["confirm"], message: "Passwords don't match" });

export async function resetPasswordAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const parsed = resetSchema.safeParse(formObject(fd));
  if (!parsed.success) return invalid(parsed.error);
  const { email, code, password } = parsed.data;
  const { ip } = await clientMeta();
  if (!(await rateLimit(`reset-ip:${ip}`, 20, 3600))) return { error: "Too many attempts. Try again later." };

  const { users } = await cols();
  const user = await findUserByEmail(email);
  if (!user) return { fieldErrors: { code: "That code isn't right or has expired." } };
  const result = await verifyOtp(user._id, "RESET_PASSWORD", code);
  if (result !== "OK") {
    return {
      fieldErrors: {
        code: result === "TOO_MANY_ATTEMPTS" ? "Too many wrong tries. Request a new code." : "That code isn't right or has expired.",
      },
    };
  }
  // Revoke first, then stamp the change: any session created before passwordChangedAt stops working.
  await revokeAllSessions(user._id);
  await users.updateOne(
    { _id: user._id },
    // A reset also activates an invited instructor (the emailed code proves the address), so retire any open invite.
    { $set: { passwordHash: await hashPassword(password), passwordChangedAt: new Date(), emailVerifiedAt: user.emailVerifiedAt ?? new Date(), inviteTokenHash: null, inviteExpiresAt: null } },
  );
  await audit(user._id, "user.password_reset", "user", user._id, { ip });
  redirect("/login?reset=1");
}

// ---------- Instructor invitations ----------

const inviteSchema = z
  .object({ password: passwordSchema, confirm: z.string() })
  .refine((d) => d.password === d.confirm, { path: ["confirm"], message: "Passwords don't match" });

/** Accepts an admin's invitation: sets the password, confirms the email, signs the instructor in. The link works once. */
export async function acceptInviteAction(token: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const { ip } = await clientMeta();
  if (!(await rateLimit(`invite:${ip}`, 20, 3600))) return { error: "Too many attempts. Try again in an hour." };
  const parsed = inviteSchema.safeParse(formObject(fd));
  if (!parsed.success) return invalid(parsed.error);
  if (!isWellFormedToken(token)) return { error: "This invitation link isn't valid. Ask the office to send a new one." };

  const now = new Date();
  const { users } = await cols();
  // One atomic update both checks and consumes the token, so the link can't be used twice.
  const user = await users.findOneAndUpdate(
    { inviteTokenHash: inviteHash(token), inviteExpiresAt: { $gt: now }, role: "INSTRUCTOR", disabledAt: null },
    { $set: { passwordHash: await hashPassword(parsed.data.password), passwordChangedAt: now, emailVerifiedAt: now, inviteTokenHash: null, inviteExpiresAt: null } },
    { returnDocument: "after" },
  );
  if (!user) return { error: "This invitation link has expired or was already used. Ask the office to send a new one." };
  await revokeAllSessions(user._id);
  await createSession(user);
  await audit(user._id, "instructor.activate", "user", user._id, { ip });
  redirect(await homePath(user));
}
import "server-only";
import { Resend } from "resend";
import { env } from "@/lib/env";
import { OTP_TTL_MINUTES } from "@/lib/otp";

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

let client: Resend | null = null;

async function send(to: string, subject: string, html: string, text: string) {
  const { RESEND_API_KEY, EMAIL_FROM } = env();
  if (!RESEND_API_KEY) {
    // Development fallback only; env() refuses to start in production without a key.
    console.info(`\n[email:dev] To: ${to}\nSubject: ${subject}\n${text}\n`);
    return;
  }
  client ??= new Resend(RESEND_API_KEY);
  const { error } = await client.emails.send({ from: EMAIL_FROM, to, subject, html, text });
  if (error) {
    console.error("[email] Resend error", error);
    throw new Error("We couldn't send the email. Try again in a minute.");
  }
}

function layout(title: string, bodyHtml: string) {
  return `<!doctype html><html><body style="margin:0;background:#F4F7F6;font-family:Arial,Helvetica,sans-serif;color:#1B2430">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
  <table role="presentation" width="100%" style="max-width:520px;background:#ffffff;border:1px solid #D9E0DD;border-radius:10px">
  <tr><td style="padding:24px 28px;border-bottom:4px solid #1F4E46"><strong style="font-size:16px;color:#1F4E46">BHI LMS</strong></td></tr>
  <tr><td style="padding:28px"><h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(title)}</h1>${bodyHtml}</td></tr>
  </table></td></tr></table></body></html>`;
}

const link = (path: string) => `${env().APP_URL}${path}`;

export async function sendOtpEmail(to: string, name: string, code: string, purpose: "VERIFY_EMAIL" | "RESET_PASSWORD") {
  const isVerify = purpose === "VERIFY_EMAIL";
  const title = isVerify ? "Your verification code" : "Your password reset code";
  const intro = isVerify ? "Use this code to verify your email address." : "Use this code to reset your password.";
  const html = layout(
    title,
    `<p>Hi ${escapeHtml(name)},</p><p>${intro}</p>
     <p style="font-size:32px;letter-spacing:8px;font-weight:bold;margin:24px 0;color:#1F4E46">${code}</p>
     <p>The code expires in ${OTP_TTL_MINUTES} minutes. If you didn't request it, you can ignore this email.</p>`,
  );
  await send(to, `${title}: ${code}`, html, `${intro}\n\nCode: ${code}\nExpires in ${OTP_TTL_MINUTES} minutes.`);
}

export async function sendCorrectionsEmail(to: string, name: string, sections: string[], note: string) {
  const list = sections.map((s) => `<li>${escapeHtml(s)}</li>`).join("");
  const html = layout(
    "Your application needs a few changes",
    `<p>Hi ${escapeHtml(name)},</p><p>Our admissions team reviewed your enrollment application and needs you to update:</p>
     <ul>${list}</ul><p><strong>Note from the team:</strong></p>
     <p style="white-space:pre-wrap;background:#F4F7F6;padding:12px;border-radius:6px">${escapeHtml(note)}</p>
     <p><a href="${link("/enroll")}" style="display:inline-block;background:#1F4E46;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Update my application</a></p>`,
  );
  await send(to, "Action needed: update your enrollment application", html,
    `Please update: ${sections.join(", ")}\n\nNote: ${note}\n\n${link("/enroll")}`);
}

/** Runs an email send and reports whether it worked, so callers never claim an email went out when it didn't. */
export async function trySend(fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch (e) {
    console.error("[email] send failed", e instanceof Error ? e.message : e);
    return false;
  }
}

export async function sendDecisionEmail(to: string, name: string, decision: "APPROVED" | "REJECTED", reason?: string, courseName?: string) {
  const approved = decision === "APPROVED";
  const html = layout(
    approved ? "Your application is approved" : "Update on your application",
    approved
      ? `<p>Hi ${escapeHtml(name)},</p><p>Your enrollment application has been approved${courseName ? ` and you're enrolled in <strong>${escapeHtml(courseName)}</strong>` : ""}. Your student dashboard is now open.</p>
         <p><a href="${link("/dashboard")}" style="display:inline-block;background:#1F4E46;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Open my dashboard</a></p>`
      : `<p>Hi ${escapeHtml(name)},</p><p>We're unable to approve your enrollment application.</p>
         ${reason ? `<p style="white-space:pre-wrap;background:#F4F7F6;padding:12px;border-radius:6px">${escapeHtml(reason)}</p>` : ""}
         <p>If you have questions, reply to this email or contact the office.</p>`,
  );
  await send(to, approved ? "Your enrollment application is approved" : "Your enrollment application", html,
    approved ? "Your application is approved." : `Your application was not approved. ${reason ?? ""}`);
}

export async function sendClassAssignedEmail(to: string, name: string, className: string) {
  const html = layout(
    "You've been assigned to a class",
    `<p>Hi ${escapeHtml(name)},</p><p>You're now enrolled in <strong>${escapeHtml(className)}</strong>. Your dashboard is open.</p>
     <p><a href="${link("/dashboard")}" style="display:inline-block;background:#1F4E46;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Open my dashboard</a></p>`,
  );
  await send(to, "Your class assignment", html, `You're enrolled in ${className}. ${link("/dashboard")}`);
}
export async function sendInstructorInviteEmail(to: string, name: string, token: string, days: number) {
  const url = link(`/invite/${token}`);
  const html = layout(
    "You've been added as an instructor",
    `<p>Hi ${escapeHtml(name)},</p><p>The BHI office has created an instructor account for you. Choose a password to activate it.</p>
     <p><a href="${url}" style="display:inline-block;background:#1F4E46;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Set my password</a></p>
     <p style="font-size:13px;color:#5B6670">This link works once and expires in ${days} days. If it has expired, ask the office to send a new one.</p>`,
  );
  await send(to, "Activate your BHI instructor account", html, `The BHI office created an instructor account for you. Set your password: ${url}\nThe link works once and expires in ${days} days.`);
}
export async function sendInstructorClassEmail(to: string, name: string, className: string, role: "LEAD" | "ASSISTANT", startDate: string, schedule: string) {
  const roleText = role === "LEAD" ? "lead instructor" : "assistant instructor";
  const when = `Starts ${startDate}${schedule ? `, ${schedule}` : ""}.`;
  const html = layout(
    "You've been assigned a class",
    `<p>Hi ${escapeHtml(name)},</p><p>You're the ${roleText} for <strong>${escapeHtml(className)}</strong>. ${escapeHtml(when)}</p>
     <p>You can see your students, take attendance and write monthly progress reports from your instructor page.</p>
     <p><a href="${link("/instructor")}" style="display:inline-block;background:#1F4E46;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Open my classes</a></p>`,
  );
  await send(to, `New class: ${className}`, html, `You're the ${roleText} for ${className}. ${when} ${link("/instructor")}`);
}

export async function sendInstructorDecisionEmail(to: string, name: string, approved: boolean) {
  const html = layout(
    approved ? "Your instructor account is approved" : "Your instructor account",
    approved
      ? `<p>Hi ${escapeHtml(name)},</p><p>Your instructor account is approved. You'll see your courses and students once an admin assigns them.</p><p><a href="${link("/login")}" style="color:#1F4E46">Sign in</a></p>`
      : `<p>Hi ${escapeHtml(name)},</p><p>Your instructor account request was not approved. Contact the office if you think this is a mistake.</p>`,
  );
  await send(to, approved ? "Instructor account approved" : "Instructor account request", html, approved ? "Approved" : "Not approved");
}

export async function notifyAdminsNewApplication(adminEmails: string[], studentName: string, applicationId: string) {
  if (!adminEmails.length) return;
  const html = layout(
    "New application to review",
    `<p>${escapeHtml(studentName)} submitted an enrollment application.</p>
     <p><a href="${link(`/admin/applications/${applicationId}`)}" style="color:#1F4E46">Review the application</a></p>`,
  );
  await Promise.allSettled(adminEmails.map((e) => send(e, `New application: ${studentName}`, html, `Review: ${link(`/admin/applications/${applicationId}`)}`)));
}

export async function sendSubmissionReceivedEmail(to: string, name: string, resubmitted: boolean) {
  const title = resubmitted ? "We received your updated application" : "We received your application";
  const html = layout(title, `<p>Hi ${escapeHtml(name)},</p><p>${resubmitted ? "Your corrected" : "Your"} enrollment application is now waiting for review. We'll email you when there's a decision or if anything needs to change.</p>
     <p><a href="${link("/application")}" style="color:#1F4E46">See your application status</a></p>`);
  await send(to, title, html, `${title}. Status: ${link("/application")}`);
}

export async function sendPaymentVerifiedEmail(to: string, name: string, status: "PAID" | "WAIVED") {
  const what = status === "PAID" ? "recorded your tuition payment" : "waived your tuition payment";
  const html = layout("Your tuition payment is settled", `<p>Hi ${escapeHtml(name)},</p><p>The BHI office has ${what}. We'll email you when your enrollment is approved.</p>
     <p><a href="${link("/application")}" style="display:inline-block;background:#1F4E46;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">See my application</a></p>`);
  await send(to, "Tuition payment settled", html, `The BHI office has ${what}. Your application: ${link("/application")}`);
}

export async function notifyAdminsPaymentReported(adminEmails: string[], studentName: string, applicationId: string) {
  if (!adminEmails.length) return;
  const url = link(`/admin/applications/${applicationId}`);
  const html = layout("Tuition payment to verify", `<p>${escapeHtml(studentName)} reported a tuition payment.</p><p><a href="${url}" style="color:#1F4E46">Verify the payment</a></p>`);
  await Promise.allSettled(adminEmails.map((e) => send(e, `Payment to verify: ${studentName}`, html, `Verify: ${url}`)));
}

export async function notifyAdminsInstructorSignup(adminEmails: string[], name: string, instructorId: string) {
  if (!adminEmails.length) return;
  const url = link(`/admin/instructors/${instructorId}`);
  const html = layout("Instructor account to review", `<p>${escapeHtml(name)} signed up as an instructor and is waiting for approval.</p><p><a href="${url}" style="color:#1F4E46">Review the account</a></p>`);
  await Promise.allSettled(adminEmails.map((e) => send(e, `Instructor sign-up: ${name}`, html, `Review: ${url}`)));
}

export async function sendInstructorCoursesEmail(to: string, name: string, courseName: string) {
  const html = layout("You've been assigned a course", `<p>Hi ${escapeHtml(name)},</p><p>You're now an instructor for <strong>${escapeHtml(courseName)}</strong>. Its students, attendance sheets and monthly progress reports are on your instructor page.</p>
     <p><a href="${link("/instructor")}" style="display:inline-block;background:#1F4E46;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Open my courses</a></p>`);
  await send(to, `New course: ${courseName}`, html, `You're an instructor for ${courseName}. ${link("/instructor")}`);
}

export async function sendClassroomLinkEmail(to: string, name: string, className: string, url: string, instructorName: string) {
  const html = layout(
    "Your Google Classroom link",
    `<p>Hi ${escapeHtml(name)},</p><p>${escapeHtml(instructorName)} shared the online classroom for <strong>${escapeHtml(className)}</strong>.</p>
     <p><a href="${escapeHtml(url)}" style="display:inline-block;background:#1F4E46;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Open Google Classroom</a></p>
     <p style="font-size:13px;color:#5B6670">Sign in with the Gmail address you registered with. The link is also on your dashboard.</p>`,
  );
  await send(to, `Google Classroom: ${className}`, html, `${instructorName} shared the online classroom for ${className}: ${url}\nThe link is also on your dashboard: ${link("/dashboard")}`);
}

// ---------- Online tuition payment (Stripe) ----------

export async function sendPaymentRequestEmail(to: string, name: string, amount: string, courseName: string, note: string) {
  const html = layout(
    "Your tuition payment request",
    `<p>Hi ${escapeHtml(name)},</p><p>The BHI office reviewed your application for <strong>${escapeHtml(courseName)}</strong>.
     To complete your enrollment, please pay your tuition of <strong>${escapeHtml(amount)}</strong>.</p>
     ${note ? `<p style="background:#F4F7F6;border-radius:6px;padding:12px;white-space:pre-wrap">${escapeHtml(note)}</p>` : ""}
     <p><a href="${link("/application")}" style="display:inline-block;background:#1F4E46;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Pay my tuition</a></p>
     <p style="font-size:13px;color:#5B6670">You pay on Stripe's secure page. As soon as the payment goes through, you're enrolled and your dashboard opens.</p>`,
  );
  await send(to, `Tuition payment request: ${amount}`, html,
    `Hi ${name},\nThe BHI office reviewed your application for ${courseName}. Please pay your tuition of ${amount}.\n${note ? `${note}\n` : ""}Pay here: ${link("/application")}`);
}

export async function sendPaymentReceivedEmail(to: string, name: string, amount: string, courseName: string) {
  const html = layout(
    "Payment received",
    `<p>Hi ${escapeHtml(name)},</p><p>We received your tuition payment of <strong>${escapeHtml(amount)}</strong> for <strong>${escapeHtml(courseName)}</strong>. Thank you.</p>
     <p>Stripe also emails you a receipt.</p>
     <p><a href="${link("/dashboard")}" style="display:inline-block;background:#1F4E46;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Open my dashboard</a></p>`,
  );
  await send(to, `Payment received: ${amount}`, html, `We received your tuition payment of ${amount} for ${courseName}. Your dashboard: ${link("/dashboard")}`);
}

export async function notifyAdminsPayment(adminEmails: string[], studentName: string, applicationId: string, headline: string, detail: string) {
  if (!adminEmails.length) return;
  const url = link(`/admin/applications/${applicationId}`);
  const html = layout(headline, `<p><strong>${escapeHtml(studentName)}</strong>: ${escapeHtml(detail)}</p><p><a href="${url}">Open the application</a></p>`);
  await Promise.all(adminEmails.map((to) => send(to, `${headline}: ${studentName}`, html, `${studentName}: ${detail}\n${url}`).catch(() => undefined)));
}

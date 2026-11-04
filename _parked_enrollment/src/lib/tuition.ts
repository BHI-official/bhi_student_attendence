import "server-only";
import Stripe from "stripe";
import { cols, type Application, type PaymentRequest } from "@/db";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";
import { approveApplication, REVIEWABLE } from "@/lib/approval";
import { formatUsd } from "@/lib/payment";
import { notifyAdminsPayment, sendPaymentReceivedEmail, trySend } from "@/lib/email";

/**
 * Online tuition payment for Private students, with Stripe Checkout (Stripe's hosted payment page:
 * card details never reach this server).
 *
 * Flow: an admin sends a payment request (amount) → the student presses "Pay" → a Checkout session
 * is created for exactly that request → Stripe confirms the payment to /api/stripe/webhook (and the
 * student's return to /application/paid checks it too) → settleCheckoutSession() marks it paid once
 * and approves + enrolls the student.
 */

let client: Stripe | null = null;
export const stripeEnabled = () => !!env().STRIPE_SECRET_KEY;
export function stripe(): Stripe {
  const key = env().STRIPE_SECRET_KEY;
  if (!key) throw new Error("Online payment isn't set up (STRIPE_SECRET_KEY is empty).");
  client ??= new Stripe(key, { appInfo: { name: "BHI LMS" }, maxNetworkRetries: 2, timeout: 20_000 });
  return client;
}

const adminEmails = async () =>
  (await (await cols()).users.find({ role: "ADMIN", disabledAt: null }, { projection: { email: 1 } }).toArray()).map((a) => a.email);

/** True when the current request is waiting for the student's payment. */
export const requestOpen = (app: Pick<Application, "category" | "paymentStatus" | "paymentRequest">) =>
  app.category === "PRIVATE" && app.paymentStatus === "REQUESTED" && app.paymentRequest?.status === "OPEN";

/**
 * Stops a Checkout session from taking a payment (when a request is cancelled or replaced).
 * Returns "PAID" if the student had already paid in it: the caller must then settle, not cancel.
 */
export async function closeCheckout(sessionId: string | null | undefined): Promise<"CLOSED" | "PAID"> {
  if (!sessionId || !stripeEnabled()) return "CLOSED";
  const s = await stripe().checkout.sessions.retrieve(sessionId);
  if (s.status === "complete") return s.payment_status === "unpaid" ? "CLOSED" : "PAID";
  if (s.status === "open") await stripe().checkout.sessions.expire(sessionId);
  return "CLOSED";
}

export type SettleResult =
  | { state: "PAID"; applicationId: string; approved: boolean; message: string }
  | { state: "PROCESSING" | "NOT_PAID" | "IGNORED"; applicationId?: string; message: string };

/**
 * Records a completed Checkout session. Safe to call any number of times for the same session (Stripe
 * retries webhooks, and the student's return page calls it too): the payment is recorded once, by a
 * conditional update, and approval is itself conditional.
 */
export async function settleCheckoutSession(session: Stripe.Checkout.Session, via: "webhook" | "return"): Promise<SettleResult> {
  const applicationId = session.metadata?.applicationId;
  const requestId = session.metadata?.requestId;
  if (!applicationId || !requestId) return { state: "IGNORED", message: "Not a tuition payment." };
  if (session.payment_status === "unpaid") {
    return session.status === "complete"
      ? { state: "PROCESSING", applicationId, message: "Your payment is processing. We'll email you when it's confirmed." }
      : { state: "NOT_PAID", applicationId, message: "The payment wasn't completed." };
  }

  const { applications, users } = await cols();
  const app = await applications.findOne({ _id: applicationId });
  if (!app) return { state: "IGNORED", message: "Unknown application." };
  const student = await users.findOne({ _id: app.studentId }, { projection: { name: 1, email: 1 } });
  const studentName = student?.name ?? "A student";
  const paymentIntent = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null;
  const paid = session.amount_total ?? 0;
  const current = app.paymentRequest?.id === requestId ? app.paymentRequest : null;
  const now = new Date();

  // Money arrived for a request that isn't the current one (cancelled or replaced after the student
  // opened the payment page). Never lost silently: recorded and the office is told to sort it out.
  if (!current || current.status === "CANCELLED") {
    const known = await audits(applicationId, "application.payment_unexpected", session.id);
    if (!known) {
      await audit(null, "application.payment_unexpected", "application", applicationId, { sessionId: session.id, paymentIntent, amountCents: paid, requestId, via });
      await notifyAdminsPayment(await adminEmails(), studentName, applicationId, "Payment for a cancelled request",
        `${formatUsd(paid)} was paid online for a payment request that had been cancelled or replaced. Refund it in Stripe, or mark the tuition paid.`);
    }
    return { state: "IGNORED", applicationId, message: "This payment request was cancelled. The office has been told about your payment and will contact you." };
  }
  if (session.currency !== "usd" || paid !== current.amountCents) {
    // Cannot happen with sessions this app creates; checked anyway so a wrong amount never approves anyone.
    await audit(null, "application.payment_mismatch", "application", applicationId, { sessionId: session.id, paid, expected: current.amountCents, currency: session.currency });
    await notifyAdminsPayment(await adminEmails(), studentName, applicationId, "Payment amount mismatch",
      `Stripe reported ${formatUsd(paid)} but the request was for ${formatUsd(current.amountCents)}. Check it in Stripe.`);
    return { state: "IGNORED", applicationId, message: "We couldn't match your payment. The office will contact you." };
  }

  const res = await applications.updateOne(
    { _id: applicationId, "paymentRequest.id": requestId, paymentStatus: { $nin: ["PAID", "WAIVED"] } },
    {
      $set: {
        paymentStatus: "PAID", paymentReference: paymentIntent, paymentVerifiedAt: now, paymentVerifiedById: null,
        "paymentRequest.status": "PAID", "paymentRequest.paidAt": now, "paymentRequest.amountPaidCents": paid,
        "paymentRequest.stripePaymentIntentId": paymentIntent, "paymentRequest.checkoutSessionId": session.id, updatedAt: now,
      },
    },
  );
  if (res.modifiedCount) {
    await audit(null, "application.payment_received", "application", applicationId, { amountCents: paid, paymentIntent, sessionId: session.id, via });
    const course = app.courseId ? await (await cols()).courses.findOne({ _id: app.courseId }, { projection: { name: 1 } }) : null;
    if (student) await trySend(() => sendPaymentReceivedEmail(student.email, student.name, formatUsd(paid), course?.name ?? "your course"));
    await notifyAdminsPayment(await adminEmails(), studentName, applicationId, "Tuition paid online", `${formatUsd(paid)} received through Stripe.`);
  } else if (current.checkoutSessionId && current.checkoutSessionId !== session.id && current.stripePaymentIntentId !== paymentIntent) {
    // Already paid, and this is a second, different payment (e.g. two browser tabs): flag for a refund.
    const known = await audits(applicationId, "application.payment_duplicate", session.id);
    if (!known) {
      await audit(null, "application.payment_duplicate", "application", applicationId, { sessionId: session.id, paymentIntent, amountCents: paid });
      await notifyAdminsPayment(await adminEmails(), studentName, applicationId, "Duplicate tuition payment",
        `A second payment of ${formatUsd(paid)} was made. Refund one of them in Stripe.`);
    }
  }

  // Approve and enroll (only while the application is waiting for review; safe to repeat).
  const fresh = await applications.findOne({ _id: applicationId }, { projection: { status: 1, paymentStatus: 1 } });
  let approved = fresh?.status === "APPROVED";
  if (fresh && fresh.paymentStatus === "PAID" && REVIEWABLE.includes(fresh.status)) {
    const r = await approveApplication(applicationId, current.requestedById, "stripe");
    approved = r.ok;
    if (!r.ok) {
      await notifyAdminsPayment(await adminEmails(), studentName, applicationId, "Paid, approval needs you", r.error);
    }
  }
  return {
    state: "PAID", applicationId, approved,
    message: approved ? "Payment received. You're enrolled." : "Payment received. The office will finish your enrollment and email you.",
  };
}

/** Has this event for this Checkout session already been logged? (keeps alerts to one per problem) */
async function audits(applicationId: string, action: string, sessionId: string) {
  const { auditLogs } = await cols();
  return (await auditLogs.countDocuments({ entity: "application", entityId: applicationId, action, "meta.sessionId": sessionId }, { limit: 1 })) > 0;
}

/** The request the student pays now, with the course name for the Stripe line item. */
export async function checkoutTarget(app: Application): Promise<{ request: PaymentRequest; courseName: string } | null> {
  if (!requestOpen(app) || !app.paymentRequest) return null;
  const course = app.courseId ? await (await cols()).courses.findOne({ _id: app.courseId }, { projection: { name: 1 } }) : null;
  return { request: app.paymentRequest, courseName: course?.name ?? "Tuition" };
}

"use server";

import { redirect } from "next/navigation";
import { cols } from "@/db";
import { env } from "@/lib/env";
import { requireStudentStage, homePath } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { audit } from "@/lib/audit";
import { REVIEWABLE } from "@/lib/approval";
import { checkoutTarget, settleCheckoutSession, stripe, stripeEnabled } from "@/lib/tuition";
import type { ActionState } from "@/lib/action";

/**
 * Student presses "Pay": sends them to Stripe's hosted payment page for exactly the current request.
 * An open page for the same request is reused, so a double click or a second tab never creates a
 * second charge. The amount always comes from the request stored here, never from the browser.
 */
export async function startCheckoutAction(_: ActionState): Promise<ActionState> {
  const { user, application } = await requireStudentStage("STATUS");
  if (!stripeEnabled()) return { error: "Online payment isn't available right now. Contact the office." };
  if (!REVIEWABLE.includes(application.status)) return { error: "There's no payment due on your application right now." };
  const target = await checkoutTarget(application);
  if (!target) return { error: "There's no payment due on your application right now." };
  if (!(await rateLimit(`checkout:${user._id}`, 20, 3600))) return { error: "Too many tries. Wait a few minutes." };
  const { request, courseName } = target;

  // Reuse the student's open payment page for this request, if there is one.
  if (request.checkoutSessionId) {
    const s = await stripe().checkout.sessions.retrieve(request.checkoutSessionId);
    if (s.status === "open" && s.url) redirect(s.url);
    if (s.status === "complete") {
      await settleCheckoutSession(s, "return");
      redirect(await homePath(user));
    }
  }

  const attempt = request.checkoutAttempts ?? 0;
  const base = env().APP_URL.replace(/\/$/, "");
  const session = await stripe().checkout.sessions.create(
    {
      mode: "payment",
      customer_email: user.email,
      client_reference_id: application._id,
      line_items: [{
        quantity: 1,
        price_data: { currency: "usd", unit_amount: request.amountCents, product_data: { name: `Tuition: ${courseName}`, description: `BHI enrollment for ${user.name}` } },
      }],
      metadata: { applicationId: application._id, requestId: request.id, studentId: user._id },
      payment_intent_data: { metadata: { applicationId: application._id, requestId: request.id }, description: `Tuition: ${courseName} (${user.name})` },
      success_url: `${base}/application/paid?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${base}/application?payment=cancelled`,
    },
    // Same request + attempt = same session, even if two clicks arrive at once.
    { idempotencyKey: `checkout:${request.id}:${attempt}` },
  );
  const { applications } = await cols();
  await applications.updateOne(
    { _id: application._id, "paymentRequest.id": request.id, "paymentRequest.status": "OPEN", "paymentRequest.checkoutAttempts": attempt },
    { $set: { "paymentRequest.checkoutSessionId": session.id, "paymentRequest.checkoutUrl": session.url }, $inc: { "paymentRequest.checkoutAttempts": 1 } },
  );
  await audit(user._id, "application.checkout_started", "application", application._id, { requestId: request.id, sessionId: session.id });
  if (!session.url) return { error: "Stripe didn't return a payment page. Try again." };
  redirect(session.url);
}

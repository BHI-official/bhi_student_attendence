import type Stripe from "stripe";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";
import { settleCheckoutSession, stripe, stripeEnabled } from "@/lib/tuition";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Stripe → this site: payment confirmations. Set up in the Stripe dashboard (Developers → Webhooks)
 * for https://<your site>/api/stripe/webhook with the events checkout.session.completed,
 * checkout.session.async_payment_succeeded and checkout.session.async_payment_failed.
 *
 * Every request is checked against STRIPE_WEBHOOK_SECRET, so nobody else can mark a payment paid.
 * Handling is idempotent: Stripe may send the same event more than once.
 */
export async function POST(req: Request) {
  if (!stripeEnabled()) return new Response("Payments are not configured", { status: 503 });
  const signature = req.headers.get("stripe-signature");
  if (!signature) return new Response("Missing signature", { status: 400 });
  const body = await req.text(); // the raw body is needed to verify the signature

  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(body, signature, env().STRIPE_WEBHOOK_SECRET);
  } catch {
    return new Response("Invalid signature", { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
        await settleCheckoutSession(event.data.object, "webhook");
        break;
      case "checkout.session.async_payment_failed": {
        const s = event.data.object;
        if (s.metadata?.applicationId) {
          await audit(null, "application.payment_failed", "application", s.metadata.applicationId, { sessionId: s.id });
        }
        break;
      }
      default:
        break; // other events aren't used
    }
  } catch (e) {
    // A 500 makes Stripe retry later (e.g. if the database was briefly unavailable).
    console.error("[stripe webhook] handling failed", event.type, event.id, e);
    return new Response("Handler error", { status: 500 });
  }
  return Response.json({ received: true });
}

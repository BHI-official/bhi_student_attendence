import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { cols } from "@/db";
import { homePath, requireUser } from "@/lib/auth";
import { settleCheckoutSession, stripe, stripeEnabled } from "@/lib/tuition";
import { StudentShell } from "@/components/student-shell";
import { Alert, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Payment" };
export const dynamic = "force-dynamic";

/**
 * Where Stripe sends the student after paying. The payment is checked with Stripe directly (the
 * webhook usually arrives first, but this doesn't depend on it), then the student goes on to their
 * dashboard. Only the student who owns the application can use a session id here.
 */
export default async function PaymentReturnPage({ searchParams }: { searchParams: Promise<{ session_id?: string }> }) {
  const user = await requireUser();
  if (user.role !== "STUDENT") redirect(await homePath(user));
  const sessionId = (await searchParams).session_id ?? "";
  if (!stripeEnabled() || !/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) redirect(await homePath(user));

  const app = await (await cols()).applications.findOne({ studentId: user._id }, { projection: { _id: 1 } });
  let message = "We couldn't confirm your payment yet. If you paid, it will show up within a few minutes and we'll email you.";
  let tone: "info" | "success" | "error" = "info";
  let goTo: string | null = null;
  try {
    const session = await stripe().checkout.sessions.retrieve(sessionId);
    if (!app || session.metadata?.applicationId !== app._id) {
      goTo = await homePath(user);
    } else {
      const result = await settleCheckoutSession(session, "return");
      if (result.state === "PAID" && result.approved) goTo = "/dashboard";
      message = result.message;
      tone = result.state === "PAID" ? "success" : result.state === "NOT_PAID" ? "error" : "info";
    }
  } catch (e) {
    console.error("[payment return] could not check the session", e);
  }
  if (goTo) redirect(goTo);
  return (
    <StudentShell name={user.name} step={2}>
      <PageHeader title="Your payment" />
      <Alert tone={tone}><p className="font-semibold">{message}</p></Alert>
      <p className="mt-5"><Link href="/application" className="font-semibold text-pine-700 underline">Back to my application</Link></p>
    </StudentShell>
  );
}

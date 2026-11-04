import { redirect } from "next/navigation";

/**
 * The old "pay first" step. Private students now pay after the office reviews their application
 * (a payment request on /application), so this address just returns to the enrollment overview.
 */
export default function PaymentPage() {
  redirect("/enroll");
}

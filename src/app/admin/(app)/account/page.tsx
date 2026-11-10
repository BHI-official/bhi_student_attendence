import { requireAdmin } from "@/lib/auth";
import { AccountPage } from "@/components/AccountPage";

export const dynamic = "force-dynamic";
export const metadata = { title: "My account" };

export default async function Account() {
  return <AccountPage staff={await requireAdmin()} />;
}

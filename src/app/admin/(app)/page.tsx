import { requireAdmin } from "@/lib/auth";
import { RosterPage, type RosterParams } from "@/components/RosterPage";

export const dynamic = "force-dynamic";
export const metadata = { title: "All attendance" };

export default async function AdminRoster({ searchParams }: { searchParams: Promise<RosterParams> }) {
  const staff = await requireAdmin();
  return <RosterPage staff={staff} sp={await searchParams} base="/admin" />;
}

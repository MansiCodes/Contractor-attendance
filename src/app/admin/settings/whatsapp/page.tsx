import type { Metadata } from "next";
import { WhatsAppAdmin } from "@/components/admin/whatsapp-admin";
import { PageHeader, SegmentedLinks } from "@/components/kit";
import { messagingOverview } from "@/lib/server/services/messaging";
import { requirePageContext } from "@/lib/server/session";

export const metadata: Metadata = { title: "WhatsApp messages" };

type Search = Promise<{ status?: string }>;

// Admin only: the admin layout redirects everyone else, and every service call re-checks the role.
export default async function WhatsAppSettingsPage({ searchParams }: { searchParams: Search }) {
  const ctx = await requirePageContext("admin");
  const sp = await searchParams;
  const overview = await messagingOverview(ctx, { status: sp.status });
  return (
    <div className="space-y-6">
      <SegmentedLinks
        label="Settings sections"
        items={[
          { href: "/admin/settings", label: "Attendance rules", active: false },
          { href: "/admin/settings/whatsapp", label: "WhatsApp", active: true },
        ]}
      />
      <PageHeader
        title="WhatsApp attendance messages"
        description="A short message to each worker after their day is confirmed: date, plant, IN, OUT and total time. Never wages. Only with the worker's consent."
      />
      <WhatsAppAdmin {...overview} statusFilter={sp.status ?? null} />
    </div>
  );
}

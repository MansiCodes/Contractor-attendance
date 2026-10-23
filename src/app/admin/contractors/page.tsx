import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Building2, MapPin } from "lucide-react";
import { AddContractorDialog, ContractorMenu } from "@/components/admin/contractor-dialogs";
import { ContractorAvatar } from "@/components/contractor-avatar";
import { EmptyState, PageHeader, StatusPill } from "@/components/kit";
import { assignmentCovers } from "@/lib/domain/register";
import { adminDirectory } from "@/lib/server/services/admin";
import { activeWorkerCount } from "@/lib/server/services/directory";
import { requirePageContext } from "@/lib/server/session";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Contractors" };

export default async function ContractorsPage() {
  const ctx = await requirePageContext("admin");
  const dir = await adminDirectory(ctx);
  const contractors = [...dir.contractors].sort((a, b) => Number(b.isActive) - Number(a.isActive) || a.name.localeCompare(b.name));

  return (
    <div className="space-y-6">
      <PageHeader title="Contractors" description="Labour contractors supplying workers to our manufacturing plants." actions={<AddContractorDialog />} />

      {contractors.length === 0 ? (
        <EmptyState icon={Building2} title="No contractors yet" description="Add the first contractor, then assign them to a plant." action={<AddContractorDialog />} />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {contractors.map((c) => {
            const sites = new Set(dir.cpas.filter((a) => a.contractorId === c.id && assignmentCovers(a, dir.today)).map((a) => a.projectId));
            const workers = activeWorkerCount(dir, c.id);
            return (
              <li
                key={c.id}
                className={cn("flex flex-col overflow-hidden rounded-xl bg-card shadow-surface", !c.isActive && "opacity-70")}
                data-testid="contractor-card"
              >
                <div className="flex items-start gap-3 p-4 pb-3">
                  <ContractorAvatar name={c.name} photoUrl={c.photoUrl} size="md" />
                  <div className="min-w-0 flex-1">
                    <Link href={`/admin/contractors/${c.id}`} className="block truncate text-md leading-6 font-semibold hover:underline">
                      {c.name}
                    </Link>
                    <div className="flex items-center gap-1 truncate text-sm text-muted-foreground">
                      <MapPin className="size-3.5 shrink-0" /> <span className="truncate">{c.location ?? "Location not recorded"}</span>
                    </div>
                  </div>
                  <ContractorMenu contractorId={c.id} name={c.name} />
                </div>
                <div className="tabular flex items-center gap-2 px-4 pb-3 text-sm">
                  <span>
                    <strong className="font-semibold">{workers}</strong> <span className="text-muted-foreground">active workers</span>
                  </span>
                  <span className="text-subtle-foreground">·</span>
                  <span>
                    <strong className="font-semibold">{sites.size}</strong> <span className="text-muted-foreground">{sites.size === 1 ? "plant" : "plants"}</span>
                  </span>
                  {c.identityStatus === "needs_review" && (
                    <StatusPill tone="pending" className="ml-auto">
                      Needs review
                    </StatusPill>
                  )}
                  {!c.isActive && (
                    <StatusPill tone="neutral" className="ml-auto">
                      Inactive
                    </StatusPill>
                  )}
                </div>
                <Link
                  href={`/admin/attendance?tab=report&contractor=${c.id}`}
                  className="group mt-auto flex h-12 items-center justify-between border-t px-4 text-sm font-semibold text-primary transition-colors hover:bg-primary-soft/60"
                >
                  View attendance
                  <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { AttendanceRegister } from "@/components/attendance/register";
import { loadRegister } from "@/lib/server/services/attendance";
import { requirePageContext } from "@/lib/server/session";

export const metadata: Metadata = { title: "Day register" };

type Search = Promise<{ project?: string; contractor?: string; date?: string }>;

export default async function HistoryDayPage({ searchParams }: { searchParams: Search }) {
  const ctx = await requirePageContext("operator");
  const sp = await searchParams;
  const view = await loadRegister(ctx, { projectId: sp.project, contractorId: sp.contractor, date: sp.date });
  return (
    <div className="space-y-3">
      <Link
        href="/history"
        className="-ml-1.5 inline-flex h-8 items-center gap-0.5 rounded-md pr-2 pl-0.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <ChevronLeft className="size-4" /> History
      </Link>
      <AttendanceRegister
        key={`${view.project?.id}:${view.contractorId}:${view.date}`}
        view={view}
        basePath="/history/day"
        allowDateChange
        heading="Day register"
      />
    </div>
  );
}

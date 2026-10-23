import type { Metadata } from "next";
import { AttendanceRegister } from "@/components/attendance/register";
import { loadRegister } from "@/lib/server/services/attendance";
import { requirePageContext } from "@/lib/server/session";

export const metadata: Metadata = { title: "Attendance" };

type Search = Promise<{ project?: string; contractor?: string; shift?: string }>;

export default async function OperatorAttendancePage({ searchParams }: { searchParams: Search }) {
  const ctx = await requirePageContext("operator");
  const sp = await searchParams;
  // Operators always record for today on this screen; past days are under History.
  const view = await loadRegister(ctx, { projectId: sp.project, contractorId: sp.contractor, date: null, shift: sp.shift });
  return (
    <AttendanceRegister
      key={`${view.project?.id}:${view.contractorId}:${view.date}:${view.shift}`}
      view={view}
      basePath="/attendance"
      allowDateChange={false}
    />
  );
}

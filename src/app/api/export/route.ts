import { NextResponse, type NextRequest } from "next/server";
import { buildAttendanceWorkbook } from "@/lib/export/xlsx";
import { toActionError } from "@/lib/server/actions/run";
import { headOfficeTimezone } from "@/lib/server/services/context";
import { getReport } from "@/lib/server/services/reports";
import { getContext } from "@/lib/server/session";
import { instantToLocal, monthRange } from "@/lib/domain/time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const ctx = await getContext();
    const sp = request.nextUrl.searchParams;
    const tz = await headOfficeTimezone(ctx);
    const now = instantToLocal(ctx.now.toISOString(), tz);
    const month = monthRange(now.date);
    const filter = {
      from: sp.get("from") || month.from,
      to: sp.get("to") || month.to,
      projectId: sp.get("project") || null,
      contractorId: sp.get("contractor") || null,
    };
    const report = await getReport(ctx, filter); // admin-only, enforced in the service
    const [projects, contractors] = await Promise.all([ctx.store.listProjects(), ctx.store.listContractors()]);
    const buffer = await buildAttendanceWorkbook(report, {
      generatedAt: `${now.date} ${now.time} (${tz})`,
      generatedBy: ctx.actor.fullName,
      projectLabel: projects.find((p) => p.id === filter.projectId)?.name ?? "All plants",
      contractorLabel: contractors.find((c) => c.id === filter.contractorId)?.name ?? "All contractors",
    });
    const filename = `attendance_${report.from}_to_${report.to}.xlsx`;
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    const err = toActionError(e);
    const status = err.code === "unauthenticated" ? 401 : err.code === "forbidden" ? 403 : err.code === "invalid" ? 400 : 500;
    return NextResponse.json({ error: err.error }, { status });
  }
}

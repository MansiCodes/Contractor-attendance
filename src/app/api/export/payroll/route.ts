import { NextResponse, type NextRequest } from "next/server";
import { buildPayrollWorkbook } from "@/lib/export/xlsx";
import { toActionError } from "@/lib/server/actions/run";
import { headOfficeTimezone } from "@/lib/server/services/context";
import { getPayroll } from "@/lib/server/services/reports";
import { getContext } from "@/lib/server/session";
import { instantToLocal } from "@/lib/domain/time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const ctx = await getContext();
    const sp = request.nextUrl.searchParams;
    const contractorId = sp.get("contractor") || null;
    const payroll = await getPayroll(ctx, { month: sp.get("month"), contractorId }); // admin-only, enforced in the service
    const tz = await headOfficeTimezone(ctx);
    const now = instantToLocal(ctx.now.toISOString(), tz);
    const contractors = await ctx.store.listContractors();
    const buffer = await buildPayrollWorkbook(payroll, {
      generatedAt: `${now.date} ${now.time} (${tz})`,
      generatedBy: ctx.actor.fullName,
      contractorLabel: contractors.find((c) => c.id === contractorId)?.name ?? "All contractors",
    });
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="payroll_${payroll.from.slice(0, 7)}.xlsx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    const err = toActionError(e);
    const status = err.code === "unauthenticated" ? 401 : err.code === "forbidden" ? 403 : err.code === "invalid" ? 400 : 500;
    return NextResponse.json({ error: err.error }, { status });
  }
}

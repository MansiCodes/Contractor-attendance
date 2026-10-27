import { NextResponse } from "next/server";
import { getAppMode } from "@/lib/config";

// Load balancer health check. It reports only "ok" or "error": no versions, hosts or
// error details. With a database it also checks one round trip to PostgreSQL, so a
// task that cannot reach the database is taken out of service.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    if (getAppMode() !== "demo") {
      const { getPool } = await import("@/lib/server/db/pool");
      await getPool().query("select 1");
    }
    return NextResponse.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const message = (e as Error).message;
    console.error("[health]", message);
    return NextResponse.json({ status: "error", reason: message }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}

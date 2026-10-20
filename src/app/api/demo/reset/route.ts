import { NextResponse } from "next/server";
import { getAppMode } from "@/lib/config";

export const dynamic = "force-dynamic";

/** Demo mode only: restores the fictional sample data (used by browser tests). */
export async function POST() {
  if (getAppMode() !== "demo") return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { resetDemoStore } = await import("@/lib/server/store/demo-store");
  resetDemoStore();
  return NextResponse.json({ ok: true });
}

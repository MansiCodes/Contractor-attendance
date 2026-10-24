import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getAppMode } from "@/lib/config";
import { companyDefaultTimezone } from "@/lib/domain/policy";
import { todayIn } from "@/lib/domain/time";
import { runDispatch } from "@/lib/server/messaging/dispatcher";
import { getTransport } from "@/lib/server/messaging/transport";
import { getServiceStore } from "@/lib/server/store";

// Scheduled WhatsApp dispatch. Call it every 10–15 minutes from a scheduler that
// runs independently of any browser or dev server, with "Authorization: Bearer
// <CRON_SECRET>". On AWS that is EventBridge Scheduler invoking the small Lambda in
// infra/lambda/dispatch.cjs (created disabled; see docs/aws/deployment.md). It
// queues the day's messages once after the configured send time and sends due
// retries. The queue itself is the outbound_messages table, so a missed or repeated
// call is harmless.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorised(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

async function handle(request: NextRequest) {
  if (!process.env.CRON_SECRET?.trim()) return NextResponse.json({ error: "Dispatch is not configured (CRON_SECRET is not set)" }, { status: 503 });
  if (!authorised(request)) return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  try {
    const store = await getServiceStore();
    const now = new Date();
    const timezone = companyDefaultTimezone(await store.listAttendancePolicies(), todayIn("UTC", now));
    const result = await runDispatch(store, getTransport(), { now, timezone, force: false, allowFictional: getAppMode() === "demo", actor: null });
    return NextResponse.json(result);
  } catch (e) {
    console.error("[whatsapp dispatch]", e);
    return NextResponse.json({ error: "Dispatch failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;

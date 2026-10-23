import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { parseStatusUpdates, verifyWebhookSignature } from "@/lib/server/messaging/transport";
import { getServiceStore } from "@/lib/server/store";

// Meta WhatsApp Cloud API webhook: delivery statuses for sent messages.
// GET answers Meta's verification handshake (WHATSAPP_VERIFY_TOKEN).
// POST is accepted only with a valid X-Hub-Signature-256 (WHATSAPP_APP_SECRET).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const token = process.env.WHATSAPP_VERIFY_TOKEN?.trim();
  const given = sp.get("hub.verify_token") ?? "";
  const ok = !!token && sp.get("hub.mode") === "subscribe" && given.length === token.length && timingSafeEqual(Buffer.from(given), Buffer.from(token));
  if (!ok) return new NextResponse("Forbidden", { status: 403 });
  return new NextResponse(sp.get("hub.challenge") ?? "", { status: 200, headers: { "Content-Type": "text/plain" } });
}

export async function POST(request: NextRequest) {
  const raw = await request.text();
  if (!verifyWebhookSignature(raw, request.headers.get("x-hub-signature-256"), process.env.WHATSAPP_APP_SECRET?.trim())) {
    return new NextResponse("Invalid signature", { status: 401 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return new NextResponse("Bad request", { status: 400 });
  }
  try {
    const store = await getServiceStore();
    let matched = 0;
    for (const u of parseStatusUpdates(payload)) {
      if (await store.applyMessageStatus(u.providerMessageId, u.status, u.at ?? new Date().toISOString(), u.error, payload)) matched++;
    }
    return NextResponse.json({ ok: true, matched });
  } catch (e) {
    console.error("[whatsapp webhook]", e);
    // A 5xx makes Meta retry the delivery later.
    return new NextResponse("Error", { status: 500 });
  }
}

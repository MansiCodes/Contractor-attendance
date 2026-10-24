import { NextResponse, type NextRequest } from "next/server";
import { getAppMode } from "@/lib/config";
import { getActor } from "@/lib/server/session";
import { CONTENT_TYPES, readLocalObject } from "@/lib/server/storage";

// Development only: serves locally stored contractor photos to signed-in users.
// In production photos come from S3 through short-lived signed URLs instead.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ key: string[] }> }) {
  if (getAppMode() !== "development") return new NextResponse("Not found", { status: 404 });
  if (!(await getActor())) return new NextResponse("Unauthorised", { status: 401 });
  const key = (await params).key.map(decodeURIComponent).join("/");
  if (!key.startsWith("contractor-photos/")) return new NextResponse("Not found", { status: 404 });
  const bytes = await readLocalObject(key);
  if (!bytes) return new NextResponse("Not found", { status: 404 });
  const type = CONTENT_TYPES[key.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
  return new NextResponse(new Uint8Array(bytes), { headers: { "Content-Type": type, "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff" } });
}

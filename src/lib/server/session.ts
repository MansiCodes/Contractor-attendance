import "server-only";
export type { ServiceContext } from "./services/context";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getAppMode } from "@/lib/config";
import { AppError } from "@/lib/errors";
import type { Actor } from "@/lib/domain/types";
import { getStore } from "./store";
import type { ServiceContext } from "./services/context";

export const DEMO_COOKIE = "nf_demo_session";

function demoSecret() {
  // Demo sessions only ever unlock fictional in-memory data.
  return process.env.DEMO_SESSION_SECRET || "nf-demo-only-not-a-secret";
}

export function signDemoSession(userId: string): string {
  const sig = createHmac("sha256", demoSecret()).update(userId).digest("base64url");
  return `${userId}.${sig}`;
}

export function verifyDemoSession(value: string | undefined): string | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;
  const userId = value.slice(0, dot);
  const expected = Buffer.from(signDemoSession(userId));
  const given = Buffer.from(value);
  return expected.length === given.length && timingSafeEqual(expected, given) ? userId : null;
}

/** The signed-in, active user — or null. Inactive users are treated as signed out. */
export const getActor = cache(async function getActor(): Promise<Actor | null> {
  const mode = getAppMode();
  if (mode === "demo") {
    const userId = verifyDemoSession((await cookies()).get(DEMO_COOKIE)?.value);
    if (!userId) return null;
    const profile = await (await getStore()).getProfile(userId);
    return profile && profile.isActive
      ? { id: profile.id, role: profile.role, fullName: profile.fullName, email: profile.email }
      : null;
  }
  // Live mode: demo cookies are ignored entirely.
  const { createServerSupabase } = await import("@/lib/supabase/server");
  const supabase = await createServerSupabase();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  const { data: profile, error: pErr } = await supabase
    .from("profiles")
    .select("id, full_name, email, role, is_active")
    .eq("id", data.user.id)
    .maybeSingle();
  if (pErr) throw new AppError(`Could not load your profile: ${pErr.message}`, "config");
  if (!profile || !profile.is_active) return null;
  return { id: profile.id, role: profile.role, fullName: profile.full_name, email: profile.email };
});

/** For server actions / route handlers: throws instead of redirecting. */
export async function getContext(): Promise<ServiceContext> {
  const actor = await getActor();
  if (!actor) throw new AppError("Please sign in again", "unauthenticated");
  return { actor, store: await getStore(), now: new Date() };
}

/** For pages: redirects to the login screen when signed out, or home on role mismatch. */
export async function requirePageContext(role?: Actor["role"]): Promise<ServiceContext> {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (role && actor.role !== role) redirect(actor.role === "admin" ? "/admin" : "/attendance");
  return { actor, store: await getStore(), now: new Date() };
}

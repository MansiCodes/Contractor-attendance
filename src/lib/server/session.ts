import "server-only";
export type { ServiceContext } from "./services/context";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
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

export interface SignedIn {
  actor: Actor;
  /** null in demo mode */
  sessionId: string | null;
  /** signed in with a temporary password that must be changed first */
  mustChangePassword: boolean;
}

/** The signed-in, active user and session — or null. Inactive users are treated as signed out. */
export const getSignedIn = cache(async function getSignedIn(): Promise<SignedIn | null> {
  // Sessions exist only at request time. This also keeps signed-in pages from being
  // pre-rendered during `next build`, where the run-time APP_MODE is not set.
  await connection();
  const mode = getAppMode();
  if (mode === "demo") {
    const userId = verifyDemoSession((await cookies()).get(DEMO_COOKIE)?.value);
    if (!userId) return null;
    const { getDemoStore } = await import("./store/demo-store");
    const profile = await getDemoStore().getProfile(userId);
    return profile && profile.isActive
      ? { actor: { id: profile.id, role: profile.role, fullName: profile.fullName, email: profile.email }, sessionId: null, mustChangePassword: false }
      : null;
  }
  // Database modes: demo cookies are ignored entirely.
  const [{ resolveSession, SESSION_COOKIE }, { pgDatabase }, { scoped }] = await Promise.all([
    import("./auth/service"),
    import("./db/pool"),
    import("./db/database"),
  ]);
  const db = pgDatabase();
  const session = await resolveSession(db, (await cookies()).get(SESSION_COOKIE)?.value);
  if (!session) return null;
  const res = await scoped(db, { kind: "user", userId: session.userId }, (q) =>
    q.query<{ id: string; full_name: string; email: string; role: "admin" | "operator"; is_active: boolean }>(
      "select id, full_name, email, role, is_active from public.profiles where id = $1",
      [session.userId],
    ),
  ).catch(() => {
    throw new AppError("Could not load your profile. Please try again.", "config");
  });
  const p = res.rows[0];
  if (!p || !p.is_active) return null;
  return {
    actor: { id: p.id, role: p.role, fullName: p.full_name, email: p.email },
    sessionId: session.sessionId,
    mustChangePassword: session.mustChangePassword,
  };
});

export async function getActor(): Promise<Actor | null> {
  return (await getSignedIn())?.actor ?? null;
}

/** For server actions / route handlers: throws instead of redirecting. */
export async function getContext(): Promise<ServiceContext> {
  const signedIn = await getSignedIn();
  if (!signedIn) throw new AppError("Please sign in again", "unauthenticated");
  if (signedIn.mustChangePassword) throw new AppError("Change your temporary password first", "forbidden");
  return { actor: signedIn.actor, store: await getStore(signedIn.actor), now: new Date() };
}

/**
 * For pages: redirects to the login screen when signed out, to the password page while
 * a temporary password is in use, or home on role mismatch.
 */
export async function requirePageContext(role?: Actor["role"]): Promise<ServiceContext> {
  const signedIn = await getSignedIn();
  if (!signedIn) redirect("/login");
  if (signedIn.mustChangePassword) redirect("/account/password");
  const { actor } = signedIn;
  if (role && actor.role !== role) redirect(actor.role === "admin" ? "/admin" : "/attendance");
  return { actor, store: await getStore(actor), now: new Date() };
}

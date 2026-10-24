"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getAppMode, secureCookies } from "@/lib/config";
import { AppError } from "@/lib/errors";
import { DEMO_COOKIE, getSignedIn, signDemoSession } from "../session";
import { toActionError, type ActionResult } from "./run";

export async function demoLoginAction(userId: string): Promise<ActionResult> {
  if (getAppMode() !== "demo") return { ok: false, error: "Demo sign-in is disabled" };
  const { getDemoStore } = await import("../store/demo-store");
  const profile = await getDemoStore().getProfile(userId);
  if (!profile || !profile.isActive) return { ok: false, error: "Unknown demo user" };
  (await cookies()).set(DEMO_COOKIE, signDemoSession(profile.id), {
    httpOnly: true,
    sameSite: "lax",
    // Secure only over HTTPS so the demo also works on a phone via http://<LAN-IP>:3000
    secure: (await headers()).get("x-forwarded-proto") === "https",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  redirect(profile.role === "admin" ? "/admin" : "/attendance");
}

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email").max(254),
  password: z.string().min(1, "Enter your password").max(200),
});

export async function loginAction(raw: unknown): Promise<ActionResult> {
  let destination = "/attendance";
  try {
    if (getAppMode() === "demo") return { ok: false, error: "Use the demo sign-in buttons" };
    const input = loginSchema.parse(raw);
    const h = await headers();
    const [{ signIn, SESSION_COOKIE }, { pgDatabase }] = await Promise.all([import("../auth/service"), import("../db/pool")]);
    const result = await signIn(pgDatabase(), input.email, input.password, {
      userAgent: h.get("user-agent"),
      ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    });
    if (!result.ok) return { ok: false, error: result.error };
    (await cookies()).set(SESSION_COOKIE, result.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: secureCookies(h.get("x-forwarded-proto")),
      path: "/",
      expires: result.expiresAt,
    });
    if (result.mustChangePassword) destination = "/account/password";
    else {
      const signedIn = await getSignedIn();
      destination = signedIn?.actor.role === "admin" ? "/admin" : "/attendance";
    }
  } catch (e) {
    return toActionError(e);
  }
  redirect(destination);
}

export async function logoutAction() {
  const jar = await cookies();
  if (getAppMode() === "demo") {
    jar.delete(DEMO_COOKIE);
  } else {
    const [{ signOut, SESSION_COOKIE }, { pgDatabase }] = await Promise.all([import("../auth/service"), import("../db/pool")]);
    await signOut(pgDatabase(), jar.get(SESSION_COOKIE)?.value).catch(() => {});
    jar.delete(SESSION_COOKIE);
  }
  redirect("/login");
}

export async function resetDemoAction(): Promise<ActionResult> {
  if (getAppMode() !== "demo") return { ok: false, error: "Not available outside the demo" };
  const { resetDemoStore } = await import("../store/demo-store");
  resetDemoStore();
  (await cookies()).delete(DEMO_COOKIE);
  redirect("/login");
}

const changeSchema = z.object({
  current: z.string().min(1, "Enter your current password").max(200),
  password: z.string().min(1, "Enter a new password").max(128),
});

/** Changes the signed-in user's own password (also used for the first sign-in with a temporary password). */
export async function changePasswordAction(raw: unknown): Promise<ActionResult> {
  try {
    if (getAppMode() === "demo") return { ok: false, error: "Not available in the demo" };
    const input = changeSchema.parse(raw);
    const signedIn = await getSignedIn();
    if (!signedIn?.sessionId) throw new AppError("Please sign in again", "unauthenticated");
    const [{ changeOwnPassword }, { pgDatabase }] = await Promise.all([import("../auth/service"), import("../db/pool")]);
    await changeOwnPassword(
      pgDatabase(),
      { userId: signedIn.actor.id, email: signedIn.actor.email, sessionId: signedIn.sessionId },
      input.current,
      input.password,
    );
    return { ok: true, data: null };
  } catch (e) {
    return toActionError(e);
  }
}

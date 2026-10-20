"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getAppMode } from "@/lib/config";
import { DEMO_COOKIE, signDemoSession } from "../session";
import { toActionError, type ActionResult } from "./run";

export async function demoLoginAction(userId: string): Promise<ActionResult> {
  if (getAppMode() !== "demo") return { ok: false, error: "Demo sign-in is disabled in live mode" };
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
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  password: z.string().min(1, "Enter your password"),
});

export async function loginAction(raw: unknown): Promise<ActionResult> {
  let role: string | null = null;
  try {
    if (getAppMode() !== "live") return { ok: false, error: "Use the demo sign-in buttons" };
    const input = loginSchema.parse(raw);
    const { createServerSupabase } = await import("@/lib/supabase/server");
    const supabase = await createServerSupabase();
    const { data, error } = await supabase.auth.signInWithPassword(input);
    if (error || !data.user) return { ok: false, error: "Email or password is incorrect" };
    const { data: profile } = await supabase.from("profiles").select("role, is_active").eq("id", data.user.id).maybeSingle();
    if (!profile || !profile.is_active) {
      await supabase.auth.signOut();
      return { ok: false, error: "This account is not active. Contact NF head office." };
    }
    role = profile.role;
  } catch (e) {
    return toActionError(e);
  }
  redirect(role === "admin" ? "/admin" : "/attendance");
}

export async function logoutAction() {
  if (getAppMode() === "demo") {
    (await cookies()).delete(DEMO_COOKIE);
  } else {
    const { createServerSupabase } = await import("@/lib/supabase/server");
    await (await createServerSupabase()).auth.signOut();
  }
  redirect("/login");
}

export async function resetDemoAction(): Promise<ActionResult> {
  if (getAppMode() !== "demo") return { ok: false, error: "Not available in live mode" };
  const { resetDemoStore } = await import("../store/demo-store");
  resetDemoStore();
  (await cookies()).delete(DEMO_COOKIE);
  redirect("/login");
}

export async function changePasswordAction(raw: unknown): Promise<ActionResult> {
  try {
    if (getAppMode() !== "live") return { ok: false, error: "Not available in demo mode" };
    const { password } = z.object({ password: z.string().min(8, "At least 8 characters").max(72) }).parse(raw);
    const { createServerSupabase } = await import("@/lib/supabase/server");
    const { error } = await (await createServerSupabase()).auth.updateUser({ password });
    if (error) return { ok: false, error: error.message };
    return { ok: true, data: null };
  } catch (e) {
    return toActionError(e);
  }
}

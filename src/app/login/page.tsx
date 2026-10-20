import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { DemoBadge } from "@/components/app-shell";
import { BrandMark } from "@/components/brand";
import { getAppMode } from "@/lib/config";
import { getActor } from "@/lib/server/session";
import { DemoLogin, LiveLogin } from "./login-forms";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage() {
  const mode = getAppMode();
  const actor = await getActor();
  if (actor) redirect(actor.role === "admin" ? "/admin" : "/attendance");

  let demoUsers: { id: string; name: string; role: "admin" | "operator"; sites: string[] }[] = [];
  if (mode === "demo") {
    const { getDemoStore } = await import("@/lib/server/store/demo-store");
    const store = getDemoStore();
    const [profiles, access, projects] = await Promise.all([store.listProfiles(), store.listOperatorAccess(), store.listProjects()]);
    demoUsers = profiles
      .filter((p) => p.isActive)
      .map((p) => ({
        id: p.id,
        name: p.fullName,
        role: p.role,
        sites: access
          .filter((a) => a.operatorId === p.id && !a.revokedAt)
          .map((a) => projects.find((x) => x.id === a.projectId)?.location.split(",")[0] ?? "")
          .filter(Boolean),
      }));
  }

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <div className="mx-auto w-full max-w-md flex-1 px-4 pt-12 pb-10 sm:pt-20">
        <div className="mb-8 space-y-5">
          <div className="flex items-center justify-between">
            <BrandMark className="size-11 rounded-xl" />
            {mode === "demo" && <DemoBadge />}
          </div>
          <div className="space-y-1.5">
            <h1 className="text-2xl font-semibold tracking-tight">NF Attendance Register</h1>
            <p className="text-md text-muted-foreground">Contractor labour attendance for NF project sites.</p>
          </div>
        </div>
        {mode === "demo" ? <DemoLogin users={demoUsers} /> : <LiveLogin />}
      </div>
      <p className="pb-6 text-center text-xs text-subtle-foreground">Valuecon · Notofire</p>
    </div>
  );
}

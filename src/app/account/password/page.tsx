import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { BrandMark } from "@/components/brand";
import { getAppMode } from "@/lib/config";
import { getSignedIn } from "@/lib/server/session";
import { ChangePasswordForm } from "./change-password-form";

export const metadata: Metadata = { title: "Choose your password" };

// Shown after signing in with a temporary password: nothing else opens until the
// user has chosen their own password.
export default async function ChoosePasswordPage() {
  // Rendered per request only: the app mode is a run-time setting, absent at build time.
  await connection();
  if (getAppMode() === "demo") redirect("/login");
  const signedIn = await getSignedIn();
  if (!signedIn) redirect("/login");
  const home = signedIn.actor.role === "admin" ? "/admin" : "/attendance";
  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <div className="mx-auto w-full max-w-md flex-1 space-y-6 px-4 pt-12 pb-10 sm:pt-20">
        <BrandMark className="size-11 rounded-xl" />
        <div className="space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">{signedIn.mustChangePassword ? "Choose your own password" : "Change your password"}</h1>
          <p className="text-md text-muted-foreground">
            {signedIn.mustChangePassword
              ? "You signed in with a temporary password from NF head office. Choose a new one to continue."
              : "Other devices signed in to your account will be signed out."}
          </p>
        </div>
        <ChangePasswordForm email={signedIn.actor.email} home={home} />
      </div>
    </div>
  );
}

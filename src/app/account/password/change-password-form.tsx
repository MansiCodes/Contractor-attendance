"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { changePasswordAction, logoutAction } from "@/lib/server/actions/auth";

export function ChangePasswordForm({ email, home }: { email: string; home: string }) {
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, start] = useTransition();
  const mismatch = again.length > 0 && next !== again;
  return (
    <form
      className="space-y-4 rounded-2xl bg-card p-5 shadow-surface"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const res = await changePasswordAction({ current, password: next });
          if (!res.ok) {
            toast.error(res.error);
            return;
          }
          toast.success("Password changed");
          router.replace(home);
          router.refresh();
        });
      }}
      noValidate
    >
      <input type="hidden" name="username" autoComplete="username" value={email} readOnly />
      <div className="space-y-1.5">
        <Label htmlFor="cp-current">Current (temporary) password</Label>
        <Input id="cp-current" type="password" autoComplete="current-password" className="h-12" value={current} onChange={(e) => setCurrent(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="cp-new">New password</Label>
        <Input id="cp-new" type="password" autoComplete="new-password" className="h-12" value={next} onChange={(e) => setNext(e.target.value)} />
        <p className="text-xs text-muted-foreground">At least 10 characters. Do not reuse the temporary password.</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="cp-again">New password again</Label>
        <Input id="cp-again" type="password" autoComplete="new-password" className="h-12" value={again} onChange={(e) => setAgain(e.target.value)} />
        {mismatch && <p className="text-sm text-absent">The two new passwords are different</p>}
      </div>
      <Button type="submit" size="lg" className="w-full" disabled={busy || !current || next.length < 10 || next !== again} data-testid="save-new-password">
        {busy && <Loader2 className="size-5 animate-spin" />} Save and continue
      </Button>
      <button type="button" className="w-full text-center text-sm font-medium text-muted-foreground hover:underline" onClick={() => start(() => logoutAction())}>
        Sign out
      </button>
    </form>
  );
}

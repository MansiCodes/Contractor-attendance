"use client";

import { useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Building2, ChevronRight, HardHat, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { demoLoginAction, loginAction } from "@/lib/server/actions/auth";
import { cn } from "@/lib/utils";

type DemoUser = { id: string; name: string; role: "admin" | "operator"; plants: string[] };

export function DemoLogin({ users }: { users: DemoUser[] }) {
  const [busy, start] = useTransition();
  const [chosen, setChosen] = useState<string | null>(null);
  const login = (id: string) => {
    setChosen(id);
    start(async () => {
      const res = await demoLoginAction(id);
      if (res && !res.ok) toast.error(res.error);
    });
  };
  const groups: { title: string; users: DemoUser[] }[] = [
    { title: "Plant attendance operators", users: users.filter((u) => u.role === "operator") },
    { title: "Head office", users: users.filter((u) => u.role === "admin") },
  ];
  return (
    <div className="space-y-6">
      {groups.map((g) =>
        g.users.length === 0 ? null : (
          <section key={g.title} className="space-y-2">
            <h2 className="px-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{g.title}</h2>
            <div className="divide-y overflow-hidden rounded-xl bg-card shadow-surface">
              {g.users.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  disabled={busy}
                  onClick={() => login(u.id)}
                  data-testid={`demo-login-${u.id}`}
                  className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-muted/60 active:bg-muted disabled:opacity-60"
                >
                  <span
                    className={cn(
                      "grid size-10 shrink-0 place-items-center rounded-full",
                      u.role === "admin" ? "bg-primary-soft text-primary" : "bg-pending-soft text-pending",
                    )}
                  >
                    {u.role === "admin" ? <Building2 className="size-5" /> : <HardHat className="size-5" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-md font-semibold">{u.name}</span>
                    <span className="block truncate text-sm text-muted-foreground">
                      {u.role === "admin" ? "All plants, reports and setup" : u.plants.join(" · ") || "No plants yet"}
                    </span>
                  </span>
                  {busy && chosen === u.id ? (
                    <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                  ) : (
                    <ChevronRight className="size-4 shrink-0 text-subtle-foreground" />
                  )}
                </button>
              ))}
            </div>
          </section>
        ),
      )}
      <p className="px-1 text-xs leading-5 text-muted-foreground">
        Demo data is kept in server memory and resets when the server restarts. Every name is fictional.
      </p>
    </div>
  );
}

const schema = z.object({
  email: z.string().trim().email("Enter a valid email"),
  password: z.string().min(1, "Enter your password"),
});

export function LiveLogin() {
  const [busy, start] = useTransition();
  const form = useForm<z.infer<typeof schema>>({ resolver: zodResolver(schema), defaultValues: { email: "", password: "" } });
  const onSubmit = form.handleSubmit((values) =>
    start(async () => {
      const res = await loginAction(values);
      if (res && !res.ok) toast.error(res.error);
    }),
  );
  return (
    <form onSubmit={onSubmit} className="space-y-4 rounded-2xl bg-card p-5 shadow-surface" noValidate>
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input id="email" type="email" autoComplete="username" inputMode="email" className="h-12" {...form.register("email")} />
        {form.formState.errors.email && <p className="text-sm text-absent">{form.formState.errors.email.message}</p>}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password">Password</Label>
        <Input id="password" type="password" autoComplete="current-password" className="h-12" {...form.register("password")} />
        {form.formState.errors.password && <p className="text-sm text-absent">{form.formState.errors.password.message}</p>}
      </div>
      <Button type="submit" size="lg" className="w-full" disabled={busy}>
        {busy && <Loader2 className="size-5 animate-spin" />} Sign in
      </Button>
      <p className="text-xs leading-5 text-muted-foreground">Accounts are created by NF head office. Ask your admin if you cannot sign in.</p>
    </form>
  );
}

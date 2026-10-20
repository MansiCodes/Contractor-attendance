"use client";

import { useState, useTransition } from "react";
import { ChevronDown, KeyRound, LogOut, RotateCcw, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { changePasswordAction, logoutAction, resetDemoAction } from "@/lib/server/actions/auth";

function initials(name: string) {
  const words = name.replace(/\(.*?\)|[–-]/g, " ").trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "?") + (words[1]?.[0] ?? "")).toUpperCase();
}

export function UserMenu({ name, role, demo }: { name: string; role: "admin" | "operator"; demo: boolean }) {
  const [pwOpen, setPwOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, start] = useTransition();
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="h-10 gap-2 rounded-full pr-2 pl-1 lg:max-w-52" data-testid="user-menu" aria-label={`Account: ${name}`}>
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold text-foreground">{initials(name)}</span>
            <span className="hidden truncate text-sm font-medium lg:inline">{name}</span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel>
            <div className="truncate font-semibold">{name}</div>
            <div className="text-xs font-normal text-muted-foreground">{role === "admin" ? "NF Admin" : "Site Operator"}</div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {demo ? (
            <>
              <DropdownMenuItem onSelect={() => start(() => logoutAction())}>
                <Users /> Switch demo user
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => start(async () => void (await resetDemoAction()))}>
                <RotateCcw /> Reset demo data
              </DropdownMenuItem>
            </>
          ) : (
            <>
              <DropdownMenuItem onSelect={() => setPwOpen(true)}>
                <KeyRound /> Change password
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => start(() => logoutAction())}>
                <LogOut /> Sign out
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={pwOpen} onOpenChange={setPwOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change password</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="new-password">New password</Label>
            <Input id="new-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <p className="text-xs text-muted-foreground">At least 8 characters.</p>
          </div>
          <DialogFooter>
            <Button
              disabled={busy || password.length < 8}
              onClick={() =>
                start(async () => {
                  const res = await changePasswordAction({ password });
                  if (res.ok) {
                    toast.success("Password changed");
                    setPassword("");
                    setPwOpen(false);
                  } else toast.error(res.error);
                })
              }
            >
              Save password
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

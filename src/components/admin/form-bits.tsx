"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { ActionResult } from "@/lib/server/actions/run";
import { cn } from "@/lib/utils";

/** Runs a server action with a toast for success/failure and refreshes the page data. */
export function useServerAction() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = <T,>(action: () => Promise<ActionResult<T>>, opts: { success?: string | ((data: T) => string); onSuccess?: (data: T) => void } = {}) =>
    start(async () => {
      try {
        const res = await action();
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        if (opts.success) toast.success(typeof opts.success === "function" ? opts.success(res.data) : opts.success);
        opts.onSuccess?.(res.data);
        router.refresh();
      } catch {
        toast.error("Could not reach the server. Check your connection and try again.");
      }
    });
  return { pending, run };
}

export function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  error?: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && !error && <p className="text-xs leading-4 text-muted-foreground">{hint}</p>}
      {error && <p className="text-sm text-absent">{error}</p>}
    </div>
  );
}

/** A labelled on/off setting with an explanation, laid out as one tappable row. */
export function ToggleRow({
  label,
  description,
  checked,
  onCheckedChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 rounded-xl bg-muted/60 px-3.5 py-3">
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        {description && <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">{description}</span>}
      </span>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </label>
  );
}

export const selectClass =
  "select-native h-11 w-full rounded-lg border border-input bg-card pl-3 text-base outline-none focus-visible:border-primary focus-visible:ring-[3px] focus-visible:ring-ring/25 disabled:opacity-50";
export const inputClass = "h-11 text-base";

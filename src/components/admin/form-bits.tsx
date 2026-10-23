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

/** Plant timezones offered in pickers. Any valid IANA zone is accepted by the server; a plant's current zone is always listed. */
const TIMEZONES: { value: string; label: string }[] = [
  { value: "Asia/Kolkata", label: "India (IST, UTC+05:30)" },
  { value: "Asia/Kathmandu", label: "Nepal (UTC+05:45)" },
  { value: "Asia/Dhaka", label: "Bangladesh (UTC+06:00)" },
  { value: "Asia/Colombo", label: "Sri Lanka (UTC+05:30)" },
  { value: "Asia/Thimphu", label: "Bhutan (UTC+06:00)" },
  { value: "Asia/Dubai", label: "UAE (UTC+04:00)" },
  { value: "Asia/Riyadh", label: "Saudi Arabia (UTC+03:00)" },
  { value: "Asia/Singapore", label: "Singapore (UTC+08:00)" },
  { value: "Europe/London", label: "United Kingdom (UTC+00:00 / BST)" },
  { value: "UTC", label: "UTC" },
];

export function TimezoneOptions({ current }: { current?: string }) {
  const list = current && !TIMEZONES.some((t) => t.value === current) ? [{ value: current, label: current }, ...TIMEZONES] : TIMEZONES;
  return (
    <>
      {list.map((t) => (
        <option key={t.value} value={t.value}>
          {t.label}
        </option>
      ))}
    </>
  );
}

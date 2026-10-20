"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { createPaymentRuleAction } from "@/lib/server/actions/admin";
import { paymentRuleInput } from "@/lib/domain/schemas";
import type { PaymentRule } from "@/lib/domain/types";
import { Field, ToggleRow, useServerAction } from "./form-bits";

interface FormValues {
  contractorId: string;
  effectiveFrom: string;
  rateType: "per_day" | "per_hour";
  dayRate: string;
  hourRate: string;
  fullDayHours: string;
  halfDayHours: string;
  overtimeEnabled: boolean;
  overtimeAfterHours: string;
  overtimeHourRate: string;
  unpaidBreakMinutes: string;
  notes: string;
  allowBackdate: boolean;
}

const str = (n: number | null | undefined) => (n === null || n === undefined ? "" : String(n));

export function NewPaymentRuleDialog({ contractorId, contractorName, latest, today }: { contractorId: string; contractorName: string; latest: PaymentRule | null; today: string }) {
  const [open, setOpen] = useState(false);
  const { pending, run } = useServerAction();
  const defaults: FormValues = {
    contractorId,
    effectiveFrom: latest && latest.effectiveFrom > today ? latest.effectiveFrom : today,
    rateType: latest?.rateType ?? "per_day",
    dayRate: str(latest?.dayRate),
    hourRate: str(latest?.hourRate),
    fullDayHours: str(latest?.fullDayHours),
    halfDayHours: str(latest?.halfDayHours),
    overtimeEnabled: latest?.overtimeEnabled ?? false,
    overtimeAfterHours: str(latest?.overtimeAfterHours),
    overtimeHourRate: str(latest?.overtimeHourRate),
    unpaidBreakMinutes: str(latest?.unpaidBreakMinutes ?? 0),
    notes: "",
    allowBackdate: false,
  };
  // The schema coerces the string inputs to numbers / nulls.
  const form = useForm<FormValues>({ resolver: zodResolver(paymentRuleInput) as never, defaultValues: defaults });
  // eslint-disable-next-line react-hooks/incompatible-library -- RHF watch is fine here
  const [rateType, overtimeEnabled, effectiveFrom] = form.watch(["rateType", "overtimeEnabled", "effectiveFrom"]);
  const e = form.formState.errors;
  const submit = form.handleSubmit((v) =>
    run(() => createPaymentRuleAction(v), {
      success: (version) => `Payment rule version ${version} saved`,
      onSuccess: () => {
        setOpen(false);
      },
    }),
  );

  return (
    <>
      <Button variant={latest ? "outline" : "default"} onClick={() => { form.reset(defaults); setOpen(true); }} data-testid="new-rule">
        {latest ? <Pencil /> : <Plus />} {latest ? "Change payment rule" : "Set up payment rule"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Payment rule · {contractorName}</DialogTitle>
            <DialogDescription>
              Saving creates a new version. Earlier dates keep using the earlier version, so past totals are not rewritten.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submit} className="space-y-4" noValidate>
            <Field label="Rate type">
              <div className="grid grid-cols-2 gap-2">
                {(["per_day", "per_hour"] as const).map((t) => (
                  <label
                    key={t}
                    className={`flex h-11 cursor-pointer items-center justify-center rounded-lg text-sm font-medium transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring ${rateType === t ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:text-foreground"}`}
                  >
                    <input type="radio" value={t} className="sr-only" {...form.register("rateType")} />
                    {t === "per_day" ? "Per day" : "Per hour"}
                  </label>
                ))}
              </div>
            </Field>
            {rateType === "per_day" ? (
              <>
                <Field label="Rate per full day (₹)" htmlFor="pr-day" error={e.dayRate?.message}>
                  <Input id="pr-day" inputMode="decimal" {...form.register("dayRate")} />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Full day if worked ≥ (hours)" htmlFor="pr-full" error={e.fullDayHours?.message} hint="Leave empty: any confirmed day = 1 day">
                    <Input id="pr-full" inputMode="decimal" {...form.register("fullDayHours")} />
                  </Field>
                  <Field label="Half day if worked ≥ (hours)" htmlFor="pr-half" error={e.halfDayHours?.message} hint="Optional">
                    <Input id="pr-half" inputMode="decimal" {...form.register("halfDayHours")} />
                  </Field>
                </div>
              </>
            ) : (
              <Field label="Rate per hour (₹)" htmlFor="pr-hour" error={e.hourRate?.message}>
                <Input id="pr-hour" inputMode="decimal" {...form.register("hourRate")} />
              </Field>
            )}
            <Field label="Unpaid break (minutes per day)" htmlFor="pr-break" error={e.unpaidBreakMinutes?.message} hint="Deducted from worked time. 0 = none.">
              <Input id="pr-break" inputMode="numeric" {...form.register("unpaidBreakMinutes")} />
            </Field>
            <ToggleRow label="Overtime" description="Pay extra hours at a separate rate." checked={overtimeEnabled} onCheckedChange={(v) => form.setValue("overtimeEnabled", v)} />
            {overtimeEnabled && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Overtime after (hours)" htmlFor="pr-ot" error={e.overtimeAfterHours?.message}>
                  <Input id="pr-ot" inputMode="decimal" {...form.register("overtimeAfterHours")} />
                </Field>
                <Field label="Overtime rate per hour (₹)" htmlFor="pr-otr" error={e.overtimeHourRate?.message}>
                  <Input id="pr-otr" inputMode="decimal" {...form.register("overtimeHourRate")} />
                </Field>
              </div>
            )}
            <Field label="Effective from" htmlFor="pr-from" error={e.effectiveFrom?.message}>
              <Input id="pr-from" type="date" {...form.register("effectiveFrom")} />
            </Field>
            {effectiveFrom < today && (
              <label className="flex items-start gap-2.5 rounded-xl bg-pending-soft p-3 text-sm text-pending">
                <input type="checkbox" className="mt-0.5 size-4" {...form.register("allowBackdate")} />
                <span>I understand this rule starts in the past and will change estimated totals from {effectiveFrom} onwards.</span>
              </label>
            )}
            <Field label="Note (optional)" htmlFor="pr-notes">
              <Input id="pr-notes" placeholder="e.g. as per work order dated…" {...form.register("notes")} />
            </Field>
            <DialogFooter>
              <Button type="submit" disabled={pending} data-testid="save-rule">
                {pending && <Loader2 className="animate-spin" />} Save new version
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

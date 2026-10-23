"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, Pencil, Plus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { OT_ROUNDING_LABEL } from "@/lib/domain/calc";
import type { ContractorRulesText } from "@/lib/domain/master-import";
import { createPaymentRuleAction } from "@/lib/server/actions/admin";
import { paymentRuleInput } from "@/lib/domain/schemas";
import type { OvertimeRounding, PaymentRule } from "@/lib/domain/types";
import { Field, selectClass, ToggleRow, useServerAction } from "./form-bits";

interface FormValues {
  contractorId: string;
  effectiveFrom: string;
  rateSource: "contractor" | "worker";
  rateType: "per_day" | "per_hour";
  dayRate: string;
  hourRate: string;
  fullDayHours: string;
  halfDayHours: string;
  shortDayPolicy: string;
  monthlyDivisorDays: string;
  overtimeEnabled: boolean;
  overtimeAfterHours: string;
  overtimeAfterNightHours: string;
  overtimeRateMode: string;
  overtimeHourRate: string;
  overtimeMultiplier: string;
  overtimeRounding: string;
  overtimeMinMinutes: string;
  unpaidBreakMinutes: string;
  commissionEnabled: boolean;
  commissionPercent: string;
  commissionScope: string;
  commissionBase: string;
  commissionTreatment: string;
  notes: string;
  allowBackdate: boolean;
}

const str = (n: number | string | null | undefined) => (n === null || n === undefined ? "" : String(n));
const NOT_DECIDED = "Not decided yet (amounts show “Needs configuration”)";

function Segmented<T extends string>({ value, options, onChange, name }: { value: T; options: [T, string][]; onChange: (v: T) => void; name: string }) {
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }} role="radiogroup" aria-label={name}>
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={`flex min-h-11 items-center justify-center rounded-lg px-2 text-center text-sm font-medium transition-colors ${value === v ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:text-foreground"}`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function NewPaymentRuleDialog({
  contractorId,
  contractorName,
  latest,
  today,
  suggestion,
}: {
  contractorId: string;
  contractorName: string;
  latest: PaymentRule | null;
  today: string;
  /** rules text found in an imported workbook; offered, never applied automatically */
  suggestion?: { rules: ContractorRulesText; fileName: string } | null;
}) {
  const [open, setOpen] = useState(false);
  const [applied, setApplied] = useState(false);
  const { pending, run } = useServerAction();
  const defaults: FormValues = {
    contractorId,
    effectiveFrom: latest && latest.effectiveFrom > today ? latest.effectiveFrom : today,
    rateSource: latest?.rateSource ?? "contractor",
    rateType: latest?.rateType ?? "per_day",
    dayRate: str(latest?.dayRate),
    hourRate: str(latest?.hourRate),
    fullDayHours: str(latest?.fullDayHours),
    halfDayHours: str(latest?.halfDayHours),
    shortDayPolicy: str(latest?.shortDayPolicy),
    monthlyDivisorDays: str(latest?.monthlyDivisorDays),
    overtimeEnabled: latest?.overtimeEnabled ?? false,
    overtimeAfterHours: str(latest?.overtimeAfterHours),
    overtimeAfterNightHours: str(latest?.overtimeAfterNightHours),
    overtimeRateMode: str(latest?.overtimeRateMode),
    overtimeHourRate: str(latest?.overtimeHourRate),
    overtimeMultiplier: str(latest?.overtimeMultiplier),
    overtimeRounding: str(latest?.overtimeRounding),
    overtimeMinMinutes: str(latest?.overtimeMinMinutes ?? 0),
    unpaidBreakMinutes: str(latest?.unpaidBreakMinutes ?? 0),
    commissionEnabled: latest?.commissionEnabled ?? false,
    commissionPercent: str(latest?.commissionPercent),
    commissionScope: str(latest?.commissionScope),
    commissionBase: str(latest?.commissionBase),
    commissionTreatment: str(latest?.commissionTreatment),
    notes: "",
    allowBackdate: false,
  };
  // The schema coerces the string inputs to numbers / nulls.
  const form = useForm<FormValues>({ resolver: zodResolver(paymentRuleInput) as never, defaultValues: defaults });
  // eslint-disable-next-line react-hooks/incompatible-library -- RHF watch is fine here
  const v = form.watch();
  const e = form.formState.errors;
  const set = <K extends keyof FormValues>(k: K, value: FormValues[K]) => form.setValue(k, value as never, { shouldDirty: true });

  /** Fills only what the workbook states; everything it does not say stays as it is. */
  const applySuggestion = () => {
    if (!suggestion) return;
    const r = suggestion.rules;
    if (r.standardHours !== null) set("fullDayHours", String(r.standardHours));
    if (r.overtimeDayHours !== null) {
      set("overtimeEnabled", true);
      set("overtimeAfterHours", String(r.overtimeDayHours));
      set("overtimeAfterNightHours", r.overtimeNightHours !== null && r.overtimeNightHours !== r.overtimeDayHours ? String(r.overtimeNightHours) : "");
    }
    if (r.commissionEnabled !== null) {
      set("commissionEnabled", r.commissionEnabled);
      if (r.commissionPercent !== null) set("commissionPercent", String(r.commissionPercent));
      if (r.commissionScope) set("commissionScope", r.commissionScope);
    }
    // Rates that "differ according to position" are each worker's own rate.
    if (r.rateVaries) set("rateSource", "worker");
    else if (r.rateBasis === "daily" && r.rateAmount !== null) {
      set("rateSource", "contractor");
      set("rateType", "per_day");
      set("dayRate", String(r.rateAmount));
    }
    setApplied(true);
  };

  const submit = form.handleSubmit((values) =>
    run(() => createPaymentRuleAction(values), {
      success: (version) => `Payment rule version ${version} saved`,
      onSuccess: () => setOpen(false),
    }),
  );

  const usesDayRate = v.rateSource === "worker" || v.rateType === "per_day";

  return (
    <>
      <Button
        variant={latest ? "outline" : "default"}
        onClick={() => {
          form.reset(defaults);
          setApplied(false);
          setOpen(true);
        }}
        data-testid="new-rule"
      >
        {latest ? <Pencil /> : <Plus />} {latest ? "Change payment rule" : "Set up payment rule"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Payment rule · {contractorName}</DialogTitle>
            <DialogDescription>
              Saving creates a new version. Earlier dates keep using the earlier version, so past totals are not rewritten. Leave anything the company has not decided
              empty: those amounts show “Needs configuration” instead of a guess.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submit} className="space-y-5" noValidate data-testid="rule-form">
            {suggestion && (
              <div className="rounded-xl bg-primary-soft p-3 text-sm">
                <p className="font-medium text-primary">From “{suggestion.fileName}”: {suggestion.rules.label}</p>
                <ul className="mt-1 space-y-0.5 text-foreground/80">
                  {suggestion.rules.lines.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                </ul>
                <Button type="button" size="sm" variant="outline" className="mt-2" onClick={applySuggestion} disabled={applied} data-testid="apply-suggestion">
                  <Sparkles /> {applied ? "Filled in — check before saving" : "Fill in what this states"}
                </Button>
              </div>
            )}

            {/* Rate */}
            <fieldset className="space-y-3">
              <legend className="text-sm font-semibold">Rate</legend>
              <Segmented
                name="Rate source"
                value={v.rateSource}
                onChange={(x) => set("rateSource", x)}
                options={[
                  ["contractor", "One rate for all workers"],
                  ["worker", "Each worker's own rate"],
                ]}
              />
              {v.rateSource === "contractor" ? (
                <>
                  <Segmented
                    name="Rate type"
                    value={v.rateType}
                    onChange={(x) => set("rateType", x)}
                    options={[
                      ["per_day", "Per day"],
                      ["per_hour", "Per hour"],
                    ]}
                  />
                  {v.rateType === "per_day" ? (
                    <Field label="Rate per full day (₹)" htmlFor="pr-day" error={e.dayRate?.message}>
                      <Input id="pr-day" inputMode="decimal" {...form.register("dayRate")} />
                    </Field>
                  ) : (
                    <Field label="Rate per hour (₹)" htmlFor="pr-hour" error={e.hourRate?.message}>
                      <Input id="pr-hour" inputMode="decimal" {...form.register("hourRate")} />
                    </Field>
                  )}
                </>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    Each worker&apos;s rate and its basis (monthly, daily or hourly) come from their pay terms, e.g. the imported master. A worker whose basis is still
                    “Requires verification” shows “Needs configuration”.
                  </p>
                  <Field
                    label="Days per month for monthly salaries"
                    htmlFor="pr-div"
                    error={e.monthlyDivisorDays?.message}
                    hint="Only used for workers paid monthly: day rate = salary ÷ this. Leave empty until it is decided."
                  >
                    <Input id="pr-div" inputMode="numeric" {...form.register("monthlyDivisorDays")} />
                  </Field>
                </>
              )}
            </fieldset>

            {/* Working day */}
            <fieldset className="space-y-3">
              <legend className="text-sm font-semibold">Working day</legend>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Standard working hours" htmlFor="pr-full" error={e.fullDayHours?.message} hint="A day of at least this many hours is a full day.">
                  <Input id="pr-full" inputMode="decimal" {...form.register("fullDayHours")} />
                </Field>
                <Field label="Unpaid break (minutes per day)" htmlFor="pr-break" error={e.unpaidBreakMinutes?.message} hint="Deducted from worked time. 0 = none.">
                  <Input id="pr-break" inputMode="numeric" {...form.register("unpaidBreakMinutes")} />
                </Field>
              </div>
              {usesDayRate && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="A completed day shorter than standard is paid" htmlFor="pr-short">
                    <select id="pr-short" className={selectClass} {...form.register("shortDayPolicy")}>
                      <option value="">{NOT_DECIDED}</option>
                      <option value="pro_rata">In proportion to hours worked</option>
                      <option value="half_day">Half a day above a minimum, else nothing</option>
                      <option value="full_day">As a full day</option>
                    </select>
                  </Field>
                  {v.shortDayPolicy === "half_day" && (
                    <Field label="Half day if worked ≥ (hours)" htmlFor="pr-half" error={e.halfDayHours?.message}>
                      <Input id="pr-half" inputMode="decimal" {...form.register("halfDayHours")} />
                    </Field>
                  )}
                </div>
              )}
            </fieldset>

            {/* Overtime */}
            <fieldset className="space-y-3">
              <legend className="sr-only">Overtime</legend>
              <ToggleRow label="Overtime" description="Hours beyond a threshold, paid separately from the day's pay." checked={v.overtimeEnabled} onCheckedChange={(x) => set("overtimeEnabled", x)} />
              {v.overtimeEnabled && (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Day shift: overtime after (hours)" htmlFor="pr-ot" error={e.overtimeAfterHours?.message}>
                      <Input id="pr-ot" inputMode="decimal" {...form.register("overtimeAfterHours")} />
                    </Field>
                    <Field label="Night shift: overtime after (hours)" htmlFor="pr-otn" error={e.overtimeAfterNightHours?.message} hint="Leave empty if the same as the day shift.">
                      <Input id="pr-otn" inputMode="decimal" {...form.register("overtimeAfterNightHours")} />
                    </Field>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Overtime is paid" htmlFor="pr-otmode">
                      <select id="pr-otmode" className={selectClass} {...form.register("overtimeRateMode")}>
                        <option value="">{NOT_DECIDED}</option>
                        <option value="per_hour">At a fixed rate per hour</option>
                        <option value="multiplier">At a multiple of the hourly rate</option>
                      </select>
                    </Field>
                    {v.overtimeRateMode === "per_hour" && (
                      <Field label="Overtime rate per hour (₹)" htmlFor="pr-otr" error={e.overtimeHourRate?.message} hint="Leave empty until it is agreed.">
                        <Input id="pr-otr" inputMode="decimal" {...form.register("overtimeHourRate")} />
                      </Field>
                    )}
                    {v.overtimeRateMode === "multiplier" && (
                      <Field label="Multiplier (× hourly rate)" htmlFor="pr-otx" error={e.overtimeMultiplier?.message} hint="Hourly rate for day rates = day rate ÷ standard hours.">
                        <Input id="pr-otx" inputMode="decimal" {...form.register("overtimeMultiplier")} />
                      </Field>
                    )}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Round overtime" htmlFor="pr-otround">
                      <select id="pr-otround" className={selectClass} {...form.register("overtimeRounding")}>
                        <option value="">{NOT_DECIDED}</option>
                        {(Object.keys(OT_ROUNDING_LABEL) as OvertimeRounding[]).map((k) => (
                          <option key={k} value={k}>
                            {OT_ROUNDING_LABEL[k][0].toUpperCase() + OT_ROUNDING_LABEL[k].slice(1)}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Do not pay overtime shorter than (minutes)" htmlFor="pr-otmin" error={e.overtimeMinMinutes?.message} hint="0 = no minimum.">
                      <Input id="pr-otmin" inputMode="numeric" {...form.register("overtimeMinMinutes")} />
                    </Field>
                  </div>
                </>
              )}
            </fieldset>

            {/* Commission */}
            <fieldset className="space-y-3">
              <legend className="sr-only">Commission</legend>
              <ToggleRow
                label="Contractor commission"
                description="A percentage of wages. Kept separate from overtime."
                checked={v.commissionEnabled}
                onCheckedChange={(x) => set("commissionEnabled", x)}
              />
              {v.commissionEnabled && (
                <>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Commission (%)" htmlFor="pr-cpct" error={e.commissionPercent?.message}>
                      <Input id="pr-cpct" inputMode="decimal" {...form.register("commissionPercent")} />
                    </Field>
                    <Field label="Applies to" htmlFor="pr-cscope" hint={v.commissionScope === "selected" ? "Select the workers under Worker rates below." : undefined}>
                      <select id="pr-cscope" className={selectClass} {...form.register("commissionScope")}>
                        <option value="">{NOT_DECIDED}</option>
                        <option value="all">Every worker</option>
                        <option value="selected">Selected workers only</option>
                      </select>
                    </Field>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Calculated on" htmlFor="pr-cbase">
                      <select id="pr-cbase" className={selectClass} {...form.register("commissionBase")}>
                        <option value="">{NOT_DECIDED}</option>
                        <option value="base_wages">Base wages (without overtime)</option>
                        <option value="gross_wages">Base wages plus overtime</option>
                      </select>
                    </Field>
                    <Field label="Commission is" htmlFor="pr-ctreat">
                      <select id="pr-ctreat" className={selectClass} {...form.register("commissionTreatment")}>
                        <option value="">{NOT_DECIDED}</option>
                        <option value="added_to_contractor_payable">Paid to the contractor on top of wages</option>
                        <option value="deducted_from_wages">Taken out of the workers&apos; wages</option>
                      </select>
                    </Field>
                  </div>
                </>
              )}
            </fieldset>

            <Field label="Effective from" htmlFor="pr-from" error={e.effectiveFrom?.message}>
              <Input id="pr-from" type="date" {...form.register("effectiveFrom")} />
            </Field>
            {v.effectiveFrom < today && (
              <label className="flex items-start gap-2.5 rounded-xl bg-pending-soft p-3 text-sm text-pending">
                <input type="checkbox" className="mt-0.5 size-4" {...form.register("allowBackdate")} />
                <span>I understand this rule starts in the past and will change estimated totals from {v.effectiveFrom} onwards.</span>
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

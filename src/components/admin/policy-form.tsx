"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Info, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { createPolicyVersionAction } from "@/lib/server/actions/settings";
import type { PolicySnapshot } from "@/lib/server/services/settings";
import { POLICY_FIELDS, REQUIRED_POLICY_FIELDS, type PolicyField, type PolicyValues } from "@/lib/domain/policy";
import { formatDateLong } from "@/lib/domain/time";
import { cn } from "@/lib/utils";
import { Field, TimezoneOptions, selectClass, useServerAction } from "./form-bits";
import { describePolicyValue, FIELD_LABELS } from "./policy-text";

type Scope = { kind: "company" } | { kind: "site"; projectId: string; projectName: string };

type FormValue = string | boolean;
type FormValues = Record<PolicyField, FormValue>;

const TIME: PolicyField[] = ["suggestedCheckIn", "nightSuggestedCheckIn", "shiftStart", "shiftEnd", "editCutoffTime"];
const BOOL: PolicyField[] = ["allowOvernight", "autoAbsentEnabled"];
/** Shift start and end are inherited or overridden together. */
const unitOf = (f: PolicyField): PolicyField[] => (f === "shiftStart" || f === "shiftEnd" ? ["shiftStart", "shiftEnd"] : [f]);

const toForm = (p: PolicyValues): FormValues =>
  Object.fromEntries(POLICY_FIELDS.map((f) => [f, BOOL.includes(f) ? Boolean(p[f]) : p[f] === null ? "" : String(p[f])])) as FormValues;

const fromForm = (f: PolicyField, v: FormValue) => (BOOL.includes(f) ? Boolean(v) : v === "" ? null : TIME.includes(f) ? String(v) : Number(v));

/** The snapshot in force on `date`: what a version starting that day builds on. */
const snapshotAt = (snapshots: PolicySnapshot[], date: string) =>
  snapshots.reduce((found, s) => (s.from <= date ? s : found), snapshots[0]);

const GROUPS: { title: string; note?: string; fields: PolicyField[] }[] = [
  {
    title: "Shift",
    note: "A suggested time is only a starting point on the register. Workers stay pending until an operator confirms them, and accepted suggestions are flagged in reports.",
    fields: ["suggestedCheckIn", "shiftStart", "shiftEnd", "breakMinutes", "allowOvernight", "nightSuggestedCheckIn"],
  },
  { title: "Time checks", fields: ["inFutureToleranceMin", "outFutureToleranceMin"] },
  {
    title: "Editing past attendance",
    note: "Head office admins can always correct any date up to today. Every change is logged.",
    fields: ["operatorBackdateDays", "editCutoffTime"],
  },
  { title: "Labels (never change pay)", fields: ["lateGraceMin", "halfDayBelowHours", "overtimeAfterHours", "overtimeMinMinutes"] },
  {
    title: "Unmarked workers",
    note: "Report only: nothing is written to attendance. Workers still pending after operators can no longer edit that day appear as “Absent – not marked”.",
    fields: ["autoAbsentEnabled"],
  },
];

const HINTS: Partial<Record<PolicyField, string>> = {
  suggestedCheckIn: "Leave empty for no suggestion: operators then enter each IN time.",
  nightSuggestedCheckIn:
    "For plants with a night shift. Leave empty for no suggestion. A night shift's OUT may always be the next morning; let operators edit 1 past day so they can record it.",
  shiftStart: "Used for late labels. Set start and end together, or leave both empty.",
  breakMinutes: "Leave empty for none. Not counted as worked time. Payable hours still follow each contractor's payment rule.",
  editCutoffTime: "Leave empty for the end of the day.",
  lateGraceMin: "Leave empty to turn late labels off. Needs a shift start.",
  halfDayBelowHours: "Leave empty to turn off.",
  overtimeAfterHours: "Leave empty to turn off.",
};

export function PolicyForm({
  scope,
  snapshots,
  versionDates,
  today,
  closeHref,
}: {
  scope: Scope;
  /** today's settings, then one per scheduled change; the form starts from the one in force on its start date */
  snapshots: PolicySnapshot[];
  /** start dates of this scope's existing versions */
  versionDates: string[];
  /** the scope's local date: versions starting earlier need confirmation */
  today: string;
  /** where Cancel and a successful save go */
  closeHref: string;
}) {
  const router = useRouter();
  const { pending, run } = useServerAction();
  const isSite = scope.kind === "site";
  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const [base, setBase] = useState(() => snapshotAt(snapshots, today));
  const [values, setValues] = useState<FormValues>(() => toForm(base.values));
  const [custom, setCustom] = useState<Set<PolicyField>>(() => new Set(isSite ? base.overridden : POLICY_FIELDS));
  const [reloaded, setReloaded] = useState(false);
  const [allowBackdate, setAllowBackdate] = useState(false);
  const [timezone, setTimezone] = useState(base.defaultTimezone);
  const [notes, setNotes] = useState("");
  const inherited = toForm(base.company); // what a plant gets for fields it does not override

  const changeDate = (date: string) => {
    setEffectiveFrom(date);
    const next = snapshotAt(snapshots, date);
    if (next.from === base.from) return;
    // A different version is in force on the new date: start from it, so saving never
    // silently drops settings that are already scheduled.
    setBase(next);
    setValues(toForm(next.values));
    setCustom(new Set(isSite ? next.overridden : POLICY_FIELDS));
    setTimezone(next.defaultTimezone);
    setReloaded(true);
  };

  const set = (f: PolicyField, v: FormValue) => setValues((prev) => ({ ...prev, [f]: v }));
  const toggleCustom = (f: PolicyField, on: boolean) =>
    setCustom((prev) => {
      const next = new Set(prev);
      for (const u of unitOf(f)) {
        if (on) next.add(u);
        else next.delete(u);
      }
      return next;
    });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const payload: Record<string, unknown> = {
      projectId: isSite ? scope.projectId : null,
      effectiveFrom,
      overridden: isSite ? POLICY_FIELDS.filter((f) => custom.has(f)) : [],
      defaultTimezone: scope.kind === "company" ? timezone : null,
      notes: notes.trim() || null,
      allowBackdate,
    };
    for (const f of POLICY_FIELDS) payload[f] = !isSite || custom.has(f) ? fromForm(f, values[f]) : null;
    run(() => createPolicyVersionAction(payload), {
      success: (v) => `Saved as version ${v}, in force from ${effectiveFrom}`,
      onSuccess: () => router.push(closeHref),
    });
  };

  const input = (f: PolicyField, disabled: boolean) => {
    const id = `pol-${f}`;
    const v = disabled ? inherited[f] : values[f];
    if (BOOL.includes(f)) {
      return <Switch id={id} checked={Boolean(v)} disabled={disabled} onCheckedChange={(on) => set(f, on)} aria-label={FIELD_LABELS[f]} />;
    }
    if (f === "operatorBackdateDays") {
      return (
        <select id={id} className={selectClass} disabled={disabled} value={String(v)} onChange={(e) => set(f, e.target.value)}>
          {[0, 1, 2, 3, 4, 5, 6, 7].map((n) => (
            <option key={n} value={n}>
              {describePolicyValue("operatorBackdateDays", n)}
            </option>
          ))}
        </select>
      );
    }
    const isTime = TIME.includes(f);
    const isHours = f === "halfDayBelowHours" || f === "overtimeAfterHours";
    return (
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type={isTime ? "time" : "number"}
          inputMode={isTime ? undefined : "decimal"}
          step={isHours ? 0.25 : isTime ? undefined : 1}
          min={isTime ? undefined : 0}
          className="h-11 text-base"
          disabled={disabled}
          value={String(v)}
          onChange={(e) => set(f, e.target.value)}
        />
        {!isTime && <span className="shrink-0 text-sm text-muted-foreground">{isHours ? "hours" : "min"}</span>}
      </div>
    );
  };

  const backdated = effectiveFrom < today;
  const later = versionDates.filter((d) => d > effectiveFrom);

  return (
    <form onSubmit={submit} className="space-y-5 rounded-xl bg-card p-4 shadow-surface" noValidate data-testid="policy-form">
      <div className="space-y-2">
        <Field label="In force from" htmlFor="pol-from" hint="Choose this first. Days before it keep their earlier rules.">
          <Input id="pol-from" type="date" className="h-11 text-base sm:max-w-56" value={effectiveFrom} onChange={(e) => changeDate(e.target.value)} />
        </Field>
        {reloaded && (
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" /> Showing the settings in force from {formatDateLong(base.from)}, as a starting point for this date.
          </p>
        )}
        {later.length > 0 && (
          <p className="flex items-start gap-2 rounded-lg bg-muted px-3 py-2 text-xs" data-testid="later-versions">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            Versions already saved from {later.map((d) => formatDateLong(d)).join(", ")} still apply from those dates, so this change only covers the days before.
          </p>
        )}
        {backdated && (
          <label className="flex items-start gap-2.5 rounded-lg bg-pending-soft px-3 py-2.5 text-sm text-pending">
            <input type="checkbox" className="mt-0.5" checked={allowBackdate} onChange={(e) => setAllowBackdate(e.target.checked)} data-testid="allow-backdate" />
            <span>
              <strong className="font-semibold">Apply to past dates.</strong> Labels for days from {effectiveFrom} will be recalculated with these rules.
              Recorded attendance is not changed.
            </span>
          </label>
        )}
      </div>

      {GROUPS.map((g) => (
        <fieldset key={g.title} className="space-y-3">
          <legend className="text-sm font-semibold">{g.title}</legend>
          {g.note && <p className="-mt-1 text-xs leading-4 text-muted-foreground">{g.note}</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            {g.fields.map((f) => {
              const own = !isSite || custom.has(f);
              const required = (REQUIRED_POLICY_FIELDS as readonly PolicyField[]).includes(f);
              return (
                <div key={f} className={cn("space-y-1.5 rounded-lg p-2.5", isSite && !own && "bg-muted/50")}>
                  <div className="flex items-center justify-between gap-2">
                    <label htmlFor={`pol-${f}`} className="text-sm font-medium">
                      {FIELD_LABELS[f]}
                    </label>
                    {isSite && (
                      <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={!own}
                          onChange={(e) => toggleCustom(f, !e.target.checked)}
                          data-testid={`inherit-${f}`}
                        />
                        Company default
                      </label>
                    )}
                  </div>
                  {input(f, !own)}
                  {own && HINTS[f] && !required && <p className="text-xs leading-4 text-muted-foreground">{HINTS[f]}</p>}
                  {!own && <p className="text-xs leading-4 text-muted-foreground">Company default: {describePolicyValue(f, base.company[f])}</p>}
                </div>
              );
            })}
          </div>
        </fieldset>
      ))}

      {scope.kind === "company" && (
        <Field label="Timezone for new plants" htmlFor="pol-tz" hint="Preselected when adding a plant. Existing plants keep their own timezone.">
          <select id="pol-tz" className={selectClass} value={timezone} onChange={(e) => setTimezone(e.target.value)}>
            <TimezoneOptions current={timezone} />
          </select>
        </Field>
      )}

      <Field label="Note (optional)" htmlFor="pol-notes" hint="Why this changed, for the history.">
        <Textarea id="pol-notes" rows={2} maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>

      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => router.push(closeHref)}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending || (backdated && !allowBackdate)} data-testid="policy-save">
          {pending && <Loader2 className="animate-spin" />} Save as new version
        </Button>
      </div>
    </form>
  );
}

import { POLICY_FIELDS, type PolicyField, type PolicyRowValues } from "@/lib/domain/policy";
import { formatMinutes, formatTime12 } from "@/lib/domain/time";

// Plain-language names and values for attendance settings (shared by the settings
// page and its form; no React here so server and client components can both use it).

export const FIELD_LABELS: Record<PolicyField, string> = {
  suggestedCheckIn: "Suggested IN time",
  nightSuggestedCheckIn: "Suggested IN time (night shift)",
  shiftStart: "Shift start",
  shiftEnd: "Shift end",
  breakMinutes: "Break",
  allowOvernight: "Overnight shifts",
  inFutureToleranceMin: "IN may be ahead of the clock by",
  outFutureToleranceMin: "OUT may be ahead of the clock by",
  lateGraceMin: "Late after shift start + grace",
  halfDayBelowHours: "Half day if worked less than",
  overtimeAfterHours: "Overtime after",
  overtimeMinMinutes: "Ignore overtime shorter than",
  operatorBackdateDays: "Operators may edit",
  editCutoffTime: "Operator editing closes at",
  autoAbsentEnabled: "Show unmarked workers as absent",
};

export function describePolicyValue(field: PolicyField, v: PolicyRowValues[PolicyField]): string {
  switch (field) {
    case "suggestedCheckIn":
    case "nightSuggestedCheckIn":
      return v === null ? "None (operators enter the time)" : formatTime12(v as string);
    case "shiftStart":
    case "shiftEnd":
      return v === null ? "Not set" : formatTime12(v as string);
    case "breakMinutes":
      return v === null || v === 0 ? "None" : `${v} min (not counted as worked time)`;
    case "editCutoffTime":
      return v === null ? "End of the last editable day" : `${formatTime12(v as string)} on the last editable day`;
    case "allowOvernight":
      return v ? "Allowed (OUT may be the next day)" : "Not allowed";
    case "autoAbsentEnabled":
      return v ? "On (report only, after the edit window closes)" : "Off";
    case "inFutureToleranceMin":
    case "outFutureToleranceMin":
      return v === 0 ? "Not at all" : `${v} min`;
    case "lateGraceMin":
      return v === null ? "Off" : `${v} min grace`;
    case "overtimeMinMinutes":
      return v === null || v === 0 ? "No minimum" : `${v} min`;
    case "halfDayBelowHours":
    case "overtimeAfterHours":
      return v === null ? "Off" : formatMinutes(Math.round((v as number) * 60));
    case "operatorBackdateDays":
      return v === 0 ? "Today only" : `Today and ${v} past day${v === 1 ? "" : "s"}`;
  }
}

/** One line per field a version sets, for the change history. */
export function describeVersion(v: PolicyRowValues & { overridden: PolicyField[] }, isCompany: boolean): string[] {
  const fields = isCompany ? POLICY_FIELDS : v.overridden;
  return fields.map((f) => `${FIELD_LABELS[f]}: ${describePolicyValue(f, v[f])}`);
}

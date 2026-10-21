import { addDays, instantToLocal, isValidTime, localToInstantPg, localToInstantStrict, minutesBetween } from "./time";
import type { AttendanceSnapshot, AttendanceStatus, CheckInSource } from "./types";

// Attendance policy: company-wide defaults with optional per-site overrides,
// stored as append-only versions with an effective date. Pure functions only.
// Mirrored in SQL (supabase/migrations/20261022*): attendance_policy_resolve()
// mirrors resolvePolicy(), operator_edit_closes_at() mirrors operatorEditClosesAt(),
// and the attendance_before_write trigger mirrors evaluateEntry(). Keep them in step.
// See docs/attendance-settings.md.

export const POLICY_FIELDS = [
  "suggestedCheckIn",
  "shiftStart",
  "shiftEnd",
  "allowOvernight",
  "inFutureToleranceMin",
  "outFutureToleranceMin",
  "lateGraceMin",
  "halfDayBelowHours",
  "overtimeAfterHours",
  "overtimeMinMinutes",
  "operatorBackdateDays",
  "editCutoffTime",
  "autoAbsentEnabled",
] as const;
export type PolicyField = (typeof POLICY_FIELDS)[number];

/** Fields where "none" has no meaning: the company row and any site override must set them. */
export const REQUIRED_POLICY_FIELDS = [
  "allowOvernight",
  "inFutureToleranceMin",
  "outFutureToleranceMin",
  "operatorBackdateDays",
  "autoAbsentEnabled",
] as const satisfies readonly PolicyField[];

const isRequired = (f: PolicyField) => (REQUIRED_POLICY_FIELDS as readonly PolicyField[]).includes(f);

export interface PolicyValues {
  /** Shown for pending workers, "HH:mm". null = no suggestion; operators enter a time. Never proof of attendance. */
  suggestedCheckIn: string | null;
  /** Informational; shift start also anchors late labels. Set together with shiftEnd. */
  shiftStart: string | null;
  shiftEnd: string | null;
  /** OUT earlier than IN is treated as the next day. */
  allowOvernight: boolean;
  /** How far ahead of the clock an IN time may be recorded. */
  inFutureToleranceMin: number;
  /** How far ahead of the clock an OUT time may be recorded (clock skew allowance). */
  outFutureToleranceMin: number;
  /** null = late labels off. Late = IN more than this many minutes after shift start. */
  lateGraceMin: number | null;
  /** null = off. A completed shift shorter than this is labelled "Half day". Label only. */
  halfDayBelowHours: number | null;
  /** null = off. Time worked beyond this is labelled overtime. Label only. */
  overtimeAfterHours: number | null;
  /** Overtime shorter than this is ignored. null = 0. */
  overtimeMinMinutes: number | null;
  /** How many past days operators may still edit. 0 = today only. Admins can always correct. */
  operatorBackdateDays: number;
  /** Site-local time on the last editable day when operator editing closes. null = end of that day. */
  editCutoffTime: string | null;
  /** Report-only: pending workers are shown as "Absent – not marked" once the operator window has closed. */
  autoAbsentEnabled: boolean;
}

export type PolicyRowValues = { [K in PolicyField]: PolicyValues[K] | null };

/** One stored version. Company rows have projectId null and set every required field. */
export interface AttendancePolicyVersion extends PolicyRowValues {
  id: string;
  projectId: string | null;
  version: number;
  effectiveFrom: string;
  /** Site rows only: the fields this version sets (a listed field with null means "none"). */
  overridden: PolicyField[];
  /** Company rows only: timezone preselected for new sites. */
  defaultTimezone: string | null;
  notes: string | null;
  createdAt: string;
  createdBy: string | null;
}

export type PolicySource = "company" | "site" | "fallback";

/** The values in force for a site on a date, and which versions they came from. */
export interface ResolvedPolicy extends PolicyValues {
  companyPolicyId: string | null;
  sitePolicyId: string | null;
}

export interface EffectivePolicy extends ResolvedPolicy {
  source: Record<PolicyField, PolicySource>;
}

/** Used only where no company version is in force (the migration seeds one from 1900-01-01). */
export const FALLBACK_POLICY: PolicyValues = {
  suggestedCheckIn: null,
  shiftStart: null,
  shiftEnd: null,
  allowOvernight: false,
  inFutureToleranceMin: 60,
  outFutureToleranceMin: 5,
  lateGraceMin: null,
  halfDayBelowHours: null,
  overtimeAfterHours: null,
  overtimeMinMinutes: null,
  operatorBackdateDays: 0,
  editCutoffTime: null,
  autoAbsentEnabled: false,
};
export const FALLBACK_TIMEZONE = "Asia/Kolkata";
/** Earliest effective date a version may have (the seeded versions start here). */
export const POLICY_EPOCH = "1900-01-01";

/** The version of one scope in force on `date`: latest effectiveFrom <= date, then highest version. */
export function versionInForce(
  versions: AttendancePolicyVersion[],
  projectId: string | null,
  date: string,
): AttendancePolicyVersion | null {
  let best: AttendancePolicyVersion | null = null;
  for (const v of versions) {
    if (v.projectId !== projectId || v.effectiveFrom > date) continue;
    if (!best || v.effectiveFrom > best.effectiveFrom || (v.effectiveFrom === best.effectiveFrom && v.version > best.version)) best = v;
  }
  return best;
}

export function resolvePolicy(versions: AttendancePolicyVersion[], projectId: string | null, date: string): EffectivePolicy {
  const company = versionInForce(versions, null, date);
  const site = projectId ? versionInForce(versions, projectId, date) : null;
  const values: Record<string, unknown> = { ...FALLBACK_POLICY };
  const source = {} as Record<PolicyField, PolicySource>;
  for (const f of POLICY_FIELDS) {
    if (site && site.overridden.includes(f)) {
      values[f] = site[f];
      source[f] = "site";
    } else if (company && !(isRequired(f) && company[f] === null)) {
      values[f] = company[f];
      source[f] = "company";
    } else {
      source[f] = "fallback";
    }
  }
  return {
    ...(values as unknown as PolicyValues),
    source,
    companyPolicyId: company?.id ?? null,
    sitePolicyId: site?.id ?? null,
  };
}

/** Timezone preselected for new sites: the company version in force on `date`. */
export function companyDefaultTimezone(versions: AttendancePolicyVersion[], date: string): string {
  return versionInForce(versions, null, date)?.defaultTimezone ?? FALLBACK_TIMEZONE;
}

/** Identifies the versions a register was loaded with, so a save can detect a settings change. */
export function policyToken(day: Pick<ResolvedPolicy, "companyPolicyId" | "sitePolicyId">, capture: Pick<ResolvedPolicy, "companyPolicyId" | "sitePolicyId">): string {
  return [day.companyPolicyId, day.sitePolicyId, capture.companyPolicyId, capture.sitePolicyId].map((v) => v ?? "-").join("|");
}

// ---------------------------------------------------------------------------
// Operator edit window
// ---------------------------------------------------------------------------

/**
 * Instant at which operators can no longer edit `workDate` at a site: the cutoff
 * time on day workDate + N (site-local), or the end of that day without a cutoff.
 * Pass the policy in force on the site's today.
 */
export function operatorEditClosesAt(
  policy: Pick<PolicyValues, "operatorBackdateDays" | "editCutoffTime">,
  workDate: string,
  timezone: string,
): Date {
  const lastDay = addDays(workDate, policy.operatorBackdateDays);
  return policy.editCutoffTime
    ? localToInstantPg(lastDay, policy.editCutoffTime, timezone)
    : localToInstantPg(addDays(lastDay, 1), "00:00", timezone);
}

// ---------------------------------------------------------------------------
// Entry evaluation (shared by the register, bulk actions and the server)
// ---------------------------------------------------------------------------

export interface EntryContext {
  workDate: string;
  timezone: string;
  /** Policy in force on the work date: suggested IN, overnight. */
  dayPolicy: Pick<PolicyValues, "suggestedCheckIn" | "allowOvernight">;
  /** Policy in force on the site's today: future-time tolerances. */
  capturePolicy: Pick<PolicyValues, "inFutureToleranceMin" | "outFutureToleranceMin">;
  now: Date;
}

/** What the operator asked for, as site-local wall-clock times ("HH:mm"). */
export interface EntryInput {
  status: AttendanceStatus;
  checkIn: string | null;
  checkOut: string | null;
  checkInSource: CheckInSource | null;
}

/** What is stored now (null when nothing is recorded). */
export interface PreviousEntry {
  status: AttendanceStatus;
  checkInAt: string | null;
  checkOutAt: string | null;
  checkInSource: CheckInSource | null;
}

export type EntryVerdict =
  | {
      ok: true;
      checkInAt: string | null;
      checkOutAt: string | null;
      checkOutNextDay: boolean;
      checkInSource: CheckInSource | null;
    }
  | { ok: false; field: "in" | "out"; error: string };

const MAX_SHIFT_MS = 24 * 3_600_000;

const dstError = (field: "in" | "out", reason: "gap" | "fold"): EntryVerdict => ({
  ok: false,
  field,
  error:
    reason === "gap"
      ? `This ${field.toUpperCase()} time does not exist on this date (clocks go forward). Choose another time.`
      : `This ${field.toUpperCase()} time happens twice on this date (clocks go back). Choose another time.`,
});

/**
 * Validates one worker's entry and converts it to instants. A time whose wall-clock
 * value equals what is stored keeps the stored instant exactly; only edited times are
 * converted and re-checked, so tightening a policy never blocks unrelated corrections.
 */
export function evaluateEntry(ctx: EntryContext, entry: EntryInput, previous: PreviousEntry | null): EntryVerdict {
  if (entry.status !== "present") {
    return { ok: true, checkInAt: null, checkOutAt: null, checkOutNextDay: false, checkInSource: null };
  }
  if (!entry.checkIn) return { ok: false, field: "in", error: "IN time is required to mark present" };
  if (!isValidTime(entry.checkIn)) return { ok: false, field: "in", error: "IN time is not valid" };
  if (entry.checkOut !== null && !isValidTime(entry.checkOut)) return { ok: false, field: "out", error: "OUT time is not valid" };

  const tz = ctx.timezone;
  const prev = previous && previous.status === "present" ? previous : null;

  // IN
  const prevIn = prev?.checkInAt ? instantToLocal(prev.checkInAt, tz) : null;
  const inChanged = !(prevIn && prevIn.date === ctx.workDate && prevIn.time === entry.checkIn);
  let checkInAt: string;
  if (!inChanged) {
    checkInAt = prev!.checkInAt!;
  } else {
    const r = localToInstantStrict(ctx.workDate, entry.checkIn, tz);
    if (!r.ok) return dstError("in", r.reason);
    checkInAt = r.instant.toISOString();
  }

  // OUT: an untouched OUT keeps its stored instant (and so its date), whatever IN does.
  // A new OUT earlier than (or equal to) IN on the wall clock is the next day, if allowed.
  let checkOutAt: string | null = null;
  let checkOutNextDay = false;
  if (entry.checkOut !== null) {
    const prevOut = prev?.checkOutAt ? instantToLocal(prev.checkOutAt, tz) : null;
    if (prevOut && prevOut.time === entry.checkOut) {
      checkOutAt = prev!.checkOutAt!;
      checkOutNextDay = prevOut.date > ctx.workDate;
    } else {
      if (entry.checkOut <= entry.checkIn) {
        if (!ctx.dayPolicy.allowOvernight) return { ok: false, field: "out", error: "OUT time must be after IN time" };
        checkOutNextDay = true;
      }
      const r = localToInstantStrict(checkOutNextDay ? addDays(ctx.workDate, 1) : ctx.workDate, entry.checkOut, tz);
      if (!r.ok) return dstError("out", r.reason);
      checkOutAt = r.instant.toISOString();
    }
    const span = Date.parse(checkOutAt) - Date.parse(checkInAt);
    if (span <= 0) return { ok: false, field: "out", error: "OUT time must be after IN time" };
    if (span > MAX_SHIFT_MS) return { ok: false, field: "out", error: "A shift cannot be longer than 24 hours" };
  }
  const outChanged = checkOutAt !== (prev?.checkOutAt ?? null);

  const nowMs = ctx.now.getTime();
  if (inChanged && Date.parse(checkInAt) > nowMs + ctx.capturePolicy.inFutureToleranceMin * 60000) {
    return { ok: false, field: "in", error: "IN time is in the future" };
  }
  if (outChanged && checkOutAt && Date.parse(checkOutAt) > nowMs + ctx.capturePolicy.outFutureToleranceMin * 60000) {
    return { ok: false, field: "out", error: "OUT time cannot be in the future" };
  }

  let checkInSource: CheckInSource | null;
  if (!inChanged) {
    checkInSource = prev!.checkInSource; // IN untouched: keep how it was recorded (null for older records)
  } else {
    if (!entry.checkInSource) return { ok: false, field: "in", error: "Say whether the IN time was entered or the suggested time was accepted" };
    if (entry.checkInSource === "suggested" && ctx.dayPolicy.suggestedCheckIn !== entry.checkIn) {
      return { ok: false, field: "in", error: "IN time does not match the site's suggested time" };
    }
    checkInSource = entry.checkInSource;
  }
  return { ok: true, checkInAt, checkOutAt, checkOutNextDay, checkInSource };
}

// ---------------------------------------------------------------------------
// Labels (computed for display and reports; never stored, never affect pay)
// ---------------------------------------------------------------------------

export interface DayLabels {
  /** minutes after shift start (grace included), when beyond the grace period */
  lateMinutes: number | null;
  halfDay: boolean;
  /** minutes beyond the overtime threshold, when at least the minimum */
  overtimeMinutes: number | null;
  /** auto-absent (report-only): nothing recorded and the operator window has closed */
  notMarkedAbsent: boolean;
}

export const NO_LABELS: DayLabels = { lateMinutes: null, halfDay: false, overtimeMinutes: null, notMarkedAbsent: false };

/**
 * Labels for one worker-day. `dayPolicy` is the policy in force on the work date;
 * `operatorWindowClosed` comes from the authoritative edit window (today's policy).
 */
export function dayLabels(
  dayPolicy: PolicyValues,
  record: AttendanceSnapshot | null,
  workDate: string,
  timezone: string,
  operatorWindowClosed: boolean,
): DayLabels {
  if (!record || record.status === "pending") {
    return { ...NO_LABELS, notMarkedAbsent: dayPolicy.autoAbsentEnabled && operatorWindowClosed };
  }
  if (record.status !== "present" || !record.checkInAt) return NO_LABELS;

  let lateMinutes: number | null = null;
  if (dayPolicy.shiftStart && dayPolicy.lateGraceMin !== null) {
    const start = localToInstantPg(workDate, dayPolicy.shiftStart, timezone).toISOString();
    const after = minutesBetween(start, record.checkInAt);
    if (after > dayPolicy.lateGraceMin) lateMinutes = after;
  }

  let halfDay = false;
  let overtimeMinutes: number | null = null;
  if (record.checkOutAt) {
    const worked = minutesBetween(record.checkInAt, record.checkOutAt);
    if (dayPolicy.halfDayBelowHours !== null && worked < Math.round(dayPolicy.halfDayBelowHours * 60)) halfDay = true;
    if (dayPolicy.overtimeAfterHours !== null) {
      const excess = worked - Math.round(dayPolicy.overtimeAfterHours * 60);
      if (excess > 0 && excess >= (dayPolicy.overtimeMinMinutes ?? 0)) overtimeMinutes = excess;
    }
  }
  return { lateMinutes, halfDay, overtimeMinutes, notMarkedAbsent: false };
}

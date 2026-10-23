import type { AttendanceSnapshot, OvertimeRounding, PaymentRule, Shift, WorkerPayTerms } from "./types";
import { minutesBetween } from "./time";

// Payment rules engine. Pure functions only — kept separate from attendance capture.
// It produces *estimated* contractor payables, never disbursed amounts.
//
// Nothing is assumed: when a setting the calculation needs is missing (an overtime
// rate, a worker's rate basis, a monthly divisor...), the day is "needs_configuration"
// and lists what is missing, instead of showing a number that could be wrong.

export type AmountState =
  /** amount is a real computed figure */
  | "ok"
  /** no payment rule applies to this contractor/date */
  | "not_configured"
  /** a rule applies but a setting it needs is missing; see `missing` */
  | "needs_configuration"
  /** worker is present but OUT is not recorded yet; nothing is assumed */
  | "incomplete"
  /** pending confirmation; not counted at all */
  | "not_applicable";

export interface DayCalculation {
  status: AttendanceSnapshot["status"];
  shift: Shift;
  /** present with both IN and OUT */
  complete: boolean;
  /** present but OUT missing */
  incomplete: boolean;
  grossMinutes: number | null;
  breakMinutes: number;
  netMinutes: number | null;
  /** net working hours rounded to 2 decimals — the value shown and exported per row */
  netHours: number | null;
  /** worked minutes beyond the overtime threshold (before rounding) */
  overtimeMinutes: number;
  /** overtime minutes that are paid (after the minimum and rounding) */
  overtimePaidMinutes: number;
  unit: "day" | "hour" | null;
  /** days (day rates) or net hours including overtime (hour rates) */
  payableUnits: number | null;
  /** pay for the standard units */
  baseAmount: number | null;
  /** pay for paid overtime */
  overtimeAmount: number | null;
  /** base + overtime (commission is worked out per worker per period, not per day) */
  amount: number | null;
  amountState: AmountState;
  /** settings that must be configured before an amount can be shown */
  missing: string[];
  ruleId: string | null;
  ruleVersion: number | null;
  termsId: string | null;
  termsVersion: number | null;
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Picks the rule version in force on `workDate` (latest effectiveFrom <= workDate). */
export function ruleForDate(rules: PaymentRule[], contractorId: string, workDate: string): PaymentRule | null {
  let best: PaymentRule | null = null;
  for (const r of rules) {
    if (r.contractorId !== contractorId || r.effectiveFrom > workDate) continue;
    if (!best || r.effectiveFrom > best.effectiveFrom || (r.effectiveFrom === best.effectiveFrom && r.version > best.version)) best = r;
  }
  return best;
}

/** A worker's pay terms in force on `workDate`. */
export function termsForDate(terms: WorkerPayTerms[], workerId: string, workDate: string): WorkerPayTerms | null {
  let best: WorkerPayTerms | null = null;
  for (const t of terms) {
    if (t.workerId !== workerId || t.effectiveFrom > workDate) continue;
    if (!best || t.effectiveFrom > best.effectiveFrom || (t.effectiveFrom === best.effectiveFrom && t.version > best.version)) best = t;
  }
  return best;
}

/**
 * The settings that reproduce how rules created before these settings existed were
 * calculated (contractor rate, full/half-day thresholds, fixed overtime rate, no
 * rounding, no commission). Used for stored legacy rule versions only.
 */
export function legacyRuleSettings(
  r: Pick<PaymentRule, "rateType" | "fullDayHours" | "overtimeEnabled">,
): Omit<PaymentRule, "id" | "contractorId" | "version" | "effectiveFrom" | "rateType" | "dayRate" | "hourRate" | "fullDayHours" | "halfDayHours" | "overtimeEnabled" | "overtimeAfterHours" | "overtimeHourRate" | "unpaidBreakMinutes" | "notes" | "createdAt" | "createdBy"> {
  return {
    rateSource: "contractor",
    shortDayPolicy: r.rateType === "per_day" ? (r.fullDayHours === null ? "full_day" : "half_day") : "pro_rata",
    monthlyDivisorDays: null,
    overtimeAfterNightHours: null,
    overtimeRateMode: r.overtimeEnabled ? "per_hour" : null,
    overtimeMultiplier: null,
    overtimeRounding: "exact",
    overtimeMinMinutes: 0,
    commissionEnabled: false,
    commissionPercent: null,
    commissionScope: null,
    commissionBase: null,
    commissionTreatment: null,
  };
}

export function roundOvertime(minutes: number, rounding: OvertimeRounding): number {
  if (minutes <= 0) return 0;
  switch (rounding) {
    case "exact":
      return minutes;
    case "floor_15":
      return Math.floor(minutes / 15) * 15;
    case "floor_30":
      return Math.floor(minutes / 30) * 30;
    case "floor_60":
      return Math.floor(minutes / 60) * 60;
    case "nearest_15":
      return Math.round(minutes / 15) * 15;
    case "nearest_30":
      return Math.round(minutes / 30) * 30;
  }
}

/** The overtime threshold for a shift, in hours (null = no overtime). */
export function overtimeThresholdHours(rule: PaymentRule, shift: Shift): number | null {
  if (!rule.overtimeEnabled) return null;
  return shift === "night" ? rule.overtimeAfterNightHours ?? rule.overtimeAfterHours : rule.overtimeAfterHours;
}

interface Rate {
  unit: "day" | "hour";
  /** rupees per unit */
  amount: number;
}

/** The rate a worker is paid at under `rule`, or what is missing to know it. */
export function resolveRate(rule: PaymentRule, terms: WorkerPayTerms | null): { rate: Rate | null; missing: string[] } {
  if (rule.rateSource === "contractor") {
    if (rule.rateType === "per_day") return rule.dayRate === null ? { rate: null, missing: ["Day rate"] } : { rate: { unit: "day", amount: rule.dayRate }, missing: [] };
    return rule.hourRate === null ? { rate: null, missing: ["Hour rate"] } : { rate: { unit: "hour", amount: rule.hourRate }, missing: [] };
  }
  if (!terms || terms.rateAmount === null) return { rate: null, missing: ["Worker's rate"] };
  switch (terms.rateBasis) {
    case "daily":
      return { rate: { unit: "day", amount: terms.rateAmount }, missing: [] };
    case "hourly":
      return { rate: { unit: "hour", amount: terms.rateAmount }, missing: [] };
    case "monthly":
      return rule.monthlyDivisorDays === null
        ? { rate: null, missing: ["Days per month for monthly salaries"] }
        : { rate: { unit: "day", amount: terms.rateAmount / rule.monthlyDivisorDays }, missing: [] };
    case "unconfirmed":
      return { rate: null, missing: ["Worker's rate basis (requires verification: monthly, daily or hourly?)"] };
  }
}

const EMPTY: Omit<DayCalculation, "status" | "shift"> = {
  complete: false,
  incomplete: false,
  grossMinutes: null,
  breakMinutes: 0,
  netMinutes: null,
  netHours: null,
  overtimeMinutes: 0,
  overtimePaidMinutes: 0,
  unit: null,
  payableUnits: null,
  baseAmount: null,
  overtimeAmount: null,
  amount: null,
  amountState: "not_applicable",
  missing: [],
  ruleId: null,
  ruleVersion: null,
  termsId: null,
  termsVersion: null,
};

/**
 * One worker-day. `terms` (the worker's pay terms in force that day) is only used
 * by rules whose rate comes from each worker.
 */
export function calculateDay(record: (AttendanceSnapshot & { shift?: Shift }) | null, rule: PaymentRule | null, terms: WorkerPayTerms | null = null): DayCalculation {
  const shift: Shift = record?.shift ?? "day";
  const refs = { ruleId: rule?.id ?? null, ruleVersion: rule?.version ?? null, termsId: rule?.rateSource === "worker" ? terms?.id ?? null : null, termsVersion: rule?.rateSource === "worker" ? terms?.version ?? null : null };
  const resolved = rule ? resolveRate(rule, terms) : null;
  const unit = resolved?.rate?.unit ?? (rule?.rateSource === "contractor" ? (rule.rateType === "per_day" ? "day" : "hour") : null);

  if (!record || record.status === "pending") return { ...EMPTY, shift, status: "pending" };

  if (record.status === "absent") {
    return {
      ...EMPTY,
      ...refs,
      shift,
      status: "absent",
      grossMinutes: 0,
      netMinutes: 0,
      netHours: 0,
      unit,
      payableUnits: rule ? 0 : null,
      baseAmount: rule ? 0 : null,
      overtimeAmount: rule ? 0 : null,
      amount: rule ? 0 : null,
      amountState: rule ? "ok" : "not_configured",
    };
  }

  // Present without OUT: no hours and no pay are assumed.
  if (!record.checkInAt || !record.checkOutAt) {
    return { ...EMPTY, ...refs, shift, status: "present", incomplete: true, unit, amountState: "incomplete" };
  }

  const gross = Math.max(0, minutesBetween(record.checkInAt, record.checkOutAt));
  const breakMinutes = Math.min(gross, rule?.unpaidBreakMinutes ?? 0);
  const net = gross - breakMinutes;
  const base = { ...EMPTY, ...refs, shift, status: "present" as const, complete: true, grossMinutes: gross, breakMinutes, netMinutes: net, netHours: round2(net / 60) };
  if (!rule) return { ...base, amountState: "not_configured" };

  const missing = [...(resolved?.missing ?? [])];
  const rate = resolved?.rate ?? null;

  // Overtime minutes (independent of the rate).
  const threshold = overtimeThresholdHours(rule, shift);
  if (rule.overtimeEnabled && threshold === null) missing.push(shift === "night" ? "Night overtime threshold" : "Overtime threshold");
  const overtimeMinutes = threshold !== null && net > threshold * 60 ? net - threshold * 60 : 0;
  let overtimePaidMinutes = 0;
  if (overtimeMinutes > 0) {
    if (overtimeMinutes < rule.overtimeMinMinutes) overtimePaidMinutes = 0;
    else if (rule.overtimeRounding === null) missing.push("Overtime rounding");
    else overtimePaidMinutes = roundOvertime(overtimeMinutes, rule.overtimeRounding);
  }

  // Standard units and base pay.
  let payableUnits: number | null = null;
  // Unrounded until the end, so the total is rounded once.
  let rawBase: number | null = null;
  const standard = rule.fullDayHours;
  if (rate?.unit === "day" || (!rate && unit === "day")) {
    if (standard === null) {
      if (rule.shortDayPolicy === "full_day") payableUnits = 1; // legacy: any complete day is a day
      else missing.push("Standard working hours");
    } else if (net >= standard * 60) payableUnits = 1;
    else if (rule.shortDayPolicy === "full_day") payableUnits = 1;
    else if (rule.shortDayPolicy === "half_day") payableUnits = rule.halfDayHours !== null && net >= rule.halfDayHours * 60 ? 0.5 : 0;
    else if (rule.shortDayPolicy === "pro_rata") payableUnits = round2(net / (standard * 60));
    else missing.push("How short days are paid");
    if (rate && payableUnits !== null) rawBase = payableUnits * rate.amount;
  } else if (rate?.unit === "hour" || (!rate && unit === "hour")) {
    // Payable hours are all net hours; the overtime part is paid at the overtime rate below.
    payableUnits = round2(net / 60);
    if (rate) rawBase = ((net - overtimeMinutes) / 60) * rate.amount;
  }

  // Overtime pay.
  let rawOvertime: number | null = 0;
  if (overtimePaidMinutes > 0) {
    if (rule.overtimeRateMode === "per_hour") {
      if (rule.overtimeHourRate === null) missing.push("Overtime rate per hour");
      else rawOvertime = (overtimePaidMinutes / 60) * rule.overtimeHourRate;
    } else if (rule.overtimeRateMode === "multiplier") {
      if (rule.overtimeMultiplier === null) missing.push("Overtime multiplier");
      else if (rate?.unit === "hour") rawOvertime = (overtimePaidMinutes / 60) * rate.amount * rule.overtimeMultiplier;
      else if (rate?.unit === "day") {
        if (standard === null) missing.push("Standard working hours");
        else rawOvertime = (overtimePaidMinutes / 60) * (rate.amount / standard) * rule.overtimeMultiplier;
      }
    } else missing.push("Overtime pay rate");
    if (missing.length > 0) rawOvertime = null;
  }

  const uniq = [...new Set(missing)];
  if (uniq.length > 0) {
    return { ...base, overtimeMinutes, overtimePaidMinutes, unit, payableUnits, baseAmount: rate && rawBase !== null ? round2(rawBase) : null, overtimeAmount: null, amount: null, amountState: "needs_configuration", missing: uniq };
  }
  // The total is rounded once (as rules always were); overtime is the remainder, so the parts add up.
  const amount = round2((rawBase ?? 0) + (rawOvertime ?? 0));
  const baseRounded = round2(rawBase ?? 0);
  return {
    ...base,
    overtimeMinutes,
    overtimePaidMinutes,
    unit,
    payableUnits,
    baseAmount: baseRounded,
    overtimeAmount: round2(amount - baseRounded),
    amount,
    amountState: "ok",
    missing: [],
  };
}

/** Whether `rule`'s commission applies to a worker with these pay terms. */
export function commissionApplies(rule: PaymentRule, terms: WorkerPayTerms | null): boolean {
  if (!rule.commissionEnabled) return false;
  if (rule.commissionScope === "all") return true;
  if (rule.commissionScope === "selected") return terms?.commissionEligible === true;
  return false;
}

/** What still has to be set before commission can be calculated (empty when ready or disabled). */
export function commissionMissing(rule: PaymentRule): string[] {
  if (!rule.commissionEnabled) return [];
  const m: string[] = [];
  if (rule.commissionPercent === null) m.push("Commission percentage");
  if (rule.commissionScope === null) m.push("Who commission applies to");
  if (rule.commissionBase === null) m.push("What commission is calculated on");
  if (rule.commissionTreatment === null) m.push("Whether commission is added to or taken from wages");
  return m;
}

const inr = (n: number | null) => (n === null ? "—" : `₹${n.toLocaleString("en-IN")}`);

export const OT_ROUNDING_LABEL: Record<OvertimeRounding, string> = {
  exact: "to the minute",
  floor_15: "down to 15 min",
  floor_30: "down to 30 min",
  floor_60: "down to the hour",
  nearest_15: "to the nearest 15 min",
  nearest_30: "to the nearest 30 min",
};

export function describeRule(rule: PaymentRule | null): string {
  if (!rule) return "Not configured";
  const parts: string[] = [];
  if (rule.rateSource === "worker") parts.push("Each worker's own rate");
  else if (rule.rateType === "per_day") parts.push(`${inr(rule.dayRate)} per day`);
  else parts.push(`${inr(rule.hourRate)} per hour`);
  if (rule.fullDayHours !== null) parts.push(`${rule.fullDayHours}h standard`);
  if (rule.unpaidBreakMinutes > 0) parts.push(`${rule.unpaidBreakMinutes} min unpaid break`);
  if (rule.overtimeEnabled) {
    const day = rule.overtimeAfterHours;
    const night = rule.overtimeAfterNightHours ?? day;
    const after = day === night ? `after ${day ?? "?"}h` : `after ${day ?? "?"}h day / ${night ?? "?"}h night`;
    const rate =
      rule.overtimeRateMode === "per_hour" ? `at ${inr(rule.overtimeHourRate)}/h` : rule.overtimeRateMode === "multiplier" ? `at ${rule.overtimeMultiplier ?? "?"}× hourly` : "rate not set";
    parts.push(`OT ${after} ${rate}`);
  }
  if (rule.commissionEnabled) parts.push(`Commission ${rule.commissionPercent ?? "?"}%${rule.commissionScope === "selected" ? " (selected workers)" : ""}`);
  return parts.join(" · ");
}

/** Everything about `rule` that must still be set; shown on the contractor's rule card. */
export function ruleGaps(rule: PaymentRule): string[] {
  const m: string[] = [];
  if (rule.rateSource === "contractor" && rule.rateType === "per_day" && rule.dayRate === null) m.push("Day rate");
  if (rule.rateSource === "contractor" && rule.rateType === "per_hour" && rule.hourRate === null) m.push("Hour rate");
  if (rule.fullDayHours === null && rule.shortDayPolicy !== "full_day") m.push("Standard working hours");
  if ((rule.rateSource === "worker" || rule.rateType === "per_day") && rule.shortDayPolicy === null) m.push("How short days are paid");
  if (rule.overtimeEnabled) {
    if (rule.overtimeAfterHours === null) m.push("Overtime threshold");
    if (rule.overtimeRateMode === null) m.push("Overtime pay rate");
    if (rule.overtimeRateMode === "per_hour" && rule.overtimeHourRate === null) m.push("Overtime rate per hour");
    if (rule.overtimeRateMode === "multiplier" && rule.overtimeMultiplier === null) m.push("Overtime multiplier");
    if (rule.overtimeRounding === null) m.push("Overtime rounding");
  }
  return [...m, ...commissionMissing(rule)];
}

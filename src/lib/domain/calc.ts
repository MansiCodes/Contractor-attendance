import type { AttendanceSnapshot, PaymentRule } from "./types";
import { minutesBetween } from "./time";

// Payment rules engine. Pure functions only — kept separate from attendance capture.
// It produces *estimated* contractor payables, never disbursed amounts.

export type AmountState =
  /** amount is a real computed figure */
  | "ok"
  /** no payment rule applies to this contractor/date */
  | "not_configured"
  /** worker is present but OUT is not recorded yet; nothing is assumed */
  | "incomplete"
  /** pending confirmation; not counted at all */
  | "not_applicable";

export interface DayCalculation {
  status: AttendanceSnapshot["status"];
  /** present with both IN and OUT */
  complete: boolean;
  /** present but OUT missing */
  incomplete: boolean;
  grossMinutes: number | null;
  breakMinutes: number;
  netMinutes: number | null;
  /** net working hours rounded to 2 decimals — the value shown and exported per row */
  netHours: number | null;
  overtimeMinutes: number;
  unit: "day" | "hour" | null;
  payableUnits: number | null;
  amount: number | null;
  amountState: AmountState;
  ruleId: string | null;
  ruleVersion: number | null;
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Picks the rule version in force on `workDate` (latest effectiveFrom <= workDate). */
export function ruleForDate(rules: PaymentRule[], contractorId: string, workDate: string): PaymentRule | null {
  let best: PaymentRule | null = null;
  for (const r of rules) {
    if (r.contractorId !== contractorId || r.effectiveFrom > workDate) continue;
    if (
      !best ||
      r.effectiveFrom > best.effectiveFrom ||
      (r.effectiveFrom === best.effectiveFrom && r.version > best.version)
    ) {
      best = r;
    }
  }
  return best;
}

const EMPTY: Omit<DayCalculation, "status"> = {
  complete: false,
  incomplete: false,
  grossMinutes: null,
  breakMinutes: 0,
  netMinutes: null,
  netHours: null,
  overtimeMinutes: 0,
  unit: null,
  payableUnits: null,
  amount: null,
  amountState: "not_applicable",
  ruleId: null,
  ruleVersion: null,
};

export function calculateDay(record: AttendanceSnapshot | null, rule: PaymentRule | null): DayCalculation {
  const ruleRef = { ruleId: rule?.id ?? null, ruleVersion: rule?.version ?? null };
  const unit = rule ? (rule.rateType === "per_day" ? "day" : "hour") : null;

  if (!record || record.status === "pending") {
    return { ...EMPTY, status: "pending" };
  }

  if (record.status === "absent") {
    return {
      ...EMPTY,
      ...ruleRef,
      status: "absent",
      grossMinutes: 0,
      netMinutes: 0,
      netHours: 0,
      unit,
      payableUnits: rule ? 0 : null,
      amount: rule ? 0 : null,
      amountState: rule ? "ok" : "not_configured",
    };
  }

  // Present.
  if (!record.checkInAt || !record.checkOutAt) {
    return { ...EMPTY, ...ruleRef, status: "present", incomplete: true, unit, amountState: "incomplete" };
  }

  const gross = Math.max(0, minutesBetween(record.checkInAt, record.checkOutAt));
  const breakMinutes = Math.min(gross, rule?.unpaidBreakMinutes ?? 0);
  const net = gross - breakMinutes;
  const base = { ...EMPTY, ...ruleRef, status: "present" as const, complete: true, grossMinutes: gross, breakMinutes, netMinutes: net, netHours: round2(net / 60) };

  if (!rule) return { ...base, amountState: "not_configured" };

  const otThreshold =
    rule.overtimeEnabled && rule.overtimeAfterHours !== null ? rule.overtimeAfterHours * 60 : null;
  const overtimeMinutes = otThreshold !== null && net > otThreshold ? net - otThreshold : 0;
  const otAmount = overtimeMinutes > 0 ? (overtimeMinutes / 60) * (rule.overtimeHourRate ?? 0) : 0;

  if (rule.rateType === "per_day") {
    let units: number;
    if (rule.fullDayHours === null) units = 1;
    else if (net >= rule.fullDayHours * 60) units = 1;
    else if (rule.halfDayHours !== null && net >= rule.halfDayHours * 60) units = 0.5;
    else units = 0;
    const amount = round2(units * (rule.dayRate ?? 0) + otAmount);
    return { ...base, overtimeMinutes, unit: "day", payableUnits: units, amount, amountState: "ok" };
  }

  // per_hour: regular hours at hour rate, overtime hours (if enabled) at overtime rate.
  const regularMinutes = net - overtimeMinutes;
  const amount = round2((regularMinutes / 60) * (rule.hourRate ?? 0) + otAmount);
  return { ...base, overtimeMinutes, unit: "hour", payableUnits: round2(net / 60), amount, amountState: "ok" };
}

export function describeRule(rule: PaymentRule | null): string {
  if (!rule) return "Not configured";
  const inr = (n: number | null) => (n === null ? "—" : `₹${n.toLocaleString("en-IN")}`);
  const parts: string[] = [];
  if (rule.rateType === "per_day") {
    parts.push(`${inr(rule.dayRate)} per day`);
    if (rule.fullDayHours !== null) parts.push(`full day ≥ ${rule.fullDayHours}h`);
    if (rule.halfDayHours !== null) parts.push(`half day ≥ ${rule.halfDayHours}h`);
  } else {
    parts.push(`${inr(rule.hourRate)} per hour`);
  }
  if (rule.unpaidBreakMinutes > 0) parts.push(`${rule.unpaidBreakMinutes} min unpaid break`);
  if (rule.overtimeEnabled) parts.push(`OT after ${rule.overtimeAfterHours}h at ${inr(rule.overtimeHourRate)}/h`);
  return parts.join(" · ");
}

import { commissionApplies, commissionMissing, round2, ruleForDate, termsForDate } from "./calc";
import type { Report, ReportRow } from "./report";
import type { CommissionTreatment, PaymentRule, RateBasis, WorkerPayTerms } from "./types";

// Contractor-wise payroll estimate for a period, built from the same report rows
// as every other screen. Commission is worked out per worker from each day's rule.
//
// A figure is only shown when every day that contributes to it could be priced.
// Otherwise it is null and `missing` says what has to be configured; days without
// a checkout are left out and counted, never guessed.

export interface PayrollFigures {
  /** worker-days marked present */
  presentDays: number;
  absentDays: number;
  /** not confirmed yet: never counted */
  pendingDays: number;
  /** present without OUT: excluded from hours and pay */
  missingCheckoutDays: number;
  /** net hours of complete days */
  confirmedHours: number;
  /** day-rated units (1 = a full day) */
  standardDays: number;
  /** hour-rated hours */
  standardHours: number;
  /** paid overtime hours (after minimum and rounding) */
  overtimeHours: number;
  baseWages: number | null;
  overtimeWages: number | null;
  commission: number | null;
  /** wages + commission added on top (commission taken from wages is not added) */
  totalPayable: number | null;
  /** wages less commission taken out of them, when that applies */
  workerNet: number | null;
  /** days whose amount needs a missing setting */
  needsConfigDays: number;
  /** days with no payment rule */
  noRuleDays: number;
  /** settings to configure before the totals can be shown */
  missing: string[];
}

export interface WorkerPayroll extends PayrollFigures {
  workerId: string;
  workerName: string;
  workerCode: string;
  employeeCode: string | null;
  contractorId: string;
  /** e.g. "₹480 / day" or "₹26,520 · Requires verification" */
  rateLabel: string;
  commissionApplies: boolean;
  ruleVersions: number[];
}

export interface ContractorPayroll extends PayrollFigures {
  contractorId: string;
  contractorName: string;
  workers: number;
  workerRows: WorkerPayroll[];
  commissionTreatment: CommissionTreatment | null;
}

export interface Payroll {
  from: string;
  to: string;
  contractors: ContractorPayroll[];
  totals: PayrollFigures;
}

const empty = (): PayrollFigures => ({
  presentDays: 0,
  absentDays: 0,
  pendingDays: 0,
  missingCheckoutDays: 0,
  confirmedHours: 0,
  standardDays: 0,
  standardHours: 0,
  overtimeHours: 0,
  baseWages: 0,
  overtimeWages: 0,
  commission: 0,
  totalPayable: 0,
  workerNet: 0,
  needsConfigDays: 0,
  noRuleDays: 0,
  missing: [],
});

const add = (a: number | null, b: number | null) => (a === null || b === null ? null : a + b);

function addFigures(into: PayrollFigures, f: PayrollFigures) {
  into.presentDays += f.presentDays;
  into.absentDays += f.absentDays;
  into.pendingDays += f.pendingDays;
  into.missingCheckoutDays += f.missingCheckoutDays;
  into.confirmedHours += f.confirmedHours;
  into.standardDays += f.standardDays;
  into.standardHours += f.standardHours;
  into.overtimeHours += f.overtimeHours;
  into.baseWages = add(into.baseWages, f.baseWages);
  into.overtimeWages = add(into.overtimeWages, f.overtimeWages);
  into.commission = add(into.commission, f.commission);
  into.totalPayable = add(into.totalPayable, f.totalPayable);
  into.workerNet = add(into.workerNet, f.workerNet);
  into.needsConfigDays += f.needsConfigDays;
  into.noRuleDays += f.noRuleDays;
  for (const m of f.missing) if (!into.missing.includes(m)) into.missing.push(m);
}

function rounded(f: PayrollFigures): PayrollFigures {
  const r = (n: number | null) => (n === null ? null : round2(n));
  return {
    ...f,
    confirmedHours: round2(f.confirmedHours),
    standardDays: round2(f.standardDays),
    standardHours: round2(f.standardHours),
    overtimeHours: round2(f.overtimeHours),
    baseWages: r(f.baseWages),
    overtimeWages: r(f.overtimeWages),
    commission: r(f.commission),
    totalPayable: r(f.totalPayable),
    workerNet: r(f.workerNet),
  };
}

const inr = (n: number) => `₹${n.toLocaleString("en-IN")}`;
const BASIS: Record<RateBasis, string> = { daily: "day", hourly: "hour", monthly: "month", unconfirmed: "Requires verification" };

function rateLabel(rule: PaymentRule | null, terms: WorkerPayTerms | null): string {
  if (!rule) return "No payment rule";
  if (rule.rateSource === "contractor") {
    return rule.rateType === "per_day" ? `${rule.dayRate === null ? "—" : inr(rule.dayRate)} / day` : `${rule.hourRate === null ? "—" : inr(rule.hourRate)} / hour`;
  }
  if (!terms || terms.rateAmount === null) return "Rate not recorded";
  return terms.rateBasis === "unconfirmed" ? `${inr(terms.rateAmount)} · ${BASIS.unconfirmed}` : `${inr(terms.rateAmount)} / ${BASIS[terms.rateBasis]}`;
}

/** One worker-day's contribution. */
function dayFigures(row: ReportRow, rule: PaymentRule | null, terms: WorkerPayTerms | null): PayrollFigures {
  const f = empty();
  const c = row.calc;
  if (row.status === "pending") {
    f.pendingDays = 1;
    return f;
  }
  if (row.status === "absent") {
    f.absentDays = 1;
    if (!rule) {
      f.noRuleDays = 1;
      f.missing.push("Payment rule");
      f.baseWages = f.overtimeWages = f.commission = f.totalPayable = f.workerNet = null;
    }
    return f;
  }
  f.presentDays = 1;
  if (c.incomplete) {
    f.missingCheckoutDays = 1;
    return f; // nothing assumed: no hours, no pay
  }
  f.confirmedHours = c.netHours ?? 0;
  if (c.unit === "day" && c.payableUnits !== null) f.standardDays = c.payableUnits;
  if (c.unit === "hour" && c.payableUnits !== null) f.standardHours = c.payableUnits - c.overtimeMinutes / 60;
  f.overtimeHours = c.overtimePaidMinutes / 60;
  if (c.amountState === "not_configured") {
    f.noRuleDays = 1;
    f.missing.push("Payment rule");
    f.baseWages = f.overtimeWages = f.commission = f.totalPayable = f.workerNet = null;
    return f;
  }
  if (c.amountState === "needs_configuration") {
    f.needsConfigDays = 1;
    f.missing.push(...c.missing);
    f.baseWages = f.overtimeWages = f.commission = f.totalPayable = f.workerNet = null;
    return f;
  }
  const base = c.baseAmount ?? 0;
  const ot = c.overtimeAmount ?? 0;
  f.baseWages = base;
  f.overtimeWages = ot;
  let commission: number | null = 0;
  if (rule?.commissionEnabled) {
    const cm = commissionMissing(rule);
    // Without knowing who it applies to, nobody's commission can be taken as zero.
    if (rule.commissionScope === null || (commissionApplies(rule, terms) && cm.length > 0)) {
      commission = null;
      f.missing.push(...cm);
    } else if (commissionApplies(rule, terms)) {
      commission = ((rule.commissionPercent ?? 0) / 100) * (rule.commissionBase === "gross_wages" ? base + ot : base);
    }
  }
  f.commission = commission;
  const wages = base + ot;
  if (commission === null) {
    f.totalPayable = f.workerNet = null;
  } else {
    f.totalPayable = wages + (rule?.commissionTreatment === "added_to_contractor_payable" ? commission : 0);
    f.workerNet = wages - (rule?.commissionTreatment === "deducted_from_wages" ? commission : 0);
  }
  return f;
}

export function buildPayroll(report: Report, rules: PaymentRule[], payTerms: WorkerPayTerms[]): Payroll {
  const byContractor = new Map<string, { name: string; workers: Map<string, { row: ReportRow; figures: PayrollFigures; versions: Set<number>; applies: boolean }> }>();
  for (const row of report.rows) {
    const rule = ruleForDate(rules, row.contractorId, row.workDate);
    const terms = termsForDate(payTerms, row.workerId, row.workDate);
    let c = byContractor.get(row.contractorId);
    if (!c) byContractor.set(row.contractorId, (c = { name: row.contractorName, workers: new Map() }));
    let w = c.workers.get(row.workerId);
    if (!w) c.workers.set(row.workerId, (w = { row, figures: empty(), versions: new Set(), applies: false }));
    addFigures(w.figures, dayFigures(row, rule, terms));
    if (rule && row.status === "present") {
      w.versions.add(rule.version);
      if (commissionApplies(rule, terms)) w.applies = true;
    }
  }

  const contractors: ContractorPayroll[] = [];
  const grand = empty();
  for (const [contractorId, c] of byContractor) {
    const totals = empty();
    const workerRows: WorkerPayroll[] = [];
    for (const [workerId, w] of c.workers) {
      addFigures(totals, w.figures);
      const latestRule = ruleForDate(rules, contractorId, report.to);
      workerRows.push({
        ...rounded(w.figures),
        workerId,
        workerName: w.row.workerName,
        workerCode: w.row.workerCode,
        employeeCode: w.row.employeeCode,
        contractorId,
        rateLabel: rateLabel(latestRule, termsForDate(payTerms, workerId, report.to)),
        commissionApplies: w.applies,
        ruleVersions: [...w.versions].sort((a, b) => a - b),
      });
    }
    workerRows.sort((a, b) => a.workerName.localeCompare(b.workerName, "en-IN"));
    addFigures(grand, totals);
    contractors.push({
      ...rounded(totals),
      contractorId,
      contractorName: c.name,
      workers: workerRows.filter((w) => w.presentDays + w.absentDays > 0).length,
      workerRows,
      commissionTreatment: ruleForDate(rules, contractorId, report.to)?.commissionTreatment ?? null,
    });
  }
  contractors.sort((a, b) => a.contractorName.localeCompare(b.contractorName));
  return { from: report.from, to: report.to, contractors, totals: rounded(grand) };
}

/** Whether a figure set is a complete total (nothing missing, no day left out for a missing OUT). */
export function payrollComplete(f: PayrollFigures): boolean {
  return f.totalPayable !== null && f.missing.length === 0 && f.missingCheckoutDays === 0;
}

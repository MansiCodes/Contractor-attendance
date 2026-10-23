import { describe, expect, it } from "vitest";
import { calculateDay, ruleGaps } from "@/lib/domain/calc";
import { buildPayroll, payrollComplete } from "@/lib/domain/payroll";
import { buildReport } from "@/lib/domain/report";
import { localToInstant } from "@/lib/domain/time";
import type { AttendanceRecord, Contractor, PaymentRule, Project, Shift, Worker, WorkerAssignment, WorkerPayTerms } from "@/lib/domain/types";

// The four contractors' rules as stated by the business (working hours, overtime
// thresholds, commission), with fictional workers. Settings the business has not
// stated (overtime pay rate, rounding, commission base and treatment, Shukla's
// rate basis, monthly divisor, short days) are left empty unless a test sets them.

const TZ = "Asia/Kolkata";
const at = (date: string, time: string) => localToInstant(date, time, TZ).toISOString();
const D = "2026-09-15";
const NEXT = "2026-09-16";

const rule = (contractorId: string, r: Partial<PaymentRule>): PaymentRule => ({
  id: `r-${contractorId}`, contractorId, version: 1, effectiveFrom: "2026-09-01", rateSource: "worker", rateType: "per_day", dayRate: null, hourRate: null,
  fullDayHours: 8, halfDayHours: null, shortDayPolicy: null, monthlyDivisorDays: null, overtimeEnabled: true, overtimeAfterHours: 8,
  overtimeAfterNightHours: null, overtimeRateMode: null, overtimeHourRate: null, overtimeMultiplier: null, overtimeRounding: null, overtimeMinMinutes: 0,
  unpaidBreakMinutes: 0, commissionEnabled: false, commissionPercent: null, commissionScope: null, commissionBase: null, commissionTreatment: null,
  notes: null, createdAt: "2026-09-01T00:00:00Z", createdBy: null, ...r,
});

const RULES = {
  shukla: rule("shukla", { overtimeAfterHours: 8, commissionEnabled: true, commissionPercent: 8, commissionScope: "all" }),
  sumit: rule("sumit", { overtimeAfterHours: 8, commissionEnabled: true, commissionPercent: 7.5, commissionScope: "selected" }),
  excellent: rule("excellent", { overtimeAfterHours: 8.5, overtimeAfterNightHours: 8 }),
  optimum: rule("optimum", { overtimeAfterHours: 8.5, overtimeAfterNightHours: 8, commissionEnabled: true, commissionPercent: 7.5, commissionScope: "all" }),
};

const terms = (workerId: string, rateAmount: number | null, rateBasis: WorkerPayTerms["rateBasis"], commissionEligible: boolean | null = null): WorkerPayTerms => ({
  id: `t-${workerId}`, workerId, version: 1, effectiveFrom: "2026-09-01", rateAmount, rateBasis, commissionEligible, source: null, notes: null, createdAt: "", createdBy: null,
});

const day = (inT: string, outT: string | null, shift: Shift = "day", outDate = D) => ({
  status: "present" as const, checkInAt: at(D, inT), checkOutAt: outT ? at(outDate, outT) : null, checkInSource: "entered" as const, shift,
});

/** Fully decided settings, for tests that need complete amounts. */
const decided: Partial<PaymentRule> = { shortDayPolicy: "pro_rata", overtimeRateMode: "multiplier", overtimeMultiplier: 2, overtimeRounding: "floor_30", commissionBase: "base_wages", commissionTreatment: "added_to_contractor_payable" };

describe("Daily vs salary rates", () => {
  it("pays a daily rate per day and keeps worker-specific rates", () => {
    const a = calculateDay(day("08:00", "16:00"), { ...RULES.excellent, ...decided }, terms("w1", 480, "daily"));
    const b = calculateDay(day("08:00", "16:00"), { ...RULES.excellent, ...decided }, terms("w2", 520, "daily"));
    expect([a.amount, b.amount]).toEqual([480, 520]);
  });

  it("a monthly salary needs the days-per-month divisor before it can be paid", () => {
    const t = terms("w1", 26520, "monthly");
    const c = calculateDay(day("08:00", "16:00"), { ...RULES.shukla, ...decided }, t);
    expect(c.amountState).toBe("needs_configuration");
    expect(c.missing).toContain("Days per month for monthly salaries");
    const ok = calculateDay(day("08:00", "16:00"), { ...RULES.shukla, ...decided, monthlyDivisorDays: 26 }, t);
    expect(ok.amount).toBe(1020); // 26,520 ÷ 26
  });

  it("an unconfirmed rate basis (Shukla) is never paid as daily or monthly by guess", () => {
    const c = calculateDay(day("08:00", "16:00"), { ...RULES.shukla, ...decided, monthlyDivisorDays: 26 }, terms("w1", 26520, "unconfirmed"));
    expect(c.amountState).toBe("needs_configuration");
    expect(c.amount).toBeNull();
    expect(c.netHours).toBe(8); // hours are still known
  });
});

describe("Overtime by contractor and shift", () => {
  const t = terms("w1", 480, "daily");
  it("Excellent/Optimum: overtime after 8.5 h on a day shift, after 8 h on a night shift", () => {
    const dayShift = calculateDay(day("08:00", "17:00"), { ...RULES.excellent, ...decided, overtimeRounding: "exact" }, t);
    expect(dayShift.overtimeMinutes).toBe(30);
    const night = calculateDay(day("21:00", "06:00", "night", NEXT), { ...RULES.excellent, ...decided, overtimeRounding: "exact" }, t);
    expect(night.netMinutes).toBe(540); // across midnight, from real timestamps
    expect(night.overtimeMinutes).toBe(60);
  });

  it("Shukla/Sumit: overtime after 8 h on both shifts", () => {
    for (const shift of ["day", "night"] as const) {
      const c = calculateDay(shift === "day" ? day("08:00", "17:00") : day("21:00", "06:00", "night", NEXT), { ...RULES.sumit, ...decided, overtimeRounding: "exact" }, t);
      expect(c.overtimeMinutes).toBe(60);
    }
  });

  it("no overtime multiplier is assumed: overtime without a pay setting needs configuration", () => {
    const c = calculateDay(day("08:00", "18:00"), { ...RULES.optimum, shortDayPolicy: "pro_rata", overtimeRounding: "exact" }, t);
    expect(c.amountState).toBe("needs_configuration");
    expect(c.missing).toEqual(["Overtime pay rate"]);
    // ...but a day without overtime is still priced.
    expect(calculateDay(day("08:00", "16:00"), { ...RULES.optimum, shortDayPolicy: "pro_rata" }, t).amount).toBe(480);
  });

  it("rounding and the minimum apply before overtime is paid", () => {
    const r = { ...RULES.excellent, ...decided, overtimeMinMinutes: 30 };
    expect(calculateDay(day("08:00", "16:50"), r, t).overtimePaidMinutes).toBe(0); // 20 min < minimum
    const c = calculateDay(day("08:00", "17:40"), r, t); // 70 min over 8.5 h, floored to 60
    expect(c.overtimePaidMinutes).toBe(60);
    expect(c.overtimeAmount).toBe(120); // 1 h × (480 ÷ 8) × 2
  });

  it("lists every undecided setting on the rule", () => {
    expect(ruleGaps(RULES.sumit)).toEqual(
      expect.arrayContaining(["How short days are paid", "Overtime pay rate", "Overtime rounding", "What commission is calculated on", "Whether commission is added to or taken from wages"]),
    );
  });
});

describe("Attendance states and pay", () => {
  const t = terms("w1", 480, "daily");
  const r = { ...RULES.excellent, ...decided };
  it("pending (an unconfirmed suggestion) is never payable", () => {
    const c = calculateDay(null, r, t);
    expect(c.amountState).toBe("not_applicable");
    expect(c.amount).toBeNull();
  });
  it("a missing checkout gives no hours and no pay, and nothing is invented", () => {
    const c = calculateDay(day("08:00", null), r, t);
    expect(c.amountState).toBe("incomplete");
    expect(c.netHours).toBeNull();
    expect(c.amount).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Payroll: commission per contractor, kept separate from overtime
// ---------------------------------------------------------------------------

function payrollFor(contractorId: keyof typeof RULES, r: PaymentRule, days: { worker: string; rec: ReturnType<typeof day> | null; date?: string }[], payTerms: WorkerPayTerms[]) {
  const contractor: Contractor = { id: contractorId, name: contractorId, location: null, legalName: null, identityStatus: "confirmed", identityNote: null, photoPath: null, photoUrl: null, isActive: true, createdAt: "", updatedAt: "" };
  const project: Project = { id: "p", name: "Plant", location: "U1", isActive: true, timezone: TZ, createdAt: "", updatedAt: "" };
  const workerIds = [...new Set(days.map((d) => d.worker))];
  const workers: Worker[] = workerIds.map((id) => ({ id, code: id, employeeCode: id.toUpperCase(), fullName: `Worker ${id}`, contractorId, department: null, designation: null, isActive: true, phone: null, notes: null, source: null, createdAt: "", updatedAt: "" }));
  const assignments: WorkerAssignment[] = workerIds.map((id) => ({ id: `a-${id}`, workerId: id, projectId: "p", contractorId, startDate: "2026-09-01", endDate: null, createdAt: "" }));
  const records: AttendanceRecord[] = days
    .filter((d) => d.rec)
    .map((d, i) => ({ id: `rec${i}`, workerId: d.worker, projectId: "p", contractorId, workDate: d.date ?? D, method: "individual", version: 1, createdAt: "", updatedAt: "", createdBy: null, updatedBy: null, ...d.rec! }));
  const report = buildReport({ from: D, to: D, projects: [project], contractors: [contractor], workers, assignments, records, rules: [r], payTerms, todayByProject: { p: "2026-09-30" } });
  return buildPayroll(report, [r], payTerms);
}

describe("Commission in payroll", () => {
  it("Shukla: 8% on every worker; commission is kept apart from overtime", () => {
    const r = { ...RULES.shukla, ...decided, monthlyDivisorDays: 26, overtimeRounding: "exact" as const };
    const p = payrollFor("shukla", r, [{ worker: "a", rec: day("08:00", "17:00") }], [terms("a", 26000, "monthly")]);
    const w = p.contractors[0].workerRows[0];
    expect(w.baseWages).toBe(1000);
    expect(w.overtimeWages).toBe(250); // 1 h × (1000 ÷ 8) × 2
    expect(w.commission).toBe(80); // 8% of base wages only
    expect(w.totalPayable).toBe(1330); // added on top of wages
    expect(payrollComplete(p.contractors[0])).toBe(true);
  });

  it("Sumit: 7.5% only for selected workers", () => {
    const r = { ...RULES.sumit, ...decided };
    const p = payrollFor("sumit", r, [{ worker: "sel", rec: day("08:00", "16:00") }, { worker: "not", rec: day("08:00", "16:00") }], [terms("sel", 550, "daily", true), terms("not", 550, "daily")]);
    const by = Object.fromEntries(p.contractors[0].workerRows.map((w) => [w.workerId, w]));
    expect(by.sel).toMatchObject({ commissionApplies: true, commission: 41.25 });
    expect(by.not).toMatchObject({ commissionApplies: false, commission: 0 });
    expect(p.contractors[0].commission).toBe(41.25);
  });

  it("Excellent: no commission", () => {
    const p = payrollFor("excellent", { ...RULES.excellent, ...decided }, [{ worker: "a", rec: day("08:00", "16:00") }], [terms("a", 480, "daily")]);
    expect(p.contractors[0]).toMatchObject({ commission: 0, totalPayable: 480 });
  });

  it("commission taken from wages is not added to the contractor's total", () => {
    const r = { ...RULES.optimum, ...decided, commissionTreatment: "deducted_from_wages" as const };
    const p = payrollFor("optimum", r, [{ worker: "a", rec: day("08:00", "16:00") }], [terms("a", 480, "daily")]);
    expect(p.contractors[0]).toMatchObject({ commission: 36, totalPayable: 480, workerNet: 444 });
  });

  it("a missing commission setting blocks the total instead of showing a wrong one", () => {
    const r = { ...RULES.optimum, ...decided, commissionBase: null };
    const p = payrollFor("optimum", r, [{ worker: "a", rec: day("08:00", "16:00") }], [terms("a", 480, "daily")]);
    const c = p.contractors[0];
    expect(c.baseWages).toBe(480);
    expect(c.commission).toBeNull();
    expect(c.totalPayable).toBeNull();
    expect(c.missing).toContain("What commission is calculated on");
    expect(payrollComplete(c)).toBe(false);
  });

  it("days without OUT are counted and excluded, never priced", () => {
    const p = payrollFor("excellent", { ...RULES.excellent, ...decided }, [{ worker: "a", rec: day("08:00", null) }], [terms("a", 480, "daily")]);
    expect(p.contractors[0]).toMatchObject({ presentDays: 1, missingCheckoutDays: 1, confirmedHours: 0, totalPayable: 0 });
    expect(payrollComplete(p.contractors[0])).toBe(false); // flagged incomplete
  });
});

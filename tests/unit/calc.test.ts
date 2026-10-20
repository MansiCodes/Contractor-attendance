import { describe, expect, it } from "vitest";
import { calculateDay, ruleForDate } from "@/lib/domain/calc";
import { localToInstant, resolveShift } from "@/lib/domain/time";
import type { AttendanceSnapshot, PaymentRule } from "@/lib/domain/types";

const TZ = "Asia/Kolkata";
const at = (date: string, time: string) => localToInstant(date, time, TZ).toISOString();
const present = (inT: string, outT: string | null, date = "2026-10-15", outDate = date): AttendanceSnapshot => ({
  status: "present",
  checkInAt: at(date, inT),
  checkOutAt: outT ? at(outDate, outT) : null,
});

const rule = (r: Partial<PaymentRule>): PaymentRule => ({
  id: "r",
  contractorId: "c1",
  version: 1,
  effectiveFrom: "2026-01-01",
  rateType: "per_day",
  dayRate: 700,
  hourRate: null,
  fullDayHours: 8,
  halfDayHours: 4,
  overtimeEnabled: false,
  overtimeAfterHours: null,
  overtimeHourRate: null,
  unpaidBreakMinutes: 30,
  notes: null,
  createdAt: "2026-01-01T00:00:00Z",
  createdBy: null,
  ...r,
});

describe("calculateDay", () => {
  it("pending (suggested 9 AM, unconfirmed) is never counted or payable", () => {
    const c = calculateDay(null, rule({}));
    expect(c.status).toBe("pending");
    expect(c.payableUnits).toBeNull();
    expect(c.amount).toBeNull();
    expect(c.netMinutes).toBeNull();
    expect(c.amountState).toBe("not_applicable");
  });

  it("full day on time: 09:00–18:00 minus 30 min break = 8.5h → 1 day", () => {
    const c = calculateDay(present("09:00", "18:00"), rule({}));
    expect(c.grossMinutes).toBe(540);
    expect(c.breakMinutes).toBe(30);
    expect(c.netMinutes).toBe(510);
    expect(c.netHours).toBe(8.5);
    expect(c.payableUnits).toBe(1);
    expect(c.amount).toBe(700);
  });

  it("late arrival: 10:15–18:00 → 7h15 net → half day", () => {
    const c = calculateDay(present("10:15", "18:00"), rule({}));
    expect(c.grossMinutes).toBe(465);
    expect(c.netMinutes).toBe(435);
    expect(c.payableUnits).toBe(0.5);
    expect(c.amount).toBe(350);
  });

  it("below half-day threshold pays nothing", () => {
    const c = calculateDay(present("09:00", "12:00"), rule({}));
    expect(c.netMinutes).toBe(150);
    expect(c.payableUnits).toBe(0);
    expect(c.amount).toBe(0);
  });

  it("absent has no payable hours", () => {
    const c = calculateDay({ status: "absent", checkInAt: null, checkOutAt: null }, rule({}));
    expect(c.netMinutes).toBe(0);
    expect(c.payableUnits).toBe(0);
    expect(c.amount).toBe(0);
  });

  it("missing checkout is incomplete: no hours, no payable, nothing assumed", () => {
    const c = calculateDay(present("09:00", null), rule({}));
    expect(c.incomplete).toBe(true);
    expect(c.complete).toBe(false);
    expect(c.grossMinutes).toBeNull();
    expect(c.netMinutes).toBeNull();
    expect(c.payableUnits).toBeNull();
    expect(c.amount).toBeNull();
    expect(c.amountState).toBe("incomplete");
  });

  it("no rule → hours still calculated, payable 'not configured'", () => {
    const c = calculateDay(present("09:00", "17:00"), null);
    expect(c.netMinutes).toBe(480);
    expect(c.amount).toBeNull();
    expect(c.amountState).toBe("not_configured");
  });

  it("per-day with no thresholds counts any complete day as 1", () => {
    const c = calculateDay(present("09:00", "11:00"), rule({ fullDayHours: null, halfDayHours: null, unpaidBreakMinutes: 0, dayRate: 600 }));
    expect(c.payableUnits).toBe(1);
    expect(c.amount).toBe(600);
  });

  it("per-day overtime beyond threshold", () => {
    const r = rule({ overtimeEnabled: true, overtimeAfterHours: 9, overtimeHourRate: 90 });
    // 08:00–19:30 = 11.5h gross, 11h net → 2h OT
    const c = calculateDay(present("08:00", "19:30"), r);
    expect(c.netMinutes).toBe(660);
    expect(c.overtimeMinutes).toBe(120);
    expect(c.amount).toBe(700 + 180);
  });

  it("per-hour pays net hours; overtime hours at overtime rate", () => {
    const r = rule({ rateType: "per_hour", dayRate: null, hourRate: 100, fullDayHours: null, halfDayHours: null, overtimeEnabled: true, overtimeAfterHours: 8, overtimeHourRate: 150 });
    const c = calculateDay(present("09:00", "19:00"), r); // 10h gross, 9.5h net → 8 regular + 1.5 OT
    expect(c.unit).toBe("hour");
    expect(c.payableUnits).toBe(9.5);
    expect(c.amount).toBe(800 + 225);
  });

  it("overnight shift computed from instants across midnight", () => {
    const shift = resolveShift("2026-10-15", "21:00", "05:30", TZ, true);
    expect(shift.ok && shift.overnight).toBe(true);
    if (!shift.ok) throw new Error();
    const c = calculateDay({ status: "present", checkInAt: shift.checkInAt, checkOutAt: shift.checkOutAt }, rule({ unpaidBreakMinutes: 0 }));
    expect(c.grossMinutes).toBe(510);
  });

  it("OUT before IN is rejected unless overnight shifts are enabled", () => {
    expect(resolveShift("2026-10-15", "09:00", "08:00", TZ, false)).toEqual({ ok: false, error: "OUT time must be after IN time" });
    expect(resolveShift("2026-10-15", "09:00", "09:00", TZ, false).ok).toBe(false);
    expect(resolveShift("2026-10-15", "09:00", "08:00", TZ, true).ok).toBe(true);
  });

  it("stores instants in UTC: 09:00 IST = 03:30Z", () => {
    expect(at("2026-10-15", "09:00")).toBe("2026-10-15T03:30:00.000Z");
  });
});

describe("ruleForDate", () => {
  const v1 = rule({ id: "v1", version: 1, effectiveFrom: "2026-01-01", dayRate: 650 });
  const v2 = rule({ id: "v2", version: 2, effectiveFrom: "2026-10-13", dayRate: 700 });
  it("uses the version in force on each date", () => {
    expect(ruleForDate([v1, v2], "c1", "2026-10-12")?.id).toBe("v1");
    expect(ruleForDate([v1, v2], "c1", "2026-10-13")?.id).toBe("v2");
    expect(ruleForDate([v1, v2], "c1", "2025-12-31")).toBeNull();
    expect(ruleForDate([v1, v2], "c2", "2026-10-13")).toBeNull();
  });
});

describe("schemas accept client-resolved values on the server", () => {
  it("re-validates already-transformed optional fields (null) without failing", async () => {
    const { workerCreate, paymentRuleInput } = await import("@/lib/domain/schemas");
    const client = workerCreate.parse({ fullName: "Asha", contractorId: "c1", projectId: "p1", startDate: "2026-10-20", phone: "", notes: "" });
    expect(client.phone).toBeNull();
    expect(workerCreate.parse(client).phone).toBeNull();
    const rule = paymentRuleInput.parse({ contractorId: "c1", effectiveFrom: "2026-10-20", rateType: "per_day", dayRate: "650", hourRate: "", fullDayHours: "8", halfDayHours: "", overtimeEnabled: false, overtimeAfterHours: "", overtimeHourRate: "", unpaidBreakMinutes: "30", notes: "", allowBackdate: false });
    expect(paymentRuleInput.parse(rule)).toEqual(rule);
  });
});

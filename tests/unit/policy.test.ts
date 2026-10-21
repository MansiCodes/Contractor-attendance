import { describe, expect, it } from "vitest";
import {
  dayLabels,
  evaluateEntry,
  FALLBACK_POLICY,
  operatorEditClosesAt,
  resolvePolicy,
  type AttendancePolicyVersion,
  type EntryContext,
  type PolicyValues,
} from "@/lib/domain/policy";
import { localToInstant, localToInstantPg, localToInstantStrict, todayIn } from "@/lib/domain/time";

const IST = "Asia/Kolkata";
const KTM = "Asia/Kathmandu"; // UTC+05:45
const NY = "America/New_York"; // DST: 2026-03-08 02:00 → 03:00, 2026-11-01 02:00 → 01:00

const iso = (date: string, time: string, tz = IST) => localToInstant(date, time, tz).toISOString();

let seq = 0;
function version(projectId: string | null, effectiveFrom: string, values: Partial<AttendancePolicyVersion>, ver = 1): AttendancePolicyVersion {
  const empty = Object.fromEntries(Object.keys(FALLBACK_POLICY).map((k) => [k, null])) as unknown as AttendancePolicyVersion;
  return {
    ...empty,
    ...(projectId === null ? FALLBACK_POLICY : {}),
    id: `v${++seq}`,
    projectId,
    version: ver,
    effectiveFrom,
    overridden: [],
    defaultTimezone: projectId === null ? IST : null,
    notes: null,
    createdAt: "2026-01-01T00:00:00Z",
    createdBy: null,
    ...values,
  };
}

describe("resolvePolicy: company defaults and site overrides", () => {
  const company = version(null, "1900-01-01", {});
  it("uses the company defaults when a site has no override (no suggested time is assumed)", () => {
    const p = resolvePolicy([company], "p1", "2026-10-20");
    expect(p.suggestedCheckIn).toBeNull();
    expect(p.inFutureToleranceMin).toBe(60);
    expect(p.outFutureToleranceMin).toBe(5);
    expect(p.operatorBackdateDays).toBe(0);
    expect(p.autoAbsentEnabled).toBe(false);
    expect(p.source.suggestedCheckIn).toBe("company");
    expect(p.companyPolicyId).toBe(company.id);
    expect(p.sitePolicyId).toBeNull();
  });

  it("a site override wins only for the fields it lists; the rest inherit", () => {
    const site = version("p1", "1900-01-01", { overridden: ["suggestedCheckIn", "operatorBackdateDays"], suggestedCheckIn: "08:30", operatorBackdateDays: 2 });
    const p = resolvePolicy([company, site], "p1", "2026-10-20");
    expect(p.suggestedCheckIn).toBe("08:30");
    expect(p.operatorBackdateDays).toBe(2);
    expect(p.inFutureToleranceMin).toBe(60);
    expect(p.source).toMatchObject({ suggestedCheckIn: "site", operatorBackdateDays: "site", inFutureToleranceMin: "company" });
    // Another site is unaffected.
    expect(resolvePolicy([company, site], "p2", "2026-10-20").suggestedCheckIn).toBeNull();
  });

  it("a site can override a company value to 'none'", () => {
    const c = version(null, "1900-01-01", { suggestedCheckIn: "09:00" });
    const site = version("p1", "1900-01-01", { overridden: ["suggestedCheckIn"], suggestedCheckIn: null });
    expect(resolvePolicy([c, site], "p1", "2026-10-20").suggestedCheckIn).toBeNull();
    expect(resolvePolicy([c, site], "p2", "2026-10-20").suggestedCheckIn).toBe("09:00");
  });

  it("applies versions from their effective date; same date → higher version wins", () => {
    const later = version(null, "2026-11-01", { inFutureToleranceMin: 15 }, 2);
    const sameDay = version(null, "2026-11-01", { inFutureToleranceMin: 30 }, 3);
    expect(resolvePolicy([company, later], "p1", "2026-10-31").inFutureToleranceMin).toBe(60);
    expect(resolvePolicy([company, later], "p1", "2026-11-01").inFutureToleranceMin).toBe(15);
    expect(resolvePolicy([company, sameDay, later], "p1", "2026-11-05").inFutureToleranceMin).toBe(30);
  });

  it("each site version is a complete snapshot, not a patch on the previous one", () => {
    const v1 = version("p1", "2026-01-01", { overridden: ["suggestedCheckIn"], suggestedCheckIn: "08:00" }, 1);
    const v2 = version("p1", "2026-06-01", { overridden: ["allowOvernight"], allowOvernight: true }, 2);
    const p = resolvePolicy([company, v1, v2], "p1", "2026-07-01");
    expect(p.allowOvernight).toBe(true);
    expect(p.suggestedCheckIn).toBeNull(); // back to the company value
  });

  it("falls back to the documented defaults when no company version is in force", () => {
    const p = resolvePolicy([], "p1", "2026-10-20");
    expect(p).toMatchObject(FALLBACK_POLICY);
    expect(p.source.inFutureToleranceMin).toBe("fallback");
  });
});

describe("site-local 'today' and the operator edit window at midnight", () => {
  it("rolls over at the site's own midnight (IST and Nepal +05:45)", () => {
    expect(todayIn(IST, new Date("2026-10-20T18:29:00Z"))).toBe("2026-10-20"); // 23:59 IST
    expect(todayIn(IST, new Date("2026-10-20T18:31:00Z"))).toBe("2026-10-21"); // 00:01 IST
    expect(todayIn(KTM, new Date("2026-10-20T18:14:00Z"))).toBe("2026-10-20"); // 23:59 NPT
    expect(todayIn(KTM, new Date("2026-10-20T18:16:00Z"))).toBe("2026-10-21"); // 00:01 NPT
  });

  it("today-only closes at the site's midnight", () => {
    const closes = operatorEditClosesAt({ operatorBackdateDays: 0, editCutoffTime: null }, "2026-10-20", IST);
    expect(closes.toISOString()).toBe(iso("2026-10-21", "00:00"));
    expect(operatorEditClosesAt({ operatorBackdateDays: 0, editCutoffTime: null }, "2026-10-20", KTM).toISOString()).toBe("2026-10-20T18:15:00.000Z");
  });

  it("past days + cutoff: yesterday stays editable until the cutoff today", () => {
    const closes = operatorEditClosesAt({ operatorBackdateDays: 1, editCutoffTime: "10:00" }, "2026-10-20", IST);
    expect(closes.toISOString()).toBe(iso("2026-10-21", "10:00"));
  });

  it("matches PostgreSQL on DST transitions (gap: offset before; fold: the later instant)", () => {
    expect(localToInstantPg("2026-03-08", "02:30", NY).toISOString()).toBe("2026-03-08T07:30:00.000Z");
    expect(localToInstantPg("2026-11-01", "01:30", NY).toISOString()).toBe("2026-11-01T06:30:00.000Z");
    expect(localToInstantPg("2026-07-01", "09:00", NY).toISOString()).toBe("2026-07-01T13:00:00.000Z");
    expect(localToInstantStrict("2026-03-08", "02:30", NY)).toEqual({ ok: false, reason: "gap" });
    expect(localToInstantStrict("2026-11-01", "01:30", NY)).toEqual({ ok: false, reason: "fold" });
    const cutoff = operatorEditClosesAt({ operatorBackdateDays: 0, editCutoffTime: "01:30" }, "2026-11-01", NY);
    expect(cutoff.toISOString()).toBe("2026-11-01T06:30:00.000Z");
  });
});

describe("evaluateEntry: one check for every entry path", () => {
  const NOW = new Date("2026-10-20T07:00:00Z"); // 12:30 IST
  const ctx = (o: Partial<EntryContext> = {}): EntryContext => ({
    workDate: "2026-10-20",
    timezone: IST,
    dayPolicy: { suggestedCheckIn: "09:00", allowOvernight: false },
    capturePolicy: { inFutureToleranceMin: 60, outFutureToleranceMin: 5 },
    now: NOW,
    ...o,
  });
  const present = (checkIn: string | null, checkOut: string | null = null, checkInSource: "entered" | "suggested" | null = "entered") => ({
    status: "present" as const,
    checkIn,
    checkOut,
    checkInSource,
  });

  it("absent and pending carry no times", () => {
    expect(evaluateEntry(ctx(), { status: "absent", checkIn: "09:00", checkOut: null, checkInSource: "entered" }, null)).toEqual({
      ok: true, checkInAt: null, checkOutAt: null, checkOutNextDay: false, checkInSource: null,
    });
  });

  it("present needs an IN and says how it was recorded; 'suggested' must match the suggestion", () => {
    expect(evaluateEntry(ctx(), present(null), null)).toMatchObject({ ok: false, field: "in" });
    expect(evaluateEntry(ctx(), present("09:00", null, null), null)).toMatchObject({ ok: false, error: /entered or the suggested/ });
    expect(evaluateEntry(ctx(), present("09:00", null, "suggested"), null)).toMatchObject({ ok: true, checkInSource: "suggested", checkInAt: iso("2026-10-20", "09:00") });
    expect(evaluateEntry(ctx(), present("09:15", null, "suggested"), null)).toMatchObject({ ok: false, error: /suggested time/ });
    const noSuggestion = ctx({ dayPolicy: { suggestedCheckIn: null, allowOvernight: false } });
    expect(evaluateEntry(noSuggestion, present("09:00", null, "suggested"), null)).toMatchObject({ ok: false });
  });

  it("future-time limits come from the policy, inclusive at the edge", () => {
    // NOW = 12:30 IST; IN tolerance 60 → 13:30 allowed, 13:31 refused.
    expect(evaluateEntry(ctx(), present("13:30"), null).ok).toBe(true);
    expect(evaluateEntry(ctx(), present("13:31"), null)).toMatchObject({ ok: false, error: "IN time is in the future" });
    // OUT tolerance 5 → 12:35 allowed, 12:36 refused.
    expect(evaluateEntry(ctx(), present("09:00", "12:35"), null).ok).toBe(true);
    expect(evaluateEntry(ctx(), present("09:00", "12:36"), null)).toMatchObject({ ok: false, error: "OUT time cannot be in the future" });
    // A stricter site: no IN ahead of the clock at all.
    const strict = ctx({ capturePolicy: { inFutureToleranceMin: 0, outFutureToleranceMin: 0 } });
    expect(evaluateEntry(strict, present("12:30"), null).ok).toBe(true);
    expect(evaluateEntry(strict, present("12:31"), null).ok).toBe(false);
  });

  it("keeps stored instants exactly for untouched times (seconds, older records without a source)", () => {
    const previous = { status: "present" as const, checkInAt: "2026-10-20T03:30:30.000Z", checkOutAt: null, checkInSource: null };
    const v = evaluateEntry(ctx(), present("09:00", "12:00", null), previous);
    expect(v).toMatchObject({ ok: true, checkInAt: "2026-10-20T03:30:30.000Z", checkInSource: null, checkOutAt: iso("2026-10-20", "12:00") });
  });

  it("does not re-check an unchanged IN against a tightened limit", () => {
    const previous = { status: "present" as const, checkInAt: iso("2026-10-20", "13:00"), checkOutAt: null, checkInSource: "entered" as const };
    const strict = ctx({ capturePolicy: { inFutureToleranceMin: 0, outFutureToleranceMin: 5 } });
    expect(evaluateEntry(strict, present("13:00"), previous).ok).toBe(true);
    expect(evaluateEntry(strict, present("13:05"), previous).ok).toBe(false);
  });

  it("never moves an untouched OUT to another day when only IN is edited", () => {
    const night = ctx({ workDate: "2026-10-19", dayPolicy: { suggestedCheckIn: null, allowOvernight: true } });
    const saved = { status: "present" as const, checkInAt: iso("2026-10-19", "09:00"), checkOutAt: iso("2026-10-19", "17:00"), checkInSource: "entered" as const };
    // IN moved after the stored OUT: refused, not silently turned into an 18:00 → 17:00 (+1) shift.
    expect(evaluateEntry(night, present("18:00", "17:00"), saved)).toMatchObject({ ok: false, error: "OUT time must be after IN time" });
    expect(evaluateEntry(night, present("08:00", "17:00"), saved)).toMatchObject({ ok: true, checkOutAt: saved.checkOutAt, checkOutNextDay: false });
  });

  it("keeps an untouched overnight OUT even after overnight shifts are turned off", () => {
    const savedNight = { status: "present" as const, checkInAt: iso("2026-10-19", "21:00"), checkOutAt: iso("2026-10-20", "05:00"), checkInSource: "entered" as const };
    const dayOnly = ctx({ workDate: "2026-10-19", dayPolicy: { suggestedCheckIn: null, allowOvernight: false } });
    expect(evaluateEntry(dayOnly, present("21:30", "05:00"), savedNight)).toMatchObject({ ok: true, checkOutAt: savedNight.checkOutAt, checkOutNextDay: true });
    // A new overnight OUT is still refused there.
    expect(evaluateEntry(dayOnly, present("21:00", "05:30"), savedNight)).toMatchObject({ ok: false });
  });

  it("keeps a stored DST occurrence when the time is not edited", () => {
    const fold = ctx({ timezone: NY, workDate: "2026-11-01", now: new Date("2026-11-02T00:00:00Z"), dayPolicy: { suggestedCheckIn: null, allowOvernight: false } });
    const saved = { status: "present" as const, checkInAt: "2026-11-01T05:30:00.000Z", checkOutAt: null, checkInSource: null }; // 01:30 EDT
    expect(evaluateEntry(fold, present("01:30", "09:00"), saved)).toMatchObject({ ok: true, checkInAt: "2026-11-01T05:30:00.000Z", checkInSource: null });
  });

  it("OUT before IN is the next day only where overnight shifts are allowed", () => {
    const night = ctx({ workDate: "2026-10-19", dayPolicy: { suggestedCheckIn: null, allowOvernight: true } });
    expect(evaluateEntry(night, present("21:00", "05:30"), null)).toMatchObject({ ok: true, checkOutNextDay: true, checkOutAt: iso("2026-10-20", "05:30") });
    expect(evaluateEntry(ctx({ workDate: "2026-10-19" }), present("21:00", "05:30"), null)).toMatchObject({ ok: false, error: "OUT time must be after IN time" });
  });

  it("works across the site's midnight: yesterday's late IN is accepted just after midnight", () => {
    const justAfterMidnight = new Date("2026-10-20T18:31:00Z"); // 00:01 IST on the 21st
    expect(evaluateEntry(ctx({ workDate: "2026-10-20", now: justAfterMidnight }), present("23:50"), null).ok).toBe(true);
    expect(evaluateEntry(ctx({ workDate: "2026-10-21", now: justAfterMidnight }), present("00:00"), null).ok).toBe(true);
    // 23:59 the day before is not "today" for the 21st's register: the IN is on its own work date only.
    const v = evaluateEntry(ctx({ workDate: "2026-10-21", now: justAfterMidnight }), present("23:59"), null);
    expect(v.ok).toBe(false); // 23:59 on the 21st is in the future
  });

  it("refuses DST gap and fold times instead of guessing", () => {
    const ny = ctx({ timezone: NY, workDate: "2026-03-08", now: new Date("2026-03-09T00:00:00Z"), dayPolicy: { suggestedCheckIn: null, allowOvernight: false } });
    expect(evaluateEntry(ny, present("02:30"), null)).toMatchObject({ ok: false, error: /does not exist/ });
    const fold = { ...ny, workDate: "2026-11-01", now: new Date("2026-11-02T00:00:00Z") };
    expect(evaluateEntry(fold, present("01:30"), null)).toMatchObject({ ok: false, error: /happens twice/ });
    expect(evaluateEntry(fold, present("08:00", "17:00"), null).ok).toBe(true);
  });
});

describe("labels (display only)", () => {
  const base: PolicyValues = { ...FALLBACK_POLICY, shiftStart: "09:00", shiftEnd: "17:30", lateGraceMin: 15, halfDayBelowHours: 4, overtimeAfterHours: 9, overtimeMinMinutes: 30 };
  const rec = (inT: string, outT: string | null, date = "2026-10-20") => ({
    status: "present" as const,
    checkInAt: iso(date, inT),
    checkOutAt: outT ? iso(date, outT) : null,
  });

  it("late only after shift start + grace", () => {
    expect(dayLabels(base, rec("09:15", null), "2026-10-20", IST, false).lateMinutes).toBeNull();
    expect(dayLabels(base, rec("09:16", null), "2026-10-20", IST, false).lateMinutes).toBe(16);
    expect(dayLabels({ ...base, lateGraceMin: null }, rec("11:00", null), "2026-10-20", IST, false).lateMinutes).toBeNull();
  });

  it("anchors the shift start to the work date (no wrap past midnight)", () => {
    const night = { ...base, shiftStart: "23:50", shiftEnd: "07:00", lateGraceMin: 20 };
    expect(dayLabels(night, rec("23:55", null), "2026-10-20", IST, false).lateMinutes).toBeNull();
  });

  it("half day and overtime use gross hours × 60", () => {
    expect(dayLabels(base, rec("09:00", "12:59"), "2026-10-20", IST, false).halfDay).toBe(true);
    expect(dayLabels(base, rec("09:00", "13:00"), "2026-10-20", IST, false).halfDay).toBe(false);
    expect(dayLabels(base, rec("09:00", "18:29"), "2026-10-20", IST, false).overtimeMinutes).toBeNull(); // 29 min < 30 min minimum
    expect(dayLabels(base, rec("09:00", "18:30"), "2026-10-20", IST, false).overtimeMinutes).toBe(30);
    expect(dayLabels(base, rec("09:00", null), "2026-10-20", IST, false)).toMatchObject({ halfDay: false, overtimeMinutes: null });
  });

  it("'absent – not marked' only when auto-absent is on and the operator window has closed", () => {
    expect(dayLabels(base, null, "2026-10-20", IST, true).notMarkedAbsent).toBe(false); // off by default
    const on = { ...base, autoAbsentEnabled: true };
    expect(dayLabels(on, null, "2026-10-20", IST, false).notMarkedAbsent).toBe(false);
    expect(dayLabels(on, null, "2026-10-20", IST, true).notMarkedAbsent).toBe(true);
    expect(dayLabels(on, { status: "absent", checkInAt: null, checkOutAt: null }, "2026-10-20", IST, true).notMarkedAbsent).toBe(false);
  });
});

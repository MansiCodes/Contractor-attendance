import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { getAppMode } from "@/lib/config";
import { mapDbError } from "@/lib/server/store/supabase-store";
import * as map from "@/lib/server/store/supabase-mappers";

const LIVE = { NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon" };

describe("16. demo data cannot leak into production", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.doUnmock("@/lib/server/store/demo-store");
    vi.doUnmock("@/lib/supabase/server");
  });

  it("chooses live mode whenever Supabase is configured", () => {
    expect(getAppMode(LIVE)).toBe("live");
    expect(getAppMode({})).toBe("demo");
    expect(getAppMode({ ...LIVE, APP_MODE: "demo" })).toBe("demo");
  });

  it("APP_MODE=live without credentials is a hard error, never a silent demo fallback", () => {
    expect(() => getAppMode({ APP_MODE: "live" })).toThrow(AppError);
    expect(() => getAppMode({ APP_MODE: "staging" })).toThrow(AppError);
  });

  it("in live mode the store factory never loads the demo store", async () => {
    vi.stubEnv("APP_MODE", "live");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", LIVE.NEXT_PUBLIC_SUPABASE_URL);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", LIVE.NEXT_PUBLIC_SUPABASE_ANON_KEY);
    const demoLoaded = vi.fn();
    vi.doMock("@/lib/server/store/demo-store", () => {
      demoLoaded();
      return { getDemoStore: () => { throw new Error("demo store must not be used"); } };
    });
    vi.doMock("@/lib/supabase/server", () => ({ createServerSupabase: async () => ({ fake: true }), createAdminSupabase: () => ({}) }));
    const { getStore } = await import("@/lib/server/store");
    const store = await getStore();
    expect(store.kind).toBe("supabase");
    expect(demoLoaded).not.toHaveBeenCalled();
  });

  it("in demo mode the Supabase client is never created", async () => {
    vi.stubEnv("APP_MODE", "demo");
    const created = vi.fn();
    vi.doMock("@/lib/supabase/server", () => {
      created();
      return { createServerSupabase: async () => ({}) };
    });
    const { getStore } = await import("@/lib/server/store");
    expect((await getStore()).kind).toBe("demo");
    expect(created).not.toHaveBeenCalled();
  });

  it("demo session cookies are signed; forged ones are rejected", async () => {
    vi.doMock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
    const { signDemoSession, verifyDemoSession } = await import("@/lib/server/session");
    const good = signDemoSession("demo-admin");
    expect(verifyDemoSession(good)).toBe("demo-admin");
    expect(verifyDemoSession("demo-admin.forged")).toBeNull();
    expect(verifyDemoSession(good.replace("demo-admin", "demo-op-pvc"))).toBeNull();
    expect(verifyDemoSession(undefined)).toBeNull();
    vi.doUnmock("next/headers");
  });
});

describe("Supabase error and row mapping", () => {
  it("maps database errors to user-safe app errors", () => {
    expect(mapDbError({ message: "forbidden: only NF admins can do this" }).code).toBe("forbidden");
    expect(mapDbError({ message: "conflict: attendance was changed" }).code).toBe("conflict");
    expect(mapDbError({ message: "invalid: OUT time cannot be in the future" }).message).toBe("OUT time cannot be in the future");
    expect(mapDbError({ message: 'new row violates row-level security policy for table "workers"', code: "42501" }).code).toBe("forbidden");
    expect(mapDbError({ message: "duplicate", code: "23505" }).code).toBe("conflict");
    expect(mapDbError({ message: "boom", code: "XX000" }).message).toContain("Database error");
  });

  it("maps rows to domain objects with normalised instants and numbers", () => {
    const rec = map.attendance({
      id: "a", worker_id: "w", project_id: "p", contractor_id: "c", work_date: "2026-10-20", status: "present",
      check_in_at: "2026-10-20T03:30:00+00:00", check_out_at: null, method: "bulk", version: 3,
      created_at: "2026-10-20T03:30:00+00:00", updated_at: "2026-10-20T03:30:00+00:00", created_by: "u", updated_by: "u",
    });
    expect(rec.checkInAt).toBe("2026-10-20T03:30:00.000Z");
    expect(rec.version).toBe(3);
    expect(rec.checkInSource).toBeNull(); // older rows have no source
    const project = map.project({ id: "p", name: "n", location: "l", is_active: true, timezone: "Asia/Kolkata", default_check_in: "09:00:00", allow_overnight: false, operator_backdate_days: 1, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" });
    expect(project).not.toHaveProperty("defaultCheckIn"); // deprecated column, no longer read
    const site = map.policyRow({ id: "v", project_id: "p", version: 2, effective_from: "2026-01-01", overridden: ["suggested_check_in", "operator_backdate_days"], suggested_check_in: null, operator_backdate_days: 2, half_day_below_hours: null, default_timezone: null, notes: null, created_at: "2026-01-01T00:00:00Z", created_by: "u" });
    expect(site).toMatchObject({ projectId: "p", overridden: ["suggestedCheckIn", "operatorBackdateDays"], suggestedCheckIn: null, operatorBackdateDays: 2 });
    expect(map.policyFields({ ...site, defaultTimezone: null })).toMatchObject({ overridden: ["suggested_check_in", "operator_backdate_days"], operator_backdate_days: 2 });
    const company = map.policyRow({ id: "c", project_id: null, version: 1, effective_from: "1900-01-01", overridden: [], suggested_check_in: "08:30:00", in_future_tolerance_min: 60, default_timezone: "Asia/Kolkata", created_at: "2026-01-01T00:00:00Z" });
    expect(company.overridden).toHaveLength(15);
    expect(company.suggestedCheckIn).toBe("08:30");
    expect(map.effectivePolicy({ suggested_check_in: null, allow_overnight: true, in_future_tolerance_min: 15, half_day_below_hours: "4.50", company_policy_id: "c", site_policy_id: null })).toMatchObject({
      suggestedCheckIn: null, allowOvernight: true, inFutureToleranceMin: 15, halfDayBelowHours: 4.5, companyPolicyId: "c", sitePolicyId: null,
    });
    const rule = map.paymentRule({ id: "r", contractor_id: "c", version: 1, effective_from: "2026-01-01", rate_type: "per_day", day_rate: "650.00", hour_rate: null, full_day_hours: "8.00", half_day_hours: null, overtime_enabled: false, overtime_after_hours: null, overtime_hour_rate: null, unpaid_break_minutes: 30, notes: null, created_at: "2026-01-01T00:00:00Z", created_by: null });
    expect(rule.dayRate).toBe(650);
    expect(rule.fullDayHours).toBe(8);
    // A rule saved before the v2 settings keeps its meaning: contractor rate, half-day thresholds, no commission.
    expect(rule).toMatchObject({ rateSource: "contractor", shortDayPolicy: "half_day", overtimeRounding: "exact", commissionEnabled: false });
    const v2 = map.paymentRule({ id: "r2", contractor_id: "c", version: 2, effective_from: "2026-09-01", rule_format: 2, rate_source: "worker", rate_type: "per_day", day_rate: null, hour_rate: null, full_day_hours: "8.00", half_day_hours: null, short_day_policy: null, overtime_enabled: true, overtime_after_hours: "8.50", overtime_after_night_hours: "8.00", overtime_rate_mode: null, overtime_rounding: null, overtime_min_minutes: 0, unpaid_break_minutes: 0, commission_enabled: true, commission_percent: "7.50", commission_scope: "selected", commission_base: null, commission_treatment: null, notes: null, created_at: "2026-09-01T00:00:00Z", created_by: null });
    expect(v2).toMatchObject({ rateSource: "worker", shortDayPolicy: null, overtimeAfterHours: 8.5, overtimeAfterNightHours: 8, overtimeRateMode: null, commissionPercent: 7.5, commissionScope: "selected", commissionBase: null });
    expect(map.paymentRuleFields(v2)).toMatchObject({ rule_format: 2, rate_source: "worker", overtime_after_night_hours: 8, commission_scope: "selected" });
    const log = map.auditLog({ id: 7, attendance_id: "a", worker_id: "w", project_id: "p", contractor_id: "c", work_date: "2026-10-20", action: "update", method: "individual", changed_by: "u", changed_by_role: "operator", changed_at: "2026-10-20T04:00:00+00:00", old_values: { status: "present", check_in_at: "2026-10-20T03:30:00+00:00", check_out_at: null }, new_values: { status: "absent", check_in_at: null, check_out_at: null } });
    expect(log.id).toBe("7");
    expect(log.oldValues?.checkInAt).toBe("2026-10-20T03:30:00.000Z");
    expect(log.newValues.status).toBe("absent");
    expect(log.oldValues).not.toHaveProperty("checkInSource"); // written before sources were tracked
    const newer = map.auditLog({ id: 8, attendance_id: "a", worker_id: "w", project_id: "p", contractor_id: "c", work_date: "2026-10-20", action: "create", method: "bulk", changed_by: "u", changed_by_role: "operator", changed_at: "2026-10-20T04:00:00+00:00", old_values: null, new_values: { status: "present", check_in_at: "2026-10-20T03:30:00+00:00", check_out_at: null, check_in_source: "suggested" } });
    expect(newer.newValues.checkInSource).toBe("suggested");
  });
});

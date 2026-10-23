import { beforeAll, describe, expect, it } from "vitest";
import { resolvePolicy, type AttendancePolicyVersion } from "@/lib/domain/policy";
import { paymentRule, paymentRuleFields, policyRow } from "@/lib/server/store/supabase-mappers";
import { applyMigrations, asUser, createAuthUser, createDb, type Db } from "./harness";

// Payment rules v2 (legacy rows keep their meaning) and day/night shifts in the database.

const one = async <T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
const rows = async <T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
const BEFORE_RULES_V2 = "20261023000002";

describe("payment rules v2", () => {
  it("keeps rules saved before the upgrade calculating as before, and accepts undecided settings after", async () => {
    const db = await createDb({ until: BEFORE_RULES_V2 });
    const admin = await createAuthUser(db, "admin@example.test", "Admin", "admin");
    const contractor = await asUser(db, admin, async () => {
      const c = (await one<{ id: string }>(db, `insert into public.contractors (name, location) values ('Legacy Co', 'Pune') returning id`)).id;
      await db.query(
        `insert into public.contractor_payment_rules (contractor_id, effective_from, rate_type, day_rate, full_day_hours, half_day_hours, overtime_enabled, overtime_after_hours, overtime_hour_rate, unpaid_break_minutes)
         values ($1, '2026-01-01', 'per_day', 650, 8, 4, true, 9, 90, 30)`,
        [c],
      );
      return c;
    });
    const before = await rows(db, `select * from public.contractor_payment_rules`);
    await applyMigrations(db, { after: BEFORE_RULES_V2 });
    const after = await rows<Record<string, unknown>>(db, `select * from public.contractor_payment_rules`);
    expect(after[0].rule_format).toBe(1);
    expect(Object.fromEntries(Object.entries(after[0]).filter(([k]) => k in before[0]))).toEqual(before[0]);
    expect(paymentRule(after[0])).toMatchObject({ rateSource: "contractor", shortDayPolicy: "half_day", overtimeRateMode: "per_hour", overtimeRounding: "exact", commissionEnabled: false });

    // A worker-rate rule with overtime and commission settings still undecided.
    const v2 = paymentRule({
      id: "x", contractor_id: contractor, version: 0, effective_from: "2026-09-01", rule_format: 2, rate_source: "worker", rate_type: "per_day",
      day_rate: null, hour_rate: null, full_day_hours: 8, half_day_hours: null, short_day_policy: null, monthly_divisor_days: null,
      overtime_enabled: true, overtime_after_hours: 8.5, overtime_after_night_hours: 8, overtime_rate_mode: null, overtime_hour_rate: null,
      overtime_multiplier: null, overtime_rounding: null, overtime_min_minutes: 0, unpaid_break_minutes: 0,
      commission_enabled: true, commission_percent: 7.5, commission_scope: "selected", commission_base: null, commission_treatment: null,
      notes: null, created_at: "2026-09-01T00:00:00Z", created_by: null,
    });
    const row = paymentRuleFields(v2);
    const keys = Object.keys(row);
    const saved = await asUser(db, admin, () =>
      one<Record<string, unknown>>(db, `insert into public.contractor_payment_rules (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning *`, keys.map((k) => row[k])),
    );
    expect(saved).toMatchObject({ version: 2, rule_format: 2, rate_source: "worker", overtime_rate_mode: null });

    // Still append-only, and a half-day policy needs its hours.
    await expect(asUser(db, admin, () => db.query(`update public.contractor_payment_rules set day_rate = 1`))).rejects.toThrow(/append-only|permission/);
    await expect(
      asUser(db, admin, () =>
        db.query(`insert into public.contractor_payment_rules (contractor_id, effective_from, rate_type, day_rate, short_day_policy) values ($1, '2026-10-01', 'per_day', 500, 'half_day')`, [contractor]),
      ),
    ).rejects.toThrow(/check constraint/);
    // A contractor-rate rule still needs its rate.
    await expect(
      asUser(db, admin, () => db.query(`insert into public.contractor_payment_rules (contractor_id, effective_from, rate_type) values ($1, '2026-10-01', 'per_day')`, [contractor])),
    ).rejects.toThrow(/check constraint/);
  });
});

describe("day and night shifts", () => {
  let db: Db;
  let admin: string;
  let op: string;
  let ids: { contractor: string; plant: string; w1: string; w2: string; w3: string };
  let d2: string; // two days ago, plant-local

  beforeAll(async () => {
    db = await createDb();
    admin = await createAuthUser(db, "admin@example.test", "Admin", "admin");
    op = await createAuthUser(db, "op@example.test", "Operator");
    d2 = (await one<{ d: string }>(db, `select to_char((now() at time zone 'Asia/Kolkata')::date - 2, 'YYYY-MM-DD') as d`)).d;
    ids = await asUser(db, admin, async () => {
      const contractor = (await one<{ id: string }>(db, `insert into public.contractors (name, location) values ('Night Co', 'Pune') returning id`)).id;
      const plant = (await one<{ id: string }>(db, `insert into public.projects (name, location) values ('Upcast Plant', 'Unit 3') returning id`)).id;
      await db.query(`insert into public.contractor_project_assignments (contractor_id, project_id, start_date) values ($1, $2, '2026-01-01')`, [contractor, plant]);
      const w = async (name: string) => (await one<{ id: string }>(db, `select id from public.admin_create_worker($1, $2, $3, '2026-01-01')`, [name, contractor, plant])).id;
      const [w1, w2, w3] = [await w("Night One"), await w("Day One"), await w("Night Two")];
      await db.query(`insert into public.site_operator_assignments (operator_id, project_id) values ($1, $2)`, [op, plant]);
      // The plant does not allow overnight day shifts; its night shift suggests 21:00. Operators may edit 2 past days.
      await db.query(
        `insert into public.attendance_policies (project_id, effective_from, overridden, night_suggested_check_in, operator_backdate_days, allow_overnight)
         values ($1, '2026-01-01', array['night_suggested_check_in', 'operator_backdate_days', 'allow_overnight'], '21:00', 2, false)`,
        [plant],
      );
      return { contractor, plant, w1, w2, w3 };
    });
  });

  const at = (date: string, time: string, nextDay = false) =>
    one<{ t: string }>(db, `select (((($1::date + $3::int) + $2::time) at time zone 'Asia/Kolkata'))::text as t`, [date, time, nextDay ? 1 : 0]).then((r) => r.t);
  const save = (items: Record<string, unknown>[]) =>
    rows<Record<string, unknown>>(db, `select * from public.save_attendance($1, $2::date, $3::jsonb)`, [ids.plant, d2, JSON.stringify(items)]);
  const item = (o: Record<string, unknown>) => ({ contractor_id: ids.contractor, status: "present", check_in_source: "entered", method: "individual", expected_version: null, ...o });

  it("a night shift may end the next morning even where day shifts may not", async () => {
    const [night] = await asUser(db, op, async () => save([item({ worker_id: ids.w1, shift: "night", check_in_at: await at(d2, "21:00"), check_out_at: await at(d2, "05:30", true) })]));
    expect(night.shift).toBe("night");
    await expect(
      asUser(db, op, async () => save([item({ worker_id: ids.w2, shift: "day", check_in_at: await at(d2, "21:00"), check_out_at: await at(d2, "05:30", true) })])),
    ).rejects.toThrow(/OUT time must be on the attendance date/);
  });

  it("the night shift's own suggested IN is the one a 'suggested' entry must match", async () => {
    const [ok] = await asUser(db, op, async () => save([item({ worker_id: ids.w3, shift: "night", check_in_source: "suggested", check_in_at: await at(d2, "21:00") })]));
    expect(ok.check_in_source).toBe("suggested");
    await expect(
      asUser(db, op, async () => save([item({ worker_id: ids.w2, shift: "day", check_in_source: "suggested", check_in_at: await at(d2, "21:00") })])),
    ).rejects.toThrow(/suggested time/);
  });

  it("records the shift in the audit log; old records default to day", async () => {
    const audit = await rows<{ new_values: { shift: string } }>(db, `select new_values from public.attendance_audit_logs where worker_id = $1`, [ids.w1]);
    expect(audit[0].new_values.shift).toBe("night");
    // A day-shift save without a shift key is a day shift.
    const [day] = await asUser(db, op, async () => save([{ worker_id: ids.w2, contractor_id: ids.contractor, status: "absent", method: "individual", expected_version: null }]));
    expect(day.shift).toBe("day");
  });

  it("a save for one shift cannot take over the other shift's record, by RPC or direct update", async () => {
    const rec = await one<{ version: number; shift: string }>(db, `select version, shift from public.attendance_records where worker_id = $1`, [ids.w2]);
    expect(rec.shift).toBe("day");
    await expect(
      asUser(db, op, () => save([{ worker_id: ids.w2, contractor_id: ids.contractor, status: "absent", method: "individual", shift: "night", expected_version: rec.version }])),
    ).rejects.toThrow(/recorded on the day shift/);
    await expect(asUser(db, op, () => db.query(`update public.attendance_records set shift = 'night' where worker_id = $1`, [ids.w2]))).rejects.toThrow(/only head office/);
    expect((await one<{ shift: string }>(db, `select shift from public.attendance_records where worker_id = $1`, [ids.w2])).shift).toBe("day");
  });

  it("the service role used by the scheduler can read attendance", async () => {
    await db.exec(`set role service_role`);
    try {
      expect((await one<{ n: number }>(db, `select count(*)::int as n from public.attendance_records`)).n).toBeGreaterThan(0);
      expect((await one<{ n: number }>(db, `select count(*)::int as n from public.attendance_policies`)).n).toBeGreaterThan(0);
    } finally {
      await db.exec(`reset role`);
    }
  });

  it("resolves the night suggested IN in SQL exactly as in TypeScript", async () => {
    const versions: AttendancePolicyVersion[] = (await rows(db, `select * from public.attendance_policies`)).map(policyRow);
    const sql = await one<{ night: string | null }>(db, `select ((r).night_suggested_check_in)::text as night from (select public.attendance_policy_resolve($1, $2::date) as r) x`, [ids.plant, d2]);
    expect(resolvePolicy(versions, ids.plant, d2).nightSuggestedCheckIn).toBe(sql.night?.slice(0, 5) ?? null);
    expect(resolvePolicy(versions, ids.plant, d2).nightSuggestedCheckIn).toBe("21:00");
  });
});

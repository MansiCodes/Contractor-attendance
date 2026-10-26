import { beforeAll, describe, expect, it } from "vitest";
import { operatorEditClosesAt, resolvePolicy, type AttendancePolicyVersion } from "@/lib/domain/policy";
import { policyRow } from "@/lib/server/store/row-mappers";
import { applyMigrations, asUser, createAuthUser, createDb, type Db } from "./harness";

// Attendance policies in the database: the upgrade from the original schema,
// versioning, the admin-only read boundary, and the write trigger that enforces
// the policy for the save RPC and for direct table writes alike.

const BEFORE = "20261020000004"; // last migration before attendance policies

const expectError = async (p: Promise<unknown>, match: RegExp) => {
  await expect(p).rejects.toThrow(match);
};
const one = async <T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
const rows = async <T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
const todayIst = async (db: Db) => (await one<{ d: string }>(db, `select to_char((now() at time zone 'Asia/Kolkata')::date, 'YYYY-MM-DD') as d`)).d;

async function seedBasics(db: Db) {
  const admin = await createAuthUser(db, "admin@example.test", "Head Office Admin", "admin");
  const op = await createAuthUser(db, "op@example.test", "Operator");
  const other = await createAuthUser(db, "other@example.test", "Other Operator");
  const ids = await asUser(db, admin, async () => {
    const contractor = (await one<{ id: string }>(db, `insert into public.contractors (name, location) values ('Test Labour Co', 'Jaipur') returning id`)).id;
    const siteA = (await one<{ id: string }>(db, `insert into public.projects (name, location) values ('Site A', 'Jaipur') returning id`)).id;
    const siteB = (await one<{ id: string }>(db, `insert into public.projects (name, location) values ('Site B', 'Pune') returning id`)).id;
    for (const p of [siteA, siteB]) {
      await db.query(`insert into public.contractor_project_assignments (contractor_id, project_id, start_date) values ($1, $2, '2026-01-01')`, [contractor, p]);
    }
    const worker = (await one<{ id: string }>(db, `select id from public.admin_create_worker('Ramesh Kumar', $1, $2, '2026-01-01')`, [contractor, siteA])).id;
    const workerB = (await one<{ id: string }>(db, `select id from public.admin_create_worker('Suresh Yadav', $1, $2, '2026-01-01')`, [contractor, siteB])).id;
    await db.query(`insert into public.site_operator_assignments (operator_id, project_id) values ($1, $2), ($3, $4)`, [op, siteA, other, siteB]);
    return { contractor, siteA, siteB, worker, workerB };
  });
  return { admin, op, other, ...ids };
}

const items = (o: Record<string, unknown>) => JSON.stringify([{ status: "present", check_in_at: null, check_out_at: null, check_in_source: "entered", method: "individual", expected_version: null, ...o }]);
const save = (db: Db, project: string, date: string, payload: string) => rows(db, `select * from public.save_attendance($1, $2::date, $3::jsonb)`, [project, date, payload]);

describe("upgrade from the original schema", () => {
  it("refuses to run over a site timezone PostgreSQL does not know", async () => {
    const db = await createDb({ until: BEFORE });
    await db.query(`insert into public.projects (name, location, timezone) values ('Bad', 'Nowhere', 'Mars/Olympus')`);
    await expect(applyMigrations(db, { after: BEFORE })).rejects.toThrow(/unknown project timezone.*Mars\/Olympus/);
  });

  it("keeps existing attendance and audit rows, and every site behaves as before", async () => {
    const db = await createDb({ until: BEFORE });
    const s = await seedBasics(db);
    const d = await todayIst(db);
    // Site A had custom settings; site B kept the old column defaults (09:00, no overnight, today only).
    // (with seconds, which the old schema allowed but the app always showed and used to the minute)
    await db.query(`update public.projects set default_check_in = '08:30:30', allow_overnight = true, operator_backdate_days = 2 where id = $1`, [s.siteA]);
    // A legacy present record (IN with seconds, no OUT) saved through the original RPC.
    const legacyIn = (await one<{ t: string }>(db, `select (least(($1::date + time '06:00:30') at time zone 'Asia/Kolkata', now() - interval '1 minute'))::text as t`, [d])).t;
    await asUser(db, s.op, () =>
      save(db, s.siteA, d, JSON.stringify([{ worker_id: s.worker, contractor_id: s.contractor, status: "present", check_in_at: legacyIn, method: "bulk", expected_version: null }])),
    );
    const before = {
      attendance: await rows(db, `select * from public.attendance_records order by id`),
      audit: await rows(db, `select * from public.attendance_audit_logs order by id`),
    };

    await applyMigrations(db, { after: BEFORE });

    const after = await rows<Record<string, unknown>>(db, `select * from public.attendance_records order by id`);
    // Identical apart from the new (empty) column.
    // Identical apart from columns added later (empty or defaulted: the shift of old records is "day").
    expect(after.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "check_in_source" && k !== "shift")))).toEqual(before.attendance);
    expect(after.every((r) => r.shift === "day")).toBe(true);
    expect(await rows(db, `select * from public.attendance_audit_logs order by id`)).toEqual(before.audit);
    expect((await one<{ s: string | null }>(db, `select check_in_source::text as s from public.attendance_records`)).s).toBeNull();

    const resolved = await rows<{ project_id: string; suggested_check_in: string | null; allow_overnight: boolean; operator_backdate_days: number; in_future_tolerance_min: number; out_future_tolerance_min: number }>(
      db,
      `select pj.id as project_id, (r).suggested_check_in::text, (r).allow_overnight, (r).operator_backdate_days, (r).in_future_tolerance_min, (r).out_future_tolerance_min
         from public.projects pj, lateral (select public.attendance_policy_resolve(pj.id, $1::date) as r) x order by pj.name`,
      [d],
    );
    expect(resolved).toEqual([
      { project_id: s.siteA, suggested_check_in: "08:30:00", allow_overnight: true, operator_backdate_days: 2, in_future_tolerance_min: 60, out_future_tolerance_min: 5 },
      { project_id: s.siteB, suggested_check_in: "09:00:00", allow_overnight: false, operator_backdate_days: 0, in_future_tolerance_min: 60, out_future_tolerance_min: 5 },
    ]);
    // A site created after the upgrade inherits the company defaults: no suggested time.
    const fresh = await asUser(db, s.admin, () => one<{ id: string }>(db, `insert into public.projects (name, location) values ('Site C', 'Lucknow') returning id`));
    expect((await one<{ t: string | null }>(db, `select (public.attendance_policy_resolve($1, $2::date)).suggested_check_in::text as t`, [fresh.id, d])).t).toBeNull();

    // The legacy row can still get an OUT: IN is untouched, so its unknown source stays unknown.
    const legacy = await one<{ check_in_at: string; version: number }>(db, `select check_in_at::text, version from public.attendance_records`);
    const out = await one<{ t: string }>(db, `select (now() - interval '10 seconds')::text as t`);
    const saved = await asUser(db, s.op, () =>
      save(db, s.siteA, d, JSON.stringify([{ worker_id: s.worker, contractor_id: s.contractor, status: "present", check_in_at: legacy.check_in_at, check_out_at: out.t, check_in_source: null, method: "bulk", expected_version: legacy.version }])),
    );
    expect(saved[0]).toMatchObject({ check_in_source: null, version: legacy.version + 1 });
    // Old audit JSON simply lacks the new key; the new entry records it.
    const audit = await rows<{ new_values: Record<string, unknown> }>(db, `select new_values from public.attendance_audit_logs order by id`);
    expect("check_in_source" in audit[0].new_values).toBe(false);
    expect(audit[1].new_values).toMatchObject({ check_in_source: null });
  });
});

describe("policies on a fresh database", () => {
  let db: Db;
  let s: Awaited<ReturnType<typeof seedBasics>>;
  let d: string;
  const insertPolicy = (cols: Record<string, unknown>) => {
    const keys = Object.keys(cols);
    return one<{ id: string; version: number; created_by: string | null }>(
      db,
      `insert into public.attendance_policies (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning id, version, created_by`,
      keys.map((k) => cols[k]),
    );
  };

  beforeAll(async () => {
    db = await createDb();
    s = await seedBasics(db);
    d = await todayIst(db);
  });

  it("seeds one company version and nothing per site on a fresh install", async () => {
    const all = await rows<{ project_id: string | null; version: number; suggested_check_in: string | null; default_timezone: string }>(db, `select project_id, version, suggested_check_in, default_timezone from public.attendance_policies`);
    expect(all).toEqual([{ project_id: null, version: 1, suggested_check_in: null, default_timezone: "Asia/Kolkata" }]);
  });

  it("numbers versions per scope, records the real author, and never changes a version", async () => {
    await asUser(db, s.admin, async () => {
      const c2 = await insertPolicy({ effective_from: "2026-01-01", allow_overnight: false, in_future_tolerance_min: 30, out_future_tolerance_min: 5, operator_backdate_days: 0, auto_absent_enabled: false, default_timezone: "Asia/Kolkata", created_by: s.op });
      expect(c2).toMatchObject({ version: 2, created_by: s.admin });
      const a1 = await insertPolicy({ project_id: s.siteA, effective_from: "2026-01-01", overridden: ["suggested_check_in"], suggested_check_in: "08:00" });
      const b1 = await insertPolicy({ project_id: s.siteB, effective_from: "2026-01-01", overridden: ["suggested_check_in"], suggested_check_in: null });
      expect([a1.version, b1.version]).toEqual([1, 1]);
      await expectError(db.query(`update public.attendance_policies set notes = 'x'`), /permission denied|append-only/);
      await expectError(db.query(`delete from public.attendance_policies`), /permission denied|append-only/);
    });
    await expectError(db.query(`update public.attendance_policies set notes = 'x'`), /append-only/);
  });

  it("rejects malformed versions", async () => {
    await asUser(db, s.admin, async () => {
      await expectError(insertPolicy({ project_id: s.siteA, effective_from: "2026-02-01", overridden: ["no_such_field"] }), /check constraint/);
      await expectError(insertPolicy({ project_id: s.siteA, effective_from: "2026-02-01", overridden: ["allow_overnight"] }), /check constraint/); // required value missing
      await expectError(insertPolicy({ project_id: s.siteA, effective_from: "2026-02-01", overridden: ["shift_start"], shift_start: "09:00" }), /check constraint/); // shift is one unit
      await expectError(insertPolicy({ project_id: s.siteA, effective_from: "2026-02-01", suggested_check_in: "09:00" }), /check constraint/); // value without override
      await expectError(insertPolicy({ effective_from: "2026-02-01", allow_overnight: false, in_future_tolerance_min: 30, out_future_tolerance_min: 5, operator_backdate_days: 0, auto_absent_enabled: false }), /check constraint/); // company needs a timezone
      await expectError(insertPolicy({ project_id: s.siteA, effective_from: "2026-02-01", overridden: ["in_future_tolerance_min"], in_future_tolerance_min: 500 }), /check constraint/);
      await expectError(insertPolicy({ project_id: s.siteA, effective_from: "2026-02-01", overridden: ["suggested_check_in"], suggested_check_in: "08:30:30" }), /check constraint/); // whole minutes only
    });
  });

  it("keeps raw versions admin-only and gives operators effective values for their own sites only", async () => {
    await asUser(db, s.op, async () => {
      expect(await rows(db, `select * from public.attendance_policies`)).toHaveLength(0);
      await expectError(insertPolicy({ project_id: s.siteA, effective_from: "2026-03-01", overridden: ["suggested_check_in"], suggested_check_in: "07:00" }), /forbidden/);
      const mine = await one<{ t: string }>(db, `select (public.attendance_policy_for($1, $2::date)).suggested_check_in::text as t`, [s.siteA, d]);
      expect(mine.t).toBe("08:00:00");
      await expectError(db.query(`select public.attendance_policy_for($1, $2::date)`, [s.siteB, d]), /forbidden/);
      await expectError(db.query(`select public.attendance_policy_for(null, $1::date)`, [d]), /forbidden/);
      await expectError(db.query(`select public.attendance_policy_resolve($1, $2::date)`, [s.siteB, d]), /permission denied/);
      await expectError(db.query(`select public.operator_edit_closes_at($1, $2::date)`, [s.siteA, d]), /permission denied/);
    });
    // A deactivated operator loses access too.
    await db.query(`update public.profiles set is_active = false where id = $1`, [s.other]);
    await asUser(db, s.other, () => expectError(db.query(`select public.attendance_policy_for($1, $2::date)`, [s.siteB, d]), /forbidden/));
    await db.query(`update public.profiles set is_active = true where id = $1`, [s.other]);
    await db.exec(`set role anon`);
    try {
      await expectError(db.query(`select * from public.attendance_policies`), /permission denied/);
      await expectError(db.query(`select public.attendance_policy_for($1, $2::date)`, [s.siteA, d]), /permission denied/);
    } finally {
      await db.exec(`reset role`);
    }
  });

  describe("the write trigger enforces the policy for the RPC and direct writes", () => {
    const ahead = (minutes: number) => one<{ t: string }>(db, `select (now() + make_interval(mins => $1))::text as t`, [minutes]).then((r) => r.t);
    const item = (o: Record<string, unknown>) => items({ worker_id: s.worker, contractor_id: s.contractor, ...o });

    it("uses the site's future-time limit", async () => {
      // A site version is a complete snapshot: it repeats the suggestion it keeps.
      await asUser(db, s.admin, () =>
        insertPolicy({ project_id: s.siteA, effective_from: "2026-01-02", overridden: ["suggested_check_in", "in_future_tolerance_min"], suggested_check_in: "08:00", in_future_tolerance_min: 0 }),
      );
      const t = await ahead(10);
      // Only meaningful while 10 minutes from now is still today in IST.
      if ((await one<{ ok: boolean }>(db, `select ($1::timestamptz at time zone 'Asia/Kolkata')::date = $2::date as ok`, [t, d])).ok) {
        await asUser(db, s.op, async () => {
          await expectError(save(db, s.siteA, d, item({ check_in_at: t })), /IN time is in the future/);
          await expectError(
            db.query(`insert into public.attendance_records (worker_id, project_id, contractor_id, work_date, status, check_in_at, check_in_source) values ($1, $2, $3, $4, 'present', $5, 'entered')`, [s.worker, s.siteA, s.contractor, d, t]),
            /IN time is in the future/,
          );
        });
      }
    });

    it("requires IN on the attendance date, a source, and a suggestion that really matches", async () => {
      await asUser(db, s.admin, async () => {
        const past = (await one<{ d: string }>(db, `select ($1::date - 5)::text as d`, [d])).d;
        const at = (date: string, time: string) => one<{ t: string }>(db, `select (($1::date + $2::time) at time zone 'Asia/Kolkata')::text as t`, [date, time]).then((r) => r.t);
        const prevDay = (await one<{ d: string }>(db, `select ($1::date - 1)::text as d`, [past])).d;
        await expectError(save(db, s.siteA, past, item({ check_in_at: await at(prevDay, "23:00") })), /IN time must be on the attendance date/);
        await expectError(save(db, s.siteA, past, item({ check_in_at: await at(past, "09:00"), check_in_source: null })), /entered or the suggested/);
        await expectError(save(db, s.siteA, past, item({ check_in_at: await at(past, "09:00"), check_in_source: "suggested" })), /suggested time/); // site A suggests 08:00
        const ok = await save(db, s.siteA, past, item({ check_in_at: await at(past, "08:00"), check_in_source: "suggested" }));
        expect(ok[0]).toMatchObject({ check_in_source: "suggested", version: 1 });
        // Adding OUT later keeps how IN was recorded, whatever the client claims.
        const again = await save(db, s.siteA, past, item({ check_in_at: await at(past, "08:00"), check_out_at: await at(past, "17:00"), check_in_source: "entered", expected_version: 1 }));
        expect(again[0]).toMatchObject({ check_in_source: "suggested", version: 2 });
        // Overnight OUT is refused unless the work-date policy allows it.
        const p2 = (await one<{ d: string }>(db, `select ($1::date - 6)::text as d`, [d])).d;
        await expectError(save(db, s.siteA, p2, item({ check_in_at: await at(p2, "21:00"), check_out_at: await at(past, "05:00") })), /OUT time must be on the attendance date/);
      });
    });

    it("refuses future work dates for everyone, through the RPC and direct inserts", async () => {
      const tomorrow = (await one<{ d: string }>(db, `select ($1::date + 1)::text as d`, [d])).d;
      for (const who of [s.op, s.admin]) {
        await asUser(db, who, async () => {
          await expectError(save(db, s.siteA, tomorrow, item({ status: "absent" })), /forbidden/);
          await expectError(
            db.query(`insert into public.attendance_records (worker_id, project_id, contractor_id, work_date, status) values ($1, $2, $3, $4, 'absent')`, [s.worker, s.siteA, s.contractor, tomorrow]),
            /forbidden/,
          );
        });
      }
    });

    it("closes the operator window at the cutoff on the last editable day", async () => {
      const yesterday = (await one<{ d: string }>(db, `select ($1::date - 1)::text as d`, [d])).d;
      const canEdit = () => asUser(db, s.op, () => one<{ ok: boolean }>(db, `select public.can_edit_attendance($1, $2::date) as ok`, [s.siteA, yesterday]).then((r) => r.ok));
      expect(await canEdit()).toBe(false); // today only (inherited)
      await asUser(db, s.admin, () => insertPolicy({ project_id: s.siteA, effective_from: "2026-01-03", overridden: ["operator_backdate_days"], operator_backdate_days: 1 }));
      expect(await canEdit()).toBe(true); // until midnight tonight
      await asUser(db, s.admin, () => insertPolicy({ project_id: s.siteA, effective_from: "2026-01-03", overridden: ["operator_backdate_days", "edit_cutoff_time"], operator_backdate_days: 1, edit_cutoff_time: "00:00" }));
      expect(await canEdit()).toBe(false); // closed at 00:00 today
      // Admins are not bound by the operator window.
      expect(await asUser(db, s.admin, () => one<{ ok: boolean }>(db, `select public.can_edit_attendance($1, $2::date) as ok`, [s.siteA, yesterday]).then((r) => r.ok))).toBe(true);
    });
  });

  it("gives a caller without access the same refusal whatever exists at the other site", async () => {
    // Operator B probes site A: an assigned worker and an unassigned one get the same answer.
    const probe = (worker: string) =>
      asUser(db, s.other, () =>
        db.query(`insert into public.attendance_records (worker_id, project_id, contractor_id, work_date, status, check_in_at, check_in_source) values ($1, $2, $3, $4, 'present', now() - interval '1 hour', 'suggested')`, [worker, s.siteA, s.contractor, d]),
      );
    await expectError(probe(s.worker), /^forbidden: you are not allowed to edit attendance for this plant and date$/);
    await expectError(probe(s.workerB), /^forbidden: you are not allowed to edit attendance for this plant and date$/);
  });

  it("refuses IN/OUT times that happen twice on a DST date, like the app does", async () => {
    await asUser(db, s.admin, async () => {
      const ny = (await one<{ id: string }>(db, `insert into public.projects (name, location, timezone) values ('NY fold test', 'NY', 'America/New_York') returning id`)).id;
      await db.query(`insert into public.contractor_project_assignments (contractor_id, project_id, start_date) values ($1, $2, '2025-01-01')`, [s.contractor, ny]);
      const w = (await one<{ id: string }>(db, `select id from public.admin_create_worker('Fold Worker', $1, $2, '2025-01-01')`, [s.contractor, ny])).id;
      const ins = (inAt: string, outAt: string | null) =>
        db.query(
          `insert into public.attendance_records (worker_id, project_id, contractor_id, work_date, status, check_in_at, check_out_at, check_in_source) values ($1, $2, $3, '2025-11-02', 'present', $4, $5, 'entered')`,
          [w, ny, s.contractor, inAt, outAt],
        );
      // 01:30 on 2025-11-02 happens twice in New York (05:30Z EDT and 06:30Z EST): both refused.
      await expectError(ins("2025-11-02T05:30:00Z", null), /happens twice/);
      await expectError(ins("2025-11-02T06:30:00Z", null), /happens twice/);
      await expectError(ins("2025-11-02T12:00:00Z", "2025-11-02T06:30:00Z"), /happens twice|out_after_in|check constraint/);
      await ins("2025-11-02T13:00:00Z", "2025-11-02T22:00:00Z"); // 08:00–17:00 EST is fine
    });
  });

  it("validates site timezones and locks them once attendance exists", async () => {
    await asUser(db, s.admin, async () => {
      await expectError(db.query(`insert into public.projects (name, location, timezone) values ('Bad', 'Nowhere', 'IST')`), /unknown timezone/);
      const c = (await one<{ id: string }>(db, `insert into public.projects (name, location, timezone) values ('Site N', 'Kathmandu', 'Asia/Kathmandu') returning id`)).id;
      await db.query(`update public.projects set timezone = 'Asia/Kolkata' where id = $1`, [c]); // no attendance yet
      await expectError(db.query(`update public.projects set timezone = 'Asia/Dubai' where id = $1`, [s.siteA]), /cannot be changed after attendance/);
      await db.query(`update public.projects set name = 'Site A (renamed)' where id = $1`, [s.siteA]); // other edits still fine
      const locked = (await rows<{ id: string }>(db, `select * from public.projects_with_attendance() as id`)).map((r) => r.id);
      expect(locked).toContain(s.siteA);
      expect(locked).not.toContain(c);
    });
  });
});

describe("manufacturing plants migration", () => {
  const PLANTS = "20261022000002"; // last migration before the manufacturing plants change

  it("keeps existing settings and attendance exactly as they were", async () => {
    const db = await createDb({ until: PLANTS });
    const s = await seedBasics(db);
    await asUser(db, s.admin, () =>
      db.query(`insert into public.attendance_policies (project_id, effective_from, overridden, suggested_check_in) values ($1, '2026-01-01', '{suggested_check_in}', '08:15')`, [s.siteA]),
    );
    const before = await rows(db, `select * from public.attendance_policies order by created_at, id`);
    const resolvedBefore = await one(db, `select (public.attendance_policy_resolve($1, current_date)).* `, [s.siteA]);

    await applyMigrations(db, { after: PLANTS });

    const after = await rows<Record<string, unknown>>(db, `select * from public.attendance_policies order by created_at, id`);
    expect(after.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "break_minutes" && k !== "night_suggested_check_in")))).toEqual(before);
    expect(after.every((r) => r.break_minutes === null)).toBe(true);
    const resolvedAfter = await one<Record<string, unknown>>(db, `select (public.attendance_policy_resolve($1, current_date)).*`, [s.siteA]);
    expect({ ...resolvedAfter, break_minutes: undefined, night_suggested_check_in: undefined }).toEqual({ ...resolvedBefore, break_minutes: undefined });
    expect(resolvedAfter.break_minutes).toBeNull();
    expect(resolvedAfter.night_suggested_check_in).toBeNull();
  });

  it("stores a plant break as an admin-only, per-plant override", async () => {
    const db = await createDb();
    const s = await seedBasics(db);
    const add = (cols: Record<string, unknown>) => {
      const keys = Object.keys(cols);
      return db.query(`insert into public.attendance_policies (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")})`, keys.map((k) => cols[k]));
    };
    await asUser(db, s.admin, async () => {
      await add({ project_id: s.siteA, effective_from: "2026-01-01", overridden: ["break_minutes"], break_minutes: 30 });
      await expectError(add({ project_id: s.siteB, effective_from: "2026-01-01", break_minutes: 30 }), /check constraint/); // value without override
      await expectError(add({ project_id: s.siteB, effective_from: "2026-01-01", overridden: ["break_minutes"], break_minutes: 500 }), /check constraint/);
    });
    await asUser(db, s.op, async () => {
      await expectError(add({ project_id: s.siteA, effective_from: "2026-02-01", overridden: ["break_minutes"], break_minutes: 0 }), /forbidden/);
      expect((await one<{ b: number }>(db, `select (public.attendance_policy_for($1, current_date)).break_minutes as b`, [s.siteA])).b).toBe(30);
    });
    expect((await one<{ b: number | null }>(db, `select (public.attendance_policy_resolve($1, current_date)).break_minutes as b`, [s.siteB])).b).toBeNull();
  });

  it("says plant, not project or site, in errors users can see", async () => {
    const db = await createDb();
    const s = await seedBasics(db);
    await asUser(db, s.admin, async () => {
      // The contractor is not assigned to this new plant.
      const plant = (await one<{ id: string }>(db, `insert into public.projects (name, location) values ('New Plant', 'Unit 9') returning id`)).id;
      await expectError(db.query(`select public.admin_create_worker('Test Worker', $1, $2, '2026-01-01')`, [s.contractor, plant]), /not assigned to that plant/);
    });
    await asUser(db, s.other, () => expectError(db.query(`select public.attendance_policy_for($1, current_date)`, [s.siteA]), /not authorised for this plant/));
  });
});

describe("TypeScript and SQL agree", () => {
  it("on resolution and the edit window, including DST transitions", async () => {
    const db = await createDb();
    const admin = await createAuthUser(db, "admin@example.test", "Admin", "admin");
    const versions: AttendancePolicyVersion[] = [];
    // Policies are written as an admin; the internal functions are then compared as the database owner.
    const ids = await asUser(db, admin, async () => {
      const ny = (await one<{ id: string }>(db, `insert into public.projects (name, location, timezone) values ('New York test', 'NY', 'America/New_York') returning id`)).id;
      const ktm = (await one<{ id: string }>(db, `insert into public.projects (name, location, timezone) values ('Kathmandu test', 'KTM', 'Asia/Kathmandu') returning id`)).id;
      const add = async (cols: Record<string, unknown>) => {
        const keys = Object.keys(cols);
        await db.query(`insert into public.attendance_policies (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")})`, keys.map((k) => cols[k]));
      };
      await add({ effective_from: "2026-06-01", suggested_check_in: "08:00", break_minutes: 45, allow_overnight: false, in_future_tolerance_min: 45, out_future_tolerance_min: 2, operator_backdate_days: 1, auto_absent_enabled: true, edit_cutoff_time: "01:30", default_timezone: "Asia/Kolkata" });
      await add({ project_id: ny, effective_from: "2026-03-01", overridden: ["edit_cutoff_time", "operator_backdate_days"], edit_cutoff_time: "02:30", operator_backdate_days: 0 });
      await add({ project_id: ny, effective_from: "2026-10-01", overridden: ["suggested_check_in", "shift_start", "shift_end", "break_minutes"], suggested_check_in: null, shift_start: "22:00", shift_end: "06:00", break_minutes: null });
      await add({ project_id: ktm, effective_from: "2026-06-01", overridden: ["half_day_below_hours", "overtime_after_hours", "break_minutes", "night_suggested_check_in"], half_day_below_hours: 4.5, overtime_after_hours: 9.25, break_minutes: 30, night_suggested_check_in: "20:30" });
      return { ny, ktm };
    });
    const { ny, ktm } = ids;
    {
      for (const r of await rows(db, `select * from public.attendance_policies`)) versions.push(policyRow(r));

      for (const projectId of [ny, ktm, null]) {
        for (const date of ["2025-12-31", "2026-03-08", "2026-06-01", "2026-10-15", "2026-11-01"]) {
          const sql = await one<Record<string, unknown>>(db, `select (r).* from (select public.attendance_policy_resolve($1, $2::date) as r) x`, [projectId, date]);
          const ts = resolvePolicy(versions, projectId, date);
          expect({
            suggestedCheckIn: ts.suggestedCheckIn, nightSuggestedCheckIn: ts.nightSuggestedCheckIn, shiftStart: ts.shiftStart, breakMinutes: ts.breakMinutes, allowOvernight: ts.allowOvernight,
            inFutureToleranceMin: ts.inFutureToleranceMin, outFutureToleranceMin: ts.outFutureToleranceMin,
            halfDayBelowHours: ts.halfDayBelowHours, overtimeAfterHours: ts.overtimeAfterHours,
            operatorBackdateDays: ts.operatorBackdateDays, editCutoffTime: ts.editCutoffTime, autoAbsentEnabled: ts.autoAbsentEnabled,
            companyPolicyId: ts.companyPolicyId, sitePolicyId: ts.sitePolicyId,
          }).toEqual({
            suggestedCheckIn: sql.suggested_check_in ? String(sql.suggested_check_in).slice(0, 5) : null,
            nightSuggestedCheckIn: sql.night_suggested_check_in ? String(sql.night_suggested_check_in).slice(0, 5) : null,
            shiftStart: sql.shift_start ? String(sql.shift_start).slice(0, 5) : null,
            breakMinutes: sql.break_minutes,
            allowOvernight: sql.allow_overnight,
            inFutureToleranceMin: sql.in_future_tolerance_min,
            outFutureToleranceMin: sql.out_future_tolerance_min,
            halfDayBelowHours: sql.half_day_below_hours === null ? null : Number(sql.half_day_below_hours),
            overtimeAfterHours: sql.overtime_after_hours === null ? null : Number(sql.overtime_after_hours),
            operatorBackdateDays: sql.operator_backdate_days,
            editCutoffTime: sql.edit_cutoff_time ? String(sql.edit_cutoff_time).slice(0, 5) : null,
            autoAbsentEnabled: sql.auto_absent_enabled,
            companyPolicyId: sql.company_policy_id,
            sitePolicyId: sql.site_policy_id,
          });
        }
      }

      // The edit window, computed in SQL from today's policy, on DST and non-DST dates.
      const today = (tz: string) => one<{ d: string }>(db, `select to_char((now() at time zone $1)::date, 'YYYY-MM-DD') as d`, [tz]).then((r) => r.d);
      for (const [projectId, tz] of [[ny, "America/New_York"], [ktm, "Asia/Kathmandu"]] as const) {
        const policyToday = resolvePolicy(versions, projectId, await today(tz));
        for (const date of ["2026-03-07", "2026-03-08", "2026-10-31", "2026-11-01", "2026-12-15"]) {
          const sql = await one<{ t: Date }>(db, `select public.operator_edit_closes_at($1, $2::date) as t`, [projectId, date]);
          expect(new Date(sql.t).toISOString()).toBe(operatorEditClosesAt(policyToday, date, tz).toISOString());
        }
      }
    }
  });
});

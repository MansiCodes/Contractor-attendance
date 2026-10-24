import { beforeAll, describe, expect, it } from "vitest";
import { asUser, createAuthUser, createDb, type Db } from "./harness";

// These tests execute the production SQL migrations (schema, RLS, functions,
// storage policies) and verify the permissions are enforced by the database.

let db: Db;
let adminId: string;
let opA: string; // operator for project A
let opB: string; // operator for project B
let contractorId: string;
let projectA: string;
let projectB: string;
let workerA: string;

const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
const today = async () => (await one<{ d: string }>(`select to_char((now() at time zone 'Asia/Kolkata')::date, 'YYYY-MM-DD') as d`)).d;
const expectError = async (p: Promise<unknown>, match: RegExp) => {
  await expect(p).rejects.toThrow(match);
};

const item = (o: Record<string, unknown>) =>
  JSON.stringify([{ worker_id: workerA, contractor_id: contractorId, status: "present", check_in_at: null, check_out_at: null, check_in_source: "entered", method: "individual", expected_version: null, ...o }]);

beforeAll(async () => {
  db = await createDb();
  adminId = await createAuthUser(db, "admin@example.test", "Head Office Admin", "admin");
  opA = await createAuthUser(db, "a@example.test", "Operator A");
  opB = await createAuthUser(db, "b@example.test", "Operator B");

  await asUser(db, adminId, async () => {
    contractorId = (await one<{ id: string }>(`insert into public.contractors (name, location) values ('Test Labour Co', 'Jaipur, Rajasthan') returning id`)).id;
    projectA = (await one<{ id: string }>(`insert into public.projects (name, location) values ('Site A', 'Jaipur') returning id`)).id;
    projectB = (await one<{ id: string }>(`insert into public.projects (name, location) values ('Site B', 'Pune') returning id`)).id;
    for (const p of [projectA, projectB]) {
      await db.query(`insert into public.contractor_project_assignments (contractor_id, project_id, start_date) values ($1, $2, '2026-01-01')`, [contractorId, p]);
    }
    workerA = (await one<{ id: string }>(`select id from public.admin_create_worker('Ramesh Kumar', $1, $2, '2026-01-01')`, [contractorId, projectA])).id;
    await db.query(`select public.admin_create_worker('Suresh Yadav', $1, $2, '2026-01-01')`, [contractorId, projectB]);
    await db.query(`insert into public.site_operator_assignments (operator_id, project_id) values ($1, $2), ($3, $4)`, [opA, projectA, opB, projectB]);
  });
});

describe("migrations", () => {
  it("apply cleanly and create profiles for new auth users with safe default roles", async () => {
    const profiles = await rows<{ email: string; role: string }>(`select email, role from public.profiles order by email`);
    expect(profiles).toEqual([
      { email: "a@example.test", role: "operator" },
      { email: "admin@example.test", role: "admin" },
      { email: "b@example.test", role: "operator" },
      { email: "system@nf-attendance.invalid", role: "admin" }, // scheduled jobs; cannot sign in
    ]);
  });

  it("generates immutable worker IDs", async () => {
    const w = await one<{ worker_code: string }>(`select worker_code from public.workers where id = $1`, [workerA]);
    expect(w.worker_code).toMatch(/^W-\d{5}$/);
    await asUser(db, adminId, () => expectError(db.query(`update public.workers set worker_code = 'X' where id = $1`, [workerA]), /cannot be changed/));
  });
});

describe("1. operators cannot create or manage workers (database-enforced)", () => {
  it("blocks direct inserts and the admin RPCs", async () => {
    await asUser(db, opA, async () => {
      await expectError(db.query(`insert into public.workers (full_name, contractor_id) values ('Fake', $1)`, [contractorId]), /row-level security/);
      await expectError(db.query(`select public.admin_create_worker('Fake', $1, $2, '2026-01-01')`, [contractorId, projectA]), /forbidden/);
      await expectError(db.query(`select public.admin_deactivate_worker($1, '2026-02-01')`, [workerA]), /forbidden/);
      await expectError(db.query(`select public.admin_transfer_worker($1, $2, $3, '2026-02-01')`, [workerA, projectB, contractorId]), /forbidden/);
      const upd = await db.query(`update public.workers set full_name = 'Changed' where id = $1`, [workerA]);
      expect(upd.affectedRows ?? 0).toBe(0);
      await expectError(db.query(`delete from public.workers where id = $1`, [workerA]), /permission denied/);
    });
  });

  it("blocks operators from changing their own role or site access", async () => {
    await asUser(db, opA, async () => {
      const r = await db.query(`update public.profiles set role = 'admin' where id = $1`, [opA]);
      expect(r.affectedRows ?? 0).toBe(0);
      await expectError(db.query(`insert into public.site_operator_assignments (operator_id, project_id) values ($1, $2)`, [opA, projectB]), /row-level security/);
    });
    expect((await one<{ role: string }>(`select role from public.profiles where id = $1`, [opA])).role).toBe("operator");
  });
});

describe("2. operators only see and edit their own sites", () => {
  it("filters projects, workers and attendance by assignment", async () => {
    await asUser(db, opA, async () => {
      expect((await rows<{ name: string }>(`select name from public.projects`)).map((r) => r.name)).toEqual(["Site A"]);
      expect((await rows<{ full_name: string }>(`select full_name from public.workers`)).map((r) => r.full_name)).toEqual(["Ramesh Kumar"]);
    });
  });

  it("rejects attendance writes on another site, even through direct table access", async () => {
    const d = await today();
    await asUser(db, opB, async () => {
      await expectError(db.query(`select * from public.save_attendance($1, $2::date, $3::jsonb)`, [projectA, d, item({ status: "absent" })]), /forbidden/);
      await expectError(
        db.query(`insert into public.attendance_records (worker_id, project_id, contractor_id, work_date, status) values ($1, $2, $3, $4, 'absent')`, [workerA, projectA, contractorId, d]),
        // Refused by the write trigger's authorization check before any lookup (RLS would refuse it too).
        /forbidden/,
      );
    });
  });

  it("cannot read payment rules or audit logs", async () => {
    await asUser(db, adminId, () =>
      db.query(`insert into public.contractor_payment_rules (contractor_id, effective_from, rate_type, day_rate) values ($1, '2026-01-01', 'per_day', 650)`, [contractorId]),
    );
    await asUser(db, opA, async () => {
      expect(await rows(`select * from public.contractor_payment_rules`)).toHaveLength(0);
      expect(await rows(`select * from public.attendance_audit_logs`)).toHaveLength(0);
      await expectError(
        db.query(`insert into public.contractor_payment_rules (contractor_id, effective_from, rate_type, day_rate) values ($1, '2026-01-01', 'per_day', 1)`, [contractorId]),
        /row-level security/,
      );
    });
  });
});

describe("attendance writes, audit trail and integrity", () => {
  it("saves today's attendance for an authorised operator and writes an audit entry", async () => {
    const d = await today();
    // 09:00 IST, or now if it is earlier in the day: an IN ahead of the clock is refused by design.
    const nineAm = await one<{ t: string }>(`select least(($1::date + time '09:00') at time zone 'Asia/Kolkata', now())::text as t`, [d]);
    const saved = await asUser(db, opA, () =>
      rows<{ version: number; status: string; created_by: string }>(`select * from public.save_attendance($1, $2::date, $3::jsonb)`, [projectA, d, item({ check_in_at: nineAm.t, method: "bulk" })]),
    );
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ version: 1, status: "present", created_by: opA });

    const audit = await asUser(db, adminId, () => rows<{ action: string; method: string; changed_by: string; changed_by_role: string; old_values: unknown }>(`select * from public.attendance_audit_logs`));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "create", method: "bulk", changed_by: opA, changed_by_role: "operator", old_values: null });
  });

  it("rejects stale versions (concurrent edits) and keeps the batch atomic", async () => {
    const d = await today();
    await asUser(db, opA, async () => {
      await expectError(db.query(`select * from public.save_attendance($1, $2::date, $3::jsonb)`, [projectA, d, item({ status: "absent", expected_version: null })]), /conflict/);
      const r = await rows<{ version: number; status: string }>(`select * from public.save_attendance($1, $2::date, $3::jsonb)`, [projectA, d, item({ status: "absent", expected_version: 1 })]);
      expect(r[0]).toMatchObject({ version: 2, status: "absent" });
    });
    const audit = await asUser(db, adminId, () => rows<{ action: string; old_values: { status: string } }>(`select * from public.attendance_audit_logs order by id`));
    expect(audit.map((a) => a.action)).toEqual(["create", "update"]);
    expect(audit[1].old_values.status).toBe("present");
  });

  it("refuses OUT before IN, future OUT times and past dates for operators", async () => {
    const d = await today();
    await asUser(db, opA, async () => {
      // Fixed local times on the attendance date, so the checks do not depend on the
      // hour the suite runs (now ± hours can fall on another date near midnight).
      const at = (time: string) =>
        db.query<{ t: string }>(`select (($1::date + $2::time) at time zone 'Asia/Kolkata')::text as t`, [d, time]).then((r) => r.rows[0].t);
      const minutesLeftToday = (await one<{ m: number }>(`select extract(epoch from (($1::date + 1) - (now() at time zone 'Asia/Kolkata'))) / 60 as m`, [d])).m;
      await expectError(db.query(`select * from public.save_attendance($1, $2::date, $3::jsonb)`, [projectA, d, item({ check_in_at: await at("00:02"), check_out_at: await at("00:01"), expected_version: 2 })]), /attendance_out_after_in|check constraint/);
      // A future OUT on the same date exists only until a few minutes before midnight.
      if (minutesLeftToday > 10) {
        await expectError(db.query(`select * from public.save_attendance($1, $2::date, $3::jsonb)`, [projectA, d, item({ check_in_at: await at("00:02"), check_out_at: await at("23:59"), expected_version: 2 })]), /future/);
      }
      await expectError(db.query(`select * from public.save_attendance($1, ($2::date - 1), $3::jsonb)`, [projectA, d, item({ status: "absent" })]), /forbidden/);
    });
  });

  it("admins may correct past dates; nobody may delete attendance or edit the audit log", async () => {
    const d = await today();
    const r = await asUser(db, adminId, () => rows(`select * from public.save_attendance($1, ($2::date - 3), $3::jsonb)`, [projectA, d, item({ status: "absent" })]));
    expect(r).toHaveLength(1);
    await asUser(db, adminId, async () => {
      await expectError(db.query(`delete from public.attendance_records`), /permission denied/);
      await expectError(db.query(`update public.attendance_audit_logs set method = 'bulk'`), /permission denied/);
      await expectError(db.query(`delete from public.attendance_audit_logs`), /permission denied/);
    });
    // Even the table owner (service role) cannot rewrite history.
    await expectError(db.query(`delete from public.attendance_audit_logs`), /append-only/);
    await expectError(db.query(`delete from public.attendance_records`), /append-only/);
  });

  it("does not allow moving an attendance record to another project or date", async () => {
    await asUser(db, adminId, async () => {
      await expectError(db.query(`update public.attendance_records set project_id = $1 where worker_id = $2`, [projectB, workerA]), /cannot be changed/);
    });
  });

  it("only accepts attendance for workers assigned to the site on that date", async () => {
    const d = await today();
    const other = (await one<{ id: string }>(`select id from public.workers where full_name = 'Suresh Yadav'`)).id;
    await asUser(db, adminId, () =>
      expectError(db.query(`select * from public.save_attendance($1, $2::date, $3::jsonb)`, [projectA, d, item({ worker_id: other, status: "absent" })]), /not assigned/),
    );
  });
});

describe("11. transfers and assignment history", () => {
  it("closes the old assignment, opens the new one, and keeps past records at the old site", async () => {
    const d = await today();
    await asUser(db, adminId, async () => {
      await db.query(`select public.admin_transfer_worker($1, $2, $3, $4::date)`, [workerA, projectB, contractorId, d]);
    });
    const assignments = await rows<{ project_id: string; end_date: string | null }>(
      `select project_id, to_char(end_date, 'YYYY-MM-DD') as end_date from public.worker_project_assignments where worker_id = $1 order by start_date`,
      [workerA],
    );
    expect(assignments.map((a) => a.project_id)).toEqual([projectA, projectB]);
    expect(assignments[1].end_date).toBeNull();
    const recs = await rows<{ project_id: string }>(`select project_id from public.attendance_records where worker_id = $1`, [workerA]);
    expect(recs.every((r) => r.project_id === projectA)).toBe(true);
    // Operator A no longer sees the worker's future register, operator B does.
    await asUser(db, opB, async () => {
      expect((await rows<{ full_name: string }>(`select full_name from public.workers order by full_name`)).map((r) => r.full_name)).toContain("Ramesh Kumar");
    });
  });

  it("forbids overlapping assignments for the same worker", async () => {
    await asUser(db, adminId, () =>
      expectError(
        db.query(`insert into public.worker_project_assignments (worker_id, project_id, contractor_id, start_date) values ($1, $2, $3, '2026-03-01')`, [workerA, projectA, contractorId]),
        /worker_assignment_no_overlap|conflicting key/,
      ),
    );
  });
});

describe("12. payment rules are versioned and immutable", () => {
  it("numbers versions automatically and rejects edits", async () => {
    await asUser(db, adminId, async () => {
      await db.query(`insert into public.contractor_payment_rules (contractor_id, effective_from, rate_type, day_rate) values ($1, '2026-06-01', 'per_day', 700)`, [contractorId]);
      const versions = await rows<{ version: number; day_rate: string }>(`select version, day_rate::text from public.contractor_payment_rules order by version`);
      expect(versions).toEqual([{ version: 1, day_rate: "650.00" }, { version: 2, day_rate: "700.00" }]);
      await expectError(db.query(`update public.contractor_payment_rules set day_rate = 1`), /permission denied|append-only/);
    });
    await expectError(db.query(`update public.contractor_payment_rules set day_rate = 1`), /append-only/);
  });

  it("validates rule shape", async () => {
    await asUser(db, adminId, () =>
      expectError(db.query(`insert into public.contractor_payment_rules (contractor_id, effective_from, rate_type) values ($1, '2026-07-01', 'per_day')`, [contractorId]), /check constraint/),
    );
  });
});

describe("anonymous access and storage", () => {
  it("gives anonymous visitors nothing", async () => {
    await db.exec(`set role anon`);
    try {
      await expectError(db.query(`select * from public.workers`), /permission denied/);
      await expectError(db.query(`select * from public.attendance_records`), /permission denied/);
    } finally {
      await db.exec(`reset role`);
    }
  });

  it("only admins can upload contractor photos", async () => {
    await asUser(db, opA, () => expectError(db.query(`insert into storage.objects (bucket_id, name) values ('contractor-photos', 'x.jpg')`), /row-level security/));
    await asUser(db, adminId, () => db.query(`insert into storage.objects (bucket_id, name) values ('contractor-photos', 'x.jpg')`));
  });
});

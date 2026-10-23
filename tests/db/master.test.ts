import { beforeAll, describe, expect, it } from "vitest";
import { masterImportPayload } from "@/lib/server/store/supabase-mappers";
import { asUser, createAuthUser, createDb, type Db } from "./harness";

// Worker master data in the database: the atomic import RPC, employee ID rules,
// append-only pay terms that only admins can see, and first-plant assignment.

const one = async <T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
const rows = async <T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
const HASH = "a".repeat(64);

describe("worker master import (database)", () => {
  let db: Db;
  let admin: string;
  let op: string;
  let plant: string;
  let existingContractor: string;

  beforeAll(async () => {
    db = await createDb();
    admin = await createAuthUser(db, "admin@example.test", "Head Office Admin", "admin");
    op = await createAuthUser(db, "op@example.test", "Operator");
    await asUser(db, admin, async () => {
      existingContractor = (await one<{ id: string }>(db, `insert into public.contractors (name, location) values ('Existing Labour Co', 'Jaipur') returning id`)).id;
      plant = (await one<{ id: string }>(db, `insert into public.projects (name, location) values ('Plant A', 'Unit 1') returning id`)).id;
      await db.query(`insert into public.site_operator_assignments (operator_id, project_id) values ($1, $2)`, [op, plant]);
    });
  });

  const payload = (overrides: Partial<Parameters<typeof masterImportPayload>[0]> = {}) =>
    JSON.stringify(
      masterImportPayload({
        batch: { fileName: "master.xlsx", fileHash: HASH, summary: { totals: { create: 2 } }, expectedLastBatchId: null },
        contractors: [{ ref: "Gamma", name: "Gamma", legalName: "DELTA SINGH CONTRACTORS", identityStatus: "needs_review", identityNote: "Sheet and heading differ" }],
        creates: [
          {
            contractor: { ref: "Gamma" }, employeeCode: "0F 8003", fullName: "Test One", department: "PRODUCTION", designation: "HELPER", source: "master.xlsx · Gamma · row 6",
            payTerms: { effectiveFrom: "2026-09-01", rateAmount: 480, rateBasis: "daily", source: "master.xlsx · Gamma · row 6" },
          },
          {
            contractor: { id: existingContractor }, employeeCode: "SC1001", fullName: "Test Two", department: null, designation: null, source: "master.xlsx · Shukla · row 6",
            payTerms: { effectiveFrom: "2026-09-01", rateAmount: 26520, rateBasis: "unconfirmed", source: "master.xlsx · Shukla · row 6" },
          },
        ],
        updates: [],
        ...overrides,
      }),
    );

  it("operators cannot run the import", async () => {
    await expect(asUser(db, op, () => db.query(`select public.admin_import_worker_master($1::jsonb)`, [payload()]))).rejects.toThrow(/forbidden/);
  });

  it("creates contractors, workers (unassigned, exact IDs) and pay terms in one call", async () => {
    const res = await asUser(db, admin, () => one<{ r: { created: number; contractors: Record<string, string> } }>(db, `select public.admin_import_worker_master($1::jsonb) as r`, [payload()]));
    expect(res.r.created).toBe(2);
    const gamma = await one<{ legal_name: string; identity_status: string; location: string | null }>(db, `select * from public.contractors where id = $1`, [res.r.contractors.Gamma]);
    expect(gamma).toMatchObject({ legal_name: "DELTA SINGH CONTRACTORS", identity_status: "needs_review", location: null });
    const w = await one<{ id: string; employee_code: string; worker_code: string }>(db, `select * from public.workers where employee_code = '0F 8003'`);
    expect(w.worker_code).toMatch(/^W-\d{5}$/);
    expect((await rows(db, `select 1 from public.worker_project_assignments where worker_id = $1`, [w.id])).length).toBe(0);
    const terms = await one<{ version: number; rate_amount: string; rate_basis: string; created_by: string }>(db, `select * from public.worker_pay_terms where worker_id = $1`, [w.id]);
    expect(terms).toMatchObject({ version: 1, rate_basis: "daily", created_by: admin });
    expect(Number(terms.rate_amount)).toBe(480);
    expect((await rows(db, `select * from public.import_batches`)).length).toBe(1);
  });

  it("rolls back everything when one worker fails (duplicate employee ID for the contractor)", async () => {
    const before = await one<{ n: number }>(db, `select count(*)::int as n from public.workers`);
    const batches = await one<{ n: number }>(db, `select count(*)::int as n from public.import_batches`);
    const last = (await one<{ id: string }>(db, `select id from public.import_batches order by created_at desc, id desc limit 1`)).id;
    const dup = payload({
      batch: { fileName: "master.xlsx", fileHash: HASH, summary: {}, expectedLastBatchId: last },
      contractors: [],
      creates: [
        {
          contractor: { id: existingContractor }, employeeCode: "NEW1", fullName: "Would Be New", department: null, designation: null, source: "x",
          payTerms: { effectiveFrom: "2026-09-01", rateAmount: 1, rateBasis: "daily", source: "x" },
        },
        {
          contractor: { id: existingContractor }, employeeCode: "SC1001", fullName: "Duplicate", department: null, designation: null, source: "x",
          payTerms: { effectiveFrom: "2026-09-01", rateAmount: 1, rateBasis: "daily", source: "x" },
        },
      ],
    });
    await expect(asUser(db, admin, () => db.query(`select public.admin_import_worker_master($1::jsonb)`, [dup]))).rejects.toThrow(/duplicate key|unique/i);
    expect((await one<{ n: number }>(db, `select count(*)::int as n from public.workers`)).n).toBe(before.n);
    expect((await one<{ n: number }>(db, `select count(*)::int as n from public.import_batches`)).n).toBe(batches.n);
  });

  it("refuses a second apply of the same preview, and an update to a worker changed since the preview", async () => {
    // The first test already applied payload() (expected: no earlier import). Replaying it must not create a second contractor.
    const contractors = (await one<{ n: number }>(db, `select count(*)::int as n from public.contractors`)).n;
    await expect(asUser(db, admin, () => db.query(`select public.admin_import_worker_master($1::jsonb)`, [payload()]))).rejects.toThrow(/another import was applied/);
    expect((await one<{ n: number }>(db, `select count(*)::int as n from public.contractors`)).n).toBe(contractors);

    const last = (await one<{ id: string }>(db, `select id from public.import_batches order by created_at desc, id desc limit 1`)).id;
    const w = await one<{ id: string }>(db, `select id from public.workers where employee_code = 'SC1001'`);
    const update = (expectedName: string) =>
      payload({
        batch: { fileName: "master.xlsx", fileHash: HASH, summary: {}, expectedLastBatchId: last },
        contractors: [],
        creates: [],
        updates: [{ workerId: w.id, expected: { fullName: expectedName, department: null, designation: null, termsVersion: 1 }, fields: { fullName: "Renamed", department: null, designation: null }, payTerms: null }],
      });
    await expect(asUser(db, admin, () => db.query(`select public.admin_import_worker_master($1::jsonb)`, [update("Someone Else")]))).rejects.toThrow(/changed after this preview/);
    expect((await one<{ full_name: string }>(db, `select full_name from public.workers where id = $1`, [w.id])).full_name).toBe("Test Two");
  });

  it("a pay terms change based on an older version is refused instead of reverting a newer one", async () => {
    const w = await one<{ id: string }>(db, `select id from public.workers where employee_code = 'SC1001'`);
    await expect(
      asUser(db, admin, () =>
        db.query(`insert into public.worker_pay_terms (worker_id, version, effective_from, rate_basis, based_on_version) values ($1, 0, '2026-09-15', 'daily', 0)`, [w.id]),
      ),
    ).rejects.toThrow(/changed meanwhile/);
  });

  it("the same employee ID may exist at a different contractor, and IDs keep inner spaces", async () => {
    await asUser(db, admin, () =>
      db.query(`insert into public.workers (full_name, contractor_id, employee_code) values ('Other Co Worker', $1, '0F 8003')`, [existingContractor]),
    );
    await expect(asUser(db, admin, () => db.query(`insert into public.workers (full_name, contractor_id, employee_code) values ('Padded', $1, ' X1 ')`, [existingContractor]))).rejects.toThrow(
      /check constraint/,
    );
  });

  it("pay terms are admin-only, append-only, and cannot go back in time", async () => {
    const w = await one<{ id: string }>(db, `select id from public.workers where employee_code = 'SC1001'`);
    expect(await asUser(db, op, () => rows(db, `select * from public.worker_pay_terms`))).toEqual([]);
    expect(await asUser(db, op, () => rows(db, `select * from public.import_batches`))).toEqual([]);
    await expect(asUser(db, op, () => db.query(`insert into public.worker_pay_terms (worker_id, version, effective_from, rate_basis) values ($1, 0, '2026-10-01', 'daily')`, [w.id]))).rejects.toThrow();
    await expect(asUser(db, admin, () => db.query(`update public.worker_pay_terms set rate_amount = 1 where worker_id = $1`, [w.id]))).rejects.toThrow(/append-only|permission/);
    await expect(
      asUser(db, admin, () => db.query(`insert into public.worker_pay_terms (worker_id, version, effective_from, rate_basis) values ($1, 0, '2026-08-01', 'monthly')`, [w.id])),
    ).rejects.toThrow(/already exist/);
    const v2 = await asUser(db, admin, () =>
      one<{ version: number }>(db, `insert into public.worker_pay_terms (worker_id, version, effective_from, rate_amount, rate_basis) values ($1, 0, '2026-10-01', 26520, 'monthly') returning version`, [w.id]),
    );
    expect(v2.version).toBe(2);
  });

  it("assigns unassigned workers only where the contractor is on the plant, and only once", async () => {
    const w = await one<{ id: string }>(db, `select id from public.workers where employee_code = 'SC1001'`);
    await expect(asUser(db, admin, () => db.query(`select public.admin_assign_workers(array[$1]::uuid[], $2, '2026-10-20')`, [w.id, plant]))).rejects.toThrow(/not assigned to that plant/);
    await asUser(db, admin, () => db.query(`insert into public.contractor_project_assignments (contractor_id, project_id, start_date) values ($1, $2, '2026-10-01')`, [existingContractor, plant]));
    await expect(asUser(db, op, () => db.query(`select public.admin_assign_workers(array[$1]::uuid[], $2, '2026-10-20')`, [w.id, plant]))).rejects.toThrow(/forbidden/);
    const n = await asUser(db, admin, () => one<{ n: number }>(db, `select public.admin_assign_workers(array[$1]::uuid[], $2, '2026-10-20') as n`, [w.id, plant]));
    expect(n.n).toBe(1);
    await expect(asUser(db, admin, () => db.query(`select public.admin_assign_workers(array[$1]::uuid[], $2, '2026-10-21')`, [w.id, plant]))).rejects.toThrow(/already has a plant/);
    // Now visible to the plant's operator, with the employee ID.
    const seen = await asUser(db, op, () => rows<{ employee_code: string }>(db, `select employee_code from public.workers`));
    expect(seen.map((r) => r.employee_code)).toEqual(["SC1001"]);
  });

  it("admin_create_worker stores the employee ID, department and designation", async () => {
    const w = await asUser(db, admin, () =>
      one<{ employee_code: string; department: string; designation: string }>(
        db,
        `select * from public.admin_create_worker('New Hire', $1, $2, '2026-10-20', null, null, 'SC2002', 'PRODUCTION', 'OPERATOR')`,
        [existingContractor, plant],
      ),
    );
    expect(w).toMatchObject({ employee_code: "SC2002", department: "PRODUCTION", designation: "OPERATOR" });
  });
});

import { beforeAll, describe, expect, it } from "vitest";
import { asUser, createAuthUser, createDb, type Db } from "./harness";

// WhatsApp tables: admin-only access, one message per idempotency key, claiming
// for a single dispatcher, forward-only statuses, and the consent history.

const one = async <T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
const rows = async <T = Record<string, unknown>>(db: Db, sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;

describe("whatsapp messaging (database)", () => {
  let db: Db;
  let admin: string;
  let op: string;
  let worker: string;
  let attendance: string;

  beforeAll(async () => {
    db = await createDb();
    admin = await createAuthUser(db, "admin@example.test", "Admin", "admin");
    op = await createAuthUser(db, "op@example.test", "Operator");
    ({ worker, attendance } = await asUser(db, admin, async () => {
      const c = (await one<{ id: string }>(db, `insert into public.contractors (name) values ('Msg Co') returning id`)).id;
      const p = (await one<{ id: string }>(db, `insert into public.projects (name, location) values ('Plant', 'U1') returning id`)).id;
      await db.query(`insert into public.contractor_project_assignments (contractor_id, project_id, start_date) values ($1, $2, '2026-01-01')`, [c, p]);
      await db.query(`insert into public.site_operator_assignments (operator_id, project_id) values ($1, $2)`, [op, p]);
      const w = (await one<{ id: string }>(db, `select id from public.admin_create_worker('Msg Worker', $1, $2, '2026-01-01')`, [c, p])).id;
      const a = (
        await one<{ id: string }>(
          db,
          `select id from public.save_attendance($1, ((now() at time zone 'Asia/Kolkata')::date - 1), jsonb_build_array(jsonb_build_object('worker_id', $2::text, 'contractor_id', $3::text, 'status', 'absent', 'method', 'individual')))`,
          [p, w, c],
        )
      ).id;
      return { worker: w, attendance: a };
    }));
  });

  it("only admins can see or change contacts, settings and messages", async () => {
    await asUser(db, admin, () =>
      db.query(`insert into public.worker_contacts (worker_id, whatsapp_number, enabled, consent_status, consent_at, consent_source) values ($1, '9876543210', true, 'granted', now(), 'Signed form')`, [worker]),
    );
    expect(await asUser(db, op, () => rows(db, `select * from public.worker_contacts`))).toEqual([]);
    await expect(asUser(db, op, () => db.query(`insert into public.messaging_settings (start_date) values (current_date)`))).rejects.toThrow();
    await expect(asUser(db, op, () => db.query(`select * from public.outbound_messages`))).resolves.toBeTruthy();
    expect(await asUser(db, op, () => rows(db, `select * from public.outbound_messages`))).toEqual([]);
    await expect(asUser(db, op, () => db.query(`select public.messaging_claim_due(now(), 10)`))).resolves.toBeTruthy(); // sees and claims nothing (RLS)
  });

  it("consent needs when and how, and every change is kept", async () => {
    await expect(
      asUser(db, admin, () => db.query(`update public.worker_contacts set consent_status = 'granted', consent_source = null where worker_id = $1`, [worker])),
    ).rejects.toThrow(/consent_recorded/);
    await asUser(db, admin, () => db.query(`update public.worker_contacts set consent_status = 'withdrawn', consent_source = 'Asked to stop' where worker_id = $1`, [worker]));
    const events = await asUser(db, admin, () => rows<{ consent_status: string }>(db, `select consent_status from public.worker_consent_events where worker_id = $1 order by id`, [worker]));
    expect(events.map((e) => e.consent_status)).toEqual(["granted", "withdrawn"]);
    await expect(asUser(db, admin, () => db.query(`delete from public.worker_consent_events`))).rejects.toThrow();
  });

  it("the same idempotency key is stored once; claiming hands each message to one caller", async () => {
    const insert = (key: string) =>
      asUser(db, admin, () =>
        db.query(
          `insert into public.outbound_messages (idempotency_key, kind, worker_id, attendance_id, attendance_version, to_number, language, template_name, body)
           values ($1, 'attendance', $2, $3, 1, '+919876543210', 'hi', 'attendance_summary_hi', 'text') on conflict (idempotency_key) do nothing`,
          [key, worker, attendance],
        ),
      );
    await insert(`att:${attendance}`);
    await insert(`att:${attendance}`);
    expect((await asUser(db, admin, () => rows(db, `select * from public.outbound_messages`))).length).toBe(1);
    const first = await asUser(db, admin, () => rows<{ status: string; attempts: number }>(db, `select * from public.messaging_claim_due(now(), 10)`));
    expect(first).toMatchObject([{ status: "sending", attempts: 1 }]);
    expect(await asUser(db, admin, () => rows(db, `select * from public.messaging_claim_due(now(), 10)`))).toEqual([]);
  });

  it("delivery statuses only move forward and are logged", async () => {
    await asUser(db, admin, () => db.query(`update public.outbound_messages set status = 'sent', provider_message_id = 'wamid.X'`));
    const apply = (s: string) => asUser(db, admin, () => one<{ ok: boolean }>(db, `select public.messaging_apply_status('wamid.X', $1, now(), null, '{}') as ok`, [s]));
    expect((await apply("read")).ok).toBe(true);
    await apply("delivered");
    expect((await one<{ status: string }>(db, `select status from public.outbound_messages`)).status).toBe("read");
    expect((await apply("delivered")).ok).toBe(true);
    expect((await one<{ n: number }>(db, `select count(*)::int as n from public.message_status_events`)).n).toBe(3);
  });

  it("a failure after sent is final, and statuses that arrived early are replayed", async () => {
    const apply = (s: string) => asUser(db, admin, () => db.query(`select public.messaging_apply_status('wamid.X', $1, now(), 'Undeliverable', '{}')`, [s]));
    await apply("failed");
    await apply("sent");
    await apply("read");
    expect((await one<{ status: string }>(db, `select status from public.outbound_messages where provider_message_id = 'wamid.X'`)).status).toBe("failed");

    await asUser(db, admin, () =>
      db.query(`insert into public.outbound_messages (idempotency_key, kind, to_number, language, template_name, body, status) values ('test:early', 'test', '+919876543210', 'en', 'attendance_summary_hi', 'x', 'sending')`),
    );
    const early = await asUser(db, admin, () => one<{ ok: boolean }>(db, `select public.messaging_apply_status('wamid.E', 'delivered', now(), null, '{}') as ok`));
    expect(early.ok).toBe(false); // no message has that id yet; the status is logged
    await asUser(db, admin, async () => {
      await db.query(`update public.outbound_messages set status = 'sent', provider_message_id = 'wamid.E' where idempotency_key = 'test:early'`);
      await db.query(`select public.messaging_replay_statuses('wamid.E')`);
    });
    expect((await one<{ status: string }>(db, `select status from public.outbound_messages where idempotency_key = 'test:early'`)).status).toBe("delivered");
  });

  it("a message stuck in sending is marked failed, never re-sent automatically", async () => {
    await asUser(db, admin, () =>
      db.query(
        `insert into public.outbound_messages (idempotency_key, kind, to_number, language, template_name, body, status, updated_at)
         values ('test:stuck', 'test', '+919876543210', 'en', 'attendance_summary_hi', 'x', 'sending', now() - interval '1 hour')`,
      ),
    );
    await asUser(db, admin, () => db.query(`select public.messaging_claim_due(now(), 10)`));
    expect((await one<{ status: string }>(db, `select status from public.outbound_messages where idempotency_key = 'test:stuck'`)).status).toBe("failed");
  });
});

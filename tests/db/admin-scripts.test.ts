import { execFile } from "node:child_process";
import { createHash, createHmac, pbkdf2Sync } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyPassword } from "@/lib/server/auth/password";
import { signIn } from "@/lib/server/auth/service";
import type { Database, Queryable } from "@/lib/server/db/database";
import { hashPassword as scriptHash } from "../../scripts/lib/password.mjs";

// The admin scripts used on AWS (scripts/db/migrate.mjs, scripts/create-admin.mjs),
// run as separate processes over the PostgreSQL protocol against a throwaway
// in-memory database. RDS itself (TLS, a non-superuser owner, the runtime login
// signing in with its password) is checked only once an RDS database exists.

function run(script: string, args: string[], env: Record<string, string>) {
  return new Promise<{ code: number; out: string }>((resolve) => {
    execFile(process.execPath, [script, ...args], { env: { ...process.env, ...env }, cwd: process.cwd(), timeout: 120_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}` }),
    );
  });
}

describe("admin scripts against PostgreSQL", () => {
  let db: PGlite;
  let server: PGLiteSocketServer;
  let env: Record<string, string>;
  const TARGET = "127.0.0.1/postgres";

  beforeAll(async () => {
    db = await PGlite.create({ extensions: { btree_gist }, parsers: { 1082: (v: string) => v } });
    server = new PGLiteSocketServer({ db, host: "127.0.0.1", port: 0, maxConnections: 1 });
    await server.start();
    env = { MIGRATION_DATABASE_URL: `postgres://postgres@${server.getServerConn()}/postgres`, DATABASE_SSL: "disable" };
  });
  afterAll(async () => {
    await server?.stop();
    await db?.close();
  });

  it("the script hashing matches the app's", async () => {
    const hash = await scriptHash("Plant-office-2026");
    expect(await verifyPassword("Plant-office-2026", hash)).toBe(true);
    expect(await verifyPassword("plant-office-2026", hash)).toBe(false);
  });

  it("plans without changing anything, and applies only to the confirmed target", async () => {
    const plan = await run("scripts/db/migrate.mjs", [], env);
    expect(plan.code).toBe(0);
    expect(plan.out).toContain("platform/bootstrap.sql");
    expect(plan.out).toContain("Nothing was changed");
    expect((await db.query("select to_regclass('public.profiles') as t")).rows[0]).toEqual({ t: null });

    const wrong = await run("scripts/db/migrate.mjs", ["--apply", "--confirm-target", "other-host/postgres"], env);
    expect(wrong.code).toBe(1);
    expect(wrong.out).toContain(`--confirm-target must be exactly "${TARGET}"`);
    expect((await db.query("select to_regclass('platform.schema_migrations') as t")).rows[0]).toEqual({ t: null });

    const applied = await run("scripts/db/migrate.mjs", ["--apply", "--confirm-target", TARGET], env);
    expect(applied.out).toMatch(/Applied 13 file\(s\)/);
    expect(applied.code).toBe(0);
    const ledger = await db.query<{ name: string }>("select name from platform.schema_migrations order by name");
    expect(ledger.rows[0].name).toBe("20261020000001_schema.sql");
    expect(ledger.rows.map((r) => r.name)).toContain("platform/bootstrap.sql");

    const again = await run("scripts/db/migrate.mjs", ["--apply", "--confirm-target", TARGET], env);
    expect(again.code).toBe(0);
    expect(again.out).toContain("Pending:  none");
  });

  it("refuses an applied migration that was edited later", async () => {
    const real = (await db.query<{ checksum: string }>("select checksum from platform.schema_migrations where name = '20261023000004_shifts.sql'")).rows[0].checksum;
    await db.query("update platform.schema_migrations set checksum = repeat('0', 64) where name = '20261023000004_shifts.sql'");
    const res = await run("scripts/db/migrate.mjs", [], env);
    expect(res.code).toBe(1);
    expect(res.out).toContain("changed since they ran: 20261023000004_shifts.sql");
    await db.query("update platform.schema_migrations set checksum = $1 where name = '20261023000004_shifts.sql'", [real]);
  });

  it("creates the runtime login with no rights of its own and a SCRAM password", async () => {
    const password = "rt-" + "x7Kp2".repeat(6);
    const res = await run("scripts/db/migrate.mjs", ["--apply", "--confirm-target", TARGET, "--runtime-role"], { ...env, DB_RUNTIME_USER: "nf_app", DB_RUNTIME_PASSWORD: password });
    expect(res.out).toContain("Runtime login nf_app created");
    expect(res.out).not.toContain(password);
    const role = (
      await db.query<{ rolinherit: boolean; rolsuper: boolean; rolbypassrls: boolean; rolpassword: string; auth: boolean; app_auth: boolean }>(
        `select rolinherit, rolsuper, rolbypassrls, rolpassword,
                pg_has_role('nf_app', 'authenticated', 'MEMBER') as auth, pg_has_role('nf_app', 'app_auth', 'MEMBER') as app_auth
           from pg_authid where rolname = 'nf_app'`,
      )
    ).rows[0];
    expect(role).toMatchObject({ rolinherit: false, rolsuper: false, rolbypassrls: false, auth: true, app_auth: true });
    // The stored verifier belongs to the password itself (PostgreSQL did not re-hash the text it was sent).
    const [, iterations, salt, storedKey] = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):/.exec(role.rolpassword)!;
    const salted = pbkdf2Sync(password, Buffer.from(salt, "base64"), Number(iterations), 32, "sha256");
    const expected = createHash("sha256").update(createHmac("sha256", salted).update("Client Key").digest()).digest("base64");
    expect(storedKey).toBe(expected);
  });

  it("creates the first admin from a precomputed hash, who must then change the password", async () => {
    const hash = await scriptHash("First-admin-2026");
    const res = await run("scripts/create-admin.mjs", ["Owner@NF.test", "Plant Owner"], { ...env, ADMIN_PASSWORD_HASH: hash });
    expect(res.out).toContain("Admin ready: owner@nf.test");
    expect(res.code).toBe(0);
    expect(res.out).not.toContain(hash);
    const again = await run("scripts/create-admin.mjs", ["owner@nf.test", "Plant Owner"], { ...env, ADMIN_PASSWORD_HASH: hash });
    expect(again.code).toBe(1);
    expect(again.out).toContain("already exists");

    const database: Database = { transaction: (fn) => db.transaction((tx) => fn(tx as unknown as Queryable)) };
    const signedIn = await signIn(database, "owner@nf.test", "First-admin-2026");
    expect(signedIn).toMatchObject({ ok: true, mustChangePassword: true });
    const profile = (await db.query<{ role: string; is_active: boolean; full_name: string }>("select role, is_active, full_name from public.profiles p join auth.users u using (id) where u.email = 'owner@nf.test'")).rows[0];
    expect(profile).toEqual({ role: "admin", is_active: true, full_name: "Plant Owner" });
  });
});

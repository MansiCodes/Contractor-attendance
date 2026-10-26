import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";

// Runs the real migrations against an in-process Postgres (PGlite), after the same
// platform bootstrap that is applied to Amazon RDS (db/platform/bootstrap.sql).

export const BOOTSTRAP_FILE = join(process.cwd(), "db", "platform", "bootstrap.sql");

export const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

/**
 * A fresh database with the migrations applied. `until` stops after the migration
 * whose file name starts with that prefix, so upgrade tests can add legacy data first
 * and then call applyMigrations({ after }).
 */
export async function createDb(opts: { until?: string } = {}) {
  // Dates stay "yyyy-MM-dd" strings, as the app's PostgreSQL driver is configured to return them.
  const db = new PGlite({ extensions: { btree_gist }, parsers: { 1082: (v: string) => v } });
  await db.exec(readFileSync(BOOTSTRAP_FILE, "utf8"));
  await applyMigrations(db, { until: opts.until });
  return db;
}

export type Db = PGlite;

export async function applyMigrations(db: Db, opts: { after?: string; until?: string } = {}) {
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    const id = file.split("_")[0];
    if (opts.after && id <= opts.after) continue;
    if (opts.until && id > opts.until) continue;
    try {
      await db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    } catch (e) {
      throw new Error(`Migration ${file} failed: ${(e as Error).message}`);
    }
  }
}

/** Runs `fn` as a signed-in user (role authenticated, so RLS applies). */
export async function asUser<T>(db: Db, userId: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`select set_config('request.jwt.claim.sub', '${userId}', false); set role authenticated;`);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
  }
}

export async function createAuthUser(db: Db, email: string, fullName: string, role?: "admin") {
  const res = await db.query<{ id: string }>(
    `insert into auth.users (email, raw_user_meta_data, raw_app_meta_data) values ($1, $2, $3) returning id`,
    [email, JSON.stringify({ full_name: fullName }), JSON.stringify(role ? { role } : {})],
  );
  return res.rows[0].id;
}

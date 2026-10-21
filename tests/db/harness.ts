import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";

// Runs the real Supabase migrations against an in-process Postgres (PGlite).
// A minimal shim stands in for Supabase's `auth` and `storage` schemas and roles.

const SHIM = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb not null default '{}',
  raw_app_meta_data jsonb not null default '{}'
);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
create schema storage;
create table storage.buckets (id text primary key, name text not null, public boolean default false);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text, owner uuid);
alter table storage.objects enable row level security;
grant usage on schema storage to authenticated;
grant select, insert, update, delete on storage.objects to authenticated;
`;

export const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

/**
 * A fresh database with the migrations applied. `until` stops after the migration
 * whose file name starts with that prefix, so upgrade tests can add legacy data first
 * and then call applyMigrations({ after }).
 */
export async function createDb(opts: { until?: string } = {}) {
  const db = new PGlite({ extensions: { btree_gist } });
  await db.exec(SHIM);
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

/** Runs `fn` as an authenticated Supabase user (RLS applies). */
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

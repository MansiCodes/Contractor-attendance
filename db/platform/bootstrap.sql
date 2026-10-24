-- Platform objects the migrations rely on, for plain PostgreSQL (Amazon RDS, a local
-- PostgreSQL, or PGlite in tests). Supabase used to provide these; nothing else in
-- the migrations is Supabase-specific.
--
-- - Roles: `authenticated` is the role every signed-in request runs as (the server
--   sets it per transaction together with the user's id, so Row Level Security keeps
--   applying exactly as before). `anon` and `service_role` are kept only because the
--   migrations grant and revoke on them; nothing logs in as either.
-- - auth.users: one row per account; auth.uid(): the id of the user the current
--   transaction acts for (set by the server with set_config, local to the transaction).
-- - storage.*: only so the original storage migration applies. Files live in S3.
--
-- Run before the migrations, as the database owner. Safe to run more than once.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end;
$$;

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb not null default '{}',
  raw_app_meta_data jsonb not null default '{}'
);

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;

create schema if not exists storage;
create table if not exists storage.buckets (id text primary key, name text not null, public boolean default false);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid
);
alter table storage.objects enable row level security;
grant usage on schema storage to authenticated;
grant select, insert, update, delete on storage.objects to authenticated;

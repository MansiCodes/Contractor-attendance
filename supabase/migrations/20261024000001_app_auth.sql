-- App-managed sign-in, replacing Supabase Auth (which is not available on Amazon RDS).
--
-- What stays the same: one auth.users row per account, a profile per account with
-- its role (admin / operator), plant access in site_operator_assignments, and Row
-- Level Security on every table. Accounts are created only by admins; there is no
-- self-registration.
--
-- What is new:
-- 1. Passwords: scrypt hashes computed by the app server, stored in auth.users.
--    Five wrong passwords lock the account for 15 minutes.
-- 2. Sessions: a random token in an httpOnly cookie; only its SHA-256 is stored.
--    Sessions end on sign-out, on expiry, on a password change or reset, and when
--    the profile is deactivated.
-- 3. A sign-in role, app_auth, that can only call the sign-in functions below. No
--    request role can read password hashes or session tokens.
-- 4. A system account (an admin profile that cannot sign in) for the scheduled
--    WhatsApp dispatcher and the provider webhook, so those jobs run under Row Level
--    Security too instead of bypassing it.

-- ---------------------------------------------------------------------------
-- 1. Credentials
-- ---------------------------------------------------------------------------
alter table auth.users
  add column if not exists password_hash text,
  add column if not exists must_change_password boolean not null default false,
  add column if not exists failed_attempts integer not null default 0,
  add column if not exists locked_until timestamptz,
  add column if not exists password_changed_at timestamptz,
  add column if not exists created_at timestamptz not null default now();

alter table auth.users
  add constraint auth_users_password_hash_format check (password_hash is null or password_hash like 'scrypt$%');
create unique index auth_users_email_uniq on auth.users (lower(btrim(email)));

-- ---------------------------------------------------------------------------
-- 2. Sessions
-- ---------------------------------------------------------------------------
create table auth.sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id),
  token_hash bytea not null unique check (octet_length(token_hash) = 32),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  user_agent text check (user_agent is null or char_length(user_agent) <= 300),
  ip text check (ip is null or char_length(ip) <= 64)
);
create index auth_sessions_user_idx on auth.sessions (user_id) where revoked_at is null;

-- Neither request role sees credentials or sessions.
revoke all on auth.users, auth.sessions from public, anon, authenticated, service_role;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_auth') then
    create role app_auth nologin;
  end if;
end;
$$;
grant usage on schema auth to app_auth;

-- ---------------------------------------------------------------------------
-- 3. Sign-in functions (called by the server as app_auth)
-- ---------------------------------------------------------------------------

-- The stored hash and account state for an email. The server checks the password.
create or replace function auth.sign_in_lookup(p_email text)
returns table (user_id uuid, password_hash text, locked_until timestamptz, is_active boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select u.id, u.password_hash, u.locked_until, coalesce(p.is_active, false)
  from auth.users u
  left join public.profiles p on p.id = u.id
  where lower(btrim(u.email)) = lower(btrim(p_email));
$$;

-- A wrong password. The fifth in a row locks the account for 15 minutes.
create or replace function auth.sign_in_failed(p_user_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_locked timestamptz;
begin
  update auth.users
     set failed_attempts = case when failed_attempts + 1 >= 5 then 0 else failed_attempts + 1 end,
         locked_until = case when failed_attempts + 1 >= 5 then now() + interval '15 minutes' else locked_until end
   where id = p_user_id
  returning locked_until into v_locked;
  return v_locked;
end;
$$;

-- A correct password: clears failures and starts a session. p_password_hash is the
-- stored hash the server just verified. The row is locked and compared, so a password
-- changed or reset meanwhile (which ends existing sessions) cannot be followed by a
-- new session for the old password: nothing is returned and the sign-in fails.
create or replace function auth.sign_in_succeeded(p_user_id uuid, p_password_hash text, p_token_hash bytea, p_ttl_seconds integer, p_user_agent text, p_ip text)
returns table (session_id uuid, expires_at timestamptz, must_change_password boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session uuid;
  v_expires timestamptz := now() + make_interval(secs => greatest(60, least(p_ttl_seconds, 30 * 86400)));
  v_must boolean;
  v_hash text;
begin
  select u.password_hash into v_hash from auth.users u where u.id = p_user_id for update;
  if not found or v_hash is null or v_hash is distinct from p_password_hash then
    return; -- the credential changed after it was checked
  end if;
  if not exists (select 1 from public.profiles p where p.id = p_user_id and p.is_active) then
    raise exception 'forbidden: this account is not active';
  end if;
  update auth.users set failed_attempts = 0, locked_until = null where id = p_user_id returning auth.users.must_change_password into v_must;
  insert into auth.sessions (user_id, token_hash, expires_at, user_agent, ip)
  values (p_user_id, p_token_hash, v_expires, left(p_user_agent, 300), left(p_ip, 64))
  returning id into v_session;
  return query select v_session, v_expires, v_must;
end;
$$;

-- The account behind a session token, if the session is live and the profile active.
create or replace function auth.session_user(p_token_hash bytea)
returns table (user_id uuid, session_id uuid, must_change_password boolean, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session auth.sessions;
begin
  select s.* into v_session
    from auth.sessions s
    join public.profiles p on p.id = s.user_id and p.is_active
   where s.token_hash = p_token_hash and s.revoked_at is null and s.expires_at > now();
  if not found then
    return;
  end if;
  if v_session.last_seen_at < now() - interval '5 minutes' then
    update auth.sessions set last_seen_at = now() where id = v_session.id;
  end if;
  return query
    select v_session.user_id, v_session.id, u.must_change_password, v_session.expires_at
      from auth.users u where u.id = v_session.user_id;
end;
$$;

create or replace function auth.end_session(p_token_hash bytea)
returns void
language sql
security definer
set search_path = ''
as $$
  update auth.sessions set revoked_at = now() where token_hash = p_token_hash and revoked_at is null;
$$;

-- ---------------------------------------------------------------------------
-- 4. Password changes and accounts (called as the signed-in user: auth.uid())
-- ---------------------------------------------------------------------------

-- The signed-in user's own new password (the server has checked the current one).
-- Other sessions of the user end; the current one stays.
create or replace function auth.change_own_password(p_password_hash text, p_keep_session uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'forbidden: please sign in again';
  end if;
  update auth.users
     set password_hash = p_password_hash, must_change_password = false, password_changed_at = now(),
         failed_attempts = 0, locked_until = null
   where id = auth.uid();
  update auth.sessions set revoked_at = now()
   where user_id = auth.uid() and revoked_at is null and id is distinct from p_keep_session;
end;
$$;

-- An admin creates an account. The profile follows from the insert (handle_new_user).
create or replace function auth.admin_create_account(p_email text, p_full_name text, p_role public.app_role, p_password_hash text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform public.assert_admin();
  if exists (select 1 from auth.users u where lower(btrim(u.email)) = lower(btrim(p_email))) then
    raise exception 'conflict: a user with this email already exists';
  end if;
  insert into auth.users (email, raw_user_meta_data, raw_app_meta_data, password_hash, must_change_password)
  values (
    lower(btrim(p_email)),
    jsonb_build_object('full_name', btrim(p_full_name)),
    jsonb_build_object('role', p_role::text),
    p_password_hash,
    true
  )
  returning id into v_id;
  return v_id;
end;
$$;

-- An admin sets a temporary password; the user must change it at the next sign-in.
create or replace function auth.admin_reset_password(p_user_id uuid, p_password_hash text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_admin();
  update auth.users
     set password_hash = p_password_hash, must_change_password = true, password_changed_at = now(),
         failed_attempts = 0, locked_until = null
   where id = p_user_id;
  if not found then
    raise exception 'invalid: user not found';
  end if;
  update auth.sessions set revoked_at = now() where user_id = p_user_id and revoked_at is null;
end;
$$;

-- Deactivating a profile ends its sessions at once.
create or replace function public.profiles_end_sessions()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.is_active and not new.is_active then
    update auth.sessions set revoked_at = now() where user_id = new.id and revoked_at is null;
  end if;
  return new;
end;
$$;
create trigger profiles_end_sessions after update of is_active on public.profiles
  for each row execute function public.profiles_end_sessions();

-- ---------------------------------------------------------------------------
-- 5. System account for scheduled jobs (cannot sign in: no password, invalid email)
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, raw_user_meta_data, raw_app_meta_data)
values (
  '00000000-0000-4000-8000-000000000001',
  'system@nf-attendance.invalid',
  '{"full_name": "System (scheduled jobs)"}',
  '{"role": "admin"}'
);

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
revoke execute on function
  auth.sign_in_lookup(text), auth.sign_in_failed(uuid), auth.sign_in_succeeded(uuid, text, bytea, integer, text, text),
  auth.session_user(bytea), auth.end_session(bytea), auth.change_own_password(text, uuid),
  auth.admin_create_account(text, text, public.app_role, text), auth.admin_reset_password(uuid, text),
  public.profiles_end_sessions()
from public, anon, authenticated, service_role;
grant execute on function
  auth.sign_in_lookup(text), auth.sign_in_failed(uuid), auth.sign_in_succeeded(uuid, text, bytea, integer, text, text),
  auth.session_user(bytea), auth.end_session(bytea)
to app_auth;
grant execute on function
  auth.change_own_password(text, uuid), auth.admin_create_account(text, text, public.app_role, text), auth.admin_reset_password(uuid, text)
to authenticated;

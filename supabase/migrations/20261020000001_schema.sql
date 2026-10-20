-- NF Contractor Labour Attendance — core schema
-- Calendar dates are DATE in the project's local timezone; instants are TIMESTAMPTZ (UTC).

create extension if not exists btree_gist;

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------
create type public.app_role as enum ('admin', 'operator');
create type public.attendance_status as enum ('pending', 'present', 'absent');
create type public.change_method as enum ('individual', 'bulk');
create type public.rate_type as enum ('per_day', 'per_hour');

-- ---------------------------------------------------------------------------
-- Generic updated_at trigger
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Profiles (one per auth user). Workers do NOT have accounts.
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete restrict,
  full_name text not null check (char_length(btrim(full_name)) between 2 and 120),
  email text not null,
  role public.app_role not null default 'operator',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

-- New auth users get a profile. The role comes from app_metadata, which only
-- the service role can set; self sign-ups therefore become operators with no sites.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(coalesce(new.raw_user_meta_data ->> 'full_name', ''));
begin
  if char_length(v_name) < 2 then
    v_name := coalesce(new.email, 'User');
  end if;
  insert into public.profiles (id, full_name, email, role)
  values (
    new.id,
    v_name,
    coalesce(new.email, ''),
    case when new.raw_app_meta_data ->> 'role' = 'admin' then 'admin'::public.app_role else 'operator'::public.app_role end
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Contractors and projects
-- ---------------------------------------------------------------------------
create table public.contractors (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 2 and 120),
  location text not null check (char_length(btrim(location)) between 2 and 120),
  photo_path text,
  is_active boolean not null default true,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger contractors_touch before update on public.contractors
  for each row execute function public.touch_updated_at();

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 2 and 120),
  location text not null check (char_length(btrim(location)) between 2 and 120),
  is_active boolean not null default true,
  timezone text not null default 'Asia/Kolkata',
  default_check_in time not null default '09:00',
  allow_overnight boolean not null default false,
  operator_backdate_days smallint not null default 0 check (operator_backdate_days between 0 and 7),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger projects_touch before update on public.projects
  for each row execute function public.touch_updated_at();

-- A project may have many contractors; a contractor may work at many projects.
create table public.contractor_project_assignments (
  id uuid primary key default gen_random_uuid(),
  contractor_id uuid not null references public.contractors (id),
  project_id uuid not null references public.projects (id),
  start_date date not null,
  end_date date,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  check (end_date is null or end_date >= start_date),
  constraint contractor_project_no_overlap exclude using gist (
    contractor_id with =,
    project_id with =,
    daterange(start_date, end_date, '[]') with &&
  )
);
create index contractor_project_project_idx on public.contractor_project_assignments (project_id);

-- ---------------------------------------------------------------------------
-- Workers and effective-dated assignments
-- ---------------------------------------------------------------------------
create sequence public.worker_code_seq;

create table public.workers (
  id uuid primary key default gen_random_uuid(),
  -- Immutable, human-friendly ID. Names are NOT identifiers.
  worker_code text not null unique default ('W-' || lpad(nextval('public.worker_code_seq')::text, 5, '0')),
  full_name text not null check (char_length(btrim(full_name)) between 2 and 120),
  contractor_id uuid not null references public.contractors (id),
  is_active boolean not null default true,
  phone text check (phone is null or char_length(phone) <= 20),
  notes text check (notes is null or char_length(notes) <= 300),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger workers_touch before update on public.workers
  for each row execute function public.touch_updated_at();

create or replace function public.workers_protect_code()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.worker_code is distinct from old.worker_code then
    raise exception 'invalid: worker ID cannot be changed';
  end if;
  return new;
end;
$$;
create trigger workers_protect_code before update on public.workers
  for each row execute function public.workers_protect_code();

-- end_date is inclusive. One primary assignment per worker per day (no overlaps).
create table public.worker_project_assignments (
  id uuid primary key default gen_random_uuid(),
  worker_id uuid not null references public.workers (id),
  project_id uuid not null references public.projects (id),
  contractor_id uuid not null references public.contractors (id),
  start_date date not null,
  end_date date,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  check (end_date is null or end_date >= start_date),
  constraint worker_assignment_no_overlap exclude using gist (
    worker_id with =,
    daterange(start_date, end_date, '[]') with &&
  )
);
create index worker_assignment_project_idx on public.worker_project_assignments (project_id, start_date);
create index worker_assignment_worker_idx on public.worker_project_assignments (worker_id);

-- ---------------------------------------------------------------------------
-- Site operators
-- ---------------------------------------------------------------------------
create table public.site_operator_assignments (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.profiles (id),
  project_id uuid not null references public.projects (id),
  granted_by uuid references public.profiles (id),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz
);
create unique index site_operator_active_uniq
  on public.site_operator_assignments (operator_id, project_id) where revoked_at is null;

-- ---------------------------------------------------------------------------
-- Attendance (never hard-deleted)
-- ---------------------------------------------------------------------------
create table public.attendance_records (
  id uuid primary key default gen_random_uuid(),
  worker_id uuid not null references public.workers (id),
  project_id uuid not null references public.projects (id),
  contractor_id uuid not null references public.contractors (id),
  -- Shift start date in the project's timezone; an overnight OUT may fall on the next day.
  work_date date not null,
  status public.attendance_status not null,
  check_in_at timestamptz,
  check_out_at timestamptz,
  method public.change_method not null default 'individual',
  version integer not null default 1,
  created_by uuid references public.profiles (id),
  updated_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Unique per worker + project + shift date: a worker transferred mid-day can
  -- legitimately have one record at each site.
  constraint attendance_unique_worker_project_date unique (worker_id, project_id, work_date),
  constraint attendance_absent_has_no_times check (status <> 'absent' or (check_in_at is null and check_out_at is null)),
  constraint attendance_pending_has_no_times check (status <> 'pending' or (check_in_at is null and check_out_at is null)),
  constraint attendance_present_needs_in check (status <> 'present' or check_in_at is not null),
  constraint attendance_out_after_in check (check_out_at is null or (check_in_at is not null and check_out_at > check_in_at)),
  constraint attendance_shift_max_24h check (check_out_at is null or check_out_at - check_in_at <= interval '24 hours')
);
create index attendance_project_date_idx on public.attendance_records (project_id, work_date);
create index attendance_contractor_date_idx on public.attendance_records (contractor_id, work_date);

-- ---------------------------------------------------------------------------
-- Contractor payment rules — append-only, versioned
-- ---------------------------------------------------------------------------
create table public.contractor_payment_rules (
  id uuid primary key default gen_random_uuid(),
  contractor_id uuid not null references public.contractors (id),
  version integer not null,
  effective_from date not null,
  rate_type public.rate_type not null,
  day_rate numeric(12, 2) check (day_rate is null or day_rate >= 0),
  hour_rate numeric(12, 2) check (hour_rate is null or hour_rate >= 0),
  full_day_hours numeric(5, 2) check (full_day_hours is null or full_day_hours between 0.25 and 24),
  half_day_hours numeric(5, 2) check (half_day_hours is null or half_day_hours between 0.25 and 24),
  overtime_enabled boolean not null default false,
  overtime_after_hours numeric(5, 2) check (overtime_after_hours is null or overtime_after_hours between 0.25 and 24),
  overtime_hour_rate numeric(12, 2) check (overtime_hour_rate is null or overtime_hour_rate >= 0),
  unpaid_break_minutes integer not null default 0 check (unpaid_break_minutes between 0 and 240),
  notes text check (notes is null or char_length(notes) <= 300),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  constraint payment_rule_version_uniq unique (contractor_id, version),
  check (rate_type <> 'per_day' or day_rate is not null),
  check (rate_type <> 'per_hour' or hour_rate is not null),
  check (not overtime_enabled or (overtime_after_hours is not null and overtime_hour_rate is not null)),
  check (half_day_hours is null or full_day_hours is null or half_day_hours < full_day_hours)
);
create index payment_rules_contractor_idx on public.contractor_payment_rules (contractor_id, effective_from);

create or replace function public.payment_rules_assign_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtext('payment_rule:' || new.contractor_id::text));
  select coalesce(max(version), 0) + 1 into new.version
    from public.contractor_payment_rules where contractor_id = new.contractor_id;
  new.created_by := coalesce(new.created_by, auth.uid());
  new.created_at := now();
  return new;
end;
$$;
create trigger payment_rules_version before insert on public.contractor_payment_rules
  for each row execute function public.payment_rules_assign_version();

create or replace function public.forbid_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'forbidden: % rows are append-only and cannot be %', tg_table_name, lower(tg_op);
end;
$$;
create trigger payment_rules_immutable before update or delete on public.contractor_payment_rules
  for each row execute function public.forbid_change();

-- ---------------------------------------------------------------------------
-- Attendance audit log — written only by trigger, never edited
-- ---------------------------------------------------------------------------
create table public.attendance_audit_logs (
  id bigint generated always as identity primary key,
  attendance_id uuid not null references public.attendance_records (id),
  worker_id uuid not null references public.workers (id),
  project_id uuid not null references public.projects (id),
  contractor_id uuid not null references public.contractors (id),
  work_date date not null,
  action text not null check (action in ('create', 'update')),
  method public.change_method not null,
  changed_by uuid references public.profiles (id),
  changed_by_role public.app_role,
  changed_at timestamptz not null default now(),
  old_values jsonb,
  new_values jsonb not null
);
create index audit_project_date_idx on public.attendance_audit_logs (project_id, work_date);
create index audit_worker_idx on public.attendance_audit_logs (worker_id);
create trigger audit_immutable before update or delete on public.attendance_audit_logs
  for each row execute function public.forbid_change();
create trigger attendance_no_delete before delete on public.attendance_records
  for each row execute function public.forbid_change();

-- Integrity for every attendance write, whoever performs it.
create or replace function public.attendance_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if not exists (
      select 1 from public.worker_project_assignments a
      where a.worker_id = new.worker_id
        and a.project_id = new.project_id
        and a.contractor_id = new.contractor_id
        and a.start_date <= new.work_date
        and (a.end_date is null or a.end_date >= new.work_date)
    ) then
      raise exception 'invalid: worker is not assigned to this project and contractor on %', new.work_date;
    end if;
    new.version := 1;
    new.created_by := auth.uid();
    new.updated_by := auth.uid();
    new.created_at := now();
    new.updated_at := now();
  else
    if new.worker_id <> old.worker_id or new.project_id <> old.project_id
       or new.work_date <> old.work_date or new.contractor_id <> old.contractor_id then
      raise exception 'invalid: worker, project, contractor and date of an attendance record cannot be changed';
    end if;
    new.version := old.version + 1;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.updated_by := auth.uid();
    new.updated_at := now();
  end if;
  return new;
end;
$$;
create trigger attendance_before_write before insert or update on public.attendance_records
  for each row execute function public.attendance_before_write();

create or replace function public.attendance_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.attendance_audit_logs (
    attendance_id, worker_id, project_id, contractor_id, work_date, action, method,
    changed_by, changed_by_role, old_values, new_values
  ) values (
    new.id, new.worker_id, new.project_id, new.contractor_id, new.work_date,
    case when tg_op = 'INSERT' then 'create' else 'update' end,
    new.method,
    auth.uid(),
    (select p.role from public.profiles p where p.id = auth.uid()),
    case when tg_op = 'UPDATE' then jsonb_build_object('status', old.status, 'check_in_at', old.check_in_at, 'check_out_at', old.check_out_at) end,
    jsonb_build_object('status', new.status, 'check_in_at', new.check_in_at, 'check_out_at', new.check_out_at)
  );
  return null;
end;
$$;
create trigger attendance_audit after insert or update on public.attendance_records
  for each row execute function public.attendance_audit();

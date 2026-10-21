-- Attendance policies: company-wide defaults with optional per-site overrides.
-- Append-only versions with an effective date, like contractor payment rules.
-- See docs/attendance-settings.md. Existing attendance rows are not modified.

-- ---------------------------------------------------------------------------
-- Preflight: every site timezone must be one PostgreSQL knows. Nothing is repaired silently.
-- ---------------------------------------------------------------------------
do $$
declare
  v_bad text;
begin
  select string_agg(distinct pj.timezone, ', ') into v_bad
    from public.projects pj
    where not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = pj.timezone);
  if v_bad is not null then
    raise exception 'Migration stopped: unknown project timezone(s): %. Correct them, then apply this migration again.', v_bad;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
create table public.attendance_policies (
  id uuid primary key default gen_random_uuid(),
  -- null = company defaults; otherwise a site override
  project_id uuid references public.projects (id),
  version integer not null,
  effective_from date not null check (effective_from >= date '1900-01-01'),
  -- Site rows: the fields this version sets (a listed field may be null, meaning "none").
  -- Unlisted fields inherit the company value. Each site version is a complete snapshot.
  -- Company rows set every field and leave this empty.
  overridden text[] not null default '{}',
  suggested_check_in time,
  shift_start time,
  shift_end time,
  allow_overnight boolean,
  in_future_tolerance_min smallint check (in_future_tolerance_min between 0 and 240),
  out_future_tolerance_min smallint check (out_future_tolerance_min between 0 and 60),
  late_grace_min smallint check (late_grace_min between 0 and 240),
  half_day_below_hours numeric(4, 2) check (half_day_below_hours between 0.25 and 24),
  overtime_after_hours numeric(4, 2) check (overtime_after_hours between 0.25 and 24),
  overtime_min_minutes smallint check (overtime_min_minutes between 0 and 240),
  operator_backdate_days smallint check (operator_backdate_days between 0 and 7),
  edit_cutoff_time time,
  auto_absent_enabled boolean,
  -- Company rows only: timezone preselected for new sites (existing sites keep their own).
  default_timezone text,
  notes text check (notes is null or char_length(notes) <= 300),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),

  -- One-dimensional, only known keys (containment also rejects NULL elements).
  constraint attendance_policy_overridden_known check (
    coalesce(array_ndims(overridden), 1) = 1
    and overridden <@ array[
      'suggested_check_in', 'shift_start', 'shift_end', 'allow_overnight', 'in_future_tolerance_min',
      'out_future_tolerance_min', 'late_grace_min', 'half_day_below_hours', 'overtime_after_hours',
      'overtime_min_minutes', 'operator_backdate_days', 'edit_cutoff_time', 'auto_absent_enabled'
    ]::text[]
  ),
  constraint attendance_policy_company_shape check (
    project_id is not null or (overridden = '{}' and default_timezone is not null)
  ),
  constraint attendance_policy_site_shape check (project_id is null or default_timezone is null),
  -- Policy times are whole minutes (the app enters "HH:mm"; a suggested IN must match exactly).
  constraint attendance_policy_minute_times check (
    coalesce(extract(second from suggested_check_in), 0) = 0
    and coalesce(extract(second from shift_start), 0) = 0
    and coalesce(extract(second from shift_end), 0) = 0
    and coalesce(extract(second from edit_cutoff_time), 0) = 0
  ),
  -- Shift start and end are one unit.
  constraint attendance_policy_shift_pair check ((shift_start is null) = (shift_end is null)),
  constraint attendance_policy_shift_override_pair check (
    ('shift_start' = any (overridden)) = ('shift_end' = any (overridden))
  ),
  -- Fields where "none" has no meaning: set on company rows, and on site rows exactly when overridden.
  constraint attendance_policy_required_fields check (
    (allow_overnight is not null) = (project_id is null or 'allow_overnight' = any (overridden))
    and (in_future_tolerance_min is not null) = (project_id is null or 'in_future_tolerance_min' = any (overridden))
    and (out_future_tolerance_min is not null) = (project_id is null or 'out_future_tolerance_min' = any (overridden))
    and (operator_backdate_days is not null) = (project_id is null or 'operator_backdate_days' = any (overridden))
    and (auto_absent_enabled is not null) = (project_id is null or 'auto_absent_enabled' = any (overridden))
  ),
  -- Site rows store nothing they do not override.
  constraint attendance_policy_site_unset check (
    project_id is null or (
      (suggested_check_in is null or 'suggested_check_in' = any (overridden))
      and (shift_start is null or 'shift_start' = any (overridden))
      and (shift_end is null or 'shift_end' = any (overridden))
      and (late_grace_min is null or 'late_grace_min' = any (overridden))
      and (half_day_below_hours is null or 'half_day_below_hours' = any (overridden))
      and (overtime_after_hours is null or 'overtime_after_hours' = any (overridden))
      and (overtime_min_minutes is null or 'overtime_min_minutes' = any (overridden))
      and (edit_cutoff_time is null or 'edit_cutoff_time' = any (overridden))
    )
  )
);
-- One version sequence per scope; the company scope (NULL project) included.
create unique index attendance_policy_version_uniq
  on public.attendance_policies (coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid), version);
create index attendance_policy_scope_idx on public.attendance_policies (project_id, effective_from);

create or replace function public.attendance_policies_assign_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Refuse non-admins before anything else (RLS would refuse the row afterwards anyway).
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'forbidden: only NF admins can change attendance settings';
  end if;
  perform pg_advisory_xact_lock(hashtext('attendance_policy:' || coalesce(new.project_id::text, 'company')));
  select coalesce(max(p.version), 0) + 1 into new.version
    from public.attendance_policies p
    where p.project_id is not distinct from new.project_id;
  new.created_by := auth.uid(); -- never caller-supplied
  new.created_at := now();
  return new;
end;
$$;
create trigger attendance_policies_version before insert on public.attendance_policies
  for each row execute function public.attendance_policies_assign_version();
create trigger attendance_policies_immutable before update or delete on public.attendance_policies
  for each row execute function public.forbid_change();

-- ---------------------------------------------------------------------------
-- Resolution: the policy in force for a site on a date.
-- Mirrors resolvePolicy() in src/lib/domain/policy.ts.
-- ---------------------------------------------------------------------------
create type public.attendance_policy_effective as (
  suggested_check_in time,
  shift_start time,
  shift_end time,
  allow_overnight boolean,
  in_future_tolerance_min integer,
  out_future_tolerance_min integer,
  late_grace_min integer,
  half_day_below_hours numeric,
  overtime_after_hours numeric,
  overtime_min_minutes integer,
  operator_backdate_days integer,
  edit_cutoff_time time,
  auto_absent_enabled boolean,
  company_policy_id uuid,
  site_policy_id uuid
);

-- Internal: no authorization check, so nobody but definer functions and triggers may call it.
create or replace function public.attendance_policy_resolve(p_project_id uuid, p_date date)
returns public.attendance_policy_effective
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  c public.attendance_policies;
  s public.attendance_policies;
  r public.attendance_policy_effective;
  o text[];
begin
  select * into c from public.attendance_policies p
    where p.project_id is null and p.effective_from <= p_date
    order by p.effective_from desc, p.version desc
    limit 1;
  if p_project_id is not null then
    select * into s from public.attendance_policies p
      where p.project_id = p_project_id and p.effective_from <= p_date
      order by p.effective_from desc, p.version desc
      limit 1;
  end if;
  o := coalesce(s.overridden, '{}');

  -- Fallbacks (when no company row is in force) match FALLBACK_POLICY in policy.ts.
  r.suggested_check_in := case when 'suggested_check_in' = any (o) then s.suggested_check_in else c.suggested_check_in end;
  r.shift_start := case when 'shift_start' = any (o) then s.shift_start else c.shift_start end;
  r.shift_end := case when 'shift_end' = any (o) then s.shift_end else c.shift_end end;
  r.allow_overnight := case when 'allow_overnight' = any (o) then s.allow_overnight else coalesce(c.allow_overnight, false) end;
  r.in_future_tolerance_min := case when 'in_future_tolerance_min' = any (o) then s.in_future_tolerance_min else coalesce(c.in_future_tolerance_min, 60) end;
  r.out_future_tolerance_min := case when 'out_future_tolerance_min' = any (o) then s.out_future_tolerance_min else coalesce(c.out_future_tolerance_min, 5) end;
  r.late_grace_min := case when 'late_grace_min' = any (o) then s.late_grace_min else c.late_grace_min end;
  r.half_day_below_hours := case when 'half_day_below_hours' = any (o) then s.half_day_below_hours else c.half_day_below_hours end;
  r.overtime_after_hours := case when 'overtime_after_hours' = any (o) then s.overtime_after_hours else c.overtime_after_hours end;
  r.overtime_min_minutes := case when 'overtime_min_minutes' = any (o) then s.overtime_min_minutes else c.overtime_min_minutes end;
  r.operator_backdate_days := case when 'operator_backdate_days' = any (o) then s.operator_backdate_days else coalesce(c.operator_backdate_days, 0) end;
  r.edit_cutoff_time := case when 'edit_cutoff_time' = any (o) then s.edit_cutoff_time else c.edit_cutoff_time end;
  r.auto_absent_enabled := case when 'auto_absent_enabled' = any (o) then s.auto_absent_enabled else coalesce(c.auto_absent_enabled, false) end;
  r.company_policy_id := c.id;
  r.site_policy_id := s.id;
  return r;
end;
$$;

-- For the app: the effective values only (no history, notes or authors), and only
-- for admins or operators with access to that site.
create or replace function public.attendance_policy_for(p_project_id uuid, p_date date)
returns public.attendance_policy_effective
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not (public.is_admin() or (p_project_id is not null and public.can_access_project(p_project_id))) then
    raise exception 'forbidden: you are not authorised for this project site';
  end if;
  return public.attendance_policy_resolve(p_project_id, p_date);
end;
$$;

-- Sites whose timezone is locked because they have attendance (rows the caller can see).
create or replace function public.projects_with_attendance()
returns setof uuid
language sql
stable
security invoker
set search_path = ''
as $$
  select distinct r.project_id from public.attendance_records r;
$$;

-- ---------------------------------------------------------------------------
-- Seed (behaviour-preserving): company defaults as decided on 2026-10-21, and
-- every existing site keeps its current suggested IN, overnight and past-day values.
-- ---------------------------------------------------------------------------
insert into public.attendance_policies (
  project_id, effective_from, suggested_check_in, shift_start, shift_end, allow_overnight,
  in_future_tolerance_min, out_future_tolerance_min, late_grace_min, half_day_below_hours,
  overtime_after_hours, overtime_min_minutes, operator_backdate_days, edit_cutoff_time,
  auto_absent_enabled, default_timezone, notes
) values (
  null, date '1900-01-01', null, null, null, false,
  60, 5, null, null,
  null, null, 0, null,
  false, 'Asia/Kolkata', 'Initial company defaults (migration)'
);

insert into public.attendance_policies (
  project_id, effective_from, overridden, suggested_check_in, allow_overnight, operator_backdate_days, notes
)
select pj.id, date '1900-01-01', array['suggested_check_in', 'allow_overnight', 'operator_backdate_days'],
       -- to the minute, as the app has always shown and used it
       make_time(extract(hour from pj.default_check_in)::int, extract(minute from pj.default_check_in)::int, 0),
       pj.allow_overnight, pj.operator_backdate_days,
       'Carried over from the site settings (migration)'
from public.projects pj
order by pj.created_at, pj.id;

comment on column public.projects.default_check_in is 'Deprecated: superseded by attendance_policies. Not read by the app.';
comment on column public.projects.allow_overnight is 'Deprecated: superseded by attendance_policies. Not read by the app.';
comment on column public.projects.operator_backdate_days is 'Deprecated: superseded by attendance_policies. Not read by the app.';

-- ---------------------------------------------------------------------------
-- Site timezone: must be a known zone, and is locked once the site has attendance
-- (stored instants would otherwise map to different local dates and times).
-- The UPDATE holds the project row lock while this runs, and attendance writes take
-- FOR SHARE on the same row, so the check and the first attendance insert serialize.
-- ---------------------------------------------------------------------------
create or replace function public.projects_check_timezone()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from pg_catalog.pg_timezone_names z where z.name = new.timezone) then
    raise exception 'invalid: unknown timezone %', new.timezone;
  end if;
  if tg_op = 'UPDATE' and new.timezone is distinct from old.timezone
     and exists (select 1 from public.attendance_records r where r.project_id = new.id) then
    raise exception 'invalid: the timezone cannot be changed after attendance has been recorded at this site';
  end if;
  return new;
end;
$$;
create trigger projects_check_timezone before insert or update of timezone on public.projects
  for each row execute function public.projects_check_timezone();

-- ---------------------------------------------------------------------------
-- Row Level Security: raw versions (history, notes, authors) are admin-only.
-- ---------------------------------------------------------------------------
alter table public.attendance_policies enable row level security;

create policy attendance_policies_admin_select on public.attendance_policies for select to authenticated
  using (public.is_admin());
create policy attendance_policies_admin_insert on public.attendance_policies for insert to authenticated
  with check (public.is_admin());

-- New objects get no implicit access (new functions are executable by PUBLIC by
-- default, and Supabase grants new tables broadly).
revoke all on public.attendance_policies from public, anon, authenticated;
grant select, insert on public.attendance_policies to authenticated;

revoke execute on function
  public.attendance_policies_assign_version(),
  public.attendance_policy_resolve(uuid, date),
  public.attendance_policy_for(uuid, date),
  public.projects_with_attendance(),
  public.projects_check_timezone()
from public, anon, authenticated;
grant execute on function public.attendance_policy_for(uuid, date), public.projects_with_attendance() to authenticated;

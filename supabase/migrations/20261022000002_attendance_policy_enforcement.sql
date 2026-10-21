-- Enforce attendance policies in the database, for the save RPC and for direct
-- table writes alike. Replaces the hardcoded IN +60 min / OUT +5 min limits.
-- Existing attendance and audit rows are not modified.

-- ---------------------------------------------------------------------------
-- How an IN time was recorded. null = absent/pending, or saved before this was tracked.
-- ---------------------------------------------------------------------------
create type public.check_in_source as enum ('entered', 'suggested');
alter table public.attendance_records add column check_in_source public.check_in_source;
alter table public.attendance_records add constraint attendance_source_only_when_present
  check (status = 'present' or check_in_source is null);

-- ---------------------------------------------------------------------------
-- True when the local wall-clock time of p_at in p_tz also names a second instant
-- (a fall-back DST fold). Mirrors the fold detection in localToInstantStrict() (time.ts).
-- ---------------------------------------------------------------------------
create or replace function public.local_time_is_ambiguous(p_at timestamptz, p_tz text)
returns boolean
language sql
stable
set search_path = ''
as $$
  with l as (select p_at at time zone p_tz as loc),
  offsets as (
    select ((p_at + d) at time zone p_tz) - ((p_at + d) at time zone 'UTC') as off
    from (values (interval '-1 day'), (interval '0'), (interval '1 day')) v (d)
  ),
  candidates as (select distinct ((l.loc - o.off) at time zone 'UTC') as inst from l, offsets o)
  select count(*) > 1 from candidates c, l where (c.inst at time zone p_tz) = l.loc;
$$;

-- ---------------------------------------------------------------------------
-- Operator edit window: work date D stays editable until the cutoff time on
-- day D + N (site-local), or the end of that day when no cutoff is set.
-- Uses the policy in force on the site's today, so tightening applies at once.
-- Mirrors operatorEditClosesAt() in src/lib/domain/policy.ts.
-- ---------------------------------------------------------------------------
create or replace function public.operator_edit_closes_at(p_project_id uuid, p_work_date date)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select (
    case
      when pol.edit_cutoff_time is null then (p_work_date + pol.operator_backdate_days + 1)::timestamp
      else (p_work_date + pol.operator_backdate_days) + pol.edit_cutoff_time
    end
  ) at time zone pj.timezone
  from public.projects pj
  cross join lateral public.attendance_policy_resolve(pj.id, (now() at time zone pj.timezone)::date) pol
  where pj.id = p_project_id;
$$;

-- Admins may correct any date up to the site's today. Operators may edit only
-- inside the edit window, on sites they are assigned to.
create or replace function public.can_edit_attendance(p_project_id uuid, p_work_date date)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.projects pj
    where pj.id = p_project_id
      and p_work_date <= (now() at time zone pj.timezone)::date
      and (
        public.is_admin()
        or (
          public.can_access_project(pj.id)
          and now() < public.operator_edit_closes_at(pj.id, p_work_date)
        )
      )
  );
$$;

-- ---------------------------------------------------------------------------
-- Integrity for every attendance write, whoever performs it (replaces the
-- original trigger function; the identity and assignment rules are unchanged).
-- Policy checks re-run only for times that change, so tightening a policy
-- never blocks unrelated corrections. Mirrors evaluateEntry() in policy.ts.
-- SECURITY DEFINER so it can use the internal resolver and lock the project row;
-- who may write which rows is still decided by RLS / can_edit_attendance.
-- ---------------------------------------------------------------------------
create or replace function public.attendance_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tz text;
  v_day public.attendance_policy_effective;
  v_now public.attendance_policy_effective;
  v_in_changed boolean;
  v_out_changed boolean;
  v_out_date date;
begin
  -- Authorization first, so a caller without access learns nothing about other sites'
  -- assignments or settings from the checks below (RLS also refuses the row afterwards).
  if auth.uid() is not null and not public.can_edit_attendance(new.project_id, new.work_date) then
    raise exception 'forbidden: you are not allowed to edit attendance for this site and date';
  end if;

  -- Serializes with a timezone change on the same site (see projects_check_timezone).
  select pj.timezone into v_tz from public.projects pj where pj.id = new.project_id for share;

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

  if new.status <> 'present' then
    new.check_in_source := null;
    return new;
  end if;

  v_in_changed := tg_op = 'INSERT' or new.check_in_at is distinct from old.check_in_at;
  v_out_changed := tg_op = 'INSERT' or new.check_out_at is distinct from old.check_out_at;
  if not v_in_changed then
    new.check_in_source := old.check_in_source; -- IN untouched: keep how it was recorded
  end if;
  if not (v_in_changed or v_out_changed) then
    return new;
  end if;

  v_day := public.attendance_policy_resolve(new.project_id, new.work_date);
  v_now := public.attendance_policy_resolve(new.project_id, (now() at time zone v_tz)::date);

  if v_in_changed and new.check_in_at is not null then
    if (new.check_in_at at time zone v_tz)::date <> new.work_date then
      raise exception 'invalid: IN time must be on the attendance date (%)', new.work_date;
    end if;
    if new.check_in_at > now() + make_interval(mins => v_now.in_future_tolerance_min) then
      raise exception 'invalid: IN time is in the future';
    end if;
    if public.local_time_is_ambiguous(new.check_in_at, v_tz) then
      raise exception 'invalid: this IN time happens twice on this date (clocks go back). Choose another time.';
    end if;
    if new.check_in_source is null then
      raise exception 'invalid: say whether the IN time was entered or the suggested time was accepted';
    end if;
    if new.check_in_source = 'suggested' and (
      v_day.suggested_check_in is null
      or (new.check_in_at at time zone v_tz)::time <> v_day.suggested_check_in
    ) then
      raise exception 'invalid: IN time does not match the site''s suggested time';
    end if;
  end if;

  if v_out_changed and new.check_out_at is not null then
    v_out_date := (new.check_out_at at time zone v_tz)::date;
    if v_out_date <> new.work_date and not (v_day.allow_overnight and v_out_date = new.work_date + 1) then
      raise exception 'invalid: OUT time must be on the attendance date%',
        case when v_day.allow_overnight then ' or the next day' else '' end;
    end if;
    if new.check_out_at > now() + make_interval(mins => v_now.out_future_tolerance_min) then
      raise exception 'invalid: OUT time cannot be in the future';
    end if;
    if public.local_time_is_ambiguous(new.check_out_at, v_tz) then
      raise exception 'invalid: this OUT time happens twice on this date (clocks go back). Choose another time.';
    end if;
  end if;
  return new;
end;
$$;

-- Audit entries now also record how IN was recorded. Older entries simply lack the key.
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
    case when tg_op = 'UPDATE' then jsonb_build_object(
      'status', old.status, 'check_in_at', old.check_in_at, 'check_out_at', old.check_out_at,
      'check_in_source', old.check_in_source
    ) end,
    jsonb_build_object(
      'status', new.status, 'check_in_at', new.check_in_at, 'check_out_at', new.check_out_at,
      'check_in_source', new.check_in_source
    )
  );
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Save RPC: same contract, plus check_in_source per item. Time and policy
-- rules are enforced by attendance_before_write, so they are no longer
-- repeated here.
-- p_items: [{ worker_id, contractor_id, status, check_in_at, check_out_at, check_in_source, method, expected_version }]
-- ---------------------------------------------------------------------------
create or replace function public.save_attendance(p_project_id uuid, p_work_date date, p_items jsonb)
returns setof public.attendance_records
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_item jsonb;
  v_worker uuid;
  v_contractor uuid;
  v_expected integer;
  v_status public.attendance_status;
  v_in timestamptz;
  v_out timestamptz;
  v_source public.check_in_source;
  v_method public.change_method;
  v_existing public.attendance_records;
  v_row public.attendance_records;
  v_assigned uuid;
begin
  if auth.uid() is null then
    raise exception 'forbidden: please sign in again';
  end if;
  if not public.can_edit_attendance(p_project_id, p_work_date) then
    raise exception 'forbidden: you are not allowed to edit attendance for this site and date';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 500 then
    raise exception 'invalid: nothing to save';
  end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_worker := (v_item ->> 'worker_id')::uuid;
    v_contractor := (v_item ->> 'contractor_id')::uuid;
    v_expected := (v_item ->> 'expected_version')::integer;
    v_status := (v_item ->> 'status')::public.attendance_status;
    v_in := (v_item ->> 'check_in_at')::timestamptz;
    v_out := (v_item ->> 'check_out_at')::timestamptz;
    v_source := (v_item ->> 'check_in_source')::public.check_in_source;
    v_method := coalesce((v_item ->> 'method')::public.change_method, 'individual');

    if v_status <> 'present' then
      v_in := null;
      v_out := null;
      v_source := null;
    end if;

    select * into v_existing
      from public.attendance_records r
      where r.worker_id = v_worker and r.project_id = p_project_id and r.work_date = p_work_date
      for update;

    if found then
      if v_expected is distinct from v_existing.version then
        raise exception 'conflict: attendance was changed by someone else. Reload to see the latest entries.';
      end if;
      if v_existing.status = v_status
         and v_existing.check_in_at is not distinct from v_in
         and v_existing.check_out_at is not distinct from v_out then
        continue; -- unchanged
      end if;
      update public.attendance_records
         set status = v_status, check_in_at = v_in, check_out_at = v_out, check_in_source = v_source, method = v_method
       where id = v_existing.id
       returning * into v_row;
    else
      if v_expected is not null then
        raise exception 'conflict: attendance was changed by someone else. Reload to see the latest entries.';
      end if;
      if v_status = 'pending' then
        continue; -- nothing recorded, nothing to reset
      end if;
      select a.contractor_id into v_assigned
        from public.worker_project_assignments a
        where a.worker_id = v_worker and a.project_id = p_project_id
          and a.start_date <= p_work_date and (a.end_date is null or a.end_date >= p_work_date);
      if v_assigned is null or v_assigned <> v_contractor then
        raise exception 'invalid: worker is not assigned to this project on this date';
      end if;
      insert into public.attendance_records (worker_id, project_id, contractor_id, work_date, status, check_in_at, check_out_at, check_in_source, method)
      values (v_worker, p_project_id, v_contractor, p_work_date, v_status, v_in, v_out, v_source, v_method)
      returning * into v_row;
    end if;
    return next v_row;
  end loop;
end;
$$;

-- Internal helper: used only inside can_edit_attendance (SECURITY DEFINER).
revoke execute on function public.operator_edit_closes_at(uuid, date) from public, anon, authenticated;
-- Pure helper (no table access); used by the write trigger.
revoke execute on function public.local_time_is_ambiguous(timestamptz, text) from public, anon;
grant execute on function public.local_time_is_ambiguous(timestamptz, text) to authenticated;

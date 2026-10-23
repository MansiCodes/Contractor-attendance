-- Day and night shifts.
--
-- 1. Every attendance record has a shift (day or night). A worker still has one
--    record per plant and date; the shift says which register it belongs to.
--    Existing records become day shifts (the column default), unchanged otherwise.
-- 2. Plants may set a suggested IN for the night shift (night_suggested_check_in),
--    inherited from the company row like every other attendance setting.
-- 3. attendance_before_write applies the policy as it holds for the record's shift:
--    a night shift uses the night suggested IN and may always end the next day.
-- 4. save_attendance takes a shift per item; audit entries record the shift.
--
-- The function bodies below are the current definitions (20261023000001) with
-- only the shift handling added.

-- ---------------------------------------------------------------------------
-- 1. Shift on attendance
-- ---------------------------------------------------------------------------
create type public.attendance_shift as enum ('day', 'night');
alter table public.attendance_records add column shift public.attendance_shift not null default 'day';

-- ---------------------------------------------------------------------------
-- 2. Night suggested IN
-- ---------------------------------------------------------------------------
alter table public.attendance_policies add column night_suggested_check_in time;

alter table public.attendance_policies drop constraint attendance_policy_overridden_known;
alter table public.attendance_policies add constraint attendance_policy_overridden_known check (
  coalesce(array_ndims(overridden), 1) = 1
  and overridden <@ array[
    'suggested_check_in', 'night_suggested_check_in', 'shift_start', 'shift_end', 'break_minutes', 'allow_overnight',
    'in_future_tolerance_min', 'out_future_tolerance_min', 'late_grace_min', 'half_day_below_hours', 'overtime_after_hours',
    'overtime_min_minutes', 'operator_backdate_days', 'edit_cutoff_time', 'auto_absent_enabled'
  ]::text[]
);

alter table public.attendance_policies drop constraint attendance_policy_site_unset;
alter table public.attendance_policies add constraint attendance_policy_site_unset check (
  project_id is null or (
    (suggested_check_in is null or 'suggested_check_in' = any (overridden))
    and (night_suggested_check_in is null or 'night_suggested_check_in' = any (overridden))
    and (shift_start is null or 'shift_start' = any (overridden))
    and (shift_end is null or 'shift_end' = any (overridden))
    and (break_minutes is null or 'break_minutes' = any (overridden))
    and (late_grace_min is null or 'late_grace_min' = any (overridden))
    and (half_day_below_hours is null or 'half_day_below_hours' = any (overridden))
    and (overtime_after_hours is null or 'overtime_after_hours' = any (overridden))
    and (overtime_min_minutes is null or 'overtime_min_minutes' = any (overridden))
    and (edit_cutoff_time is null or 'edit_cutoff_time' = any (overridden))
  )
);

alter type public.attendance_policy_effective add attribute night_suggested_check_in time;

-- ---------------------------------------------------------------------------
-- 3. Functions (create or replace keeps each function's existing grants and revokes)
-- ---------------------------------------------------------------------------

-- attendance_policy_resolve
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
  r.night_suggested_check_in := case when 'night_suggested_check_in' = any (o) then s.night_suggested_check_in else c.night_suggested_check_in end;
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
  r.break_minutes := case when 'break_minutes' = any (o) then s.break_minutes else c.break_minutes end;
  r.edit_cutoff_time := case when 'edit_cutoff_time' = any (o) then s.edit_cutoff_time else c.edit_cutoff_time end;
  r.auto_absent_enabled := case when 'auto_absent_enabled' = any (o) then s.auto_absent_enabled else coalesce(c.auto_absent_enabled, false) end;
  r.company_policy_id := c.id;
  r.site_policy_id := s.id;
  return r;
end;
$$;

-- attendance_before_write
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
  v_shift_changed boolean;
begin
  -- Authorization first, so a caller without access learns nothing about other sites'
  -- assignments or settings from the checks below (RLS also refuses the row afterwards).
  if auth.uid() is not null and not public.can_edit_attendance(new.project_id, new.work_date) then
    raise exception 'forbidden: you are not allowed to edit attendance for this plant and date';
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
      raise exception 'invalid: worker is not assigned to this plant and contractor on %', new.work_date;
    end if;
    new.version := 1;
    new.created_by := auth.uid();
    new.updated_by := auth.uid();
    new.created_at := now();
    new.updated_at := now();
  else
    if new.worker_id <> old.worker_id or new.project_id <> old.project_id
       or new.work_date <> old.work_date or new.contractor_id <> old.contractor_id then
      raise exception 'invalid: worker, plant, contractor and date of an attendance record cannot be changed';
    end if;
    if new.shift <> old.shift and not public.is_admin() then
      raise exception 'invalid: only head office can move a record to the other shift';
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

  v_shift_changed := tg_op = 'UPDATE' and new.shift is distinct from old.shift;
  v_in_changed := tg_op = 'INSERT' or new.check_in_at is distinct from old.check_in_at;
  -- A shift change re-checks OUT: night shifts may end the next day, day shifts only if the plant allows it.
  v_out_changed := tg_op = 'INSERT' or new.check_out_at is distinct from old.check_out_at or v_shift_changed;
  if not v_in_changed then
    new.check_in_source := old.check_in_source; -- IN untouched: keep how it was recorded
  end if;
  if not (v_in_changed or v_out_changed) then
    return new;
  end if;

  v_day := public.attendance_policy_resolve(new.project_id, new.work_date);
  -- The policy as it applies to the shift (mirrors policyForShift() in policy.ts).
  if new.shift = 'night' then
    v_day.suggested_check_in := v_day.night_suggested_check_in;
    v_day.allow_overnight := true;
  end if;
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
      raise exception 'invalid: IN time does not match the plant''s suggested time';
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

-- save_attendance
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
  v_shift public.attendance_shift;
  v_existing public.attendance_records;
  v_row public.attendance_records;
  v_assigned uuid;
begin
  if auth.uid() is null then
    raise exception 'forbidden: please sign in again';
  end if;
  if not public.can_edit_attendance(p_project_id, p_work_date) then
    raise exception 'forbidden: you are not allowed to edit attendance for this plant and date';
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
    v_shift := coalesce((v_item ->> 'shift')::public.attendance_shift, 'day');

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
      -- One record per worker and day: a save for one shift never takes over the other shift's record.
      if v_existing.shift <> v_shift then
        raise exception 'invalid: this worker is recorded on the % shift for this date. Open that shift to change it.', v_existing.shift;
      end if;
      if v_existing.status = v_status
         and v_existing.check_in_at is not distinct from v_in
         and v_existing.check_out_at is not distinct from v_out
         and v_existing.shift = v_shift then
        continue; -- unchanged
      end if;
      update public.attendance_records
         set status = v_status, check_in_at = v_in, check_out_at = v_out, check_in_source = v_source, method = v_method, shift = v_shift
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
        raise exception 'invalid: worker is not assigned to this plant on this date';
      end if;
      insert into public.attendance_records (worker_id, project_id, contractor_id, work_date, status, check_in_at, check_out_at, check_in_source, method, shift)
      values (v_worker, p_project_id, v_contractor, p_work_date, v_status, v_in, v_out, v_source, v_method, v_shift)
      returning * into v_row;
    end if;
    return next v_row;
  end loop;
end;
$$;

-- Audit entries also record the shift. Older entries simply lack the key (they were day shifts).
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
      'check_in_source', old.check_in_source, 'shift', old.shift
    ) end,
    jsonb_build_object(
      'status', new.status, 'check_in_at', new.check_in_at, 'check_out_at', new.check_out_at,
      'check_in_source', new.check_in_source, 'shift', new.shift
    )
  );
  return null;
end;
$$;

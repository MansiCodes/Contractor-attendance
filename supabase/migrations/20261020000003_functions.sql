-- Atomic operations called by the app through PostgREST RPC.
-- All run as the calling user (SECURITY INVOKER), so RLS still applies, and
-- each re-checks authorization itself. Each call is one transaction.
-- Error messages start with "forbidden:", "invalid:" or "conflict:" so the app
-- can show them to users.

-- ---------------------------------------------------------------------------
-- Save a batch of attendance changes for one project + date (all-or-nothing)
-- p_items: [{ worker_id, contractor_id, status, check_in_at, check_out_at, method, expected_version }]
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
    v_method := coalesce((v_item ->> 'method')::public.change_method, 'individual');

    if v_status <> 'present' then
      v_in := null;
      v_out := null;
    end if;
    -- Never accept an OUT time ahead of the clock, or an IN hours in advance.
    if v_out is not null and v_out > now() + interval '5 minutes' then
      raise exception 'invalid: OUT time cannot be in the future';
    end if;
    if v_in is not null and v_in > now() + interval '60 minutes' then
      raise exception 'invalid: IN time is in the future';
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
         set status = v_status, check_in_at = v_in, check_out_at = v_out, method = v_method
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
      insert into public.attendance_records (worker_id, project_id, contractor_id, work_date, status, check_in_at, check_out_at, method)
      values (v_worker, p_project_id, v_contractor, p_work_date, v_status, v_in, v_out, v_method)
      returning * into v_row;
    end if;
    return next v_row;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Worker lifecycle (admin only)
-- ---------------------------------------------------------------------------
create or replace function public.assert_admin()
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden: only NF admins can do this';
  end if;
end;
$$;

create or replace function public.assert_contractor_on_project(p_contractor_id uuid, p_project_id uuid, p_date date)
returns void
language plpgsql
stable
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.contractor_project_assignments a
    join public.projects p on p.id = a.project_id
    where a.contractor_id = p_contractor_id and a.project_id = p_project_id and p.is_active
      and a.start_date <= p_date and (a.end_date is null or a.end_date >= p_date)
  ) then
    raise exception 'invalid: this contractor is not assigned to that project on %', p_date;
  end if;
end;
$$;

create or replace function public.admin_create_worker(
  p_full_name text, p_contractor_id uuid, p_project_id uuid, p_start_date date,
  p_phone text default null, p_notes text default null
)
returns public.workers
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_worker public.workers;
begin
  perform public.assert_admin();
  perform public.assert_contractor_on_project(p_contractor_id, p_project_id, p_start_date);
  insert into public.workers (full_name, contractor_id, phone, notes, created_by)
  values (btrim(p_full_name), p_contractor_id, nullif(btrim(p_phone), ''), nullif(btrim(p_notes), ''), auth.uid())
  returning * into v_worker;
  insert into public.worker_project_assignments (worker_id, project_id, contractor_id, start_date, created_by)
  values (v_worker.id, p_project_id, p_contractor_id, p_start_date, auth.uid());
  return v_worker;
end;
$$;

create or replace function public.admin_transfer_worker(p_worker_id uuid, p_project_id uuid, p_contractor_id uuid, p_effective_date date)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_open public.worker_project_assignments;
begin
  perform public.assert_admin();
  perform public.assert_contractor_on_project(p_contractor_id, p_project_id, p_effective_date);
  select * into v_open from public.worker_project_assignments
    where worker_id = p_worker_id and end_date is null for update;
  if not found then
    raise exception 'invalid: worker is inactive. Reactivate instead.';
  end if;
  if v_open.project_id = p_project_id and v_open.contractor_id = p_contractor_id then
    raise exception 'invalid: worker is already assigned there';
  end if;
  if p_effective_date <= v_open.start_date then
    raise exception 'invalid: transfer date must be after the current assignment started (%)', v_open.start_date;
  end if;
  -- Close the old assignment the day before; history stays with the old site.
  update public.worker_project_assignments set end_date = p_effective_date - 1 where id = v_open.id;
  insert into public.worker_project_assignments (worker_id, project_id, contractor_id, start_date, created_by)
  values (p_worker_id, p_project_id, p_contractor_id, p_effective_date, auth.uid());
  update public.workers set contractor_id = p_contractor_id where id = p_worker_id;
end;
$$;

create or replace function public.admin_deactivate_worker(p_worker_id uuid, p_last_working_date date)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_open public.worker_project_assignments;
begin
  perform public.assert_admin();
  select * into v_open from public.worker_project_assignments
    where worker_id = p_worker_id and end_date is null for update;
  if found then
    if p_last_working_date < v_open.start_date then
      raise exception 'invalid: last working date cannot be before %', v_open.start_date;
    end if;
    update public.worker_project_assignments set end_date = p_last_working_date where id = v_open.id;
  end if;
  update public.workers set is_active = false where id = p_worker_id;
end;
$$;

create or replace function public.admin_reactivate_worker(p_worker_id uuid, p_project_id uuid, p_start_date date)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_worker public.workers;
begin
  perform public.assert_admin();
  select * into v_worker from public.workers where id = p_worker_id for update;
  if not found then
    raise exception 'invalid: worker not found';
  end if;
  if exists (select 1 from public.worker_project_assignments where worker_id = p_worker_id and end_date is null) then
    raise exception 'conflict: worker is already active';
  end if;
  perform public.assert_contractor_on_project(v_worker.contractor_id, p_project_id, p_start_date);
  insert into public.worker_project_assignments (worker_id, project_id, contractor_id, start_date, created_by)
  values (p_worker_id, p_project_id, v_worker.contractor_id, p_start_date, auth.uid());
  update public.workers set is_active = true where id = p_worker_id;
end;
$$;

create or replace function public.admin_end_contractor_project(p_assignment_id uuid, p_end_date date)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_cpa public.contractor_project_assignments;
  v_count integer;
begin
  perform public.assert_admin();
  select * into v_cpa from public.contractor_project_assignments where id = p_assignment_id for update;
  if not found then
    raise exception 'invalid: assignment not found';
  end if;
  select count(*) into v_count from public.worker_project_assignments w
    where w.project_id = v_cpa.project_id and w.contractor_id = v_cpa.contractor_id
      and (w.end_date is null or w.end_date > p_end_date);
  if v_count > 0 then
    raise exception 'invalid: move or deactivate the % worker(s) still deployed here first', v_count;
  end if;
  update public.contractor_project_assignments
     set end_date = greatest(p_end_date, v_cpa.start_date)
   where id = p_assignment_id;
end;
$$;

grant execute on function
  public.save_attendance(uuid, date, jsonb),
  public.assert_admin(),
  public.assert_contractor_on_project(uuid, uuid, date),
  public.admin_create_worker(text, uuid, uuid, date, text, text),
  public.admin_transfer_worker(uuid, uuid, uuid, date),
  public.admin_deactivate_worker(uuid, date),
  public.admin_reactivate_worker(uuid, uuid, date),
  public.admin_end_contractor_project(uuid, date)
to authenticated;

-- Contractor worker master data.
--
-- 1. Contractors: legal name as written on their documents, and an identity
--    status for contractors an admin still has to confirm (e.g. a wage sheet
--    named "Excellent" but headed "GAJENDRA RANA CONTRACTORS"). Location becomes
--    optional: wage sheets carry no address.
-- 2. Workers: the contractor's own employee ID (kept exactly as written, unique
--    per contractor), department, designation and where the record came from.
-- 3. Worker pay terms: append-only, effective-dated versions of each worker's
--    rate amount and its basis (monthly / daily / hourly / unconfirmed), plus
--    commission eligibility for contractors whose commission applies to some
--    workers only. Admin-only.
-- 4. Import batches: one row per applied import (file name, SHA-256, summary).
-- 5. admin_import_worker_master(): applies a previewed import in one transaction.
--    admin_assign_workers(): gives Unassigned workers their first plant.
--
-- Imported workers get no plant assignment: the master does not say where they
-- work, so they stay Unassigned until an admin assigns them.
-- Existing rows are not modified.

-- ---------------------------------------------------------------------------
-- 1. Contractors
-- ---------------------------------------------------------------------------
alter table public.contractors alter column location drop not null;
alter table public.contractors
  add column legal_name text check (legal_name is null or char_length(btrim(legal_name)) between 1 and 200),
  add column identity_status text not null default 'confirmed' check (identity_status in ('confirmed', 'needs_review')),
  add column identity_note text check (identity_note is null or char_length(identity_note) <= 500);

-- ---------------------------------------------------------------------------
-- 2. Workers
-- ---------------------------------------------------------------------------
alter table public.workers
  -- Exactly as on the contractor's records: inner spaces, leading zeros and O/0 are kept.
  add column employee_code text check (employee_code is null or (char_length(employee_code) between 1 and 40 and employee_code = btrim(employee_code))),
  add column department text check (department is null or char_length(department) <= 80),
  add column designation text check (designation is null or char_length(designation) <= 80),
  add column source text check (source is null or char_length(source) <= 300);

create unique index workers_contractor_employee_code_uniq
  on public.workers (contractor_id, employee_code) where employee_code is not null;

-- ---------------------------------------------------------------------------
-- 3. Worker pay terms (append-only)
-- ---------------------------------------------------------------------------
create type public.rate_basis as enum ('monthly', 'daily', 'hourly', 'unconfirmed');

create table public.worker_pay_terms (
  id uuid primary key default gen_random_uuid(),
  worker_id uuid not null references public.workers (id),
  version integer not null,
  effective_from date not null,
  -- The amount as recorded; its meaning comes from rate_basis.
  rate_amount numeric(12, 2) check (rate_amount is null or rate_amount >= 0),
  rate_basis public.rate_basis not null default 'unconfirmed',
  -- null = not selected (only used where commission applies to selected workers)
  commission_eligible boolean,
  source text check (source is null or char_length(source) <= 300),
  notes text check (notes is null or char_length(notes) <= 300),
  -- Optional optimistic check: the latest version the writer based this on (0 = none).
  -- A concurrent change in between makes the insert fail instead of silently reverting it.
  based_on_version integer,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  constraint worker_pay_terms_version_uniq unique (worker_id, version)
);
create index worker_pay_terms_worker_idx on public.worker_pay_terms (worker_id, effective_from);

create or replace function public.worker_pay_terms_assign_version()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_latest date;
  v_version integer;
begin
  perform pg_advisory_xact_lock(hashtext('worker_pay_terms:' || new.worker_id::text));
  select max(effective_from), coalesce(max(version), 0) into v_latest, v_version from public.worker_pay_terms where worker_id = new.worker_id;
  if new.based_on_version is not null and new.based_on_version <> v_version then
    raise exception 'conflict: this worker''s pay terms were changed meanwhile (now version %). Reload and try again.', v_version;
  end if;
  if v_latest is not null and new.effective_from < v_latest then
    raise exception 'invalid: pay terms from % already exist; a new version must start on or after that date', v_latest;
  end if;
  select coalesce(max(version), 0) + 1 into new.version
    from public.worker_pay_terms where worker_id = new.worker_id;
  new.created_by := coalesce(new.created_by, auth.uid());
  new.created_at := now();
  return new;
end;
$$;
create trigger worker_pay_terms_version before insert on public.worker_pay_terms
  for each row execute function public.worker_pay_terms_assign_version();
create trigger worker_pay_terms_immutable before update or delete on public.worker_pay_terms
  for each row execute function public.forbid_change();

-- ---------------------------------------------------------------------------
-- 4. Import batches (append-only)
-- ---------------------------------------------------------------------------
create table public.import_batches (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('worker_master', 'worker_contacts', 'historical_attendance')),
  file_name text not null check (char_length(file_name) between 1 and 200),
  file_hash text not null check (file_hash ~ '^[0-9a-f]{64}$'),
  summary jsonb not null default '{}'::jsonb,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);
create index import_batches_hash_idx on public.import_batches (file_hash);
create trigger import_batches_immutable before update or delete on public.import_batches
  for each row execute function public.forbid_change();

-- ---------------------------------------------------------------------------
-- Security: pay terms and import history are admin-only.
-- ---------------------------------------------------------------------------
alter table public.worker_pay_terms enable row level security;
alter table public.import_batches enable row level security;

create policy pay_terms_admin_select on public.worker_pay_terms for select to authenticated using (public.is_admin());
create policy pay_terms_admin_insert on public.worker_pay_terms for insert to authenticated with check (public.is_admin());
create policy import_batches_admin_select on public.import_batches for select to authenticated using (public.is_admin());
create policy import_batches_admin_insert on public.import_batches for insert to authenticated with check (public.is_admin());

revoke all on public.worker_pay_terms, public.import_batches from public, anon, authenticated;
grant select, insert on public.worker_pay_terms, public.import_batches to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Functions
-- ---------------------------------------------------------------------------

-- admin_create_worker gains the employee ID, department and designation.
drop function public.admin_create_worker(text, uuid, uuid, date, text, text);
create function public.admin_create_worker(
  p_full_name text, p_contractor_id uuid, p_project_id uuid, p_start_date date,
  p_phone text default null, p_notes text default null,
  p_employee_code text default null, p_department text default null, p_designation text default null
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
  insert into public.workers (full_name, contractor_id, phone, notes, employee_code, department, designation, created_by)
  values (
    btrim(p_full_name), p_contractor_id, nullif(btrim(p_phone), ''), nullif(btrim(p_notes), ''),
    nullif(btrim(p_employee_code), ''), nullif(btrim(p_department), ''), nullif(btrim(p_designation), ''), auth.uid()
  )
  returning * into v_worker;
  insert into public.worker_project_assignments (worker_id, project_id, contractor_id, start_date, created_by)
  values (v_worker.id, p_project_id, p_contractor_id, p_start_date, auth.uid());
  return v_worker;
end;
$$;

-- First plant for active workers who have none (e.g. after an import).
create or replace function public.admin_assign_workers(p_worker_ids uuid[], p_project_id uuid, p_start_date date)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_worker public.workers;
  v_count integer := 0;
begin
  perform public.assert_admin();
  for v_worker in select * from public.workers where id = any (p_worker_ids) order by id for update loop
    if not v_worker.is_active then
      raise exception 'invalid: % is inactive. Reactivate instead.', v_worker.full_name;
    end if;
    if exists (select 1 from public.worker_project_assignments a where a.worker_id = v_worker.id and (a.end_date is null or a.end_date >= p_start_date)) then
      raise exception 'invalid: % already has a plant from %. Use Transfer instead.', v_worker.full_name, p_start_date;
    end if;
    perform public.assert_contractor_on_project(v_worker.contractor_id, p_project_id, p_start_date);
    insert into public.worker_project_assignments (worker_id, project_id, contractor_id, start_date, created_by)
    values (v_worker.id, p_project_id, v_worker.contractor_id, p_start_date, auth.uid());
    v_count := v_count + 1;
  end loop;
  if v_count <> coalesce(array_length(p_worker_ids, 1), 0) then
    raise exception 'invalid: some workers were not found';
  end if;
  return v_count;
end;
$$;

-- Applies a previewed worker master import in one transaction.
-- p_payload: { batch: {file_name, file_hash, summary},
--              contractors: [{ref, name, legal_name, identity_status, identity_note}],
--              creates: [{contractor_id | contractor_ref, employee_code, full_name, department, designation, source,
--                         pay_terms: {effective_from, rate_amount, rate_basis, source}}],
--              updates: [{worker_id, fields: {full_name, department, designation} | null,
--                         pay_terms: {effective_from, rate_amount, rate_basis, commission_eligible, source} | null}] }
create or replace function public.admin_import_worker_master(p_payload jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_batch uuid;
  v_refs jsonb := '{}'::jsonb;
  v_c jsonb;
  v_w jsonb;
  v_id uuid;
  v_contractor uuid;
  v_created integer := 0;
  v_updated integer := 0;
  v_last uuid;
  v_worker public.workers;
  v_terms integer;
begin
  perform public.assert_admin();
  -- One import at a time, and only on top of the state it was previewed against:
  -- two admins applying the same preview cannot create the same workers twice.
  perform pg_advisory_xact_lock(hashtext('worker_master_import'));
  select b.id into v_last from public.import_batches b where b.kind = 'worker_master' order by b.created_at desc, b.id desc limit 1;
  if v_last is distinct from nullif(p_payload->'batch'->>'expected_last_batch_id', '')::uuid then
    raise exception 'conflict: another import was applied after this preview. Preview again before importing.';
  end if;

  insert into public.import_batches (kind, file_name, file_hash, summary, created_by)
  values ('worker_master', p_payload->'batch'->>'file_name', p_payload->'batch'->>'file_hash', coalesce(p_payload->'batch'->'summary', '{}'::jsonb), auth.uid())
  returning id into v_batch;

  for v_c in select * from jsonb_array_elements(coalesce(p_payload->'contractors', '[]'::jsonb)) loop
    insert into public.contractors (name, location, legal_name, identity_status, identity_note, created_by)
    values (btrim(v_c->>'name'), null, nullif(btrim(v_c->>'legal_name'), ''), coalesce(v_c->>'identity_status', 'needs_review'), v_c->>'identity_note', auth.uid())
    returning id into v_id;
    v_refs := v_refs || jsonb_build_object(v_c->>'ref', v_id);
  end loop;

  for v_w in select * from jsonb_array_elements(coalesce(p_payload->'creates', '[]'::jsonb)) loop
    v_contractor := coalesce((v_w->>'contractor_id')::uuid, (v_refs->>(v_w->>'contractor_ref'))::uuid);
    if v_contractor is null then
      raise exception 'invalid: an imported worker has no contractor';
    end if;
    insert into public.workers (full_name, contractor_id, employee_code, department, designation, source, created_by)
    values (btrim(v_w->>'full_name'), v_contractor, v_w->>'employee_code', v_w->>'department', v_w->>'designation', v_w->>'source', auth.uid())
    returning id into v_id;
    insert into public.worker_pay_terms (worker_id, version, effective_from, rate_amount, rate_basis, source)
    values (
      v_id, 0, (v_w->'pay_terms'->>'effective_from')::date, (v_w->'pay_terms'->>'rate_amount')::numeric,
      (v_w->'pay_terms'->>'rate_basis')::public.rate_basis, v_w->'pay_terms'->>'source'
    );
    v_created := v_created + 1;
  end loop;

  for v_w in select * from jsonb_array_elements(coalesce(p_payload->'updates', '[]'::jsonb)) loop
    v_id := (v_w->>'worker_id')::uuid;
    select * into v_worker from public.workers where id = v_id for update;
    if not found then
      raise exception 'invalid: a worker in this import no longer exists';
    end if;
    select coalesce(max(version), 0) into v_terms from public.worker_pay_terms where worker_id = v_id;
    if v_worker.full_name is distinct from v_w->'expected'->>'full_name'
       or v_worker.department is distinct from v_w->'expected'->>'department'
       or v_worker.designation is distinct from v_w->'expected'->>'designation'
       or v_terms <> (v_w->'expected'->>'terms_version')::integer then
      raise exception 'conflict: % was changed after this preview. Preview again before importing.', v_worker.full_name;
    end if;
    if jsonb_typeof(v_w->'fields') = 'object' then
      update public.workers
         set full_name = btrim(v_w->'fields'->>'full_name'),
             department = v_w->'fields'->>'department',
             designation = v_w->'fields'->>'designation'
       where id = v_id;
      if not found then
        raise exception 'invalid: a worker in this import no longer exists';
      end if;
    end if;
    if jsonb_typeof(v_w->'pay_terms') = 'object' then
      insert into public.worker_pay_terms (worker_id, version, effective_from, rate_amount, rate_basis, commission_eligible, source, based_on_version)
      values (
        v_id, 0, (v_w->'pay_terms'->>'effective_from')::date, (v_w->'pay_terms'->>'rate_amount')::numeric,
        (v_w->'pay_terms'->>'rate_basis')::public.rate_basis, (v_w->'pay_terms'->>'commission_eligible')::boolean, v_w->'pay_terms'->>'source', v_terms
      );
    end if;
    v_updated := v_updated + 1;
  end loop;

  return jsonb_build_object('batch_id', v_batch, 'contractors', v_refs, 'created', v_created, 'updated', v_updated);
end;
$$;

revoke execute on function
  public.admin_create_worker(text, uuid, uuid, date, text, text, text, text, text),
  public.admin_assign_workers(uuid[], uuid, date),
  public.admin_import_worker_master(jsonb),
  public.worker_pay_terms_assign_version()
from public, anon;
grant execute on function
  public.admin_create_worker(text, uuid, uuid, date, text, text, text, text, text),
  public.admin_assign_workers(uuid[], uuid, date),
  public.admin_import_worker_master(jsonb)
to authenticated;

-- Row Level Security: permissions are enforced in the database, not just the UI.

-- ---------------------------------------------------------------------------
-- Helper functions (SECURITY DEFINER so policies can consult other tables
-- without recursive RLS evaluation).
-- ---------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin' and p.is_active
  );
$$;

create or replace function public.can_access_project(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public.is_admin() or exists (
    select 1
    from public.site_operator_assignments s
    join public.profiles pr on pr.id = s.operator_id
    join public.projects pj on pj.id = s.project_id
    where s.operator_id = auth.uid()
      and s.project_id = p_project_id
      and s.revoked_at is null
      and pr.is_active
      and pr.role = 'operator'
      and pj.is_active
  );
$$;

-- Admins may correct any date up to today. Operators may edit today (and the
-- project's configured number of past days) only, on sites they are assigned to.
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
          and p_work_date >= (now() at time zone pj.timezone)::date - pj.operator_backdate_days
        )
      )
  );
$$;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.contractors enable row level security;
alter table public.projects enable row level security;
alter table public.contractor_project_assignments enable row level security;
alter table public.workers enable row level security;
alter table public.worker_project_assignments enable row level security;
alter table public.site_operator_assignments enable row level security;
alter table public.attendance_records enable row level security;
alter table public.contractor_payment_rules enable row level security;
alter table public.attendance_audit_logs enable row level security;

-- profiles
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());
create policy profiles_admin_update on public.profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- contractors: operators see contractors deployed on their sites
create policy contractors_select on public.contractors for select to authenticated
  using (
    public.is_admin()
    or exists (select 1 from public.contractor_project_assignments a where a.contractor_id = contractors.id and public.can_access_project(a.project_id))
    or exists (select 1 from public.worker_project_assignments w where w.contractor_id = contractors.id and public.can_access_project(w.project_id))
  );
create policy contractors_admin_insert on public.contractors for insert to authenticated with check (public.is_admin());
create policy contractors_admin_update on public.contractors for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- projects
create policy projects_select on public.projects for select to authenticated using (public.can_access_project(id));
create policy projects_admin_insert on public.projects for insert to authenticated with check (public.is_admin());
create policy projects_admin_update on public.projects for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- contractor <-> project
create policy cpa_select on public.contractor_project_assignments for select to authenticated using (public.can_access_project(project_id));
create policy cpa_admin_insert on public.contractor_project_assignments for insert to authenticated with check (public.is_admin());
create policy cpa_admin_update on public.contractor_project_assignments for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- workers: operators see workers who are (or were) deployed on their sites
create policy workers_select on public.workers for select to authenticated
  using (
    public.is_admin()
    or exists (select 1 from public.worker_project_assignments w where w.worker_id = workers.id and public.can_access_project(w.project_id))
  );
create policy workers_admin_insert on public.workers for insert to authenticated with check (public.is_admin());
create policy workers_admin_update on public.workers for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- worker assignments
create policy wpa_select on public.worker_project_assignments for select to authenticated using (public.can_access_project(project_id));
create policy wpa_admin_insert on public.worker_project_assignments for insert to authenticated with check (public.is_admin());
create policy wpa_admin_update on public.worker_project_assignments for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- operator site access
create policy soa_select on public.site_operator_assignments for select to authenticated
  using (public.is_admin() or operator_id = auth.uid());
create policy soa_admin_insert on public.site_operator_assignments for insert to authenticated with check (public.is_admin());
create policy soa_admin_update on public.site_operator_assignments for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- attendance: read on accessible sites; write only within the allowed date window. No deletes.
create policy attendance_select on public.attendance_records for select to authenticated
  using (public.can_access_project(project_id));
create policy attendance_insert on public.attendance_records for insert to authenticated
  with check (public.can_edit_attendance(project_id, work_date));
create policy attendance_update on public.attendance_records for update to authenticated
  using (public.can_edit_attendance(project_id, work_date))
  with check (public.can_edit_attendance(project_id, work_date));

-- payment rules: admins only (operators never see rates or payables)
create policy rules_admin_select on public.contractor_payment_rules for select to authenticated using (public.is_admin());
create policy rules_admin_insert on public.contractor_payment_rules for insert to authenticated with check (public.is_admin());

-- audit logs: admins read; nobody writes directly (trigger only)
create policy audit_admin_select on public.attendance_audit_logs for select to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------------
-- Grants. Anonymous visitors get nothing. Deletes are never granted.
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke execute on all functions in schema public from public, anon;

grant usage on schema public to authenticated;
grant select on all tables in schema public to authenticated;
grant insert, update on
  public.contractors, public.projects, public.contractor_project_assignments, public.workers,
  public.worker_project_assignments, public.site_operator_assignments, public.attendance_records,
  public.profiles
  to authenticated;
grant insert on public.contractor_payment_rules to authenticated;
revoke delete, truncate on all tables in schema public from authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on function public.is_admin(), public.can_access_project(uuid), public.can_edit_attendance(uuid, date) to authenticated;

-- Profiles: admins may change name/role/active only; never the id or email linkage.
revoke update on public.profiles from authenticated;
grant update (full_name, role, is_active) on public.profiles to authenticated;

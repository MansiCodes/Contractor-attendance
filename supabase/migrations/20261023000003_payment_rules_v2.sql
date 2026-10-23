-- Contractor payment rules, version 2 settings.
--
-- Adds what the contractors' rules need (Shukla, Sumit, Excellent, Optimum):
-- each worker's own rate as the rate source, short-day handling, a monthly
-- divisor for salaried workers, separate day/night overtime thresholds, how
-- overtime is paid (fixed rate or multiplier), rounding and a minimum, and
-- contractor commission (percentage, who it applies to, what it is calculated
-- on, and whether it is added to or taken from wages).
--
-- Settings the company has not decided may stay null: the app then shows
-- "Needs configuration" for the affected amounts instead of a guessed figure.
--
-- Existing rule rows are not modified (rules are append-only). They are marked
-- rule_format 1 through the column default, and the app reads them with the
-- settings that reproduce how they were always calculated. New rows are format 2.

alter table public.contractor_payment_rules
  add column rule_format smallint not null default 1 check (rule_format in (1, 2)),
  add column rate_source text not null default 'contractor' check (rate_source in ('contractor', 'worker')),
  add column short_day_policy text check (short_day_policy in ('pro_rata', 'half_day', 'full_day')),
  add column monthly_divisor_days smallint check (monthly_divisor_days between 1 and 31),
  add column overtime_after_night_hours numeric(5, 2) check (overtime_after_night_hours is null or overtime_after_night_hours between 0.25 and 24),
  add column overtime_rate_mode text check (overtime_rate_mode in ('per_hour', 'multiplier')),
  add column overtime_multiplier numeric(4, 2) check (overtime_multiplier is null or overtime_multiplier between 1 and 5),
  add column overtime_rounding text check (overtime_rounding in ('exact', 'floor_15', 'floor_30', 'floor_60', 'nearest_15', 'nearest_30')),
  add column overtime_min_minutes integer not null default 0 check (overtime_min_minutes between 0 and 240),
  add column commission_enabled boolean not null default false,
  add column commission_percent numeric(5, 2) check (commission_percent is null or (commission_percent > 0 and commission_percent <= 50)),
  add column commission_scope text check (commission_scope in ('all', 'selected')),
  add column commission_base text check (commission_base in ('base_wages', 'gross_wages')),
  add column commission_treatment text check (commission_treatment in ('added_to_contractor_payable', 'deducted_from_wages'));

-- Rows added from now on use the version 2 meaning.
alter table public.contractor_payment_rules alter column rule_format set default 2;

-- The original table checks required a contractor rate and an overtime rate. With
-- worker rates and "not decided yet" settings they no longer hold for new rows, so
-- they are replaced (existing rows satisfy the new checks unchanged).
do $$
declare
  r record;
begin
  for r in
    select conname, pg_get_constraintdef(oid) as def from pg_constraint
    where conrelid = 'public.contractor_payment_rules'::regclass and contype = 'c'
  loop
    if r.def like '%day_rate IS NOT NULL%' or r.def like '%hour_rate IS NOT NULL%' then
      execute format('alter table public.contractor_payment_rules drop constraint %I', r.conname);
    end if;
  end loop;
end;
$$;

alter table public.contractor_payment_rules
  add constraint payment_rule_contractor_rate check (
    rate_source = 'worker'
    or ((rate_type <> 'per_day' or day_rate is not null) and (rate_type <> 'per_hour' or hour_rate is not null))
  ),
  add constraint payment_rule_overtime_threshold check (not overtime_enabled or overtime_after_hours is not null),
  -- Format 1 rules always carried their overtime rate.
  add constraint payment_rule_legacy_overtime_rate check (rule_format = 2 or not overtime_enabled or overtime_hour_rate is not null),
  add constraint payment_rule_half_day check (short_day_policy is distinct from 'half_day' or half_day_hours is not null);

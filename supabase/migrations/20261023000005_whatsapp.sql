-- WhatsApp attendance messages (sending is server-side only; LIVE SENDING IS OFF
-- unless the server is configured for it, see docs/whatsapp.md).
--
-- 1. worker_contacts: WhatsApp number, country code, on/off, consent and language.
--    Consent changes are kept in worker_consent_events (append-only).
-- 2. messaging_settings: one row of admin settings (schedule, templates, pause).
-- 3. outbound_messages: the queue and history. idempotency_key is unique, so the
--    same attendance record can never be queued twice. Statuses only move forward.
-- 4. message_status_events: every delivery status received from the provider.
-- 5. messaging_claim_due(): hands due messages to one dispatcher at a time.
--
-- Admin-only throughout: operators cannot read numbers, consent or messages.
-- The scheduled dispatcher and the provider webhook use the service role.

create type public.consent_status as enum ('unknown', 'granted', 'withdrawn');

create table public.worker_contacts (
  worker_id uuid primary key references public.workers (id),
  country_code text not null default '+91' check (country_code ~ '^\+[0-9]{1,4}$'),
  whatsapp_number text check (whatsapp_number is null or whatsapp_number ~ '^[0-9]{6,14}$'),
  enabled boolean not null default false,
  consent_status public.consent_status not null default 'unknown',
  consent_at timestamptz,
  consent_source text check (consent_source is null or char_length(consent_source) <= 200),
  preferred_language text check (preferred_language in ('hi', 'hi_latn', 'en')),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id),
  -- Consent must say when and how it was given.
  constraint worker_contacts_consent_recorded check (consent_status <> 'granted' or (consent_at is not null and consent_source is not null))
);

create table public.worker_consent_events (
  id bigint generated always as identity primary key,
  worker_id uuid not null references public.workers (id),
  consent_status public.consent_status not null,
  source text,
  at timestamptz not null default now(),
  by uuid references public.profiles (id)
);
create index worker_consent_events_worker_idx on public.worker_consent_events (worker_id);
create trigger worker_consent_events_immutable before update or delete on public.worker_consent_events
  for each row execute function public.forbid_change();

create or replace function public.worker_contacts_stamp()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  return new;
end;
$$;
create trigger worker_contacts_stamp before insert or update on public.worker_contacts
  for each row execute function public.worker_contacts_stamp();

-- Consent history. An AFTER trigger, so an upsert (insert ... on conflict do update)
-- logs only the change that actually happened, once.
create or replace function public.worker_contacts_log_consent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or new.consent_status is distinct from old.consent_status then
    insert into public.worker_consent_events (worker_id, consent_status, source, by)
    values (new.worker_id, new.consent_status, new.consent_source, auth.uid());
  end if;
  return null;
end;
$$;
create trigger worker_contacts_log_consent after insert or update on public.worker_contacts
  for each row execute function public.worker_contacts_log_consent();

create table public.messaging_settings (
  id smallint primary key default 1 check (id = 1),
  enabled boolean not null default false,
  paused boolean not null default false,
  send_time time not null default '20:00',
  default_language text not null default 'hi' check (default_language in ('hi', 'hi_latn', 'en')),
  include_english boolean not null default false,
  attendance_template text not null default 'attendance_summary_hi' check (char_length(attendance_template) between 1 and 512 and attendance_template ~ '^[a-z0-9_]+$'),
  correction_template text not null default 'attendance_correction_hi' check (char_length(correction_template) between 1 and 512 and correction_template ~ '^[a-z0-9_]+$'),
  correction_notices boolean not null default true,
  -- No retroactive messages: only work dates on or after this.
  start_date date not null,
  test_number text check (test_number is null or test_number ~ '^\+[0-9]{7,15}$'),
  last_scheduled_run date,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles (id)
);

create table public.outbound_messages (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique check (char_length(idempotency_key) <= 200),
  kind text not null check (kind in ('attendance', 'correction', 'test')),
  worker_id uuid references public.workers (id),
  attendance_id uuid references public.attendance_records (id),
  attendance_version integer,
  contractor_id uuid references public.contractors (id),
  project_id uuid references public.projects (id),
  work_date date,
  shift public.attendance_shift,
  to_number text not null check (to_number ~ '^\+[0-9]{7,15}$'),
  language text not null check (language in ('hi', 'hi_latn', 'en')),
  template_name text not null,
  params jsonb not null default '[]'::jsonb,
  body text not null,
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'cancelled')),
  attempts integer not null default 0,
  next_attempt_at timestamptz,
  last_error text,
  provider_message_id text unique,
  transport text check (transport in ('mock', 'cloud_api')),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id),
  check (kind = 'test' or (worker_id is not null and attendance_id is not null))
);
create index outbound_messages_due_idx on public.outbound_messages (status, next_attempt_at);

create table public.message_status_events (
  id bigint generated always as identity primary key,
  provider_message_id text not null,
  status text not null,
  at timestamptz,
  payload jsonb not null,
  received_at timestamptz not null default now()
);
create trigger message_status_events_immutable before update or delete on public.message_status_events
  for each row execute function public.forbid_change();

-- Hands up to p_limit due messages to the caller, marked as sending. A message left
-- "sending" for over 10 minutes is marked failed for an admin to check: it may have
-- been delivered, so it is never re-sent automatically.
create or replace function public.messaging_claim_due(p_now timestamptz, p_limit integer)
returns setof public.outbound_messages
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.outbound_messages
     set status = 'failed', last_error = 'Sending was interrupted. Check whether it arrived before retrying.', next_attempt_at = null, updated_at = p_now
   where status = 'sending' and updated_at < p_now - interval '10 minutes';
  return query
  update public.outbound_messages m
     set status = 'sending', attempts = m.attempts + 1, updated_at = p_now
   where m.id in (
     select q.id from public.outbound_messages q
      where q.status = 'queued' and (q.next_attempt_at is null or q.next_attempt_at <= p_now)
      order by q.created_at
      limit p_limit
      for update skip locked
   )
  returning m.*;
end;
$$;

-- Applies one provider status: statuses only move forward (sent → delivered → read).
-- A failure reported after "sent" is recorded and final; a late or replayed "sent"
-- never hides it. Returns false when no message has that provider id (yet).
create or replace function public.messaging_apply_status_only(p_provider_message_id text, p_status text, p_at timestamptz, p_error text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_rank constant jsonb := '{"queued":0,"sending":1,"failed":2,"cancelled":2,"sent":3,"delivered":4,"read":5}';
  v_msg public.outbound_messages;
begin
  select * into v_msg from public.outbound_messages where provider_message_id = p_provider_message_id for update;
  if not found then
    return false;
  end if;
  if v_msg.status in ('failed', 'cancelled') then
    return true;
  end if;
  if (p_status = 'failed' and (v_rank ->> v_msg.status)::int >= (v_rank ->> 'sent')::int)
     or (p_status <> 'failed' and (v_rank ->> p_status)::int > (v_rank ->> v_msg.status)::int) then
    update public.outbound_messages
       set status = p_status, last_error = case when p_status = 'failed' then p_error else last_error end, updated_at = coalesce(p_at, now())
     where id = v_msg.id;
  end if;
  return true;
end;
$$;

-- Webhook entry point: logs every status (also those that arrive before the send
-- result is saved), then applies it.
create or replace function public.messaging_apply_status(p_provider_message_id text, p_status text, p_at timestamptz, p_error text, p_payload jsonb default '{}'::jsonb)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  insert into public.message_status_events (provider_message_id, status, at, payload)
  values (p_provider_message_id, p_status, p_at, coalesce(p_payload, '{}'::jsonb) || jsonb_build_object('error', p_error));
  return public.messaging_apply_status_only(p_provider_message_id, p_status, p_at, p_error);
end;
$$;

-- A status can reach the webhook before the send result (with the provider id) is
-- saved. It is logged above; this applies the logged statuses once the id is known.
create or replace function public.messaging_replay_statuses(p_provider_message_id text)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_e public.message_status_events;
begin
  for v_e in select * from public.message_status_events where provider_message_id = p_provider_message_id order by at nulls last, id loop
    perform public.messaging_apply_status_only(v_e.provider_message_id, v_e.status, v_e.at, v_e.payload->>'error');
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Security: admin-only. Nothing is ever deleted.
-- ---------------------------------------------------------------------------
alter table public.worker_contacts enable row level security;
alter table public.worker_consent_events enable row level security;
alter table public.messaging_settings enable row level security;
alter table public.outbound_messages enable row level security;
alter table public.message_status_events enable row level security;

create policy contacts_admin_all on public.worker_contacts for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy consent_events_admin_select on public.worker_consent_events for select to authenticated using (public.is_admin());
create policy messaging_settings_admin_all on public.messaging_settings for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy outbound_messages_admin_all on public.outbound_messages for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy status_events_admin_select on public.message_status_events for select to authenticated using (public.is_admin());
create policy status_events_admin_insert on public.message_status_events for insert to authenticated with check (public.is_admin());

revoke all on public.worker_contacts, public.worker_consent_events, public.messaging_settings, public.outbound_messages, public.message_status_events
  from public, anon, authenticated;
grant select, insert, update on public.worker_contacts, public.messaging_settings, public.outbound_messages to authenticated;
grant select on public.worker_consent_events to authenticated;
grant select, insert on public.message_status_events to authenticated;
grant all on public.worker_contacts, public.worker_consent_events, public.messaging_settings, public.outbound_messages, public.message_status_events to service_role;
grant usage, select on all sequences in schema public to service_role;

revoke execute on function
  public.messaging_claim_due(timestamptz, integer), public.messaging_apply_status(text, text, timestamptz, text, jsonb),
  public.messaging_apply_status_only(text, text, timestamptz, text), public.messaging_replay_statuses(text), public.worker_contacts_stamp(),
  public.worker_contacts_log_consent()
  from public, anon, authenticated;
grant execute on function
  public.messaging_claim_due(timestamptz, integer), public.messaging_apply_status(text, text, timestamptz, text, jsonb),
  public.messaging_apply_status_only(text, text, timestamptz, text), public.messaging_replay_statuses(text)
  to authenticated, service_role;

-- The scheduled dispatcher and the webhook run as service_role. State its read access
-- to the attendance data explicitly instead of relying on project defaults.
grant usage on schema public to service_role;
grant select on public.attendance_records, public.workers, public.projects, public.contractors, public.attendance_policies,
  public.worker_project_assignments, public.contractor_project_assignments, public.profiles to service_role;

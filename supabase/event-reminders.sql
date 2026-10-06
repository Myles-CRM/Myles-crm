-- CRM calendar reminder jobs. Run this migration in Supabase before enabling the new UI.
-- Reminder delivery is authoritative in this table; calendar metadata is only display state.
create table if not exists public.event_reminders (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid,
  event_id text,
  event_version text not null,
  event_title text not null,
  event_date date not null,
  event_time text,
  event_timezone text not null default 'Australia/Adelaide',
  event_at timestamptz not null,
  event_location text,
  reminder text not null,
  reminder_minutes integer not null default 15,
  due_at timestamptz not null,
  email text not null,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  locked_at timestamptz,
  idempotency_key text not null default gen_random_uuid()::text,
  claim_token text,
  sent_at timestamptz,
  send_error text,
  resend_id text,
  created_at timestamptz not null default now(),
  constraint event_reminders_minutes_check check (reminder_minutes between 0 and 10080),
  constraint event_reminders_status_check check (status in ('pending', 'processing', 'sent', 'failed', 'cancelled', 'expired'))
);

-- Additive migration for the original reminder table.
alter table public.event_reminders add column if not exists event_version text;
alter table public.event_reminders add column if not exists owner_id uuid;
alter table public.event_reminders add column if not exists event_id text;
alter table public.event_reminders add column if not exists event_title text;
alter table public.event_reminders add column if not exists event_date date;
alter table public.event_reminders add column if not exists event_time text;
alter table public.event_reminders add column if not exists event_location text;
alter table public.event_reminders add column if not exists event_timezone text;
alter table public.event_reminders add column if not exists event_at timestamptz;
alter table public.event_reminders add column if not exists reminder_minutes integer;
alter table public.event_reminders add column if not exists due_at timestamptz;
alter table public.event_reminders add column if not exists email text;
alter table public.event_reminders add column if not exists status text;
alter table public.event_reminders add column if not exists attempt_count integer;
alter table public.event_reminders add column if not exists locked_at timestamptz;
alter table public.event_reminders add column if not exists idempotency_key text;
alter table public.event_reminders add column if not exists claim_token text;
alter table public.event_reminders add column if not exists sent_at timestamptz;
alter table public.event_reminders add column if not exists send_error text;
alter table public.event_reminders add column if not exists resend_id text;
alter table public.event_reminders add column if not exists created_at timestamptz;

update public.event_reminders
set event_version = coalesce(event_version, id::text),
    event_id = coalesce(event_id, id::text),
    event_title = coalesce(event_title, 'Calendar event'),
    event_date = coalesce(event_date, (now() at time zone 'Australia/Adelaide')::date),
    event_timezone = coalesce(event_timezone, 'Australia/Adelaide'),
    event_at = coalesce(event_at, (event_date::text || ' ' || coalesce(nullif(event_time, ''), '06:30'))::timestamp at time zone coalesce(event_timezone, 'Australia/Adelaide')),
    reminder_minutes = coalesce(reminder_minutes, 15),
    due_at = coalesce(due_at, event_at - make_interval(mins => coalesce(reminder_minutes, 15))),
    email = coalesce(email, 'tacotrumpet001@gmail.com'),
    attempt_count = coalesce(attempt_count, 0),
    idempotency_key = coalesce(idempotency_key, id::text),
    claim_token = coalesce(claim_token, id::text),
    status = coalesce(status, case when sent_at is null then 'pending' else 'sent' end);
update public.event_reminders
set event_at = (event_date::text || ' ' || coalesce(nullif(event_time, ''), '06:30'))::timestamp at time zone event_timezone
where event_at is null;
update public.event_reminders set created_at = coalesce(created_at, now());
update public.event_reminders
set due_at = event_at - make_interval(mins => reminder_minutes)
where due_at is null;

-- Keep the newest active row before the unique index is created. This makes the
-- migration safe to re-run against databases with duplicate legacy submissions.
delete from public.event_reminders older
using public.event_reminders newer
where older.id <> newer.id
  and older.event_id = newer.event_id
  and older.event_version = newer.event_version
  and older.email = newer.email
  and older.reminder_minutes = newer.reminder_minutes
  and older.status in ('pending', 'processing')
  and newer.status in ('pending', 'processing')
  and (older.created_at, older.id) < (newer.created_at, newer.id);

alter table public.event_reminders alter column event_version set not null;
alter table public.event_reminders alter column event_id set not null;
alter table public.event_reminders alter column event_title set not null;
alter table public.event_reminders alter column event_date set not null;
alter table public.event_reminders alter column event_timezone set default 'Australia/Adelaide';
alter table public.event_reminders alter column event_timezone set not null;
alter table public.event_reminders alter column event_at set not null;
alter table public.event_reminders alter column due_at set not null;
alter table public.event_reminders alter column email set not null;
alter table public.event_reminders alter column reminder_minutes set default 15;
alter table public.event_reminders alter column reminder_minutes set not null;
alter table public.event_reminders alter column status set default 'pending';
alter table public.event_reminders alter column status set not null;
alter table public.event_reminders alter column attempt_count set default 0;
alter table public.event_reminders alter column attempt_count set not null;
alter table public.event_reminders alter column idempotency_key set not null;
alter table public.event_reminders alter column claim_token set default gen_random_uuid()::text;
alter table public.event_reminders alter column created_at set default now();
alter table public.event_reminders alter column created_at set not null;

-- The partial identity is what prevents repeated form submissions from creating two active jobs.
create unique index if not exists event_reminders_active_identity_idx
  on public.event_reminders (event_id, event_version, email, reminder_minutes)
  where status in ('pending', 'processing');
create index if not exists event_reminders_due_idx
  on public.event_reminders (due_at)
  where status = 'pending';

create or replace function public.replace_event_reminder(
  p_event_id text,
  p_event_version text,
  p_event_title text,
  p_event_date date,
  p_event_time text,
  p_event_timezone text,
  p_event_location text,
  p_minutes integer,
  p_email text,
  p_enabled boolean
)
returns public.event_reminders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event_at timestamptz;
  v_due_at timestamptz;
  v_result public.event_reminders;
begin
  if coalesce(auth.role(), '') <> 'authenticated' or auth.uid() is null then raise exception 'Authentication is required'; end if;
  if p_event_id is null or length(trim(p_event_id)) = 0 or length(p_event_id) > 200 then raise exception 'Event id is invalid'; end if;
  if p_event_version is null or length(trim(p_event_version)) = 0 or length(p_event_version) > 200 then raise exception 'Event version is invalid'; end if;
  if p_event_title is null or length(trim(p_event_title)) = 0 or length(p_event_title) > 500 then raise exception 'Event title is invalid'; end if;
  if p_event_date is null then raise exception 'Event date is required'; end if;
  if p_email is null or lower(trim(p_email)) <> 'tacotrump001@gmail.com' then raise exception 'Recipient is not allowed'; end if;
  if p_minutes is null or p_minutes < 0 or p_minutes > 10080 then raise exception 'Reminder minutes must be between 0 and 10080'; end if;
  if p_event_timezone is null or p_event_timezone <> 'Australia/Adelaide' then raise exception 'Unsupported event timezone'; end if;
  if p_event_time is not null and p_event_time !~ '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'Event time is invalid'; end if;
  if p_event_location is not null and length(p_event_location) > 500 then raise exception 'Event location is invalid'; end if;
  if exists (
    select 1 from public.event_reminders
    where event_id = p_event_id and status in ('pending', 'processing')
      and owner_id is distinct from auth.uid()
  ) then raise exception 'Event is owned by another user'; end if;

  -- All-day events use a 06:30 Adelaide wall-clock anchor. Timed events use their local wall-clock time.
  v_event_at := (p_event_date::text || ' ' || coalesce(nullif(p_event_time, ''), '06:30'))::timestamp at time zone p_event_timezone;
  v_due_at := v_event_at - make_interval(mins => p_minutes);

  update public.event_reminders
  set status = 'cancelled', locked_at = null, claim_token = null, send_error = 'Superseded by a newer event version'
  where event_id = p_event_id and owner_id = auth.uid() and status in ('pending', 'processing');

  if not p_enabled then return; end if;

  insert into public.event_reminders (
    owner_id, event_id, event_version, event_title, event_date, event_time, event_timezone, event_at,
    event_location, reminder, reminder_minutes, due_at, email, idempotency_key
  ) values (
    auth.uid(), p_event_id, p_event_version, p_event_title, p_event_date, p_event_time, p_event_timezone, v_event_at,
    p_event_location, p_minutes::text || ' minutes before', p_minutes, v_due_at, lower(trim(p_email)),
    p_event_id || ':' || p_event_version || ':' || lower(trim(p_email)) || ':' || p_minutes
  )
  on conflict (event_id, event_version, email, reminder_minutes) where status in ('pending', 'processing')
  do update set event_title = excluded.event_title, event_date = excluded.event_date,
    event_time = excluded.event_time, event_timezone = excluded.event_timezone, event_at = excluded.event_at,
    event_location = excluded.event_location, due_at = excluded.due_at, status = 'pending', locked_at = null;

  select * into v_result from public.event_reminders
  where event_id = p_event_id and event_version = p_event_version and email = lower(trim(p_email))
    and reminder_minutes = p_minutes and status = 'pending'
  order by created_at desc limit 1;
  return v_result;
end;
$$;

create or replace function public.cancel_event_reminders(p_event_id text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if coalesce(auth.role(), '') <> 'authenticated' or auth.uid() is null then raise exception 'Authentication is required'; end if;
  update public.event_reminders
  set status = 'cancelled', locked_at = null, claim_token = null, send_error = 'Cancelled with event'
  where event_id = p_event_id and owner_id = auth.uid() and status in ('pending', 'processing');
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.claim_due_event_reminders(
  p_now timestamptz default now(), p_limit integer default 25, p_lease_minutes integer default 10, p_grace_hours integer default 24
)
returns setof public.event_reminders
language plpgsql security definer set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Worker claims require service role'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then raise exception 'Invalid claim limit'; end if;
  if p_lease_minutes is null or p_lease_minutes < 1 or p_lease_minutes > 120 then raise exception 'Invalid lease'; end if;
  if p_grace_hours is null or p_grace_hours < 1 or p_grace_hours > 168 then raise exception 'Invalid grace window'; end if;

  update public.event_reminders
  set status = 'expired', locked_at = null, claim_token = null, send_error = 'Reminder expired after outage grace window'
  where status in ('pending', 'processing') and due_at < p_now - make_interval(hours => p_grace_hours);

  return query
  with candidates as (
    select id from public.event_reminders
    where due_at <= p_now
      and event_at >= p_now - make_interval(hours => p_grace_hours)
      and attempt_count < 3
      and (status = 'pending' or (status = 'processing' and locked_at is not null and locked_at < p_now - make_interval(mins => p_lease_minutes)))
    order by due_at, created_at for update skip locked limit p_limit
  )
  update public.event_reminders r
  set status = 'processing', locked_at = p_now, claim_token = gen_random_uuid()::text,
      attempt_count = r.attempt_count + 1, send_error = null
  from candidates where r.id = candidates.id returning r.*;
end;
$$;

create or replace function public.complete_event_reminder(
  p_id uuid,
  p_claim_token text,
  p_success boolean,
  p_resend_id text default null,
  p_error text default null
)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare
  v_rows integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Worker completion requires service role'; end if;
  if p_id is null or p_claim_token is null or length(trim(p_claim_token)) = 0 then
    raise exception 'Reminder completion identity is required';
  end if;
  if p_success is true then
    update public.event_reminders
    set status = 'sent', sent_at = now(), locked_at = null, claim_token = null,
        send_error = null, resend_id = p_resend_id
    where id = p_id and status = 'processing' and claim_token = p_claim_token;
  else
    update public.event_reminders
    set status = case when attempt_count >= 3 then 'failed' else 'pending' end,
        locked_at = null, claim_token = null, send_error = left(coalesce(p_error, 'Unknown send error'), 2000)
    where id = p_id and status = 'processing' and claim_token = p_claim_token;
  end if;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

revoke all on function public.replace_event_reminder(text,text,text,date,text,text,text,integer,text,boolean) from public, anon, authenticated;
revoke all on function public.cancel_event_reminders(text) from public, anon, authenticated;
revoke all on function public.claim_due_event_reminders(timestamptz,integer,integer,integer) from public, anon, authenticated;
revoke all on function public.complete_event_reminder(uuid,text,boolean,text,text) from public, anon, authenticated;
grant execute on function public.replace_event_reminder(text,text,text,date,text,text,text,integer,text,boolean) to authenticated;
grant execute on function public.cancel_event_reminders(text) to authenticated;
grant execute on function public.claim_due_event_reminders(timestamptz,integer,integer,integer) to service_role;
grant execute on function public.complete_event_reminder(uuid,text,boolean,text,text) to service_role;

alter table public.event_reminders enable row level security;
drop policy if exists "Anyone can add event reminders" on public.event_reminders;
create policy "Reminder RPC owns inserts" on public.event_reminders for insert to authenticated with check (false);
-- Service role performs claims and delivery updates; the browser uses the two RPCs above.

-- REVIEW ONLY: protected CRM contacts/events schema.
-- Run only after live zgbz schema/policy inventory and explicit review.
-- This file deliberately has no PUBLIC/anon CRUD policies.

begin;

create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  first_name text not null check (length(btrim(first_name)) > 0),
  last_name text,
  phone text,
  email text,
  address text,
  profession text,
  notes text,
  created_by text not null default 'Myles',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  title text not null check (length(btrim(title)) > 0),
  date date not null,
  time text,
  location text,
  created_by text not null default 'Myles',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists contacts_owner_name_idx on public.contacts (owner_id, first_name, last_name) where deleted_at is null;
create index if not exists events_owner_date_time_idx on public.events (owner_id, date, time) where deleted_at is null;

create or replace function public.crm_prevent_owner_change()
returns trigger language plpgsql security invoker as $$
begin
  if tg_op = 'UPDATE' and new.owner_id is distinct from old.owner_id then
    raise exception 'owner_id is immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists contacts_owner_immutable on public.contacts;
create trigger contacts_owner_immutable before update on public.contacts for each row execute function public.crm_prevent_owner_change();
drop trigger if exists events_owner_immutable on public.events;
create trigger events_owner_immutable before update on public.events for each row execute function public.crm_prevent_owner_change();

alter table public.contacts enable row level security;
alter table public.events enable row level security;

-- Remove only known draft names here; inventory must remove any other broad policies.
drop policy if exists contacts_public_read on public.contacts;
drop policy if exists contacts_public_insert on public.contacts;
drop policy if exists contacts_public_update on public.contacts;
drop policy if exists events_public_read on public.events;
drop policy if exists events_public_insert on public.events;
drop policy if exists events_public_update on public.events;

drop policy if exists contacts_owner_select on public.contacts;
create policy contacts_owner_select on public.contacts for select to authenticated using (owner_id = (select auth.uid()) and deleted_at is null);
drop policy if exists contacts_owner_insert on public.contacts;
create policy contacts_owner_insert on public.contacts for insert to authenticated with check (owner_id = (select auth.uid()));
drop policy if exists contacts_owner_update on public.contacts;
create policy contacts_owner_update on public.contacts for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

drop policy if exists events_owner_select on public.events;
create policy events_owner_select on public.events for select to authenticated using (owner_id = (select auth.uid()) and deleted_at is null);
drop policy if exists events_owner_insert on public.events;
create policy events_owner_insert on public.events for insert to authenticated with check (owner_id = (select auth.uid()));
drop policy if exists events_owner_update on public.events;
create policy events_owner_update on public.events for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

revoke all on public.contacts from anon;
revoke all on public.events from anon;
grant select, insert, update on public.contacts to authenticated;
grant select, insert, update on public.events to authenticated;

commit;

-- Before running: inspect existing policies/grants and add owner_id/backfill notes
-- in a separate reviewed migration. Do not mass-assign ambiguous legacy rows.

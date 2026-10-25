-- Reviewed migration for the live Myles CRM project.
-- Approved by the Supabase project owner on 2026-10-25.
-- Run only in the intended zgbzjeiprratbyjnsbge production project.
-- This assigns the single existing notes row to the approved CRM_OWNER_UID.

begin;

-- Fail closed if the known live shape has changed.
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='notes' and column_name='title')
    or not exists (select 1 from information_schema.columns where table_schema='public' and table_name='notes' and column_name='body')
    or not exists (select 1 from information_schema.columns where table_schema='public' and table_name='notes' and column_name='id' and column_default like '%gen_random_uuid%') then
    raise exception 'Unexpected notes schema or id default; stop and review before migration';
  end if;
  if to_regclass('public.contacts') is not null or to_regclass('public.events') is not null then
    raise exception 'contacts or events already exist; stop and review their live schema before migration';
  end if;
  if (select count(*) from public.notes) <> 1 then
    raise exception 'Expected exactly one existing notes row; stop and review backfill';
  end if;
  if not exists (select 1 from auth.users where id='a54d2b35-6388-44b5-b38c-a155682ab187') then
    raise exception 'Approved CRM owner auth user does not exist';
  end if;
end;
$$;

alter table public.notes add column if not exists owner_id uuid references auth.users(id);
update public.notes set owner_id='a54d2b35-6388-44b5-b38c-a155682ab187' where owner_id is null;
alter table public.notes alter column owner_id set not null;
alter table public.notes alter column owner_id set default auth.uid();

create table if not exists public.contacts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  first_name text not null,
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
  owner_id uuid not null default auth.uid() references auth.users(id),
  title text not null,
  date date not null,
  time text,
  location text,
  created_by text not null default 'Myles',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create or replace function public.crm_prevent_owner_change()
returns trigger language plpgsql security invoker as $$
begin
  if tg_op='UPDATE' and new.owner_id is distinct from old.owner_id then raise exception 'owner_id is immutable'; end if;
  return new;
end;
$$;

do $$
begin
  if exists (select 1 from pg_policies where schemaname='public' and tablename in ('notes','contacts','events')) then
    raise exception 'Unexpected existing CRM policies; review before replacing policies';
  end if;
end;
$$;

create index if not exists notes_owner_created_idx on public.notes(owner_id, created_at);
create index if not exists contacts_owner_name_idx on public.contacts(owner_id, first_name, last_name) where deleted_at is null;
create index if not exists events_owner_date_idx on public.events(owner_id, date, time) where deleted_at is null;

alter table public.notes enable row level security;
alter table public.contacts enable row level security;
alter table public.events enable row level security;

revoke all on public.notes, public.contacts, public.events from public, anon;
grant select, insert, update, delete on public.notes, public.contacts, public.events to authenticated;

create policy notes_owner_select on public.notes for select to authenticated using (owner_id=auth.uid());
create policy notes_owner_insert on public.notes for insert to authenticated with check (owner_id=auth.uid());
create policy notes_owner_update on public.notes for update to authenticated using (owner_id=auth.uid()) with check (owner_id=auth.uid());
create policy notes_owner_delete on public.notes for delete to authenticated using (owner_id=auth.uid());

create policy contacts_owner_select on public.contacts for select to authenticated using (owner_id=auth.uid() and deleted_at is null);
create policy contacts_owner_insert on public.contacts for insert to authenticated with check (owner_id=auth.uid());
create policy contacts_owner_update on public.contacts for update to authenticated using (owner_id=auth.uid()) with check (owner_id=auth.uid());
create policy contacts_owner_delete on public.contacts for delete to authenticated using (owner_id=auth.uid());

create policy events_owner_select on public.events for select to authenticated using (owner_id=auth.uid() and deleted_at is null);
create policy events_owner_insert on public.events for insert to authenticated with check (owner_id=auth.uid());
create policy events_owner_update on public.events for update to authenticated using (owner_id=auth.uid()) with check (owner_id=auth.uid());
create policy events_owner_delete on public.events for delete to authenticated using (owner_id=auth.uid());

create trigger notes_owner_immutable before update on public.notes for each row execute function public.crm_prevent_owner_change();
create trigger contacts_owner_immutable before update on public.contacts for each row execute function public.crm_prevent_owner_change();
create trigger events_owner_immutable before update on public.events for each row execute function public.crm_prevent_owner_change();

commit;

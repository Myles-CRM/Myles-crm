-- REVIEW ONLY: protected owner migration for the existing checklist notes table.
-- Do not run until live columns, rows, policies, grants, and legacy callers are inventoried.
-- Ambiguous legacy rows must be backfilled separately and explicitly.

begin;

create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id),
  category text not null,
  content text not null,
  created_by text not null default 'Myles',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'notes' and column_name = 'owner_id') then
    raise exception 'notes.owner_id is missing; stop and perform a reviewed backfill migration first';
  end if;
end;
$$;

do $$
declare unexpected text;
begin
  select string_agg(format('%s.%s', schemaname, policyname), ', ' order by schemaname, policyname) into unexpected
  from pg_policies
  where schemaname = 'public' and tablename = 'notes'
    and policyname not in ('notes_public_read', 'notes_public_insert', 'notes_public_update', 'notes_owner_select', 'notes_owner_insert', 'notes_owner_update');
  if unexpected is not null then raise exception 'Unexpected notes policies found; inventory first: %', unexpected; end if;
end;
$$;

do $$
declare broad text;
begin
  select string_agg(format('%s.%s.%s', grantee, table_name, privilege_type), ', ' order by table_name, grantee, privilege_type) into broad
  from information_schema.table_privileges
  where table_schema = 'public' and table_name = 'notes'
    and grantee in ('PUBLIC', 'anon') and privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE');
  if broad is not null then raise exception 'Broad notes grants found; inventory and revoke explicitly first: %', broad; end if;
end;
$$;

create index if not exists notes_owner_category_created_idx on public.notes (owner_id, category, created_at) where deleted_at is null;

create or replace function public.crm_prevent_owner_change()
returns trigger language plpgsql security invoker as $$
begin
  if tg_op = 'UPDATE' and new.owner_id is distinct from old.owner_id then raise exception 'owner_id is immutable'; end if;
  return new;
end;
$$;

drop trigger if exists notes_owner_immutable on public.notes;
create trigger notes_owner_immutable before update on public.notes for each row execute function public.crm_prevent_owner_change();

alter table public.notes enable row level security;
drop policy if exists notes_public_read on public.notes;
drop policy if exists notes_public_insert on public.notes;
drop policy if exists notes_public_update on public.notes;
drop policy if exists notes_owner_select on public.notes;
create policy notes_owner_select on public.notes for select to authenticated using (owner_id = (select auth.uid()) and deleted_at is null);
drop policy if exists notes_owner_insert on public.notes;
create policy notes_owner_insert on public.notes for insert to authenticated with check (owner_id = (select auth.uid()));
drop policy if exists notes_owner_update on public.notes;
create policy notes_owner_update on public.notes for update to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

revoke all on public.notes from anon;
grant select, insert, update on public.notes to authenticated;

commit;

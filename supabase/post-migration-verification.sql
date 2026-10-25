-- Read-only verification after notes-owner.sql migration.
-- Run in the intended zgbzjeiprratbyjnsbge project.

select
  'TABLES' as section,
  table_name as item,
  '' as detail_1,
  '' as detail_2
from information_schema.tables
where table_schema = 'public'
  and table_name in ('notes', 'contacts', 'events')

union all

select
  'OWNER_COLUMNS',
  table_name,
  column_name,
  data_type
from information_schema.columns
where table_schema = 'public'
  and table_name in ('notes', 'contacts', 'events')
  and column_name = 'owner_id'

union all

select
  'POLICIES',
  tablename,
  policyname,
  cmd
from pg_policies
where schemaname = 'public'
  and tablename in ('notes', 'contacts', 'events')

union all

select
  'ANON_GRANTS',
  table_name,
  grantee,
  privilege_type
from information_schema.table_privileges
where table_schema = 'public'
  and table_name in ('notes', 'contacts', 'events')
  and grantee in ('anon', 'PUBLIC')

union all

select
  'NOTE_OWNER_COUNT',
  'notes',
  count(*)::text,
  count(owner_id)::text
from public.notes

order by section, item, detail_1;

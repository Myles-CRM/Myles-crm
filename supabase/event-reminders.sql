-- Run this in Supabase SQL Editor before enabling email reminders.
create table if not exists public.event_reminders (
  id uuid primary key default gen_random_uuid(),
  event_id text,
  event_title text not null,
  event_date date not null,
  event_time text,
  event_location text,
  reminder text not null,
  reminder_minutes integer not null default 15,
  due_at timestamptz not null,
  email text not null,
  sent_at timestamptz,
  send_error text,
  resend_id text,
  created_at timestamptz not null default now()
);

alter table public.event_reminders
  add column if not exists reminder_minutes integer not null default 15;

create index if not exists event_reminders_due_idx
  on public.event_reminders (due_at)
  where sent_at is null;

alter table public.event_reminders enable row level security;

drop policy if exists "Anyone can add event reminders" on public.event_reminders;
create policy "Anyone can add event reminders"
  on public.event_reminders
  for insert
  to anon
  with check (email = 'tacotrumpet001@gmail.com');

-- Reads/updates for sending use SUPABASE_SERVICE_KEY in the scheduled function.

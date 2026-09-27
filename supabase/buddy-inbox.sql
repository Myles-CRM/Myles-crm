-- Run this in Supabase SQL Editor before enabling Buddy Inbox.
-- The webhook API writes with SUPABASE_SERVICE_KEY, so this table does not allow public browser reads.
create table if not exists public.buddy_inbox_messages (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'resend',
  event_type text not null default 'email.received',
  email_id text,
  message_id text,
  from_email text,
  to_emails text[] not null default '{}',
  cc_emails text[] not null default '{}',
  bcc_emails text[] not null default '{}',
  subject text not null default '(no subject)',
  received_at timestamptz not null default now(),
  text_body text,
  html_body text,
  summary text,
  attachment_count integer not null default 0,
  attachments jsonb not null default '[]'::jsonb,
  raw_payload jsonb not null,
  status text not null default 'new',
  created_at timestamptz not null default now()
);

create index if not exists buddy_inbox_messages_received_idx
  on public.buddy_inbox_messages (received_at desc);

create index if not exists buddy_inbox_messages_status_idx
  on public.buddy_inbox_messages (status);

alter table public.buddy_inbox_messages enable row level security;

-- No anon policies on purpose: inbound emails can contain private information.
-- Reads and writes should go through server-side code with SUPABASE_SERVICE_KEY.

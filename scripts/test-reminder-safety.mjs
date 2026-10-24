import assert from 'node:assert/strict';
import fs from 'node:fs';

const sql = fs.readFileSync(new URL('../supabase/event-reminders.sql', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('../lib/reminders.js', import.meta.url), 'utf8');
const calendar = fs.readFileSync(new URL('../public/calendar.html', import.meta.url), 'utf8');
const reminderApi = fs.readFileSync(new URL('../api/calendar-reminders.js', import.meta.url), 'utf8');
const uiRecipient = calendar.match(/const reminderEmailAddress = '([^']+)'/)?.[1];
assert.ok(uiRecipient, 'calendar must define a reminder recipient');

for (const marker of [
  'replace_event_reminder',
  'cancel_event_reminders',
  'claim_due_event_reminders',
  'for update skip locked',
  'event_reminders_active_identity_idx',
  'Australia/Adelaide',
  '06:30',
  'p_grace_hours integer default 24',
  "status = 'expired'",
  'delete from public.event_reminders older',
  'p_event_time !~',
  'Invalid claim limit',
  'get diagnostics v_count = row_count',
  'auth.uid() is not null',
  'Authenticated owner or server owner is required',
  "= 'service_role'",
  'owner_id = v_owner_id',
  'event_at >= p_now - make_interval(hours => p_grace_hours)',
  'claim_token = gen_random_uuid()::text',
  'complete_event_reminder',
  'p_success boolean',
  'grant execute on function public.complete_event_reminder',
]) assert.ok(sql.toLowerCase().includes(marker.toLowerCase()), marker);
assert.match(worker, /Idempotency-Key/);
assert.match(worker, /rpc\('claim_due_event_reminders'/);
assert.match(worker, /p_success: true/);
assert.match(sql, /attempt_count >= 3/);
assert.match(worker, /maybeSingle()/);
assert.match(worker, /Claim was cancelled or lost/);
assert.match(worker, /persistenceError/);
assert.match(worker, /claim_token/);
assert.match(worker, /complete_event_reminder/);
assert.match(worker, /completionUncertain/);
assert.match(calendar, /p_event_timezone: 'Australia\/Adelaide'/);
assert.match(calendar, /crypto\?\.randomUUID/);
assert.match(calendar, /newReminderVersion/);
assert.match(calendar, /api\/calendar-reminders/);
assert.equal(calendar.includes("rpc('replace_event_reminder'"), false);
assert.equal(calendar.includes("rpc('cancel_event_reminders'"), false);
assert.match(reminderApi, /CRM_ADMIN_TOKEN/);
assert.match(reminderApi, /p_owner_id: REMINDER_OWNER_ID/);
assert.ok(sql.includes('lower(trim(p_email)) <> ' + "'" + uiRecipient + "'"), 'SQL validator must accept the calendar recipient');
const replaceLegacyDrop = sql.indexOf('drop function if exists public.replace_event_reminder(text,text,text,date,text,text,text,integer,text,boolean)');
const cancelLegacyDrop = sql.indexOf('drop function if exists public.cancel_event_reminders(text)');
assert.ok(replaceLegacyDrop >= 0, 'replace legacy signature must be dropped if present');
assert.ok(cancelLegacyDrop >= 0, 'cancel legacy signature must be dropped if present');
assert.doesNotMatch(sql, /grant execute on function public\.replace_event_reminder[^;]* to anon/i);
assert.doesNotMatch(sql, /grant execute on function public\.cancel_event_reminders[^;]* to anon/i);
assert.match(sql, /grant execute on function public\.replace_event_reminder[^;]* to authenticated/i);
assert.match(sql, /grant execute on function public\.cancel_event_reminders[^;]* to authenticated/i);
console.log('Reminder safety source checks passed.');

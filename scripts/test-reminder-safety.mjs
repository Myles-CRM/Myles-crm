import assert from 'node:assert/strict';
import fs from 'node:fs';

const sql = fs.readFileSync(new URL('../supabase/event-reminders.sql', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('../lib/reminders.js', import.meta.url), 'utf8');
const calendar = fs.readFileSync(new URL('../public/calendar.html', import.meta.url), 'utf8');

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
  'returning 1',
]) assert.ok(sql.toLowerCase().includes(marker.toLowerCase()), marker);
assert.match(worker, /Idempotency-Key/);
assert.match(worker, /rpc\('claim_due_event_reminders'/);
assert.match(worker, /status: 'sent'/);
assert.match(worker, /attempt_count >= 3/);
assert.match(worker, /maybeSingle()/);
assert.match(worker, /Claim was cancelled or lost/);
assert.match(worker, /persistenceError/);
assert.match(calendar, /rpc\('replace_event_reminder'/);
assert.match(calendar, /rpc\('cancel_event_reminders'/);
assert.match(calendar, /p_event_timezone: 'Australia\/Adelaide'/);
console.log('Reminder safety source checks passed.');

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const REMINDER_FROM_EMAIL = process.env.REMINDER_FROM_EMAIL || 'Myles CRM <onboarding@resend.dev>';
const DEFAULT_TO_EMAIL = process.env.REMINDER_TO_EMAIL || 'tacotrumpet001@gmail.com';

function jsonHeaders() {
  return { 'Content-Type': 'application/json' };
}

function missingConfig() {
  const missing = [];
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_SERVICE_KEY) missing.push('SUPABASE_SERVICE_KEY');
  if (!RESEND_API_KEY) missing.push('RESEND_API_KEY');
  return missing;
}

function formatEventTime(reminder) {
  const date = reminder.event_date || 'Unknown date';
  const time = reminder.event_time || 'all day';
  return `${date} at ${time}`;
}

function emailBody(reminder) {
  const lines = [
    `Reminder: ${reminder.event_title}`,
    '',
    `When: ${formatEventTime(reminder)}`,
  ];

  if (reminder.event_location) lines.push(`Where: ${reminder.event_location}`);
  if (reminder.reminder) lines.push(`Reminder setting: ${reminder.reminder}`);

  lines.push('', 'From Myles CRM');
  return lines.join('\n');
}

async function sendReminderEmail(reminder) {
  if (!reminder.idempotency_key) throw new Error('Reminder has no idempotency key');
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      ...jsonHeaders(),
      Authorization: 'Bearer ' + RESEND_API_KEY,
      'Idempotency-Key': reminder.idempotency_key,
    },
    body: JSON.stringify({
      from: REMINDER_FROM_EMAIL,
      to: [reminder.email || DEFAULT_TO_EMAIL],
      subject: `Reminder: ${reminder.event_title}`,
      text: emailBody(reminder),
    }),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Resend returned ${response.status}: ${message}`);
  }

  return response.json();
}

export async function processDueReminders({ now = new Date(), supabaseClient, sendEmail = sendReminderEmail } = {}) {
  const missing = missingConfig();
  if (missing.length) {
    return { ok: false, skipped: true, reason: `Missing ${missing.join(', ')}` };
  }

  const supabase = supabaseClient || createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  const nowIso = now.toISOString();

  const { data: reminders, error } = await supabase.rpc('claim_due_event_reminders', {
    p_now: nowIso,
    p_limit: 25,
    p_lease_minutes: 10,
    p_grace_hours: 24,
  });

  if (error) throw error;

  const results = [];
  for (const reminder of reminders || []) {
    try {
      // Cancellation can happen after claim but before the network request. Re-read
      // the state immediately before sending so cancelled jobs are not delivered.
      const { data: current, error: stateError } = await supabase
        .from('event_reminders')
        .select('status')
        .eq('id', reminder.id)
        .maybeSingle();
      if (stateError) throw stateError;
      if (!current || current.status !== 'processing') {
        results.push({ id: reminder.id, sent: false, skipped: true, reason: 'Claim was cancelled or lost' });
        continue;
      }

      const emailResult = await sendEmail(reminder);
      const { data: persisted, error: updateError } = await supabase
        .from('event_reminders')
        .update({ status: 'sent', sent_at: nowIso, locked_at: null, send_error: null, resend_id: emailResult.id || null })
        .eq('id', reminder.id)
        .eq('status', 'processing')
        .select('id')
        .maybeSingle();
      if (updateError) throw updateError;
      if (!persisted) throw new Error('Reminder claim was lost after email delivery');
      results.push({ id: reminder.id, sent: true });
    } catch (sendError) {
      const message = sendError.message || 'Unknown send error';
      const nextStatus = reminder.attempt_count >= 3 ? 'failed' : 'pending';
      const { error: persistError } = await supabase
        .from('event_reminders')
        .update({ status: nextStatus, locked_at: null, send_error: message })
        .eq('id', reminder.id)
        .eq('status', 'processing');
      results.push({ id: reminder.id, sent: false, error: message, persistenceError: persistError?.message || null });
    }
  }

  return { ok: true, checkedAt: nowIso, processed: results.length, results };
}

export function isCronAuthorized(headers = {}) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  const auth = headers.authorization || headers.Authorization || '';
  return auth === `Bearer ${secret}`;
}

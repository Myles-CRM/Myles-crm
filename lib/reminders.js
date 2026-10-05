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
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      ...jsonHeaders(),
      Authorization: 'Bearer ' + RESEND_API_KEY,
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

export async function processDueReminders({ now = new Date() } = {}) {
  const missing = missingConfig();
  if (missing.length) {
    return { ok: false, skipped: true, reason: `Missing ${missing.join(', ')}` };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  const nowIso = now.toISOString();

  const { data: reminders, error } = await supabase
    .from('event_reminders')
    .select('*')
    .is('sent_at', null)
    .lte('due_at', nowIso)
    .limit(25);

  if (error) throw error;

  const results = [];
  for (const reminder of reminders || []) {
    try {
      const emailResult = await sendReminderEmail(reminder);
      const { error: updateError } = await supabase
        .from('event_reminders')
        .update({ sent_at: nowIso, send_error: null, resend_id: emailResult.id || null })
        .eq('id', reminder.id);
      if (updateError) throw updateError;
      results.push({ id: reminder.id, sent: true });
    } catch (sendError) {
      const message = sendError.message || 'Unknown send error';
      await supabase
        .from('event_reminders')
        .update({ send_error: message })
        .eq('id', reminder.id);
      results.push({ id: reminder.id, sent: false, error: message });
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

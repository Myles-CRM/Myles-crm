import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BUDDY_INBOX_WEBHOOK_TOKEN = process.env.BUDDY_INBOX_WEBHOOK_TOKEN;

function jsonResponse(res, status, body) {
  return res.status(status).json(body);
}

function headerValue(headers, name) {
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || '';
}

function requestToken(req) {
  const auth = headerValue(req.headers, 'authorization');
  if (auth.startsWith('Bearer ')) return auth.slice('Bearer '.length).trim();
  return headerValue(req.headers, 'x-buddy-inbox-token') || req.query?.token || '';
}

function missingConfig() {
  const missing = [];
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_SERVICE_KEY) missing.push('SUPABASE_SERVICE_KEY');
  if (!BUDDY_INBOX_WEBHOOK_TOKEN) missing.push('BUDDY_INBOX_WEBHOOK_TOKEN');
  return missing;
}

function isAuthorized(req) {
  if (!BUDDY_INBOX_WEBHOOK_TOKEN) return false;
  return requestToken(req) === BUDDY_INBOX_WEBHOOK_TOKEN;
}

function stripHtml(html = '') {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function bulletise(text = '') {
  return String(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (line.startsWith('• ') ? line : `• ${line}`))
    .join('\n');
}

function noteContentFromMessage(message) {
  const body = message.text_body || stripHtml(message.html_body || '') || message.summary || '';
  const receivedAt = message.received_at ? new Date(message.received_at).toLocaleString('en-AU', { timeZone: 'Australia/Adelaide' }) : 'unknown time';
  const lines = [
    `• Buddy Inbox email: ${message.subject || '(no subject)'}`,
    `• From: ${message.from_email || 'unknown sender'}`,
    `• Received: ${receivedAt}`,
  ];

  if (body.trim()) {
    lines.push('', bulletise(body).slice(0, 7000));
  } else {
    lines.push('', '• No readable email body was included.');
  }

  return lines.join('\n').slice(0, 8000);
}

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST');
    return jsonResponse(res, 405, { ok: false, error: 'Method Not Allowed' });
  }

  const missing = missingConfig();
  if (missing.length) {
    return jsonResponse(res, 503, { ok: false, skipped: true, reason: `Missing ${missing.join(', ')}` });
  }

  if (!isAuthorized(req)) {
    return jsonResponse(res, 401, { ok: false, error: 'Unauthorized' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  const limit = Math.min(Math.max(Number(req.query?.limit || 5), 1), 20);

  const { data: messages, error: readError } = await supabase
    .from('buddy_inbox_messages')
    .select('id, subject, from_email, received_at, text_body, html_body, summary, status')
    .in('status', ['new', 'ready', 'metadata-only'])
    .order('received_at', { ascending: true })
    .limit(limit);

  if (readError) {
    return jsonResponse(res, 500, { ok: false, error: readError.message || 'Could not read Buddy Inbox messages' });
  }

  const results = [];
  for (const message of messages || []) {
    try {
      const content = noteContentFromMessage(message);
      const { data: note, error: noteError } = await supabase
        .from('notes')
        .insert([{ category: 'general', content, created_by: 'Buddy Inbox' }])
        .select('id')
        .single();
      if (noteError) throw noteError;

      const { error: updateError } = await supabase
        .from('buddy_inbox_messages')
        .update({ status: 'noted' })
        .eq('id', message.id);
      if (updateError) throw updateError;

      results.push({ inboxId: message.id, noteId: note?.id || null, subject: message.subject || '(no subject)', noted: true });
    } catch (error) {
      results.push({ inboxId: message.id, subject: message.subject || '(no subject)', noted: false, error: error.message || 'Could not create note' });
    }
  }

  return jsonResponse(res, 200, {
    ok: true,
    processed: results.length,
    results,
    message: results.length ? 'Buddy Inbox messages were turned into General notes.' : 'No new Buddy Inbox messages to turn into notes.',
  });
}

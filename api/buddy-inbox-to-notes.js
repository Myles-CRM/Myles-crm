import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BUDDY_INBOX_WEBHOOK_TOKEN = process.env.BUDDY_INBOX_WEBHOOK_TOKEN;
const ELIGIBLE_STATUSES = ['new', 'ready', 'metadata-only'];

function jsonResponse(res, status, body) {
  return res.status(status).json(body);
}

function headerValue(headers, name) {
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || '';
}

function requestToken(headers = {}) {
  const auth = headerValue(headers, 'authorization');
  if (auth.startsWith('Bearer ')) return auth.slice('Bearer '.length).trim();
  return headerValue(headers, 'x-buddy-inbox-token');
}

function missingConfig() {
  const missing = [];
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_SERVICE_KEY) missing.push('SUPABASE_SERVICE_KEY');
  if (!BUDDY_INBOX_WEBHOOK_TOKEN) missing.push('BUDDY_INBOX_WEBHOOK_TOKEN');
  return missing;
}

function isAuthorized(headers = {}) {
  if (!BUDDY_INBOX_WEBHOOK_TOKEN) return false;
  return requestToken(headers) === BUDDY_INBOX_WEBHOOK_TOKEN;
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

function cleanSnippet(message) {
  const source = message.summary || message.text_body || stripHtml(message.html_body || '');
  return String(source)
    .replace(/https?:\/\/\S+/g, '[link]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function noteBlockFromMessage(message) {
  const receivedAt = message.received_at
    ? new Date(message.received_at).toLocaleString('en-AU', { timeZone: 'Australia/Adelaide' })
    : 'unknown time';
  const snippet = cleanSnippet(message) || 'No readable preview was included.';

  return [
    `• Buddy Inbox: ${message.subject || '(no subject)'}`,
    `• From: ${message.from_email || 'unknown sender'}`,
    `• Received: ${receivedAt}`,
    `• Preview: ${snippet}`,
  ].join('\n');
}

function appendNoteContent(existing = '', blocks = []) {
  const header = '• Buddy Inbox processed emails';
  const separator = '\n\n';
  const body = blocks.join('\n\n');
  const current = String(existing || '').trim();
  const next = current ? `${current}${separator}${body}` : `${header}${separator}${body}`;
  return next.slice(-8000);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return jsonResponse(res, 405, { ok: false, error: 'Method Not Allowed' });
  }

  const missing = missingConfig();
  if (missing.length) {
    return jsonResponse(res, 503, { ok: false, skipped: true, reason: `Missing ${missing.join(', ')}` });
  }

  if (!isAuthorized(req.headers || {})) {
    return jsonResponse(res, 401, { ok: false, error: 'Unauthorized' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  const limit = Math.min(Math.max(Number(req.body?.limit || 5), 1), 20);

  const { data: candidates, error: readError } = await supabase
    .from('buddy_inbox_messages')
    .select('id, subject, from_email, received_at, text_body, html_body, summary, status')
    .in('status', ELIGIBLE_STATUSES)
    .order('received_at', { ascending: true })
    .limit(limit);

  if (readError) {
    return jsonResponse(res, 500, { ok: false, error: 'Could not read Buddy Inbox messages' });
  }

  const claimed = [];
  for (const candidate of candidates || []) {
    const { data: claim, error: claimError } = await supabase
      .from('buddy_inbox_messages')
      .update({ status: 'processing' })
      .eq('id', candidate.id)
      .in('status', ELIGIBLE_STATUSES)
      .select('id, subject, from_email, received_at, text_body, html_body, summary')
      .single();

    if (!claimError && claim) claimed.push(claim);
  }

  if (!claimed.length) {
    return jsonResponse(res, 200, { ok: true, processed: 0, message: 'No new Buddy Inbox messages to turn into notes.' });
  }

  try {
    const { data: latestNotes, error: latestError } = await supabase
      .from('notes')
      .select('content')
      .eq('category', 'general')
      .is('deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(1);

    if (latestError) throw latestError;

    const blocks = claimed.map(noteBlockFromMessage);
    const content = appendNoteContent(latestNotes?.[0]?.content || '', blocks);
    const { data: note, error: noteError } = await supabase
      .from('notes')
      .insert([{ category: 'general', content, created_by: 'Buddy Inbox' }])
      .select('id')
      .single();

    if (noteError) throw noteError;

    for (const message of claimed) {
      await supabase
        .from('buddy_inbox_messages')
        .update({ status: 'noted' })
        .eq('id', message.id)
        .eq('status', 'processing');
    }

    return jsonResponse(res, 200, {
      ok: true,
      processed: claimed.length,
      noteId: note?.id || null,
      subjects: claimed.map((message) => message.subject || '(no subject)'),
      message: 'Buddy Inbox messages were appended to General notes.',
    });
  } catch (error) {
    for (const message of claimed) {
      await supabase
        .from('buddy_inbox_messages')
        .update({ status: 'error' })
        .eq('id', message.id)
        .eq('status', 'processing');
    }

    return jsonResponse(res, 500, { ok: false, error: 'Could not create CRM note from Buddy Inbox messages' });
  }
}

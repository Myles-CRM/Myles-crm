import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BUDDY_INBOX_ACTION_TOKEN = process.env.BUDDY_INBOX_ACTION_TOKEN;
const ACTIONABLE_STATUSES = ['new', 'ready', 'metadata-only', 'reviewed'];

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
  if (!BUDDY_INBOX_ACTION_TOKEN) missing.push('BUDDY_INBOX_ACTION_TOKEN');
  return missing;
}

function isAuthorized(headers = {}) {
  if (!BUDDY_INBOX_ACTION_TOKEN) return false;
  return requestToken(headers) === BUDDY_INBOX_ACTION_TOKEN;
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

function cleanText(value = '', maxLength = 1200) {
  return String(value || '')
    .replace(/https?:\/\/\S+/g, '[link]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function messagePreview(message) {
  return cleanText(message.summary || message.text_body || stripHtml(message.html_body || ''), 1200);
}

function safeDate(value) {
  if (!value) return 'unknown time';
  return new Date(value).toLocaleString('en-AU', { timeZone: 'Australia/Adelaide' });
}

function noteBlockFromMessage(message) {
  const preview = messagePreview(message) || 'No readable preview was included.';
  return [
    `• Buddy Inbox: ${message.subject || '(no subject)'}`,
    `• From: ${message.from_email || 'unknown sender'}`,
    `• Received: ${safeDate(message.received_at)}`,
    `• Buddy summary: ${preview}`,
  ].join('\n');
}

function buildBuddyNote(messages = [], noteContent = '') {
  const writtenByBuddy = cleanText(noteContent, 6000);
  if (writtenByBuddy) return writtenByBuddy;

  const blocks = messages.map(noteBlockFromMessage).join('\n\n');
  return `• Buddy Inbox note\n\n${blocks}`.slice(0, 8000);
}

function idList(value) {
  const values = Array.isArray(value) ? value : [value];
  return values
    .map((id) => String(id || '').trim())
    .filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
    .slice(0, 10);
}

async function listMessages(supabase, limit) {
  const safeLimit = Math.min(Math.max(Number(limit || 10), 1), 25);
  const { data, error } = await supabase
    .from('buddy_inbox_messages')
    .select('id, subject, from_email, to_emails, received_at, summary, text_body, html_body, attachment_count, status')
    .in('status', ACTIONABLE_STATUSES)
    .order('received_at', { ascending: false })
    .limit(safeLimit);

  if (error) throw error;

  return (data || []).map((message) => ({
    id: message.id,
    subject: message.subject || '(no subject)',
    fromEmail: message.from_email || 'unknown sender',
    toEmails: message.to_emails || [],
    receivedAt: message.received_at,
    status: message.status,
    attachmentCount: message.attachment_count || 0,
    preview: messagePreview(message),
  }));
}

async function createNoteFromMessages(supabase, req) {
  const ids = idList(req.body?.messageIds || req.body?.messageId);
  if (!ids.length) {
    return { ok: true, processed: 0, message: 'No valid Buddy Inbox message ids were supplied.' };
  }

  const { data: messages, error: claimError } = await supabase
    .from('buddy_inbox_messages')
    .update({ status: 'processing' })
    .in('id', ids)
    .in('status', ACTIONABLE_STATUSES)
    .select('id, subject, from_email, received_at, summary, text_body, html_body, status');

  if (claimError) throw claimError;
  if (!messages?.length) {
    return { ok: true, processed: 0, message: 'No matching Buddy Inbox messages were ready for Buddy to file.' };
  }

  try {
    const content = buildBuddyNote(messages, req.body?.noteContent);
    const { data: note, error: noteError } = await supabase
      .from('notes')
      .insert([{ category: req.body?.category || 'general', content, created_by: 'Buddy' }])
      .select('id')
      .single();

    if (noteError) throw noteError;

    const { error: updateError } = await supabase
      .from('buddy_inbox_messages')
      .update({ status: 'noted' })
      .in('id', messages.map((message) => message.id))
      .eq('status', 'processing');

    if (updateError) throw updateError;

    return {
      ok: true,
      processed: messages.length,
      noteId: note?.id || null,
      subjects: messages.map((message) => message.subject || '(no subject)'),
      message: 'Buddy filed selected inbox message(s) into Notes.',
    };
  } catch (error) {
    await supabase
      .from('buddy_inbox_messages')
      .update({ status: 'error' })
      .in('id', messages.map((message) => message.id))
      .eq('status', 'processing');
    throw error;
  }
}

async function updateMessageStatus(supabase, req, status) {
  const ids = idList(req.body?.messageIds || req.body?.messageId);
  if (!ids.length) return { ok: true, processed: 0, message: 'No valid message ids were supplied.' };

  const { data, error } = await supabase
    .from('buddy_inbox_messages')
    .update({ status })
    .in('id', ids)
    .select('id, subject');

  if (error) throw error;

  return {
    ok: true,
    processed: data?.length || 0,
    subjects: (data || []).map((message) => message.subject || '(no subject)'),
    message: `Buddy marked selected message(s) as ${status}.`,
  };
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
  const action = req.body?.action || 'list';

  try {
    if (action === 'list') {
      return jsonResponse(res, 200, { ok: true, messages: await listMessages(supabase, req.body?.limit) });
    }

    if (action === 'create_note') {
      return jsonResponse(res, 200, await createNoteFromMessages(supabase, req));
    }

    if (action === 'archive') {
      return jsonResponse(res, 200, await updateMessageStatus(supabase, req, 'archived'));
    }

    if (action === 'mark_reviewed') {
      return jsonResponse(res, 200, await updateMessageStatus(supabase, req, 'reviewed'));
    }

    return jsonResponse(res, 400, { ok: false, error: 'Unknown Buddy Inbox action' });
  } catch (error) {
    return jsonResponse(res, 500, { ok: false, error: 'Could not complete Buddy Inbox action' });
  }
}

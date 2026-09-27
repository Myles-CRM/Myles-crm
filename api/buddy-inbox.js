import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const BUDDY_INBOX_WEBHOOK_TOKEN = process.env.BUDDY_INBOX_WEBHOOK_TOKEN;
const BUDDY_INBOX_ALLOWED_TO = (process.env.BUDDY_INBOX_ALLOWED_TO || '')
  .split(',')
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

function jsonResponse(res, status, body) {
  return res.status(status).json(body);
}

function configStatus() {
  const missing = [];
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_SERVICE_KEY) missing.push('SUPABASE_SERVICE_KEY');
  if (!RESEND_API_KEY) missing.push('RESEND_API_KEY');
  if (!BUDDY_INBOX_WEBHOOK_TOKEN) missing.push('BUDDY_INBOX_WEBHOOK_TOKEN');
  return { ready: missing.length === 0, missing };
}

function headerValue(headers, name) {
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || '';
}

function requestToken(req) {
  const auth = headerValue(req.headers, 'authorization');
  if (auth.startsWith('Bearer ')) return auth.slice('Bearer '.length).trim();
  return headerValue(req.headers, 'x-buddy-inbox-token') || req.query?.token || '';
}

function isAuthorized(req) {
  if (!BUDDY_INBOX_WEBHOOK_TOKEN) return false;
  return requestToken(req) === BUDDY_INBOX_WEBHOOK_TOKEN;
}

function asArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

function emailFrom(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return value.email || value.address || value.value || '';
}

function emailsFrom(value) {
  return asArray(value).map(emailFrom).filter(Boolean);
}

function findData(payload = {}) {
  return payload.data || payload.email || payload.message || payload;
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== '') || '';
}

function snippetFrom(...values) {
  const source = firstValue(...values);
  return String(source)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 280);
}

async function fetchReceivedEmail(emailId) {
  if (!RESEND_API_KEY || !emailId) return null;
  const response = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${RESEND_API_KEY}`,
    },
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Resend receiving API returned ${response.status}: ${message}`);
  }

  const body = await response.json();
  return body.data || body;
}

function normalisePayload(payload = {}, receivedEmail = null) {
  const data = { ...findData(payload), ...(receivedEmail || {}) };
  const toEmails = emailsFrom(data.to || data.recipients || data.rcpt_to || data.headers?.to);
  const ccEmails = emailsFrom(data.cc || data.headers?.cc);
  const bccEmails = emailsFrom(data.bcc || data.headers?.bcc);
  const textBody = firstValue(data.text, data.text_body, data.plain, data.body?.text);
  const htmlBody = firstValue(data.html, data.html_body, data.body?.html);

  return {
    provider: 'resend',
    event_type: payload.type || payload.event || 'email.received',
    email_id: firstValue(data.email_id, data.id, data.message_id, payload.id),
    message_id: firstValue(data.message_id, data.headers?.['message-id']),
    from_email: emailFrom(data.from || data.sender || data.headers?.from),
    to_emails: toEmails,
    cc_emails: ccEmails,
    bcc_emails: bccEmails,
    subject: firstValue(data.subject, data.headers?.subject, '(no subject)'),
    received_at: firstValue(data.created_at, data.received_at, payload.created_at, new Date().toISOString()),
    text_body: textBody || null,
    html_body: htmlBody || null,
    summary: snippetFrom(textBody, htmlBody, data.subject),
    attachment_count: asArray(data.attachments).length,
    attachments: asArray(data.attachments),
    raw_payload: receivedEmail ? { webhook: payload, received_email: receivedEmail } : payload,
    status: receivedEmail ? 'ready' : 'metadata-only',
  };
}

function allowedRecipient(message) {
  if (!BUDDY_INBOX_ALLOWED_TO.length) return true;
  const recipients = [...message.to_emails, ...message.cc_emails, ...message.bcc_emails]
    .map((email) => email.toLowerCase());
  return recipients.some((email) => BUDDY_INBOX_ALLOWED_TO.includes(email));
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const status = configStatus();
    return jsonResponse(res, 200, {
      ok: true,
      ready: status.ready,
      missing: status.missing,
      allowedRecipientsConfigured: BUDDY_INBOX_ALLOWED_TO.length > 0,
      message: status.ready
        ? 'Buddy Inbox webhook is configured.'
        : 'Buddy Inbox is designed but waiting for parent-approved secrets.',
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return jsonResponse(res, 405, { ok: false, error: 'Method Not Allowed' });
  }

  const status = configStatus();
  if (!status.ready) {
    return jsonResponse(res, 503, { ok: false, skipped: true, reason: `Missing ${status.missing.join(', ')}` });
  }

  if (!isAuthorized(req)) {
    return jsonResponse(res, 401, { ok: false, error: 'Unauthorized' });
  }

  let message = normalisePayload(req.body || {});
  if (message.event_type === 'email.received' && message.email_id) {
    try {
      const receivedEmail = await fetchReceivedEmail(message.email_id);
      message = normalisePayload(req.body || {}, receivedEmail);
    } catch (error) {
      return jsonResponse(res, 502, { ok: false, error: error.message || 'Could not fetch received email body' });
    }
  }

  if (!allowedRecipient(message)) {
    return jsonResponse(res, 202, { ok: true, skipped: true, reason: 'Recipient not allowed for Buddy Inbox' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  const { data, error } = await supabase
    .from('buddy_inbox_messages')
    .insert(message)
    .select('id, subject, from_email, received_at, status')
    .single();

  if (error) {
    return jsonResponse(res, 500, { ok: false, error: error.message || 'Could not save Buddy Inbox message' });
  }

  return jsonResponse(res, 200, { ok: true, saved: data });
}

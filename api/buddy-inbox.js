import { createClient } from '@supabase/supabase-js';
import { createHmac, timingSafeEqual } from 'node:crypto';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET;
const BUDDY_INBOX_ALLOWED_TO = (process.env.BUDDY_INBOX_ALLOWED_TO || '')
  .split(',')
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

function jsonResponse(res, status, body) {
  res.setHeader?.('Cache-Control', 'no-store');
  return res.status(status).json(body);
}

function configStatus() {
  const missing = [];
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_SERVICE_KEY) missing.push('SUPABASE_SERVICE_KEY');
  if (!RESEND_API_KEY) missing.push('RESEND_API_KEY');
  if (!RESEND_WEBHOOK_SECRET) missing.push('RESEND_WEBHOOK_SECRET');
  if (!BUDDY_INBOX_ALLOWED_TO.length) missing.push('BUDDY_INBOX_ALLOWED_TO');
  return { ready: missing.length === 0, missing };
}

function headerValue(headers, name) {
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || '';
}

const MAX_WEBHOOK_BYTES = 2 * 1024 * 1024;

function rawBody(req) {
  const value = typeof req.rawBody === 'string'
    ? req.rawBody
    : Buffer.isBuffer(req.rawBody)
      ? req.rawBody.toString('utf8')
      : typeof req.body === 'string'
        ? req.body
        : null;
  if (value !== null && Buffer.byteLength(value, 'utf8') > MAX_WEBHOOK_BYTES) {
    throw new RangeError('Webhook payload too large');
  }
  return value;
}

async function readRawBody(req) {
  const existing = rawBody(req);
  if (existing !== null) return existing;
  if (req.readableEnded || typeof req.on !== 'function') return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_WEBHOOK_BYTES) throw new RangeError('Webhook payload too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function verifyResendWebhook(payload, headers) {
  const id = headerValue(headers, 'svix-id');
  const timestamp = headerValue(headers, 'svix-timestamp');
  const signature = headerValue(headers, 'svix-signature');
  if (!id || !timestamp || !signature || !RESEND_WEBHOOK_SECRET) return false;

  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber) || Math.abs(Date.now() / 1000 - timestampNumber) > 300) return false;

  const secretValue = RESEND_WEBHOOK_SECRET.startsWith('whsec_')
    ? RESEND_WEBHOOK_SECRET.slice('whsec_'.length)
    : RESEND_WEBHOOK_SECRET;
  const secret = Buffer.from(secretValue, 'base64');
  const expected = createHmac('sha256', secret).update(id + '.' + timestamp + '.' + payload).digest('base64');
  return signature.split(' ').some((candidate) => {
    const value = candidate.startsWith('v1,') ? candidate.slice(3) : '';
    const actual = Buffer.from(value);
    const wanted = Buffer.from(expected);
    return actual.length === wanted.length && timingSafeEqual(actual, wanted);
  });
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
      Authorization: 'Bearer ' + RESEND_API_KEY,
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
    email_id: firstValue(data.email_id),
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

export const config = { api: { bodyParser: false } };

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

  let payloadText;
  try {
    payloadText = await readRawBody(req);
  } catch (error) {
    if (error instanceof RangeError) return jsonResponse(res, 413, { ok: false, error: 'Webhook payload too large' });
    return jsonResponse(res, 400, { ok: false, error: 'Raw webhook body unavailable' });
  }
  if (payloadText === null) return jsonResponse(res, 400, { ok: false, error: 'Raw webhook body unavailable' });

  let payload;
  try {
    payload = JSON.parse(payloadText || '{}');
  } catch {
    return jsonResponse(res, 400, { ok: false, error: 'Invalid JSON payload' });
  }

  if (!verifyResendWebhook(payloadText, req.headers || {})) {
    return jsonResponse(res, 401, { ok: false, error: 'Invalid Resend webhook signature' });
  }

  if (payload.type !== 'email.received' || !payload.data || typeof payload.data.email_id !== 'string' || !payload.data.email_id.trim()) {
    return jsonResponse(res, 400, { ok: false, error: 'Expected email.received with data.email_id' });
  }

  let message = normalisePayload(payload);
  if (!allowedRecipient(message)) {
    return jsonResponse(res, 202, { ok: true, skipped: true, reason: 'Recipient not allowed for Buddy Inbox' });
  }
  if (message.email_id) {
    try {
      const receivedEmail = await fetchReceivedEmail(message.email_id);
      message = normalisePayload(payload, receivedEmail);
    } catch (error) {
      console.error('Resend receiving API fetch failed', error);
      return jsonResponse(res, 502, { ok: false, error: 'Could not fetch received email body' });
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
    if (error.code === '23505' && message.email_id) {
      return jsonResponse(res, 200, { ok: true, duplicate: true, emailId: message.email_id });
    }
    console.error('Buddy Inbox storage failed', error);
    return jsonResponse(res, 500, { ok: false, error: 'Could not save Buddy Inbox message' });
  }

  return jsonResponse(res, 200, { ok: true, saved: data });
}

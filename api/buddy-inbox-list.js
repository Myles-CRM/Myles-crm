import { createClient } from '@supabase/supabase-js';
import { tokenMatches } from '../lib/auth.js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CRM_ADMIN_TOKEN = process.env.CRM_ADMIN_TOKEN;
const LEGACY_ADMIN_ENABLED = process.env.CRM_LEGACY_ADMIN_ENABLED === 'true';

function response(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json(body);
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return response(res, 405, { ok: false, error: 'Method Not Allowed' });
  }

  if (!LEGACY_ADMIN_ENABLED) return response(res, 410, { ok: false, error: 'Legacy inbox route disabled' });

  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!tokenMatches(CRM_ADMIN_TOKEN, token)) return response(res, 401, { ok: false, error: 'Unauthorized' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return response(res, 503, { ok: false, error: 'Server not configured' });

  const limit = Math.min(Math.max(Number(req.query?.limit || 25), 1), 50);
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  const { data, error } = await supabase
    .from('buddy_inbox_messages')
    .select('id, subject, from_email, to_emails, received_at, summary, attachment_count, status')
    .in('status', ['new', 'ready', 'metadata-only', 'reviewed'])
    .order('received_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('Buddy Inbox list failed', error);
    return response(res, 500, { ok: false, error: 'Could not list Buddy Inbox messages' });
  }

  return response(res, 200, {
    ok: true,
    messages: (data || []).map((message) => ({
      id: message.id,
      subject: message.subject || '(no subject)',
      fromEmail: message.from_email || 'unknown sender',
      toEmails: message.to_emails || [],
      receivedAt: message.received_at,
      summary: message.summary || message.text_body || '',
      attachmentCount: message.attachment_count || 0,
      status: message.status,
    })),
  });
}

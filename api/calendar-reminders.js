import { createClient } from '@supabase/supabase-js';
import { tokenMatches } from '../lib/auth.js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CRM_ADMIN_TOKEN = process.env.CRM_ADMIN_TOKEN;
const REMINDER_OWNER_ID = process.env.CRM_REMINDER_OWNER_ID || '00000000-0000-0000-0000-000000000001';

function bodyOf(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  return req.body || {};
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const authorization = String(req.headers.authorization || '');
  const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!tokenMatches(CRM_ADMIN_TOKEN, token)) return res.status(401).json({ error: 'Unauthorized' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res.status(500).json({ error: 'Server not configured' });

  const body = bodyOf(req);
  if (!body || !['replace', 'cancel'].includes(body.action)) return res.status(400).json({ error: 'Invalid action' });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  const result = body.action === 'replace'
    ? await supabase.rpc('replace_event_reminder', {
      ...(body.data || {}),
      p_owner_id: REMINDER_OWNER_ID,
    })
    : await supabase.rpc('cancel_event_reminders', {
      p_event_id: String(body.eventId || ''),
      p_owner_id: REMINDER_OWNER_ID,
    });

  if (result.error) return res.status(400).json({ error: result.error.message });
  return res.status(200).json({ ok: true, data: result.data });
}

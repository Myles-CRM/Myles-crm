// api/admin.js (ESM)
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CRM_ADMIN_TOKEN = process.env.CRM_ADMIN_TOKEN;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const auth = (req.headers.authorization || '').toString();
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!CRM_ADMIN_TOKEN || token !== CRM_ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'Server not configured' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

  let body = req.body ?? {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }
  const { type, data } = body || {};
  if (!type || !data) return res.status(400).json({ error: 'Missing type/data' });

  const table = ({ note: 'notes', event: 'events', contact: 'contacts' })[type];
  if (!table) return res.status(400).json({ error: 'Bad type' });

  const { error } = await supabase.from(table).insert({ ...data, created_at: new Date().toISOString() });
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ ok: true });
}

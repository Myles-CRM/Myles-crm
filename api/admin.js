// api/admin.js
const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  // Check admin token
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token !== process.env.CRM_ADMIN_TOKEN) return res.status(401).json({ error: 'Unauthorized' });

  // Supabase (server-side) client
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

  // Parse JSON body
  let body = req.body || {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  const { type, data } = body;
  if (!type || !data) return res.status(400).json({ error: 'Missing type/data' });

  const table = { note: 'notes', event: 'events', contact: 'contacts' }[type];
  if (!table) return res.status(400).json({ error: 'Bad type' });

  const { error } = await supabase.from(table).insert({ ...data, created_at: new Date().toISOString() });
  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ ok: true });
};

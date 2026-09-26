import { isCronAuthorized, processDueReminders } from '../lib/reminders.js';

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  if (!isCronAuthorized(req.headers)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const result = await processDueReminders();
    return res.status(result.ok ? 200 : 503).json(result);
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message || 'Reminder job failed' });
  }
}

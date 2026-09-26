import { isCronAuthorized, processDueReminders } from '../../lib/reminders.js';

export const config = {
  schedule: '*/5 * * * *',
};

export default async function handler(request) {
  if (!isCronAuthorized(Object.fromEntries(request.headers.entries()))) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await processDueReminders();
    return Response.json(result, { status: result.ok ? 200 : 503 });
  } catch (error) {
    return Response.json({ ok: false, error: error.message || 'Reminder job failed' }, { status: 500 });
  }
}

const MAX_CALENDAR_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 15000;

function allow(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function getCalendarUrl(req) {
  const rawUrl = req.query?.url;
  const url = Array.isArray(rawUrl) ? rawUrl[0] : rawUrl;
  return typeof url === 'string' ? url.trim() : '';
}

function isAllowedCalendarUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    return parsed.hostname.endsWith('.daymap.net') || parsed.pathname.toLowerCase().endsWith('.ics');
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  allow(res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const calendarUrl = getCalendarUrl(req);
  if (!isAllowedCalendarUrl(calendarUrl)) {
    return res.status(400).json({ error: 'Use a secure Daymap or .ics calendar link.' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(calendarUrl, {
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        'Accept': 'text/calendar, text/plain, */*',
        'User-Agent': 'Myles-CRM-Calendar-Importer/1.0',
      },
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: `Calendar link returned ${response.status}` });
    }

    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > MAX_CALENDAR_BYTES) {
      return res.status(413).json({ error: 'Calendar file is too large.' });
    }

    const calendarText = await response.text();
    if (calendarText.length > MAX_CALENDAR_BYTES) {
      return res.status(413).json({ error: 'Calendar file is too large.' });
    }

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(calendarText);
  } catch (error) {
    const message = error.name === 'AbortError' ? 'Calendar fetch timed out.' : 'Could not fetch calendar link.';
    return res.status(502).json({ error: message });
  } finally {
    clearTimeout(timeout);
  }
}

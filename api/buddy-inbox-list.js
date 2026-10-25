export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Allow', 'GET');
  return res.status(410).json({ ok: false, error: 'Legacy inbox list route retired.' });
}

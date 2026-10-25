export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Allow', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  return res.status(410).json({ error: 'Legacy admin route retired; use the owner-scoped CRM route.' });
}

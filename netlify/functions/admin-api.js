exports.handler = async (event) => ({
  statusCode: 410,
  headers: { 'Cache-Control': 'no-store', Allow: 'POST, OPTIONS' },
  body: JSON.stringify({ error: 'Legacy admin route retired; use the owner-scoped CRM route.' }),
});

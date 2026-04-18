# Myles-crm
## Admin API examples

All admin operations require a Bearer token in `Authorization` and use POST to `/.netlify/functions/admin-api`.

Add Note:
```bash
curl -X POST https://myles-crm.netlify.app/.netlify/functions/admin-api \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"add-note","category":"guitar","content":"Practice pentatonics"}'
```

Add Contact:
```bash
curl -X POST https://myles-crm.netlify.app/.netlify/functions/admin-api \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"add-contact","first_name":"Alex","last_name":"Lee","phone":"0400 000 000"}'
```

Notes:
- CORS is enabled with `Access-Control-Allow-Origin: *` and allows `Authorization, Content-Type` headers.
- GET to the function returns 405 (health check intentionally disabled).

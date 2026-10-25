import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../api/assistant-crm.js', import.meta.url), 'utf8');
for (const fragment of [
  "const SUPABASE_URL = process.env.SUPABASE_URL || '';",
  "parsed.href === 'https://' + ALLOWED_HOST + '/'",
  "if (!tokenMatches(CRM_ASSISTANT_TOKEN, bearer(req)))",
  "if (!data || typeof data !== 'object' || Array.isArray(data))",
  'Number.isInteger(requestedLimit)',
  'select(columns)',
  ".eq('owner_id', CRM_OWNER_UID)",
  "if (!action.startsWith('add_')) return null",
]) assert.ok(source.includes(fragment), 'Missing route safety guard: ' + fragment);
assert.ok(!source.includes('NEXT_PUBLIC_SUPABASE_URL'), 'Route must not use public Supabase URL fallback');
console.log('Buddy CRM route boundary checks passed.');

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.CRM_ADMIN_TOKEN = 'admin-test-token';
process.env.SUPABASE_URL = 'https://zgbzjeiprratbyjnsbge.supabase.co/';
process.env.CRM_OWNER_UID = 'a54d2b35-6388-44b5-b38c-a155682ab187';
process.env.SUPABASE_SERVICE_KEY = 'service-key';

const source = await readFile(new URL('../api/calendar-reminders.js', import.meta.url), 'utf8');
const moduleSource = source
  .replace("import { createClient } from '@supabase/supabase-js';", 'const createClient = (...args) => globalThis.__calendarTestCreateClient(...args);')
  .replace("import { tokenMatches } from '../lib/auth.js';", 'const tokenMatches = (expected, actual) => expected === actual;');
const { default: handler } = await import('data:text/javascript;base64,' + Buffer.from(moduleSource).toString('base64'));

function response() {
  return { code: 0, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(v) { this.body = v; return this; } };
}

const calls = [];
globalThis.__calendarTestCreateClient = () => ({ rpc(name, params) { calls.push({ name, params }); return Promise.resolve({ data: true, error: null }); } });

let res = response();
await handler({ method: 'POST', headers: {}, body: { action: 'cancel', eventId: 'evt-1' } }, res);
assert.equal(res.code, 401, 'missing admin token must be rejected');
assert.equal(calls.length, 0, 'unauthorized request must not reach Supabase');

res = response();
await handler({ method: 'POST', headers: { authorization: 'Bearer admin-test-token' }, body: { action: 'cancel', eventId: 'evt-1' } }, res);
assert.equal(res.code, 200, 'authorized cancel should succeed');
assert.equal(calls[0].name, 'cancel_event_reminders');
assert.equal(calls[0].params.p_owner_id, 'a54d2b35-6388-44b5-b38c-a155682ab187');

res = response();
await handler({ method: 'POST', headers: { authorization: 'Bearer admin-test-token' }, body: { action: 'replace', data: { p_event_id: 'evt-1', p_event_version: 'v1' } } }, res);
assert.equal(res.code, 200, 'authorized replace should succeed');
assert.equal(calls[1].name, 'replace_event_reminder');
assert.equal(calls[1].params.p_owner_id, 'a54d2b35-6388-44b5-b38c-a155682ab187');

console.log('Calendar reminder API authorization tests passed.');

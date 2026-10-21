import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'test-service-key';
process.env.RESEND_API_KEY = 'test-resend-key';
process.env.BUDDY_INBOX_ALLOWED_TO = 'buddy@example.com';
const secret = Buffer.from('test-webhook-secret').toString('base64');
process.env.RESEND_WEBHOOK_SECRET = 'whsec_' + secret;

const { default: handler } = await import('../api/buddy-inbox.js?webhook-test=' + Date.now());

function response() {
  return {
    statusCode: 0,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(statusCode) { this.statusCode = statusCode; return this; },
    json(body) { this.body = body; return body; },
  };
}

function signedRequest(payload, { signature = true, chunks = null } = {}) {
  const body = JSON.stringify(payload);
  const id = 'msg_test_' + Math.random().toString(16).slice(2);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const digest = createHmac('sha256', Buffer.from(secret, 'base64'))
    .update(id + '.' + timestamp + '.' + body)
    .digest('base64');
  const bodyChunks = chunks || [Buffer.from(body)];
  const req = {
    method: 'POST',
    headers: {
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': signature ? 'v1,' + digest : 'v1,invalid',
    },
    readableEnded: false,
    on() {},
    async *[Symbol.asyncIterator]() { for (const chunk of bodyChunks) yield chunk; },
  };
  return req;
}

async function run(payload, options) {
  const res = response();
  await handler(signedRequest(payload, options), res);
  return res;
}

let res = await run({ type: 'wrong.event', data: { email_id: 'email_1' } });
assert.equal(res.statusCode, 400);
assert.match(res.body.error, /Expected email.received/);

res = await run({ type: 'email.received', data: { subject: 'missing id' } });
assert.equal(res.statusCode, 400);

res = await run({ type: 'email.received', data: { email_id: 'email_2', to: ['buddy@example.com'] } }, { signature: false });
assert.equal(res.statusCode, 401);

res = await run({ type: 'email.received', data: { email_id: 'email_3', to: ['other@example.com'] } }, { chunks: [Buffer.from('{'), Buffer.from('"type":"email.received","data":{"email_id":"email_3","to":["other@example.com"]}}')] });
assert.equal(res.statusCode, 202);
assert.equal(res.body.reason, 'Recipient not allowed for Buddy Inbox');

res = await run({ type: 'email.received', data: { email_id: 'email_4', to: ['buddy@example.com'] } }, { chunks: [Buffer.alloc(2 * 1024 * 1024 + 1)] });
assert.equal(res.statusCode, 413);

console.log('Inbound webhook regression tests passed: strict type/id, Svix signature, chunked raw body, recipient filter, and size limit');

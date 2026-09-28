import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.BUDDY_INBOX_ACTION_TOKEN = 'buddy-action-test-token';

const source = await readFile(new URL('../api/buddy-inbox-to-notes.js', import.meta.url), 'utf8');
const moduleSource = source.replace(
  "import { createClient } from '@supabase/supabase-js';",
  `const createClient = (...args) => globalThis.__buddyInboxTestCreateClient(...args);`,
);
const { default: handler } = await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`);

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function makeMessages(count = 30) {
  return Array.from({ length: count }, (_, index) => ({
    id: uuid(index + 1),
    subject: `Subject ${index + 1}`,
    from_email: `sender${index + 1}@example.com`,
    to_emails: ['buddy@example.com'],
    received_at: '2026-09-28T06:00:00.000Z',
    summary: `Summary ${index + 1}`,
    text_body: `Text body ${index + 1}`,
    html_body: `<p>HTML body ${index + 1}</p>`,
    attachment_count: 0,
    status: 'ready',
  }));
}

function createFakeSupabase(initialMessages = makeMessages()) {
  const state = { messages: initialMessages.map((message) => ({ ...message })), notes: [] };

  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.limitValue = null;
      this.updateValues = null;
      this.insertRows = null;
      this.selected = '';
    }

    select(columns) { this.selected = columns; return this; }
    order() { return this; }
    limit(value) { this.limitValue = value; return this._result(); }
    single() { return this._singleResult(); }
    eq(column, value) { this.filters.push({ type: 'eq', column, value }); return this; }
    is(column, value) { this.filters.push({ type: 'eq', column, value }); return this; }
    in(column, values) { this.filters.push({ type: 'in', column, values }); return this; }
    update(values) { this.updateValues = values; return this; }
    insert(rows) { this.insertRows = rows; return this; }
    then(resolve, reject) { return Promise.resolve(this._result()).then(resolve, reject); }

    _matches(row) {
      return this.filters.every((filter) => {
        if (filter.type === 'eq') return row[filter.column] === filter.value;
        if (filter.type === 'in') return filter.values.includes(row[filter.column]);
        return true;
      });
    }

    _project(row) {
      if (!this.selected || this.selected === '*') return { ...row };
      return Object.fromEntries(
        this.selected.split(',').map((key) => key.trim()).filter(Boolean).map((key) => [key, row[key]]),
      );
    }

    _result() {
      if (this.table === 'buddy_inbox_messages') {
        let rows = state.messages.filter((row) => this._matches(row));
        if (this.updateValues) {
          rows = rows.map((row) => Object.assign(row, this.updateValues));
        }
        if (this.limitValue !== null) rows = rows.slice(0, this.limitValue);
        return { data: rows.map((row) => this._project(row)), error: null };
      }
      return { data: [], error: null };
    }

    _singleResult() {
      if (this.table === 'notes' && this.insertRows) {
        const note = { ...this.insertRows[0], id: `note-${state.notes.length + 1}` };
        state.notes.push(note);
        return { data: { id: note.id }, error: null };
      }
      return { data: null, error: null };
    }
  }

  return {
    state,
    client: {
      from(table) { return new Query(table); },
    },
  };
}

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: undefined,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function run(req, fake = createFakeSupabase()) {
  globalThis.__buddyInboxTestCreateClient = () => fake.client;
  const res = makeRes();
  await handler({ headers: {}, body: {}, query: {}, ...req }, res);
  return { res, fake };
}

let result = await run({ method: 'GET' });
assert.equal(result.res.statusCode, 405, 'GET should be rejected');
assert.equal(result.res.headers['cache-control'], 'no-store', 'private responses should not be cached');

result = await run({ method: 'POST', query: { token: process.env.BUDDY_INBOX_ACTION_TOKEN } });
assert.equal(result.res.statusCode, 401, 'query-string token should not authorize action endpoint');

result = await run({ method: 'POST', headers: {} });
assert.equal(result.res.statusCode, 401, 'missing auth should be rejected');

result = await run({
  method: 'POST',
  headers: { 'x-buddy-inbox-action-token': process.env.BUDDY_INBOX_ACTION_TOKEN },
  body: { action: 'list', limit: 999 },
});
assert.equal(result.res.statusCode, 200, 'header auth should be accepted');
assert.equal(result.res.body.messages.length, 25, 'list should cap returned messages');
assert.ok(!('html_body' in result.res.body.messages[0]), 'list response should not expose raw html_body');
assert.ok(!('text_body' in result.res.body.messages[0]), 'list response should not expose raw text_body');

const bearerFake = createFakeSupabase(makeMessages(1));
result = await run({
  method: 'POST',
  headers: { authorization: ['Bear', 'er'].join('') + ' ' + process.env.BUDDY_INBOX_ACTION_TOKEN },
  body: { action: 'create_note', messageIds: [uuid(1)] },
}, bearerFake);
assert.equal(result.res.statusCode, 200, 'Bearer auth should reach create_note action');
assert.equal(result.res.body.ok, true, 'create_note should file selected emailed note text');
assert.equal(bearerFake.state.notes.length, 1, 'create_note without Buddy override should insert the emailed note');
assert.match(bearerFake.state.notes[0].content, /Text body 1/, 'filed note should use the selected email body');
assert.match(bearerFake.state.notes[0].content, /Source email: Subject 1/, 'note should keep a source reference');

const fake = createFakeSupabase(makeMessages(1));
result = await run({
  method: 'POST',
  headers: { 'x-buddy-inbox-action-token': process.env.BUDDY_INBOX_ACTION_TOKEN },
  body: { action: 'create_note', messageIds: [uuid(1)] },
}, fake);
assert.equal(result.res.body.ok, true, 'create_note with selected id should succeed');
assert.equal(fake.state.notes.length, 1, 'first create_note should insert one note');
assert.equal(fake.state.messages[0].status, 'noted', 'processed message should be marked noted');
assert.match(fake.state.notes[0].content, /Text body 1/, 'note should come from Myles emailed note text');
assert.match(fake.state.notes[0].content, /Source email: Subject 1/, 'note should keep a source reference');

result = await run({
  method: 'POST',
  headers: { 'x-buddy-inbox-action-token': process.env.BUDDY_INBOX_ACTION_TOKEN },
  body: { action: 'create_note', messageIds: [uuid(1)] },
}, fake);
assert.equal(result.res.body.processed, 0, 'retry should not process already-noted message');
assert.equal(fake.state.notes.length, 1, 'retry should not create a duplicate note');

result = await run({
  method: 'POST',
  headers: { 'x-buddy-inbox-action-token': process.env.BUDDY_INBOX_ACTION_TOKEN },
  body: { action: 'archive', messageIds: [uuid(1)] },
}, fake);
assert.equal(result.res.body.processed, 0, 'archive should not mutate already-noted messages');
assert.equal(fake.state.messages[0].status, 'noted', 'archive should leave terminal noted status alone');

console.log('Buddy Inbox action route tests passed');

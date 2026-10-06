import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_KEY = 'service-key';
process.env.RESEND_API_KEY = 'resend-key';

const source = await readFile(new URL('../lib/reminders.js', import.meta.url), 'utf8');
const moduleSource = source.replace(
  "import { createClient } from '@supabase/supabase-js';",
  'const createClient = () => { throw new Error("unexpected real client"); };',
);
const { processDueReminders } = await import(
  'data:text/javascript;base64,' + Buffer.from(moduleSource).toString('base64'),
);

function fakeSupabase(reminder, { cancelBeforeSend = false, failPersist = false } = {}) {
  const state = { row: { ...reminder }, sent: 0 };
  return {
    state,
    rpc(name) {
      assert.equal(name, 'claim_due_event_reminders');
      return Promise.resolve({ data: [{ ...state.row, status: 'processing' }], error: null });
    },
    from() {
      const query = {
        values: null,
        filters: [],
        select() { return this; },
        update(values) { this.values = values; return this; },
        eq(column, value) { this.filters.push([column, value]); return this; },
        then(resolve, reject) { return this.maybeSingle().then(resolve, reject); },
        maybeSingle() {
          if (this.values) {
            if (failPersist) return Promise.resolve({ data: null, error: { message: 'persistence failed' } });
            const matches = this.filters.every(([key, value]) => state.row[key] === value);
            if (!matches) return Promise.resolve({ data: null, error: null });
            Object.assign(state.row, this.values);
            return Promise.resolve({ data: { id: state.row.id }, error: null });
          }
          if (cancelBeforeSend) state.row.status = 'cancelled';
          return Promise.resolve({ data: { status: state.row.status }, error: null });
        },
      };
      return query;
    },
  };
}

const base = {
  id: 'r1', idempotency_key: 'event:v1:mail:15', attempt_count: 1,
  status: 'processing', event_title: 'Test event', event_date: '2026-10-06',
  event_time: '10:00', email: 'test@example.com',
};

let fake = fakeSupabase(base);
let result = await processDueReminders({
  now: new Date('2026-10-06T00:00:00.000Z'),
  supabaseClient: fake,
  sendEmail: async (reminder) => { fake.state.sent += 1; assert.equal(reminder.idempotency_key, base.idempotency_key); return { id: 'resend-1' }; },
});
assert.equal(fake.state.sent, 1, 'claimed reminder should be sent once');
assert.equal(fake.state.row.status, 'sent', 'successful delivery must persist sent state');
assert.equal(result.results[0].sent, true);

fake = fakeSupabase(base, { cancelBeforeSend: true });
result = await processDueReminders({ supabaseClient: fake, sendEmail: async () => { fake.state.sent += 1; return { id: 'should-not-send' }; } });
assert.equal(fake.state.sent, 0, 'cancellation after claim must prevent the send');
assert.equal(result.results[0].skipped, true);

fake = fakeSupabase({ ...base, attempt_count: 3 }, { failPersist: true });
result = await processDueReminders({ supabaseClient: fake, sendEmail: async () => ({ id: 'resend-2' }) });
assert.equal(result.results[0].sent, false, 'persistence failure must not be reported as sent');
assert.equal(result.results[0].persistenceError, 'persistence failed');

console.log('Reminder worker behavioral tests passed.');

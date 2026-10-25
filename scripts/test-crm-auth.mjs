import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/assets/crm-auth.js', import.meta.url), 'utf8');
const owner = '11111111-1111-4111-8111-111111111111';
const outsider = '22222222-2222-4222-8222-222222222222';

function harness({ configured = true, user = null } = {}) {
  const calls = { otp: [], signOut: 0, navigation: [], history: [] };
  const auth = {
    async getUser() { return { data: { user }, error: null }; },
    async signInWithOtp(input) { calls.otp.push(input); return { error: null }; },
    async signOut() { calls.signOut++; return { error: null }; },
  };
  const window = {
    ...(configured ? { CRM_OWNER_UID: owner } : {}),
    supabase: { auth },
    location: {
      href: 'https://crm.example/login.html',
      pathname: '/login.html',
      replace(value) { calls.navigation.push(value); },
    },
    history: { replaceState(...args) { calls.history.push(args); } },
  };
  vm.runInNewContext(source, { window, URL, Set, Error, String, encodeURIComponent });
  return { api: window.CrmAuth, window, calls };
}

{
  const { api, calls } = harness();
  await api.sendMagicLink('  myles@example.test  ', 'notes.html');
  assert.equal(calls.otp.length, 1);
  assert.equal(calls.otp[0].email, 'myles@example.test');
  assert.equal(calls.otp[0].options.shouldCreateUser, false);
  assert.equal(new URL(calls.otp[0].options.emailRedirectTo).searchParams.get('next'), 'notes.html');
  await api.sendMagicLink('myles@example.test', 'https://evil.example/');
  assert.equal(new URL(calls.otp[1].options.emailRedirectTo).searchParams.get('next'), 'index.html');
}

{
  const { api, calls } = harness({ configured: false });
  await assert.rejects(api.sendMagicLink('myles@example.test'), /owner is not configured/);
  assert.equal(calls.otp.length, 0);
}

{
  const { api, calls } = harness({ user: { id: owner } });
  await api.finishMagicLink('contacts.html');
  assert.deepEqual(calls.navigation, ['contacts.html']);
  assert.equal(calls.history.length, 1);
}

{
  const { api, calls } = harness({ user: { id: outsider } });
  await assert.rejects(api.finishMagicLink('notes.html'), /invited CRM owner/);
  assert.equal(calls.signOut, 1);
  assert.equal(calls.history.length, 1);
  assert.deepEqual(calls.navigation, []);
}

{
  const { api, window, calls } = harness();
  window.location.pathname = '/calendar.html';
  assert.equal(await api.requireOwner(), null);
  assert.deepEqual(calls.navigation, ['login.html?next=calendar.html']);
}

console.log('CRM Auth skeleton checks passed.');

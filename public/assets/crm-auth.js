// Myles CRM browser authentication. Authorization still depends on owner-scoped RLS.
// Integration must provide window.CRM_OWNER_UID (the invited Auth user's UUID).
(function () {
  'use strict';

  const pages = new Set(['index.html', 'notes.html', 'contacts.html', 'calendar.html']);
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function client() {
    if (!window.supabase?.auth) throw new Error('CRM authentication is not configured.');
    return window.supabase;
  }

  function ownerId() {
    const value = window.CRM_OWNER_UID;
    if (typeof value !== 'string' || !uuidPattern.test(value)) {
      throw new Error('The CRM owner is not configured.');
    }
    return value.toLowerCase();
  }

  function returnPage(value) {
    // Only the CRM's own page names are accepted; never redirect to a supplied URL.
    return pages.has(value) ? value : 'index.html';
  }

  async function verifiedOwner() {
    const expected = ownerId();
    const { data, error } = await client().auth.getUser();
    if (error || !data?.user) return null;
    if (data.user.id?.toLowerCase() === expected) return data.user;
    // Do not leave a different project's/user's session active in this CRM tab.
    await client().auth.signOut();
    return null;
  }

  async function requireOwner() {
    const user = await verifiedOwner();
    if (user) return user;
    const next = returnPage(window.location.pathname.split('/').pop());
    window.location.replace('login.html?next=' + encodeURIComponent(next));
    return null;
  }

  async function sendMagicLink(email, next) {
    ownerId(); // Fail closed until the invited UID is configured.
    const redirect = new URL('auth-callback.html', window.location.href);
    redirect.searchParams.set('next', returnPage(next));
    const { error } = await client().auth.signInWithOtp({
      email: String(email || '').trim(),
      options: { shouldCreateUser: false, emailRedirectTo: redirect.href },
    });
    if (error) throw error;
  }

  async function finishMagicLink(next) {
    // supabase-js processes its standard callback URL before getUser resolves.
    let user;
    try {
      user = await verifiedOwner();
    } finally {
      // Remove tokens/error details from the address bar even if verification fails.
      window.history.replaceState(null, '', window.location.pathname);
    }
    if (!user) throw new Error('This link did not sign in the invited CRM owner.');
    window.location.replace(returnPage(next));
  }

  async function signOut() {
    const { error } = await client().auth.signOut();
    if (error) throw error;
    // Integrating pages must clear their own private local caches before redirecting.
    window.location.replace('login.html');
  }

  window.CrmAuth = Object.freeze({ returnPage, verifiedOwner, requireOwner, sendMagicLink, finishMagicLink, signOut });
})();

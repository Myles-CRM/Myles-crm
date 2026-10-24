# CRM Auth skeleton integration contract

This branch adds browser-side sign-in scaffolding only. It is **not** a deployed
access control system until the intended CRM project has owner-scoped RLS and
every private page/API route has been integrated. No database migration or live
configuration change is included.

1. In the intended CRM Supabase project, invite Myles's email, disable public
   signups, and allowlist the deployed `auth-callback.html` redirect URL. Use the
   standard Supabase magic-link callback format with this scaffold. Do not put
   the invited email, a service key, or any other secret in browser files.
2. At build time, set `window.CRM_OWNER_UID` to the invited Auth user's UUID in
   the public runtime config **after** confirming it. The UID is an identifier,
   not a secret. Until present, the helper fails closed. The existing public
   anon/publishable key still initializes the Supabase browser client.
3. On each private page, load `assets/crm-auth.js` after `assets/common.js`.
   Before reading *either* cloud or local cached private data, call
   `await window.CrmAuth.requireOwner()`. If it returns `null`, stop page
   initialization; otherwise continue with that verified Auth user. Recheck
   on auth changes and before writes. `getUser()` verifies the session with
   Supabase Auth; do not treat a locally decoded token as proof of identity.
4. Namespace private localStorage/cache keys by user ID or clear them at logout
   and account change. The caller must clear them before `CrmAuth.signOut()`;
   this helper does not know every cache key. Avoid caching private API responses
   in the service worker. Do not render a previous user's offline cache on the
   login/callback pages.
5. Owner-scoped database RLS remains authoritative. This browser guard is for
   correct UX and shared-device privacy, not a substitute for RLS. Server-only
   Buddy access must use its separate scoped route, not Myles's browser session.

`sendMagicLink(email, next)` uses `shouldCreateUser: false`; `next` is limited
to the four CRM page names. `finishMagicLink(next)` verifies the returned Auth
user against `CRM_OWNER_UID` and strips callback parameters before navigating.
The current scaffold uses the standard implicit magic-link callback handled by
supabase-js. If the project changes to PKCE/custom email templates, the callback
must be updated and retested before deployment.

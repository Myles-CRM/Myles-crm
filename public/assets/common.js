// Minimal shared helpers
console.log('Myles CRM loaded');

if (window.supabase?.createClient && window.SUPABASE_URL && window.SUPABASE_ANON) {
  window.supabase = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON);
}

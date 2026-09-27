// Minimal shared helpers
console.log('Myles CRM loaded');

if (window.supabase?.createClient && window.SUPABASE_URL && window.SUPABASE_ANON) {
  window.supabase = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON);
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((error) => {
      console.warn('Offline app cache could not start:', error);
    });
  });
}

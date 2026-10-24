import { writeFile } from 'node:fs/promises';

const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
if (!anonKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_ANON_KEY is required for the CRM build.');
}
const config = '// Generated during the Vercel build; do not edit manually.\n'
  + 'window.SUPABASE_ANON = ' + JSON.stringify(anonKey) + ';\n';
await writeFile(new URL('../public/runtime-config.js', import.meta.url), config);
console.log('Generated Supabase runtime config.');

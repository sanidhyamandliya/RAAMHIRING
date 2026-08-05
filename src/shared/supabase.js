import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey || url.includes('YOUR_PROJECT_REF') || anonKey.includes('your_anon_key')) {
  console.warn(
    '[Apex] Missing Supabase config. Copy .env.example → .env and set VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY.'
  );
}

export const supabase = createClient(url || 'https://invalid.supabase.co', anonKey || 'invalid');

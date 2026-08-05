import fs from 'fs';

const h = fs.readFileSync('dashboard-supabase.html', 'utf8');
const scripts = [...h.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
console.log(
  'scripts',
  scripts.map((m, i) => ({ i, len: m[1].length, head: m[1].slice(0, 60).replace(/\n/g, ' ') }))
);
const start = h.indexOf("const CREDENTIALS");
console.log('CREDENTIALS at', start);

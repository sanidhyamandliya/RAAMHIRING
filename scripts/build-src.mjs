/**
 * Strip embedded makeSupaDb + hardcoded config from extracted monolith JS,
 * prepend ESM imports, patch init/login, and expose functions for HTML onclick.
 */
import fs from 'fs';
import path from 'path';

function stripMakeSupaDb(js) {
  // Remove from SUPABASE_URL / CREDENTIALS through end of makeSupaDb function
  // Pattern: starts at CREDENTIALS or SUPABASE_URL comment block, ends at `return { ref:(p)=>new Ref(p) };\n}`
  const startMarkers = [
    /\/\/ ═+[\s\S]*?const SUPABASE_URL/,
    /const CREDENTIALS\s*=/,
    /\/\/ ─── Supabase backend config/,
    /const SUPABASE_URL\s*=/,
  ];
  let start = -1;
  for (const re of startMarkers) {
    const m = js.match(re);
    if (m && (start < 0 || m.index < start)) start = m.index;
  }
  if (start < 0) throw new Error('Could not find config/makeSupaDb start');

  const endNeedle = 'return { ref:(p)=>new Ref(p) };\n}';
  const endAlt = 'return { ref:(p)=>new Ref(p) };\r\n}';
  let end = js.indexOf(endNeedle, start);
  let endLen = endNeedle.length;
  if (end < 0) {
    end = js.indexOf(endAlt, start);
    endLen = endAlt.length;
  }
  if (end < 0) {
    // flexible
    const m = js.slice(start).match(/return\s*\{\s*ref\s*:\s*\(p\)\s*=>\s*new\s*Ref\(p\)\s*\}\s*;\s*\}/);
    if (!m) throw new Error('Could not find makeSupaDb end');
    end = start + m.index;
    endLen = m[0].length;
  }
  return js.slice(0, start) + js.slice(end + endLen);
}

function stripEmailCfg(js) {
  return js
    .replace(/const EMAIL_CFG\s*=\s*\{[\s\S]*?\};?\s*/, '')
    .replace(/const EMAIL_CFG\s*=\s*\{[^}]*\}\s*;?\s*/, '');
}

function exposeFunctions(js) {
  const names = [
    ...js.matchAll(/^(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm),
  ].map((m) => m[1]);
  const unique = [...new Set(names)];
  return (
    js +
    '\n\n// Expose handlers for inline HTML onclick (ES modules are scoped)\n' +
    unique.map((n) => `window.${n} = ${n};`).join('\n') +
    '\n'
  );
}

function transformAssessment(raw) {
  let js = raw.replace(/^'use strict';\s*/, '');
  js = stripMakeSupaDb(js);
  js = stripEmailCfg(js);
  js = js.replace(/let _supaClient\s*=\s*null\s*;?\s*/, '');
  js = js.replace(
    /function initFirebase\(\)\s*\{[\s\S]*?^\}\n/m,
    `function initFirebase(){
  try{
    if(!db){ db=makeSupaDb(supabase); }
    console.log('[Apex] Supabase connected');
    attachCustomQuestionListener();
    attachCollegeListener();
    attachBlockSyncListener();
    setTimeout(_drainPendingSync, 500);
  }catch(err){
    console.warn('[Apex] Supabase init error:',err);
    setTimeout(initFirebase,1000);
  }
}
`
  );
  const header = `import './styles.css';
import { supabase } from '../shared/supabase.js';
import { makeSupaDb } from '../shared/kv-adapter.js';
import { EMAIL_CFG } from '../shared/email.js';

`;
  return exposeFunctions(header + js);
}

function transformDashboard(raw) {
  let js = raw.replace(/^'use strict';\s*/, '');
  js = stripMakeSupaDb(js);
  js = stripEmailCfg(js);
  js = js.replace(/let _supaClient\s*=\s*null\s*;?\s*/, '');

  // Replace login/session with Supabase Auth
  js = js.replace(
    /function selRole\(el,r\)\{[\s\S]*?function initDashboard\(\)\{[^}]+\}\n/,
    `function selRole(el,_r){document.querySelectorAll('.login-role-tab').forEach(t=>t.classList.remove('active'));el.classList.add('active');}
async function doLogin(){
  const email=document.getElementById('l-id').value.trim();
  const pw=document.getElementById('l-pw').value;
  const errEl=document.getElementById('l-err');
  if(!email||!pw){errEl.textContent='Enter email and password.';return;}
  errEl.textContent='Signing in…';
  try{
    const user=await signIn(email,pw);
    loggedUser=user;
    document.getElementById('login-screen').style.display='none';
    document.getElementById('dashboard').style.display='flex';
    document.getElementById('sb-user').textContent=user.name;
    document.getElementById('sb-role-badge').textContent=user.role.toUpperCase();
    if(user.role==='hr') document.querySelectorAll('.admin-only').forEach(el=>el.style.display='none');
    errEl.textContent='';
    initDashboard();
  }catch(e){
    errEl.textContent=e.message||'Invalid credentials.';
    document.getElementById('l-pw').value='';
    setTimeout(()=>{if(errEl.textContent)errEl.textContent='';},4000);
  }
}
async function doLogout(){
  if(!confirm('Sign out?'))return;
  await signOut();
  location.reload();
}
async function checkSession(){
  try{
    const s=await getSessionUser();
    if(!s)return false;
    loggedUser=s;
    document.getElementById('sb-user').textContent=s.name;
    document.getElementById('sb-role-badge').textContent=s.role.toUpperCase();
    document.getElementById('login-screen').style.display='none';
    document.getElementById('dashboard').style.display='flex';
    if(s.role==='hr') document.querySelectorAll('.admin-only').forEach(el=>el.style.display='none');
    return true;
  }catch(e){return false;}
}
function initDashboard(){initFirebase();initLiveSync();initFirebaseStatus();updateAllCounts();renderPage();setInterval(()=>{if(curPage==='live')softRefresh();},15000);}
`
  );

  js = js.replace(
    /function initFirebase\(\)\s*\{[\s\S]*?^\}\n/m,
    `function initFirebase(){
  try{
    if(!db){ db=makeSupaDb(supabase); }
    console.log('[Apex Dashboard] Supabase connected');
    // ... listeners attached below in original body — keep following code path via rewrite
    _attachDashboardListeners();
  }catch(err){
    console.warn('[Apex] Supabase init error:',err);
    setTimeout(initFirebase,1000);
  }
}
function _attachDashboardListeners(){
`
  );

  // The above might have broken initFirebase - let me check original initFirebase for dashboard more carefully
  // Actually a simpler replace for initFirebase body only

  js = js.replace(
    /showFbHelp\(\)\{\s*alert\('Cross-device sync is blocked[\s\S]*?Re-run the schema if unsure — it is safe to run again\.'\);/,
    `showFbHelp(){
  alert('Cross-device sync is blocked — the browser cannot read/write your Supabase table.\\n\\nChecklist:\\n1. Did you run sql/supabase-schema.sql in Supabase → SQL Editor?\\n2. Realtime: table public.kv must be enabled.\\n3. RLS policies from the schema must exist.\\n4. VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env / Netlify must match Project Settings → API.');`
  );

  // Fix boot init to be async
  js = js.replace(
    /\(function init\(\)\{\s*if\(!checkSession\(\)\)\{\s*document\.getElementById\('login-screen'\)\.style\.display='flex';\s*return;\s*\}\s*initDashboard\(\);\s*\}\)\(\);/,
    `(async function init(){
  const ok=await checkSession();
  if(!ok){
    document.getElementById('login-screen').style.display='flex';
    return;
  }
  initDashboard();
})();`
  );

  const header = `import './styles.css';
import * as XLSX from 'xlsx';
import { supabase } from '../shared/supabase.js';
import { makeSupaDb } from '../shared/kv-adapter.js';
import { EMAIL_CFG } from '../shared/email.js';
import { signIn, signOut, getSessionUser } from '../shared/auth.js';

window.XLSX = XLSX;

`;
  return exposeFunctions(header + js);
}

// --- Simpler, safer dashboard initFirebase patch ---
function transformDashboardSafe(raw) {
  let js = raw.replace(/^'use strict';\s*/, '');
  js = stripMakeSupaDb(js);
  js = stripEmailCfg(js);
  js = js.replace(/let _supaClient\s*=\s*null\s*;?\s*/, '');

  // Remove CREDENTIALS if still present
  js = js.replace(/const CREDENTIALS\s*=\s*\[[\s\S]*?\];\s*/, '');

  js = js.replace(
    /function selRole\(el,r\)\{document\.querySelectorAll\('\.login-role-tab'\)\.forEach\(t=>t\.classList\.remove\('active'\)\);el\.classList\.add\('active'\);\}/,
    `function selRole(el,_r){document.querySelectorAll('.login-role-tab').forEach(t=>t.classList.remove('active'));el.classList.add('active');}`
  );

  js = js.replace(
    /function doLogin\(\)\{[\s\S]*?\n\}/,
    `async function doLogin(){
  const email=document.getElementById('l-id').value.trim();
  const pw=document.getElementById('l-pw').value;
  const errEl=document.getElementById('l-err');
  if(!email||!pw){errEl.textContent='Enter email and password.';return;}
  errEl.textContent='Signing in…';
  try{
    const user=await signIn(email,pw);
    loggedUser=user;
    document.getElementById('login-screen').style.display='none';
    document.getElementById('dashboard').style.display='flex';
    document.getElementById('sb-user').textContent=user.name;
    document.getElementById('sb-role-badge').textContent=user.role.toUpperCase();
    if(user.role==='hr') document.querySelectorAll('.admin-only').forEach(el=>el.style.display='none');
    errEl.textContent='';
    initDashboard();
  }catch(e){
    errEl.textContent=e.message||'Invalid credentials.';
    document.getElementById('l-pw').value='';
    setTimeout(()=>{if(errEl.textContent)errEl.textContent='';},4000);
  }
}`
  );

  js = js.replace(
    /function doLogout\(\)\{if\(!confirm\('Sign out\?'\)\)return;sessionStorage\.removeItem\('apex_session'\);location\.reload\(\);\}/,
    `async function doLogout(){if(!confirm('Sign out?'))return;await signOut();location.reload();}`
  );

  js = js.replace(
    /function checkSession\(\)\{[\s\S]*?\n\}/,
    `async function checkSession(){
  try{
    const s=await getSessionUser();
    if(!s)return false;
    loggedUser=s;
    document.getElementById('sb-user').textContent=s.name;
    document.getElementById('sb-role-badge').textContent=s.role.toUpperCase();
    document.getElementById('login-screen').style.display='none';
    document.getElementById('dashboard').style.display='flex';
    if(s.role==='hr') document.querySelectorAll('.admin-only').forEach(el=>el.style.display='none');
    return true;
  }catch(e){return false;}
}`
  );

  js = js.replace(
    /function initFirebase\(\)\{\s*try\{\s*if\(!window\.supabase\)\{setTimeout\(initFirebase,300\);return;\}\s*if\(!db\)\{_supaClient=supabase\.createClient\(SUPABASE_URL,SUPABASE_ANON_KEY\);db=makeSupaDb\(_supaClient\);\}/,
    `function initFirebase(){\n  try{\n    if(!db){ db=makeSupaDb(supabase); }`
  );

  // Also handle multiline variants
  js = js.replace(
    /if\(!window\.supabase\)\{setTimeout\(initFirebase,300\);return;\}\s*/g,
    ''
  );
  js = js.replace(
    /if\(!db\)\{_supaClient=supabase\.createClient\(SUPABASE_URL,SUPABASE_ANON_KEY\);db=makeSupaDb\(_supaClient\);\}/g,
    'if(!db){ db=makeSupaDb(supabase); }'
  );
  js = js.replace(
    /if\(!db\)\{\s*_supaClient=supabase\.createClient\(SUPABASE_URL,SUPABASE_ANON_KEY\);\s*db=makeSupaDb\(_supaClient\);\s*\}/g,
    'if(!db){ db=makeSupaDb(supabase); }'
  );

  js = js.replace(
    /SUPABASE_URL and SUPABASE_ANON_KEY at the top of the file must match Project Settings → API\./g,
    'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env / Netlify must match Project Settings → API.'
  );
  js = js.replace(
    /Did you run supabase-schema\.sql/g,
    'Did you run sql/supabase-schema.sql'
  );

  js = js.replace(
    /\(function init\(\)\{\s*if\(!checkSession\(\)\)\{\s*document\.getElementById\('login-screen'\)\.style\.display='flex';\s*return;\s*\}\s*initDashboard\(\);\s*\}\)\(\);/,
    `(async function init(){
  const ok=await checkSession();
  if(!ok){
    document.getElementById('login-screen').style.display='flex';
    return;
  }
  initDashboard();
})();`
  );

  const header = `import './styles.css';
import * as XLSX from 'xlsx';
import { supabase } from '../shared/supabase.js';
import { makeSupaDb } from '../shared/kv-adapter.js';
import { EMAIL_CFG } from '../shared/email.js';
import { signIn, signOut, getSessionUser } from '../shared/auth.js';

window.XLSX = XLSX;

`;
  return exposeFunctions(header + js);
}

function transformAssessmentSafe(raw) {
  let js = raw.replace(/^'use strict';\s*/, '');
  js = stripMakeSupaDb(js);
  js = stripEmailCfg(js);
  js = js.replace(/let _supaClient\s*=\s*null\s*;?\s*/, '');
  js = js.replace(/if\(!window\.supabase\)\{\s*setTimeout\(initFirebase,300\);\s*return;\s*\}\s*/g, '');
  js = js.replace(
    /if\(!db\)\{\s*_supaClient=supabase\.createClient\(SUPABASE_URL,SUPABASE_ANON_KEY\);\s*db=makeSupaDb\(_supaClient\);\s*\}/g,
    'if(!db){ db=makeSupaDb(supabase); }'
  );
  js = js.replace(
    /if\(!db\)\{ _supaClient=supabase\.createClient\(SUPABASE_URL,SUPABASE_ANON_KEY\); db=makeSupaDb\(_supaClient\); \}/g,
    'if(!db){ db=makeSupaDb(supabase); }'
  );

  const header = `import './styles.css';
import { supabase } from '../shared/supabase.js';
import { makeSupaDb } from '../shared/kv-adapter.js';
import { EMAIL_CFG } from '../shared/email.js';

`;
  return exposeFunctions(header + js);
}

const outDir = 'src';
fs.mkdirSync(path.join(outDir, 'assessment'), { recursive: true });
fs.mkdirSync(path.join(outDir, 'dashboard'), { recursive: true });
fs.mkdirSync('sql', { recursive: true });

fs.copyFileSync('tmp_extract/assessment.css', 'src/assessment/styles.css');
fs.copyFileSync('tmp_extract/dashboard.css', 'src/dashboard/styles.css');

const aRaw = fs.readFileSync('tmp_extract/assessment.js', 'utf8');
const dRaw = fs.readFileSync('tmp_extract/dashboard.js', 'utf8');

fs.writeFileSync('src/assessment/main.js', transformAssessmentSafe(aRaw));
fs.writeFileSync('src/dashboard/main.js', transformDashboardSafe(dRaw));

// HTML shells
const aBody = fs.readFileSync('tmp_extract/assessment-body.html', 'utf8');
const dBody = fs
  .readFileSync('tmp_extract/dashboard-body.html', 'utf8')
  .replace(
    /<label>Dashboard ID<\/label><input class="login-inp" id="l-id" autocomplete="off" placeholder="Enter ID">/,
    '<label>Email</label><input class="login-inp" id="l-id" type="email" autocomplete="username" placeholder="you@company.com">'
  )
  .replace(
    /<div class="login-hint">Authorised recruitment personnel only\.<\/div>/,
    '<div class="login-hint">Sign in with your Supabase Auth account (role in app_metadata).</div>'
  );

const assessmentHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Apex Assessment Platform</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;1,9..40,300&display=swap" rel="stylesheet">
</head>
<body>
${aBody}
<script type="module" src="/src/assessment/main.js"></script>
</body>
</html>
`;

const dashboardHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Apex Platform — HR Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Sans:opsz,wght@9..40,300;0,9..40,400;0,9..40,500;0,9..40,600&display=swap" rel="stylesheet">
</head>
<body>
${dBody}
<script type="module" src="/src/dashboard/main.js"></script>
</body>
</html>
`;

fs.writeFileSync('index.html', assessmentHtml);
fs.writeFileSync('dashboard.html', dashboardHtml);

if (fs.existsSync('supabase-schema.sql')) {
  fs.copyFileSync('supabase-schema.sql', 'sql/supabase-schema.sql');
}

console.log('Transformed assessment main.js', fs.statSync('src/assessment/main.js').size);
console.log('Transformed dashboard main.js', fs.statSync('src/dashboard/main.js').size);
console.log('Wrote index.html + dashboard.html');

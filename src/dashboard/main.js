import './styles.css';
import * as XLSX from 'xlsx';
import { sendMail } from '../shared/mailer.js';
import { renderCertificatePNG } from '../shared/certImage.js';
import { signIn, signOut, getSessionUser } from '../shared/auth.js';
import {
  getCandidates,
  subscribeCandidates,
  setHrStatus,
  hireCandidate as hireCandidateDb,
  softDeleteCandidate,
  listEvents,
  subscribeEvents,
  listColleges,
  upsertCollege,
  deleteCollege,
  subscribeColleges,
  listBlockedDevices,
  listBlockedEmails,
  blockEmail as dbBlockEmail,
  unblockDevice as dbUnblockDevice,
  unblockEmail as dbUnblockEmail,
  subscribeBlocks,
  listCustomQuestions,
  saveCustomQuestions,
  subscribeCustomQuestions,
  getResumeByEmail,
} from '../shared/db/index.js';
import { ROUNDS, CORRECT_ANS } from '../assessment/rounds.js';

window.XLSX = XLSX;

const DB_KEY='apex_mt_v1';
const RN=['SJT','Logical','Numerical','Verbal','Game','Behavioural'];
const RI=['🎭','🧩','📊','📝','🧠','🧬'];
const COMP=['Situational Judgement','Logical Reasoning','Numerical Aptitude','Verbal Reasoning','Cognitive Agility','Behavioural Profile'];
// Real question bank so the editor pre-populates the full 17 questions per round,
// mirroring exactly what the live assessment runs (single source of truth: rounds.js)
const QUESTION_BANK = [0, 1, 2, 3].map((ri) => ({
  questions: ROUNDS[ri].qs.map((q, qi) => ({
    text: q.text,
    opts: [...q.opts],
    correct: CORRECT_ANS[ri][qi],
  })),
}));
let dbReady=false,liveEvents=[],violationLog=[],srch='',statusF='all',progF='all',curPage='overview',loggedUser=null;
let deletedSet=new Set();
let monSrch='',monFilter='all';
let calMonth=new Date().getMonth(),calYear=new Date().getFullYear(),calView='year';
let collegesCache={};
try{deletedSet=new Set(JSON.parse(localStorage.getItem('apex_deleted_local')||'[]'));}catch(e){}

function selRole(el,_r){document.querySelectorAll('.login-role-tab').forEach(t=>t.classList.remove('active'));el.classList.add('active');}
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
async function doLogout(){if(!confirm('Sign out?'))return;await signOut();location.reload();}
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
let _fbConnected=false,_fbReadOK=null;
function setFbStatus(){
  const el=document.getElementById('fb-status');if(!el)return;
  if(_fbReadOK===false){el.className='fb-pill fb-bad';el.textContent='⛔ Sync blocked — run relational schema';el.onclick=showFbHelp;return;}
  if(_fbConnected&&_fbReadOK){el.className='fb-pill fb-ok';el.textContent='🟢 Live sync on';el.onclick=null;return;}
  if(_fbConnected){el.className='fb-pill fb-connecting';el.textContent='🟡 Connected — verifying…';el.onclick=null;return;}
  el.className='fb-pill fb-connecting';el.textContent='⏳ Connecting…';el.onclick=null;
}
function showFbHelp(){
  alert('Cross-device sync is blocked.\\n\\n1. Run sql/relational-schema.sql in Supabase SQL Editor\\n2. Enable Realtime for candidates, events, colleges, blocked_* tables\\n3. Check VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in .env');
}
function initFirebaseStatus(){
  if(!dbReady){setTimeout(initFirebaseStatus,600);return;}
  _fbConnected=true;setFbStatus();
  getCandidates().then(()=>{_fbReadOK=true;setFbStatus();})
    .catch(err=>{_fbReadOK=false;setFbStatus();console.warn('[Apex] candidates read failed:',err&&err.message);});
}
async function refreshCandidatesFromDb(){
  try{
    const list=await getCandidates();
    saveCands(list);
    updateAllCounts();
    if(['overview','candidates','shortlist','leaderboard','hired','live'].includes(curPage))softRefresh();
  }catch(e){console.warn('[Apex] refresh candidates',e);}
}
async function refreshBlocksFromDb(){
  try{
    const devices=await listBlockedDevices();
    const emails=await listBlockedEmails();
    localStorage.setItem('apex_blocked_devices',JSON.stringify(devices.map(d=>d.device_id)));
    localStorage.setItem('apex_blocked_emails',JSON.stringify(emails.map(e=>e.email)));
    updateAllCounts();
    if(curPage==='whitelist')renderWhitelist();
  }catch(e){console.warn('[Apex] refresh blocks',e);}
}
async function refreshQuestionsFromDb(){
  try{
    const data=await listCustomQuestions();
    const saved={};
    Object.keys(data).forEach(k=>{
      const m=/^round(\d+)$/.exec(k);
      if(m) saved[parseInt(m[1],10)]=data[k];
      else if(/^\d+$/.test(k)) saved[parseInt(k,10)]=data[k];
    });
    localStorage.setItem('apex_custom_questions',JSON.stringify(saved));
    if(curPage==='questions'&&_qRound>=0)showREditor(_qRound);
  }catch(e){console.warn('[Apex] refresh questions',e);}
}
async function refreshCollegesFromDb(){
  try{
    collegesCache=await listColleges();
    localStorage.setItem('apex_colleges_local',JSON.stringify(collegesCache));
    if(curPage==='colleges')renderColleges();
    if(curPage==='calendar')renderCalendar();
  }catch(e){console.warn('[Apex] refresh colleges',e);}
}
function initFirebase(){
  try{
    dbReady=true;
    console.log('[Apex Dashboard] Supabase relational API ready');
    refreshCandidatesFromDb();
    listEvents(400).then(evs=>{
      evs.forEach(e=>handleLiveEvent(e));
    }).catch(e=>console.warn('[Apex] events load',e));
    subscribeEvents(e=>{if(e)handleLiveEvent(e);});
    subscribeCandidates(()=>refreshCandidatesFromDb());
    refreshBlocksFromDb();
    subscribeBlocks(()=>refreshBlocksFromDb());
    refreshQuestionsFromDb();
    subscribeCustomQuestions(()=>refreshQuestionsFromDb());
    refreshCollegesFromDb();
    subscribeColleges(()=>refreshCollegesFromDb());
  }catch(err){console.warn('[Apex] initFirebase',err);}
}
function initLiveSync(){
  if(!window.BroadcastChannel)return;
  try{const ch=new BroadcastChannel('apex_live_feed');ch.onmessage=ev=>{if(ev.data)handleLiveEvent(ev.data);};}catch(e){}
}
function mergeFromFB(c){try{const key=(c.email||'').replace(/[.@]/g,'_');if(deletedSet.has(key))return;const all=JSON.parse(localStorage.getItem(DB_KEY)||'[]');const idx=all.findIndex(x=>x.email===c.email);if(idx>=0)all[idx]={...all[idx],...c,_updated:Date.now()};else all.push({...c,id:c.id||('C'+Date.now().toString(36).toUpperCase()),_created:Date.now()});localStorage.setItem(DB_KEY,JSON.stringify(all));}catch(e){}}
function getCands(){try{return JSON.parse(localStorage.getItem(DB_KEY)||'[]');}catch(e){return[];}}
function saveCands(a){try{localStorage.setItem(DB_KEY,JSON.stringify(a));}catch(e){}}
// Rebuild candidate records from the live events stream (fallback)
function mergeEventToCandidate(e){
  const email=e.email||e.candidateEmail;
  if(!email)return;
  const key=email.replace(/[.@]/g,'_');
  if(deletedSet.has(key))return;
  const all=getCands();
  const idx=all.findIndex(x=>x.email===email);
  const rec=idx>=0?{...all[idx]}:{email,id:'C'+Date.now().toString(36).toUpperCase(),_created:Date.now(),status:'in_progress',completedRounds:0,scores:[]};
  ['fname','lname','college','passYear','deg','phone','prog','progKey','collegeId','registeredAt','submittedAt','certId','deviceId'].forEach(f=>{if(e[f]!=null&&e[f]!=='')rec[f]=e[f];});
  if(Array.isArray(e.scores))rec.scores=e.scores;
  if(e.completedRounds!=null)rec.completedRounds=e.completedRounds;
  if(e.finalScore!=null)rec.finalScore=e.finalScore;
  if(e.violations!=null)rec.violations=e.violations;
  if(!rec.fname&&e.candidateName){const p=String(e.candidateName).trim().split(' ');rec.fname=p[0]||'';rec.lname=p.slice(1).join(' ');}
  const locked=rec.status==='completed'||rec.status==='terminated';
  if(e.type==='completed')rec.status='completed';
  else if(e.type==='terminated')rec.status='terminated';
  else if(e.type==='round_start'){if(!locked)rec.status='in_progress';if(e.round!=null)rec.currentRound=e.round;}
  else if(e.type==='round_completed'){if(!locked)rec.status='in_progress';if(e.roundJustCompleted!=null)rec.completedRounds=Math.max(rec.completedRounds||0,e.roundJustCompleted);}
  else if(e.type==='registered'){if(!rec.status)rec.status='in_progress';}
  else if(e.type==='violation')rec.violations=(e.count!=null?e.count:(rec.violations||0)+1);
  else if(e.status&&!locked)rec.status=e.status;
  rec._updated=e._ts||Date.now();
  if(idx>=0)all[idx]=rec;else all.push(rec);
  saveCands(all);
}
function getFiltered(){let c=getCands();if(srch){const s=srch.toLowerCase();c=c.filter(x=>(x.fname||'').toLowerCase().includes(s)||(x.lname||'').toLowerCase().includes(s)||(x.email||'').toLowerCase().includes(s)||(x.college||'').toLowerCase().includes(s));}if(statusF!=='all')c=c.filter(x=>cStatus(x)===statusF);if(progF!=='all')c=c.filter(x=>x.progKey===progF);return c;}
function cAvg(c){const sc=c.scores||[];return sc.length?Math.round(sc.reduce((a,b)=>a+b,0)/sc.length):0;}
function cStatus(c){if(c.hired)return'hired';if(c.hrStatus)return c.hrStatus;const a=cAvg(c);if(c.completedRounds>=6){if(a>=80)return'shortlist';if(a>=65)return'review';return'hold';}return'in_progress';}
function fullN(c){return(((c.fname||'')+' '+(c.lname||'')).trim())||c.email||'Unknown';}
function inits(c){return(((c.fname||'?')[0]||'?')+((c.lname||'?')[0]||'?')).toUpperCase();}
const avc=['#D4A843','#22C55E','#3B82F6','#A78BFA','#F59E0B','#EF4444','#10B981','#EC4899'];
const avCol=i=>avc[i%avc.length];
function scColor(s){return s>=80?'var(--green)':s>=65?'var(--orange)':s>=50?'var(--blue)':'var(--red)';}
function scClass(s){return s>=80?'pill-g':s>=65?'pill-y':'pill-r';}
function sLabel(s){const m={shortlist:'⭐ Shortlist',review:'🟡 Review',hold:'🔴 Hold',in_progress:'🔵 Active',hired:'✅ Hired'};return m[s]||s;}
function sClass(s){const m={shortlist:'pill-g',review:'pill-y',hold:'pill-r',in_progress:'pill-b',hired:'pill-hired'};return m[s]||'pill-b';}
function fmtDate(ts){if(!ts)return '—';try{const d=new Date(ts);return d.getDate().toString().padStart(2,'0')+' '+['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()]+' '+String(d.getFullYear()).slice(2)+' '+d.getHours().toString().padStart(2,'0')+':'+d.getMinutes().toString().padStart(2,'0');}catch(e){return '—';}}
function avgArr(arr){const v=arr.filter(x=>typeof x==='number'&&!isNaN(x));return v.length?Math.round(v.reduce((a,b)=>a+b,0)/v.length):0;}
function updateAllCounts(){
  const all=getCands();
  const s=(id,v)=>{const el=document.getElementById(id);if(el)el.textContent=v;};
  s('nb-total',all.length);s('nb-live',all.filter(c=>c.status==='in_progress').length);
  s('nb-short',all.filter(c=>cStatus(c)==='shortlist'&&!c.hired).length);s('nb-hired',all.filter(c=>c.hired).length);
  s('nb-viols',violationLog.length);s('nb-events',liveEvents.length);
  try{const bd=JSON.parse(localStorage.getItem('apex_blocked_devices')||'[]');const be=JSON.parse(localStorage.getItem('apex_blocked_emails')||'[]');s('nb-blocked',bd.length+be.length);}catch(e){}
  try{s('nb-colleges',Object.keys(_collegesData()).length);}catch(e){}
  try{const td=new Date();const tm=new Date(td.getFullYear(),td.getMonth(),td.getDate()).getTime();const d=_collegesData();let up=0;Object.values(d).forEach(c=>{const st=_collegeMs(c.startTime),ex=_collegeMs(c.expireTime);if(st&&(ex?ex>=tm:st>=tm))up++;});s('nb-calendar',up);}catch(e){}
}
let _liveRefreshT=null;
function scheduleLiveRefresh(){
  if(_liveRefreshT)return;
  _liveRefreshT=setTimeout(()=>{_liveRefreshT=null;updateAllCounts();if(['live','violations','candidates','overview','shortlist','leaderboard','hired'].includes(curPage))softRefresh();},250);
}
function handleLiveEvent(e){
  const icons={registered:'📋',round_start:'▶️',round_completed:'✅',completed:'🏆',violation:'⚠️',terminated:'🚫',hired:'🎉',flag:'🖥️'};
  if(e.type==='violation')violationLog.push(e);
  mergeEventToCandidate(e);
  liveEvents.unshift({type:e.type,ico:icons[e.type]||'📍',name:e.candidateName||e.name||'Candidate',detail:getEvDetail(e),time:e.time||new Date().toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'}),_ts:e._ts||Date.now()});
  if(liveEvents.length>200)liveEvents.pop();
  scheduleLiveRefresh();
}
function getEvDetail(e){
  if(e.type==='registered')return'Registered · '+(e.prog||e.progKey||'')+' · '+(e.college||'');
  if(e.type==='round_start')return'Started Round '+(e.round||'')+': '+(e.roundName||'');
  if(e.type==='round_completed')return'Completed Round '+(e.roundJustCompleted||'')+(e.roundScore!==undefined?' · Score: '+e.roundScore+'%':'');
  if(e.type==='completed')return'All 6 rounds submitted';
  if(e.type==='violation')return'Violation #'+(e.count||'')+': '+(e.reason||'Unknown');
  if(e.type==='terminated')return'Terminated — device blocked';
  if(e.type==='hired')return'Marked as HIRED';
  if(e.type==='flag')return'Possible remote-access signal: '+(e.reason||'Unknown');
  return e.detail||'';
}
const pageTitles={overview:'Live Dashboard',candidates:'All Candidates',live:'Live Monitor',shortlist:'Shortlist',hired:'Hired',leaderboard:'Leaderboard',analytics:'Analytics',collegecompare:'Compare Colleges',violations:'Violations',whitelist:'Whitelist Manager',questions:'Question Editor',bulkinvite:'Bulk Invite',colleges:'College Links & Scheduling',calendar:'Hiring Calendar',certs:'Certificates',settings:'Settings'};
function nav(page,el){curPage=page;document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));if(el)el.classList.add('active');document.getElementById('page-title').textContent=pageTitles[page]||page;renderPage();}
function navTo(page){const el=[...document.querySelectorAll('.nav-item')].find(n=>(n.getAttribute('onclick')||'').includes("'"+page+"'"));nav(page,el);}
function globalSearch(v){srch=v;if(curPage!=='candidates'){navTo('candidates');const gs=document.getElementById('global-search');if(gs)gs.focus();}else{renderCandResults();}}
function renderPage(){const fns={overview:renderOverview,candidates:renderCandidates,live:renderLive,shortlist:renderShortlist,hired:renderHired,leaderboard:renderLeaderboard,analytics:renderAnalytics,collegecompare:renderCollegeCompare,violations:renderViolations,whitelist:renderWhitelist,questions:renderQEditor,bulkinvite:renderBulkInvite,colleges:renderColleges,calendar:renderCalendar,certs:renderCerts,settings:renderSettings};if(fns[curPage])fns[curPage]();}
// Re-render without stealing focus from a text field the user is typing in (fixes search interruption)
function softRefresh(){
  const ae=document.activeElement;
  let r=null;
  if(ae&&(ae.tagName==='INPUT'||ae.tagName==='TEXTAREA')&&ae.id){r={id:ae.id,s:ae.selectionStart,e:ae.selectionEnd};}
  renderPage();
  if(r){const el=document.getElementById(r.id);if(el){try{el.focus({preventScroll:true});if(r.s!=null&&el.setSelectionRange)el.setSelectionRange(r.s,r.e);}catch(_){}}}
}

function renderOverview(){
  const all=getCands(),comp=all.filter(c=>c.completedRounds>=6),active=all.filter(c=>c.status==='in_progress'),hired=all.filter(c=>c.hired);
  const avg=comp.length?avgArr(comp.map(c=>cAvg(c))):0;
  document.getElementById('content').innerHTML=`
  <div class="stat-row">
    <div class="stat-card" style="--accent:var(--blue)"><div class="stat-lbl">Registered</div><div class="stat-val">${all.length}</div><div class="stat-sub">${active.length} active now</div></div>
    <div class="stat-card" style="--accent:var(--green)"><div class="stat-lbl">Completed</div><div class="stat-val">${comp.length}</div><div class="stat-sub">All 6 rounds</div></div>
    <div class="stat-card"><div class="stat-lbl">Avg Score</div><div class="stat-val">${avg}%</div><div class="stat-sub">Completed candidates</div></div>
    <div class="stat-card" style="--accent:var(--violet)"><div class="stat-lbl">Hired</div><div class="stat-val" style="color:var(--green)">${hired.length}</div><div class="stat-sub">Offers sent</div></div>
  </div>
  <div class="grid2">
    <div class="live-panel">
      <div class="live-feed-hdr">
        <div style="display:flex;align-items:center;gap:6px"><span class="live-dot" style="width:7px;height:7px;border-radius:50%;background:var(--green);animation:blink 1.5s infinite"></span><span style="font-family:var(--fd);font-size:12px;font-weight:700">Live Feed</span></div>
        <button class="btn btn-ghost" style="font-size:8.5px;padding:2px 6px" onclick="liveEvents=[];renderPage()">Clear</button>
      </div>
      <div class="live-feed-list">${liveEvents.length===0?'<div style="text-align:center;padding:2.5rem;color:var(--muted);font-size:11px">Waiting for events…</div>':liveEvents.slice(0,30).map(e=>`<div class="feed-item ${e.type}"><span class="feed-ico">${e.ico}</span><div class="feed-body"><div class="feed-name">${e.name}</div><div class="feed-detail">${e.detail}</div></div><div class="feed-time">${e.time}</div></div>`).join('')}</div>
    </div>
    <div class="hcard">
      <div class="hcard-title">🔴 Active Now</div>
      ${active.length===0?'<div style="text-align:center;padding:1.5rem;color:var(--muted);font-size:11px">No active candidates</div>':active.map((c,i)=>`<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--border2)"><span class="sdot active"></span><div class="avtr" style="background:${avCol(i)}22;color:${avCol(i)}">${inits(c)}</div><div style="flex:1"><div style="font-size:11.5px;font-weight:600">${fullN(c)}</div><div style="font-size:9.5px;color:var(--text2)">${c.college||'—'} · Round ${c.completedRounds||0}/6</div></div><button class="btn btn-ghost" style="font-size:8.5px;padding:2px 6px" onclick="openDetail('${c.id||c.email}')">→</button></div>`).join('')}
    </div>
  </div>
  <div class="hcard">
    <div class="hcard-title">📊 Round Performance (Average)</div>
    ${RN.map((rn,ri)=>{const scores=comp.map(c=>(c.scores||[])[ri]).filter(s=>typeof s==='number');const avg2=scores.length?avgArr(scores):0;return`<div class="bar-row"><span class="bar-label">${RI[ri]} ${rn}</span><div class="bar-track"><div class="bar-fill" style="width:${avg2}%;background:${scColor(avg2)}"></div></div><span class="bar-val" style="color:${scColor(avg2)}">${avg2}%</span></div>`;}).join('')}
  </div>`;}

function renderCandidates(){
  const wasSearch=document.activeElement&&document.activeElement.id==='cand-search';
  const caret=wasSearch?document.activeElement.selectionStart:null;
  document.getElementById('content').innerHTML=`
  <div class="toolbar">
    <input class="inp" id="cand-search" placeholder="Search…" value="${(srch||'').replace(/"/g,'&quot;')}" oninput="srch=this.value;renderCandResults()" style="flex:1;min-width:140px">
    ${['all','shortlist','review','hold','hired','in_progress'].map(s=>`<button class="fbtn ${statusF===s?'on':''}" onclick="statusF='${s}';renderCandidates()">${s==='all'?'All':sLabel(s)}</button>`).join('')}
    ${['all','6mt','3mt'].map(p=>`<button class="fbtn ${progF===p?'on':''}" onclick="progF='${p}';renderCandidates()">${p==='all'?'All Prog':p.toUpperCase()}</button>`).join('')}
  </div>
  <div id="cand-results"></div>`;
  renderCandResults();
  if(wasSearch){const si=document.getElementById('cand-search');if(si){si.focus();const p=caret==null?si.value.length:caret;try{si.setSelectionRange(p,p);}catch(e){}}}
}
function renderCandResults(){
  const box=document.getElementById('cand-results');if(!box)return;
  const all=getCands(),filtered=getFiltered().sort((a,b)=>(b._updated||0)-(a._updated||0));
  box.innerHTML=`
  <div style="font-size:9.5px;color:var(--muted);margin-bottom:.6rem">${filtered.length} of ${all.length} candidates</div>
  <div class="hcard" style="padding:0"><div class="tbl-wrap"><table class="tbl">
    <thead><tr><th>#</th><th>Candidate</th><th>College</th><th>Prog</th>${RN.map(r=>'<th>'+r+'</th>').join('')}<th>Avg</th><th>Status</th><th>Viols</th><th>Action</th></tr></thead>
    <tbody>
    ${filtered.length===0?'<tr><td colspan="15" style="text-align:center;padding:2rem;color:var(--muted)">No candidates match filters</td></tr>':''}
    ${filtered.map((c,i)=>{const a=cAvg(c),st=cStatus(c),sc=c.scores||[];const viols=violationLog.filter(v=>v.candidateEmail===c.email).length;return`<tr onclick="openDetail('${c.id||c.email}')">
      <td style="color:var(--muted)">${i+1}</td>
      <td><div style="display:flex;align-items:center;gap:6px"><span class="sdot ${c.status==='in_progress'?'active':c.completedRounds>=6?'done':'hold'}"></span><div class="avtr" style="width:24px;height:24px;font-size:9px;background:${avCol(i)}22;color:${avCol(i)}">${inits(c)}</div><div><div style="font-weight:600;font-size:11px">${fullN(c)}</div><div style="font-size:9px;color:var(--muted)">${c.email||''}</div></div></div></td>
      <td style="font-size:10.5px;color:var(--text2)">${c.college||'—'}</td>
      <td><span class="prog-pill">${c.progKey==='6mt'?'6MT':'3MT'}</span></td>
      ${[0,1,2,3,4,5].map(ri=>`<td style="color:${sc[ri]!==undefined?scColor(sc[ri]):'var(--muted)'};font-weight:600;font-size:10.5px">${sc[ri]!==undefined?sc[ri]+'%':'—'}</td>`).join('')}
      <td><span class="pill ${scClass(a)}">${a}%</span></td>
      <td><span class="pill ${sClass(st)}">${sLabel(st)}</span></td>
      <td>${viols>0?`<span class="pill pill-r">⚠ ${viols}</span>`:'-'}</td>
      <td onclick="event.stopPropagation()">${c.hired?'<span class="pill pill-hired">✅</span>':`<button class="btn-hire" style="font-size:8.5px;padding:3px 8px" onclick="hireCandidate('${c.id||c.email}')">Hire</button>`}</td>
    </tr>`;}).join('')}
    </tbody></table></div></div>`;
}

function relTime(ms){if(!ms)return '';const d=Date.now()-ms;const s=Math.floor(d/1000);if(s<10)return 'just now';if(s<60)return s+'s ago';const m=Math.floor(s/60);if(m<60)return m+'m ago';const h=Math.floor(m/60);if(h<24)return h+'h ago';return Math.floor(h/24)+'d ago';}
function monitorActivity(c){
  const done=c.completedRounds||((c.scores||[]).length)||0;
  if(c.hired)return{txt:'\U0001F389 Hired',cls:'done'};
  if(c.status==='terminated'||c.terminated)return{txt:'\U0001F6AB Terminated',cls:'hold'};
  if(done>=6||c.status==='completed'||c.submittedAt)return{txt:'\u2713 Completed all rounds',cls:'done'};
  if(c.status==='in_progress'){
    if(c._updated&&(Date.now()-c._updated>150000))return{txt:'\u23F8 Idle \u00B7 Round '+(done+1)+' ('+(RN[done]||'')+')',cls:'idle'};
    if(done===0&&!((c.scores||[]).length))return{txt:'\u23F3 Starting \u00B7 '+(RN[0]||''),cls:'active'};
    return{txt:'\u25B6 Round '+(done+1)+' of 6 \u00B7 '+(RN[done]||''),cls:'active'};
  }
  return{txt:'\U0001F4CB Registered \u00B7 not started',cls:'hold'};
}
function renderLive(){
  const cands=getCands();
  const evMap={};liveEvents.forEach(e=>{const k=(e.name||'').toLowerCase();if(k&&!evMap[k])evMap[k]=e;});
  const monitored=cands.slice().sort((a,b)=>(b._updated||0)-(a._updated||0));
  let monView=monitored;
  if(monSrch){const s=monSrch.toLowerCase();monView=monView.filter(c=>(fullN(c)||'').toLowerCase().includes(s)||(c.email||'').toLowerCase().includes(s)||(c.college||'').toLowerCase().includes(s));}
  if(monFilter!=='all'){monView=monView.filter(c=>{const a=monitorActivity(c);if(monFilter==='active')return a.cls==='active';if(monFilter==='idle')return a.cls==='idle';if(monFilter==='done')return a.cls==='done';if(monFilter==='flagged')return violationLog.some(v=>v.candidateEmail===c.email);return true;});}
  const activeN=cands.filter(c=>c.status==='in_progress').length;
  const doneN=cands.filter(c=>(c.completedRounds||0)>=6||c.submittedAt).length;
  const flagN=cands.filter(c=>violationLog.some(v=>v.candidateEmail===c.email)).length;
  const stat=(lbl,val,col)=>`<div class="hcard" style="padding:.7rem .9rem;flex:1;min-width:108px"><div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:.07em">${lbl}</div><div style="font-family:var(--fd);font-size:22px;font-weight:800;color:${col}">${val}</div></div>`;
  const card=(c,i)=>{
    const act=monitorActivity(c);
    const sc=c.scores||[];const done=c.completedRounds||sc.length||0;const viols=violationLog.filter(v=>v.candidateEmail===c.email).length;
    const ev=evMap[(fullN(c)||'').toLowerCase()];
    const chips=[0,1,2,3,4,5].map(ri=>{
      const state=sc[ri]!==undefined?'done':(ri===done&&act.cls==='active'?'cur':'pend');
      const bg=state==='done'?scColor(sc[ri]):(state==='cur'?'var(--amber)':'var(--border2)');
      return `<span title="${RN[ri]}" style="flex:1;height:5px;border-radius:3px;background:${bg};opacity:${state==='pend'?.3:1};${state==='cur'?'animation:blink 1.2s infinite':''}"></span>`;
    }).join('');
    return `<div class="hcard mon-card" style="cursor:pointer;padding:.85rem" onclick="openDetail('${c.id||c.email}')">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:.55rem">
        <span class="sdot ${act.cls}"></span>
        <div class="avtr" style="background:${avCol(i)}22;color:${avCol(i)}">${inits(c)}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:12px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${fullN(c)}</div>
          <div style="font-size:9px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${c.college||c.email||''}</div>
        </div>
        <span class="prog-pill">${c.progKey==='6mt'?'6MT':'3MT'}</span>
      </div>
      <div style="font-size:10.5px;font-weight:600;color:var(--text);margin-bottom:.5rem">${act.txt}</div>
      <div style="display:flex;gap:3px;margin-bottom:.5rem">${chips}</div>
      <div style="display:flex;justify-content:space-between;align-items:center;font-size:9px;color:var(--muted)">
        <span>${done}/6 rounds${cAvg(c)?' \u00B7 avg '+cAvg(c)+'%':''}</span>
        <span>${viols>0?`<span style="color:var(--red)">\u26A0 ${viols}</span> \u00B7 `:''}${ev?relTime(ev._ts):relTime(c._updated)}</span>
      </div>
    </div>`;
  };
  document.getElementById('content').innerHTML=`
  <div style="display:flex;gap:.6rem;flex-wrap:wrap;margin-bottom:1rem">
    ${stat('Active now',activeN,'var(--green)')}
    ${stat('Completed',doneN,'var(--blue)')}
    ${stat('Flagged',flagN,flagN?'var(--red)':'var(--text)')}
    ${stat('Total',cands.length,'var(--amber)')}
  </div>
  <div style="display:flex;align-items:center;gap:7px;margin-bottom:.7rem;flex-wrap:wrap">
    <span class="live-dot" style="width:7px;height:7px;border-radius:50%;background:var(--green);animation:blink 1.5s infinite"></span>
    <span style="font-family:var(--fd);font-size:12px;font-weight:700">Candidate Monitor</span>
    <span style="font-size:9.5px;color:var(--muted)">live activity \u2014 click a card for detail</span>
  </div>
  <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:.8rem">
    <input class="inp" id="mon-search" placeholder="Search name, email, college\u2026" value="${(monSrch||'').replace(/"/g,'&quot;')}" oninput="monSrch=this.value;softRefresh()" style="flex:1;min-width:150px;font-size:11px">
    ${[['all','All'],['active','\u25B6 Active'],['idle','\u23F8 Idle'],['done','\u2713 Done'],['flagged','\u26A0 Flagged']].map(([k,l])=>`<button class="fbtn ${monFilter===k?'on':''}" onclick="monFilter='${k}';softRefresh()">${l}</button>`).join('')}
  </div>
  ${cands.length===0?'<div class="hcard" style="text-align:center;color:var(--muted);padding:2rem;font-size:11px">No candidates yet. Cards appear here as candidates register and begin.</div>':(monView.length===0?'<div class="hcard" style="text-align:center;color:var(--muted);padding:1.6rem;font-size:11px">No candidates match this view.</div>':`<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(235px,1fr));gap:.7rem;margin-bottom:1.3rem">${monView.map(card).join('')}</div>`)}
  <div class="live-panel"><div class="live-feed-hdr"><div style="display:flex;align-items:center;gap:7px"><span class="live-dot" style="width:7px;height:7px;border-radius:50%;background:var(--green);animation:blink 1.5s infinite"></span><span style="font-family:var(--fd);font-size:12px;font-weight:700">Live Event Feed</span><span class="nav-badge live">${liveEvents.length}</span></div><button class="btn btn-ghost" style="font-size:9px" onclick="liveEvents=[];renderLive()">Clear</button></div><div class="live-feed-list" style="max-height:300px">${liveEvents.length===0?'<div style="text-align:center;padding:2rem;color:var(--muted)">Waiting for events\u2026</div>':liveEvents.map(e=>`<div class="feed-item ${e.type}"><span class="feed-ico">${e.ico}</span><div class="feed-body"><div class="feed-name">${e.name}</div><div class="feed-detail">${e.detail}</div></div><div class="feed-time">${e.time}</div></div>`).join('')}</div></div>`;
}

function renderShortlist(){
  const sl=getCands().filter(c=>cStatus(c)==='shortlist'&&!c.hired).sort((a,b)=>cAvg(b)-cAvg(a));
  document.getElementById('content').innerHTML=sl.length===0?'<div style="text-align:center;padding:3rem;color:var(--muted)"><div style="font-size:40px;margin-bottom:.8rem">⭐</div><div style="font-family:var(--fd)">Shortlist empty — candidates ≥80% auto-shortlisted</div></div>':`<div style="margin-bottom:.8rem;display:flex;align-items:center;justify-content:space-between"><div style="font-size:11.5px;color:var(--text2)">${sl.length} ready for PI</div><button class="btn-hire" onclick="bulkHire()">✅ Hire All</button></div>`+sl.map((c,i)=>{const a=cAvg(c);return`<div class="hcard" style="margin-bottom:8px;cursor:pointer" onclick="openDetail('${c.id||c.email}')"><div style="display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap"><div class="avtr" style="width:40px;height:40px;font-size:12px;background:${avCol(i)}22;color:${avCol(i)}">${inits(c)}</div><div style="flex:1"><div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;flex-wrap:wrap"><span style="font-family:var(--fd);font-size:13px;font-weight:700">${fullN(c)}</span><span class="prog-pill">${c.progKey==='6mt'?'6MT':'3MT'}</span><span class="pill pill-g">⭐</span></div><div style="font-size:10.5px;color:var(--text2);margin-bottom:6px">${c.college||''} · ${c.email||''}</div><div style="display:grid;grid-template-columns:repeat(6,1fr);gap:4px">${RN.map((rn,ri)=>`<div style="text-align:center;background:rgba(255,255,255,.025);border-radius:5px;padding:4px;border:1px solid var(--border2)"><div style="font-size:7.5px;color:var(--muted);margin-bottom:1px">${rn}</div><div style="font-size:10.5px;font-weight:700;color:${scColor((c.scores||[])[ri]||0)}">${(c.scores||[])[ri]||'—'}${(c.scores||[])[ri]!==undefined?'%':''}</div></div>`).join('')}</div></div><div style="text-align:center;flex-shrink:0"><div style="font-family:var(--fd);font-size:26px;font-weight:800;color:${scColor(a)}">${a}%</div><div style="font-size:8.5px;color:var(--text2);margin-bottom:6px">Overall</div><button class="btn-hire" style="font-size:9.5px;padding:6px 12px" onclick="event.stopPropagation();hireCandidate('${c.id||c.email}')">✅ Hire</button></div></div></div>`;}).join('');}
function bulkHire(){if(!confirm('Hire ALL shortlisted?'))return;const sl=getCands().filter(c=>cStatus(c)==='shortlist'&&!c.hired);sl.forEach(c=>confirmHire(c.id||c.email));showToast('🎉 '+sl.length+' hired!','success');}

function renderHired(){const hired=getCands().filter(c=>c.hired).sort((a,b)=>new Date(b.hiredAt||0)-new Date(a.hiredAt||0));document.getElementById('content').innerHTML=hired.length===0?'<div style="text-align:center;padding:3rem;color:var(--muted)"><div style="font-size:40px;margin-bottom:.8rem">✅</div><div style="font-family:var(--fd)">No hires yet</div></div>':`<div style="margin-bottom:.8rem;font-size:11.5px;color:var(--text2)">${hired.length} offer${hired.length!==1?'s':''} sent</div>`+hired.map((c,i)=>{const a=cAvg(c);return`<div class="hcard" style="margin-bottom:8px;border-color:rgba(34,197,94,.18)"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><div class="avtr" style="width:40px;height:40px;font-size:12px;background:rgba(34,197,94,.12);color:var(--green)">${inits(c)}</div><div style="flex:1"><div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:3px"><span style="font-family:var(--fd);font-size:13px;font-weight:700">${fullN(c)}</span><span class="pill pill-hired">✅ HIRED</span><span class="prog-pill">${c.progKey==='6mt'?'6MT':'3MT'}</span></div><div style="font-size:10.5px;color:var(--text2)">${c.college||''} · ${c.email||''}</div><div style="font-size:9.5px;color:var(--muted);margin-top:2px">Hired by ${c.hiredBy||'HR'} · ${fmtDate(c.hiredAt)}</div></div><div style="text-align:center"><div style="font-family:var(--fd);font-size:24px;font-weight:800;color:var(--green)">${a}%</div></div><div style="display:flex;flex-direction:column;gap:4px"><button class="btn btn-amber" style="font-size:8.5px" onclick="showCert('${c.id||c.email}')">🏆 Cert</button><button class="btn btn-ghost" style="font-size:8.5px" onclick="sendCertEmail('${c.id||c.email}')">📧 Send</button></div></div></div>`;}).join('');}

function renderLeaderboard(){const ranked=[...getCands()].filter(c=>c.completedRounds>=6).sort((a,b)=>cAvg(b)-cAvg(a));document.getElementById('content').innerHTML=ranked.length===0?'<div style="text-align:center;padding:3rem;color:var(--muted)"><div style="font-size:40px;margin-bottom:.8rem">🏆</div><div style="font-family:var(--fd)">Awaiting completions</div></div>':ranked.map((c,i)=>{const a=cAvg(c);const medal=i<3?['🥇','🥈','🥉'][i]:'';return`<div class="hcard" style="margin-bottom:8px;cursor:pointer${c.hired?';border-color:rgba(34,197,94,.18)':''}" onclick="openDetail('${c.id||c.email}')"><div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><div style="font-family:var(--fd);font-size:15px;font-weight:700;color:var(--muted);width:28px;text-align:center">${medal||'#'+(i+1)}</div><div class="avtr" style="width:36px;height:36px;font-size:11px;background:${avCol(i)}22;color:${avCol(i)}">${inits(c)}</div><div style="flex:1"><div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:4px"><span style="font-family:var(--fd);font-size:13px;font-weight:700">${fullN(c)}</span><span style="font-size:10.5px;color:var(--text2)">${c.college||''}</span><span class="prog-pill">${c.progKey==='6mt'?'6MT':'3MT'}</span><span class="pill ${sClass(cStatus(c))}">${sLabel(cStatus(c))}</span>${c.hired?'<span class="pill pill-hired">✅ Hired</span>':''}</div><div style="display:flex;align-items:center;gap:6px"><div style="flex:1;height:5px;background:rgba(255,255,255,.05);border-radius:3px;overflow:hidden"><div style="height:100%;width:${a}%;background:${scColor(a)}"></div></div><span style="font-family:var(--fd);font-size:14px;font-weight:700;color:${scColor(a)};width:36px;text-align:right">${a}%</span></div></div>${!c.hired?`<button class="btn-hire" style="font-size:8.5px;padding:4px 10px" onclick="event.stopPropagation();hireCandidate('${c.id||c.email}')">Hire</button>`:''}</div></div>`;}).join('');}

function renderAnalytics(){
  const completed=getCands().filter(c=>c.completedRounds>=6);
  const topQ=completed.filter(c=>cAvg(c)>=80),midQ=completed.filter(c=>cAvg(c)>=65&&cAvg(c)<80),lowQ=completed.filter(c=>cAvg(c)<65);
  const pct=getCands().length>0?Math.round(completed.length/getCands().length*100):0;
  document.getElementById('content').innerHTML=`
  <div class="stat-row">
    <div class="stat-card" style="--accent:var(--green)"><div class="stat-lbl">Top ≥80%</div><div class="stat-val">${topQ.length}</div><div class="stat-sub">Auto-shortlisted</div></div>
    <div class="stat-card" style="--accent:var(--orange)"><div class="stat-lbl">Mid 65–79%</div><div class="stat-val">${midQ.length}</div><div class="stat-sub">Under review</div></div>
    <div class="stat-card" style="--accent:var(--red)"><div class="stat-lbl">Below 65%</div><div class="stat-val">${lowQ.length}</div><div class="stat-sub">Hold</div></div>
    <div class="stat-card"><div class="stat-lbl">Completion Rate</div><div class="stat-val">${pct}%</div><div class="stat-sub">Of registered</div></div>
  </div>
  <div class="hcard">
    <div class="hcard-title">🧬 Competency Breakdown</div>
    ${COMP.map((comp,ci)=>{const scores=completed.map(c=>(c.scores||[])[ci]).filter(s=>typeof s==='number');const avg2=scores.length?avgArr(scores):0;const p80=scores.filter(s=>s>=80).length;const p65=scores.filter(s=>s>=65&&s<80).length;const pLow=scores.filter(s=>s<65).length;return`<div style="margin-bottom:1.1rem"><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px"><span style="font-size:11.5px;font-weight:600">${RI[ci]} ${comp}</span><span style="font-size:11.5px;font-weight:700;color:${scColor(avg2)}">${avg2}% avg</span></div><div style="display:flex;height:6px;border-radius:3px;overflow:hidden;gap:1px"><div style="width:${scores.length>0?Math.round(p80/scores.length*100):0}%;background:var(--green)"></div><div style="width:${scores.length>0?Math.round(p65/scores.length*100):0}%;background:var(--orange)"></div><div style="width:${scores.length>0?Math.round(pLow/scores.length*100):0}%;background:var(--red)"></div></div><div style="display:flex;gap:12px;margin-top:3px;font-size:9px;color:var(--muted)"><span>🟢 ${p80} ≥80%</span><span>🟡 ${p65} 65–79%</span><span>🔴 ${pLow} &lt;65%</span></div></div>`;}).join('')}
  </div>
  <div class="grid2">
    <div class="hcard">
      <div class="hcard-title">📈 Score Distribution</div>
      ${[[90,100,'Elite'],[80,89,'Excellent'],[65,79,'Good'],[50,64,'Average'],[0,49,'Below Avg']].map(([lo,hi,lbl])=>{const cnt=completed.filter(c=>{const a=cAvg(c);return a>=lo&&a<=hi;}).length;const w=completed.length>0?Math.round(cnt/completed.length*100):0;return`<div class="bar-row"><span class="bar-label" style="font-size:9.5px">${lo}-${hi}% ${lbl}</span><div class="bar-track"><div class="bar-fill" style="width:${w}%;background:${scColor(lo)}"></div></div><span class="bar-val" style="color:${scColor(lo)}">${cnt}</span></div>`;}).join('')}
    </div>
    <div class="hcard">
      <div class="hcard-title">🎓 Programme Split</div>
      ${[['6mt','6-Month MT'],['3mt','3-Month MT']].map(([key,lbl])=>{const cnt=completed.filter(c=>c.progKey===key).length;const w=completed.length>0?Math.round(cnt/completed.length*100):0;return`<div class="bar-row"><span class="bar-label" style="font-size:10px">${lbl}</span><div class="bar-track"><div class="bar-fill" style="width:${w}%;background:var(--amber)"></div></div><span class="bar-val">${cnt}</span></div>`;}).join('')}
      <div style="margin-top:1rem;font-size:10.5px;color:var(--text2);line-height:1.9">
        <div>Avg time to complete: <strong>~75 min</strong></div>
        <div>Violation rate: <strong>${getCands().length>0?Math.round(violationLog.length/getCands().length*10)/10:0} per candidate</strong></div>
        <div>Termination rate: <strong>${getCands().length>0?Math.round(getCands().filter(c=>c.status==='terminated'?true:false).length/getCands().length*100):0}%</strong></div>
      </div>
    </div>
  </div>`;}

function renderViolations(){document.getElementById('content').innerHTML=`<div class="hcard" style="padding:0"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>#</th><th>Candidate</th><th>Email</th><th>Round</th><th>Reason</th><th>Count</th><th>Time</th><th>Device</th></tr></thead><tbody>${violationLog.length===0?'<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--muted)">No violations recorded</td></tr>':''}${violationLog.map((v,i)=>`<tr><td style="color:var(--muted)">${i+1}</td><td style="font-weight:600;font-size:11px">${v.candidateName||'—'}</td><td style="font-size:10px;color:var(--text2)">${v.candidateEmail||'—'}</td><td><span class="pill pill-y">R${v.round||'?'}</span></td><td style="font-size:10.5px;color:var(--text2)">${v.reason||'—'}</td><td><span class="pill pill-r">⚠ ${v.count||1}</span></td><td style="font-size:9.5px;color:var(--muted)">${v.time||'—'}</td><td style="font-size:9px;color:var(--muted);max-width:110px;overflow:hidden;text-overflow:ellipsis">${v.deviceId||'—'}</td></tr>`).join('')}</tbody></table></div></div>`;}

function renderWhitelist(){
  let bd=[],be=[];
  try{bd=JSON.parse(localStorage.getItem('apex_blocked_devices')||'[]');}catch(e){}
  try{be=JSON.parse(localStorage.getItem('apex_blocked_emails')||'[]');}catch(e){}
  document.getElementById('content').innerHTML=`
  <div class="hcard">
    <div class="hcard-title">🔓 Whitelist Manager <span style="font-size:9.5px;color:var(--muted);font-weight:400">(Admin only)</span></div>
    <p style="font-size:11px;color:var(--text2);margin-bottom:1.1rem;line-height:1.7">When a candidate is terminated, their device ID and email are blocked. Use this panel to reinstate access after review.</p>
    <div class="grid2">
      <div>
        <div style="font-size:10px;font-weight:700;color:var(--amber);text-transform:uppercase;letter-spacing:.1em;margin-bottom:.6rem">🚫 Blocked Devices (${bd.length})</div>
        ${bd.length===0?'<div style="font-size:10.5px;color:var(--muted)">None blocked</div>':''}
        ${bd.map(d=>`<div style="display:flex;align-items:center;gap:7px;padding:7px 0;border-bottom:1px solid var(--border2)"><span style="font-family:var(--fd);font-size:9.5px;color:var(--text2);flex:1;word-break:break-all">${d}</span><button class="btn btn-success" style="font-size:8.5px;padding:2px 7px" onclick="unblockDevice('${d}')">✓ Reinstate</button></div>`).join('')}
      </div>
      <div>
        <div style="font-size:10px;font-weight:700;color:var(--amber);text-transform:uppercase;letter-spacing:.1em;margin-bottom:.6rem">📧 Blocked Emails (${be.length})</div>
        ${be.length===0?'<div style="font-size:10.5px;color:var(--muted)">None blocked</div>':''}
        ${be.map(e=>`<div style="display:flex;align-items:center;gap:7px;padding:7px 0;border-bottom:1px solid var(--border2)"><span style="font-size:10.5px;color:var(--text2);flex:1">${e}</span><button class="btn btn-success" style="font-size:8.5px;padding:2px 7px" onclick="unblockEmail('${e}')">✓ Reinstate</button></div>`).join('')}
      </div>
    </div>
    <div style="margin-top:1.1rem;border-top:1px solid var(--border2);padding-top:1rem">
      <div style="font-size:10.5px;font-weight:700;color:var(--text2);margin-bottom:.55rem">Manually Block / Whitelist Email</div>
      <div style="display:flex;gap:7px;flex-wrap:wrap">
        <input class="inp" id="wl-email" placeholder="candidate@email.com" style="flex:1;min-width:180px">
        <button class="btn btn-danger" onclick="manualBlockEmail()">🚫 Block</button>
        <button class="btn btn-success" onclick="manualUnblockEmail()">✓ Unblock</button>
      </div>
    </div>
  </div>`;}

function unblockDevice(id){try{let b=JSON.parse(localStorage.getItem('apex_blocked_devices')||'[]');b=b.filter(d=>d!==id);localStorage.setItem('apex_blocked_devices',JSON.stringify(b));dbUnblockDevice(id).catch(e=>console.warn(e));}catch(e){}updateAllCounts();showToast('Device reinstated','success');renderWhitelist();}
function unblockEmail(email){try{let b=JSON.parse(localStorage.getItem('apex_blocked_emails')||'[]');b=b.filter(e=>e!==email);localStorage.setItem('apex_blocked_emails',JSON.stringify(b));dbUnblockEmail(email).catch(e=>console.warn(e));}catch(e){}updateAllCounts();showToast('Email reinstated','success');renderWhitelist();}
function manualBlockEmail(){const email=document.getElementById('wl-email').value.trim().toLowerCase();if(!email){showToast('Enter an email','warn');return;}try{let b=JSON.parse(localStorage.getItem('apex_blocked_emails')||'[]');if(!b.includes(email)){b.push(email);localStorage.setItem('apex_blocked_emails',JSON.stringify(b));}dbBlockEmail(email,null,'manual').catch(e=>console.warn(e));}catch(e){}updateAllCounts();showToast('Email blocked','success');renderWhitelist();}
function manualUnblockEmail(){const email=document.getElementById('wl-email').value.trim().toLowerCase();if(!email){showToast('Enter an email','warn');return;}unblockEmail(email);}

let _qRound=-1,_qData=null;
function renderQEditor(){
  document.getElementById('content').innerHTML=`
  <div class="hcard">
    <div class="hcard-title" style="flex-direction:column;align-items:flex-start;gap:5px"><span>✏️ Question Bank Editor</span><p style="font-size:10.5px;color:var(--text2);font-weight:400;line-height:1.65">Edit questions and options. Click ★ to mark the correct answer. Rounds 5 & 6 are auto-scored.</p></div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:1.1rem">
      ${['Situational Judgement','Logical Reasoning','Numerical Reasoning','Verbal Reasoning'].map((rn,ri)=>`<button class="fbtn" onclick="showREditor(${ri})" id="qe-tab-${ri}">${ri+1}. ${rn.split(' ')[0]}</button>`).join('')}
    </div>
    <div id="qe-body"><div style="text-align:center;padding:1.8rem;color:var(--muted);font-size:11px">Select a round to edit.</div></div>
    <div style="margin-top:.9rem;display:flex;gap:6px;flex-wrap:wrap">
      <button class="btn btn-amber" onclick="saveQEdits()">💾 Save Changes</button>
      <button class="btn btn-ghost" onclick="if(confirm('Reset to defaults?')){localStorage.removeItem('apex_custom_questions');showToast('Reset','success');}">↺ Reset</button>
    </div>
  </div>`;}

function showREditor(ri){
  _qRound=ri;
  document.querySelectorAll('[id^="qe-tab-"]').forEach(t=>t.classList.remove('on'));
  const tab=document.getElementById('qe-tab-'+ri);if(tab)tab.classList.add('on');
  let saved=null;try{const s=JSON.parse(localStorage.getItem('apex_custom_questions')||'null');if(s)saved=s[ri];}catch(e){}
  _qData=saved||(QUESTION_BANK[ri]?JSON.parse(JSON.stringify(QUESTION_BANK[ri])):{questions:[{text:'Edit this question text here.',opts:['Option A','Option B','Option C','Option D'],correct:0}]});
  _qData=JSON.parse(JSON.stringify(_qData));
  document.getElementById('qe-body').innerHTML=_qData.questions.map((q,qi)=>`
    <div class="q-editor-item">
      <div style="font-size:8.5px;font-weight:700;color:var(--amber);text-transform:uppercase;letter-spacing:.1em;margin-bottom:.4rem">Q${qi+1}</div>
      <textarea class="inp" id="qt-${qi}" style="width:100%;min-height:65px;font-size:11.5px;line-height:1.6;resize:vertical">${q.text}</textarea>
      ${q.opts.map((opt,oi)=>`<div class="q-opt-row"><span style="font-size:9px;font-weight:700;color:var(--amber);width:14px;flex-shrink:0;font-family:var(--fd)">${String.fromCharCode(65+oi)}</span><input class="inp" id="qo-${qi}-${oi}" value="${opt.replace(/"/g,'&quot;')}" style="flex:1;font-size:11px"><button class="btn ${q.correct===oi?'btn-amber':'btn-ghost'}" id="qcb-${qi}-${oi}" style="font-size:8px;padding:2px 6px;min-width:48px" onclick="setCorrect(${qi},${oi})">${q.correct===oi?'★ Correct':'☆'}</button></div>`).join('')}
    </div>`).join('')+`<button class="btn btn-ghost" style="font-size:9.5px;margin-top:.4rem" onclick="addNewQ()">+ Add Question</button>`;}

function setCorrect(qi,oi){if(!_qData||_qRound<0)return;_qData.questions[qi].correct=oi;showREditor(_qRound);}
function addNewQ(){if(!_qData||_qRound<0)return;_qData.questions.push({text:'New question',opts:['Option A','Option B','Option C','Option D'],correct:0});showREditor(_qRound);}
function saveQEdits(){
  if(_qRound<0){showToast('Select a round first','warn');return;}
  _qData.questions.forEach((q,qi)=>{const ta=document.getElementById('qt-'+qi);if(ta)q.text=ta.value;q.opts.forEach((_,oi)=>{const inp=document.getElementById('qo-'+qi+'-'+oi);if(inp)q.opts[oi]=inp.value;});});
  let saved={};try{saved=JSON.parse(localStorage.getItem('apex_custom_questions')||'{}');}catch(e){}
  saved[_qRound]=_qData;localStorage.setItem('apex_custom_questions',JSON.stringify(saved));
  saveCustomQuestions(_qRound,_qData).catch(e=>console.warn(e));
  showToast('✅ Saved Round '+(_qRound+1),'success');}

function openDetail(id){
  const c=getCands().find(x=>(x.id||x.email)===id);if(!c)return;
  const a=cAvg(c),viols=violationLog.filter(v=>v.candidateEmail===c.email);
  const ranked=getCands().filter(x=>x.completedRounds>=6).sort((a,b)=>cAvg(b)-cAvg(a));
  const rank=ranked.findIndex(x=>x.email===c.email)+1;
  const pct=ranked.length>0?Math.round((1-rank/ranked.length)*100):0;
  document.getElementById('detail-pan').innerHTML=`
    <div class="det-hdr">
      <div style="display:flex;align-items:center;gap:10px">
        <div class="avtr" style="width:42px;height:42px;font-size:13px;background:${avCol(0)}22;color:${avCol(0)}">${inits(c)}</div>
        <div><div style="font-family:var(--fd);font-size:15px;font-weight:700">${fullN(c)}</div><div style="font-size:10.5px;color:var(--text2)">${c.email||'—'}</div></div>
      </div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        ${c.hired?'<span class="pill pill-hired" style="font-size:10px;padding:3px 8px">✅ HIRED</span>':`<button class="btn-hire" onclick="hireCandidate('${c.id||c.email}')">✅ Hire</button>`}
        <button class="btn btn-amber" style="font-size:9.5px" onclick="showCert('${c.id||c.email}')">🏆 Cert</button>
        <button class="btn btn-ghost" style="padding:3px 8px;font-size:12px" onclick="closeDetail()">✕</button>
      </div>
    </div>
    <div class="det-body">
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:1.1rem">
        <div style="background:var(--card2);border-radius:8px;padding:.75rem;text-align:center"><div style="font-family:var(--fd);font-size:24px;font-weight:800;color:${scColor(a)}">${a}%</div><div style="font-size:8.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.1em">Score</div></div>
        <div style="background:var(--card2);border-radius:8px;padding:.75rem;text-align:center"><div style="font-family:var(--fd);font-size:24px;font-weight:800;color:var(--amber)">#${rank||'—'}</div><div style="font-size:8.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.1em">Rank · ${pct}th %ile</div></div>
        <div style="background:var(--card2);border-radius:8px;padding:.75rem;text-align:center"><div style="font-family:var(--fd);font-size:24px;font-weight:800;color:var(--blue)">${c.completedRounds||0}/6</div><div style="font-size:8.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.1em">Rounds Done</div></div>
      </div>
      <div style="font-size:9.5px;font-weight:700;color:var(--amber);text-transform:uppercase;letter-spacing:.1em;margin-bottom:.5rem">Round Scores</div>
      <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:4px;margin-bottom:1.1rem">
        ${RN.map((rn,ri)=>{const s=(c.scores||[])[ri];return`<div style="text-align:center;background:rgba(255,255,255,.025);border-radius:6px;padding:5px 3px;border:1px solid var(--border2)"><div style="font-size:7.5px;color:var(--muted);margin-bottom:1px">${RI[ri]} ${rn}</div><div style="font-size:12px;font-weight:700;color:${s!==undefined?scColor(s):'var(--muted)'}">${s!==undefined?s+'%':'—'}</div></div>`;}).join('')}
      </div>
      ${RN.map((rn,ri)=>{const s=(c.scores||[])[ri];return s!==undefined?`<div class="bar-row"><span class="bar-label">${rn}</span><div class="bar-track"><div class="bar-fill" style="width:${s}%;background:${scColor(s)}"></div></div><span class="bar-val" style="color:${scColor(s)}">${s}%</span></div>`:''}).join('')}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:1rem 0;font-size:11px">
        <div><span style="color:var(--muted)">College:</span> <strong>${c.college||'—'}</strong></div>
        <div><span style="color:var(--muted)">Passing Year:</span> <strong>${c.passYear||'—'}</strong></div>
        <div><span style="color:var(--muted)">Programme:</span> <strong>${c.prog||'—'}</strong></div>
        <div><span style="color:var(--muted)">Degree:</span> <strong>${c.deg||'—'}</strong></div>
        <div><span style="color:var(--muted)">Phone:</span> <strong>${c.phone||'—'}</strong></div>
        <div><span style="color:var(--muted)">Registered:</span> <strong>${fmtDate(c.registeredAt)}</strong></div>
        <div><span style="color:var(--muted)">Violations:</span> <strong style="color:${viols.length>0?'var(--red)':'var(--green)'}">${viols.length}</strong></div>
      </div>
      ${viols.length>0?`<div style="background:rgba(239,68,68,.05);border:1px solid rgba(239,68,68,.14);border-radius:7px;padding:.75rem;margin-bottom:1rem"><div style="font-size:9.5px;font-weight:700;color:var(--red);text-transform:uppercase;letter-spacing:.1em;margin-bottom:.4rem">⚠ Violations</div>${viols.map(v=>`<div style="font-size:10px;color:rgba(255,255,255,.4);margin-bottom:2px">· ${v.reason||'—'} (R${v.round||'?'} · ${v.time||'—'})</div>`).join('')}</div>`:''}
      ${c.rating||c.feedback?`<div style="background:rgba(212,168,67,.05);border:1px solid var(--border);border-radius:7px;padding:.75rem;margin-bottom:1rem"><div style="font-size:9.5px;font-weight:700;color:var(--amber);text-transform:uppercase;letter-spacing:.1em;margin-bottom:.4rem">⭐ Test Rating & Feedback</div>${c.rating?`<div style="font-size:15px;color:var(--amber);margin-bottom:4px">${'★'.repeat(c.rating)}${'☆'.repeat(5-c.rating)}</div>`:''}${c.feedback?`<div style="font-size:10.5px;color:rgba(255,255,255,.6);line-height:1.6">${c.feedback.replace(/</g,'&lt;')}</div>`:''}</div>`:''}
      <div style="font-size:9.5px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.1em;margin-bottom:.4rem">HR Status</div>
      <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:1rem">
        ${['shortlist','review','hold'].map(s=>`<button class="btn ${cStatus(c)===s?'btn-amber':'btn-ghost'}" style="font-size:8.5px" onclick="setStatus('${c.id||c.email}','${s}')">${sLabel(s)}</button>`).join('')}
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="btn btn-ghost" style="font-size:9.5px" onclick="sendCertEmail('${c.id||c.email}')">📧 Send Certificate</button>
        <button class="btn btn-ghost" style="font-size:9.5px" onclick="viewResume('${c.email}')">📄 Resume</button>
        ${loggedUser?.role==='admin'&&!c.hired?`<button class="btn btn-danger" style="font-size:8.5px" onclick="if(confirm('Delete?'))deleteCandidate('${c.id||c.email}')">🗑 Delete</button>`:''}
      </div>
    </div>`;
  document.getElementById('detail-ov').classList.add('open');}
function closeDetail(){document.getElementById('detail-ov').classList.remove('open');}
function viewResume(email){
  if(!email){showToast('No email on file for this candidate','warn');return;}
  showToast('Loading resume…','success');
  getResumeByEmail(email).then(r=>{
    if(r&&r.url)window.open(r.url,'_blank');
    else showToast('No resume uploaded for this candidate','warn');
  }).catch(e=>{console.warn('[Apex] resume fetch',e);showToast('Could not load resume','error');});
}
function deleteCandidate(id){
  const target=getCands().find(c=>(c.id||c.email)===id);
  const all=getCands().filter(c=>(c.id||c.email)!==id);saveCands(all);
  if(target&&target.email){
    const key=target.email.replace(/[.@]/g,'_');
    deletedSet.add(key);
    try{localStorage.setItem('apex_deleted_local',JSON.stringify([...deletedSet]));}catch(e){}
    softDeleteCandidate(target.email, loggedUser?.name||'HR').catch(e=>console.warn(e));
  }
  closeDetail();updateAllCounts();renderPage();showToast('Removed','warn');
}

function setStatus(id,val){const all=getCands();const idx=all.findIndex(c=>(c.id||c.email)===id);if(idx<0)return;all[idx].hrStatus=val;all[idx]._updated=Date.now();saveCands(all);setHrStatus(all[idx].email,val).catch(e=>console.warn(e));updateAllCounts();showToast('Status → '+sLabel(val),'success');}
function hireCandidate(id){const c=getCands().find(x=>(x.id||x.email)===id);if(!c)return;document.getElementById('hire-confirm-box').innerHTML=`<div style="font-size:40px;margin-bottom:.8rem">🎉</div><div style="font-family:var(--fd);font-size:17px;font-weight:700;margin-bottom:.3rem;color:var(--green)">Confirm Hire</div><div style="font-size:11.5px;color:var(--text2);margin-bottom:1.3rem;line-height:1.7">Mark <strong style="color:var(--text)">${fullN(c)}</strong> as <strong style="color:var(--green)">HIRED</strong> for <strong>${c.prog||'MT'}</strong>.<br>An offer email will be sent to <strong style="color:var(--amber)">${c.email}</strong>.</div><div style="display:flex;gap:8px;justify-content:center"><button class="btn btn-ghost" onclick="closeHireConfirm()">Cancel</button><button class="btn-hire" onclick="confirmHire('${id}')">✅ Confirm</button></div>`;document.getElementById('hire-overlay').classList.add('open');}
function confirmHire(id){const all=getCands();const idx=all.findIndex(c=>(c.id||c.email)===id);if(idx<0)return;all[idx].hired=true;all[idx].hrStatus='hired';all[idx].hiredAt=new Date().toISOString();all[idx].hiredBy=loggedUser?.name||'HR';all[idx]._updated=Date.now();saveCands(all);hireCandidateDb(all[idx].email,all[idx].hiredBy).catch(e=>console.warn(e));sendOfferEmail(all[idx]);closeHireConfirm();closeDetail();updateAllCounts();showToast('🎉 '+fullN(all[idx])+' hired!','success');renderPage();}
function closeHireConfirm(){document.getElementById('hire-overlay').classList.remove('open');}
async function sendOfferEmail(c){const name=fullN(c);if(!c.email)return;const body=`Dear ${name},

Congratulations! We are pleased to offer you a position as a Management Trainee for the ${c.prog||'MT Programme'}.

Your assessment performance has impressed our team.

Please contact HR to confirm acceptance within 5 business days.

Best regards,
Recruitment Team`;try{await sendMail('offer',{to:c.email,name,college:c.college||'',programme:c.prog||'MT'});showToast('📧 Offer sent to '+c.email,'success');return;}catch(e){console.warn('[Apex] offer email failed:',e&&e.message);}showEmailModal(c,body);}
function showEmailModal(c,body){document.getElementById('email-modal-body').innerHTML=`<div style="margin-bottom:.8rem;font-size:11px;color:var(--text2)">To: <strong>${c.email}</strong></div><div style="font-size:10px;color:var(--orange);background:rgba(245,158,11,.05);border:1px solid rgba(245,158,11,.17);border-radius:6px;padding:8px;margin-bottom:.8rem">⚠ Send failed. Copy and send manually.</div><textarea class="inp" style="width:100%;min-height:160px;font-size:11px;line-height:1.7;resize:vertical" id="email-body-ta">${body}</textarea><div style="display:flex;gap:6px;margin-top:.8rem;flex-wrap:wrap"><button class="btn btn-amber" onclick="copyEmailBody()">📋 Copy</button><a class="btn btn-ghost" href="mailto:${c.email}?subject=Management Trainee Offer&body=${encodeURIComponent(body)}" style="display:flex;align-items:center">📧 Open in Mail</a><button class="btn btn-ghost" onclick="closeEmailModal()">Close</button></div>`;document.getElementById('email-modal').classList.add('open');}
function copyEmailBody(){const ta=document.getElementById('email-body-ta');if(ta)navigator.clipboard.writeText(ta.value).then(()=>showToast('Copied!','success'));}
function closeEmailModal(){document.getElementById('email-modal').classList.remove('open');}

function renderCerts(){const cands=getCands().filter(c=>c.completedRounds>=6).sort((a,b)=>cAvg(b)-cAvg(a));document.getElementById('content').innerHTML=`<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.9rem;flex-wrap:wrap;gap:7px"><div style="font-size:11.5px;color:var(--text2)">${cands.length} completed</div><button class="btn btn-amber" style="font-size:9.5px" onclick="sendAllCerts()">📧 Send All</button></div><div class="hcard" style="padding:0"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Candidate</th><th>College</th><th>Score</th><th>Status</th><th>Grade</th><th>Actions</th></tr></thead><tbody>${cands.length===0?'<tr><td colspan="6" style="text-align:center;padding:2rem;color:var(--muted)">No completed candidates</td></tr>':''}${cands.map((c,i)=>{const a=cAvg(c),st=cStatus(c);const grade=a>=90?'🎯 Top Performer':a>=80?'⭐ Excellence':a>=65?'🏆 Achievement':'🎓 Participation';return`<tr><td><div style="display:flex;align-items:center;gap:6px"><div class="avtr" style="width:24px;height:24px;font-size:8.5px;background:${avCol(i)}22;color:${avCol(i)}">${inits(c)}</div><div><div style="font-weight:600;font-size:11px">${fullN(c)}</div><div style="font-size:9px;color:var(--muted)">${c.email||''}</div></div></div></td><td style="font-size:10.5px;color:var(--text2)">${c.college||'—'}</td><td><span class="pill ${scClass(a)}">${a}%</span></td><td><span class="pill ${sClass(st)}">${sLabel(st)}</span></td><td style="font-size:10px">${grade}</td><td><div style="display:flex;gap:3px"><button class="btn btn-amber" style="font-size:8px;padding:2px 6px" onclick="showCert('${c.id||c.email}')">👁</button><button class="btn btn-ghost" style="font-size:8px;padding:2px 6px" onclick="sendCertEmail('${c.id||c.email}')">📧</button></div></td></tr>`;}).join('')}</tbody></table></div></div>`;}
function showCert(id){const c=getCands().find(x=>(x.id||x.email)===id);if(!c)return;const a=cAvg(c);document.getElementById('c-name').textContent=fullN(c);document.getElementById('c-detail').innerHTML='Programme: <strong style="color:var(--amber)">'+(c.prog||'—')+'</strong> &nbsp;|&nbsp; College: <strong>'+(c.college||'—')+'</strong> &nbsp;|&nbsp; Date: <strong>'+fmtDate(c.submittedAt||c._updated)+'</strong>';document.getElementById('c-ring').style.setProperty('--p',Math.min(a,100));document.getElementById('c-score').textContent=a+'%';document.getElementById('c-id').textContent=c.certId||'CERT-'+Date.now().toString(36).toUpperCase();document.getElementById('c-status').textContent=a>=80?'EXCELLENCE':a>=65?'ACHIEVEMENT':'PARTICIPATION';document.getElementById('c-rounds').innerHTML=RN.map((rn,i)=>(c.scores||[])[i]!==undefined?'<span style="background:rgba(34,197,94,.09);border:1px solid rgba(34,197,94,.17);border-radius:100px;padding:2px 7px;font-size:8px;color:var(--green)">'+rn+' ✓</span>':'').join('');document.getElementById('cert-overlay').classList.add('open');}
function closeCert(){document.getElementById('cert-overlay').classList.remove('open');}
async function sendCertEmail(id){
  const c=getCands().find(x=>(x.id||x.email)===id);
  if(!c||!c.email){showToast('No email on file','warn');return;}
  showToast('📧 Sending certificate…','success');
  try{
    const a=cAvg(c);
    const statusText=a>=80?'EXCELLENCE':a>=65?'ACHIEVEMENT':'PARTICIPATION';
    const certId=c.certId||('CERT-'+Date.now().toString(36).toUpperCase());
    const certImageBase64=renderCertificatePNG({name:fullN(c),programme:c.prog||'MT',college:c.college||'—',statusText,certId});
    await sendMail('confirmation',{to:c.email,name:fullN(c),college:c.college||'',programme:c.prog||'MT',certId,certImageBase64});
    showToast('✅ Certificate sent to '+c.email,'success');
  }catch(e){console.warn('[Apex] cert email failed:',e&&e.message);showToast('Certificate send failed','error');}
}
function sendAllCerts(){const c=getCands().filter(x=>x.completedRounds>=6);c.forEach(x=>sendCertEmail(x.id||x.email));showToast('📧 Sending '+c.length+' certificates…','success');}

function renderSettings(){const all=getCands();document.getElementById('content').innerHTML=`<div class="grid2"><div class="hcard"><div class="hcard-title">🗄 Database Status</div>${[['Records',all.length],['Supabase',dbReady?'Connected':'Offline'],['Completed',all.filter(c=>c.completedRounds>=6).length],['Active',all.filter(c=>c.status==='in_progress').length],['Hired',all.filter(c=>c.hired).length]].map(([l,v])=>`<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border2);font-size:11px"><span style="color:var(--text2)">${l}</span><strong>${v}</strong></div>`).join('')}<div style="display:flex;gap:6px;margin-top:.85rem;flex-wrap:wrap"><button class="btn btn-amber" style="font-size:9.5px" onclick="exportCSV()">⬇ CSV</button><button class="btn btn-ghost" style="font-size:9.5px" onclick="refreshAll()">⟳ Sync</button><button class="btn btn-danger" style="font-size:9.5px" onclick="if(confirm('Delete ALL data?'))clearDB()">🗑 Clear</button></div></div><div class="hcard"><div class="hcard-title">➕ Add Manually</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px"><div><label style="font-size:8.5px;color:var(--text2);display:block;margin-bottom:2px">First Name</label><input class="inp" id="m-fn" placeholder="First" style="width:100%"></div><div><label style="font-size:8.5px;color:var(--text2);display:block;margin-bottom:2px">Last Name</label><input class="inp" id="m-ln" placeholder="Last" style="width:100%"></div></div><div style="margin-bottom:6px"><label style="font-size:8.5px;color:var(--text2);display:block;margin-bottom:2px">Email</label><input class="inp" id="m-em" placeholder="email@college.edu" style="width:100%"></div><div style="margin-bottom:6px"><label style="font-size:8.5px;color:var(--text2);display:block;margin-bottom:2px">College</label><input class="inp" id="m-co" placeholder="College name" style="width:100%"></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px"><div><label style="font-size:8.5px;color:var(--text2);display:block;margin-bottom:2px">Scores (comma)</label><input class="inp" id="m-sc" placeholder="82,79,88,75,80,83" style="width:100%"></div><div><label style="font-size:8.5px;color:var(--text2);display:block;margin-bottom:2px">Programme</label><select class="inp" id="m-pr" style="width:100%"><option value="6mt">6-Month MT</option><option value="3mt">3-Month MT</option></select></div></div><button class="btn btn-amber" style="font-size:9.5px" onclick="addManualCand()">Add</button></div></div><div class="hcard"><div class="hcard-title">🔌 Supabase + Email Setup</div><div style="font-size:11px;color:var(--text2);line-height:1.9;margin-bottom:.8rem">Set <code style="background:rgba(255,255,255,.06);padding:1px 4px;border-radius:3px;font-size:10px">VITE_SUPABASE_URL</code> / <code style="background:rgba(255,255,255,.06);padding:1px 4px;border-radius:3px;font-size:10px">VITE_SUPABASE_ANON_KEY</code> in <code style="background:rgba(255,255,255,.06);padding:1px 4px;border-radius:3px;font-size:10px">.env</code>, then deploy the <code style="background:rgba(255,255,255,.06);padding:1px 4px;border-radius:3px;font-size:10px">send-email</code> Edge Function with a Resend API key.</div><div style="background:rgba(212,168,67,.05);border:1px solid var(--border);border-radius:8px;padding:11px;font-size:11px;color:var(--text2);line-height:2"><strong style="color:var(--amber)">1</strong> — Supabase project → run <code style="background:rgba(255,255,255,.05);padding:1px 4px;border-radius:3px;font-size:9.5px">sql/relational-schema.sql</code> in the SQL Editor<br><strong style="color:var(--amber)">2</strong> — <code style="background:rgba(255,255,255,.05);padding:1px 4px;border-radius:3px;font-size:9.5px">npx supabase functions deploy send-email</code><br><strong style="color:var(--amber)">3</strong> — <code style="background:rgba(255,255,255,.05);padding:1px 4px;border-radius:3px;font-size:9.5px">npx supabase secrets set RESEND_API_KEY=... MAIL_FROM=...</code><br><strong style="color:var(--amber)">4</strong> — Host on Netlify (already configured in <code style="background:rgba(255,255,255,.05);padding:1px 4px;border-radius:3px;font-size:9.5px">netlify.toml</code>)</div><div style="margin-top:.8rem;background:rgba(59,130,246,.04);border:1px solid rgba(59,130,246,.17);border-radius:7px;padding:10px;font-size:11px;color:var(--text2)"><strong style="color:var(--blue)">Credentials:</strong> Edit CREDENTIALS array · Default: <code style="background:rgba(255,255,255,.05);padding:1px 4px;border-radius:3px;font-size:9.5px">apex_admin / Admin@2026!</code></div></div>`;}

function addManualCand(){const fn=document.getElementById('m-fn').value.trim(),ln=document.getElementById('m-ln').value.trim(),em=document.getElementById('m-em').value.trim().toLowerCase(),co=document.getElementById('m-co').value.trim();if(!fn||!ln||!em){showToast('Fill required fields','warn');return;}const scStr=document.getElementById('m-sc').value;const scores=scStr.split(',').map(s=>parseInt(s.trim())).filter(s=>!isNaN(s));const pr=document.getElementById('m-pr').value;const rec={fname:fn,lname:ln,email:em,college:co,progKey:pr,prog:pr==='6mt'?'6-Month MT':'3-Month MT',scores,completedRounds:scores.length,status:scores.length>=6?'completed':'in_progress',registeredAt:new Date().toISOString(),_created:Date.now()};const all=getCands();const idx=all.findIndex(c=>c.email===em);if(idx>=0)all[idx]={...all[idx],...rec};else all.push({...rec,id:'C'+Date.now().toString(36).toUpperCase()});saveCands(all);updateAllCounts();showToast('✅ Candidate added','success');renderSettings();}
function clearDB(){saveCands([]);updateAllCounts();renderPage();showToast('Database cleared','warn');}
function exportCSV(){const all=getCands();if(!all.length){showToast('No data','warn');return;}const hdrs=['Name','Email','College','Programme',...RN,'Avg','Status','Violations','Hired','Registered'];const rows=all.map(c=>{const viols=violationLog.filter(v=>v.candidateEmail===c.email).length;const scores=RN.map((_,i)=>(c.scores||[])[i]!==undefined?(c.scores||[])[i]+'%':'');return[fullN(c),c.email||'',c.college||'',c.prog||'',...scores,cAvg(c)+'%',cStatus(c),viols,c.hired?'Yes':'',c.registeredAt?new Date(c.registeredAt).toLocaleDateString():''];});const csv=[hdrs,...rows].map(r=>r.map(v=>'"'+String(v).replace(/"/g,"''")+'"').join(',')).join('\n');const a=document.createElement('a');a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);a.download='apex_candidates_'+new Date().toISOString().slice(0,10)+'.csv';a.click();showToast('✅ CSV exported','success');}
function refreshAll(){refreshCandidatesFromDb().then(()=>{renderPage();showToast('Synced','success');}).catch(()=>showToast('Sync failed — check relational schema','warn'));}

// ═══════════════════════════════════════════════════════════
// BULK INVITE — Excel upload → extract emails → send assessment link
// ═══════════════════════════════════════════════════════════
let _inviteEmails=[],_inviteResults=[];
// Assessment always lives at the site root (/, index.html) — never assessment.html
const ASSESSMENT_URL = new URL('/', window.location.href).href;

function renderBulkInvite(){
  document.getElementById('content').innerHTML=`
  <div class="hcard">
    <div class="hcard-title" style="flex-direction:column;align-items:flex-start;gap:5px">
      <span>📨 Bulk Invite via Excel</span>
      <p style="font-size:10.5px;color:var(--text2);font-weight:400;line-height:1.65">Upload any Excel or CSV file. The system will scan every column for email addresses, preview the list, let you edit it, then send the assessment link to all of them.</p>
    </div>

    <!-- STEP 1: Upload -->
    <div id="bi-step1">
      <div style="border:2px dashed rgba(212,168,67,.25);border-radius:10px;padding:2.5rem 1.5rem;text-align:center;cursor:pointer;transition:all .2s;background:rgba(212,168,67,.025)" id="bi-dropzone"
        ondragover="event.preventDefault();this.style.borderColor='var(--amber)'"
        ondragleave="this.style.borderColor='rgba(212,168,67,.25)'"
        ondrop="biHandleDrop(event)"
        onclick="document.getElementById('bi-file-input').click()">
        <div style="font-size:44px;margin-bottom:.7rem">📊</div>
        <div style="font-family:var(--fd);font-size:14px;font-weight:700;margin-bottom:.3rem">Drop Excel or CSV here</div>
        <div style="font-size:11px;color:var(--muted)">Supports .xlsx · .xls · .csv — any column layout. Emails are auto-detected.</div>
        <div style="margin-top:1rem">
          <button class="btn btn-amber" style="font-size:10.5px" onclick="event.stopPropagation();document.getElementById('bi-file-input').click()">Browse File</button>
        </div>
      </div>
      <input type="file" id="bi-file-input" accept=".xlsx,.xls,.csv" style="display:none" onchange="biHandleFile(this.files[0])">
    </div>

    <!-- STEP 2: Preview & Edit -->
    <div id="bi-step2" style="display:none">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:.8rem;flex-wrap:wrap;gap:7px">
        <div style="font-size:11px;color:var(--text2)">
          Found <strong id="bi-count" style="color:var(--amber)">0</strong> email address(es) from file: <strong id="bi-filename" style="color:var(--text)"></strong>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="btn btn-ghost" style="font-size:9.5px" onclick="biReset()">↺ Upload Different File</button>
          <button class="btn btn-ghost" style="font-size:9.5px" onclick="biAddManual()">+ Add Email</button>
        </div>
      </div>

      <!-- Email list editor -->
      <div style="background:var(--card2);border:1px solid var(--border2);border-radius:8px;padding:.75rem;margin-bottom:.9rem;max-height:320px;overflow-y:auto" id="bi-email-list"></div>

      <!-- Assessment link preview -->
      <div style="background:rgba(59,130,246,.04);border:1px solid rgba(59,130,246,.15);border-radius:8px;padding:.85rem;margin-bottom:.9rem">
        <div style="font-size:9.5px;font-weight:700;color:var(--blue);text-transform:uppercase;letter-spacing:.1em;margin-bottom:.4rem">📎 Assessment Link</div>
        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <code style="background:rgba(255,255,255,.04);border:1px solid var(--border2);border-radius:5px;padding:5px 9px;font-size:10.5px;color:var(--text);flex:1;word-break:break-all" id="bi-link-preview"></code>
          <button class="btn btn-ghost" style="font-size:9px" onclick="biCopyLink()">📋 Copy</button>
        </div>
        <div style="margin-top:.6rem">
          <input class="inp" id="bi-custom-link" placeholder="Override link (optional)" style="width:100%;font-size:11px" oninput="document.getElementById('bi-link-preview').textContent=this.value||ASSESSMENT_URL">
        </div>
      </div>

      <!-- Email template -->
      <div style="background:rgba(212,168,67,.04);border:1px solid var(--border);border-radius:8px;padding:.85rem;margin-bottom:.9rem">
        <div style="font-size:9.5px;font-weight:700;color:var(--amber);text-transform:uppercase;letter-spacing:.1em;margin-bottom:.5rem">✉ Email Template</div>
        <div style="margin-bottom:.5rem">
          <label style="font-size:9px;color:var(--text2);display:block;margin-bottom:3px">Subject</label>
          <input class="inp" id="bi-subject" value="Invitation: Management Trainee Assessment" style="width:100%;font-size:11px">
        </div>
        <div>
          <label style="font-size:9px;color:var(--text2);display:block;margin-bottom:3px">Body <span style="color:var(--muted)">(use {link} for the assessment URL, {email} for recipient email)</span></label>
          <textarea class="inp" id="bi-body" rows="7" style="width:100%;font-size:11px;line-height:1.7;resize:vertical">Dear Candidate,

You have been shortlisted to appear for the Management Trainee Assessment.

Please click the link below to begin your assessment:
{link}

The assessment consists of 6 rounds and takes approximately 58 minutes. Ensure you are in a quiet environment with a stable internet connection before starting.

This link is unique to your application. Do not share it.

Best regards,
Recruitment Team</textarea>
        </div>
      </div>

      <!-- Action buttons -->
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <button class="btn-hire" id="bi-send-btn" onclick="biSendAll()">
          <span id="bi-send-icon">📧</span> Send to <span id="bi-send-count">0</span> Candidate(s)
        </button>
        <button class="btn btn-ghost" style="font-size:9.5px" onclick="biCopyAll()">📋 Copy All Emails</button>
        <button class="btn btn-ghost" style="font-size:9.5px" onclick="biDownloadCSV()">⬇ Download List</button>
      </div>
    </div>

    <!-- STEP 3: Results -->
    <div id="bi-step3" style="display:none">
      <div style="text-align:center;padding:1.5rem 0">
        <div style="font-size:48px;margin-bottom:.7rem">📬</div>
        <div style="font-family:var(--fd);font-size:16px;font-weight:700;margin-bottom:.35rem" id="bi-result-title">Invitations Sent</div>
        <div style="font-size:11px;color:var(--text2);margin-bottom:1.2rem" id="bi-result-sub"></div>
      </div>
      <div id="bi-result-list" style="max-height:320px;overflow-y:auto"></div>
      <div style="display:flex;gap:7px;margin-top:1rem;flex-wrap:wrap">
        <button class="btn btn-amber" style="font-size:10px" onclick="biReset()">📨 Send Another Batch</button>
        <button class="btn btn-ghost" style="font-size:10px" onclick="biDownloadReport()">⬇ Download Report</button>
      </div>
    </div>
  </div>`;

  // Set link preview
  const linkEl=document.getElementById('bi-link-preview');
  if(linkEl) linkEl.textContent=ASSESSMENT_URL;
}

function biHandleDrop(e){
  e.preventDefault();
  document.getElementById('bi-dropzone').style.borderColor='rgba(212,168,67,.25)';
  const file=e.dataTransfer.files[0];
  if(file) biHandleFile(file);
}

function biHandleFile(file){
  if(!file) return;
  const name=file.name.toLowerCase();
  const isCSV=name.endsWith('.csv');
  const isXLS=name.endsWith('.xlsx')||name.endsWith('.xls');
  if(!isCSV&&!isXLS){showToast('Please upload .xlsx, .xls, or .csv','warn');return;}

  document.getElementById('bi-filename').textContent=file.name;
  const reader=new FileReader();
  reader.onload=function(ev){
    try{
      let allText='';
      if(isCSV){
        allText=ev.target.result;
      } else {
        const data=new Uint8Array(ev.target.result);
        const wb=XLSX.read(data,{type:'array'});
        // Collect all cell values across all sheets
        wb.SheetNames.forEach(sheetName=>{
          const ws=wb.Sheets[sheetName];
          const rows=XLSX.utils.sheet_to_csv(ws);
          allText+=rows+'\n';
        });
      }
      // Extract all email addresses using regex
      const emailRegex=/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
      const found=[...new Set(allText.match(emailRegex)||[])];
      // Filter out obvious non-person emails
      const filtered=found.filter(e=>!/@example\.com$/i.test(e)&&!/^test@/i.test(e)&&!/@noreply/i.test(e));
      _inviteEmails=[...filtered];
      biShowStep2();
    } catch(err){
      showToast('Error reading file: '+err.message,'error');
    }
  };
  if(isCSV) reader.readAsText(file);
  else reader.readAsArrayBuffer(file);
}

function biShowStep2(){
  document.getElementById('bi-step1').style.display='none';
  document.getElementById('bi-step2').style.display='block';
  document.getElementById('bi-step3').style.display='none';
  document.getElementById('bi-count').textContent=_inviteEmails.length;
  document.getElementById('bi-send-count').textContent=_inviteEmails.length;
  biRenderEmailList();
}

function biRenderEmailList(){
  const el=document.getElementById('bi-email-list');
  if(!el) return;
  if(_inviteEmails.length===0){
    el.innerHTML='<div style="text-align:center;padding:1.2rem;color:var(--muted);font-size:11px">No emails found. Try adding manually.</div>';
    return;
  }
  el.innerHTML=_inviteEmails.map((email,i)=>`
    <div style="display:flex;align-items:center;gap:7px;padding:6px 4px;border-bottom:1px solid rgba(255,255,255,.04)" id="bi-row-${i}">
      <span style="font-size:11px;color:var(--green);width:16px;flex-shrink:0">✓</span>
      <input class="inp" value="${email}" id="bi-email-${i}" style="flex:1;font-size:11px;padding:4px 8px"
        onchange="_inviteEmails[${i}]=this.value;biSyncCount()">
      <button onclick="biRemoveEmail(${i})" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:13px;padding:2px 4px">✕</button>
    </div>`).join('');
  biSyncCount();
}

function biSyncCount(){
  const c=_inviteEmails.filter(e=>e&&e.includes('@')).length;
  const el=document.getElementById('bi-count');if(el)el.textContent=c;
  const s=document.getElementById('bi-send-count');if(s)s.textContent=c;
}

function biRemoveEmail(i){
  _inviteEmails.splice(i,1);
  biRenderEmailList();
  document.getElementById('bi-count').textContent=_inviteEmails.length;
  document.getElementById('bi-send-count').textContent=_inviteEmails.length;
}

function biAddManual(){
  const email=prompt('Enter email address:');
  if(email&&email.includes('@')){
    _inviteEmails.push(email.trim().toLowerCase());
    biShowStep2();
    showToast('Email added','success');
  }
}

function biCopyLink(){
  const link=document.getElementById('bi-link-preview').textContent||ASSESSMENT_URL;
  navigator.clipboard.writeText(link).then(()=>showToast('Link copied!','success'));
}

function biCopyAll(){
  const emails=_inviteEmails.filter(e=>e&&e.includes('@'));
  navigator.clipboard.writeText(emails.join('\n')).then(()=>showToast('All emails copied!','success'));
}

function biDownloadCSV(){
  const emails=_inviteEmails.filter(e=>e&&e.includes('@'));
  const csv='Email\n'+emails.join('\n');
  const a=document.createElement('a');
  a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download='invite_list_'+new Date().toISOString().slice(0,10)+'.csv';
  a.click();
}

async function biSendAll(){
  const emails=_inviteEmails.filter(e=>e&&e.includes('@'));
  if(emails.length===0){showToast('No valid emails to send','warn');return;}
  const link=document.getElementById('bi-link-preview').textContent||ASSESSMENT_URL;
  const subject=document.getElementById('bi-subject').value||'Assessment Invitation';
  const bodyTemplate=document.getElementById('bi-body').value||'Assessment link: {link}';
  const btn=document.getElementById('bi-send-btn');
  if(btn){btn.style.opacity='.5';btn.style.pointerEvents='none';}
  _inviteResults=[];
  let sent=0,failed=0;
  // Show progress
  showToast('Sending '+emails.length+' invitations…','success');

  for(let i=0;i<emails.length;i++){
    const email=emails[i];
    const body=bodyTemplate.replace(/\{link\}/g,link).replace(/\{email\}/g,email);
    let success=false,errMsg='';
    try{
      await sendMail('invite',{to:email,link,subject,body});
      success=true;sent++;
    }catch(err){failed++;errMsg=String(err&&err.message||err).slice(0,140);console.warn('[Apex] invite email failed for',email,errMsg);}
    _inviteResults.push({email,success,body,subject,err:errMsg});
    // Small delay between sends to be a good citizen toward the email provider's rate limits
    if(i<emails.length-1) await new Promise(r=>setTimeout(r,300));
  }

  if(btn){btn.style.opacity='';btn.style.pointerEvents='';}
  biShowResults(link,subject,bodyTemplate);
}

function biShowResults(link,subject,bodyTemplate){
  document.getElementById('bi-step1').style.display='none';
  document.getElementById('bi-step2').style.display='none';
  document.getElementById('bi-step3').style.display='block';
  const sent=_inviteResults.filter(r=>r.success===true).length;
  const total=_inviteResults.length;
  document.getElementById('bi-result-title').textContent=`${sent}/${total} Invitations Sent`;
  document.getElementById('bi-result-sub').textContent=`Delivered ${sent} of ${total} emails. ${total-sent>0?(total-sent)+' failed — use the mailto links below to send those manually.':''}`;
  const listEl=document.getElementById('bi-result-list');
  listEl.innerHTML=_inviteResults.map((r,i)=>{
    const statusIcon=r.success===true?'✅':r.success===false?'❌':'📋';
    const statusColor=r.success===true?'var(--green)':r.success===false?'var(--red)':'var(--amber)';
    const statusLabel=r.success===true?'Sent':r.success===false?'Failed':'Manual';
    const mailtoLink=`mailto:${r.email}?subject=${encodeURIComponent(r.subject)}&body=${encodeURIComponent(r.body)}`;
    return`<div style="display:flex;align-items:center;gap:8px;padding:8px 6px;border-bottom:1px solid rgba(255,255,255,.04);flex-wrap:wrap">
      <span style="font-size:14px">${statusIcon}</span>
      <span style="font-size:11px;flex:1;word-break:break-all">${r.email}${r.success===false&&r.err?`<div style="font-size:8.5px;color:var(--red);opacity:.85;margin-top:2px">${(r.err||'').replace(/</g,'&lt;')}</div>`:''}</span>
      <span style="font-size:9px;font-weight:700;color:${statusColor}">${statusLabel}</span>
      ${r.success!==true?`<a href="${mailtoLink}" style="background:rgba(255,255,255,.05);border:1px solid var(--border2);border-radius:4px;padding:2px 7px;font-size:8.5px;color:var(--amber);text-decoration:none">📧 Open in Mail</a>`:''}
    </div>`;}).join('');
}

function biDownloadReport(){
  if(!_inviteResults.length){showToast('No results yet','warn');return;}
  const rows=_inviteResults.map(r=>`"${r.email}","${r.success===true?'Sent':r.success===false?'Failed':'Manual'}"`);
  const csv='Email,Status\n'+rows.join('\n');
  const a=document.createElement('a');
  a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download='invite_report_'+new Date().toISOString().slice(0,10)+'.csv';
  a.click();
}

function biReset(){
  _inviteEmails=[];_inviteResults=[];
  document.getElementById('bi-step1').style.display='block';
  document.getElementById('bi-step2').style.display='none';
  document.getElementById('bi-step3').style.display='none';
  const fi=document.getElementById('bi-file-input');if(fi)fi.value='';
}


function showToast(msg,type){const el=document.getElementById('toast');const c={success:'rgba(34,197,94,.95)',warn:'rgba(234,179,8,.95)',error:'rgba(239,68,68,.95)'};el.style.background=c[type]||c.success;el.textContent=msg;el.style.display='block';clearTimeout(el._t);el._t=setTimeout(()=>el.style.display='none',3000);}

// ═══════════════════════════════════════════════════════════
// HIRING CALENDAR (year/month view of college schedules)
// ═══════════════════════════════════════════════════════════
const CAL_MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
const CAL_MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const CAL_DOW=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function calEsc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function calEvents(){
  const data=_collegesData();
  return Object.keys(data).map(id=>{const c=data[id]||{};return{id,name:c.name||id,start:_collegeMs(c.startTime),expire:_collegeMs(c.expireTime),cfg:c,status:_collegeStatus(c),registered:getCands().filter(x=>x.collegeId===id).length};});
}
function calDayMid(ms){const d=new Date(ms);return new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime();}
function calPrevMonth(){if(calMonth===0){calMonth=11;calYear--;}else calMonth--;renderCalendar();}
function calNextMonth(){if(calMonth===11){calMonth=0;calYear++;}else calMonth++;renderCalendar();}
function calToday(){const n=new Date();calMonth=n.getMonth();calYear=n.getFullYear();renderCalendar();}
function calGoMonth(m){calMonth=m;renderCalendar();}
function calYearShift(d){calYear+=d;renderCalendar();}
function calSetView(v){calView=v;renderCalendar();}
function calOpenMonth(y,m){calYear=y;calMonth=m;calView='month';renderCalendar();}
function buildMiniMonth(year,m,evs,todayMid){
  const byDay={};let cnt=0;
  evs.forEach(e=>{if(!e.start)return;const sd=new Date(e.start);if(sd.getFullYear()===year&&sd.getMonth()===m){(byDay[sd.getDate()]=byDay[sd.getDate()]||[]).push(e);cnt++;}});
  const firstDow=new Date(year,m,1).getDay(),dim=new Date(year,m+1,0).getDate();
  let cells='';
  for(let i=0;i<firstDow;i++)cells+='<div class="cal-mini-day empty"></div>';
  for(let d=1;d<=dim;d++){
    const dayMid=new Date(year,m,d).getTime();
    const isToday=dayMid===todayMid;
    const dayEvs=byDay[d]||[];
    const inWin=!dayEvs.length&&evs.some(e=>e.start&&dayMid>=calDayMid(e.start)&&dayMid<=(e.expire||e.start));
    const cls=['cal-mini-day'];if(dayEvs.length)cls.push('ev');else if(inWin)cls.push('win');if(isToday)cls.push('today');
    const title=dayEvs.length?dayEvs.map(e=>calEsc(e.name)+' \u00B7 '+e.status.label).join(' | '):'';
    cells+=`<div class="${cls.join(' ')}" ${dayEvs.length?`onclick="calOpenMonth(${year},${m})"`:''} title="${title}">${d}</div>`;
  }
  return `<div class="cal-ymon">
    <div class="cal-ymon-h" onclick="calOpenMonth(${year},${m})"><span class="nm">${CAL_MONTHS[m]}</span><span class="ct ${cnt?'':'zero'}">${cnt?cnt+(cnt>1?' events':' event'):'\u2014'}</span></div>
    <div class="cal-mini-dow">${['S','M','T','W','T','F','S'].map(x=>'<span>'+x+'</span>').join('')}</div>
    <div class="cal-mini-days">${cells}</div>
  </div>`;
}
function renderCalendar(){
  const evs=calEvents();
  const now=new Date(),todayMid=new Date(now.getFullYear(),now.getMonth(),now.getDate()).getTime();
  const counts=new Array(12).fill(0);
  evs.forEach(e=>{if(e.start){const sd=new Date(e.start);if(sd.getFullYear()===calYear)counts[sd.getMonth()]++;}});
  const yearTotal=counts.reduce((a,b)=>a+b,0);
  const fmtRange=e=>_fmtDT(e.start)+(e.expire?' \u2192 '+_fmtDT(e.expire):'');
  const upcoming=evs.filter(e=>e.start&&(e.expire?e.expire>=todayMid:e.start>=todayMid)).sort((a,b)=>a.start-b.start);
  const scheduled=evs.filter(e=>e.start).sort((a,b)=>a.start-b.start);
  const unscheduled=evs.filter(e=>!e.start);
  const listRow=e=>`<div class="hcard" style="display:flex;align-items:center;gap:10px;margin-bottom:7px;cursor:pointer;padding:.7rem .85rem" onclick="navTo('colleges')">
      <div style="text-align:center;min-width:46px"><div style="font-family:var(--fd);font-size:18px;font-weight:800;color:var(--amber);line-height:1">${e.start?new Date(e.start).getDate():'--'}</div><div style="font-size:8.5px;color:var(--muted);text-transform:uppercase">${e.start?CAL_MON[new Date(e.start).getMonth()]+' '+new Date(e.start).getFullYear():''}</div></div>
      <div style="flex:1;min-width:0"><div style="font-weight:700;font-size:12px">${calEsc(e.name)}</div><div style="font-size:9.5px;color:var(--muted)">${e.start?fmtRange(e):'No date set'} \u00B7 ${e.registered} registered</div></div>
      <span class="pill" style="background:${e.status.color}1a;color:${e.status.color};border:1px solid ${e.status.color}55;font-size:9px;padding:3px 8px;white-space:nowrap">${e.status.label}</span>
    </div>`;
  let mainPanel='';
  if(calView==='year'){
    mainPanel=`<div class="cal-yeargrid">${Array.from({length:12},(_,m)=>buildMiniMonth(calYear,m,evs,todayMid)).join('')}</div>`;
  }else{
    const byDay={};
    evs.forEach(e=>{if(!e.start)return;const sd=new Date(e.start);if(sd.getFullYear()===calYear&&sd.getMonth()===calMonth){(byDay[sd.getDate()]=byDay[sd.getDate()]||[]).push(e);}});
    const firstDow=new Date(calYear,calMonth,1).getDay(),dim=new Date(calYear,calMonth+1,0).getDate();
    let cells='';
    for(let i=0;i<firstDow;i++)cells+='<div class="cal-cell empty"></div>';
    for(let d=1;d<=dim;d++){
      const dayMid=new Date(calYear,calMonth,d).getTime();
      const isToday=dayMid===todayMid;
      const inWin=evs.some(e=>e.start&&dayMid>=calDayMid(e.start)&&dayMid<=(e.expire||e.start));
      const dayEvs=byDay[d]||[];
      cells+=`<div class="cal-cell ${isToday?'today':''} ${inWin?'inwin':''}"><div class="cal-date">${d}</div>${dayEvs.map(e=>`<div class="cal-chip" style="--c:${e.status.color}" title="${calEsc(e.name)} \u00B7 ${e.status.label}" onclick="navTo('colleges')">${calEsc(e.name)}</div>`).join('')}</div>`;
    }
    mainPanel=`<div class="cal-year">${CAL_MON.map((m,i)=>`<div class="cal-mini ${i===calMonth?'on':''}" onclick="calGoMonth(${i})"><div class="cm-m">${m}</div><div class="cm-c ${counts[i]?'':'zero'}">${counts[i]||'\u00B7'}</div></div>`).join('')}</div>
    <div class="cal-dows">${CAL_DOW.map(d=>`<div class="cal-dow">${d}</div>`).join('')}</div>
    <div class="cal-grid">${cells}</div>`;
  }
  document.getElementById('content').innerHTML=`
  <div class="cal-head">
    <div style="display:flex;align-items:center;gap:6px">
      <button class="cal-navbtn" onclick="calYearShift(-1)" title="Previous year">\u00AB</button>
      <div class="cal-title">${calView==='year'?calYear:CAL_MONTHS[calMonth]+' '+calYear}</div>
      <button class="cal-navbtn" onclick="calYearShift(1)" title="Next year">\u00BB</button>
      ${calView==='month'?`<button class="cal-navbtn" onclick="calPrevMonth()" title="Previous month">\u2039</button><button class="cal-navbtn" onclick="calNextMonth()" title="Next month">\u203A</button>`:''}
    </div>
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
      <span style="font-size:9px;color:var(--muted)">${yearTotal} scheduled in ${calYear}</span>
      <div class="cal-viewtoggle"><button class="${calView==='year'?'on':''}" onclick="calSetView('year')">Year</button><button class="${calView==='month'?'on':''}" onclick="calSetView('month')">Month</button></div>
      <button class="cal-navbtn" onclick="calToday()">Today</button>
      <button class="btn btn-amber" style="font-size:9.5px" onclick="navTo('colleges')">+ Schedule a college</button>
    </div>
  </div>
  ${mainPanel}
  <div style="margin-top:1.4rem;display:grid;grid-template-columns:repeat(auto-fit,minmax(290px,1fr));gap:1rem">
    <div>
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text2);margin-bottom:.7rem">\uD83D\uDCCC Upcoming (${upcoming.length})</div>
      ${upcoming.length?upcoming.map(listRow).join(''):'<div class="hcard" style="text-align:center;color:var(--muted);padding:1.3rem;font-size:10.5px">No upcoming hiring scheduled.</div>'}
    </div>
    <div>
      ${unscheduled.length?`<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--orange);margin-bottom:.7rem">\u26A0 Needs a date (${unscheduled.length})</div>`+unscheduled.map(listRow).join(''):''}
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--text2);margin:${unscheduled.length?'1.2rem':'0'} 0 .7rem">\uD83D\uDDC2 All scheduled (${scheduled.length})</div>
      ${scheduled.length?scheduled.map(listRow).join(''):'<div class="hcard" style="text-align:center;color:var(--muted);padding:1.3rem;font-size:10.5px">Nothing scheduled yet \u2014 use \u201CSchedule a college\u201D.</div>'}
    </div>
  </div>`;
}

// ═══════════════════════════════════════════════════════════
// COLLEGE LINKS & SCHEDULING (features 8-9)
// ═══════════════════════════════════════════════════════════
function _collegesData(){
  if(collegesCache&&Object.keys(collegesCache).length)return collegesCache;
  try{return JSON.parse(localStorage.getItem('apex_colleges_local')||'{}');}catch(e){return{};}
}
function _collegeMs(v){if(!v)return 0;if(typeof v==='number')return v;const t=Date.parse(v);return isNaN(t)?0:t;}
function _collegeStatus(cfg){
  const now=Date.now(),start=_collegeMs(cfg.startTime),expire=_collegeMs(cfg.expireTime);
  if(cfg.ended===true)return{label:'Closed',color:'var(--red)'};
  if(expire&&now>expire)return{label:'Expired',color:'var(--muted)'};
  if(start&&now<start&&cfg.open!==true)return{label:'Scheduled',color:'var(--blue)'};
  if(cfg.open===true)return{label:'● Live',color:'var(--green)'};
  return{label:'Not started',color:'var(--orange)'};
}
function _fmtDT(ms){if(!ms)return '—';try{return new Date(ms).toLocaleString('en-IN',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});}catch(e){return '—';}}
function collegeSlug(name){return (name||'college').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,28)+'-'+Math.random().toString(36).slice(2,6);}
function collegeLink(id){return ASSESSMENT_URL+'?college='+encodeURIComponent(id);}

function _collegeWrite(id,patch){
  const data=_collegesData();
  const merged={...(data[id]||{}),...patch};
  collegesCache={...data,[id]:merged};
  try{localStorage.setItem('apex_colleges_local',JSON.stringify(collegesCache));}catch(e){}
  upsertCollege(id,merged).catch(e=>console.warn(e));
  if(curPage==='colleges')renderColleges();else if(curPage==='calendar')renderCalendar();
  updateAllCounts();
}
function createCollege(){
  const name=(document.getElementById('cl-name')?.value||'').trim();
  if(!name){showToast('Enter a college name','warn');return;}
  const startV=document.getElementById('cl-start')?.value;
  const expireV=document.getElementById('cl-expire')?.value;
  const accent=document.getElementById('cl-accent')?.value||'';
  const welcome=(document.getElementById('cl-welcome')?.value||'').trim();
  const id=collegeSlug(name);
  const cfg={name,open:false,ended:false,
    startTime:startV?new Date(startV).getTime():0,
    expireTime:expireV?new Date(expireV).getTime():0,
    accent:accent||'',welcome:welcome||'',createdAt:Date.now(),createdBy:loggedUser?.name||'HR'};
  _collegeWrite(id,cfg);
  showToast('🎓 College link created','success');
}
function collegeStartNow(id){const data=_collegesData();const cfg=data[id]||{};_collegeWrite(id,{open:true,ended:false,startTime:cfg.startTime&&_collegeMs(cfg.startTime)>Date.now()?cfg.startTime:Date.now()});showToast('▶ Assessment opened','success');}
function collegeEnd(id){_collegeWrite(id,{open:false,ended:true,endedAt:Date.now()});showToast('⏹ Assessment closed','warn');}
function collegeReopen(id){_collegeWrite(id,{open:true,ended:false});showToast('▶ Assessment re-opened','success');}
function collegeDelete(id){if(!confirm('Delete this college link? Candidates using it will lose access.'))return;const data=_collegesData();delete data[id];collegesCache={...data};try{localStorage.setItem('apex_colleges_local',JSON.stringify(collegesCache));}catch(e){}deleteCollege(id).catch(e=>console.warn(e));renderColleges();updateAllCounts();showToast('College link deleted','warn');}
function collegeCopyLink(id){const url=collegeLink(id);navigator.clipboard.writeText(url).then(()=>showToast('🔗 Link copied','success')).catch(()=>showToast(url,'success'));}
function collegeSaveInterface(id){
  const accent=document.getElementById('ci-accent-'+id)?.value||'';
  const welcome=(document.getElementById('ci-welcome-'+id)?.value||'').trim();
  const landTitle=(document.getElementById('ci-title-'+id)?.value||'').trim();
  const landEyebrow=(document.getElementById('ci-eyebrow-'+id)?.value||'').trim();
  _collegeWrite(id,{accent,welcome,landTitle,landEyebrow});
  showToast('🎨 Interface saved','success');
}
function collegeSetSchedule(id){
  const startV=document.getElementById('cs-start-'+id)?.value;
  const expireV=document.getElementById('cs-expire-'+id)?.value;
  _collegeWrite(id,{startTime:startV?new Date(startV).getTime():0,expireTime:expireV?new Date(expireV).getTime():0});
  showToast('🗓 Schedule updated','success');
}
function _dtLocalValue(ms){if(!ms)return '';try{const d=new Date(ms);const pad=n=>String(n).padStart(2,'0');return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'T'+pad(d.getHours())+':'+pad(d.getMinutes());}catch(e){return '';}}

// ═══════════════════════════════════════════════════════════
// COLLEGE COMPARE — cards, per-college roster + Excel export, side-by-side comparison
// Grouped by the free-text `college` field every candidate has (not the admin-managed
// `colleges` link table below), so this covers every registration, not just scheduled links.
// ═══════════════════════════════════════════════════════════
let _compareSel=new Set();
function _collegeGroups(){
  const map={};
  getCands().forEach(c=>{
    const name=(c.college||'').trim()||'Unspecified';
    (map[name]=map[name]||[]).push(c);
  });
  return Object.keys(map).sort((a,b)=>map[b].length-map[a].length).map(name=>({name,cands:map[name]}));
}
function _collegeStats(cands){
  const completed=cands.filter(c=>c.completedRounds>=6);
  const avg=completed.length?avgArr(completed.map(c=>cAvg(c))):0;
  const hired=cands.filter(c=>c.hired).length;
  const viols=cands.reduce((n,c)=>n+violationLog.filter(v=>v.candidateEmail===c.email).length,0);
  const roundAvgs=RN.map((_,ri)=>{
    const scores=completed.map(c=>(c.scores||[])[ri]).filter(s=>typeof s==='number');
    return scores.length?avgArr(scores):0;
  });
  return {registered:cands.length,completed:completed.length,avg,hired,viols,roundAvgs};
}
function _candidatesToRows(cands){
  const hdrs=['Name','Email','College','Programme',...RN,'Avg','Status','Violations','Hired','Registered'];
  const rows=cands.map(c=>{
    const viols=violationLog.filter(v=>v.candidateEmail===c.email).length;
    const scores=RN.map((_,i)=>(c.scores||[])[i]!==undefined?(c.scores||[])[i]:'');
    return[fullN(c),c.email||'',c.college||'',c.prog||'',...scores,cAvg(c),cStatus(c),viols,c.hired?'Yes':'',c.registeredAt?new Date(c.registeredAt).toLocaleDateString():''];
  });
  return {hdrs,rows};
}
function _downloadXLSX(sheets,filename){
  const wb=XLSX.utils.book_new();
  sheets.forEach(({name,hdrs,rows})=>{
    const ws=XLSX.utils.aoa_to_sheet([hdrs,...rows]);
    XLSX.utils.book_append_sheet(wb,ws,(name||'Sheet1').replace(/[\\/*?:[\]]/g,'').slice(0,31));
  });
  XLSX.writeFile(wb,filename);
}
function exportCollegeExcel(name){
  const group=_collegeGroups().find(g=>g.name===name);
  if(!group||!group.cands.length){showToast('No students for this college','warn');return;}
  const {hdrs,rows}=_candidatesToRows(group.cands);
  _downloadXLSX([{name,hdrs,rows}],'college_'+name.replace(/[^a-z0-9]+/gi,'_').slice(0,40)+'_'+new Date().toISOString().slice(0,10)+'.xlsx');
  showToast('✅ Excel exported','success');
}
function exportAllCollegesExcel(){
  const groups=_collegeGroups();
  if(!groups.length){showToast('No data','warn');return;}
  const sheets=groups.map(g=>({name:g.name,..._candidatesToRows(g.cands)}));
  _downloadXLSX(sheets,'all_colleges_'+new Date().toISOString().slice(0,10)+'.xlsx');
  showToast('✅ Excel exported — '+groups.length+' college sheet(s)','success');
}
function viewCollegeStudents(name){srch=name;navTo('candidates');}
function toggleCompareCollege(name){
  if(_compareSel.has(name))_compareSel.delete(name);else _compareSel.add(name);
  renderCollegeCompare();
}
function renderCollegeCompare(){
  const groups=_collegeGroups();
  document.getElementById('content').innerHTML=`
  <div class="hcard" style="margin-bottom:1rem">
    <div class="hcard-title" style="flex-direction:column;align-items:flex-start;gap:5px">
      <span>🏛️ Colleges</span>
      <p style="font-size:10.5px;color:var(--text2);font-weight:400;line-height:1.6">Every college that appears in a candidate's registration. Click a card to select it for comparison, use "View Students" to see its full roster, or export any (or all) colleges' data to Excel.</p>
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:.9rem">
      <button class="btn btn-amber" style="font-size:9.5px" onclick="exportAllCollegesExcel()">⬇ Export All Colleges (Excel)</button>
      ${_compareSel.size>0?`<button class="btn btn-ghost" style="font-size:9.5px" onclick="_compareSel=new Set();renderCollegeCompare()">✕ Clear Selection (${_compareSel.size})</button>`:''}
    </div>
    ${groups.length===0?'<div style="text-align:center;color:var(--muted);font-size:11px;padding:2rem">No candidates registered yet.</div>':`
    <div class="college-cardgrid">
      ${groups.map(g=>{
        const st=_collegeStats(g.cands);
        const sel=_compareSel.has(g.name);
        const nameEsc=g.name.replace(/'/g,"\\'").replace(/"/g,'&quot;');
        return `<div class="college-card ${sel?'sel':''}" onclick="toggleCompareCollege('${nameEsc}')">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px;margin-bottom:.5rem">
            <div style="font-family:var(--fd);font-size:13px;font-weight:700;flex:1">${g.name}</div>
            ${sel?'<span style="color:var(--amber);font-size:14px">✓</span>':''}
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:.7rem">
            <div><div style="font-family:var(--fd);font-size:18px;font-weight:800">${st.registered}</div><div style="font-size:8px;color:var(--muted);text-transform:uppercase">Registered</div></div>
            <div><div style="font-family:var(--fd);font-size:18px;font-weight:800;color:${scColor(st.avg)}">${st.avg}%</div><div style="font-size:8px;color:var(--muted);text-transform:uppercase">Avg Score</div></div>
            <div><div style="font-family:var(--fd);font-size:14px;font-weight:700">${st.completed}</div><div style="font-size:8px;color:var(--muted);text-transform:uppercase">Completed</div></div>
            <div><div style="font-family:var(--fd);font-size:14px;font-weight:700;color:var(--green)">${st.hired}</div><div style="font-size:8px;color:var(--muted);text-transform:uppercase">Hired</div></div>
          </div>
          <div style="display:flex;gap:5px;flex-wrap:wrap" onclick="event.stopPropagation()">
            <button class="btn btn-ghost" style="font-size:8.5px" onclick="viewCollegeStudents('${nameEsc}')">👁 View Students</button>
            <button class="btn btn-ghost" style="font-size:8.5px" onclick="exportCollegeExcel('${nameEsc}')">⬇ Excel</button>
          </div>
        </div>`;
      }).join('')}
    </div>`}
  </div>
  ${_compareSel.size>=2?renderCollegeCompareTable(groups):(_compareSel.size===1?'<div class="hcard" style="text-align:center;color:var(--muted);font-size:11px;padding:1.5rem">Select at least one more college above to compare.</div>':'')}
  `;
}
function renderCollegeCompareTable(groups){
  const sel=groups.filter(g=>_compareSel.has(g.name));
  const stats=sel.map(g=>({name:g.name,..._collegeStats(g.cands)}));
  return `
  <div class="hcard">
    <div class="hcard-title">⚖️ Comparison — ${sel.map(s=>s.name).join(' vs ')}</div>
    <div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Metric</th>${stats.map(s=>`<th>${s.name}</th>`).join('')}</tr></thead>
      <tbody>
        <tr><td>Registered</td>${stats.map(s=>`<td>${s.registered}</td>`).join('')}</tr>
        <tr><td>Completed</td>${stats.map(s=>`<td>${s.completed}</td>`).join('')}</tr>
        <tr><td>Avg Score</td>${stats.map(s=>`<td style="color:${scColor(s.avg)};font-weight:700">${s.avg}%</td>`).join('')}</tr>
        <tr><td>Hired</td>${stats.map(s=>`<td style="color:var(--green);font-weight:700">${s.hired}</td>`).join('')}</tr>
        <tr><td>Violations</td>${stats.map(s=>`<td>${s.viols}</td>`).join('')}</tr>
      </tbody>
    </table></div>
    <div style="margin-top:1.1rem;font-size:9.5px;font-weight:700;color:var(--amber);text-transform:uppercase;letter-spacing:.1em;margin-bottom:.6rem">Round-wise Average Score</div>
    ${RN.map((rn,ri)=>`
      <div style="margin-bottom:.7rem">
        <div style="font-size:10px;color:var(--text2);margin-bottom:3px">${RI[ri]} ${rn}</div>
        ${stats.map((s,i)=>`<div class="bar-row"><span class="bar-label" style="width:120px">${s.name.slice(0,18)}</span><div class="bar-track"><div class="bar-fill" style="width:${s.roundAvgs[ri]}%;background:${avCol(i)}"></div></div><span class="bar-val">${s.roundAvgs[ri]}%</span></div>`).join('')}
      </div>`).join('')}
  </div>`;
}

function renderColleges(){
  const data=_collegesData();
  const ids=Object.keys(data).sort((a,b)=>(data[b].createdAt||0)-(data[a].createdAt||0));
  const cands=getCands();
  const cardFor=id=>{
    const cfg=data[id]||{};const st=_collegeStatus(cfg);
    const url=collegeLink(id);
    const count=cands.filter(c=>c.collegeId===id).length;
    const live=cfg.open===true&&cfg.ended!==true;
    return `<div class="hcard" style="margin-bottom:.9rem">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap;margin-bottom:.7rem">
        <div>
          <div style="font-family:var(--fd);font-size:14px;font-weight:700">${cfg.name||id}</div>
          <div style="font-size:9.5px;color:var(--muted);margin-top:2px">${count} registered · created ${_fmtDT(cfg.createdAt)}</div>
        </div>
        <span class="pill" style="background:${st.color}1a;color:${st.color};border:1px solid ${st.color}55;font-size:10px;padding:3px 9px">${st.label}</span>
      </div>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:.7rem">
        <code style="background:rgba(255,255,255,.04);border:1px solid var(--border2);border-radius:5px;padding:5px 9px;font-size:10px;color:var(--text);flex:1;min-width:160px;word-break:break-all">${url}</code>
        <button class="btn btn-ghost" style="font-size:9px" onclick="collegeCopyLink('${id}')">📋 Copy</button>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:.8rem">
        ${live
          ?`<button class="btn btn-danger" style="font-size:9.5px" onclick="collegeEnd('${id}')">⏹ End Assessment</button>`
          :cfg.ended
            ?`<button class="btn btn-success" style="font-size:9.5px" onclick="collegeReopen('${id}')">▶ Re-open</button>`
            :`<button class="btn btn-success" style="font-size:9.5px" onclick="collegeStartNow('${id}')">▶ Start Assessment Now</button>`}
        <button class="btn btn-danger" style="font-size:9.5px;opacity:.8" onclick="collegeDelete('${id}')">🗑 Delete</button>
      </div>
      <details style="margin-bottom:.5rem">
        <summary style="cursor:pointer;font-size:10px;font-weight:700;color:var(--amber);text-transform:uppercase;letter-spacing:.08em">🗓 Schedule (start &amp; expiry)</summary>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:.6rem">
          <div><label style="font-size:8.5px;color:var(--text2);display:block;margin-bottom:2px">Scheduled start</label><input type="datetime-local" class="inp" id="cs-start-${id}" value="${_dtLocalValue(_collegeMs(cfg.startTime))}" style="width:100%;font-size:10.5px"></div>
          <div><label style="font-size:8.5px;color:var(--text2);display:block;margin-bottom:2px">Link expiry</label><input type="datetime-local" class="inp" id="cs-expire-${id}" value="${_dtLocalValue(_collegeMs(cfg.expireTime))}" style="width:100%;font-size:10.5px"></div>
        </div>
        <div style="font-size:9px;color:var(--muted);margin-top:5px">Start: <strong>${_fmtDT(_collegeMs(cfg.startTime))}</strong> · Expires: <strong>${_fmtDT(_collegeMs(cfg.expireTime))}</strong></div>
        <button class="btn btn-amber" style="font-size:9px;margin-top:.5rem" onclick="collegeSetSchedule('${id}')">💾 Save Schedule</button>
      </details>
      <details>
        <summary style="cursor:pointer;font-size:10px;font-weight:700;color:var(--blue);text-transform:uppercase;letter-spacing:.08em">🎨 Candidate interface (shown before they register)</summary>
        <div style="margin-top:.6rem;display:grid;gap:7px">
          <div><label style="font-size:8.5px;color:var(--text2);display:block;margin-bottom:2px">Landing headline (HTML allowed)</label><input class="inp" id="ci-title-${id}" value="${(cfg.landTitle||'').replace(/"/g,'&quot;')}" placeholder="e.g. Welcome, IIM-A 2026 batch" style="width:100%;font-size:10.5px"></div>
          <div><label style="font-size:8.5px;color:var(--text2);display:block;margin-bottom:2px">Eyebrow text</label><input class="inp" id="ci-eyebrow-${id}" value="${(cfg.landEyebrow||'').replace(/"/g,'&quot;')}" placeholder="e.g. Campus Recruitment · 2026" style="width:100%;font-size:10.5px"></div>
          <div style="display:grid;grid-template-columns:auto 1fr;gap:8px;align-items:center"><div><label style="font-size:8.5px;color:var(--text2);display:block;margin-bottom:2px">Accent</label><input type="color" id="ci-accent-${id}" value="${cfg.accent||'#d4a843'}" style="width:46px;height:30px;border:none;background:none;cursor:pointer"></div><div><label style="font-size:8.5px;color:var(--text2);display:block;margin-bottom:2px">Welcome / instructions message</label><textarea class="inp" id="ci-welcome-${id}" rows="2" placeholder="Shown on the gate screen" style="width:100%;font-size:10.5px;resize:vertical">${cfg.welcome||''}</textarea></div></div>
          <button class="btn btn-amber" style="font-size:9px;justify-self:start" onclick="collegeSaveInterface('${id}')">💾 Save Interface</button>
        </div>
      </details>
    </div>`;
  };
  document.getElementById('content').innerHTML=`
  <div class="hcard" style="margin-bottom:1rem">
    <div class="hcard-title" style="flex-direction:column;align-items:flex-start;gap:5px"><span>🎓 Create College Link</span><p style="font-size:10.5px;color:var(--text2);font-weight:400;line-height:1.6">Each college gets its own expirable assessment URL. Schedule when it opens, set an expiry, start/end it live, and customise the candidate-facing interface before students register.</p></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px">
      <div style="grid-column:1/-1"><label style="font-size:8.5px;color:var(--text2);display:block;margin-bottom:2px">College name *</label><input class="inp" id="cl-name" placeholder="e.g. IIM Ahmedabad" style="width:100%"></div>
      <div><label style="font-size:8.5px;color:var(--text2);display:block;margin-bottom:2px">Scheduled start (optional)</label><input type="datetime-local" class="inp" id="cl-start" style="width:100%;font-size:10.5px"></div>
      <div><label style="font-size:8.5px;color:var(--text2);display:block;margin-bottom:2px">Link expiry (optional)</label><input type="datetime-local" class="inp" id="cl-expire" style="width:100%;font-size:10.5px"></div>
      <div style="display:flex;align-items:flex-end;gap:8px"><div><label style="font-size:8.5px;color:var(--text2);display:block;margin-bottom:2px">Accent</label><input type="color" id="cl-accent" value="#d4a843" style="width:46px;height:30px;border:none;background:none;cursor:pointer"></div><div style="flex:1"><label style="font-size:8.5px;color:var(--text2);display:block;margin-bottom:2px">Welcome message (optional)</label><input class="inp" id="cl-welcome" placeholder="Shown on the gate screen" style="width:100%;font-size:10.5px"></div></div>
    </div>
    <button class="btn btn-amber" style="font-size:10px" onclick="createCollege()">+ Create College Link</button>
  </div>
  <div style="font-size:10px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.08em;margin-bottom:.7rem">${ids.length} College Link${ids.length===1?'':'s'}</div>
  ${ids.length===0?'<div class="hcard" style="text-align:center;color:var(--muted);font-size:11px;padding:2rem">No colleges yet. Create one above to generate its assessment link.</div>':ids.map(cardFor).join('')}`;
}

(async function init(){
  const ok=await checkSession();
  if(!ok){
    document.getElementById('login-screen').style.display='flex';
    return;
  }
  initDashboard();
})();


// Expose handlers for inline HTML onclick (ES modules are scoped)
window.selRole = selRole;
window.doLogin = doLogin;
window.doLogout = doLogout;
window.checkSession = checkSession;
window.initDashboard = initDashboard;
window.setFbStatus = setFbStatus;
window.showFbHelp = showFbHelp;
window.initFirebaseStatus = initFirebaseStatus;
window.initFirebase = initFirebase;
window.initLiveSync = initLiveSync;
window.mergeFromFB = mergeFromFB;
window.getCands = getCands;
window.saveCands = saveCands;
window.mergeEventToCandidate = mergeEventToCandidate;
window.getFiltered = getFiltered;
window.cAvg = cAvg;
window.cStatus = cStatus;
window.fullN = fullN;
window.inits = inits;
window.scColor = scColor;
window.scClass = scClass;
window.sLabel = sLabel;
window.sClass = sClass;
window.fmtDate = fmtDate;
window.avgArr = avgArr;
window.updateAllCounts = updateAllCounts;
window.scheduleLiveRefresh = scheduleLiveRefresh;
window.handleLiveEvent = handleLiveEvent;
window.getEvDetail = getEvDetail;
window.nav = nav;
window.navTo = navTo;
window.globalSearch = globalSearch;
window.renderPage = renderPage;
window.softRefresh = softRefresh;
window.renderOverview = renderOverview;
window.renderCandidates = renderCandidates;
window.renderCandResults = renderCandResults;
window.relTime = relTime;
window.monitorActivity = monitorActivity;
window.renderLive = renderLive;
window.renderShortlist = renderShortlist;
window.bulkHire = bulkHire;
window.renderHired = renderHired;
window.renderLeaderboard = renderLeaderboard;
window.renderAnalytics = renderAnalytics;
window.renderViolations = renderViolations;
window.renderWhitelist = renderWhitelist;
window.unblockDevice = unblockDevice;
window.unblockEmail = unblockEmail;
window.manualBlockEmail = manualBlockEmail;
window.manualUnblockEmail = manualUnblockEmail;
window.renderQEditor = renderQEditor;
window.showREditor = showREditor;
window.setCorrect = setCorrect;
window.addNewQ = addNewQ;
window.saveQEdits = saveQEdits;
window.openDetail = openDetail;
window.closeDetail = closeDetail;
window.viewResume = viewResume;
window.renderCollegeCompare = renderCollegeCompare;
window.toggleCompareCollege = toggleCompareCollege;
window.viewCollegeStudents = viewCollegeStudents;
window.exportCollegeExcel = exportCollegeExcel;
window.exportAllCollegesExcel = exportAllCollegesExcel;
window.deleteCandidate = deleteCandidate;
window.setStatus = setStatus;
window.hireCandidate = hireCandidate;
window.confirmHire = confirmHire;
window.closeHireConfirm = closeHireConfirm;
window.sendOfferEmail = sendOfferEmail;
window.showEmailModal = showEmailModal;
window.copyEmailBody = copyEmailBody;
window.closeEmailModal = closeEmailModal;
window.renderCerts = renderCerts;
window.showCert = showCert;
window.closeCert = closeCert;
window.sendCertEmail = sendCertEmail;
window.sendAllCerts = sendAllCerts;
window.renderSettings = renderSettings;
window.addManualCand = addManualCand;
window.clearDB = clearDB;
window.exportCSV = exportCSV;
window.refreshAll = refreshAll;
window.renderBulkInvite = renderBulkInvite;
window.biHandleDrop = biHandleDrop;
window.biHandleFile = biHandleFile;
window.biShowStep2 = biShowStep2;
window.biRenderEmailList = biRenderEmailList;
window.biSyncCount = biSyncCount;
window.biRemoveEmail = biRemoveEmail;
window.biAddManual = biAddManual;
window.biCopyLink = biCopyLink;
window.biCopyAll = biCopyAll;
window.biDownloadCSV = biDownloadCSV;
window.biSendAll = biSendAll;
window.biShowResults = biShowResults;
window.biDownloadReport = biDownloadReport;
window.biReset = biReset;
window.showToast = showToast;
window.calEsc = calEsc;
window.calEvents = calEvents;
window.calDayMid = calDayMid;
window.calPrevMonth = calPrevMonth;
window.calNextMonth = calNextMonth;
window.calToday = calToday;
window.calGoMonth = calGoMonth;
window.calYearShift = calYearShift;
window.calSetView = calSetView;
window.calOpenMonth = calOpenMonth;
window.buildMiniMonth = buildMiniMonth;
window.renderCalendar = renderCalendar;
window._collegesData = _collegesData;
window._collegeMs = _collegeMs;
window._collegeStatus = _collegeStatus;
window._fmtDT = _fmtDT;
window.collegeSlug = collegeSlug;
window.collegeLink = collegeLink;
window.ASSESSMENT_URL = ASSESSMENT_URL;
window._collegeWrite = _collegeWrite;
window.createCollege = createCollege;
window.collegeStartNow = collegeStartNow;
window.collegeEnd = collegeEnd;
window.collegeReopen = collegeReopen;
window.collegeDelete = collegeDelete;
window.collegeCopyLink = collegeCopyLink;
window.collegeSaveInterface = collegeSaveInterface;
window.collegeSetSchedule = collegeSetSchedule;
window._dtLocalValue = _dtLocalValue;
window.renderColleges = renderColleges;

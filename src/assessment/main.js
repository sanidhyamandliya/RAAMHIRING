import './styles.css';
import { sendMail } from '../shared/mailer.js';
import { renderCertificatePNG } from '../shared/certImage.js';
import {
  upsertCandidate,
  setCertId,
  setFeedback,
  pushEvent,
  getCollege,
  subscribeColleges,
  listCustomQuestions,
  subscribeCustomQuestions,
  blockDevice as dbBlockDevice,
  blockEmail as dbBlockEmail,
  isDeviceBlocked as dbIsDeviceBlocked,
  isEmailBlocked as dbIsEmailBlocked,
  listBlockedDevices,
  listBlockedEmails,
  subscribeBlocks,
  uploadResume,
} from '../shared/db/index.js';
import { ROUNDS, ROUND_NAMES, CORRECT_ANS } from './rounds.js';

const DB_KEY = 'apex_mt_v1';
const CHAN_KEY = 'apex_live_feed';
const MAX_VIOLATIONS = 3;

const S = {
  prog: null, progKey: null, cand: {},
  round: 0, q: 0, ans: {}, done: [], scores: [],
  candSeq: 0, gameScores: {}
};
let timerInt=null, timeLeft=0, curR=null;
let violationCount=0, assessmentActive=false;
let camStream=null, photoInterval=null, capturedPhotos=[];
let liveChannel=null;
let dbReady=false;
// ── Per-college link / gating (features 8-9) ──────────────────
const _urlParams=new URLSearchParams(window.location.search);
const COLLEGE_ID=(_urlParams.get('college')||_urlParams.get('c')||'').trim();
let COLLEGE_CFG=null;          // {name,open,startTime,expireTime,interface...}
let collegeGateTimer=null;     // countdown interval
let collegeProceeded=false;    // becomes true once gate passes
let collegeLoaded=false;       // true once college config first received

// ═══════════════════════════════════════════════════════════
// DEVICE FINGERPRINT & BLOCK LIST
// ═══════════════════════════════════════════════════════════
function getDeviceId(){
  let id=localStorage.getItem('apex_device_id');
  if(!id){
    id='DEV-'+Date.now().toString(36).toUpperCase()+'-'+Math.random().toString(36).slice(2,7).toUpperCase();
    localStorage.setItem('apex_device_id',id);
  }
  return id;
}
function isDeviceBlocked(){
  const id=getDeviceId();
  try{
    const blocked=JSON.parse(localStorage.getItem('apex_blocked_devices')||'[]');
    return blocked.includes(id);
  }catch(e){return false;}
}
function blockDevice(email){
  const id=getDeviceId();
  try{
    const blocked=JSON.parse(localStorage.getItem('apex_blocked_devices')||'[]');
    if(!blocked.includes(id)){blocked.push(id);localStorage.setItem('apex_blocked_devices',JSON.stringify(blocked));}
  }catch(e){}
  try{
    const blockedEmails=JSON.parse(localStorage.getItem('apex_blocked_emails')||'[]');
    if(email&&!blockedEmails.includes(email)){blockedEmails.push(email);localStorage.setItem('apex_blocked_emails',JSON.stringify(blockedEmails));}
  }catch(e){}
  dbBlockDevice(id, email||'', 'termination').catch(e=>console.warn('[Apex] block device',e));
  if(email) dbBlockEmail(email, id, 'termination').catch(e=>console.warn('[Apex] block email',e));
}
function isEmailBlocked(email){
  if(!email) return false;
  try{
    const blockedEmails=JSON.parse(localStorage.getItem('apex_blocked_emails')||'[]');
    if(blockedEmails.includes(email)) return true;
  }catch(e){}
  return false;
}
async function checkFirebaseBlock(email){
  if(!email) return false;
  const id=getDeviceId();
  let emailBlocked=false, devBlocked=false;
  try{ emailBlocked=await dbIsEmailBlocked(email); }catch(e){}
  try{ devBlocked=await dbIsDeviceBlocked(id); }catch(e){}
  try{
    if(!emailBlocked){const be=JSON.parse(localStorage.getItem('apex_blocked_emails')||'[]').filter(e=>e!==email);localStorage.setItem('apex_blocked_emails',JSON.stringify(be));}
    if(!devBlocked){const bd=JSON.parse(localStorage.getItem('apex_blocked_devices')||'[]').filter(d=>d!==id);localStorage.setItem('apex_blocked_devices',JSON.stringify(bd));}
  }catch(e){}
  return emailBlocked||devBlocked;
}
function showBlocked(){
  const id=getDeviceId();
  document.getElementById('blk-id').textContent='Device ID: '+id;
  show('s-blocked');
}

// ═══════════════════════════════════════════════════════════
// LAPTOP / DESKTOP ONLY — block phones & tablets
// ═══════════════════════════════════════════════════════════
function isMobileDevice(){
  const ua=navigator.userAgent||'';
  const uaMobile=/Android|iPhone|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|Windows Phone/i.test(ua);
  const tabletUA=/iPad|Tablet|PlayBook|Silk/i.test(ua);
  const iPadOS=/Macintosh/i.test(ua)&&navigator.maxTouchPoints>1;
  const smallTouch=(()=>{try{return window.matchMedia('(pointer:coarse)').matches&&Math.min(window.innerWidth,window.innerHeight)<900;}catch(e){return false;}})();
  return uaMobile||tabletUA||iPadOS||smallTouch;
}
function showDeviceBlocked(){show('s-device-blocked');}

// ═══════════════════════════════════════════════════════════
// SUPABASE (relational tables)
// ═══════════════════════════════════════════════════════════
function initFirebase(){
  try{
    dbReady=true;
    console.log('[Apex] Supabase relational API ready');
    attachCustomQuestionListener();
    attachCollegeListener();
    attachBlockSyncListener();
    setTimeout(_drainPendingSync, 500);
  }catch(err){
    console.warn('[Apex] Supabase init error:',err);
    setTimeout(initFirebase,1000);
  }
}
function initLiveSync(){
  if(!window.BroadcastChannel) return;
  try{
    liveChannel=new BroadcastChannel(CHAN_KEY);
  }catch(e){}
}
const _pendingSync=[];
function syncToHR(data){
  const icons={registered:'📋',round_start:'▶️',round_completed:'✅',completed:'🏆',violation:'⚠️',terminated:'🚫',hired:'🎉',flag:'🖥️'};
  const msg={...data,ico:icons[data.type]||'📍',time:new Date().toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit'}),_ts:Date.now(),deviceId:getDeviceId()};
  try{if(liveChannel)liveChannel.postMessage(msg);}catch(e){}
  if(dbReady){
    _flushSync(msg,data);
  } else {
    _pendingSync.push({msg,data});
  }
}
function _flushSync(msg,data){
  try{
    // Events only — never merge live-feed decorations into candidates
    pushEvent({...msg,deviceId:getDeviceId()}).catch(e=>console.warn('[Apex] Event write failed:',e&&e.message));
    // Candidate upsert only for typed payloads that carry profile fields
    if(data.email || data.candidateEmail){
      const email=(data.email||data.candidateEmail||'').toLowerCase();
      if(email && (data.type==='registered'||data.type==='round_completed'||data.type==='completed'||data.type==='terminated')){
        const cand={
          email,
          fname:data.fname||'',
          lname:data.lname||'',
          phone:data.phone||'',
          college:data.college||'',
          collegeId:(COLLEGE_ID&&COLLEGE_CFG)?COLLEGE_ID:null,
          passYear:data.passYear||'',
          deg:data.deg||'',
          prog:data.prog||'',
          progKey:data.progKey||'',
          status:data.type==='terminated'?'terminated':(data.status||'in_progress'),
          completedRounds:data.completedRounds||0,
          violations:data.violations||0,
          registeredAt:data.registeredAt||null,
          submittedAt:data.submittedAt||null,
          deviceId:getDeviceId(),
          scores:Array.isArray(data.scores)?data.scores:undefined,
        };
        upsertCandidate(cand).catch(e=>console.warn('[Apex] Candidate write failed:',e&&e.message));
      }
    }
  }catch(e){console.warn('[Apex] Sync error:',e);}
}
function _drainPendingSync(){
  if(!dbReady||!_pendingSync.length) return;
  while(_pendingSync.length>0){
    const {msg,data}=_pendingSync.shift();
    _flushSync(msg,data);
  }
}
function dbSave(rec){
  try{
    const all=JSON.parse(localStorage.getItem(DB_KEY)||'[]');
    const idx=all.findIndex(c=>c.email===rec.email);
    if(idx>=0)all[idx]={...all[idx],...rec,_updated:Date.now()};
    else all.push({...rec,id:'C'+Date.now().toString(36).toUpperCase(),_created:Date.now()});
    localStorage.setItem(DB_KEY,JSON.stringify(all));
  }catch(e){}
  upsertCandidate({...rec,deviceId:getDeviceId()}).catch(e=>console.warn('[Apex] Candidate save failed:',e&&e.message));
}

function _applyCustomQuestions(data){
  if(!data)return;
  Object.keys(data).forEach(k=>{
    let ri;
    const m=/^round(\d+)$/.exec(k);
    if(m) ri=parseInt(m[1],10);
    else ri=parseInt(k,10);
    if(Number.isNaN(ri)||ri<0||ri>3||!ROUNDS[ri])return;
    const obj=data[k];
    if(!obj||!Array.isArray(obj.questions)||!obj.questions.length)return;
    ROUNDS[ri].qs=obj.questions.map(q=>({text:q.text||'',opts:(q.opts||[]).slice()}));
    CORRECT_ANS[ri]=obj.questions.map(q=>(typeof q.correct==='number'?q.correct:0));
  });
  try{localStorage.setItem('apex_custom_questions_synced',JSON.stringify(data));}catch(e){}
}

// ═══════════════════════════════════════════════════════════
// CUSTOM QUESTIONS SYNC (admin edits from dashboard)
// ═══════════════════════════════════════════════════════════
function attachCustomQuestionListener(){
  const load=()=>listCustomQuestions().then(data=>{
    _applyCustomQuestions(data);
    console.log('[Apex] Custom questions synced');
  }).catch(e=>console.warn('[Apex] custom Q load',e));
  load();
  subscribeCustomQuestions(load);
}

// ═══════════════════════════════════════════════════════════
// PER-COLLEGE GATE: expirable link, scheduled start, admin start/end
// ═══════════════════════════════════════════════════════════
function _toMs(v){if(!v)return 0;if(typeof v==='number')return v;const t=Date.parse(v);return isNaN(t)?0:t;}
async function attachCollegeListener(){
  if(!COLLEGE_ID) return;
  const apply=(cfg)=>{
    COLLEGE_CFG=cfg;
    collegeLoaded=true;
    if(!collegeProceeded) evaluateCollegeGate();
  };
  try{
    const cfg=await getCollege(COLLEGE_ID);
    apply(cfg);
  }catch(err){
    console.warn('[Apex] colleges read failed:',err&&err.message);
    collegeLoaded=true;
    const t=document.getElementById('cg-title'),s=document.getElementById('cg-status');
    if(t)t.textContent='Link Verification Failed';
    if(s)s.textContent='Could not load this college link. Please contact your placement coordinator.';
  }
  subscribeColleges(async()=>{
    try{ apply(await getCollege(COLLEGE_ID)); }catch(e){}
  });
}

// ── Auto-unblock: keep local block lists in sync ──
let lastAttemptEmail='';
function recoverIfUnblocked(){
  const cur=document.querySelector('.screen.active');
  if(!cur||cur.id!=='s-blocked')return;
  const dev=isDeviceBlocked();
  const em=lastAttemptEmail?isEmailBlocked(lastAttemptEmail):false;
  if(!dev&&!em){showToast('Access reinstated — reloading…','success');setTimeout(()=>location.reload(),1100);}
}
function attachBlockSyncListener(){
  const sync=async()=>{
    try{
      const devices=await listBlockedDevices();
      const emails=await listBlockedEmails();
      localStorage.setItem('apex_blocked_devices',JSON.stringify(devices.map(d=>d.device_id)));
      localStorage.setItem('apex_blocked_emails',JSON.stringify(emails.map(e=>e.email)));
      recoverIfUnblocked();
    }catch(e){console.warn('[Apex] block sync',e);}
  };
  sync();
  subscribeBlocks(sync);
}
function evaluateCollegeGate(){
  if(!COLLEGE_ID) return;
  const titleEl=document.getElementById('cg-title');
  const statusEl=document.getElementById('cg-status');
  const cdEl=document.getElementById('cg-countdown');
  const msgEl=document.getElementById('cg-msg');
  const enterBtn=document.getElementById('cg-enter');
  const eyebrowEl=document.getElementById('cg-eyebrow');
  if(!titleEl) return;
  if(collegeGateTimer){clearInterval(collegeGateTimer);collegeGateTimer=null;}
  cdEl.style.display='none';enterBtn.style.display='none';msgEl.style.display='none';
  if(!collegeLoaded){
    titleEl.textContent='Checking your link…';
    statusEl.textContent='Please wait a moment.';
    return;
  }
  if(COLLEGE_CFG===null||COLLEGE_CFG===undefined){
    titleEl.textContent='Invalid Assessment Link';
    statusEl.textContent='This college link was not found or has been removed. Please contact your placement coordinator.';
    return;
  }
  const cfg=COLLEGE_CFG;
  eyebrowEl.textContent=(cfg.name||'College')+' · Assessment Portal';
  if(cfg.welcome){msgEl.textContent=cfg.welcome;msgEl.style.display='block';}
  const now=Date.now(), start=_toMs(cfg.startTime), expire=_toMs(cfg.expireTime);
  if(expire && now>expire){
    titleEl.textContent='Link Expired';
    statusEl.textContent='This assessment link expired on '+new Date(expire).toLocaleString('en-IN')+'. Please contact your coordinator for a new link.';
    return;
  }
  if(cfg.ended===true){
    titleEl.textContent='Assessment Closed';
    statusEl.textContent='The assessment for '+(cfg.name||'your college')+' has been closed by the administrator.';
    return;
  }
  if(start && now<start && cfg.open!==true){
    titleEl.textContent=(cfg.name||'Your College')+' Assessment';
    statusEl.textContent='Your assessment is scheduled. This portal will open automatically at the time below.';
    cdEl.style.display='block';
    _startGateCountdown(start);
    return;
  }
  if(cfg.open!==true){
    titleEl.textContent=(cfg.name||'Your College')+' Assessment';
    statusEl.textContent='The assessment has not started yet. Please keep this page open — it will update automatically when the administrator opens the assessment.';
    return;
  }
  // OPEN and valid → ready to enter
  titleEl.textContent=(cfg.name||'Your College')+' Assessment is Live';
  statusEl.textContent='Your assessment is now open. Click below to begin.';
  enterBtn.style.display='inline-flex';
}
function _startGateCountdown(target){
  const clockEl=document.getElementById('cg-clock');
  const tick=()=>{
    const diff=target-Date.now();
    if(diff<=0){clearInterval(collegeGateTimer);collegeGateTimer=null;evaluateCollegeGate();return;}
    const s=Math.floor(diff/1000);
    const d=Math.floor(s/86400),h=Math.floor((s%86400)/3600),m=Math.floor((s%3600)/60),ss=s%60;
    clockEl.textContent=(d>0?d+'d ':'')+String(h).padStart(2,'0')+':'+String(m).padStart(2,'0')+':'+String(ss).padStart(2,'0');
  };
  tick();collegeGateTimer=setInterval(tick,1000);
}
function collegeEnter(){
  collegeProceeded=true;
  applyCollegeInterface();
  if(COLLEGE_CFG&&COLLEGE_CFG.progKey){
    // College link has a programme configured — skip the manual picker entirely.
    S.prog=COLLEGE_CFG.prog;S.progKey=COLLEGE_CFG.progKey;
    goReg();
  }else{
    show('s-land');
  }
}
function applyCollegeInterface(){
  if(!COLLEGE_CFG) return;
  const c=COLLEGE_CFG;
  if(c.accent){try{document.documentElement.style.setProperty('--amber',c.accent);}catch(e){}}
  if(c.landTitle){const el=document.querySelector('.land-h1');if(el)el.innerHTML=c.landTitle;}
  if(c.landEyebrow){const el=document.querySelector('.land-eyebrow');if(el)el.textContent=c.landEyebrow;}
  if(c.name){const rt=document.getElementById('reg-title');if(rt)rt.textContent=c.name+' — Registration';}
}

// ═══════════════════════════════════════════════════════════
// ANONYMOUS QUESTION BANKS — no company names visible
// Questions shuffled per candidate via seeded random
// ═══════════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════════
// COGNITIVE GAME: PATTERN MEMORY (3×3 tile grid)
// ═══════════════════════════════════════════════════════════
let seqMemLevel=0, seqMemSequence=[], seqMemInput=[], seqMemScore=0, seqMemAccepting=false, seqMemTimer=null, seqMemDone=false;

function renderPatternMemGame(body){
  seqMemLevel=5; seqMemSequence=[]; seqMemInput=[]; seqMemScore=0; seqMemDone=false; seqMemAccepting=false;
  body.innerHTML=`
    <div class="game-wrap">
      <div class="game-title">🧩 Pattern Memory — Hard</div>
      <div class="game-sub">Watch the tiles light up in order, then repeat the pattern. Starts at length 5 and climbs to 10. One miss ends the game.</div>
      <div class="game-scoreboard">
        <div class="game-stat"><div class="game-stat-val" id="sm-score">0</div><div class="game-stat-lbl">Score</div></div>
        <div class="game-stat"><div class="game-stat-val" id="sm-level">5</div><div class="game-stat-lbl">Length</div></div>
        <div class="game-stat"><div class="game-stat-val" id="sm-round">1</div><div class="game-stat-lbl">Round</div></div>
      </div>
      <div class="pattern-mem-label" id="sm-label">Get Ready</div>
      <div class="pattern-grid" id="sm-grid">
        ${Array.from({length:9},(_,n)=>`<div class="pattern-tile" id="pt-${n}" onclick="patternMemInput_push(${n})"></div>`).join('')}
      </div>
      <div id="sm-feedback" style="font-size:13px;color:var(--amber);min-height:20px;margin-top:10px;text-align:center"></div>
      <div id="sm-done" style="display:none" class="game-done-overlay">
        <div style="font-size:32px;margin-bottom:.5rem">🧠</div>
        <div style="font-family:var(--fd);font-size:17px;font-weight:700;color:var(--amber)">Memory Round Complete!</div>
        <div style="font-size:12px;color:var(--text2);margin:.4rem 0">Score: <strong id="sm-final-score"></strong></div>
        <button type="button" class="btn-next" style="margin-top:1rem" onclick="finishPatternMem()">Continue to Math Blitz →</button>
      </div>
    </div>`;
  document.getElementById('btn-next').style.display='none';
  setTimeout(()=>patternMemStartRound(),800);
}

function patternMemStartRound(){
  seqMemInput=[];
  seqMemAccepting=false;
  seqMemSequence=Array.from({length:seqMemLevel},()=>Math.floor(Math.random()*9));
  document.getElementById('sm-feedback').textContent='';
  document.querySelectorAll('.pattern-tile').forEach(t=>t.classList.remove('lit','correct','wrong'));
  const lbl=document.getElementById('sm-label');
  lbl.textContent='Memorise!';
  let idx=0;
  seqMemTimer=setInterval(()=>{
    document.querySelectorAll('.pattern-tile').forEach(t=>t.classList.remove('lit'));
    if(idx<seqMemSequence.length){
      const tile=document.getElementById('pt-'+seqMemSequence[idx]);
      if(tile) tile.classList.add('lit');
      idx++;
    } else {
      clearInterval(seqMemTimer);
      lbl.textContent='Your turn!';
      seqMemAccepting=true;
    }
  },480);
}

function patternMemInput_push(n){
  if(!seqMemAccepting) return;
  const i=seqMemInput.length;
  seqMemInput.push(n);
  const tile=document.getElementById('pt-'+n);
  const isCorrectSoFar=n===seqMemSequence[i];
  if(tile){
    tile.classList.add(isCorrectSoFar?'correct':'wrong');
    setTimeout(()=>tile.classList.remove('correct','wrong'),300);
  }
  if(!isCorrectSoFar){
    seqMemAccepting=false;
    document.getElementById('sm-feedback').textContent='❌ Incorrect — game over!';
    S.gameScores.patternmem=Math.min(100,Math.round(seqMemScore/2.2));
    setTimeout(()=>{
      document.getElementById('sm-final-score').textContent=seqMemScore+' pts';
      document.getElementById('sm-done').style.display='block';
    },900);
    return;
  }
  if(seqMemInput.length===seqMemSequence.length){
    seqMemAccepting=false;
    seqMemScore+=seqMemLevel*10;
    document.getElementById('sm-score').textContent=seqMemScore;
    document.getElementById('sm-feedback').textContent='✅ Correct!';
    seqMemLevel++;
    if(seqMemLevel>10){
      // done — normalize to 0–100 for scoring
      S.gameScores.patternmem=Math.min(100,Math.round(seqMemScore/2.2));
      document.getElementById('sm-final-score').textContent=seqMemScore+' pts';
      document.getElementById('sm-done').style.display='block';
      return;
    }
    document.getElementById('sm-level').textContent=seqMemLevel;
    const roundEl=document.getElementById('sm-round');
    roundEl.textContent=parseInt(roundEl.textContent)+1;
    setTimeout(()=>patternMemStartRound(),1000);
  }
}

function finishPatternMem(){
  S.q=1; renderQ();
  document.getElementById('btn-next').style.display='';
}

// ═══════════════════════════════════════════════════════════
// COGNITIVE GAME: MATH BLITZ
// ═══════════════════════════════════════════════════════════
let mathQ=0, mathScore=0, mathStreak=0, mathTotal=12, mathTimer=null, mathTimeLeft=5, mathDone=false;
const MATH_SEC=5;

function renderMathBlitz(body){
  mathQ=0; mathScore=0; mathStreak=0; mathDone=false;
  body.innerHTML=`
    <div class="game-wrap">
      <div class="game-title">⚡ Math Blitz — Hard</div>
      <div class="game-sub">12 questions · ${MATH_SEC}s each · includes × ÷ and mixed ops.</div>
      <div class="game-scoreboard">
        <div class="game-stat"><div class="game-stat-val" id="mb-score">0</div><div class="game-stat-lbl">Score</div></div>
        <div class="game-stat"><div class="game-stat-val" id="mb-q">1/${mathTotal}</div><div class="game-stat-lbl">Question</div></div>
        <div class="game-stat"><div class="game-stat-val" id="mb-time" style="color:var(--red)">${MATH_SEC}</div><div class="game-stat-lbl">Seconds</div></div>
      </div>
      <div class="game-timebar"><div class="game-timebar-fill" id="mb-timebar" style="width:100%"></div></div>
      <div id="mb-q-area"></div>
      <div class="game-combo" id="mb-combo"></div>
    </div>`;
  nextMathQ();
}

function nextMathQ(){
  if(mathQ>=mathTotal){finishMath();return;}
  const roll=Math.random();
  let a,b,ans,op;
  if(roll<0.25){op='+';a=Math.floor(Math.random()*180)+40;b=Math.floor(Math.random()*160)+25;ans=a+b;}
  else if(roll<0.45){op='−';a=Math.floor(Math.random()*200)+80;b=Math.floor(Math.random()*70)+15;ans=a-b;}
  else if(roll<0.7){op='×';a=Math.floor(Math.random()*14)+7;b=Math.floor(Math.random()*12)+6;ans=a*b;}
  else{op='÷';b=Math.floor(Math.random()*11)+3;ans=Math.floor(Math.random()*14)+6;a=b*ans;}

  const wrongs=new Set();
  while(wrongs.size<3){
    const delta=[1,2,3,4,5,6,7,8,9,10,-1,-2,-3,-4,-5][Math.floor(Math.random()*15)];
    let w=ans+delta;
    if(op==='×') w=ans+(Math.floor(Math.random()*9)-4)*b;
    if(w!==ans&&w>0&&!wrongs.has(w)) wrongs.add(w);
  }
  const opts=[ans,...wrongs].sort(()=>Math.random()-.5);
  const correct=opts.indexOf(ans);
  window._mathCorrect=correct;

  clearInterval(mathTimer);
  mathTimeLeft=MATH_SEC;
  const barEl=document.getElementById('mb-timebar');
  mathTimer=setInterval(()=>{
    mathTimeLeft--;
    const tEl=document.getElementById('mb-time');
    if(tEl) tEl.textContent=mathTimeLeft;
    if(barEl) barEl.style.width=(mathTimeLeft/MATH_SEC*100)+'%';
    if(mathTimeLeft<=0){clearInterval(mathTimer);handleMathAnswer(-1,ans,opts);}
  },1000);

  document.getElementById('mb-q-area').innerHTML=`
    <div class="math-display">
      <div class="math-equation">${a} ${op} ${b} = ?</div>
    </div>
    <div class="math-opts">
      ${opts.map((o,oi)=>`<div class="math-opt" id="mb-opt-${oi}" onclick="handleMathAnswer(${oi},${ans},${JSON.stringify(opts)})">${o}</div>`).join('')}
    </div>`;
}

function handleMathAnswer(chosen,ans,opts){
  clearInterval(mathTimer);
  const correct=window._mathCorrect;
  const isCorrect=chosen===correct;
  document.querySelectorAll('.math-opt').forEach((el,i)=>{
    el.style.pointerEvents='none';
    if(i===correct) el.classList.add('correct');
    else if(i===chosen) el.classList.add('wrong');
  });
  if(isCorrect){
    mathScore+=10+mathStreak*2;
    mathStreak++;
    const combo=document.getElementById('mb-combo');
    if(mathStreak>1&&combo){combo.textContent='🔥 x'+mathStreak+' Combo!';setTimeout(()=>combo.textContent='',1500);}
  } else { mathStreak=0; }
  document.getElementById('mb-score').textContent=mathScore;
  mathQ++;
  document.getElementById('mb-q').textContent=mathQ+'/'+mathTotal;
  setTimeout(()=>nextMathQ(),600);
}

function finishMath(){
  clearInterval(mathTimer);
  mathDone=true;
  const maxRough=mathTotal*20;
  S.gameScores.mathblitz=Math.min(100,Math.round((mathScore/maxRough)*100));
  document.getElementById('mb-q-area').innerHTML=`
    <div class="game-done-overlay">
      <div style="font-size:32px;margin-bottom:.5rem">⚡</div>
      <div style="font-family:var(--fd);font-size:17px;font-weight:700;color:var(--amber)">Math Blitz Complete!</div>
      <div style="font-size:12px;color:var(--text2);margin:.4rem 0">Score: <strong style="color:var(--amber)">${mathScore}</strong> pts</div>
      <button type="button" class="btn-next" style="margin-top:1rem" onclick="finishMathGame()">Continue to Hard Puzzles →</button>
    </div>`;
}

function finishMathGame(){
  S.q=2; renderQ();
  document.getElementById('btn-next').style.display='';
}

// ═══════════════════════════════════════════════════════════
// GAME RENDERER
// ═══════════════════════════════════════════════════════════
function renderGame(q, roundIdx){
  const body=document.getElementById('ass-body');
  if(q.gameType==='patternmem'){
    renderPatternMemGame(body);
    document.getElementById('btn-next').style.display='none';
  } else if(q.gameType==='mathblitz'){
    renderMathBlitz(body);
    document.getElementById('btn-next').style.display='none';
  } else {
    renderNormalQ(q,roundIdx);
  }
}

// ═══════════════════════════════════════════════════════════
// VIOLATION MONITORING
// ═══════════════════════════════════════════════════════════
function startMonitoring(){
  assessmentActive=true; violationCount=0;
  document.addEventListener('visibilitychange',onVis);
  document.addEventListener('contextmenu',onCtx);
  document.addEventListener('copy',onCopy);
  document.addEventListener('keydown',onKey);
  document.addEventListener('fullscreenchange',onFS);
  try{document.documentElement.requestFullscreen();}catch(e){}
  checkRemoteAccessSignals();
  checkVirtualCamera();
}

// ═══════════════════════════════════════════════════════════
// REMOTE-ACCESS BEST-EFFORT SIGNALS
// Browser JS cannot see other running processes, so this cannot reliably
// detect UltraViewer/AnyDesk/TeamViewer etc. These are supplementary, informational
// signals only — logged for HR review, never counted toward auto-termination.
// ═══════════════════════════════════════════════════════════
function flagSignal(reason){
  syncToHR({type:'flag',candidateName:(S.cand.fname||'')+' '+(S.cand.lname||''),candidateEmail:S.cand.email||'',reason,round:S.round+1,timestamp:new Date().toISOString(),deviceId:getDeviceId()});
}
function checkRemoteAccessSignals(){
  try{
    if(window.screen&&window.screen.isExtended===true){
      flagSignal('Multiple displays detected');
    }
  }catch(e){}
}
async function checkVirtualCamera(){
  try{
    if(!navigator.mediaDevices||!navigator.mediaDevices.enumerateDevices)return;
    const devices=await navigator.mediaDevices.enumerateDevices();
    const suspicious=/obs|virtual|manycam|iriun|droidcam|snap camera|epoccam|ivcam|camtwist|xsplit|ndi/i;
    const hit=devices.find(d=>d.kind==='videoinput'&&suspicious.test(d.label||''));
    if(hit) flagSignal('Possible virtual camera device: '+hit.label);
  }catch(e){}
}
function stopMonitoring(){
  assessmentActive=false;
  document.removeEventListener('visibilitychange',onVis);
  document.removeEventListener('contextmenu',onCtx);
  document.removeEventListener('copy',onCopy);
  document.removeEventListener('keydown',onKey);
  document.removeEventListener('fullscreenchange',onFS);
  stopCam();
}
function onVis(){if(assessmentActive&&document.hidden)triggerViolation('Tab switch / window minimise');}
function onCtx(e){if(assessmentActive){e.preventDefault();triggerViolation('Right-click attempt');}}
function onCopy(e){if(assessmentActive){e.preventDefault();triggerViolation('Copy attempt');}}
function onKey(e){
  if(!assessmentActive) return;
  const block=(e.ctrlKey&&['c','x','v','a','u','p','s'].includes(e.key.toLowerCase()))||
    e.key==='F12'||(e.ctrlKey&&e.shiftKey&&['I','J'].includes(e.key))||e.key==='PrintScreen';
  if(block){e.preventDefault();triggerViolation('Keyboard shortcut: '+(e.ctrlKey?'Ctrl+':'')+e.key);}
}
function onFS(){if(assessmentActive&&!document.fullscreenElement)triggerViolation('Fullscreen exit');}

function triggerViolation(reason){
  violationCount++;
  syncToHR({type:'violation',candidateName:(S.cand.fname||'')+' '+(S.cand.lname||''),
    candidateEmail:S.cand.email||'',count:violationCount,reason,round:S.round+1,timestamp:new Date().toISOString(),deviceId:getDeviceId()});
  const pill=document.getElementById('p-viol-pill');
  if(pill){pill.style.display='inline';pill.textContent='⚠ '+violationCount+' violation'+(violationCount!==1?'s':'')}
  if(violationCount>=MAX_VIOLATIONS){terminateAssessment();return;}
  document.getElementById('viol-num').textContent=violationCount;
  document.getElementById('viol-msg').textContent=reason+'. Logged.';
  document.getElementById('viol-remain').textContent=(MAX_VIOLATIONS-violationCount);
  document.getElementById('viol-overlay').classList.add('show');
}
function resumeViolation(){document.getElementById('viol-overlay').classList.remove('show');try{document.documentElement.requestFullscreen();}catch(e){}}
function terminateAssessment(){
  stopMonitoring();
  document.getElementById('viol-overlay').classList.remove('show');
  blockDevice(S.cand.email||null);
  syncToHR({type:'terminated',candidateName:(S.cand.fname||'')+' '+(S.cand.lname||''),candidateEmail:S.cand.email||'',timestamp:new Date().toISOString(),deviceId:getDeviceId()});
  document.getElementById('term-device-id').textContent='Device: '+getDeviceId();
  show('s-term');
}

// ═══════════════════════════════════════════════════════════
// CAMERA
// ═══════════════════════════════════════════════════════════
async function startCam(){
  if(camStream){showCamPip('on');return;}   // already running — just ensure preview is visible
  try{
    camStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'user'},audio:false});
    document.getElementById('cam-vid').srcObject=camStream;
    await document.getElementById('cam-vid').play();
    setCamStatus(true);
    showCamPip('on');
    photoInterval=setInterval(()=>capturePhoto('auto'),90000);
    setTimeout(()=>capturePhoto('initial'),4000);
  }catch(e){setCamStatus(false);showCamPip('nocam');}
}
function stopCam(){if(camStream){camStream.getTracks().forEach(t=>t.stop());camStream=null;}if(photoInterval){clearInterval(photoInterval);photoInterval=null;}showCamPip('off');}
function showCamPip(state){
  const pip=document.getElementById('cam-pip');if(!pip)return;
  if(state==='on'){pip.classList.add('show');pip.classList.remove('no-cam');}
  else if(state==='nocam'){pip.classList.add('show','no-cam');}
  else{pip.classList.remove('show');}
}
function toggleCamPip(e){
  if(e){e.stopPropagation();}
  const pip=document.getElementById('cam-pip');if(!pip)return;
  pip.classList.toggle('minimized');
  const btn=document.getElementById('cam-pip-min');
  if(btn)btn.textContent=pip.classList.contains('minimized')?'+':'▢';
}
(function initCamDrag(){
  let sx,sy,ox,oy,drag=false;
  const start=e=>{
    const pip=document.getElementById('cam-pip');
    if(!pip||!e.target.closest('#cam-pip')||e.target.classList.contains('cam-pip-min'))return;
    drag=true;pip.classList.add('dragging');
    const r=pip.getBoundingClientRect();
    sx=(e.touches?e.touches[0].clientX:e.clientX);sy=(e.touches?e.touches[0].clientY:e.clientY);
    ox=r.left;oy=r.top;
    pip.style.right='auto';pip.style.bottom='auto';pip.style.left=ox+'px';pip.style.top=oy+'px';
    if(e.cancelable)e.preventDefault();
  };
  const move=e=>{
    if(!drag)return;const pip=document.getElementById('cam-pip');if(!pip)return;
    const cx=(e.touches?e.touches[0].clientX:e.clientX),cy=(e.touches?e.touches[0].clientY:e.clientY);
    let nx=ox+(cx-sx),ny=oy+(cy-sy);
    nx=Math.max(4,Math.min(window.innerWidth-pip.offsetWidth-4,nx));
    ny=Math.max(4,Math.min(window.innerHeight-pip.offsetHeight-4,ny));
    pip.style.left=nx+'px';pip.style.top=ny+'px';
  };
  const end=()=>{drag=false;const pip=document.getElementById('cam-pip');if(pip)pip.classList.remove('dragging');};
  document.addEventListener('mousedown',start);document.addEventListener('mousemove',move);document.addEventListener('mouseup',end);
  document.addEventListener('touchstart',start,{passive:false});document.addEventListener('touchmove',move,{passive:false});document.addEventListener('touchend',end);
})();
function setCamStatus(ok){
  const dot=document.getElementById('p-dot'),txt=document.getElementById('p-cam-txt');
  if(dot) dot.className='proctor-dot'+(ok?'':' off');
  if(txt) txt.textContent=ok?'Live proctoring active':'Camera unavailable — tab activity monitored';
  const img=document.getElementById('p-cam-img');if(img)img.style.display=ok?'block':'none';
}
function capturePhoto(reason){
  const vid=document.getElementById('cam-vid'),cvs=document.getElementById('cam-canvas');
  if(!vid||!cvs||!camStream) return null;
  cvs.width=320;cvs.height=240;
  cvs.getContext('2d').drawImage(vid,0,0,320,240);
  const url=cvs.toDataURL('image/jpeg',0.7);
  capturedPhotos.push({time:new Date().toISOString(),reason,url});
  const img=document.getElementById('p-cam-img');
  if(img){img.src=url;img.style.display='block';}
  return url;
}
function manualCapture(){const url=capturePhoto('manual');if(url)showToast('📸 Photo captured','success');else showToast('Camera not available','warn');}

// ═══════════════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════════════
function show(id){document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));document.getElementById(id).classList.add('active');}
function selProg(el,name,key){document.querySelectorAll('.prog-card').forEach(c=>c.classList.remove('sel'));el.classList.add('sel');S.prog=name;S.progKey=key;document.getElementById('btn-start').disabled=false;}
function goReg(){if(!S.prog)return;document.getElementById('r-prog').value=S.prog;S.candSeq=parseInt(localStorage.getItem('apex_cand_seq')||'0')+1;localStorage.setItem('apex_cand_seq',S.candSeq);populateRegDropdowns();show('s-reg');}
function regBack(){
  // College links with a programme configured skip s-land entirely, so send those candidates
  // back to the college gate on "Back" instead of a picker screen they never saw.
  if(COLLEGE_ID&&COLLEGE_CFG&&COLLEGE_CFG.progKey){show('s-college');}
  else{show('s-land');}
}

function submitReg(){
  const fn=document.getElementById('r-fn').value.trim();
  const ln=document.getElementById('r-ln').value.trim();
  const em=document.getElementById('r-em').value.trim().toLowerCase();
  let col=document.getElementById('r-col').value.trim();
  if(col==='__other__'){col=(document.getElementById('r-col-other').value||'').trim();}
  const pass=document.getElementById('r-pass').value.trim();
  const deg=document.getElementById('r-deg').value.trim();
  const resumeFile=(document.getElementById('r-resume').files||[])[0];
  if(!fn||!ln||!em||!col||!pass||!deg){showToast('Please fill all required fields','warn');return;}
  if(!resumeFile){showToast('Please upload your resume','warn');return;}
  if(!/\.(pdf|doc|docx)$/i.test(resumeFile.name)){showToast('Resume must be a PDF or Word document','warn');return;}
  if(resumeFile.size>5*1024*1024){showToast('Resume must be under 5MB','warn');return;}
  lastAttemptEmail=em;
  // Check local blocks immediately (sync)
  if(isDeviceBlocked()){showBlocked();return;}
  if(isEmailBlocked(em)){showBlocked();return;}
  // Firebase block check runs in background - won't block flow
  checkFirebaseBlock(em).then(blocked=>{if(blocked){show('s-blocked');}}).catch(()=>{});
  S.cand={fname:fn,lname:ln,email:em,college:col,passYear:pass,deg:deg,phone:document.getElementById('r-ph').value};
  S.round=0;S.q=0;S.ans={};S.done=[];S.scores=[];
  startCam();   // request camera now so the live preview shows from registration onward
  const regRecord={...S.cand,prog:S.prog,progKey:S.progKey,collegeId:COLLEGE_ID||'',scores:[],completedRounds:0,status:'in_progress',submittedAt:null,registeredAt:new Date().toISOString(),violations:0,deviceId:getDeviceId()};
  dbSave(regRecord);
  syncToHR({type:'registered',...regRecord});
  uploadResume(em,resumeFile).catch(e=>{console.warn('[Apex] Resume upload failed:',e&&e.message);showToast('Resume upload failed — please notify HR','warn');});
  renderOV();show('s-ov');
}

// ── Registration dropdown population ──────────────────────────
const COLLEGE_LIST=['Indian Institute of Management (IIM)','Indian Institute of Technology (IIT)','XLRI Jamshedpur','Faculty of Management Studies (FMS), Delhi','Symbiosis Institute of Business Management','Narsee Monjee (NMIMS)','SP Jain Institute of Management','Management Development Institute (MDI)','Indian School of Business (ISB)','Christ University','St. Xavier\u2019s College','Loyola College','Osmania University','JNTU Hyderabad','ICFAI Business School','Great Lakes Institute of Management','Welingkar Institute','TA Pai Management Institute (TAPMI)'];
const DEGREE_LIST=['MBA \u2014 Marketing','MBA \u2014 Finance','MBA \u2014 Operations','MBA \u2014 HR','MBA \u2014 General Management','PGDM','BBA','B.Com','B.Tech','M.Tech','B.Sc','M.Sc','B.A','M.A','Other'];
function populateRegDropdowns(){
  const colSel=document.getElementById('r-col');
  const degSel=document.getElementById('r-deg');
  const passSel=document.getElementById('r-pass');
  if(passSel&&passSel.options.length<=1){
    const yNow=new Date().getFullYear();
    for(let y=yNow+2;y>=yNow-6;y--){const o=document.createElement('option');o.value=String(y);o.textContent=String(y);passSel.appendChild(o);}
  }
  if(degSel&&degSel.options.length<=1){
    DEGREE_LIST.forEach(d=>{const o=document.createElement('option');o.value=d;o.textContent=d;degSel.appendChild(o);});
  }
  if(colSel&&colSel.options.length<=1){
    COLLEGE_LIST.forEach(c=>{const o=document.createElement('option');o.value=c;o.textContent=c;colSel.appendChild(o);});
    const oo=document.createElement('option');oo.value='__other__';oo.textContent='Other / Not listed…';colSel.appendChild(oo);
  }
  // If launched via a college-specific link, lock the college field
  if(COLLEGE_ID&&COLLEGE_CFG&&COLLEGE_CFG.name&&colSel){
    let found=Array.from(colSel.options).find(o=>o.value===COLLEGE_CFG.name);
    if(!found){const o=document.createElement('option');o.value=COLLEGE_CFG.name;o.textContent=COLLEGE_CFG.name;colSel.insertBefore(o,colSel.options[1]);}
    colSel.value=COLLEGE_CFG.name;colSel.disabled=true;
    const other=document.getElementById('r-col-other');if(other)other.style.display='none';
  }
}
function onCollegeChange(){
  const colSel=document.getElementById('r-col');
  const other=document.getElementById('r-col-other');
  if(colSel&&other) other.style.display=(colSel.value==='__other__')?'block':'none';
}

// ═══════════════════════════════════════════════════════════
// OVERVIEW
// ═══════════════════════════════════════════════════════════
function renderOV(){
  const inits=((S.cand.fname||'?')[0]+(S.cand.lname||'?')[0]).toUpperCase();
  document.getElementById('ov-avatar').textContent=inits;
  document.getElementById('ov-name').textContent=(S.cand.fname||'')+' '+(S.cand.lname||'');
  document.getElementById('ov-sub').textContent=S.prog+' · '+(S.cand.college||'');
  document.getElementById('ov-pct').textContent=S.done.length+'/6';
  const g=document.getElementById('rounds-grid');g.innerHTML='';
  ROUNDS.forEach((r,i)=>{
    const done=S.done.includes(i),locked=i>0&&!S.done.includes(i-1);
    const el=document.createElement('div');
    el.className='r-card'+(locked?' locked':done?' done':'');
    el.innerHTML=(locked?'<div style="position:absolute;top:9px;right:9px;font-size:9px;color:rgba(255,255,255,.14)">LOCKED</div>':done?'<div style="position:absolute;top:9px;right:9px;font-size:9px;color:rgba(34,197,94,.6);font-weight:700">✓ DONE</div>':'')+
      '<div class="r-num">Round '+(i+1)+'</div>'+
      '<div class="r-name">'+r.name+'</div>'+'<div class="r-desc">'+r.desc+'</div>'+
      '<div class="r-meta"><span style="font-size:9px;color:var(--muted)">⏱ '+Math.floor(r.dur/60)+' min</span>'+
      '<span class="r-badge '+(done?'b-done':locked?'b-lock':'b-ready')+'">'+  (done?'✓ Done':locked?'Locked':'Ready')+'</span></div>';
    if(!locked&&!done) el.onclick=()=>launchRound(i);
    g.appendChild(el);
  });
}

// ═══════════════════════════════════════════════════════════
// ASSESSMENT ENGINE
// ═══════════════════════════════════════════════════════════
function launchRound(idx){
  S.round=idx;S.q=0;curR=ROUNDS[idx];
  if(!S.ans[idx])S.ans[idx]={};
  // Don't shuffle game round - order matters (patternmem -> mathblitz -> puzzles)
  curR._sq=curR.isGame ? [...curR.qs] : seededShuffle([...curR.qs],S.candSeq*13+idx*7);
  // Shuffle answer options per candidate too
  curR._sq=curR._sq.map(q=>{
    if(q.gameType||q.seq) return q;
    const shuffledOpts=[...q.opts];
    const originalCorrect=CORRECT_ANS[idx][curR.qs.indexOf(q)];
    const correctText=q.opts[originalCorrect];
    seededShuffleArr(shuffledOpts,S.candSeq*17+idx*11+curR.qs.indexOf(q)*3);
    const newCorrect=shuffledOpts.indexOf(correctText);
    return {...q,opts:shuffledOpts,_correct:newCorrect};
  });
  document.getElementById('ass-round-lbl').textContent='Round '+(idx+1)+' — '+curR.name;
  document.getElementById('ass-round-sub').textContent=curR.tlbl+' · '+curR.qs.length+' questions';
  timeLeft=curR.dur;startTimer();renderQ();show('s-ass');
  if(!assessmentActive){startCam();startMonitoring();}
  syncToHR({type:'round_start',round:idx+1,roundName:curR.name,candidateName:(S.cand.fname||'')+' '+(S.cand.lname||''),candidateEmail:S.cand.email||'',timestamp:new Date().toISOString()});
}

function startTimer(){
  clearInterval(timerInt);
  timerInt=setInterval(()=>{
    timeLeft--;
    const el=document.getElementById('timer');
    const m=Math.floor(timeLeft/60),s=timeLeft%60;
    el.textContent='⏱ '+String(m).padStart(2,'0')+ ':'+String(s).padStart(2,'0');
    if(timeLeft<=60)el.classList.add('warn');else el.classList.remove('warn');
    if(timeLeft<=0){clearInterval(timerInt);submitRound();}
  },1000);
}

function renderQ(){
  const qs=curR._sq||curR.qs,q=qs[S.q],tot=qs.length;
  // update dots
  const dotsEl=document.getElementById('q-dots');
  if(dotsEl){
    dotsEl.innerHTML='';
    for(let i=0;i<tot;i++){
      const d=document.createElement('div');
      d.className='q-dot'+(S.ans[S.round]&&S.ans[S.round][i]!==undefined?' answered':'')+(i===S.q?' current':'');
      dotsEl.appendChild(d);
    }
  }
  document.getElementById('prog-fill').style.width=(S.q/tot*100)+'%';
  document.getElementById('q-ctr').textContent='Question '+(S.q+1)+' of '+tot;
  document.getElementById('btn-prev').style.display=S.q===0?'none':'';
  document.getElementById('btn-next').textContent=S.q===tot-1?'Submit Round ✓':'Next →';
  document.getElementById('btn-next').style.display='';
  if(curR.isGame&&q.gameType){renderGame(q,S.round);return;}
  renderNormalQ(q,S.round);
}

function renderNormalQ(q,roundIdx){
  const qs=curR._sq||curR.qs,tot=qs.length;
  const body=document.getElementById('ass-body');
  let html='<div class="q-eyebrow"><span>'+(curR.tlbl||'Q')+'</span><span class="q-counter">Q'+(S.q+1)+' / '+tot+'</span></div>';
  html+='<div class="q-text">'+(q.text||q.q||'Question')+'</div>';
  if(q.ctx) html+='<div class="q-ctx">📌 '+q.ctx+'</div>';
  if(q.fig) html+='<div class="q-fig">'+q.fig+'</div>';
  if(q.seq&&q.seqLabels) html+='<div class="seq-row">'+q.seqLabels.map((l,si)=>'<div class="seq-cell"><div class="seq-cell-lbl">'+l+'</div><div class="seq-cell-val">'+(q.seqVals&&q.seqVals[si]||'?')+ '</div></div>').join('')+'</div>';
  if(q.table) html+='<table class="q-tbl"><thead><tr>'+q.table.hdrs.map(h=>'<th>'+h+'</th>').join('')+'</tr></thead><tbody>'+q.table.rows.map(row=>'<tr>'+row.map(c=>'<td>'+c+'</td>').join('')+'</tr>').join('')+'</tbody></table>';
  const sel=S.ans[S.round]&&S.ans[S.round][S.q];
  html+='<div class="opts">'+(q.opts||[]).map((opt,oi)=>'<div class="opt '+(sel===oi?'sel':'')+'" onclick="selA('+oi+')"><div class="opt-ltr">'+String.fromCharCode(65+oi)+'</div><div>'+opt+'</div></div>').join('')+'</div>';
  body.innerHTML=html;
}

function selA(i){if(!S.ans[S.round])S.ans[S.round]={};S.ans[S.round][S.q]=i;renderQ();}
function prevQ(){if(S.q>0){S.q--;renderQ();}}
function nextQ(){if(S.q<(curR._sq||curR.qs).length-1){S.q++;renderQ();}else submitRound();}

function submitRound(){
  clearInterval(timerInt);clearInterval(seqMemTimer);clearInterval(mathTimer);
  const qs=curR._sq||curR.qs,ans=S.ans[S.round]||{};
  let correct=0;
  qs.forEach((q,i)=>{
    if(q.gameType){correct++;return;}
    const a=ans[i];
    const correctIdx=q._correct!==undefined?q._correct:CORRECT_ANS[S.round][curR.qs.indexOf(q)];
    if(typeof correctIdx==='number'&&a===correctIdx) correct++;
  });
  let score;
  if(curR.isGame){
    const qs=curR._sq||curR.qs;
    let puzzleCorrect=0,puzzleTotal=0;
    qs.forEach((q,i)=>{
      if(q.gameType) return;
      puzzleTotal++;
      const a=ans[i];
      const correctIdx=q._correct!==undefined?q._correct:CORRECT_ANS[S.round][curR.qs.indexOf(q)];
      if(typeof correctIdx==='number'&&a===correctIdx) puzzleCorrect++;
    });
    const puzzlePct=puzzleTotal?Math.round((puzzleCorrect/puzzleTotal)*100):70;
    const memPct=typeof S.gameScores.patternmem==='number'?S.gameScores.patternmem:55;
    const mathPct=typeof S.gameScores.mathblitz==='number'?S.gameScores.mathblitz:55;
    score=Math.round((memPct+mathPct+puzzlePct)/3);
  } else if(curR.id==='sjt'||curR.id==='predictive'){
    score=Math.round(62+Math.random()*26);
  } else {
    score=Math.round((correct/qs.length)*100);
  }
  S.scores.push({r:S.round,score});
  if(!S.done.includes(S.round))S.done.push(S.round);
  const isLast=S.done.length>=ROUNDS.length;
  const roundScores=ROUNDS.map((_,i)=>{const sc=S.scores.find(s=>s.r===i);return sc?sc.score:null;});
  const record={
    fname:S.cand.fname,lname:S.cand.lname,email:S.cand.email,
    college:S.cand.college,deg:S.cand.deg,phone:S.cand.phone||'',
    prog:S.prog,progKey:S.progKey,
    scores:roundScores.filter(s=>s!==null),
    completedRounds:S.done.length,violations:violationCount,
    status:isLast?'completed':'in_progress',
    submittedAt:isLast?new Date().toISOString():null,
    registeredAt:S.cand.registeredAt||'',
    deviceId:getDeviceId()
  };
  dbSave(record);
  syncToHR({type:isLast?'completed':'round_completed',...record,roundJustCompleted:S.round+1,roundScore:score,timestamp:new Date().toISOString()});
  if(isLast){stopMonitoring();}
  document.getElementById('rd-icon').textContent=isLast?'🏆':'✦';
  document.getElementById('rd-title').textContent=isLast?'Assessment Complete! 🎉':'Round '+(S.round+1)+' Complete';
  document.getElementById('rd-sub').textContent=isLast?'All 6 rounds submitted. Outstanding effort.':'Responses captured and locked.';
  document.getElementById('rd-saved').textContent='✅ Saved to HR dashboard';
  document.getElementById('btn-rd-next').textContent=isLast?'View Confirmation ✓':'Continue to Round '+(S.round+2)+' →';
  show('s-rd');
}

function rdNext(){
  if(S.done.length>=ROUNDS.length){
    show('s-feedback');
  } else {renderOV();show('s-ov');}
}

// ═══════════════════════════════════════════════════════════
// POST-TEST RATING & FEEDBACK
// ═══════════════════════════════════════════════════════════
let feedbackRating=0;
function setRating(n){
  feedbackRating=n;
  document.querySelectorAll('#fb-stars .star').forEach(s=>{
    s.classList.toggle('on',parseInt(s.dataset.n,10)<=n);
  });
}
function submitFeedback(){
  if(!feedbackRating){showToast('Please select a star rating','warn');return;}
  const feedbackText=(document.getElementById('fb-text').value||'').trim();
  const email=S.cand.email||'';
  if(email){
    setFeedback(email,feedbackRating,feedbackText).catch(e=>console.warn('[Apex] feedback save failed:',e&&e.message));
  }
  sendConfirmationEmail();
  document.getElementById('sub-saved').textContent='✅ Results live in HR Dashboard';
  show('s-sub');
}

// ═══════════════════════════════════════════════════════════
// SHUFFLE UTILS
// ═══════════════════════════════════════════════════════════
function seededShuffle(arr,seed){
  let s=seed>>>0;
  const rnd=()=>{s=(s*1664525+1013904223)>>>0;return s/0x100000000;};
  const a=[...arr];
  for(let i=a.length-1;i>0;i--){const j=Math.floor(rnd()*(i+1));[a[i],a[j]]=[a[j],a[i]];}
  return a;
}
function seededShuffleArr(arr,seed){
  let s=seed>>>0;
  const rnd=()=>{s=(s*1664525+1013904223)>>>0;return s/0x100000000;};
  for(let i=arr.length-1;i>0;i--){const j=Math.floor(rnd()*(i+1));[arr[i],arr[j]]=[arr[j],arr[i]];}
}

// ═══════════════════════════════════════════════════════════
// CERTIFICATE
// ═══════════════════════════════════════════════════════════
function showMyCert(){
  document.getElementById('c-name').textContent=(S.cand.fname||'')+' '+(S.cand.lname||'');
  document.getElementById('c-detail').innerHTML='Programme: <strong style="color:var(--amber)">'+S.prog+'</strong> &nbsp;|&nbsp; College: <strong>'+S.cand.college+'</strong> &nbsp;|&nbsp; Date: <strong>'+new Date().toLocaleDateString('en-IN',{day:'2-digit',month:'long',year:'numeric'})+'</strong>';
  document.getElementById('c-ring').style.setProperty('--p',100);
  document.getElementById('c-score').textContent='✓';
  document.getElementById('c-id').textContent='CERT-'+Date.now().toString(36).toUpperCase();
  document.getElementById('c-status').textContent='ASSESSMENT SUBMITTED';
  document.getElementById('c-rounds').innerHTML=ROUND_NAMES.map((rn,i)=>S.done.includes(i)?
    '<span style="background:rgba(34,197,94,.09);border:1px solid rgba(34,197,94,.18);border-radius:100px;padding:2px 9px;font-size:9px;color:var(--green)">'+rn+' ✓</span>':'').join('');
  document.getElementById('cert-overlay').classList.add('show');
}
function closeCert(){document.getElementById('cert-overlay').classList.remove('show');}

// ═══════════════════════════════════════════════════════════
// EMAIL
// ═══════════════════════════════════════════════════════════
async function sendConfirmationEmail(){
  const {email,fname,lname,college}=S.cand;
  if(!email) return;
  const name=fname+' '+lname;
  const certId='CERT-'+Date.now().toString(36).toUpperCase();
  try{
    const certImageBase64=renderCertificatePNG({name,programme:S.prog,college,statusText:'ASSESSMENT SUBMITTED',certId});
    await sendMail('confirmation',{to:email,name,college,programme:S.prog,certId,certImageBase64});
    const s=document.getElementById('sub-email-strip');if(s)s.style.display='flex';
  }catch(e){console.warn('[Apex] confirmation email failed:',e&&e.message);}
  setCertId(email, certId).catch(()=>{});
}

// ═══════════════════════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════════════════════
function showToast(msg,type){
  const el=document.getElementById('toast');
  const c={success:'rgba(34,197,94,.95)',warn:'rgba(234,179,8,.95)',error:'rgba(239,68,68,.95)'};
  el.style.background=c[type]||c.success;el.textContent=msg;el.style.display='block';
  clearTimeout(el._t);el._t=setTimeout(()=>el.style.display='none',3000);
}

// ═══════════════════════════════════════════════════════════
// ENTRANCE
// ═══════════════════════════════════════════════════════════
(function entrance(){
  if(isMobileDevice()){showDeviceBlocked();return;}
  initFirebase();initLiveSync();
  if(isDeviceBlocked()){
    const bar=document.getElementById('ent-bar');if(bar)bar.style.width='100%';
    setTimeout(()=>showBlocked(),800);return;
  }
  const bar=document.getElementById('ent-bar'),lbl=document.getElementById('ent-label');
  const labels=['Loading Assessment Engine','Connecting HR Dashboard','Initialising Proctoring','Ready'];
  let p=0,li=0;
  const iv=setInterval(()=>{
    p+=2;if(bar)bar.style.width=p+'%';
    if(p%25===0&&lbl&&li<labels.length)lbl.textContent=labels[li++];
    if(p>=100){
      clearInterval(iv);
      const ent=document.getElementById('s-entrance');
      ent.style.transition='opacity .5s';ent.style.opacity='0';
      setTimeout(()=>{
        ent.style.display='none';
        if(COLLEGE_ID){show('s-college');evaluateCollegeGate();
          setTimeout(()=>{
            if(!collegeLoaded){
              const t=document.getElementById('cg-title'),s=document.getElementById('cg-status');
              if(t)t.textContent='Connection Issue';
              if(s)s.textContent='We could not verify your assessment link. Please check your internet connection and refresh this page.';
            }
          },10000);
        }
        else show('s-land');
      },500);
    }
  },28);
})();


// Expose handlers for inline HTML onclick (ES modules are scoped)
window.getDeviceId = getDeviceId;
window.isDeviceBlocked = isDeviceBlocked;
window.blockDevice = blockDevice;
window.isEmailBlocked = isEmailBlocked;
window.checkFirebaseBlock = checkFirebaseBlock;
window.showBlocked = showBlocked;
window.isMobileDevice = isMobileDevice;
window.showDeviceBlocked = showDeviceBlocked;
window.initFirebase = initFirebase;
window.initLiveSync = initLiveSync;
window.syncToHR = syncToHR;
window._flushSync = _flushSync;
window._drainPendingSync = _drainPendingSync;
window.dbSave = dbSave;
window.attachCustomQuestionListener = attachCustomQuestionListener;
window._toMs = _toMs;
window.attachCollegeListener = attachCollegeListener;
window.recoverIfUnblocked = recoverIfUnblocked;
window.attachBlockSyncListener = attachBlockSyncListener;
window.evaluateCollegeGate = evaluateCollegeGate;
window._startGateCountdown = _startGateCountdown;
window.collegeEnter = collegeEnter;
window.applyCollegeInterface = applyCollegeInterface;
window.renderPatternMemGame = renderPatternMemGame;
window.patternMemStartRound = patternMemStartRound;
window.patternMemInput_push = patternMemInput_push;
window.finishPatternMem = finishPatternMem;
window.renderMathBlitz = renderMathBlitz;
window.nextMathQ = nextMathQ;
window.handleMathAnswer = handleMathAnswer;
window.finishMath = finishMath;
window.finishMathGame = finishMathGame;
window.renderGame = renderGame;
window.startMonitoring = startMonitoring;
window.stopMonitoring = stopMonitoring;
window.flagSignal = flagSignal;
window.checkRemoteAccessSignals = checkRemoteAccessSignals;
window.checkVirtualCamera = checkVirtualCamera;
window.onVis = onVis;
window.onCtx = onCtx;
window.onCopy = onCopy;
window.onKey = onKey;
window.onFS = onFS;
window.triggerViolation = triggerViolation;
window.resumeViolation = resumeViolation;
window.terminateAssessment = terminateAssessment;
window.startCam = startCam;
window.stopCam = stopCam;
window.showCamPip = showCamPip;
window.toggleCamPip = toggleCamPip;
window.setCamStatus = setCamStatus;
window.capturePhoto = capturePhoto;
window.manualCapture = manualCapture;
window.show = show;
window.selProg = selProg;
window.goReg = goReg;
window.regBack = regBack;
window.submitReg = submitReg;
window.populateRegDropdowns = populateRegDropdowns;
window.onCollegeChange = onCollegeChange;
window.renderOV = renderOV;
window.launchRound = launchRound;
window.startTimer = startTimer;
window.renderQ = renderQ;
window.renderNormalQ = renderNormalQ;
window.selA = selA;
window.prevQ = prevQ;
window.nextQ = nextQ;
window.submitRound = submitRound;
window.rdNext = rdNext;
window.setRating = setRating;
window.submitFeedback = submitFeedback;
window.seededShuffle = seededShuffle;
window.seededShuffleArr = seededShuffleArr;
window.showMyCert = showMyCert;
window.closeCert = closeCert;
window.sendConfirmationEmail = sendConfirmationEmail;
window.showToast = showToast;

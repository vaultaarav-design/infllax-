/**
 * ISI Terminal — Session Lock Sticker
 * Appears 2 minutes before 30-min session expires
 * Draggable, countdown, locks on expiry
 * v6.02
 */

(function() {
'use strict';

const LOCK_INTERVAL = 30 * 60 * 1000;   // 30 minutes
const WARN_BEFORE   =  2 * 60 * 1000;   // warn 2 min before
const LS_LAST_AUTH  = 'isi_last_auth';
const LS_PERM_KEYS  = 'isi_perm_keys';
const LS_TEMP_PASS  = 'isi_temp_pass';

let _locked  = false;
let _stkEl   = null;
let _overlayEl = null;
let _cdTimer = null;
let _monitorTimer = null;
let _dragging = false, _dragOX = 0, _dragOY = 0;

// ── CSS ──────────────────────────────────────────────────────
const STYLE = `
#isi-lock-sticker{
  position:fixed; z-index:999990;
  bottom:80px; right:28px;
  width:148px;
  background:linear-gradient(135deg,#0a0800,#100f00);
  border:1.5px solid #c5a059;
  border-radius:10px;
  padding:10px 12px 10px 12px;
  box-shadow:0 4px 24px rgba(197,160,89,0.18), 0 0 0 1px rgba(197,160,89,0.06);
  cursor:grab;
  user-select:none;
  display:none;
  font-family:'Segoe UI',sans-serif;
  transition: box-shadow 0.2s;
  backdrop-filter:blur(6px);
}
#isi-lock-sticker:active{ cursor:grabbing; box-shadow:0 8px 32px rgba(197,160,89,0.28); }
#isi-lock-sticker.warn{
  border-color:#ff8c00;
  box-shadow:0 4px 24px rgba(255,140,0,0.25), 0 0 16px rgba(255,140,0,0.10);
  animation: isiWarnPulse 2s ease-in-out infinite;
}
#isi-lock-sticker.crit{
  border-color:#ff3b3b;
  box-shadow:0 4px 24px rgba(255,59,59,0.35), 0 0 16px rgba(255,59,59,0.15);
  animation: isiCritPulse 1s ease-in-out infinite;
}
@keyframes isiWarnPulse{0%,100%{box-shadow:0 4px 24px rgba(255,140,0,0.25);}50%{box-shadow:0 4px 32px rgba(255,140,0,0.45);}}
@keyframes isiCritPulse{0%,100%{box-shadow:0 4px 24px rgba(255,59,59,0.35);}50%{box-shadow:0 4px 32px rgba(255,59,59,0.6);}}

#isi-lock-sticker .isi-stk-logo{
  width:28px; height:28px; border-radius:6px;
  object-fit:cover;
  margin-right:7px; flex-shrink:0;
}
#isi-lock-sticker .isi-stk-top{
  display:flex; align-items:center; margin-bottom:7px;
}
#isi-lock-sticker .isi-stk-label{
  font-size:0.52rem; color:#c5a059; letter-spacing:2px; font-weight:bold; line-height:1.2;
}
#isi-lock-sticker .isi-stk-sub{
  font-size:0.43rem; color:#555; letter-spacing:1px; margin-top:1px;
}
#isi-lock-sticker .isi-stk-countdown{
  font-family:monospace; font-size:1.4rem; font-weight:900;
  text-align:center; letter-spacing:3px;
  color:#ff8c00; margin:4px 0 8px;
  text-shadow:0 0 12px rgba(255,140,0,0.4);
  line-height:1;
}
#isi-lock-sticker .isi-stk-countdown.crit{
  color:#ff3b3b;
  text-shadow:0 0 14px rgba(255,59,59,0.5);
}
#isi-lock-sticker .isi-stk-bar-wrap{
  background:#0d0d0d; border-radius:3px; height:3px; margin-bottom:8px; overflow:hidden;
}
#isi-lock-sticker .isi-stk-bar{
  height:100%; background:linear-gradient(90deg,#c5a059,#ff8c00);
  border-radius:3px; transition:width 1s linear;
}
#isi-lock-sticker button.isi-stk-btn{
  width:100%; padding:5px; border-radius:5px;
  font-size:0.58rem; font-weight:bold; letter-spacing:1px;
  cursor:pointer; border:none;
  background:linear-gradient(135deg,#1a1200,#0d0800);
  border:1px solid #c5a059; color:#c5a059;
  transition:all 0.15s;
}
#isi-lock-sticker button.isi-stk-btn:hover{background:linear-gradient(135deg,#2a1e00,#1a1000);box-shadow:0 0 10px rgba(197,160,89,0.2);}

/* ── LOCK OVERLAY ────────────────────────────────────── */
#isi-lock-overlay{
  position:fixed; inset:0; z-index:999995;
  background:rgba(0,0,0,0.92);
  backdrop-filter:blur(8px);
  display:none; flex-direction:column;
  align-items:center; justify-content:center;
  font-family:'Segoe UI',sans-serif;
}
#isi-lock-overlay .isi-lov-card{
  background:linear-gradient(135deg,#0a0800,#0d0d00);
  border:2px solid #c5a059;
  border-radius:16px;
  padding:32px 36px;
  width:320px;
  box-shadow:0 8px 48px rgba(197,160,89,0.2);
  text-align:center;
}
#isi-lock-overlay img.isi-lov-logo{
  width:64px; height:64px; border-radius:14px;
  margin-bottom:14px;
}
#isi-lock-overlay .isi-lov-title{
  font-size:1.1rem; font-weight:900; color:#c5a059;
  letter-spacing:3px; margin-bottom:4px;
}
#isi-lock-overlay .isi-lov-sub{
  font-size:0.6rem; color:#555; letter-spacing:1px; margin-bottom:20px; line-height:1.6;
}
#isi-lock-overlay input.isi-lov-input{
  width:100%; background:#050505; border:1.5px solid #2a2a2a;
  color:#fff; padding:11px 14px; border-radius:8px;
  font-size:0.9rem; letter-spacing:3px; text-align:center;
  margin-bottom:10px; outline:none; font-family:monospace;
  transition:border-color 0.2s;
}
#isi-lock-overlay input.isi-lov-input:focus{border-color:#c5a059;}
#isi-lock-overlay .isi-lov-err{
  font-size:0.58rem; color:#ff3b3b; margin-bottom:8px;
  min-height:16px; letter-spacing:1px;
}
#isi-lock-overlay button.isi-lov-btn{
  width:100%; padding:12px;
  background:linear-gradient(135deg,#1a1200,#0d0800);
  border:2px solid #c5a059; color:#c5a059;
  border-radius:8px; font-size:0.72rem;
  font-weight:bold; letter-spacing:2px; cursor:pointer;
  transition:all 0.18s;
}
#isi-lock-overlay button.isi-lov-btn:hover{
  background:linear-gradient(135deg,#2a1e00,#1a1000);
  box-shadow:0 0 18px rgba(197,160,89,0.25);
}
#isi-lock-overlay .isi-lov-hint{
  font-size:0.52rem; color:#333; margin-top:10px; letter-spacing:1px;
}
`;

// ── Inject CSS ─────────────────────────────────────────────
function injectStyle() {
  const s = document.createElement('style');
  s.textContent = STYLE;
  document.head.appendChild(s);
}

// ── Build sticker HTML ────────────────────────────────────
function buildSticker() {
  _stkEl = document.createElement('div');
  _stkEl.id = 'isi-lock-sticker';
  const logoSrc = typeof ISI_LOGO !== 'undefined' ? ISI_LOGO : 'logo-icon.png';
  _stkEl.innerHTML = `
    <div class="isi-stk-top">
      <img src="${logoSrc}" class="isi-stk-logo" onerror="this.style.display='none'">
      <div>
        <div class="isi-stk-label">ISI TERMINAL</div>
        <div class="isi-stk-sub">SESSION LOCK</div>
      </div>
    </div>
    <div class="isi-stk-countdown" id="isiStkCd">2:00</div>
    <div class="isi-stk-bar-wrap"><div class="isi-stk-bar" id="isiStkBar" style="width:100%"></div></div>
    <button class="isi-stk-btn" onclick="isiExtendSession()">🔓 EXTEND SESSION</button>
  `;
  document.body.appendChild(_stkEl);

  // Draggable
  _stkEl.addEventListener('mousedown', onDragStart);
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', onDragEnd);
  _stkEl.addEventListener('touchstart', onTouchStart, { passive:true });
  document.addEventListener('touchmove', onTouchMove, { passive:false });
  document.addEventListener('touchend', onTouchEnd);
}

// ── Build lock overlay ─────────────────────────────────────
function buildOverlay() {
  _overlayEl = document.createElement('div');
  _overlayEl.id = 'isi-lock-overlay';
  const logoSrc = typeof ISI_LOGO !== 'undefined' ? ISI_LOGO : 'logo-icon.png';
  _overlayEl.innerHTML = `
    <div class="isi-lov-card">
      <img src="${logoSrc}" class="isi-lov-logo" onerror="this.style.display='none'">
      <div class="isi-lov-title">⚡ ISI TERMINAL</div>
      <div class="isi-lov-sub">Session expired. Apna password ya permanent key enter karo.</div>
      <input type="password" class="isi-lov-input" id="isiLovInput" placeholder="••••••••"
        onkeydown="if(event.key==='Enter') isiUnlock()">
      <div class="isi-lov-err" id="isiLovErr"></div>
      <button class="isi-lov-btn" onclick="isiUnlock()">🔓 UNLOCK TERMINAL</button>
      <div class="isi-lov-hint">Permanent key · Temporary password</div>
    </div>
  `;
  document.body.appendChild(_overlayEl);
}

// ── Drag logic ──────────────────────────────────────────────
function onDragStart(e) {
  if (e.target.tagName === 'BUTTON') return;
  _dragging = true;
  const r = _stkEl.getBoundingClientRect();
  _dragOX = e.clientX - r.left;
  _dragOY = e.clientY - r.top;
  _stkEl.style.transition = 'none';
}
function onDragMove(e) {
  if (!_dragging) return;
  let x = e.clientX - _dragOX, y = e.clientY - _dragOY;
  x = Math.max(0, Math.min(window.innerWidth  - _stkEl.offsetWidth,  x));
  y = Math.max(0, Math.min(window.innerHeight - _stkEl.offsetHeight, y));
  _stkEl.style.left   = x + 'px';
  _stkEl.style.top    = y + 'px';
  _stkEl.style.right  = 'auto';
  _stkEl.style.bottom = 'auto';
}
function onDragEnd() { _dragging = false; _stkEl.style.transition = ''; }
function onTouchStart(e) {
  if (e.target.tagName === 'BUTTON') return;
  const t = e.touches[0];
  _dragging = true;
  const r = _stkEl.getBoundingClientRect();
  _dragOX = t.clientX - r.left;
  _dragOY = t.clientY - r.top;
}
function onTouchMove(e) {
  if (!_dragging) return;
  e.preventDefault();
  const t = e.touches[0];
  let x = t.clientX - _dragOX, y = t.clientY - _dragOY;
  x = Math.max(0, Math.min(window.innerWidth  - _stkEl.offsetWidth,  x));
  y = Math.max(0, Math.min(window.innerHeight - _stkEl.offsetHeight, y));
  _stkEl.style.left   = x + 'px';
  _stkEl.style.top    = y + 'px';
  _stkEl.style.right  = 'auto';
  _stkEl.style.bottom = 'auto';
}
function onTouchEnd() { _dragging = false; }

// ── Countdown display ──────────────────────────────────────
function startCountdown(msLeft) {
  const cdEl  = document.getElementById('isiStkCd');
  const barEl = document.getElementById('isiStkBar');
  if (_cdTimer) clearInterval(_cdTimer);

  const totalWarn = WARN_BEFORE;

  function tick() {
    const now      = Date.now();
    const lastAuth = parseInt(localStorage.getItem(LS_LAST_AUTH) || '0');
    const expires  = lastAuth + LOCK_INTERVAL;
    const remain   = expires - now;

    if (remain <= 0) {
      if (_stkEl) _stkEl.style.display = 'none';
      triggerLock();
      clearInterval(_cdTimer);
      return;
    }

    const mm = String(Math.floor(remain / 60000)).padStart(1,'0');
    const ss = String(Math.floor((remain % 60000) / 1000)).padStart(2,'0');
    if (cdEl) {
      cdEl.textContent = mm + ':' + ss;
      cdEl.className = 'isi-stk-countdown' + (remain < 30000 ? ' crit' : '');
    }
    if (barEl) {
      barEl.style.width = Math.min(100, (remain / totalWarn) * 100) + '%';
      barEl.style.background = remain < 30000
        ? 'linear-gradient(90deg,#ff3b3b,#ff0000)'
        : remain < 60000
        ? 'linear-gradient(90deg,#ff8c00,#ff3b3b)'
        : 'linear-gradient(90deg,#c5a059,#ff8c00)';
    }
    if (_stkEl) {
      _stkEl.className = remain < 30000 ? 'crit' : 'warn';
    }
  }
  tick();
  _cdTimer = setInterval(tick, 1000);
}

// ── Main monitor ───────────────────────────────────────────
function startMonitor() {
  if (_monitorTimer) clearInterval(_monitorTimer);
  _monitorTimer = setInterval(checkSession, 15000);
  checkSession();
}

function checkSession() {
  if (_locked) return;
  const lastAuth = parseInt(localStorage.getItem(LS_LAST_AUTH) || '0');
  const now      = Date.now();

  // No auth recorded yet — set now
  if (!lastAuth) {
    localStorage.setItem(LS_LAST_AUTH, String(now));
    return;
  }

  const elapsed = now - lastAuth;
  const remaining = LOCK_INTERVAL - elapsed;

  if (remaining <= 0) {
    triggerLock();
    return;
  }
  if (remaining <= WARN_BEFORE) {
    showSticker(remaining);
  }
}

function showSticker(msLeft) {
  if (!_stkEl) return;
  _stkEl.style.display = 'block';
  startCountdown(msLeft);
}

function triggerLock() {
  _locked = true;
  if (_stkEl) _stkEl.style.display = 'none';
  if (_cdTimer) clearInterval(_cdTimer);
  if (_overlayEl) {
    _overlayEl.style.display = 'flex';
    setTimeout(() => {
      const inp = document.getElementById('isiLovInput');
      if (inp) inp.focus();
    }, 100);
  }
}

// ── Unlock ──────────────────────────────────────────────────
window.isiUnlock = function() {
  const inp = document.getElementById('isiLovInput');
  const err = document.getElementById('isiLovErr');
  const val = inp ? inp.value.trim() : '';
  if (!val) { if (err) err.textContent = '⚠ Password enter karo'; return; }

  // Check permanent keys
  const permKeys = JSON.parse(localStorage.getItem(LS_PERM_KEYS) || '[]');
  const matchPerm = permKeys.some(k => k === val || k.key === val);

  // Check temp password
  let matchTemp = false;
  try {
    const td = JSON.parse(localStorage.getItem(LS_TEMP_PASS) || 'null');
    if (td && td.pass === val && Date.now() < td.expires) matchTemp = true;
  } catch(e) {}

  if (matchPerm || matchTemp) {
    localStorage.setItem(LS_LAST_AUTH, String(Date.now()));
    _locked = false;
    if (_overlayEl) _overlayEl.style.display = 'none';
    if (_stkEl) _stkEl.style.display = 'none';
    if (inp) inp.value = '';
    if (err) err.textContent = '';
    startMonitor();
  } else {
    if (err) err.textContent = '❌ Wrong password / key';
    if (inp) { inp.style.borderColor = '#ff3b3b'; setTimeout(() => { inp.style.borderColor = ''; }, 1500); }
  }
};

// ── Extend session ──────────────────────────────────────────
window.isiExtendSession = function() {
  // Require quick re-auth to extend
  const permKeys = JSON.parse(localStorage.getItem(LS_PERM_KEYS) || '[]');
  if (permKeys.length === 0) {
    // No keys set — just extend
    localStorage.setItem(LS_LAST_AUTH, String(Date.now()));
    if (_stkEl) _stkEl.style.display = 'none';
    if (_cdTimer) clearInterval(_cdTimer);
    return;
  }
  // Show mini prompt
  const val = prompt('Session extend karne ke liye password enter karo:');
  if (!val) return;
  const match = permKeys.some(k => k === val || k.key === val);
  let tempMatch = false;
  try {
    const td = JSON.parse(localStorage.getItem(LS_TEMP_PASS) || 'null');
    if (td && td.pass === val && Date.now() < td.expires) tempMatch = true;
  } catch(e) {}

  if (match || tempMatch) {
    localStorage.setItem(LS_LAST_AUTH, String(Date.now()));
    if (_stkEl) _stkEl.style.display = 'none';
    if (_cdTimer) clearInterval(_cdTimer);
  } else {
    alert('❌ Wrong password');
  }
};

// ── Init ────────────────────────────────────────────────────
function init() {
  injectStyle();
  buildSticker();
  buildOverlay();
  // Set auth time if not set
  if (!localStorage.getItem(LS_LAST_AUTH)) {
    localStorage.setItem(LS_LAST_AUTH, String(Date.now()));
  }
  startMonitor();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

})();

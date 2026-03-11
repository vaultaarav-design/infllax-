/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║   ISI ORDER TRACKER v2.0                                ║
 * ║   Har page pe floating popup — Live Active Orders       ║
 * ║   Cancel + Resume + Firebase sync                       ║
 * ╚══════════════════════════════════════════════════════════╝
 */

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
    getDatabase, ref, onValue, update, push as fbPush, get
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

// ─────────────────────────────────────
// FIREBASE (reuse existing app if same project)
// ─────────────────────────────────────
const FB_CFG = {
    apiKey:            "AIzaSyBhVpnVtlLMy0laY8U5A5Y8lLY9s3swjkE",
    authDomain:        "trading-terminal-b8006.firebaseapp.com",
    projectId:         "trading-terminal-b8006",
    storageBucket:     "trading-terminal-b8006.firebasestorage.app",
    messagingSenderId: "690730161822",
    appId:             "1:690730161822:web:81dabfd7b4575e86860d8f",
    databaseURL:       "https://trading-terminal-b8006-default-rtdb.firebaseio.com"
};

let _db = null;
try {
    const ex = getApps().find(a => a.name === '[DEFAULT]') || getApps()[0];
    _db = getDatabase(ex || initializeApp(FB_CFG, 'ot'));
} catch(e) { console.warn('[OT]', e); }

// ─────────────────────────────────────
// STATE
// ─────────────────────────────────────
let _orders    = {};   // { key: orderObj }
let _visible   = false;
let _minimized = false;
let _unsub     = null;
let _lastCid   = null;
let _pendingCancel = null;

const TODAY = () => new Date().toISOString().slice(0, 10);

// ─────────────────────────────────────
// CSS
// ─────────────────────────────────────
const CSS = `
/* ─── FLOATING TRIGGER BUTTON ─── */
#_ot_btn {
    position:fixed; bottom:28px; right:28px; z-index:99990;
    display:flex; align-items:center; gap:8px;
    background:linear-gradient(135deg,#0a0800,#000810);
    border:2px solid #c5a059; border-radius:50px;
    padding:9px 16px; cursor:pointer;
    font-family:'Segoe UI',sans-serif; font-size:0.65rem;
    font-weight:900; color:#c5a059; letter-spacing:1px;
    box-shadow:0 4px 24px rgba(0,0,0,0.8),0 0 16px rgba(197,160,89,0.15);
    transition:all 0.2s; user-select:none;
}
#_ot_btn:hover { box-shadow:0 4px 32px rgba(0,0,0,0.9),0 0 24px rgba(197,160,89,0.3); transform:translateY(-2px); }
#_ot_btn .otb-icon { font-size:0.85rem; }
#_ot_badge {
    background:#c5a059; color:#000; border-radius:50%;
    width:19px; height:19px; font-size:0.58rem; font-weight:900;
    display:flex; align-items:center; justify-content:center;
    transition:all 0.3s;
}
#_ot_badge.zero { background:#1e1e1e; color:#444; }
#_ot_badge.pulse { animation:_otBadgePulse 1.5s ease-in-out infinite; }
@keyframes _otBadgePulse {
    0%,100%{ box-shadow:0 0 0 0 rgba(197,160,89,0.5); }
    50%    { box-shadow:0 0 0 6px rgba(197,160,89,0); }
}

/* ─── POPUP PANEL ─── */
#_ot_popup {
    position:fixed; bottom:80px; right:28px; z-index:99991;
    width:420px; max-height:80vh;
    background:#040404;
    border:1.5px solid #c5a059; border-radius:10px;
    box-shadow:0 8px 48px rgba(0,0,0,0.95),0 0 24px rgba(197,160,89,0.12);
    font-family:'Segoe UI',sans-serif;
    display:none; flex-direction:column; overflow:hidden;
}
#_ot_popup.show { display:flex; animation:_otSlide 0.18s ease; }
@keyframes _otSlide { from{opacity:0;transform:translateY(12px)} to{opacity:1;transform:translateY(0)} }
#_ot_popup.mini { max-height:52px; }

/* HEADER */
.ot-hdr {
    background:linear-gradient(90deg,#0a0800,#000);
    border-bottom:1px solid #1a1400;
    padding:11px 14px; display:flex; align-items:center;
    justify-content:space-between; flex-shrink:0; cursor:pointer;
}
.ot-hdr-left { display:flex; align-items:center; gap:10px; }
.ot-hdr-title { font-size:0.58rem; color:#c5a059; letter-spacing:3px; font-weight:900; }
.ot-hdr-right { display:flex; gap:5px; align-items:center; }
.ot-hbtn {
    background:#111; border:1px solid #222; color:#555;
    width:22px; height:22px; border-radius:3px; cursor:pointer;
    font-size:0.62rem; display:flex; align-items:center; justify-content:center;
    transition:all 0.15s;
}
.ot-hbtn:hover { border-color:#c5a059; color:#c5a059; }

/* STATS BAR */
.ot-stats {
    background:#030303; border-bottom:1px solid #0d0d0d;
    display:grid; grid-template-columns:repeat(4,1fr);
    padding:7px 10px; gap:4px; flex-shrink:0;
}
.ot-stat { text-align:center; }
.ot-stat-l { font-size:0.44rem; color:#2a2a2a; letter-spacing:1px; margin-bottom:2px; }
.ot-stat-v { font-size:0.72rem; font-weight:900; font-family:monospace; }

/* BODY */
.ot-body {
    overflow-y:auto; flex:1; padding:8px;
}
.ot-body::-webkit-scrollbar { width:3px; }
.ot-body::-webkit-scrollbar-thumb { background:#1a1a1a; border-radius:2px; }

/* ─── ORDER CARD ─── */
.otc {
    background:#070707; border:1px solid #111;
    border-radius:6px; margin-bottom:8px; overflow:hidden;
    transition:all 0.2s;
}
.otc.long  { border-left:3px solid #00c805; }
.otc.short { border-left:3px solid #ff3b3b; }
.otc.pend  { animation:_otCardPulse 3s ease-in-out infinite; }
@keyframes _otCardPulse {
    0%,100%{ box-shadow:0 0 0 0 rgba(197,160,89,0); }
    50%    { box-shadow:0 0 10px rgba(197,160,89,0.1); }
}
.otc.exec { border-color:#00ff88; opacity:0.75; }
.otc.fail { border-color:#ff3b3b; opacity:0.65; }
.otc.canc { border-color:#222; opacity:0.45; }

.otc-head {
    display:flex; justify-content:space-between; align-items:center;
    padding:7px 10px; border-bottom:1px solid #0d0d0d;
}
.otc-sym  { font-size:0.8rem; font-weight:900; color:#fff; }
.otc-dir  { font-size:0.52rem; font-weight:bold; padding:2px 7px; border-radius:2px; letter-spacing:1px; }
.d-long   { background:#020d02; color:#00c805; border:1px solid #00c805; }
.d-short  { background:#0d0202; color:#ff3b3b; border:1px solid #ff3b3b; }
.otc-time { font-size:0.52rem; color:#2a2a2a; font-family:monospace; }

.stag { font-size:0.5rem; font-weight:bold; padding:2px 6px; border-radius:2px; letter-spacing:1px; }
.st-pend { background:#0d0800; color:#c5a059; border:1px solid #c5a059; }
.st-exec { background:#020d02; color:#00ff88; border:1px solid #00ff88; }
.st-fail { background:#0d0202; color:#ff3b3b; border:1px solid #ff3b3b; }
.st-canc { background:#111;    color:#444;    border:1px solid #222;    }
.st-auth { background:#010a1a; color:#4a9eff; border:1px solid #4a9eff; }

.otc-body { padding:8px 10px; }

.otc-lvls {
    display:grid; grid-template-columns:repeat(4,1fr);
    gap:3px; margin-bottom:6px;
}
.otc-lvl {
    background:#050505; border:1px solid #0d0d0d;
    border-radius:3px; padding:4px 5px; text-align:center;
}
.otc-lvl-l { font-size:0.43rem; color:#222; letter-spacing:1px; margin-bottom:2px; }
.otc-lvl-v { font-size:0.6rem; font-weight:bold; font-family:monospace; color:#999; }

.otc-meta {
    display:flex; gap:10px; font-size:0.52rem; color:#2a2a2a;
    margin-bottom:6px; flex-wrap:wrap;
}
.otc-meta b { color:#555; }

.otc-exec-info { font-size:0.55rem; color:#00ff88; margin-bottom:5px; line-height:1.5; }
.otc-fail-info { font-size:0.55rem; color:#ff5555; margin-bottom:5px; line-height:1.5; }

.otc-acts { display:flex; gap:5px; }
.ota {
    flex:1; padding:6px 8px; font-size:0.58rem; font-weight:bold;
    cursor:pointer; border-radius:3px; letter-spacing:1px; text-align:center;
    transition:all 0.15s;
}
.ota-resume { background:#0a0800; border:1px solid #c5a059; color:#c5a059; }
.ota-resume:hover { background:#150f00; }
.ota-cancel { background:#0d0202; border:1px solid #ff3b3b; color:#ff3b3b; }
.ota-cancel:hover { background:#1a0303; }

/* EMPTY STATE */
.ot-empty { color:#1a1a1a; font-size:0.63rem; text-align:center; padding:24px; line-height:2; }

/* ─── CONFIRM DIALOG ─── */
#_ot_confirm {
    position:fixed; inset:0; background:rgba(0,0,0,0.85);
    z-index:99999; display:none; align-items:center; justify-content:center;
}
#_ot_confirm.show { display:flex; }
.ot-cfm-box {
    background:#080808; border:1.5px solid #ff3b3b;
    border-radius:8px; padding:22px 24px; max-width:360px; width:90%;
    font-family:'Segoe UI',sans-serif;
    box-shadow:0 0 40px rgba(255,59,59,0.2);
}
.ot-cfm-title { font-size:0.58rem; color:#ff3b3b; letter-spacing:3px; font-weight:900; margin-bottom:10px; }
.ot-cfm-msg { font-size:0.7rem; color:#ccc; margin-bottom:16px; line-height:1.7; }
.ot-cfm-btns { display:flex; gap:8px; }
.ot-cfm-yes {
    flex:1; padding:10px; background:#0d0202;
    border:1.5px solid #ff3b3b; color:#ff3b3b;
    border-radius:4px; font-weight:bold; font-size:0.65rem;
    cursor:pointer; letter-spacing:1px;
}
.ot-cfm-no {
    flex:1; padding:10px; background:#0a0a0a;
    border:1px solid #2a2a2a; color:#555;
    border-radius:4px; font-weight:bold; font-size:0.65rem;
    cursor:pointer;
}

/* ─── TOAST ─── */
#_ot_toast {
    position:fixed; bottom:96px; left:50%; transform:translateX(-50%);
    background:#0d0d0d; border:1px solid #c5a059; color:#c5a059;
    padding:8px 20px; border-radius:4px; font-size:0.65rem; font-weight:bold;
    z-index:100000; display:none; letter-spacing:1px;
    font-family:'Segoe UI',sans-serif; white-space:nowrap;
}

@media(max-width:460px){
    #_ot_popup { width:calc(100vw - 16px); right:8px; bottom:76px; }
}
`;

// ─────────────────────────────────────
// BUILD DOM
// ─────────────────────────────────────
function buildDOM() {
    if (document.getElementById('_ot_btn')) return;

    // Inject CSS
    const st = document.createElement('style');
    st.id = '_ot_css';
    st.textContent = CSS;
    document.head.appendChild(st);

    // Floating button
    document.body.insertAdjacentHTML('beforeend', `
        <div id="_ot_btn" onclick="window._OT.toggle()">
            <span class="otb-icon">📋</span>
            <span>ORDERS</span>
            <span id="_ot_badge" class="zero">0</span>
        </div>
    `);

    // Popup
    document.body.insertAdjacentHTML('beforeend', `
        <div id="_ot_popup">
            <div class="ot-hdr" onclick="window._OT.toggleMin(event)">
                <div class="ot-hdr-left">
                    <span class="ot-hdr-title">📋 ACTIVE ORDERS</span>
                    <span id="_ot_hdr_cnt" style="font-size:0.52rem;color:#444;"></span>
                </div>
                <div class="ot-hdr-right" onclick="event.stopPropagation()">
                    <div class="ot-hbtn" onclick="window._OT.refresh()" title="Refresh">↻</div>
                    <div class="ot-hbtn" id="_ot_minbtn" onclick="window._OT.toggleMin()">−</div>
                    <div class="ot-hbtn" onclick="window._OT.close()">✕</div>
                </div>
            </div>
            <div class="ot-stats" id="_ot_stats">
                <div class="ot-stat">
                    <div class="ot-stat-l">TOTAL</div>
                    <div class="ot-stat-v" id="_ot_s_total" style="color:#888;">0</div>
                </div>
                <div class="ot-stat">
                    <div class="ot-stat-l">PENDING</div>
                    <div class="ot-stat-v" id="_ot_s_pend" style="color:#c5a059;">0</div>
                </div>
                <div class="ot-stat">
                    <div class="ot-stat-l">EXECUTED</div>
                    <div class="ot-stat-v" id="_ot_s_exec" style="color:#00ff88;">0</div>
                </div>
                <div class="ot-stat">
                    <div class="ot-stat-l">FAILED/CANC</div>
                    <div class="ot-stat-v" id="_ot_s_fail" style="color:#ff3b3b;">0</div>
                </div>
            </div>
            <div class="ot-body" id="_ot_body">
                <div class="ot-empty">Koi active order nahi.<br><span style="font-size:0.55rem;">Pre-entry → Authorize karo.</span></div>
            </div>
        </div>
    `);

    // Confirm dialog
    document.body.insertAdjacentHTML('beforeend', `
        <div id="_ot_confirm">
            <div class="ot-cfm-box">
                <div class="ot-cfm-title">⚠ ORDER CANCEL CONFIRM</div>
                <div class="ot-cfm-msg" id="_ot_cfm_msg"></div>
                <div class="ot-cfm-btns">
                    <button class="ot-cfm-yes" id="_ot_cfm_yes">❌ CANCEL ORDER</button>
                    <button class="ot-cfm-no" onclick="window._OT.hideConfirm()">RAKHNE DO</button>
                </div>
            </div>
        </div>
    `);

    // Toast
    document.body.insertAdjacentHTML('beforeend', `<div id="_ot_toast"></div>`);
}

// ─────────────────────────────────────
// FIREBASE LISTENER
// ─────────────────────────────────────
function startListening() {
    if (!_db) return;

    const cid  = localStorage.getItem('isi_sel_cluster');
    const nidx = localStorage.getItem('isi_sel_node') || '0';

    if (!cid || cid === _lastCid) return;
    _lastCid = cid;

    if (_unsub) { try { _unsub(); } catch(e) {} }

    const path = `isi_v6/order_requests/${cid}/${nidx}`;

    _unsub = onValue(ref(_db, path), snap => {
        const raw   = snap.val() || {};
        _orders     = {};
        const today = TODAY();

        Object.entries(raw).forEach(([key, ord]) => {
            if (!ord || typeof ord !== 'object') return;
            if (ord.status === 'CANCELLED' && (ord.requestedAt || '').slice(0, 10) !== today) return;
            const orderDate = (ord.requestedAt || '').slice(0, 10);
            // Show: today's orders OR pending orders from any date
            if (orderDate !== today && ord.status !== 'ORDER_PENDING') return;
            _orders[key] = { ...ord, _key: key };
        });

        updateBadge();
        updateStats();
        if (_visible && !_minimized) renderList();
    });
}

// ─────────────────────────────────────
// RENDER
// ─────────────────────────────────────
function renderList() {
    const body = document.getElementById('_ot_body');
    if (!body) return;

    const list = Object.values(_orders)
        .sort((a, b) => new Date(b.requestedAt || 0) - new Date(a.requestedAt || 0));

    if (!list.length) {
        body.innerHTML = `<div class="ot-empty">
            Aaj koi order nahi.<br>
            <span style="font-size:0.55rem;">Pre-entry karo → Terminal pe Authorize karo.</span>
        </div>`;
        return;
    }

    body.innerHTML = '';

    list.forEach(ord => {
        const isLong = ord.direction === 'LONG';
        const time   = ord.requestedAt
            ? new Date(ord.requestedAt).toLocaleTimeString('en-GB', { hour12: false })
            : '—';

        // Status config
        const stMap = {
            ORDER_PENDING: { lbl:'⏳ PENDING',   cls:'st-pend', cardCls:'pend'  },
            EXECUTED:      { lbl:'⚡ EXECUTED',  cls:'st-exec', cardCls:'exec'  },
            FAILED:        { lbl:'💥 FAILED',    cls:'st-fail', cardCls:'fail'  },
            CANCELLED:     { lbl:'🚫 CANCELLED', cls:'st-canc', cardCls:'canc'  },
            LOGGED:        { lbl:'📡 SIGNAL',    cls:'st-auth', cardCls:''      },
        };
        const st = stMap[ord.status] || { lbl: ord.status, cls:'st-pend', cardCls:'' };

        // RR
        let rr = '—';
        if (ord.entry && ord.sl && ord.tp) {
            const r = Math.abs(ord.entry - ord.sl);
            const w = Math.abs(ord.tp    - ord.entry);
            rr = '1:' + (w / Math.max(r, 0.000001)).toFixed(1);
        }

        // Extra info rows
        const execInfo = ord.status === 'EXECUTED' ? `
            <div class="otc-exec-info">
                ✅ Executed @ <b>${ord.exec_price || ord.entry}</b>
                ${ord.order_id ? '| MT5 ID: ' + ord.order_id : ''}
                ${ord.exec_time ? '<br>' + new Date(ord.exec_time).toLocaleTimeString() : ''}
            </div>` : '';

        const failInfo = ord.status === 'FAILED' ? `
            <div class="otc-fail-info">❌ ${ord.error || 'Broker ne reject kiya'}</div>` : '';

        // Action buttons
        const isPending = ord.status === 'ORDER_PENDING';
        const canCancel = ['ORDER_PENDING', 'LOGGED', 'EXECUTED'].includes(ord.status);
        const canResume = isPending;

        const acts = (canResume || canCancel) ? `
            <div class="otc-acts">
                ${canResume ? `<button class="ota ota-resume" onclick="window._OT.resume('${ord._key}')">↩ RESUME / EDIT</button>` : ''}
                ${canCancel ? `<button class="ota ota-cancel" onclick="window._OT.cancelPrompt('${ord._key}','${(ord.symbol||'').replace(/'/g,'')}')">❌ CANCEL</button>` : ''}
            </div>` : '';

        const card = document.createElement('div');
        card.className = `otc ${isLong ? 'long' : 'short'} ${st.cardCls}`;
        card.innerHTML = `
            <div class="otc-head">
                <div style="display:flex;align-items:center;gap:6px;">
                    <span class="otc-sym">${ord.symbol || '—'}</span>
                    <span class="otc-dir ${isLong ? 'd-long' : 'd-short'}">${isLong ? '▲ LONG' : '▼ SHORT'}</span>
                    <span class="stag ${st.cls}">${st.lbl}</span>
                </div>
                <span class="otc-time">${time}</span>
            </div>
            <div class="otc-body">
                <div class="otc-lvls">
                    <div class="otc-lvl">
                        <div class="otc-lvl-l">ENTRY</div>
                        <div class="otc-lvl-v" style="color:#c5a059;">${ord.entry ?? '—'}</div>
                    </div>
                    <div class="otc-lvl">
                        <div class="otc-lvl-l">SL</div>
                        <div class="otc-lvl-v" style="color:#ff8888;">${ord.sl ?? '—'}</div>
                    </div>
                    <div class="otc-lvl">
                        <div class="otc-lvl-l">TP</div>
                        <div class="otc-lvl-v" style="color:#88ff88;">${ord.tp ?? '—'}</div>
                    </div>
                    <div class="otc-lvl">
                        <div class="otc-lvl-l">R:R</div>
                        <div class="otc-lvl-v" style="color:#c5a059;">${rr}</div>
                    </div>
                </div>
                <div class="otc-meta">
                    <span>QTY: <b>${ord.qty ?? '—'}</b></span>
                    <span>RISK: <b>${ord.riskPct ? ord.riskPct + '%' : '—'}</b></span>
                    <span>SCORE: <b>${ord.score ?? '—'}</b></span>
                    ${ord.htf_ms ? `<span>HTF: <b>${ord.htf_ms}</b></span>` : ''}
                    ${ord.source === 'ISI_TERMINAL_MANUAL' ? '<span style="color:#4a9eff;font-size:0.5rem;">MANUAL</span>' : '<span style="color:#9b59b6;font-size:0.5rem;">ALGO</span>'}
                </div>
                ${execInfo}${failInfo}
                ${acts}
            </div>
        `;
        body.appendChild(card);
    });
}

// ─────────────────────────────────────
// BADGE + STATS
// ─────────────────────────────────────
function updateBadge() {
    const badge = document.getElementById('_ot_badge');
    const hcnt  = document.getElementById('_ot_hdr_cnt');
    if (!badge) return;

    const total   = Object.keys(_orders).length;
    const pending = Object.values(_orders).filter(o => o.status === 'ORDER_PENDING').length;

    badge.textContent = total;
    badge.className   = total === 0 ? 'zero' : pending > 0 ? 'pulse' : '';
    if (hcnt) hcnt.textContent = total ? `(${total})` : '';
}

function updateStats() {
    const vals = Object.values(_orders);
    const s = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    s('_ot_s_total', vals.length);
    s('_ot_s_pend',  vals.filter(o => o.status === 'ORDER_PENDING').length);
    s('_ot_s_exec',  vals.filter(o => o.status === 'EXECUTED').length);
    s('_ot_s_fail',  vals.filter(o => ['FAILED','CANCELLED'].includes(o.status)).length);
}

// ─────────────────────────────────────
// PUBLIC API — window._OT
// ─────────────────────────────────────
window._OT = {

    toggle() {
        _visible = !_visible;
        const popup = document.getElementById('_ot_popup');
        if (_visible) {
            popup.classList.add('show');
            popup.classList.remove('mini');
            _minimized = false;
            document.getElementById('_ot_minbtn').textContent = '−';
            document.getElementById('_ot_stats').style.display = 'grid';
            startListening();
            renderList();
        } else {
            popup.classList.remove('show');
        }
    },

    close() {
        _visible = false;
        document.getElementById('_ot_popup').classList.remove('show');
    },

    toggleMin(e) {
        if (e) e.stopPropagation();
        if (!_visible) return;
        _minimized = !_minimized;
        const popup  = document.getElementById('_ot_popup');
        const stats  = document.getElementById('_ot_stats');
        const body   = document.getElementById('_ot_body');
        const minBtn = document.getElementById('_ot_minbtn');
        popup.classList.toggle('mini', _minimized);
        if (stats) stats.style.display = _minimized ? 'none' : 'grid';
        if (body)  body.style.display  = _minimized ? 'none' : '';
        if (minBtn) minBtn.textContent  = _minimized ? '+' : '−';
    },

    refresh() {
        _lastCid = null;
        startListening();
        _toast('↻ Refreshed');
    },

    // ── RESUME — go to terminal with pre-filled order ──
    resume(key) {
        const ord = _orders[key];
        if (!ord) return;

        // Rebuild pre-entry compatible payload
        const pe = {
            asset:       ord.symbol,
            direction:   ord.direction,
            entryPrice:  ord.entry,
            stopLoss:    ord.sl,
            targetZone:  ord.tp,
            entryZone:   ord.entry,
            stopZone:    ord.sl,
            calcQty:     ord.qty,
            riskAmt:     ord.riskAmt,
            riskPct:     ord.riskPct,
            score:       ord.score || 0,
            biasResult:  ord.biasResult || '',
            htf:         { ms: ord.htf_ms || '', zone: ord.htf_zone || '' },
            ltf:         { ms: ord.ltf_ms || '' },
            smm:         ord.smm || [],
            note:        ord.note || '',
            date:        TODAY(),
            rrPlanned:   ord.rr || null,
            _resumeKey:  key,
            _isResume:   true,
        };

        localStorage.setItem('isi_last_preentry',   JSON.stringify(pe));
        localStorage.setItem('isi_resume_order_key', key);

        const page = window.location.pathname.split('/').pop();
        if (page === 'index.html' || page === '') {
            // Already on terminal — refresh order card
            this.close();
            if (typeof window.loadPreEntryBadge === 'function') {
                window.loadPreEntryBadge();
                // Scroll to flow card
                const fc = document.getElementById('flowCard');
                if (fc) fc.scrollIntoView({ behavior: 'smooth' });
            } else {
                window.location.reload();
            }
        } else {
            // Navigate to terminal
            window.location.href = 'index.html';
        }
    },

    // ── CANCEL PROMPT ──
    cancelPrompt(key, symbol) {
        _pendingCancel = key;
        const ord = _orders[key];
        const msg = document.getElementById('_ot_cfm_msg');
        const yes = document.getElementById('_ot_cfm_yes');
        if (!msg || !yes) return;

        msg.innerHTML = `
            <b style="color:#fff;font-size:0.85rem;">${symbol}</b> order cancel karna chahte ho?<br>
            <span style="font-size:0.6rem;color:#555;">
            ${ord && ord.status === 'EXECUTED'
                ? '⚠ Order already executed hai — MT5 mein position close hogi.'
                : 'Python engine ko cancel request jaayega — MT5 mein pending order remove hoga.'}
            </span>
        `;
        yes.onclick = () => {
            this.hideConfirm();
            this._doCancel(key);
        };
        document.getElementById('_ot_confirm').classList.add('show');
    },

    hideConfirm() {
        document.getElementById('_ot_confirm').classList.remove('show');
        _pendingCancel = null;
    },

    async _doCancel(key) {
        if (!_db) { _toast('❌ Firebase not connected'); return; }

        const cid  = localStorage.getItem('isi_sel_cluster');
        const nidx = localStorage.getItem('isi_sel_node') || '0';
        if (!cid) { _toast('❌ Cluster not selected'); return; }

        const ord = _orders[key];
        if (!ord) return;

        try {
            // 1. Mark as CANCELLED in Firebase
            await update(ref(_db, `isi_v6/order_requests/${cid}/${nidx}/${key}`), {
                status:      'CANCELLED',
                cancelledAt: new Date().toISOString(),
                cancelledBy: 'USER_MANUAL'
            });

            // 2. Push cancel request → Python engine will cancel in MT5
            await fbPush(ref(_db, `isi_v6/cancel_requests/${cid}/${nidx}`), {
                type:        'CANCEL_ORDER',
                orderKey:    key,
                symbol:      ord.symbol,
                order_id:    ord.order_id || null,
                direction:   ord.direction,
                entry:       ord.entry,
                requestedAt: new Date().toISOString(),
                status:      'CANCEL_PENDING'
            });

            _toast(`🚫 ${ord.symbol} order cancel request bheja`);

        } catch(e) {
            console.error('[OT] Cancel error:', e);
            _toast('❌ Cancel failed — ' + e.message);
        }
    }
};

// ─────────────────────────────────────
// TOAST
// ─────────────────────────────────────
function _toast(msg) {
    const t = document.getElementById('_ot_toast');
    if (!t) return;
    t.textContent = msg;
    t.style.display = 'block';
    clearTimeout(window._ot_toast_timer);
    window._ot_toast_timer = setTimeout(() => t.style.display = 'none', 3000);
}

// ─────────────────────────────────────
// INIT — auto-start on page load
// ─────────────────────────────────────
function init() {
    buildDOM();
    if (_db) {
        startListening();
        // Re-check cluster every 10s (in case user selects cluster after page load)
        setInterval(startListening, 10000);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

// Export for index.js to call after authorize
window._OT_reload = () => { _lastCid = null; startListening(); };

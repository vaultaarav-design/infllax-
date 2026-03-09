import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
    getDatabase, ref, onValue, update, push, remove, get
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { aiTradeReview, renderAIResponse } from "./gemini.js";

// ── FIREBASE CONFIG ──
const firebaseConfig = {
    apiKey: "AIzaSyBhVpnVtlLMy0laY8U5A5Y8lLY9s3swjkE",
    authDomain: "trading-terminal-b8006.firebaseapp.com",
    projectId: "trading-terminal-b8006",
    storageBucket: "trading-terminal-b8006.firebasestorage.app",
    messagingSenderId: "690730161822",
    appId: "1:690730161822:web:81dabfd7b4575e86860d8f",
    databaseURL: "https://trading-terminal-b8006-default-rtdb.firebaseio.com"
};
const fbApp = initializeApp(firebaseConfig);
const db    = getDatabase(fbApp);

// ──────────────────────────────────────────────
// STATE
// ──────────────────────────────────────────────
let clusters          = {};
let selectedClusterId = null;
let selectedNodeIdx   = null;
let selectedSlotIdx   = 0;   // active trade slot index (for multi-slot nodes)
let tradeHistory      = [];
let equityPoints      = [];
let chartInstance     = null;
let currentVios       = [];
let flowMemory        = {};
let _clusterUnsubs    = []; // unsubscribe functions for cluster equity listeners

const flowKeys = [
    "Sleep", "No Revenge", "Desk Ready", "HTF Location",
    "Single Side", "No Mid-Range", "Clear Range", "LTF Confirm"
];

// ──────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────
const getActiveNode    = () => clusters[selectedClusterId]?.nodes[selectedNodeIdx] || null;
const nodeBasePath     = () => `isi_v6/clusters/${selectedClusterId}/nodes/${selectedNodeIdx}`;
const statsPath        = (cId, nIdx) => `isi_v6/stats/${cId}/${nIdx}`;
const activeStatsPath  = () => statsPath(selectedClusterId, selectedNodeIdx);
const getClusterPass   = () => clusters[selectedClusterId]?.resetKey || null;

// Live stats cache — updated by dedicated onValue listener
// Structure: { [clusterId]: { [nodeIdx]: { currentBal, trades, wins, winRate, net } } }
let liveStats = {};

/** Verify entered password matches the ACTIVE cluster's resetKey */
function verifyPass() {
    const entered = document.getElementById('sysPass').value;
    const correct = getClusterPass();
    if (!correct) { alert('Select a cluster first!'); return false; }
    if (entered !== correct) { alert('Wrong Security Key!'); return false; }
    return true;
}

// Get stats for any node — from liveStats cache first, fallback to node.stats, fallback to node.balance
// NOTE: Firebase object keys are always strings, so we use String(nIdx)
function getNodeStats(cId, nIdx) {
    const cached = liveStats[cId]?.[String(nIdx)];
    if (cached) return cached;
    // fallback to old location in clusters (migration compat)
    const node = clusters[cId]?.nodes[nIdx];
    if (node?.stats) return node.stats;
    return { currentBal: node?.balance ?? 0, trades: 0, wins: 0, winRate: 0, net: 0 };
}

// Write stats to dedicated lightweight path ONLY
// node.balance = setup/reference balance — NEVER changed by trading
// stats.currentBal = live trading balance — only place trading logic writes
async function writeStats(cId, nIdx, statsObj) {
    // Use String(nIdx) explicitly — Firebase stores as string, keep consistent
    try {
        await update(ref(db, `isi_v6/stats/${cId}/${String(nIdx)}`), statsObj);
        return true;
    } catch(e) {
        showToast('⚠ Stats update fail hua — Balance stale ho sakta hai. Firebase connection check karo.', 'error');
        console.error('writeStats failed:', e);
        return false;
    }
}

// ── TOAST NOTIFICATION ──
function showToast(msg, type = 'info') {
    document.getElementById('isiToastEl')?.remove();
    const bg  = type === 'error' ? '#1a0000' : '#001a00';
    const bc  = type === 'error' ? '#cc2222' : '#00aa44';
    const col = type === 'error' ? '#ff5252' : '#00c805';
    const t   = document.createElement('div');
    t.id = 'isiToastEl';
    t.style.cssText = `position:fixed;bottom:22px;right:22px;z-index:99999;background:${bg};
        border:1.5px solid ${bc};color:${col};padding:12px 18px;border-radius:7px;
        font-size:0.75rem;font-weight:bold;max-width:320px;line-height:1.6;
        box-shadow:0 4px 20px rgba(0,0,0,0.7);white-space:pre-line;`;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 5000);
}

// ──────────────────────────────────────────────
// CLOCK + COUNTDOWN
// ──────────────────────────────────────────────
function timeToMinutes(t) {
    if (!t) return null;
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
}

function formatCountdown(diffSeconds) {
    if (diffSeconds <= 0) return '00:00:00';
    const h = Math.floor(diffSeconds / 3600);
    const m = Math.floor((diffSeconds % 3600) / 60);
    const s = diffSeconds % 60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

// ──────────────────────────────────────────────
// HELPER — get all active time slots for a node today
// Supports new timeSlots format AND old times format
// Returns: [ { start, end, expire, risk, qtyFrom, qtyTo, slotIdx } ]
// ──────────────────────────────────────────────
function getNodeSlotsForDay(node, dayName) {
    if (node.timeSlots && node.timeSlots[dayName] && Array.isArray(node.timeSlots[dayName])) {
        return node.timeSlots[dayName]
            .filter(sl => sl && sl.start)
            .map((sl, i) => ({ ...sl, slotIdx: i }));
    }
    if (node.times && node.times[dayName] && node.times[dayName].start) {
        const t = node.times[dayName];
        return [{
            start:   t.start,
            end:     t.end    || '',
            expire:  t.expire || '',
            risk:    node.risk    ?? null,
            qtyFrom: node.qtyFrom || 1,
            qtyTo:   node.qtyTo   || 10,
            slotIdx: 0
        }];
    }
    return [];
}

function updateClock() {
    const now     = new Date();
    const dayName = ['SUN','MON','TUE','WED','THU','FRI','SAT'][now.getDay()];
    const ts      = now.toLocaleTimeString('en-GB', { hour12: false }).slice(0, 5);

    document.getElementById('liveClock').textContent = `${dayName} ${ts} IST`;

    document.querySelectorAll('.s-timer-card').forEach(card => {
        const n = clusters[card.dataset.cluster]?.nodes[card.dataset.node];
        if (!n) return;
        const slotIdx = parseInt(card.dataset.slot || '0');
        const isSel = card.classList.contains('node-selected');

        // Get slot-specific times
        const slots = getNodeSlotsForDay(n, dayName);
        const slot  = slots[slotIdx] || slots[0] || {};
        const tt    = { start: slot.start, end: slot.end, expire: slot.expire };

        const startMin  = timeToMinutes(tt.start);
        const endMin    = timeToMinutes(tt.end);
        const expireMin = timeToMinutes(tt.expire);
        const nowMin    = now.getHours() * 60 + now.getMinutes();

        let st = 'NO DATA', sc = '#333', lbl = '--', countdown = '--:--:--';
        let phase = 'idle';

        if (startMin !== null && nowMin < startMin) {
            phase = 'pre';
            const diffS = (startMin - nowMin) * 60 - now.getSeconds();
            countdown = formatCountdown(diffS);
            st = 'SCHEDULED'; sc = '#c5a059'; lbl = 'LIVE IN';
        } else if (startMin !== null && endMin !== null && nowMin >= startMin && nowMin < endMin) {
            phase = 'live';
            const diffS = (endMin - nowMin) * 60 - now.getSeconds();
            countdown = formatCountdown(diffS);
            st = '● LIVE'; sc = '#00ff41'; lbl = 'ENDS IN';
        } else if (endMin !== null && expireMin !== null && nowMin >= endMin && nowMin < expireMin) {
            phase = 'exit';
            const diffS = (expireMin - nowMin) * 60 - now.getSeconds();
            countdown = formatCountdown(diffS);
            st = 'EXIT ZONE'; sc = '#ffcc00'; lbl = 'EXPIRES IN';
        } else if (expireMin !== null && nowMin >= expireMin) {
            phase = 'closed';
            countdown = 'DONE';
            st = 'CLOSED'; sc = '#ff3b3b'; lbl = 'SESSION';
        }

        // Update card classes
        const baseClass = 's-timer-card stc-landscape';
        if (isSel) {
            card.className = baseClass + ' node-selected';
        } else {
            const phaseClass = phase === 'live' ? 'tc-active' : phase === 'exit' ? 'tc-warning' : phase === 'closed' ? 'tc-expired' : '';
            card.className = baseClass + (phaseClass ? ' ' + phaseClass : '');
            if (phase === 'pre') card.classList.add('stc-rgb-pulse');
        }

        const se = card.querySelector('.tc-status-text');
        const cd = card.querySelector('.stc-countdown');
        const lb = card.querySelector('.stc-live-label');
        if (se) { se.textContent = st; se.style.color = ''; }
        if (cd) { cd.textContent = countdown; cd.style.color = ''; }
        if (lb) { lb.textContent = lbl; lb.style.color = ''; }
    });

    updateSelectedInfoBar();
}
setInterval(updateClock, 1000);

// ──────────────────────────────────────────────
// FIREBASE – LOAD ALL CLUSTERS (live listener)
// Every time Firebase data changes (trade saved, settings updated, balance changed)
// this fires and refreshes ALL displays automatically
// ──────────────────────────────────────────────
onValue(ref(db, 'isi_v6/clusters'), (snap) => {
    clusters = snap.val() || {};
    document.getElementById('fbStatus').textContent = '● LIVE';
    document.getElementById('fbStatus').className   = 'fb-dot live';
    renderTimerSlider();
    populateClusterDropdown();
    updateClock();
    renderBalanceDisplay();
    renderPortal();
    updateSelectedInfoBar();
    updateRiskCalc();
    // Init flow UI on first load
    initFlowUI();
    loadPreEntryBadge();
});

// ──────────────────────────────────────────────
// FIREBASE – DEDICATED STATS LISTENER (lightweight)
// isi_v6/stats/{clusterId}/{nodeIdx} = { currentBal, trades, wins, winRate, net }
// This path has NO images/tradeHistory — updates instantly
// Also migrates old stats from nodes path on first load
// ──────────────────────────────────────────────
onValue(ref(db, 'isi_v6/stats'), (snap) => {
    liveStats = snap.val() || {};
    // Re-render all balance displays whenever stats change
    renderBalanceDisplay();
    renderPortal();
    updateSelectedInfoBar();
    updateRiskCalc();
});

// ──────────────────────────────────────────────
// HELPER — get all active time slots for a node today
// Supports new timeSlots format AND old times format
// Returns: [ { start, end, expire, risk, qtyFrom, qtyTo, slotIdx } ]
// ──────────────────────────────────────────────
// ──────────────────────────────────────────────
function renderTimerSlider() {
    const grid    = document.getElementById('timerSlider');
    const entries = Object.entries(clusters);
    grid.innerHTML = '';

    const dayName = ['SUN','MON','TUE','WED','THU','FRI','SAT'][new Date().getDay()];

    if (!entries.length) {
        grid.innerHTML = '<div class="tc-empty-state">📡 No clusters found. Go to SETUP.</div>';
        return;
    }

    let todayCards = [];
    entries.forEach(([cId, cluster]) => {
        cluster.nodes.forEach((node, nIdx) => {
            const slots = getNodeSlotsForDay(node, dayName);
            slots.forEach(slot => {
                todayCards.push({ cId, cluster, node, nIdx, times: slot, slotIdx: slot.slotIdx });
            });
        });
    });

    if (!todayCards.length) {
        grid.innerHTML = '<div class="tc-empty-state">📅 No trades scheduled for today (' + dayName + '). Configure in SETUP.</div>';
        grid.classList.add('no-anim');
        return;
    }

    todayCards.forEach(({ cId, cluster, node, nIdx, times, slotIdx }) => {
        const s       = getNodeStats(cId, nIdx);
        const liveBal = s.currentBal ?? node.balance ?? 0;
        const slotRisk   = times.risk    ?? node.risk    ?? 0;
        const slotQFrom  = times.qtyFrom ?? node.qtyFrom ?? 1;
        const slotQTo    = times.qtyTo   ?? node.qtyTo   ?? 10;
        const riskAmt = (liveBal * slotRisk / 100).toFixed(0);
        const slotLabel = slotIdx > 0 ? ` (S${slotIdx+1})` : '';
        grid.innerHTML += `
            <div class="s-timer-card stc-landscape" data-cluster="${cId}" data-node="${nIdx}" data-slot="${slotIdx}" onclick="selectFromSliderCard(this)" style="cursor:pointer;">
                <div class="stc-left">
                    <div class="stc-cluster">${cluster.title}</div>
                    <div class="stc-name">${node.title || 'Account ' + (nIdx + 1)}${slotLabel}</div>
                    <div class="stc-window">${times.start} → ${times.end || '--'} → ${times.expire || '--'}</div>
                    <div class="stc-risk">${node.curr}${riskAmt} risk · ${slotRisk}% · Qty ${slotQFrom}–${slotQTo}</div>
                </div>
                <div class="stc-right">
                    <div class="stc-status-text tc-status-text">LOADING</div>
                    <div class="stc-countdown tc-timer-main">--:--:--</div>
                    <div class="stc-live-label">LIVE IN</div>
                </div>
            </div>`;
    });

    // Duplicate for seamless scroll if enough cards
    if (todayCards.length > 2) {
        grid.innerHTML += grid.innerHTML;
        grid.classList.remove('no-anim');
    } else {
        grid.classList.add('no-anim');
    }

    highlightSelectedCard();
}

// ──────────────────────────────────────────────
// CLUSTER DROPDOWN
// ──────────────────────────────────────────────
function populateClusterDropdown() {
    const sel       = document.getElementById('clusterSelect');
    const saved     = localStorage.getItem('isi_sel_cluster');
    const savedNode = localStorage.getItem('isi_sel_node');

    sel.innerHTML = '<option value="">— Select Cluster —</option>';
    Object.entries(clusters).forEach(([id, c]) => {
        const o = document.createElement('option');
        o.value = id; o.textContent = c.title;
        sel.appendChild(o);
    });

    if (saved && clusters[saved]) {
        sel.value = saved; selectedClusterId = saved;
        populateAccountDropdown(saved);
        updatePassHint();
        if (savedNode !== null && savedNode !== '') {
            document.getElementById('accountSelect').value = savedNode;
            selectedNodeIdx = parseInt(savedNode);
            onAccountSelected();
        }
    }
}

function populateAccountDropdown(clusterId) {
    const sel = document.getElementById('accountSelect');
    sel.innerHTML = '<option value="">— Select Account —</option>';
    sel.disabled  = false;
    const nodes = clusters[clusterId]?.nodes || [];

    nodes.forEach((node, idx) => {
        const o   = document.createElement('option');
        const s   = getNodeStats(clusterId, idx);
        const bal = s.currentBal ?? node.balance ?? 0;
        o.value       = idx;
        o.textContent = `${node.title || 'Account ' + (idx + 1)}  [#${node.order || idx+1}]  ${node.curr}${bal.toLocaleString()}`;
        sel.appendChild(o);
    });
}

// ──────────────────────────────────────────────
// PASSWORD HINT
// ──────────────────────────────────────────────
function updatePassHint() {
    const hint = document.getElementById('passHint');
    if (!hint) return;
    if (selectedClusterId && clusters[selectedClusterId]) {
        hint.textContent = `(Key for cluster: "${clusters[selectedClusterId].title}")`;
    } else {
        hint.textContent = '(Select a cluster first)';
    }
}

// ──────────────────────────────────────────────
// DROPDOWN EVENT HANDLERS  (called from HTML)
// ──────────────────────────────────────────────
window.onClusterChange = function () {
    selectedClusterId = document.getElementById('clusterSelect').value || null;
    selectedNodeIdx   = null;

    const accSel = document.getElementById('accountSelect');
    accSel.innerHTML = '<option value="">— Select Account —</option>';
    accSel.disabled  = true;

    updateModeBadge(); hideSelectedInfoBar(); removeCardHighlight();
    tradeHistory = []; equityPoints = [];
    updatePassHint();

    document.getElementById('noClusterWarn').className = selectedClusterId ? 'vis' : '';

    if (selectedClusterId) {
        populateAccountDropdown(selectedClusterId);
        localStorage.setItem('isi_sel_cluster', selectedClusterId);
        localStorage.removeItem('isi_sel_node');
        // Load cluster-combined equity chart
        loadClusterEquity();
        const titleEl = document.getElementById('equityChartTitle');
        if (titleEl) titleEl.textContent = `1. Cluster Equity Pulse — ${clusters[selectedClusterId]?.title || ''}  (Combined)`;
    } else {
        localStorage.removeItem('isi_sel_cluster');
        localStorage.removeItem('isi_sel_node');
    }

    renderAll();
};

window.onAccountChange = function () {
    const val = document.getElementById('accountSelect').value;
    if (val === '') {
        selectedNodeIdx = null;
        updateModeBadge(); hideSelectedInfoBar(); removeCardHighlight();
        localStorage.removeItem('isi_sel_node');
        tradeHistory = []; equityPoints = [];
        // Restore cluster-combined view
        const titleEl = document.getElementById('equityChartTitle');
        if (titleEl) titleEl.textContent = `1. Cluster Equity Pulse — ${clusters[selectedClusterId]?.title || ''} (Combined)`;
        loadClusterEquity();
        return;
    }
    selectedNodeIdx = parseInt(val);
    selectedSlotIdx = 0;
    localStorage.setItem('isi_sel_node', selectedNodeIdx);
    onAccountSelected();
};

function onAccountSelected(preserveSlot) {
    updateModeBadge(); updateSelectedInfoBar(); highlightSelectedCard();
    document.getElementById('noClusterWarn').className = '';
    const n = getActiveNode();
    const titleEl = document.getElementById('equityChartTitle');
    if (titleEl && n) titleEl.textContent = `1. Equity Pulse — ${n.title || 'Account ' + (selectedNodeIdx + 1)}`;
    loadNodeData();
    populateTradeSlotDropdown(preserveSlot);
    updateRiskCalc();
    renderAll();
}

// ──────────────────────────────────────────────
// TRADE SLOT DROPDOWN
// Shows all time slots of selected node for today
// If only 1 slot → hide dropdown, auto-select slot 0
// If multiple slots → show dropdown
// ──────────────────────────────────────────────
function populateTradeSlotDropdown(preserveSlot) {
    const wrap = document.getElementById('tradeSlotWrap');
    const sel  = document.getElementById('tradeSlotSelect');
    if (!wrap || !sel) return;

    const n = getActiveNode();
    if (!n) { wrap.style.display = 'none'; return; }

    const dayName = ['SUN','MON','TUE','WED','THU','FRI','SAT'][new Date().getDay()];
    const slots   = getNodeSlotsForDay(n, dayName);

    sel.innerHTML = '';
    if (slots.length <= 1) {
        wrap.style.display = 'none';
        if (!preserveSlot) selectedSlotIdx = 0;
        return;
    }

    // Multiple slots — show dropdown
    wrap.style.display = 'block';
    slots.forEach((sl, i) => {
        const o = document.createElement('option');
        o.value = i;
        o.textContent = `Slot ${i + 1}  ${sl.start} → ${sl.expire || '--'}  (Risk: ${sl.risk}%)`;
        sel.appendChild(o);
    });

    // If preserveSlot, keep current selectedSlotIdx; else reset to 0
    if (!preserveSlot) selectedSlotIdx = 0;
    // Clamp to valid range
    if (selectedSlotIdx >= slots.length) selectedSlotIdx = 0;
    sel.value = String(selectedSlotIdx);
}

window.onTradeSlotChange = function () {
    const val = document.getElementById('tradeSlotSelect').value;
    selectedSlotIdx = val !== '' ? parseInt(val) : 0;
    updateRiskCalc();
    updateSelectedInfoBar();
    highlightSelectedCard(); // ← slot change pe card highlight update karo
};


// ──────────────────────────────────────────────
// MODE BADGE + INFO BAR
// ──────────────────────────────────────────────
function updateModeBadge() {
    const b = document.getElementById('modeBadge');
    if (!selectedClusterId || selectedNodeIdx === null) {
        b.textContent = 'NO SELECTION'; b.className = 'mode-badge no-sel'; return;
    }
    const n = getActiveNode(); if (!n) return;
    b.className = 'mode-badge';
    b.textContent = n.title || ('Account ' + (selectedNodeIdx + 1));
}

// ──────────────────────────────────────────────
// HELPER — get risk% for a node
// Priority: today's selected slot → any slot from any day → node.risk → 0
// ──────────────────────────────────────────────
function getNodeRisk(node, dayName, slotIdx) {
    slotIdx = slotIdx || 0;
    // 1. Try today's slot
    const todaySlots = getNodeSlotsForDay(node, dayName);
    const todaySlot  = todaySlots[slotIdx] || todaySlots[0];
    if (todaySlot && todaySlot.risk != null) return todaySlot.risk;

    // 2. Try any day's first slot (pick first non-empty day)
    const days = ['MON','TUE','WED','THU','FRI','SAT','SUN'];
    for (const d of days) {
        const s = getNodeSlotsForDay(node, d);
        if (s.length > 0 && s[0].risk != null) return s[0].risk;
    }

    // 3. Fallback to node-level risk (old format)
    return node.risk ?? 0;
}

function updateSelectedInfoBar() {
    const bar = document.getElementById('selectedInfoBar');
    if (!selectedClusterId || selectedNodeIdx === null) { bar.classList.remove('vis'); return; }
    const n = getActiveNode(); if (!n) return;

    const s        = getNodeStats(selectedClusterId, selectedNodeIdx);
    const liveBal  = s.currentBal ?? n.balance ?? 0;
    const dayName  = ['SUN','MON','TUE','WED','THU','FRI','SAT'][new Date().getDay()];
    const slots    = getNodeSlotsForDay(n, dayName);
    const slot     = slots[selectedSlotIdx] || slots[0] || {};
    const riskPct  = getNodeRisk(n, dayName, selectedSlotIdx);
    const rAmt     = (liveBal * riskPct / 100).toFixed(2);
    const timeWindow = slot.start ? `${slot.start} → ${slot.expire || '--'}` : 'Not set (today)';

    document.getElementById('sibName').textContent    = n.title || ('Account ' + (selectedNodeIdx + 1));
    document.getElementById('sibBal').textContent     = `${n.curr}${liveBal.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
    document.getElementById('sibTime').textContent    = timeWindow;
    document.getElementById('sibRiskAmt').textContent = `${n.curr}${rAmt}`;
    bar.classList.add('vis');
}

function hideSelectedInfoBar() { document.getElementById('selectedInfoBar').classList.remove('vis'); }

function highlightSelectedCard() {
    removeCardHighlight();
    if (!selectedClusterId || selectedNodeIdx === null) return;
    document.querySelectorAll('.s-timer-card').forEach(c => {
        const matchCluster = c.dataset.cluster === selectedClusterId;
        const matchNode    = parseInt(c.dataset.node) === selectedNodeIdx;
        const matchSlot    = parseInt(c.dataset.slot || '0') === selectedSlotIdx;
        if (matchCluster && matchNode && matchSlot)
            c.classList.add('node-selected');
    });
}
function removeCardHighlight() {
    document.querySelectorAll('.s-timer-card').forEach(c => c.classList.remove('node-selected'));
}

// ── SELECT FROM SLIDER CARD CLICK ──
window.selectFromSliderCard = function(card) {
    const cId   = card.dataset.cluster;
    const nIdx  = parseInt(card.dataset.node);
    const sIdx  = parseInt(card.dataset.slot || '0');
    if (!cId || !clusters[cId]) return;

    // Set cluster dropdown
    const clSel = document.getElementById('clusterSelect');
    if (clSel) { clSel.value = cId; }
    selectedClusterId = cId;
    localStorage.setItem('isi_sel_cluster', cId);

    // Populate account dropdown
    populateAccountDropdown(cId);

    // Set account dropdown
    const accSel = document.getElementById('accountSelect');
    if (accSel) { accSel.value = String(nIdx); accSel.disabled = false; }
    selectedNodeIdx = nIdx;
    selectedSlotIdx = sIdx;
    localStorage.setItem('isi_sel_node', nIdx);

    // Set trade slot dropdown
    const dayName = ['SUN','MON','TUE','WED','THU','FRI','SAT'][new Date().getDay()];
    const n = clusters[cId]?.nodes[nIdx];
    if (n) {
        const slots = getNodeSlotsForDay(n, dayName);
        const wrap = document.getElementById('tradeSlotWrap');
        const slSel = document.getElementById('tradeSlotSelect');
        if (slots.length > 1 && wrap && slSel) {
            wrap.style.display = 'block';
            slSel.innerHTML = '';
            slots.forEach((sl, i) => {
                const o = document.createElement('option');
                o.value = i;
                o.textContent = `Slot ${i+1}  ${sl.start} → ${sl.expire||'--'}  (Risk: ${sl.risk}%)`;
                slSel.appendChild(o);
            });
            slSel.value = String(sIdx);
        } else if (wrap) {
            wrap.style.display = 'none';
        }
    }

    onAccountSelected(true); // true = preserve selectedSlotIdx
};

// ──────────────────────────────────────────────
// RISK CALCULATION
// ──────────────────────────────────────────────
window.updateRiskCalc = function () {
    const n = getActiveNode();
    if (!n) return;

    // Clear riskQty — user manually enters this
    const rqEl = document.getElementById('riskQty');
    if (rqEl && !rqEl.dataset.userEdited) rqEl.value = '';

    updateFlowStatus();
};

// Custom asset toggle
window.onAssetChange = function () {
    const sel    = document.getElementById('assetSelect');
    const custom = document.getElementById('assetCustomInput');
    if (!sel || !custom) return;
    if (sel.value === 'CUSTOM') {
        custom.style.display = 'block';
        custom.focus();
    } else {
        custom.style.display = 'none';
        custom.value = '';
    }
    updateRiskCalc();
};

// Get actual asset name (custom or dropdown)
function getSelectedAsset() {
    const sel = document.getElementById('assetSelect');
    if (!sel) return 'XAUUSD';
    if (sel.value === 'CUSTOM') {
        const ci = document.getElementById('assetCustomInput');
        return (ci?.value?.trim().toUpperCase()) || 'CUSTOM';
    }
    return sel.value || 'XAUUSD';
}

// ──────────────────────────────────────────────
// BIAS ENGINE
// ──────────────────────────────────────────────
// ──────────────────────────────────────────────
// PERMISSION MATRIX — INSTITUTIONAL BIAS ENGINE
// HTF + LTF structure, conflict detection, SMC flags
// ──────────────────────────────────────────────
const permState = {
    htf: {},   // { ms, zone }
    ltf: {},   // { ms, candle }
    smc: {}    // { liqHunt, orderBlock, ... }
};

window.setPermStruct = function (btn) {
    const tf  = btn.dataset.tf;
    const key = btn.dataset.key;
    const val = btn.dataset.val;
    const typ = btn.dataset.type;

    document.querySelectorAll(`.perm-struct-btn[data-tf="${tf}"][data-key="${key}"]`)
        .forEach(b => b.classList.remove('p-bull','p-bear','p-neut'));
    btn.classList.add(typ === 'bull' ? 'p-bull' : typ === 'bear' ? 'p-bear' : 'p-neut');

    if (!permState[tf]) permState[tf] = {};
    permState[tf][key] = val;

    runBiasEngine();
    updateFlowStatus();
};

window.toggleSMC = function (btn) {
    const key = btn.dataset.key;
    btn.classList.toggle('smc-on');
    permState.smc[key] = btn.classList.contains('smc-on');
    runBiasEngine();
    updateFlowStatus();
};

function runBiasEngine() {
    const htfMs  = permState.htf?.ms    || '';
    const htfZn  = permState.htf?.zone  || '';
    const ltfMs  = permState.ltf?.ms    || '';
    const ltfCn  = permState.ltf?.candle || '';

    const htfBull = htfMs.includes('BULL') || htfMs === 'TREND_BULL';
    const htfBear = htfMs.includes('BEAR');
    const ltfBull = ltfMs.includes('BULL') || ['MITIGATION','REJECTION','ENGULF','PINBAR','LIQ_HUNT'].includes(ltfCn);
    const ltfBear = ltfMs.includes('BEAR');
    const discZone = htfZn === 'DISCOUNT' || htfZn === 'DEMAND';
    const premZone = htfZn === 'PREMIUM'  || htfZn === 'SUPPLY';

    // Conflict detection
    let conflict = '';
    if (htfBull && ltfBear)
        conflict = `HTF BULLISH (${htfMs}) but LTF BEARISH (${ltfMs}) — Wait for LTF CHoCH bullish before entry.`;
    else if (htfBear && ltfBull)
        conflict = `HTF BEARISH (${htfMs}) but LTF BULLISH (${ltfMs}) — Counter-trend. Wait for LTF bearish confirmation.`;
    else if (discZone && ltfBear && htfBull)
        conflict = `In HTF DISCOUNT/DEMAND zone but LTF still bearish — Possible final sweep. Wait for LTF BOS.`;
    else if (premZone && ltfBull && htfBear)
        conflict = `In HTF PREMIUM/SUPPLY zone but LTF bullish — Possible stop hunt in progress. Wait for CHoCH.`;

    const conflictEl = document.getElementById('termConflict');
    const conflictMsg = document.getElementById('termConflictMsg');
    if (conflict) {
        conflictEl.style.display = 'block';
        conflictMsg.textContent = conflict;
    } else {
        conflictEl.style.display = 'none';
    }

    // Bias result
    const el = document.getElementById('biasDisplay');
    let bias = '', bg = '', color = '', border = '#222';

    if (htfBull && ltfBull && discZone) {
        bias = '🟢 STRONG INSTITUTIONAL LONG — HTF + LTF + DISCOUNT ZONE ALIGNED ▲';
        bg = '#001800'; color = 'var(--accent)'; border = 'var(--accent)';
    } else if (htfBear && ltfBear && premZone) {
        bias = '🔴 STRONG INSTITUTIONAL SHORT — HTF + LTF + PREMIUM ZONE ALIGNED ▼';
        bg = '#180000'; color = 'var(--danger)'; border = 'var(--danger)';
    } else if (htfBull && ltfBull) {
        bias = '🟡 BULLISH BIAS — HTF + LTF ALIGNED ▲ (Zone unconfirmed)';
        bg = '#100d00'; color = 'var(--gold)'; border = 'var(--gold)';
    } else if (htfBear && ltfBear) {
        bias = '🟡 BEARISH BIAS — HTF + LTF ALIGNED ▼ (Zone unconfirmed)';
        bg = '#100d00'; color = 'var(--gold)'; border = 'var(--gold)';
    } else if (htfBull && discZone) {
        bias = '🔵 DISCOUNT + HTF BULL — Waiting for LTF confirmation ▲';
        bg = '#000d18'; color = '#4a9eff'; border = '#4a9eff';
    } else if (htfBear && premZone) {
        bias = '🔵 PREMIUM + HTF BEAR — Waiting for LTF confirmation ▼';
        bg = '#000d18'; color = '#4a9eff'; border = '#4a9eff';
    } else if (conflict) {
        bias = '⚠ TIMEFRAME CONFLICT — See warning above. High risk. Do not trade.';
        bg = '#1a0800'; color = '#ff6600'; border = '#ff6600';
    } else if (htfMs || ltfMs) {
        bias = '⬜ PARTIAL — Complete both HTF and LTF analysis for full bias';
        bg = '#0a0a0a'; color = '#888';
    } else {
        bias = 'Select HTF + LTF structure to generate institutional bias';
        bg = '#0a0a0a'; color = '#555';
    }

    el.style.background = bg;
    el.style.color = color;
    el.style.borderColor = border;
    el.textContent = bias;

    // Store for trade save
    permState._bias     = bias;
    permState._conflict = conflict;
}

// ──────────────────────────────────────────────
// EXECUTION FLOW CHECKLIST — 8 STARS + G/R
// Star colors by position:
// 1=light yellow, 2=yellow, 3=orange, 4=light green,
// 5=full green, 6=light red, 7=red, 8=full red
// ──────────────────────────────────────────────
const STAR_COLORS = [
    '#d4c44a',  // 1 — light yellow
    '#ffee00',  // 2 — yellow
    '#ff8800',  // 3 — orange
    '#88dd66',  // 4 — light green
    '#00ff41',  // 5 — full green
    '#ff8888',  // 6 — light red
    '#ff3b3b',  // 7 — red
    '#dd0000',  // 8 — full red
];

window.initFlowUI = function () {
    const c = document.getElementById('binaryChecklist');
    if (!c) return;
    c.innerHTML = '';
    // Load from active node settings if available, fallback to default hardcoded
    const node    = getActiveNode();
    const keysToUse = (node?.flowKeys && node.flowKeys.length > 0) ? node.flowKeys : flowKeys;
    keysToUse.forEach((key, idx) => {
        const starColor = STAR_COLORS[idx] || '#c5a059';
        const state     = flowMemory[key] || '';
        const glowCSS   = state
            ? (state === 'G' ? `filter:drop-shadow(0 0 6px ${starColor}) drop-shadow(0 0 12px ${starColor});`
                             : `filter:drop-shadow(0 0 6px #ff3b3b);`)
            : '';
        const starOpacity = state ? '1' : '0.25';
        const div = document.createElement('div');
        div.className = 'bin-item';
        div.innerHTML = `
            <div class="bin-left">
                <span class="bin-star" id="star_${idx}"
                    style="color:${starColor};opacity:${starOpacity};${glowCSS}">★</span>
                <span class="bin-text">${key}</span>
            </div>
            <div class="bin-btns">
                <button type="button" class="t-btn g-off ${state==='G'?'g-on':''}"
                    onclick="setFlowState('${key}','G')">G</button>
                <button type="button" class="t-btn r-off ${state==='R'?'r-on':''}"
                    onclick="setFlowState('${key}','R')">R</button>
            </div>`;
        c.appendChild(div);
    });
};

window.setFlowState = function (key, val) {
    flowMemory[key] = val;
    initFlowUI();
    updateFlowStatus();
};

window.updateFlowStatus = function () {
    const greens    = Object.values(flowMemory).filter(v => v === 'G').length;
    const qty       = document.getElementById('riskQty')?.value?.trim();
    const liq       = document.getElementById('liqType')?.value;
    const card      = document.getElementById('flowCard');
    const title     = document.getElementById('flowTitle');
    const btn       = document.getElementById('executeBtn');
    if (!card || !btn) return;
    const ok        = (qty !== '' && liq !== '');
    const conflict  = !!permState._conflict;
    const hasBias   = !!(permState.htf?.ms && permState.ltf?.ms);

    if (greens >= 7 && ok && hasBias && !conflict) {
        card.className = 'card exec-card-ready';
        title.style.color = '#00ff41';
        btn.disabled = false;
        btn.style.cssText = 'background:linear-gradient(135deg,#003000,#006600);color:#00ff41;border:2px solid #00ff41;box-shadow:0 0 18px rgba(0,255,65,0.25);height:48px;font-weight:900;letter-spacing:2px;cursor:pointer;width:100%;border-radius:5px;';
        btn.innerText = '✅ AUTHORIZE ENTRY — ALL CLEAR';
    } else if (conflict) {
        card.className = 'card exec-card-locked';
        title.style.color = '#ff6600';
        btn.disabled = true;
        btn.style.cssText = 'background:#1a0800;color:#ff6600;border:1px solid #ff6600;height:48px;font-weight:900;letter-spacing:2px;cursor:not-allowed;width:100%;border-radius:5px;';
        btn.innerText = '⚠ TIMEFRAME CONFLICT — ENTRY BLOCKED';
    } else {
        card.className = 'card exec-card-locked';
        title.style.color = '#ff5252';
        btn.disabled = true;
        btn.style.cssText = 'background:#1a1a1a;color:#444;border:1px solid #333;height:48px;font-weight:900;letter-spacing:2px;cursor:not-allowed;width:100%;border-radius:5px;';
        const missing = [];
        if (greens < 7) missing.push(`${greens}/7 GREEN`);
        if (!hasBias)   missing.push('BIAS INCOMPLETE');
        if (!ok)        missing.push('FILL QTY + LIQ');
        btn.innerText = `LOCKED — ${missing.join(' · ')}`;
    }
};

// ──────────────────────────────────────────────
// LOAD PRE-ENTRY BADGE from localStorage
// ──────────────────────────────────────────────
function loadPreEntryBadge() {
    try {
        const pe = JSON.parse(localStorage.getItem('isi_last_preentry') || 'null');
        const badge = document.getElementById('preEntryBadge');
        if (!pe || !badge) return;
        const today = new Date().toISOString().slice(0,10);
        if (pe.date !== today) return; // only show today's

        badge.style.display = 'flex';
        document.getElementById('peBadgeScore').textContent = `Score: ${pe.score}/100`;
        document.getElementById('peBadgeBias').textContent  = pe.biasResult ? pe.biasResult.slice(0,50) : '';
        if (pe.conflict) document.getElementById('peBadgeConflict').textContent = '⚠ CONFLICT';

        // ── AUTO-FILL Trading Control Panel ──
        // Asset
        const assetSel = document.getElementById('assetSelect');
        const customIn = document.getElementById('assetCustomInput');
        if (assetSel && pe.asset) {
            const knownAssets = ['XAUUSD','EURUSD','GBPUSD','BTCUSD','NAS100','US30'];
            if (knownAssets.includes(pe.asset)) {
                assetSel.value = pe.asset;
                if (customIn) customIn.style.display = 'none';
            } else {
                assetSel.value = 'CUSTOM';
                if (customIn) { customIn.style.display = 'block'; customIn.value = pe.asset; }
            }
        }

        // ── SHOW ORDER CARD ──
        fillOrderCard(pe);

        // ── AUTO-FILL Qty in execution flow ──
        if (pe.calcQty) {
            const rqEl = document.getElementById('riskQty');
            if (rqEl) {
                rqEl.value = pe.calcQty;
                rqEl.dataset.userEdited = '1';
                updateFlowStatus();
            }
        }
    } catch(e) { console.warn('loadPreEntryBadge error:', e); }
}

// ── FILL ORDER CARD from pre-entry data ──
function fillOrderCard(pe) {
    const card = document.getElementById('orderCard');
    if (!card) return;

    if (!pe || !pe.entryPrice || !pe.stopLoss) {
        card.style.display = 'none';
        return;
    }

    card.style.display = 'block';

    const dirColor = pe.direction === 'LONG' ? '#00c805' : pe.direction === 'SHORT' ? '#ff3131' : '#c5a059';

    const setText = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val ?? '—';
    };

    setText('ocAsset',     pe.asset || '—');
    const dirEl = document.getElementById('ocDirection');
    if (dirEl) { dirEl.textContent = pe.direction || '—'; dirEl.style.color = dirColor; }
    setText('ocQty',       pe.calcQty     ? String(pe.calcQty)         : '—');
    setText('ocEntry',     pe.entryPrice  ? String(pe.entryPrice)      : '—');
    setText('ocSL',        pe.stopLoss    ? String(pe.stopLoss)        : '—');
    setText('ocTarget',    pe.targetZone  ? String(pe.targetZone)      : '—');
    setText('ocRiskAmt',   pe.riskAmt     ? `${pe.curr||''}${pe.riskAmt}` : '—');
    setText('ocRiskPct',   pe.riskPct     ? `${pe.riskPct}%`          : '—');
    setText('ocScore',     pe.score       ? `${pe.score}/100`          : '—');

    const rr = pe.rrPlanned || pe.calcRR || '—';
    setText('ocRR',        rr !== '—' ? `1:${rr} R` : '—');
}

window.revealSections = function () {
    if (!selectedClusterId || selectedNodeIdx === null)
        return alert('Select a Cluster and Account first!');
    document.getElementById('postTradeSections').style.display = 'block';
    document.getElementById('postTradeSections').scrollIntoView({ behavior: 'smooth' });
};

window.addVio = function () {
    const v = document.getElementById('vSelect').value;
    if (v !== 'None' && !currentVios.includes(v)) {
        currentVios.push(v);
        document.getElementById('vListDisplay').innerHTML += `<span class="vio-tag">${v}</span>`;
    }
};

// ──────────────────────────────────────────────
// SAVE TRADE → FIREBASE
// ──────────────────────────────────────────────
window.handleSaveAction = async function () {
    if (!verifyPass()) return;
    if (!selectedClusterId || selectedNodeIdx === null)
        return alert('Select Cluster + Account first!');

    const node = getActiveNode();
    if (!node) return alert('Active node not found!');

    if (!document.getElementById('checkPositions').checked ||
        !document.getElementById('checkMT5').checked       ||
        !document.getElementById('checkApp').checked        ||
        !document.getElementById('checkLaptop').checked)
        return alert('Complete all Shutdown Protocol steps first!');

    const file = document.getElementById('screenshotInput').files[0];
    if (!file) return alert('Please upload a trade screenshot!');

    const reader = new FileReader();
    reader.onloadend = async function () {
        const img     = reader.result;
        const pl      = parseFloat(document.getElementById('netPL').value) || 0;
        const out     = document.getElementById('outcome').value;
        const finalPL = (out === 'Stop Loss' ? -Math.abs(pl) : pl);

        const trade = {
            date:      document.getElementById('tradeDate').value,
            nodeTitle: node.title || 'Account ' + (selectedNodeIdx + 1),
            clusterId: selectedClusterId,
            nodeIdx:   selectedNodeIdx,
            type:      out,
            pl:        finalPL,
            entry:     document.getElementById('entryPrice').value,
            exit:      document.getElementById('exitPrice').value,
            position:  document.getElementById('positionType').value,
            asset:     getSelectedAsset(),
            grade:     document.getElementById('gradeSelect').value,
            vios:      [...currentVios],
            liq:       document.getElementById('liqType').value,
            // Institutional bias data
            htfMs:     permState.htf?.ms    || '',
            htfZone:   permState.htf?.zone  || '',
            ltfMs:     permState.ltf?.ms    || '',
            ltfCandle: permState.ltf?.candle || '',
            smcFlags:  Object.keys(permState.smc).filter(k => permState.smc[k]),
            biasResult:permState._bias     || '',
            conflict:  permState._conflict || '',
            psy: [
                document.getElementById('psy1').value,
                document.getElementById('psy2').value,
                document.getElementById('psy3').value,
                document.getElementById('psy4').value,
                document.getElementById('psy5').value,
                document.getElementById('lesson').value
            ],
            scale:   Array.from(document.querySelectorAll('.scale:checked')).map(c => c.value),
            image:   img,
            savedAt: new Date().toISOString()
        };

        try {
            // ── STEP 1: Fetch LIVE stats from dedicated stats path ──
            const liveSnap  = await get(ref(db, activeStatsPath()));
            const liveStatsSnap = liveSnap.val() || getNodeStats(selectedClusterId, selectedNodeIdx);

            // Use live currentBal — fallback to node.balance if no trades yet
            const oldBal  = liveStatsSnap.currentBal ?? node.balance ?? 0;
            const newBal  = oldBal + finalPL;
            const newT    = (liveStatsSnap.trades || 0) + 1;
            const newW    = (liveStatsSnap.wins   || 0) + (out === 'Target' ? 1 : 0);
            const newNet  = (liveStatsSnap.net    || 0) + finalPL;
            const newWR   = parseFloat(((newW / newT) * 100).toFixed(1));

            // ── STEP 2: Save trade history ──
            await push(ref(db, `${nodeBasePath()}/tradeHistory`), trade);

            // ── STEP 3: Write to dedicated stats path (lightweight, instant update) ──
            await writeStats(selectedClusterId, selectedNodeIdx, {
                currentBal: newBal,
                trades:     newT,
                wins:       newW,
                winRate:    newWR,
                net:        newNet
            });

            // ── STEP 4: Push equity point (for chart) ──
            await push(ref(db, `${nodeBasePath()}/equityPoints`), newBal);

            downloadSinglePDF(trade);

            // ── AI TRADE REVIEW (async, non-blocking) ──
            const aiBox = document.getElementById('aiTradeReviewBox');
            if (aiBox) {
                aiBox.style.display = 'block';
                aiBox.innerHTML = `<div style="display:flex;align-items:center;gap:10px;padding:12px;">
                    <div style="width:16px;height:16px;border:2px solid #c5a059;border-top-color:transparent;
                        border-radius:50%;animation:aiSpin 0.8s linear infinite;"></div>
                    <span style="color:#666;font-size:0.75rem;">AI tera trade review kar raha hai...</span>
                    <style>@keyframes aiSpin{to{transform:rotate(360deg)}}</style>
                </div>`;
                aiTradeReview(trade).then(result => {
                    renderAIResponse('aiTradeReviewBox', result, '🤖 AI Post-Trade Review');
                });
            }

            alert('✅ Session Locked & Saved!\n\nCapital Updated: ' + node.curr + newBal.toFixed(2));
            // Don't reload immediately — let AI review show
            setTimeout(() => location.reload(), 8000);

        } catch (err) {
            alert('Firebase Error: ' + err.message);
        }
    };
    reader.readAsDataURL(file);
};

// ──────────────────────────────────────────────
// RENDER ALL
// ──────────────────────────────────────────────
function renderAll() { updateChart(); renderBalanceDisplay(); renderPortal(); filterHistory(); }

function renderBalanceDisplay() {
    const d = document.getElementById('balanceDisplay');
    if (!selectedClusterId) { d.innerHTML='<div style="color:#555;font-size:0.78rem;">Select a cluster</div>'; return; }
    const cluster = clusters[selectedClusterId]; if (!cluster) return;
    d.innerHTML = '';

    cluster.nodes.forEach((node, idx) => {
        const active = idx === selectedNodeIdx;
        const s      = getNodeStats(selectedClusterId, idx);
        const bal    = s.currentBal ?? node.balance ?? 0;
        const chipId = `bchip_${idx}`;
        d.innerHTML += `
            <div class="balance-chip" id="${chipId}" style="${active?'border-color:#4a9eff;background:#080d14;':''}">
                <div style="font-size:0.65rem;color:#888;">${node.title||'Acc '+(idx+1)}</div>
                <b style="color:${active?'#4a9eff':'var(--gold)'};font-size:0.95rem;">
                    ${node.curr}${bal.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}
                </b>
            </div>`;
    });
}

function renderPortal() {
    const body = document.getElementById('portalBody');
    const foot = document.getElementById('portalFoot');
    if (!selectedClusterId) { body.innerHTML=''; foot.innerHTML=''; return; }
    const cluster = clusters[selectedClusterId]; if (!cluster) return;
    const nodes   = cluster.nodes;

    const totByCurr = {}, netByCurr = {};
    let tT = 0, tW = 0;

    body.innerHTML = '';
    nodes.forEach((n, i) => {
        const active = i === selectedNodeIdx;
        const s      = getNodeStats(selectedClusterId, i);
        const bal    = s.currentBal ?? n.balance ?? 0;
        const net    = s.net     || 0;
        const trades = s.trades  || 0;
        const wins   = s.wins    || 0;
        const wr     = trades ? ((wins/trades)*100).toFixed(1) : 0;
        const c      = n.curr || '$';

        body.innerHTML += `
            <tr style="${active?'background:#080d14;color:#4a9eff;':''}">
                <td>${n.title||'Acc '+(i+1)}</td>
                <td>${trades}</td><td>${wins}</td>
                <td style="color:${net>=0?'#00ff41':'#ff5252'}">${net>=0?'+':''}${c}${Math.abs(net).toFixed(2)}</td>
                <td>${wr}%</td>
                <td style="color:${active?'#4a9eff':'var(--gold)'};font-weight:bold;">${c}${bal.toFixed(2)}</td>
            </tr>`;

        totByCurr[c] = (totByCurr[c]||0) + bal;
        netByCurr[c] = (netByCurr[c]||0) + net;
        tT += trades; tW += wins;
    });

    const aumStr = Object.entries(totByCurr).map(([c,v])=>`${c}${v.toFixed(2)}`).join(' + ');
    const netStr = Object.entries(netByCurr).map(([c,v])=>`${v>=0?'+':''}${c}${v.toFixed(2)}`).join(' + ');
    foot.innerHTML = `<tr><td>TOTAL</td><td>${tT}</td><td>${tW}</td>
        <td style="color:${netStr.includes('-')?'#ff5252':'#00ff41'}">${netStr||'$0.00'}</td>
        <td>${tT?(tW/tT*100).toFixed(1):0}%</td>
        <td style="color:var(--gold);font-weight:bold;">${aumStr||'$0.00'}</td></tr>`;
}

// ──────────────────────────────────────────────
// EQUITY PULSE CHART
// Color logic per trade:
//   RED   — Stop Loss (direct)
//   BLUE  — Partial win: only scale[0] checked (40% only)
//   GREEN — Full win: 2+ scales checked (40%+30% or all three)
// Each point glows with RGB box-shadow matching its color
// ──────────────────────────────────────────────

// Range = number of trades to show
// ──────────────────────────────────────────────
// CHART RANGE CONFIG
// Weekly≈5 trades, Monthly≈20, Quarterly≈60, HalfYearly≈120, Annual≈240
// ──────────────────────────────────────────────
const RANGE_LABELS = ['Weekly', 'Monthly', 'Quarterly', 'Half-Yearly', 'Annual'];
const RANGE_VALUES = [7, 30, 90, 180, 365];
let activeRangeIdx = 1; // default Monthly

window.changeChartRange = function(idx) {
    activeRangeIdx = idx;
    document.querySelectorAll('.chart-range-btns button').forEach((b, i) => {
        b.style.background = i === idx ? 'var(--gold)' : '';
        b.style.color      = i === idx ? '#000'        : '';
    });
    updateChart();
};

// ──────────────────────────────────────────────
// PULSE COLOR LOGIC
// RED   = Stop Loss
// BLUE  = Target but only first scale (40%) — partial
// GREEN = Target with 2+ scales filled (40%+30% or all 3)
// ──────────────────────────────────────────────
function getPulseColor(trade) {
    if (!trade) return '#c5a059';
    if (trade.type === 'Stop Loss')   return '#d32f2f'; // RED
    if (trade.type === 'Break Even')  return '#1565c0'; // BLUE
    const scales      = (trade.scale || []).filter(s => s && s.trim() !== '');
    const scaleFilled = scales.length;
    if (scaleFilled >= 2) return '#00ff41'; // GREEN — good exit
    if (scaleFilled === 1) return '#1565c0'; // BLUE  — partial / first scale only
    return '#00ff41'; // profit with no scale tracking = green
}

function getGlowColor(color) {
    if (color === '#d32f2f') return 'rgba(211,47,47,0.85)';
    if (color === '#1565c0') return 'rgba(21,101,192,0.85)';
    if (color === '#00ff41') return 'rgba(0,255,65,0.85)';
    return 'rgba(197,160,89,0.6)';
}

// ──────────────────────────────────────────────
// CLEANUP CLUSTER LISTENERS
// Call before attaching new ones to avoid stacking
// ──────────────────────────────────────────────
function cleanupClusterListeners() {
    _clusterUnsubs.forEach(fn => { try { fn(); } catch(e) {} });
    _clusterUnsubs = [];
}

// ──────────────────────────────────────────────
// LOAD CLUSTER-COMBINED EQUITY
// Merges tradeHistory chronologically across all nodes
// Builds combined running equity curve
// ──────────────────────────────────────────────
function loadClusterEquity() {
    cleanupClusterListeners();
    if (!selectedClusterId || !clusters[selectedClusterId]) return;

    const cluster   = clusters[selectedClusterId];
    const nodes     = cluster.nodes || [];
    const nodeCount = nodes.length;
    if (!nodeCount) return;

    const allHistory = Array.from({ length: nodeCount }, () => []);

    nodes.forEach((node, nIdx) => {
        const unsub = onValue(
            ref(db, `isi_v6/clusters/${selectedClusterId}/nodes/${nIdx}/tradeHistory`),
            (snap) => {
                if (selectedNodeIdx !== null) return; // account selected — ignore
                allHistory[nIdx] = snap.val()
                    ? Object.values(snap.val()).filter(t => t && t.date)
                    : [];
                rebuildCombined();
            }
        );
        _clusterUnsubs.push(unsub);
    });

    function rebuildCombined() {
        if (selectedNodeIdx !== null) return;

        // Merge and sort all trades chronologically across all accounts
        const merged = allHistory.flat()
            .filter(t => t && t.date)
            .sort((a, b) => {
                const d = a.date.localeCompare(b.date);
                return d !== 0 ? d : (a.savedAt || '').localeCompare(b.savedAt || '');
            });

        tradeHistory = merged;

        // Build equity curve from sum of initial balances
        // equityPoints[0] = start balance (no trade yet)
        // equityPoints[i+1] = after trade i
        const startBal = nodes.reduce((s, n) => s + (n.balance ?? 0), 0);
        if (merged.length === 0) {
            const liveTot = nodes.reduce((sum, n, i) => {
                const s = getNodeStats(selectedClusterId, i);
                return sum + (s.currentBal ?? n.balance ?? 0);
            }, 0);
            equityPoints = liveTot > 0 ? [liveTot] : (startBal > 0 ? [startBal] : []);
        } else {
            let running = startBal;
            equityPoints = [running];
            merged.forEach(t => {
                running += (t.pl || 0);
                equityPoints.push(running);
            });
        }

        updateChart();
        renderBalanceDisplay();
        renderPortal();
        filterHistory();
    }
}

// ──────────────────────────────────────────────
// LOAD INDIVIDUAL NODE DATA
// ──────────────────────────────────────────────
function loadNodeData() {
    cleanupClusterListeners(); // stop cluster listeners when account selected
    if (!selectedClusterId || selectedNodeIdx === null) return;
    const node = getActiveNode();

    onValue(ref(db, `${nodeBasePath()}/tradeHistory`), (snap) => {
        tradeHistory = snap.val()
            ? Object.values(snap.val())
                .filter(t => t && t.date)
                .sort((a, b) => a.date.localeCompare(b.date) || (a.savedAt||'').localeCompare(b.savedAt||''))
            : [];

        // Build equity from tradeHistory so points align perfectly with trades
        const s        = getNodeStats(selectedClusterId, selectedNodeIdx);
        const startBal = node?.balance ?? 0;
        let running    = s.currentBal != null
            ? s.currentBal - tradeHistory.reduce((sum, t) => sum + (t.pl || 0), 0)
            : startBal;
        equityPoints = [running];
        tradeHistory.forEach(t => {
            running += (t.pl || 0);
            equityPoints.push(running);
        });

        filterHistory();
        updateChart();
    });
}

function updateChart() {
    const ctx = document.getElementById('equityLineChart');
    if (!ctx) return;
    const c2d = ctx.getContext('2d');
    if (chartInstance) { chartInstance.destroy(); chartInstance = null; }

    // equityPoints[0]   = starting balance (before any trade)
    // equityPoints[i+1] = balance after trade[i]
    // So tradeHistory[i] corresponds to equityPoints[i+1]
    // We slice by RANGE_VALUES[activeRangeIdx] trades
    const maxTrades  = RANGE_VALUES[activeRangeIdx];
    const histSlice  = tradeHistory.slice(-maxTrades);
    // For display: include the "before first trade" point + one per trade
    const startIdx   = Math.max(0, equityPoints.length - histSlice.length - 1);
    const eqSlice    = equityPoints.slice(startIdx);

    if (eqSlice.length <= 1 && histSlice.length === 0) {
        // No data — draw empty state
        c2d.clearRect(0, 0, ctx.width, ctx.height);
        chartInstance = new Chart(c2d, {
            type: 'line',
            data: { labels: ['No Trades Yet'], datasets: [{ data: [0], borderColor: '#1a1a1a', pointRadius: 0 }] },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    y: { grid: { color: 'rgba(255,255,255,0.02)' }, ticks: { color: '#333', font: { size: 9 } } },
                    x: { grid: { display: false }, ticks: { color: '#333', font: { size: 9 } } }
                }
            }
        });
        document.getElementById('chartWR').innerText = '0%';
        return;
    }

    // Build point colors:
    // eqSlice[0]   = start (no trade) → gold color
    // eqSlice[i+1] = after histSlice[i] → use trade's pulse color
    const pointColors = eqSlice.map((_, i) => {
        if (i === 0) return '#c5a059'; // starting balance point — gold
        return getPulseColor(histSlice[i - 1]);
    });

    // Labels:
    // eqSlice[0] = "Start"
    // eqSlice[i+1] = date of histSlice[i]
    const labels = eqSlice.map((_, i) => {
        if (i === 0) return 'Start';
        const t = histSlice[i - 1];
        return t?.date ? t.date.slice(5) : `T${i}`;
    });

    // Win rate for sliced range
    const wins = histSlice.filter(t => t && t.type === 'Target').length;
    const wr   = histSlice.length ? ((wins / histSlice.length) * 100).toFixed(1) : 0;
    document.getElementById('chartWR').innerText = wr + '%';

    // Glow plugin — draw colored glow under each point
    const glowPlugin = {
        id: 'pulseGlow',
        afterDatasetsDraw(chart) {
            const meta = chart.getDatasetMeta(0);
            meta.data.forEach((pt, i) => {
                const col  = pointColors[i];
                const glow = getGlowColor(col);

                // Outer glow ring
                c2d.save();
                c2d.shadowColor = glow;
                c2d.shadowBlur  = 18;
                c2d.beginPath();
                c2d.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
                c2d.fillStyle = col;
                c2d.fill();

                // Second pass — tighter inner glow
                c2d.shadowBlur  = 8;
                c2d.beginPath();
                c2d.arc(pt.x, pt.y, 3, 0, Math.PI * 2);
                c2d.fillStyle = col;
                c2d.fill();
                c2d.restore();
            });
        }
    };

    chartInstance = new Chart(c2d, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                data: eqSlice,
                segment: {
                    // Line segment color = color of the destination point (the trade result)
                    borderColor: ctx => pointColors[ctx.p1DataIndex] || '#c5a059'
                },
                borderWidth: 1.5,
                pointRadius:      5,
                pointHoverRadius: 8,
                pointBackgroundColor: ctx => pointColors[ctx.dataIndex] || '#c5a059',
                pointBorderColor:     ctx => pointColors[ctx.dataIndex] || '#c5a059',
                pointBorderWidth: 1,
                tension: 0.35,
                fill: false
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 300 },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        title: (items) => {
                            const i = items[0].dataIndex;
                            if (i === 0) return 'Starting Balance';
                            const t = histSlice[i - 1];
                            return t ? `${t.date} — ${t.nodeTitle || ''}` : items[0].label;
                        },
                        label: (item) => {
                            const i   = item.dataIndex;
                            const bal = item.parsed.y;
                            if (i === 0) return `Balance: $${bal.toLocaleString('en-US', {minimumFractionDigits:2})}`;
                            const t = histSlice[i - 1];
                            if (!t) return `Balance: $${bal.toFixed(2)}`;
                            const scales = (t.scale||[]).filter(s=>s).length;
                            const outcome = t.type === 'Stop Loss'
                                ? '🔴 STOP LOSS'
                                : scales >= 2 ? '🟢 FULL WIN' : '🔵 PARTIAL (1 Scale)';
                            return [
                                `${outcome}`,
                                `P/L: $${(t.pl||0).toFixed(2)}`,
                                `Balance: $${bal.toLocaleString('en-US',{minimumFractionDigits:2})}`
                            ];
                        }
                    },
                    backgroundColor: '#0d1117',
                    borderColor: '#2a2a2a',
                    borderWidth: 1,
                    titleColor: '#c5a059',
                    bodyColor: '#aaa',
                    padding: 10
                }
            },
            scales: {
                y: {
                    grid: { color: 'rgba(255,255,255,0.03)' },
                    ticks: {
                        color: '#555',
                        font: { size: 9 },
                        callback: v => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 0 })
                    }
                },
                x: {
                    grid: { display: false },
                    ticks: { color: '#444', font: { size: 9 }, maxRotation: 45, maxTicksLimit: 12 }
                }
            }
        },
        plugins: [glowPlugin]
    });
}

// ──────────────────────────────────────────────
// HISTORY FILTER + TABLE
// ──────────────────────────────────────────────
window.filterHistory = function () {
    const from = document.getElementById('histFrom').value;
    const to   = document.getElementById('histTo').value;
    const body = document.getElementById('historyBody');
    body.innerHTML = '';

    let filtered = tradeHistory.filter(h => (!from || h.date >= from) && (!to || h.date <= to));
    const display = (from || to) ? filtered : filtered.slice(-6);

    display.slice().reverse().forEach(h => {
        const idx = tradeHistory.indexOf(h);
        body.innerHTML += `
            <tr>
                <td>${h.date}</td>
                <td>${h.nodeTitle || '—'}</td>
                <td>${h.asset || '—'}</td>
                <td style="color:${h.type === 'Target' ? '#00ff41' : '#ff3131'}">${h.type}</td>
                <td style="color:${h.pl >= 0 ? '#00ff41' : '#ff5252'}">$${h.pl}</td>
                <td>${h.grade}</td>
                <td>
                    <button class="view-btn" onclick="viewDeepDive(${idx})">VIEW</button>
                    <button class="del-btn"  onclick="deleteTrade(${idx})">DEL</button>
                </td>
            </tr>`;
    });
};

// ──────────────────────────────────────────────
// DEEP DIVE MODAL
// ──────────────────────────────────────────────
window.viewDeepDive = function (idx) {
    const t = tradeHistory[idx]; if (!t) return;
    document.getElementById('modalData').innerHTML = `
        <div class="grid">
            <div><b>Date:</b> ${t.date}</div>
            <div><b>Account:</b> ${t.nodeTitle || '—'}</div>
            <div><b>Asset:</b> ${t.asset || '—'}</div>
            <div><b>Position:</b> ${t.position || '—'}</div>
            <div><b>Entry:</b> ${t.entry || '—'}</div>
            <div><b>Exit:</b> ${t.exit || '—'}</div>
            <div><b>P/L:</b> $${t.pl}</div>
            <div><b>Grade:</b> ${t.grade}</div>
            <div><b>Liquidity:</b> ${t.liq || '—'}</div>
            <div><b>Scales:</b> ${(t.scale || []).join(', ') || 'None'}</div>
        </div>
        <div style="margin-top:14px;"><b>Violations:</b><br>
            ${(t.vios || []).map(v => `<span class="vio-tag">${v}</span>`).join('') || 'None'}
        </div>
        <div style="margin-top:14px; background:#111; padding:13px; border-radius:8px; border:1px solid #222;">
            <p><b>Plan vs Emotion:</b> ${(t.psy || [])[0] || '—'}</p>
            <p><b>Setup:</b> ${(t.psy || [])[1] || '—'}</p>
            <p><b>Patience:</b> ${(t.psy || [])[2] || '—'}</p>
            <p><b>Focus:</b> ${(t.psy || [])[3] || '—'}</p>
            <p><b>Emotional Bias:</b> ${(t.psy || [])[4] || '—'}</p>
            <p><b>Key Lesson:</b> ${(t.psy || [])[5] || '—'}</p>
        </div>
        ${t.image ? `<div style="margin-top:14px;"><b>Screenshot:</b><br>
            <img src="${t.image}" style="max-width:100%; border-radius:6px; margin-top:7px; border:1px solid #333;"></div>` : ''}`;
    document.getElementById('viewModal').style.display = 'block';
};

window.closeModal = function () { document.getElementById('viewModal').style.display = 'none'; };

// ──────────────────────────────────────────────
// DELETE TRADE
// ──────────────────────────────────────────────
window.deleteTrade = async function (idx) {
    if (!verifyPass()) return;
    if (!confirm('Permanently delete this trade?')) return;

    const t = tradeHistory[idx]; if (!t) return;

    // Fetch live tradeHistory keys from Firebase
    const snap    = await get(ref(db, `${nodeBasePath()}/tradeHistory`));
    const val     = snap.val(); if (!val) return;
    const entries = Object.entries(val);

    if (entries[idx]) {
        const [key] = entries[idx];
        await remove(ref(db, `${nodeBasePath()}/tradeHistory/${key}`));

        // Fetch LIVE stats from dedicated path
        const liveSnap  = await get(ref(db, activeStatsPath()));
        const liveStatsSnap = liveSnap.val() || getNodeStats(selectedClusterId, selectedNodeIdx);

        const node   = getActiveNode();
        const newBal = (liveStatsSnap.currentBal ?? node?.balance ?? 0) - t.pl;
        const newT   = Math.max(0, (liveStatsSnap.trades || 1) - 1);
        const newW   = Math.max(0, (liveStatsSnap.wins   || 0) - (t.type === 'Target' ? 1 : 0));
        const newNet = (liveStatsSnap.net || 0) - t.pl;

        await writeStats(selectedClusterId, selectedNodeIdx, {
            currentBal: newBal,
            trades:     newT,
            wins:       newW,
            winRate:    newT ? parseFloat(((newW / newT) * 100).toFixed(1)) : 0,
            net:        newNet
        });
        alert('✅ Trade deleted. Capital recalculated.');
    }
};

// ──────────────────────────────────────────────
// PDF EXPORT
// ──────────────────────────────────────────────
window.downloadSinglePDF = function (t) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    doc.setFontSize(14); doc.text('ISI INSTITUTIONAL TRADE REPORT', 14, 18);
    doc.setFontSize(9);
    doc.autoTable({
        startY: 26,
        body: [
            ['Date', t.date], ['Account', t.nodeTitle || '—'], ['Asset', t.asset || '—'],
            ['Position', t.position || '—'], ['Outcome', t.type], ['Net P/L', `$${t.pl}`],
            ['Entry', t.entry || '—'], ['Exit', t.exit || '—'], ['Grade', t.grade],
            ['Liquidity', t.liq || '—'], ['Scales', (t.scale || []).join(', ')],
            ['Violations', (t.vios || []).join(', ') || 'None'],
            ['Plan vs Emotion', (t.psy || [])[0] || '—'], ['Setup', (t.psy || [])[1] || '—'],
            ['Patience', (t.psy || [])[2] || '—'], ['Focus', (t.psy || [])[3] || '—'],
            ['Emotional Bias', (t.psy || [])[4] || '—'], ['Key Lesson', (t.psy || [])[5] || '—']
        ],
        theme: 'grid'
    });
    if (t.image) {
        doc.addPage(); doc.text('TRADE SCREENSHOT', 14, 14);
        doc.addImage(t.image, t.image.includes('png') ? 'PNG' : 'JPEG', 15, 20, 180, 130);
    }
    doc.save(`Trade_${t.date}_${t.nodeTitle || 'node'}.pdf`);
};

window.downloadHistoryPDF = function () {
    if (!tradeHistory.length) return alert('No history to export!');
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    doc.setFontSize(14); doc.text('ISI MASTER TRADE HISTORY', 14, 16);
    doc.autoTable({
        startY: 24,
        head: [['Date', 'Account', 'Asset', 'Outcome', 'P/L', 'Grade']],
        body: tradeHistory.map(t => [t.date, t.nodeTitle || '—', t.asset || '—', t.type, `$${t.pl}`, t.grade]),
        theme: 'grid'
    });
    doc.save(`ISI_TradeHistory_${new Date().toLocaleDateString()}.pdf`);
};

// ──────────────────────────────────────────────
// OATH POPUP
// ──────────────────────────────────────────────
const oaths = [
    "Discipline First: Main profit ke liye trade nahi karta. Profit rules ka by-product hai. 🧠",
    "Permission Rule: Agar system allow nahi karta, to main trade nahi karta. 🚦",
    "Risk Authority: Risk mera boss hai. ⚖️",
    "Self-Control: Market mujhe control nahi karega. Main apne actions control karunga. 🪞",
    "No Revenge: Loss ke baad discipline maintain karna hai. ❌🔥",
    "Timing Law: Galat time pe sahi trade bhi galat hota hai. ⏱️",
    "Process Loyalty: Main outcome ka slave nahi hoon. Main process ka follower hoon. 📊",
    "Identity: Main trader nahi hoon. Main system operator hoon. 🏆",
    "Patience Protocol: Valid setup ka wait karna mera kaam hai. ⏳",
    "Calm Mind: Fast mind galti karta hai. Calm mind execute karta hai. 🌊",
    "Final Command: Aaj ka goal perfect execution hai. Profit khud follow karega. 🎖️"
];

window.closeOath = function () {
    document.getElementById('oathPopup').style.display = 'none';
    // Remember today's date — oath won't show again today
    localStorage.setItem('isi_oath_date', new Date().toISOString().split('T')[0]);
};

// ──────────────────────────────────────────────
// DOM READY
// ──────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
    // Oath — show only once per day
    const today     = new Date().toISOString().split('T')[0];
    const oathDone  = localStorage.getItem('isi_oath_date');
    const popup     = document.getElementById('oathPopup');
    const d         = document.getElementById('oathDisplay');

    if (oathDone === today) {
        // Already sworn today — hide immediately
        if (popup) popup.style.display = 'none';
    } else {
        // Show oath
        if (d) d.innerText = oaths[Math.floor(Math.random() * oaths.length)];
        if (popup) popup.style.display = 'flex';
    }

    // Checklist
    initFlowUI();

    // Today's date default
    const td = document.getElementById('tradeDate');
    if (td) td.value = today;
});

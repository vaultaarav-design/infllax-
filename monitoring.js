import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, onValue, update, remove, get } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { aiWeeklyCoach, showAILoading, renderAIResponse } from "./gemini.js";

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

// ── CONSTANTS ──
const monthNames = ["January","February","March","April","May","June",
                    "July","August","September","October","November","December"];

// ── STATE ──
let clusters           = {};
let selectedClusterId  = null;
let allTrades          = [];
let nodeMap            = {};
let liveStats          = {};  // { [clusterId]: { [nodeIdx]: statsObj } }
let preentryData       = {};  // { [clusterId]: { [nodeIdx]: { [fbKey]: record } } }

// Stats path — dedicated lightweight path
const statsPath = (cId, nIdx) => `isi_v6/stats/${cId}/${nIdx}`;

function getNodeStats(cId, nIdx) {
    const cached = liveStats[cId]?.[String(nIdx)];
    if (cached) return cached;
    const node = clusters[cId]?.nodes[nIdx];
    if (node?.stats) return node.stats;
    return { currentBal: node?.balance ?? 0, trades: 0, wins: 0, winRate: 0, net: 0 };
}

// ──────────────────────────────────────────────
// FIREBASE — LOAD ALL CLUSTERS
// ──────────────────────────────────────────────
onValue(ref(db, 'isi_v6/clusters'), (snap) => {
    clusters = snap.val() || {};
    document.getElementById('fbMonStatus').textContent = '● LIVE — Firebase Connected';
    document.getElementById('fbMonStatus').style.color = '#00c805';
    populateClusterFilter();
});

// ── DEDICATED STATS LISTENER (instant, no images) ──
onValue(ref(db, 'isi_v6/stats'), (snap) => {
    liveStats = snap.val() || {};
    if (selectedClusterId) renderAll();
});

// ── PRE-ENTRY DATA LISTENER ──
onValue(ref(db, 'isi_v6/preentry'), (snap) => {
    preentryData = snap.val() || {};
});

// ──────────────────────────────────────────────
// POPULATE CLUSTER FILTER
// ──────────────────────────────────────────────
function populateClusterFilter() {
    const sel   = document.getElementById('clusterFilter');
    const saved = localStorage.getItem('mon_sel_cluster');

    sel.innerHTML = '<option value="">— Select Cluster —</option>';
    Object.entries(clusters).forEach(([id, c]) => {
        const o = document.createElement('option');
        o.value = id; o.textContent = c.title;
        sel.appendChild(o);
    });

    if (saved && clusters[saved]) {
        sel.value = saved;
        selectedClusterId = saved;
        populateAccFilter(saved);
        loadClusterData(saved);
    }
}

// ──────────────────────────────────────────────
// POPULATE ACCOUNT FILTER
// ──────────────────────────────────────────────
function populateAccFilter(clusterId) {
    const sel = document.getElementById('accFilter');
    sel.innerHTML = '<option value="ALL">All Accounts (Combined)</option>';
    sel.disabled  = false;

    const cluster = clusters[clusterId];
    if (!cluster) return;

    cluster.nodes.forEach((node, idx) => {
        const o = document.createElement('option');
        o.value       = idx;
        o.textContent = `${node.title || 'Account ' + (idx + 1)}  (${node.curr}${(node.balance || 0).toLocaleString()})`;
        sel.appendChild(o);
    });
}

// ──────────────────────────────────────────────
// LOAD ALL TRADES FOR SELECTED CLUSTER
// ──────────────────────────────────────────────
function loadClusterData(clusterId) {
    const cluster = clusters[clusterId];
    if (!cluster) return;

    allTrades = [];
    nodeMap   = {};
    let pending = cluster.nodes.length;
    if (pending === 0) { renderAll(); return; }

    cluster.nodes.forEach((node, nIdx) => {
        nodeMap[nIdx] = node;
        onValue(ref(db, `isi_v6/clusters/${clusterId}/nodes/${nIdx}/tradeHistory`), (snap) => {
            // Remove old trades from this node
            allTrades = allTrades.filter(t => t._nodeIdx !== nIdx);
            const val = snap.val();
            if (val) {
                Object.entries(val).forEach(([fbKey, trade]) => {
                    allTrades.push({
                        ...trade,
                        _nodeIdx: nIdx,
                        _fbKey:   fbKey,
                        _nodeTitle: node.title || 'Account ' + (nIdx + 1),
                        _curr: node.curr || '$'
                    });
                });
            }
            // Sort by date desc
            allTrades.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
            renderAll();
        });
    });
}

// ──────────────────────────────────────────────
// FILTER CHANGE HANDLER
// ──────────────────────────────────────────────
window.onFilterChange = function () {
    const newCluster = document.getElementById('clusterFilter').value;

    if (newCluster !== selectedClusterId) {
        selectedClusterId = newCluster || null;
        allTrades = [];
        document.getElementById('accFilter').innerHTML = '<option value="ALL">All Accounts (Combined)</option>';
        document.getElementById('accFilter').disabled  = true;

        if (selectedClusterId) {
            localStorage.setItem('mon_sel_cluster', selectedClusterId);
            populateAccFilter(selectedClusterId);
            loadClusterData(selectedClusterId);
        } else {
            localStorage.removeItem('mon_sel_cluster');
            renderAll();
        }
    } else {
        renderAll();
    }
};

// ──────────────────────────────────────────────
// GET FILTERED TRADES
// ──────────────────────────────────────────────
function getFilteredTrades() {
    const accVal  = document.getElementById('accFilter').value;
    const range   = document.getElementById('timeRange').value;
    const now     = new Date();

    let filtered = [...allTrades];

    // Account filter
    if (accVal !== 'ALL') {
        const idx = parseInt(accVal);
        filtered = filtered.filter(t => t._nodeIdx === idx);
    }

    // Time filter
    if (range !== 'all') {
        filtered = filtered.filter(t => {
            if (!t.date) return false;
            const d = new Date(t.date);
            if (range === '1week')   return (now - d) / 86400000 <= 7;
            if (range === 'current') return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
            if (range === '3months') return (now - d) / 86400000 <= 92;
            if (range === '1year')   return (now - d) / 86400000 <= 365;
            if (range === '3year')   return (now - d) / 86400000 <= 1095;
            return true;
        });
    }

    return filtered;
}

// ──────────────────────────────────────────────
// RENDER ALL
// ──────────────────────────────────────────────
function renderAll() {
    if (!selectedClusterId) {
        clearUI(); return;
    }
    const filtered = getFilteredTrades();
    renderPerformanceCard(filtered);
    renderRecentSessions();
    renderCalendar(filtered);
}

function clearUI() {
    document.getElementById('bigWr').innerText     = '0%';
    document.getElementById('currBal').innerText   = '—';
    document.getElementById('periodPl').innerText  = '$0.00';
    document.getElementById('periodPerc').innerText = '0.00%';
    document.getElementById('periodTrades').innerText = '0';
    document.getElementById('accBreakdown').innerText = 'Select a cluster to view data.';
    document.getElementById('pnl').innerText   = '$0.00';
    document.getElementById('trades').innerText = '0';
    document.getElementById('wr').innerText     = '0%';
    document.getElementById('gDays').innerText  = '0';
    document.getElementById('recentSessions').innerHTML = '<div style="color:#555; font-size:0.8rem; padding:20px;">Select a cluster to view sessions...</div>';
    document.getElementById('calendarArea').innerHTML = '';
}

// ──────────────────────────────────────────────
// PERFORMANCE OVERVIEW CARD
// ──────────────────────────────────────────────
function renderPerformanceCard(filtered) {
    const accVal  = document.getElementById('accFilter').value;
    const cluster = clusters[selectedClusterId];
    if (!cluster) return;

    const totalPl  = filtered.reduce((s, t) => s + (t.pl || 0), 0);
    const winCount = filtered.filter(t => t.type === 'Target').length;
    const wr       = filtered.length ? (winCount / filtered.length) * 100 : 0;

    document.getElementById('bigWr').innerText        = wr.toFixed(1) + '%';
    document.getElementById('periodTrades').innerText = filtered.length;

    // Period P/L — per node currency
    const plByCurr = {};
    filtered.forEach(t => {
        const nodeIdx = t._nodeIdx ?? 0;
        const c = cluster.nodes[nodeIdx]?.curr || '$';
        plByCurr[c] = (plByCurr[c] || 0) + (t.pl || 0);
    });
    const plStr = Object.entries(plByCurr).map(([c,v])=>`${v>=0?'+':''}${c}${v.toFixed(2)}`).join(' ') || '+$0.00';
    const plEl = document.getElementById('periodPl');
    plEl.innerHTML   = plStr;
    plEl.style.color = totalPl >= 0 ? 'var(--accent)' : 'var(--danger)';

    // Return % — use setup balance as base, single currency only
    const startBal = accVal === 'ALL'
        ? cluster.nodes.reduce((s,n) => s+(n.balance??0), 0)
        : (cluster.nodes[parseInt(accVal)]?.balance ?? 0);
    const periodPerc  = startBal > 0 ? (totalPl / startBal) * 100 : 0;
    const percEl = document.getElementById('periodPerc');
    percEl.innerText   = (periodPerc >= 0 ? '+' : '') + periodPerc.toFixed(2) + '%';
    percEl.style.color = periodPerc >= 0 ? 'var(--accent)' : 'var(--danger)';

    const ring = document.getElementById('winRing');
    ring.className = 'win-circle ' + (wr >= 65 ? 'high' : wr >= 35 ? 'mid' : 'low');

    // Account breakdown
    const nodeEntries = accVal === 'ALL'
        ? cluster.nodes.map((n, i) => ({ n, title: n.title || 'Acc '+(i+1), idx: i }))
        : [{ n: cluster.nodes[parseInt(accVal)], title: cluster.nodes[parseInt(accVal)]?.title || 'Acc '+(parseInt(accVal)+1), idx: parseInt(accVal) }];

    const breakdown = nodeEntries.map(({ n, title, idx }) => {
        const nodeTrades = filtered.filter(t => t._nodeIdx === idx);
        const nodePl     = nodeTrades.reduce((s, t) => s + (t.pl||0), 0);
        const nodeWr     = nodeTrades.length ? ((nodeTrades.filter(t=>t.type==='Target').length/nodeTrades.length)*100).toFixed(0) : 0;
        const c          = n?.curr || '$';
        return `<b style="color:#ccc">${title}</b>: ${nodeTrades.length} trades | <span style="color:${nodePl>=0?'var(--accent)':'var(--danger)'}">${nodePl>=0?'+':''}${c}${nodePl.toFixed(0)}</span> | WR: ${nodeWr}%`;
    }).join('&nbsp;&nbsp;|&nbsp;&nbsp;');
    document.getElementById('accBreakdown').innerHTML = breakdown || '—';

    // Current Balance — from live stats cache (instant, no async needed)
    const currBalEl = document.getElementById('currBal');
    const nodesToUse = accVal === 'ALL'
        ? cluster.nodes.map((n,i) => ({n,i}))
        : [{ n: cluster.nodes[parseInt(accVal)], i: parseInt(accVal) }];

    const byCurr = {};
    nodesToUse.forEach(({n, i}) => {
        const s   = getNodeStats(selectedClusterId, i);
        const c   = n.curr || '$';
        const bal = s.currentBal ?? n.balance ?? 0;
        byCurr[c] = (byCurr[c]||0) + bal;
    });
    currBalEl.innerText = Object.entries(byCurr)
        .map(([c,v]) => `${c}${v.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`)
        .join(' + ') || '$0.00';
}

// ──────────────────────────────────────────────
// RECENT 6 SESSIONS
// ──────────────────────────────────────────────
function renderRecentSessions() {
    const container = document.getElementById('recentSessions');
    const accVal    = document.getElementById('accFilter').value;

    let source = [...allTrades];
    if (accVal !== 'ALL') source = source.filter(t => t._nodeIdx === parseInt(accVal));
    const recent = source.slice(0, 6); // already sorted desc

    if (!recent.length) {
        container.innerHTML = '<div style="color:#555; font-size:0.8rem; padding:20px;">No sessions found for selected filters.</div>';
        return;
    }

    container.innerHTML = recent.map(t => `
        <div class="recent-card">
            <div style="display:flex; justify-content:space-between; font-weight:bold; font-size:0.85rem;">
                <span>${t.date} | <span style="color:var(--gold)">${t._nodeTitle}</span></span>
                <span style="color:${(t.pl || 0) >= 0 ? 'var(--accent)' : 'var(--danger)'}">
                    ${(t.pl || 0) >= 0 ? '+' : ''}$${(t.pl || 0).toFixed(2)}
                </span>
            </div>
            <div style="font-size:0.72rem; margin-top:5px; color:var(--gold);">
                Asset: ${t.asset || '—'} | Outcome: ${t.type || '—'} | Grade: ${t.grade || '—'}
            </div>
            <div style="margin-top:7px;">
                ${t.vios && t.vios.length > 0
                    ? t.vios.map(v => `<span class="tag red">${v}</span>`).join('')
                    : '<span class="tag green">No Violations</span>'}
            </div>
            <div class="recent-lesson"><b>Lesson:</b> ${(t.psy || [])[5] || 'No lesson recorded.'}</div>
        </div>
    `).join('');
}

// ──────────────────────────────────────────────
// CALENDAR RENDER
// ──────────────────────────────────────────────
function renderCalendar(filtered) {
    const range = document.getElementById('timeRange').value;
    const now   = new Date();
    const calArea = document.getElementById('calendarArea');
    calArea.innerHTML = '';

    // Build month list
    const months = [];
    let count = 1;
    if (range === '1week')   count = 1;
    else if (range === '3months') count = 3;
    else if (range === '1year')   count = 12;
    else if (range === '3year')   count = 36;
    else if (range === 'all')     count = 60;

    for (let i = count - 1; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        months.push({ m: d.getMonth(), y: d.getFullYear() });
    }

    // Build daily trade map for fast lookup
    const dayMap = {}; // "YYYY-MM-DD" → { pl, trades[] }
    filtered.forEach(t => {
        if (!t.date) return;
        if (!dayMap[t.date]) dayMap[t.date] = { pl: 0, trades: [] };
        dayMap[t.date].pl     += t.pl || 0;
        dayMap[t.date].trades.push(t);
    });

    // Stats
    let tPL = 0, tTrades = 0, tWins = 0, tGreen = 0;

    months.forEach(({ m, y }) => {
        const monthDiv = document.createElement('div');
        monthDiv.className = 'month-box';

        const monthHeader = document.createElement('div');
        monthHeader.className = 'month-name';
        monthHeader.textContent = `${monthNames[m]} ${y}`;
        monthDiv.appendChild(monthHeader);

        const grid = document.createElement('div');
        grid.className = 'cal-grid';

        // Day headers
        ['SUN','MON','TUE','WED','THU','FRI','SAT'].forEach(d => {
            const h = document.createElement('div');
            h.className = 'cal-day-header';
            h.textContent = d;
            grid.appendChild(h);
        });

        // Blank cells before 1st
        const firstDay = new Date(y, m, 1).getDay();
        for (let i = 0; i < firstDay; i++) {
            grid.appendChild(document.createElement('div'));
        }

        const daysInMonth = new Date(y, m + 1, 0).getDate();

        for (let d = 1; d <= daysInMonth; d++) {
            const dateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            const info    = dayMap[dateStr];
            const dayPL   = info?.pl ?? 0;
            const dayTr   = info?.trades ?? [];

            if (info) {
                tPL    += dayPL;
                tTrades += dayTr.length;
                tWins  += dayTr.filter(t => t.type === 'Target').length;
                if (dayPL > 0) tGreen++;
            }

            const dayEl = document.createElement('div');
            dayEl.className = 'day' + (dayTr.length > 0 ? (dayPL >= 0 ? ' green-day' : ' red-day') : '');

            dayEl.innerHTML = `
                <span class="d-num">${d}</span>
                ${dayTr.length > 0 ? `
                    <span style="font-weight:bold; font-size:0.72rem; color:${dayPL >= 0 ? '#00ff41' : '#ff3131'}; text-align:center;">
                        ${dayPL >= 0 ? '+' : ''}$${Math.abs(dayPL).toFixed(0)}
                    </span>
                    <span class="d-trades">${dayTr.length} trade${dayTr.length > 1 ? 's' : ''}</span>
                ` : ''}
            `;

            if (dayTr.length > 0) {
                dayEl.onclick = () => openDayTrades(dateStr, dayTr);
                dayEl.style.cursor = 'pointer';
            }

            grid.appendChild(dayEl);
        }

        monthDiv.appendChild(grid);
        calArea.appendChild(monthDiv);
    });

    // Update stats bar
    const plEl = document.getElementById('pnl');
    plEl.innerText   = (tPL >= 0 ? '+' : '') + `$${tPL.toFixed(2)}`;
    plEl.style.color = tPL >= 0 ? 'var(--accent)' : 'var(--danger)';

    document.getElementById('trades').innerText = tTrades;
    document.getElementById('wr').innerText     = tTrades ? ((tWins / tTrades) * 100).toFixed(1) + '%' : '0%';
    document.getElementById('gDays').innerText  = tGreen;
}

// ──────────────────────────────────────────────
// OPEN DAY TRADES (List of trades for a date)
// ──────────────────────────────────────────────
window.openDayTrades = function (date, trades) {
    if (!trades.length) return;

    const totalPl = trades.reduce((s, t) => s + (t.pl || 0), 0);
    document.getElementById('modalTitle').innerHTML =
        `${date} &nbsp;|&nbsp; ${trades.length} Trade${trades.length > 1 ? 's' : ''} &nbsp;|&nbsp;
         <span style="color:${totalPl >= 0 ? 'var(--accent)' : 'var(--danger)'}">
            ${totalPl >= 0 ? '+' : ''}$${totalPl.toFixed(2)}
         </span>`;

    document.getElementById('modalBody').innerHTML = trades.map(t => `
        <div style="background:#111; padding:14px; margin-top:10px; border-radius:8px;
                    border-left:4px solid var(--gold); cursor:pointer;"
             onclick="viewDeepDive('${t._nodeIdx}','${t._fbKey}')">
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <div>
                    <b style="font-size:0.9rem;">${t.asset || '—'} | ${t._nodeTitle}</b>
                    <br><small style="color:#666;">Grade: ${t.grade || '—'} | ${t.type || '—'} | Lot: ${t.pl || 0 >= 0 ? '' : ''}${t.riskQty || '—'}</small>
                </div>
                <div style="color:${(t.pl || 0) >= 0 ? '#00ff41' : '#ff3131'}; font-weight:bold; font-size:1rem;">
                    ${(t.pl || 0) >= 0 ? '+' : ''}$${(t.pl || 0).toFixed(2)}
                </div>
            </div>
        </div>
    `).join('');

    document.getElementById('tradeModal').style.display = 'block';
};

// ──────────────────────────────────────────────
// VIEW DEEP DIVE (Single trade detail)
// ──────────────────────────────────────────────
window.viewDeepDive = function (nodeIdxStr, fbKey) {
    const nodeIdx = parseInt(nodeIdxStr);
    const t = allTrades.find(x => x._nodeIdx === nodeIdx && x._fbKey === fbKey);
    if (!t) return;

    // Always ensure modal is open (works from both calendar day-list AND list view)
    document.getElementById('tradeModal').style.display = 'block';

    const viosHtml   = (t.vios || []).length > 0
        ? t.vios.map(v => `<span class="tag red">${v}</span>`).join('')
        : '<span class="tag green">Clean Session</span>';
    const scalesHtml = (t.scale || []).map(s => `<span class="tag green">${s}</span>`).join('') || '—';
    const smcHtml    = (t.smcFlags || []).length > 0
        ? t.smcFlags.map(f => `<span class="tag" style="color:#c5a059;border-color:#c5a059;">${f}</span>`).join('')
        : '<span style="color:#444;font-size:0.7rem;">None recorded</span>';

    // Pre-entry record for same date + node
    const peRecords = preentryData?.[t.clusterId]?.[t.nodeIdx];
    const todayPE   = peRecords
        ? Object.values(peRecords).filter(r => r.date === t.date).sort((a,b) => (b.savedAt||'').localeCompare(a.savedAt||''))
        : [];
    const bestPE = todayPE[0];

    document.getElementById('modalTitle').innerText = `Deep-Dive: ${t.date} | ${t._nodeTitle}`;
    document.getElementById('modalBody').innerHTML = `
        <button onclick="openDayTrades('${t.date}', allTradesForDate('${t.date}'))"
            style="background:#222;color:#aaa;border:1px solid #444;padding:7px 14px;margin:12px 0;cursor:pointer;border-radius:4px;width:auto;font-size:0.75rem;">
            ← Back to Day
        </button>

        <div class="detail-grid">
            <div class="info-pane">
                <h3 style="color:var(--gold);margin-top:0;font-size:0.85rem;">1. EXECUTION CONTEXT</h3>
                <p><b>Asset:</b> ${t.asset||'—'} | <b>Position:</b> ${t.position||'—'}</p>
                <p><b>Entry:</b> ${t.entry||'—'} | <b>Exit:</b> ${t.exit||'—'}</p>
                <p><b>Outcome:</b> <span style="color:${t.type==='Target'?'#00ff41':'#ff5252'}">${t.type||'—'}</span> (${t.grade||'—'})</p>
                <p><b>Liquidity:</b> ${t.liq||'—'}</p>
                <p><b>Net P/L:</b> <span style="color:${(t.pl||0)>=0?'#00ff41':'#ff5252'};font-size:1.1rem;font-weight:bold;">
                    ${(t.pl||0)>=0?'+':''}${t._curr||'$'}${Math.abs(t.pl||0).toFixed(2)}</span></p>
            </div>
            <div class="info-pane">
                <h3 style="color:var(--gold);margin-top:0;font-size:0.85rem;">2. INSTITUTIONAL BIAS</h3>
                ${t.biasResult ? `<p style="color:#c5a059;font-size:0.78rem;font-weight:bold;">${t.biasResult}</p>` : '<p style="color:#444;">No bias recorded</p>'}
                ${t.htfMs ? `<p style="font-size:0.73rem;"><b>HTF:</b> <span style="color:#4a9eff">${t.htfMs}</span>${t.htfZone?' · '+t.htfZone:''}</p>` : ''}
                ${t.ltfMs ? `<p style="font-size:0.73rem;"><b>LTF:</b> <span style="color:#4a9eff">${t.ltfMs}</span>${t.ltfCandle?' · '+t.ltfCandle:''}</p>` : ''}
                ${t.conflict ? `<p style="color:#ff6600;font-size:0.7rem;"><b>⚠ CONFLICT:</b> ${t.conflict.slice(0,120)}</p>` : ''}
                <p style="margin-top:6px;"><b>SMC Active:</b><br>${smcHtml}</p>
            </div>
        </div>

        <div class="detail-grid" style="margin-top:14px;">
            <div class="info-pane">
                <h3 style="color:var(--gold);margin-top:0;font-size:0.85rem;">3. SYSTEM HEALTH</h3>
                <p><b>Violations:</b><br>${viosHtml}</p>
                <p><b>Scales Booked:</b><br>${scalesHtml}</p>
            </div>
            ${bestPE ? `
            <div class="info-pane" style="border-color:#1a2a00;">
                <h3 style="color:var(--accent);margin-top:0;font-size:0.85rem;">4. PRE-ENTRY ANALYSIS</h3>
                <p><b>Score:</b> <span style="color:${bestPE.score>=75?'var(--accent)':bestPE.score>=50?'var(--gold)':'var(--danger)'};font-size:1rem;font-weight:900;font-family:monospace;">${bestPE.score}/100</span></p>
                <p style="font-size:0.7rem;"><b>Timer:</b> ${Math.floor((bestPE.timerSecs||0)/60)}m ${(bestPE.timerSecs||0)%60}s analysis</p>
                ${bestPE.direction ? `<p style="font-size:0.7rem;"><b>Planned:</b> ${bestPE.direction} · RR ${bestPE.rrPlanned||'—'}</p>` : ''}
                ${bestPE.note ? `<p style="font-size:0.68rem;color:#888;font-style:italic;">"${bestPE.note.slice(0,120)}"</p>` : ''}
                ${bestPE.conflict ? `<p style="color:#ff6600;font-size:0.65rem;">⚠ Conflict noted pre-trade</p>` : ''}
            </div>` : `
            <div class="info-pane" style="border-color:#1a1a00;">
                <h3 style="color:#444;margin-top:0;font-size:0.85rem;">4. PRE-ENTRY ANALYSIS</h3>
                <p style="color:#444;font-size:0.75rem;">No pre-entry record for this date.<br>Use PRE-ENTRY page before trading.</p>
            </div>`}
        </div>

        <div class="info-pane" style="margin-top:14px;">
            <h3 style="color:var(--gold);margin-top:0;font-size:0.85rem;">5. PSYCHOLOGY & LESSONS</h3>
            <div style="font-size:0.83rem;line-height:1.7;">
                <p><b>Plan vs Emotion:</b> ${(t.psy||[])[0]||'—'}</p>
                <p><b>Setup Quality:</b>   ${(t.psy||[])[1]||'—'}</p>
                <p><b>Patience:</b>         ${(t.psy||[])[2]||'—'}</p>
                <p><b>Focus / Neutrality:</b> ${(t.psy||[])[3]||'—'}</p>
                <p><b>Emotional Bias:</b>   ${(t.psy||[])[4]||'—'}</p>
                <p style="background:#000;padding:10px;border-left:3px solid var(--accent);border-radius:4px;">
                    <b>Master Lesson:</b> ${(t.psy||[])[5]||'—'}
                </p>
            </div>
        </div>

        ${t.image ? `
        <div style="margin-top:16px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
                <b style="color:var(--gold);font-size:0.82rem;">6. TRADE SCREENSHOT</b>
                <button class="del-ss-btn" onclick="deleteScreenshot('${nodeIdxStr}','${fbKey}')">🗑 Delete Screenshot</button>
            </div>
            <img src="${t.image}" class="screenshot-img">
        </div>` : `
        <div style="padding:20px;text-align:center;color:#444;background:#0a0a0a;border-radius:8px;margin-top:16px;border:1px dashed #333;">No Screenshot Found</div>`}

        <button onclick="downloadTradePDF('${nodeIdxStr}','${fbKey}')"
            style="width:100%;background:var(--gold);color:#000;padding:13px;font-weight:bold;margin-top:18px;border:none;border-radius:6px;cursor:pointer;font-size:0.9rem;">
            ⬇ DOWNLOAD PDF REPORT
        </button>
    `;
};

// ──────────────────────────────────────────────
// HELPER — Get all trades for a specific date (filtered by current acc filter)
// ──────────────────────────────────────────────
window.allTradesForDate = function (date) {
    const accVal = document.getElementById('accFilter').value;
    let src = allTrades.filter(t => t.date === date);
    if (accVal !== 'ALL') src = src.filter(t => t._nodeIdx === parseInt(accVal));
    return src;
};

// ──────────────────────────────────────────────
// DELETE SCREENSHOT — from Firebase + update UI
// ──────────────────────────────────────────────
window.deleteScreenshot = async function (nodeIdxStr, fbKey) {
    if (!confirm('Delete this screenshot permanently from Firebase?\n\nIt will also disappear in Trade History on index.html.')) return;

    const nodeIdx = parseInt(nodeIdxStr);
    const path    = `isi_v6/clusters/${selectedClusterId}/nodes/${nodeIdx}/tradeHistory/${fbKey}/image`;

    try {
        await update(ref(db, `isi_v6/clusters/${selectedClusterId}/nodes/${nodeIdx}/tradeHistory/${fbKey}`), {
            image: null
        });

        // Update local state
        const t = allTrades.find(x => x._nodeIdx === nodeIdx && x._fbKey === fbKey);
        if (t) t.image = null;

        alert('✅ Screenshot deleted from Firebase successfully!');
        // Re-render deep dive without screenshot
        viewDeepDive(nodeIdxStr, fbKey);
    } catch (err) {
        alert('Error: ' + err.message);
    }
};

// ──────────────────────────────────────────────
// DOWNLOAD TRADE PDF
// ──────────────────────────────────────────────
window.downloadTradePDF = function (nodeIdxStr, fbKey) {
    const t = allTrades.find(x => x._nodeIdx === parseInt(nodeIdxStr) && x._fbKey === fbKey);
    if (!t) return;

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    doc.setFillColor(10, 10, 10); doc.rect(0, 0, 210, 297, 'F');
    doc.setTextColor(197, 160, 89); doc.setFontSize(18);
    doc.text('ISI INSTITUTIONAL TRADE REPORT', 14, 20);

    const rows = [
        ['Date', t.date || '—'], ['Account', t._nodeTitle || '—'],
        ['Asset', t.asset || '—'], ['Position', t.position || '—'],
        ['Outcome', t.type || '—'], ['Net P/L', `$${(t.pl || 0).toFixed(2)}`],
        ['Entry', t.entry || '—'], ['Exit', t.exit || '—'],
        ['Grade', t.grade || '—'], ['Liquidity', t.liq || '—'],
        ['Scales', (t.scale || []).join(', ') || 'None'],
        ['Violations', (t.vios || []).join(', ') || 'None'],
        ['Plan vs Emotion', (t.psy || [])[0] || '—'],
        ['Setup Quality', (t.psy || [])[1] || '—'],
        ['Master Lesson', (t.psy || [])[5] || '—']
    ];

    doc.setTextColor(255, 255, 255);
    doc.autoTable({ startY: 30, body: rows, theme: 'grid', styles: { fontSize: 9 } });

    if (t.image) {
        doc.addPage();
        doc.setTextColor(197, 160, 89); doc.setFontSize(14);
        doc.text('EXECUTION PROOF', 14, 15);
        doc.addImage(t.image, t.image.includes('png') ? 'PNG' : 'JPEG', 10, 22, 190, 130);
    }

    doc.save(`Journal_${t.date || 'trade'}_${t._nodeTitle || 'node'}.pdf`);
};

// ──────────────────────────────────────────────
// CLOSE MODAL
// ──────────────────────────────────────────────
window.closeModal = function () {
    document.getElementById('tradeModal').style.display = 'none';
};
window.onclick = function (e) {
    if (e.target.classList.contains('mon-modal')) closeModal();
};

// ──────────────────────────────────────────────
// AI WEEKLY COACH — monitoring page
// ──────────────────────────────────────────────
window.runAIWeeklyCoach = async function () {
    showAILoading('aiCoachBox');

    // Build stats from allTrades
    const wins   = allTrades.filter(t => t.type === 'Target').length;
    const losses = allTrades.filter(t => t.type === 'Stop Loss').length;
    const totalPL = allTrades.reduce((s, t) => s + (t.pl || 0), 0);
    const winRate = allTrades.length ? ((wins / allTrades.length) * 100).toFixed(1) : 0;

    // Violations count
    const vioCount = {};
    allTrades.forEach(t => (t.vios || []).forEach(v => { vioCount[v] = (vioCount[v]||0)+1; }));
    const violations = Object.entries(vioCount).sort((a,b)=>b[1]-a[1]).map(([v])=>v);

    // Grade distribution
    const gradeCount = {};
    allTrades.forEach(t => { if(t.grade) gradeCount[t.grade] = (gradeCount[t.grade]||0)+1; });

    // Best asset
    const assetPL = {};
    allTrades.forEach(t => { assetPL[t.asset||'?'] = (assetPL[t.asset||'?']||0) + (t.pl||0); });
    const assets = Object.entries(assetPL).sort((a,b)=>b[1]-a[1]).map(([a])=>a);

    // Best day
    const dayPL = {};
    allTrades.forEach(t => {
        if (!t.date) return;
        const day = new Date(t.date).toLocaleDateString('en-GB',{weekday:'long'});
        dayPL[day] = (dayPL[day]||0) + (t.pl||0);
    });
    const days = Object.entries(dayPL).sort((a,b)=>b[1]-a[1]).map(([d])=>d);

    const result = await aiWeeklyCoach({
        trades: allTrades.length, wins, losses,
        totalPL, winRate, violations,
        grades: gradeCount, assets, days
    });
    renderAIResponse('aiCoachBox', result, '🤖 AI Weekly Performance Coach');
};

// ══════════════════════════════════════════════════════════
// CALENDAR / LIST VIEW TOGGLE
// ══════════════════════════════════════════════════════════
window.onCalViewMode = function() {
    const mode = document.getElementById('calViewMode').value;
    document.getElementById('calendarArea').style.display = mode === 'calendar' ? '' : 'none';
    document.getElementById('listViewArea').style.display = mode === 'list' ? '' : 'none';
    if (mode === 'list') renderListView();
};

function renderListView() {
    const container = document.getElementById('listViewArea');
    if (!container) return;
    const filtered = getFilteredTrades();

    // Group by date descending
    const byDate = {};
    filtered.forEach(t => {
        const d = t.date || 'Unknown';
        if (!byDate[d]) byDate[d] = [];
        byDate[d].push(t);
    });
    const dates = Object.keys(byDate).sort((a,b) => b.localeCompare(a));

    if (!dates.length) {
        container.innerHTML = '<div style="color:#333;text-align:center;padding:30px;font-size:0.78rem;">No trades in selected range.</div>';
        return;
    }

    container.innerHTML = dates.map(date => {
        const trades = byDate[date];
        const dayPL  = trades.reduce((s,t) => s + (t.pl||0), 0);
        const dayColor = dayPL > 0 ? '#00c805' : dayPL < 0 ? '#ff3131' : '#00aaff';
        const dayLabel = dayPL > 0 ? 'GREEN' : dayPL < 0 ? 'RED' : 'BE';

        const cards = trades.map(t => {
            const pl = t.pl || 0;
            let bg, border, oc;
            if (t.type === 'Target')    { bg='#001500'; border='#00c805'; oc='#00c805'; }
            else if(t.type==='Stop Loss'){ bg='#150000'; border='#ff3131'; oc='#ff3131'; }
            else                        { bg='#001020'; border='#00aaff'; oc='#00aaff'; }

            return `<div onclick="viewDeepDive('${t._nodeIdx}','${t._fbKey}')"
                style="background:${bg};border:1px solid ${border};border-radius:6px;padding:10px 14px;
                       cursor:pointer;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:6px;">
                <div>
                    <div style="font-size:0.74rem;font-weight:bold;color:#ccc;">${t.asset||'—'} &nbsp;|&nbsp; <span style="color:#888;">${t._nodeTitle}</span></div>
                    <div style="font-size:0.6rem;color:#555;margin-top:2px;">${t.position||'—'} · Grade: <b style="color:#aaa;">${t.grade||'—'}</b> · ${t.liq||'—'}</div>
                    ${(t.lockRiskAmt!=null||t.lockQty!=null)?`<div style="font-size:0.58rem;color:#00aaff;margin-top:2px;">🔒 Risk: ${t._curr||'$'}${Number(t.lockRiskAmt||0).toFixed(2)} · Qty: ${t.lockQty?Number(t.lockQty).toFixed(4):'—'}</div>`:''}
                </div>
                <div style="text-align:right;">
                    <div style="font-size:0.92rem;font-weight:bold;color:${oc};font-family:monospace;">${pl>=0?'+':''}${t._curr||'$'}${Math.abs(pl).toFixed(2)}</div>
                    <div style="font-size:0.6rem;color:${oc};">${t.type||'—'}</div>
                </div>
            </div>`;
        }).join('');

        return `<div style="margin-bottom:20px;">
            <div style="display:flex;justify-content:space-between;align-items:center;
                        background:#050505;border:1px solid #1a1a1a;border-radius:6px;
                        padding:9px 14px;margin-bottom:8px;">
                <span style="font-size:0.76rem;font-weight:bold;color:#ccc;">${date}</span>
                <div style="display:flex;align-items:center;gap:12px;">
                    <span style="font-size:0.62rem;font-weight:bold;color:${dayColor};background:${dayColor}22;padding:2px 8px;border-radius:10px;">${dayLabel}</span>
                    <span style="font-size:0.76rem;color:${dayColor};font-family:monospace;font-weight:bold;">${dayPL>=0?'+':''}${trades[0]?._curr||'$'}${Math.abs(dayPL).toFixed(2)}</span>
                    <span style="font-size:0.6rem;color:#444;">${trades.length} trade${trades.length>1?'s':''}</span>
                </div>
            </div>
            ${cards}
        </div>`;
    }).join('');
}

// Also re-render list when filters change
const _origRenderAll = window.onFilterChange;
window.onFilterChange = function() {
    if (_origRenderAll) _origRenderAll();
    const mode = document.getElementById('calViewMode')?.value;
    if (mode === 'list') renderListView();
};

// ══════════════════════════════════════════════════════════
// AI FULL ANALYSIS — MONITORING PAGE
// ══════════════════════════════════════════════════════════
window.runMonAI = async function() {
    const { callAI, showAILoading, renderAIResponse } = await import('./gemini.js');
    const box = document.getElementById('monAIBox');
    if (!box) return;
    box.style.display = 'block';
    showAILoading('monAIBox');

    const filtered = getFilteredTrades();
    const wins    = filtered.filter(t => t.type === 'Target').length;
    const losses  = filtered.filter(t => t.type === 'Stop Loss').length;
    const totalPL = filtered.reduce((s,t) => s+(t.pl||0), 0);
    const wr      = filtered.length ? ((wins/filtered.length)*100).toFixed(1) : 0;

    const grades = {};
    filtered.forEach(t => { if(t.grade) grades[t.grade]=(grades[t.grade]||0)+1; });

    const vios = {};
    filtered.forEach(t => (t.vios||[]).forEach(v => { vios[v]=(vios[v]||0)+1; }));

    const assetPL = {};
    filtered.forEach(t => { assetPL[t.asset||'?']=(assetPL[t.asset||'?']||0)+(t.pl||0); });

    const recent6 = filtered.slice(0,6).map(t =>
        `${t.date} | ${t.asset} | ${t.type} | P/L:${t._curr}${(t.pl||0).toFixed(2)} | Grade:${t.grade||'—'} | Vios:${(t.vios||[]).join(',')||'None'}`
    ).join('\n');

    const prompt = `You are an elite institutional trading performance analyst for ISI Terminal.

TRADING PERFORMANCE DATA:
- Total Trades: ${filtered.length} | Wins: ${wins} | Losses: ${losses}
- Win Rate: ${wr}% | Net P/L: $${totalPL.toFixed(2)}
- Grade Distribution: ${JSON.stringify(grades)}
- Top Rule Violations: ${JSON.stringify(vios)}
- Asset P/L Breakdown: ${JSON.stringify(assetPL)}

LAST 6 SESSIONS:
${recent6}

Provide a thorough, actionable analysis in these sections:
1. OVERALL ASSESSMENT — performance summary
2. STRENGTHS — what is working well
3. CRITICAL WEAKNESSES — exact patterns causing losses
4. VIOLATION ANALYSIS — which violations are most costly
5. ASSET INSIGHTS — best and worst performing assets
6. ACTION PLAN — 3 specific things to improve next week

Be direct, data-driven, institutional-grade. No fluff.`;

    const result = await callAI(prompt, 'monAIBox');
    renderAIResponse('monAIBox', result, '🤖 AI Full Performance Analysis');
};

// ══════════════════════════════════════════════════════════
// MULTI CLUSTER EQUITY PANEL
// ══════════════════════════════════════════════════════════
let _mcSel     = {};   // { cId: { on:bool, nodes:{nIdx:bool} } }
let _mcChart   = null;
let _mcRngIdx  = 1;    // default Monthly
const MC_RANGES = [7, 30, 90, 180, 365];

function mcPulseColor(t) {
    if (!t) return '#c5a059';
    if (t.type === 'Stop Loss') return '#d32f2f';
    const sc = (t.scale||[]).filter(s=>s&&s.trim()).length;
    return sc >= 2 ? '#00ff41' : sc === 1 ? '#1565c0' : '#00ff41';
}
function mcGlowColor(c) {
    if (c==='#d32f2f') return 'rgba(211,47,47,0.85)';
    if (c==='#1565c0') return 'rgba(21,101,192,0.85)';
    if (c==='#00ff41') return 'rgba(0,255,65,0.85)';
    return 'rgba(197,160,89,0.6)';
}

window.openMultiCluster = function() {
    document.getElementById('mcPanel').style.display = 'block';
    // Init selections — all ON by default
    Object.entries(clusters).forEach(([cId, cluster]) => {
        if (!_mcSel[cId]) {
            _mcSel[cId] = { on: true, nodes: {} };
            (cluster.nodes||[]).forEach((_,i) => _mcSel[cId].nodes[i] = true);
        }
    });
    _buildMCList();
    _loadAndRenderMC();
};

window.closeMultiCluster = function() {
    document.getElementById('mcPanel').style.display = 'none';
};

window.mcSetRange = function(idx) {
    _mcRngIdx = idx;
    for (let i = 0; i < 5; i++) {
        const b = document.getElementById('mcRng'+i);
        if (!b) continue;
        if (i === idx) { b.style.borderColor='var(--gold)'; b.style.background='#1a1200'; b.style.color='var(--gold)'; }
        else           { b.style.borderColor='#333';        b.style.background='#111';    b.style.color='#666'; }
    }
    _loadAndRenderMC();
};

window.mcToggleCluster = function(cId, on) {
    if (!_mcSel[cId]) _mcSel[cId] = { on, nodes:{} };
    _mcSel[cId].on = on;
    const nd = document.getElementById('mcNodes_'+cId);
    if (nd) nd.style.display = on ? '' : 'none';
    _loadAndRenderMC();
};

window.mcToggleNode = function(cId, nIdx, on) {
    if (!_mcSel[cId]) _mcSel[cId] = { on:true, nodes:{} };
    _mcSel[cId].nodes[nIdx] = on;
    _loadAndRenderMC();
};

function _buildMCList() {
    const list = document.getElementById('mcClusterList');
    if (!list) return;
    list.innerHTML = '';

    Object.entries(clusters).forEach(([cId, cluster]) => {
        const sel = _mcSel[cId] || { on:true, nodes:{} };
        const nodes = cluster.nodes || [];

        const nodeRows = nodes.map((node, nIdx) => {
            const stats  = getNodeStats(cId, nIdx);
            const bal    = (stats.currentBal ?? node.balance ?? 0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
            const net    = stats.net ?? 0;
            const curr   = node.curr || '$';
            const netCol = net >= 0 ? '#00c805' : '#ff3131';
            const chk    = sel.nodes[nIdx] !== false ? 'checked' : '';
            return `<label style="display:flex;align-items:center;gap:8px;cursor:pointer;padding:5px 0 5px 24px;border-top:1px solid #0d0d0d;">
                <input type="checkbox" ${chk} onchange="mcToggleNode('${cId}',${nIdx},this.checked)" style="accent-color:var(--accent);width:13px;height:13px;flex-shrink:0;">
                <span style="font-size:0.68rem;color:#aaa;flex:1;">${node.title||'Account '+(nIdx+1)}</span>
                <span style="font-size:0.65rem;color:var(--gold);font-family:monospace;">${curr}${bal}</span>
                <span style="font-size:0.62rem;color:${netCol};font-family:monospace;">${net>=0?'+':''}${curr}${Math.abs(net).toFixed(2)}</span>
            </label>`;
        }).join('');

        const cChk = sel.on ? 'checked' : '';
        const wrap = document.createElement('div');
        wrap.style.cssText = 'background:#040404;border:1px solid #1a1a1a;border-radius:6px;overflow:hidden;';
        wrap.innerHTML = `
            <label style="display:flex;align-items:center;gap:10px;cursor:pointer;padding:9px 14px;background:#060606;">
                <input type="checkbox" ${cChk} onchange="mcToggleCluster('${cId}',this.checked)" style="accent-color:#00aaff;width:15px;height:15px;flex-shrink:0;">
                <span style="font-size:0.75rem;font-weight:bold;color:#00aaff;">${cluster.title}</span>
                <span style="font-size:0.58rem;color:#444;">${nodes.length} account${nodes.length!==1?'s':''}</span>
            </label>
            <div id="mcNodes_${cId}" style="${sel.on?'':'display:none'};padding:0 14px 6px;">${nodeRows}</div>`;
        list.appendChild(wrap);
    });
}

async function _loadAndRenderMC() {
    const canvas  = document.getElementById('mcEquityCanvas');
    const emptyEl = document.getElementById('mcChartEmpty');
    const statsEl = document.getElementById('mcStats');
    const wrEl    = document.getElementById('mcWR');
    if (!canvas) return;

    // Show loading
    if (emptyEl) { emptyEl.style.display='flex'; emptyEl.textContent='⏳ Loading...'; emptyEl.style.position='absolute'; }

    const rate = await getUsdInrRate();

    // Load trades for each selected cluster
    const allPicked = [];

    const promises = Object.entries(clusters).map(([cId, cluster]) => {
        const sel = _mcSel[cId];
        if (!sel || !sel.on) return Promise.resolve();
        const nodes = cluster.nodes || [];

        const nodePromises = nodes.map((node, nIdx) => {
            if (sel.nodes[nIdx] === false) return Promise.resolve();

            // If this is the currently-loaded cluster, use allTrades (already in memory)
            if (cId === selectedClusterId) {
                allTrades
                    .filter(t => t._nodeIdx === nIdx)
                    .forEach(t => allPicked.push({ ...t, _cId: cId }));
                return Promise.resolve();
            }

            // Otherwise load from Firebase
            return get(ref(db, `isi_v6/clusters/${cId}/nodes/${nIdx}/tradeHistory`))
                .then(snap => {
                    const val = snap.val();
                    if (!val) return;
                    Object.entries(val).forEach(([fbKey, trade]) => {
                        if (trade && trade.date) {
                            allPicked.push({
                                ...trade,
                                _cId:       cId,
                                _nodeIdx:   nIdx,
                                _fbKey:     fbKey,
                                _nodeTitle: node.title || 'Account '+(nIdx+1),
                                _curr:      node.curr || '$'
                            });
                        }
                    });
                })
                .catch(() => {});
        });
        return Promise.all(nodePromises);
    });

    await Promise.all(promises);

    // Sort by date+time
    allPicked.sort((a,b) => {
        const d = (a.date||'').localeCompare(b.date||'');
        return d !== 0 ? d : (a.savedAt||'').localeCompare(b.savedAt||'');
    });

    // Apply range
    const histSlice = allPicked.slice(-MC_RANGES[_mcRngIdx]);

    // Start balance = sum of node.balance for selected nodes
    let startBal = 0;
    Object.entries(clusters).forEach(([cId, cluster]) => {
        const sel = _mcSel[cId];
        if (!sel || !sel.on) return;
        (cluster.nodes||[]).forEach((node,nIdx) => {
            if (sel.nodes[nIdx] !== false) startBal += (node.balance ?? 0);
        });
    });

    // Build equity curve
    let running = startBal;
    const eqPts = [running];
    histSlice.forEach(t => {
        const curr = t._curr || t.curr || '$';
        const pl   = (curr === '₹') ? (t.pl||0)/rate : (t.pl||0);
        running += pl;
        eqPts.push(parseFloat(running.toFixed(2)));
    });

    const wins = histSlice.filter(t => t.type==='Target').length;
    const wr   = histSlice.length ? ((wins/histSlice.length)*100).toFixed(1) : 0;
    if (wrEl) wrEl.textContent = wr + '%';

    // Empty state
    if (!histSlice.length) {
        canvas.style.display = 'none';
        if (emptyEl) { emptyEl.style.display='flex'; emptyEl.textContent='No trades found for selected filters.'; }
        if (statsEl) statsEl.innerHTML = '';
        return;
    }

    canvas.style.display = '';
    if (emptyEl) emptyEl.style.display = 'none';

    // Point colors + labels
    const ptColors = eqPts.map((_,i) => i===0 ? '#c5a059' : mcPulseColor(histSlice[i-1]));
    const labels   = eqPts.map((_,i) => {
        if (i===0) return 'Start';
        const t = histSlice[i-1];
        return t?.date ? t.date.slice(5) : 'T'+i;
    });

    if (_mcChart) { _mcChart.destroy(); _mcChart = null; }
    const c2d = canvas.getContext('2d');

    const glowPlugin = {
        id: 'mcGlow',
        afterDatasetsDraw(chart) {
            chart.getDatasetMeta(0).data.forEach((pt,i) => {
                const col = ptColors[i];
                c2d.save();
                c2d.shadowColor=mcGlowColor(col); c2d.shadowBlur=18;
                c2d.beginPath(); c2d.arc(pt.x,pt.y,5,0,Math.PI*2); c2d.fillStyle=col; c2d.fill();
                c2d.shadowBlur=8;
                c2d.beginPath(); c2d.arc(pt.x,pt.y,3,0,Math.PI*2); c2d.fillStyle=col; c2d.fill();
                c2d.restore();
            });
        }
    };

    _mcChart = new Chart(c2d, {
        type: 'line',
        data: {
            labels,
            datasets: [{
                data: eqPts,
                segment: { borderColor: ctx => ptColors[ctx.p1DataIndex]||'#c5a059' },
                borderWidth: 1.5,
                pointRadius:5, pointHoverRadius:8,
                pointBackgroundColor: ctx => ptColors[ctx.dataIndex]||'#c5a059',
                pointBorderColor:     ctx => ptColors[ctx.dataIndex]||'#c5a059',
                pointBorderWidth:1, tension:0.35, fill:false
            }]
        },
        options: {
            responsive:true, maintainAspectRatio:false, animation:{duration:300},
            plugins: {
                legend:{display:false},
                tooltip:{
                    callbacks:{
                        title: items => {
                            const i=items[0].dataIndex;
                            if(i===0) return 'Starting Balance';
                            const t=histSlice[i-1];
                            return t ? `${t.date} — ${t._nodeTitle||''}` : items[0].label;
                        },
                        label: item => {
                            const i=item.dataIndex, bal=item.parsed.y;
                            if(i===0) return `Balance: $${bal.toLocaleString('en-US',{minimumFractionDigits:2})}`;
                            const t=histSlice[i-1]; if(!t) return `$${bal.toFixed(2)}`;
                            const sc=(t.scale||[]).filter(s=>s).length;
                            const out=t.type==='Stop Loss'?'🔴 SL':sc>=2?'🟢 FULL WIN':'🔵 PARTIAL';
                            return [out,`P/L: $${(t.pl||0).toFixed(2)}`,`Bal: $${bal.toLocaleString('en-US',{minimumFractionDigits:2})}`];
                        }
                    },
                    backgroundColor:'#0d1117',borderColor:'#2a2a2a',borderWidth:1,
                    titleColor:'#c5a059',bodyColor:'#aaa',padding:10
                }
            },
            scales:{
                y:{grid:{color:'rgba(255,255,255,0.03)'},ticks:{color:'#555',font:{size:9},callback:v=>'$'+v.toLocaleString()}},
                x:{grid:{display:false},ticks:{color:'#444',font:{size:9},maxRotation:45,maxTicksLimit:12}}
            }
        },
        plugins:[glowPlugin]
    });

    // Stats
    const net=eqPts[eqPts.length-1]-eqPts[0];
    const plC=net>=0?'#00c805':'#ff3131';
    if (statsEl) statsEl.innerHTML=[
        ['NET P/L',`<span style="color:${plC};font-family:monospace;">${net>=0?'+':''}$${Math.abs(net).toFixed(2)}</span>`],
        ['WIN RATE',`<span style="color:var(--gold);font-family:monospace;">${wr}%</span>`],
        ['TRADES',`<span style="color:#ccc;font-family:monospace;">${histSlice.length}</span>`],
        ['W / L',`<span style="color:#00c805;">${wins}</span> / <span style="color:#ff3131;">${histSlice.length-wins}</span>`]
    ].map(([l,v])=>`<div style="background:#060606;border:1px solid #1a1a1a;border-radius:5px;padding:7px 14px;">
        <div style="font-size:0.55rem;color:#444;letter-spacing:1px;margin-bottom:2px;">${l}</div>
        <div style="font-size:0.76rem;font-weight:bold;">${v}</div></div>`).join('');
}

window.mcToggleFullscreen = function() {
    const panel = document.getElementById('mcPanel');
    const inner = panel?.querySelector(':scope > div');
    const btn   = document.getElementById('mcFsBtn');
    if (!inner) return;
    const fs = inner.dataset.fs === '1';
    inner.style.maxWidth     = fs ? '900px' : '100%';
    inner.style.margin       = fs ? '0 auto' : '0';
    inner.style.borderRadius = fs ? '10px' : '0';
    panel.style.padding      = fs ? '16px' : '0';
    const chartBox = document.getElementById('mcEquityCanvas')?.parentElement;
    if (chartBox) chartBox.style.height = fs ? '200px' : '340px';
    if (btn) btn.textContent = fs ? '⛶' : '↙';
    inner.dataset.fs = fs ? '0' : '1';
    if (_mcChart) setTimeout(()=>_mcChart.resize(),100);
};
// ══════════════════════════════════════════════════════════
// DELETE ALL SCREENSHOTS
// ══════════════════════════════════════════════════════════
window.openDeleteSS = function() {
    const panel = document.getElementById('deleteSsPanel');
    panel.style.display = 'flex';
    const sel = document.getElementById('delSsCid');
    sel.innerHTML = '<option value="">— Select Cluster —</option>';
    Object.entries(clusters).forEach(([cId, c]) => {
        const o = document.createElement('option');
        o.value = cId; o.textContent = c.title;
        if (cId === selectedClusterId) o.selected = true;
        sel.appendChild(o);
    });
    document.getElementById('delSsPass').value = '';
    document.getElementById('delSsErr').textContent = '';
};

window.closeDeleteSS = function() {
    document.getElementById('deleteSsPanel').style.display = 'none';
};

window.confirmDeleteSS = async function() {
    const cId  = document.getElementById('delSsCid').value;
    const pass = document.getElementById('delSsPass').value.trim();
    const err  = document.getElementById('delSsErr');
    const btn  = document.getElementById('delSsConfirmBtn');

    err.textContent = '';
    if (!cId)  { err.textContent = 'Please select a cluster.'; return; }
    if (!pass) { err.textContent = 'Please enter password.'; return; }

    // Verify password against Firebase
    try {
        const snap = await get(ref(db, `isi_v6/clusters/${cId}/securityKey`));
        const stored = snap.val();
        if (stored && pass !== stored) {
            err.textContent = '❌ Wrong password!'; return;
        }
    } catch(e) { err.textContent = 'Error checking password.'; return; }

    btn.textContent = '⏳ Deleting...';
    btn.disabled = true;

    let count = 0;
    const clusterTrades = allTrades.filter(t => {
        const tid = t.clusterId || t._cId || selectedClusterId;
        return tid === cId;
    });

    for (const t of clusterTrades) {
        if (!t.image) continue;
        try {
            await update(ref(db, `isi_v6/clusters/${cId}/nodes/${t._nodeIdx}/tradeHistory/${t._fbKey}`), { image: null });
            t.image = null;
            count++;
        } catch(e) {}
    }

    btn.textContent = '🗑 CONFIRM DELETE';
    btn.disabled = false;
    closeDeleteSS();
    alert(`✅ ${count} screenshot${count!==1?'s':''} deleted successfully!`);
};

// ── MC FULLSCREEN TOGGLE ──
window.mcToggleFullscreen = function() {
    const panel = document.getElementById('mcPanel');
    const inner = panel?.querySelector('div');
    const btn   = document.getElementById('mcFsBtn');
    if (!inner) return;

    if (inner.dataset.fs === '1') {
        // Restore
        inner.style.maxWidth  = '900px';
        inner.style.margin    = '0 auto';
        inner.style.height    = '';
        panel.style.padding   = '16px';
        if (btn) btn.textContent = '⛶';
        inner.dataset.fs = '0';
        // Restore chart height
        const chartBox = inner.querySelector('#mcEquityCanvas')?.parentElement;
        if (chartBox) chartBox.style.height = '200px';
    } else {
        // Fullscreen
        inner.style.maxWidth  = '100%';
        inner.style.margin    = '0';
        inner.style.height    = '100vh';
        inner.style.overflowY = 'auto';
        inner.style.borderRadius = '0';
        panel.style.padding   = '0';
        if (btn) btn.textContent = '✕FS';
        inner.dataset.fs = '1';
        // Expand chart height
        const chartBox = inner.querySelector('#mcEquityCanvas')?.parentElement;
        if (chartBox) chartBox.style.height = '320px';
    }
    // Resize chart
    if (_mcChart) setTimeout(() => _mcChart.resize(), 100);
};

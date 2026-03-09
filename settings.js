import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, set, update, onValue, remove, get, push as _fbPush } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { getStorage, ref as sRef, uploadBytesResumable, getDownloadURL, deleteObject } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

const firebaseConfig = {
    apiKey: "AIzaSyBhVpnVtlLMy0laY8U5A5Y8lLY9s3swjkE",
    authDomain: "trading-terminal-b8006.firebaseapp.com",
    projectId: "trading-terminal-b8006",
    storageBucket: "trading-terminal-b8006.firebasestorage.app",
    messagingSenderId: "690730161822",
    appId: "1:690730161822:web:81dabfd7b4575e86860d8f",
    databaseURL: "https://trading-terminal-b8006-default-rtdb.firebaseio.com"
};
const app = initializeApp(firebaseConfig);
const db      = getDatabase(app);
let clusters      = {}; // global cache for transaction section
let liveStatsCache = {}; // live stats cache for transaction dropdowns
const storage = getStorage(app);

const days = ['MON','TUE','WED','THU','FRI'];
let editingClusterId = null;

// Stats path — dedicated lightweight path, no images here
// Always use String(nIdx) — Firebase object keys are strings
const statsPath = (cId, nIdx) => `isi_v6/stats/${cId}/${String(nIdx)}`;

// Helper: get live stats for a node (new path first, fallback to old nodes path)
async function getLiveStats(cId, nIdx, fallbackBalance) {
    try {
        const snap = await get(ref(db, statsPath(cId, nIdx)));
        if (snap.val()) return snap.val();
        // Try old location for migration
        const oldSnap = await get(ref(db, `isi_v6/clusters/${cId}/nodes/${nIdx}/stats`));
        if (oldSnap.val()) {
            // Migrate: write to new path
            await set(ref(db, statsPath(cId, nIdx)), oldSnap.val());
            return oldSnap.val();
        }
    } catch(e) {}
    return { currentBal: fallbackBalance || 0, trades: 0, wins: 0, winRate: 0, net: 0 };
}

// ─────────────────────────────────────────────────────────
// HELPER — format balance with correct currency symbol
// ─────────────────────────────────────────────────────────
function fmtBal(curr, val) {
    return `${curr}${Number(val||0).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
}

// ─────────────────────────────────────────────────────────
// BUILD NODE UI
// ─────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────
// CUSTOM NODE COUNT HELPERS
// ─────────────────────────────────────────────────────────
window.onNodeQtyChange = function() {
    const val = document.getElementById('nodeQty').value;
    const box = document.getElementById('customNodeBox');
    if (val === 'custom') {
        box.style.display = 'flex';
        document.getElementById('nodeGrid').innerHTML = '';
    } else {
        box.style.display = 'none';
        window.buildNodeUI();
    }
};

window.applyCustomNodes = function() {
    const n = parseInt(document.getElementById('customNodeCount').value);
    if (!n || n < 1 || n > 20) return alert('1 se 20 tak valid count daalo!');
    window.buildNodeUI(null, n);
};

// ─────────────────────────────────────────────────────────
// BUILD SLOT HTML for a single day+node
// slots: array of { start, end, expire, risk, qtyFrom, qtyTo }
// ─────────────────────────────────────────────────────────
function buildDaySlotHtml(day, nodeIdx, slots) {
    // slots = array; always at least 1 empty slot
    if (!slots || slots.length === 0) slots = [{}];
    let slotsHtml = '';
    slots.forEach((sl, sIdx) => {
        slotsHtml += `
        <div class="slot-row" data-day="${day}" data-node="${nodeIdx}" data-slot="${sIdx}" style="display:grid;grid-template-columns:1fr 1fr 1fr 60px 40px 40px auto;gap:3px;align-items:center;margin-bottom:4px;">
            <input type="time" class="slot-start"  data-day="${day}" data-node="${nodeIdx}" data-slot="${sIdx}" value="${sl.start||''}" style="padding:3px;background:#000;border:1px solid #333;color:#fff;font-size:0.62rem;width:100%;">
            <input type="time" class="slot-end"    data-day="${day}" data-node="${nodeIdx}" data-slot="${sIdx}" value="${sl.end||''}"   style="padding:3px;background:#000;border:1px solid #333;color:#fff;font-size:0.62rem;width:100%;">
            <input type="time" class="slot-expire" data-day="${day}" data-node="${nodeIdx}" data-slot="${sIdx}" value="${sl.expire||''}" style="padding:3px;background:#000;border:1px solid #333;color:#fff;font-size:0.62rem;width:100%;">
            <input type="number" class="slot-risk" data-day="${day}" data-node="${nodeIdx}" data-slot="${sIdx}" value="${sl.risk ?? ''}" step="0.01" placeholder="Risk%" title="Risk %" style="padding:3px;background:#000;border:1px solid #444;color:var(--gold);font-size:0.62rem;width:100%;">
            <input type="number" class="slot-qfrom" data-day="${day}" data-node="${nodeIdx}" data-slot="${sIdx}" value="${sl.qtyFrom??1}" placeholder="Q-" title="Qty From" style="padding:3px;background:#000;border:1px solid #333;color:#aaa;font-size:0.6rem;width:100%;">
            <input type="number" class="slot-qto"   data-day="${day}" data-node="${nodeIdx}" data-slot="${sIdx}" value="${sl.qtyTo??10}" placeholder="Q+" title="Qty To" style="padding:3px;background:#000;border:1px solid #333;color:#aaa;font-size:0.6rem;width:100%;">
            ${sIdx === 0
                ? `<button onclick="addSlot(this,'${day}',${nodeIdx})" title="Add time slot" style="background:transparent;border:1px solid var(--gold);color:var(--gold);padding:2px 6px;border-radius:3px;cursor:pointer;font-size:0.75rem;">＋</button>`
                : `<button onclick="removeSlot(this)" title="Remove slot" style="background:transparent;border:1px solid var(--danger);color:var(--danger);padding:2px 6px;border-radius:3px;cursor:pointer;font-size:0.75rem;">✕</button>`
            }
        </div>`;
    });
    return slotsHtml;
}

// Add slot dynamically
window.addSlot = function(btn, day, nodeIdx) {
    const container = btn.closest('.day-slots-container');
    const existingSlots = container.querySelectorAll('.slot-row').length;
    const sIdx = existingSlots;
    const div = document.createElement('div');
    div.innerHTML = `
        <div class="slot-row" data-day="${day}" data-node="${nodeIdx}" data-slot="${sIdx}" style="display:grid;grid-template-columns:1fr 1fr 1fr 60px 40px 40px auto;gap:3px;align-items:center;margin-bottom:4px;">
            <input type="time" class="slot-start"  data-day="${day}" data-node="${nodeIdx}" data-slot="${sIdx}" style="padding:3px;background:#000;border:1px solid #333;color:#fff;font-size:0.62rem;width:100%;">
            <input type="time" class="slot-end"    data-day="${day}" data-node="${nodeIdx}" data-slot="${sIdx}" style="padding:3px;background:#000;border:1px solid #333;color:#fff;font-size:0.62rem;width:100%;">
            <input type="time" class="slot-expire" data-day="${day}" data-node="${nodeIdx}" data-slot="${sIdx}" style="padding:3px;background:#000;border:1px solid #333;color:#fff;font-size:0.62rem;width:100%;">
            <input type="number" class="slot-risk" data-day="${day}" data-node="${nodeIdx}" data-slot="${sIdx}" value="" placeholder="Risk%" style="padding:3px;background:#000;border:1px solid #444;color:var(--gold);font-size:0.62rem;width:100%;">
            <input type="number" class="slot-qfrom" data-day="${day}" data-node="${nodeIdx}" data-slot="${sIdx}" value="1" placeholder="Q-" style="padding:3px;background:#000;border:1px solid #333;color:#aaa;font-size:0.6rem;width:100%;">
            <input type="number" class="slot-qto"   data-day="${day}" data-node="${nodeIdx}" data-slot="${sIdx}" value="10" placeholder="Q+" style="padding:3px;background:#000;border:1px solid #333;color:#aaa;font-size:0.6rem;width:100%;">
            <button onclick="removeSlot(this)" title="Remove slot" style="background:transparent;border:1px solid var(--danger);color:var(--danger);padding:2px 6px;border-radius:3px;cursor:pointer;font-size:0.75rem;">✕</button>
        </div>`;
    container.appendChild(div.firstElementChild);
};

window.removeSlot = function(btn) {
    const row = btn.closest('.slot-row');
    if (row) row.remove();
};

// ─────────────────────────────────────────────────────────
// BUILD NODE UI  (new multi-slot version)
// existingNodes: array of node objects from Firebase
// forceQty: override qty (used by custom input)
// ─────────────────────────────────────────────────────────
window.buildNodeUI = function(existingNodes = null, forceQty = null) {
    let qty;
    if (forceQty !== null) {
        qty = forceQty;
    } else {
        const val = document.getElementById('nodeQty').value;
        qty = val === 'custom' ? 0 : parseInt(val);
    }
    const grid = document.getElementById('nodeGrid');
    grid.innerHTML = '';
    if (!qty || qty === 0) return;

    for (let i = 0; i < qty; i++) {
        const ex = existingNodes ? (existingNodes[i] || {}) : {};

        // Support both old (times[DAY]={start,end,expire}) and new (timeSlots[DAY]=[{...}]) format
        let dayHtml = '';
        days.forEach(day => {
            // New format: timeSlots[day] is array of slots
            let slots = [];
            if (ex.timeSlots && ex.timeSlots[day] && Array.isArray(ex.timeSlots[day]) && ex.timeSlots[day].length > 0) {
                slots = ex.timeSlots[day];
            } else if (ex.times && ex.times[day]) {
                // Migrate old format: single slot, copy risk from node level
                const t = ex.times[day];
                if (t.start) slots = [{ start: t.start, end: t.end||'', expire: t.expire||'', risk: ex.risk ?? null, qtyFrom: ex.qtyFrom||1, qtyTo: ex.qtyTo||10 }];
            }
            if (!slots.length) slots = [{}];

            dayHtml += `
            <div class="day-card" style="background:#0a0a0a;padding:10px;border-radius:4px;border:1px solid #333;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                    <div class="day-name" style="font-weight:bold;color:var(--gold);font-size:0.7rem;">${day}</div>
                    <label style="font-size:0.55rem;color:#555;display:flex;align-items:center;gap:4px;cursor:pointer;">
                        <input type="checkbox" class="day-deselect" data-day="${day}" data-node="${i}" ${slots[0].start ? '' : 'checked'}
                            onchange="toggleDaySlots(this)"
                            style="accent-color:var(--danger);cursor:pointer;">
                        OFF
                    </label>
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr 60px 40px 40px auto;gap:2px;margin-bottom:3px;">
                    <div style="font-size:0.5rem;color:#444;text-align:center;">ENTRY</div>
                    <div style="font-size:0.5rem;color:#444;text-align:center;">EXIT</div>
                    <div style="font-size:0.5rem;color:#444;text-align:center;">EXPIRE</div>
                    <div style="font-size:0.5rem;color:#c5a059;text-align:center;">RISK%</div>
                    <div style="font-size:0.5rem;color:#444;text-align:center;">Q-</div>
                    <div style="font-size:0.5rem;color:#444;text-align:center;">Q+</div>
                    <div></div>
                </div>
                <div class="day-slots-container" data-day="${day}" data-node="${i}" ${!slots[0].start && !ex.times?.[day]?.start ? 'style="opacity:0.3;pointer-events:none;"' : ''}>
                    ${buildDaySlotHtml(day, i, slots)}
                </div>
            </div>`;
        });

        grid.innerHTML += `
        <div class="node-setup-card">
            <div class="input-row">
                <input type="text"   class="node-title"   placeholder="Account Name" value="${ex.title || 'Account '+(i+1)}">
                <select class="node-curr">
                    <option value="$" ${(ex.curr||'$')==='$'?'selected':''}>$ USD</option>
                    <option value="₹" ${(ex.curr||'')==='₹'?'selected':''}>₹ INR</option>
                </select>
                <input type="number" class="node-balance" placeholder="Setup Balance" value="${ex.balance ?? 100000}" title="Setup/Initial Balance">
            </div>
            <div style="margin-bottom:8px;">
                <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;">
                    <div style="font-size:0.65rem;color:#555;letter-spacing:1px;">Trade Order #</div>
                    <input type="number" class="node-order" value="${ex.order ?? (i+1)}" style="width:50px;padding:4px;background:#000;border:1px solid #333;color:#fff;">
                </div>
            </div>
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;">${dayHtml}</div>
        </div>`;
    }
};

// Toggle day ON/OFF
window.toggleDaySlots = function(cb) {
    const container = cb.closest('.day-card').querySelector('.day-slots-container');
    if (cb.checked) {
        // OFF — disable inputs, dim
        container.style.opacity = '0.3';
        container.style.pointerEvents = 'none';
        // Clear start times so they don't get saved
        container.querySelectorAll('.slot-start').forEach(el => el.dataset.disabled = '1');
    } else {
        container.style.opacity = '1';
        container.style.pointerEvents = '';
        container.querySelectorAll('.slot-start').forEach(el => delete el.dataset.disabled);
    }
};

// ─────────────────────────────────────────────────────────
// HELPER — collect timeSlots from a node card
// Returns: { MON: [{start,end,expire,risk,qtyFrom,qtyTo},...], ... }
// ─────────────────────────────────────────────────────────
function collectNodeTimeSlots(card, nodeIdx) {
    const result = {};
    days.forEach(day => {
        const container = card.querySelector(`.day-slots-container[data-day="${day}"][data-node="${nodeIdx}"]`);
        if (!container) return;
        const deselect = card.querySelector(`.day-deselect[data-day="${day}"][data-node="${nodeIdx}"]`);
        if (deselect && deselect.checked) {
            result[day] = []; // day is OFF
            return;
        }
        const rows = container.querySelectorAll('.slot-row');
        const slots = [];
        rows.forEach(row => {
            const start = row.querySelector('.slot-start')?.value || '';
            if (!start) return; // skip empty slots
            slots.push({
                start,
                end:     row.querySelector('.slot-end')?.value    || '',
                expire:  row.querySelector('.slot-expire')?.value || '',
                risk:    parseFloat(row.querySelector('.slot-risk')?.value) || null,
                qtyFrom: parseInt(row.querySelector('.slot-qfrom')?.value   || 1),
                qtyTo:   parseInt(row.querySelector('.slot-qto')?.value     || 10),
            });
        });
        result[day] = slots;
    });
    return result;
}

// ─────────────────────────────────────────────────────────
// RESET FORM
// ─────────────────────────────────────────────────────────
function resetForm() {
    editingClusterId = null;
    document.getElementById('deskTitle').value    = '';
    document.getElementById('resetKey').value     = '';
    document.getElementById('nodeQty').value      = '0';
    document.getElementById('nodeGrid').innerHTML = '';
    const customBox = document.getElementById('customNodeBox');
    if (customBox) customBox.style.display = 'none';
    const btn = document.getElementById('btnDeploy');
    btn.textContent = 'DEPLOY CLUSTER';
    btn.style.cssText = '';
    const cancel = document.getElementById('btnCancelEdit');
    if (cancel) cancel.style.display = 'none';
    const banner = document.getElementById('editModeBanner');
    if (banner) banner.style.display = 'none';
}

// ─────────────────────────────────────────────────────────
// DEPLOY / UPDATE
// EDIT  → update() per field — tradeHistory NEVER touched
// NEW   → set() on fresh path
// ─────────────────────────────────────────────────────────
document.getElementById('btnDeploy').onclick = async () => {
    const title = document.getElementById('deskTitle').value.trim();
    const pass  = document.getElementById('resetKey').value.trim();
    if (!title || !pass) return alert('Cluster Name aur Security Key daalo!');
    const cards = document.querySelectorAll('.node-setup-card');
    if (!cards.length) return alert('Nodes select karo!');

    const btn = document.getElementById('btnDeploy');
    btn.textContent = editingClusterId ? 'UPDATING...' : 'DEPLOYING...';

    try {
        if (editingClusterId) {
            // ── EDIT: only metadata — NEVER touch tradeHistory / equityPoints ──
            await update(ref(db, `isi_v6/clusters/${editingClusterId}`), { title, resetKey: pass });

            for (let i = 0; i < cards.length; i++) {
                const card = cards[i];
                const timeSlots = collectNodeTimeSlots(card, i);
                const newSetupBalance = parseFloat(card.querySelector('.node-balance').value);

                // Update only config — NOT stats, NOT tradeHistory, NOT equityPoints
                await update(ref(db, `isi_v6/clusters/${editingClusterId}/nodes/${i}`), {
                    title:      card.querySelector('.node-title').value,
                    curr:       card.querySelector('.node-curr').value,
                    balance:    newSetupBalance,
                    timeSlots,
                    order:      parseInt(card.querySelector('.node-order').value),
                });

                // Only reset stats.currentBal if NO trades yet
                const s = await getLiveStats(editingClusterId, i, newSetupBalance);
                if (!s.trades || s.trades === 0) {
                    await set(ref(db, statsPath(editingClusterId, i)), {
                        currentBal: newSetupBalance,
                        trades: 0, wins: 0, winRate: 0, net: 0
                    });
                }
            }
            alert('✅ Cluster updated! Trade history safe hai.');
            resetForm();

        } else {
            // ── NEW CLUSTER ──
            const clusterId = title.toLowerCase().replace(/\s+/g,'_');
            const cluster   = { title, resetKey: pass, nodes: [] };
            cards.forEach((card, i) => {
                const timeSlots = collectNodeTimeSlots(card, i);
                const b = parseFloat(card.querySelector('.node-balance').value);
                cluster.nodes.push({
                    title:     card.querySelector('.node-title').value,
                    curr:      card.querySelector('.node-curr').value,
                    balance:   b,
                    timeSlots,
                    order:     parseInt(card.querySelector('.node-order').value),
                });
            });
            await set(ref(db, `isi_v6/clusters/${clusterId}`), cluster);
            for (let i = 0; i < cluster.nodes.length; i++) {
                await set(ref(db, statsPath(clusterId, i)), {
                    currentBal: cluster.nodes[i].balance,
                    trades: 0, wins: 0, winRate: 0, net: 0
                });
            }
            alert('✅ Cluster deployed!');
            resetForm();
        }
    } catch (err) {
        alert('Firebase Error: ' + err.message);
    } finally {
        btn.textContent = editingClusterId ? '💾 UPDATE CLUSTER' : 'DEPLOY CLUSTER';
        if (editingClusterId) { btn.style.background='linear-gradient(45deg,#1565c0,#42a5f5)'; btn.style.color='#fff'; }
    }
};

// ─────────────────────────────────────────────────────────
// ACTIVE CLUSTERS LIST
// Fetch live stats per-node via get() so balance is always fresh
// Per-node currency shown individually — no mixed-currency sum
// ─────────────────────────────────────────────────────────
async function renderClusterCard(id, cluster) {
    const nodes = cluster.nodes || [];

    // Fetch live stats from dedicated lightweight path
    const statsArr = await Promise.all(
        nodes.map((n, i) => getLiveStats(id, i, n.balance))
    );

    // Per-currency totals (mixed currency clusters handled correctly)
    const byCurrency = {};
    nodes.forEach((n, i) => {
        const c   = n.curr || '$';
        const bal = statsArr[i].currentBal ?? n.balance ?? 0;
        byCurrency[c] = (byCurrency[c] || 0) + bal;
    });
    const aumStr = Object.entries(byCurrency)
        .map(([c, v]) => fmtBal(c, v))
        .join(' + ');

    const totalTrades = statsArr.reduce((s, st) => s + (st.trades || 0), 0);

    const netByCurr = {};
    nodes.forEach((n, i) => {
        const c = n.curr || '$';
        netByCurr[c] = (netByCurr[c] || 0) + (statsArr[i].net || 0);
    });
    const netStr = Object.entries(netByCurr)
        .map(([c, v]) => `<span style="color:${v>=0?'var(--accent)':'var(--danger)'};">${v>=0?'+':''}${fmtBal(c,v)}</span>`)
        .join(' ');

    return `
    <div class="active-card" id="acard_${id}">
        <div style="display:flex;justify-content:space-between;align-items:center;">
            <div>
                <strong style="color:var(--gold);font-size:0.95rem;">${cluster.title}</strong>
                <div style="font-size:0.6rem;color:#555;margin-top:2px;">${nodes.length} nodes · ${totalTrades} trades</div>
            </div>
            <div style="display:flex;gap:6px;">
                <button onclick="editCluster('${id}')"
                    style="background:var(--accent);color:#000;border:none;padding:6px 12px;border-radius:3px;cursor:pointer;font-weight:bold;font-size:0.75rem;">✏ EDIT</button>
                <button onclick="deleteCluster('${id}','${cluster.resetKey}')"
                    style="background:var(--danger);color:#fff;border:none;padding:6px 12px;border-radius:3px;cursor:pointer;font-weight:bold;font-size:0.75rem;">✕ DEL</button>
            </div>
        </div>

        <div class="metrics" style="margin-top:10px;">
            <div><small>Live AUM</small><div class="m-val" style="color:var(--gold);font-size:0.8rem;">${aumStr}</div></div>
            <div><small>Net P&L</small><div class="m-val" style="font-size:0.8rem;">${netStr||'—'}</div></div>
            <div><small>Trades</small><div class="m-val">${totalTrades}</div></div>
            <div><small>Status</small><div class="m-val" style="color:var(--accent)">● LIVE</div></div>
        </div>

        <div style="margin-top:10px;border-top:1px solid #1a1a1a;padding-top:8px;">
            ${nodes.map((n, i) => {
                const s       = statsArr[i];
                const liveBal = s.currentBal ?? n.balance ?? 0;
                const net     = s.net     || 0;
                const trades  = s.trades  || 0;
                const wr      = s.winRate || 0;
                return `
                <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;${i>0?'border-top:1px solid #111;':''}">
                    <span style="color:#888;font-size:0.68rem;">${n.title||'Acc '+(i+1)}</span>
                    <div style="display:flex;gap:8px;font-size:0.68rem;font-family:monospace;">
                        <span style="color:var(--gold);font-weight:bold;">${fmtBal(n.curr||'$',liveBal)}</span>
                        <span style="color:${net>=0?'var(--accent)':'var(--danger)'};">${net>=0?'+':''}${fmtBal(n.curr||'$',net)}</span>
                        <span style="color:#555;">T:${trades} WR:${wr}%</span>
                    </div>
                </div>`;
            }).join('')}
        </div>
    </div>`;
}

onValue(ref(db, 'isi_v6/clusters'), async (snap) => {
    clusters = snap.val() || {}; // keep global in sync
    populateTxClusters(); // refresh transaction dropdown
    const list = document.getElementById('activeList');
    const data = snap.val();
    if (!data) {
        list.innerHTML = '<div style="color:#555;font-size:0.82rem;padding:20px;text-align:center;">No clusters deployed yet.</div>';
        return;
    }
    list.innerHTML = '<div style="color:#555;font-size:0.75rem;padding:10px;">Loading live balances...</div>';
    const cards = await Promise.all(Object.entries(data).map(([id, c]) => renderClusterCard(id, c)));
    list.innerHTML = cards.join('');
});

// ─────────────────────────────────────────────────────────
// EDIT CLUSTER
// ─────────────────────────────────────────────────────────
window.editCluster = (id) => {
    const key = prompt('🔑 Security Key enter karo:');
    if (!key) return;
    get(ref(db, `isi_v6/clusters/${id}`)).then(snap => {
        const cluster = snap.val();
        if (!cluster)                  return alert('Cluster not found!');
        if (cluster.resetKey !== key)  return alert('❌ Wrong Security Key!');

        editingClusterId = id;
        document.getElementById('deskTitle').value = cluster.title;
        document.getElementById('resetKey').value  = cluster.resetKey;

        const nodeCount  = cluster.nodes.length;
        const sel        = document.getElementById('nodeQty');
        // Check if standard option exists
        let found = false;
        for (const o of sel.options) { if (parseInt(o.value)===nodeCount){sel.value=o.value;found=true;break;} }
        if (!found) {
            // Use custom box
            sel.value = 'custom';
            const customBox = document.getElementById('customNodeBox');
            if (customBox) { customBox.style.display = 'flex'; }
            const customInput = document.getElementById('customNodeCount');
            if (customInput) customInput.value = nodeCount;
        }

        window.buildNodeUI(cluster.nodes, nodeCount);

        const btn = document.getElementById('btnDeploy');
        btn.textContent='💾 UPDATE CLUSTER';
        btn.style.background='linear-gradient(45deg,#1565c0,#42a5f5)';
        btn.style.color='#fff';

        let cancel = document.getElementById('btnCancelEdit');
        if (!cancel) {
            cancel=document.createElement('button');
            cancel.id='btnCancelEdit';
            cancel.style.cssText='width:100%;padding:12px;background:#1a1a1a;color:#888;border:1px solid #333;border-radius:6px;margin-top:10px;cursor:pointer;font-size:0.85rem;font-weight:bold;';
            cancel.onclick=resetForm;
            btn.insertAdjacentElement('afterend',cancel);
        }
        cancel.textContent='✕ Cancel Edit'; cancel.style.display='block';

        let banner=document.getElementById('editModeBanner');
        if (!banner) {
            banner=document.createElement('div'); banner.id='editModeBanner';
            banner.style.cssText='background:#0a1a2a;border:1px solid #1565c0;border-left:4px solid #42a5f5;padding:10px 14px;border-radius:4px;margin-bottom:14px;font-size:0.78rem;color:#42a5f5;font-weight:bold;';
            document.getElementById('nodeGrid').insertAdjacentElement('beforebegin',banner);
        }
        banner.style.display='block';
        banner.textContent=`✏ EDIT MODE — ${cluster.title} (${nodeCount} nodes)`;
        document.querySelector('.config-area').scrollTo({top:0,behavior:'smooth'});

    }).catch(err => alert('Firebase Error: '+err.message));
};

// ─────────────────────────────────────────────────────────
// DELETE CLUSTER
// ─────────────────────────────────────────────────────────
window.deleteCluster = (id, key) => {
    const entered = prompt('⚠️ Delete karne ke liye Security Key:');
    if (!entered) return;
    if (entered !== key) return alert('❌ Wrong Key!');
    if (!confirm('Pakka? Saara trade history permanently delete hoga!')) return;
    remove(ref(db,`isi_v6/clusters/${id}`))
        .then(()=>alert('✅ Deleted.'))
        .catch(err=>alert('Error: '+err.message));
};

// ─────────────────────────────────────────────────────────
// PRE-ENTRY CONFIG — Save to localStorage
// ─────────────────────────────────────────────────────────
window.savePreEntryConfig = function () {
    const config = {
        minAnalysisTime: parseInt(document.getElementById('minAnalysisTime')?.value || 300),
        minEntryScore:   parseInt(document.getElementById('minEntryScore')?.value   || 60),
        conflictBlock:   document.getElementById('conflictBlock')?.value || 'block'
    };
    localStorage.setItem('isi_preentry_config', JSON.stringify(config));
    const st = document.getElementById('preEntryConfigStatus');
    if (st) { st.textContent = '✅ Config saved!'; st.style.color = 'var(--accent)'; }
    setTimeout(() => { if (st) st.textContent = ''; }, 2000);
};

// Load saved config on page load
(function loadPreEntryConfig() {
    try {
        const cfg = JSON.parse(localStorage.getItem('isi_preentry_config') || '{}');
        if (cfg.minAnalysisTime !== undefined) {
            const el = document.getElementById('minAnalysisTime');
            if (el) el.value = String(cfg.minAnalysisTime);
        }
        if (cfg.minEntryScore !== undefined) {
            const el = document.getElementById('minEntryScore');
            if (el) el.value = String(cfg.minEntryScore);
        }
        if (cfg.conflictBlock !== undefined) {
            const el = document.getElementById('conflictBlock');
            if (el) el.value = cfg.conflictBlock;
        }
    } catch(e) {}
})();

// ═══════════════════════════════════════════════════════
// BLOCK 1 — AI INTEGRATION MANAGER
// ═══════════════════════════════════════════════════════

// Built-in providers
const BUILTIN_AI = [
    { id:'gemini',     name:'🟡 Gemini 2.0 Flash',   desc:'Free: 15 req/min · 1500/day',        link:'https://aistudio.google.com',  ph:'AIzaSy...' },
    { id:'groq',       name:'🟢 Groq Llama 3.3 70B', desc:'Free: 30 req/min · 14,400/day · Fastest', link:'https://console.groq.com',     ph:'gsk_...' },
    { id:'openrouter', name:'🔵 OpenRouter',          desc:'Free models: Mistral, Llama, Gemma', link:'https://openrouter.ai',         ph:'sk-or-...' },
    { id:'cohere',     name:'🟣 Cohere Command',      desc:'Free trial: 20 req/min',             link:'https://dashboard.cohere.com',  ph:'...' },
];

function getAllAIProviders() {
    const custom = JSON.parse(localStorage.getItem('isi_custom_ai') || '[]');
    return [...BUILTIN_AI, ...custom.map(c => ({
        id: 'custom_' + c.id, name: '⚪ ' + c.name,
        desc: c.url, link: c.freeLink || '#', ph: 'API Key...',
        custom: true, model: c.model, url: c.url
    }))];
}

function buildAIDropdown() {
    const sel = document.getElementById('aiProviderDropdown');
    if (!sel) return;
    const saved = localStorage.getItem('isi_ai_provider') || 'auto';
    sel.innerHTML = '<option value="auto">⚡ AUTO (best available use karega)</option>';
    getAllAIProviders().forEach(p => {
        const hasKey = !!localStorage.getItem('isi_key_' + p.id);
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name + (hasKey ? ' ✓' : '');
        sel.appendChild(opt);
    });
    sel.value = saved;
    onProviderSelect();
    refreshAIStatusRow();
}

window.onProviderSelect = function() {
    const sel = document.getElementById('aiProviderDropdown');
    if (!sel) return;
    const id = sel.value;
    if (id === 'auto') {
        document.getElementById('aiKeyPanel').style.opacity = '0.4';
        document.getElementById('aiKeyPanel').style.pointerEvents = 'none';
        localStorage.setItem('isi_ai_provider','auto');
        return;
    }
    document.getElementById('aiKeyPanel').style.opacity = '1';
    document.getElementById('aiKeyPanel').style.pointerEvents = 'auto';
    localStorage.setItem('isi_ai_provider', id);

    const p = getAllAIProviders().find(x => x.id === id);
    if (!p) return;
    document.getElementById('aiKeyLabel').textContent = p.name;
    document.getElementById('aiKeyDesc').textContent  = p.desc;
    document.getElementById('aiKeyLink').href         = p.link;
    document.getElementById('aiKeyInput').placeholder = p.ph;
    document.getElementById('aiKeyInput').value = localStorage.getItem('isi_key_' + id) || '';
    document.getElementById('aiKeyStatus').textContent = '';
    refreshAIStatusRow();
};

window.saveAIKey = function() {
    const id  = document.getElementById('aiProviderDropdown').value;
    const val = document.getElementById('aiKeyInput').value.trim();
    const st  = document.getElementById('aiKeyStatus');
    if (!val || id === 'auto') { if(st){st.textContent='⚠ Provider select karo aur key daalo';st.style.color='#ff6600';} return; }
    localStorage.setItem('isi_key_' + id, val);
    if(st){st.textContent='✅ Key saved! AI ready.';st.style.color='#00c805';}
    buildAIDropdown();
};

window.testAIKey = async function() {
    const id  = document.getElementById('aiProviderDropdown').value;
    const key = document.getElementById('aiKeyInput').value.trim() || localStorage.getItem('isi_key_' + id) || '';
    const st  = document.getElementById('aiKeyStatus');
    if (!key || id === 'auto') { if(st){st.textContent='⚠ Key daalo pehle';st.style.color='#ff6600';} return; }
    if(st){st.textContent='⏳ Testing...';st.style.color='#888';}
    try {
        let ok = false;
        if (id === 'gemini') {
            const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
                {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:'Say OK'}]}],generationConfig:{maxOutputTokens:5}})});
            ok = r.ok;
        } else if (id === 'groq') {
            const r = await fetch('https://api.groq.com/openai/v1/chat/completions',
                {method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},body:JSON.stringify({model:'llama-3.3-70b-versatile',messages:[{role:'user',content:'OK'}],max_tokens:5})});
            ok = r.ok;
        } else if (id === 'openrouter') {
            const r = await fetch('https://openrouter.ai/api/v1/chat/completions',
                {method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+key,'HTTP-Referer':location.origin},body:JSON.stringify({model:'mistralai/mistral-7b-instruct:free',messages:[{role:'user',content:'OK'}],max_tokens:5})});
            ok = r.ok;
        } else if (id === 'cohere') {
            const r = await fetch('https://api.cohere.ai/v1/generate',
                {method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+key},body:JSON.stringify({model:'command',prompt:'Say OK',max_tokens:5})});
            ok = r.ok;
        } else { ok = true; } // custom — assume ok if key present
        if(st){st.textContent=ok?'✅ Key valid! AI ready.':'❌ Key invalid ya expired.';st.style.color=ok?'#00c805':'#ff5252';}
    } catch(e) {
        if(st){st.textContent='❌ Network error';st.style.color='#ff5252';}
    }
};

function refreshAIStatusRow() {
    const row = document.getElementById('aiAllStatus');
    const badge = document.getElementById('aiActiveBadge');
    if (!row) return;
    const providers = getAllAIProviders();
    let activeLabel = 'AUTO';
    row.innerHTML = providers.map(p => {
        const has = !!localStorage.getItem('isi_key_' + p.id);
        const short = p.name.split(' ').slice(1,3).join(' ');
        if (has && localStorage.getItem('isi_ai_provider') === p.id) activeLabel = short;
        return `<span style="background:${has?'#001800':'#0a0a0a'};border:1px solid ${has?'#006600':'#1a1a1a'};
            color:${has?'#00c805':'#333'};padding:3px 9px;border-radius:4px;font-size:0.58rem;font-weight:bold;">
            ${has?'✓':'—'} ${short}</span>`;
    }).join('');
    if (badge) badge.textContent = '⚡ ' + activeLabel;
}

// ── CUSTOM AI ──
window.addCustomAI = function() {
    document.getElementById('caiName').value = '';
    document.getElementById('caiUrl').value  = '';
    document.getElementById('caiModel').value= '';
    document.getElementById('caiKey').value  = '';
    document.getElementById('caiLink').value = '';
    const m = document.getElementById('customAIModal');
    m.style.display = 'flex';
};
window.closeCustomAI = function() { document.getElementById('customAIModal').style.display='none'; };
window.saveCustomAI = function() {
    const name  = document.getElementById('caiName').value.trim();
    const url   = document.getElementById('caiUrl').value.trim();
    const model = document.getElementById('caiModel').value.trim();
    const key   = document.getElementById('caiKey').value.trim();
    const link  = document.getElementById('caiLink').value.trim();
    if (!name || !url) return alert('Name aur URL required!');
    const customs = JSON.parse(localStorage.getItem('isi_custom_ai') || '[]');
    const id = Date.now().toString(36);
    customs.push({ id, name, url, model, freeLink: link });
    localStorage.setItem('isi_custom_ai', JSON.stringify(customs));
    if (key) localStorage.setItem('isi_key_custom_' + id, key);
    closeCustomAI();
    buildAIDropdown();
};


// ═══════════════════════════════════════════════════════
// BLOCK 2 — KNOWLEDGE BASE (Settings page)
// All DB calls use top-level: db, ref, onValue, update, remove, _fbPush
// ═══════════════════════════════════════════════════════

let _kbEntries   = {};
let _kbEditKey   = null;
let _kbActiveCat = 'ALL';
let _kbFileData  = null;        // { file(raw File obj), name, type, size, ext }
let _kbSubCount  = 0;
let _kbActiveTab = 'upload';    // 'upload' | 'text'
const _kbSubFiles = new Map();  // subCount(string) → raw File object

// ── Firebase listener ──
onValue(ref(db, 'isi_v6/knowledge/entries'), snap => {
    _kbEntries = snap.val() || {};
    renderKBList();
    updateKBStats();
    buildKBLinkDropdown();
});

window.onKBCatSelect = function() {
    _kbActiveCat = document.getElementById('kbCatDropdown').value;
    renderKBList();
};

// ── File Icons ──
function getFileIcon(ext) {
    const m = { pdf:'📄', doc:'📝', docx:'📝', xls:'📊', xlsx:'📊',
                txt:'📃', png:'🖼', jpg:'🖼', jpeg:'🖼', gif:'🖼',
                webp:'🖼', csv:'📊', ppt:'📋', pptx:'📋', mp4:'🎬', mp3:'🎵' };
    return m[(ext||'').toLowerCase()] || '📁';
}

// ── Tab switch ──
window.switchKBTab = function(tab) {
    _kbActiveTab = tab;
    const up = document.getElementById('tabUpload');
    const tx = document.getElementById('tabText');
    const bu = document.getElementById('tabUploadBtn');
    const bt = document.getElementById('tabTextBtn');
    if (!up || !tx) return;
    if (tab === 'upload') {
        up.style.display = 'block'; tx.style.display = 'none';
        bu.style.cssText += ';border-color:var(--gold);background:#1a1200;color:var(--gold);';
        bt.style.cssText += ';border-color:#333;background:#111;color:#666;';
    } else {
        up.style.display = 'none'; tx.style.display = 'block';
        bt.style.cssText += ';border-color:var(--gold);background:#1a1200;color:var(--gold);';
        bu.style.cssText += ';border-color:#333;background:#111;color:#666;';
    }
};

// ── Drag & drop ──
window.handleKBDrop = function(e) {
    e.preventDefault();
    document.getElementById('kbDropZone').style.borderColor = '#333';
    const file = e.dataTransfer.files[0];
    if (file) handleKBFile(file);
};

// ── Main file select ──
window.handleKBFile = function(file) {
    if (!file) return;
    const ext = file.name.split('.').pop().toLowerCase();
    _kbFileData = { file, name: file.name, type: file.type, size: file.size, ext };
    document.getElementById('kbFilePreview').style.display = 'block';
    document.getElementById('kbFileIcon').textContent = getFileIcon(ext);
    document.getElementById('kbFileName').textContent = file.name;
    document.getElementById('kbFileSize').textContent = (file.size / 1024 / 1024).toFixed(2) + ' MB';
    document.getElementById('kbDropZone').style.display = 'none';
};

window.clearKBFile = function() {
    _kbFileData = null;
    const fp = document.getElementById('kbFilePreview');
    const dz = document.getElementById('kbDropZone');
    const fi = document.getElementById('kbFileInput');
    if (fp) fp.style.display = 'none';
    if (dz) dz.style.display = 'block';
    if (fi) fi.value = '';
};

// ── Sub-sections ──
window.addKBSubSection = function() {
    _kbSubCount++;
    const id = 'sub_' + _kbSubCount;
    const n  = _kbSubCount;
    const container = document.getElementById('kbSubSections');
    const div = document.createElement('div');
    div.id = id;
    div.style.cssText = 'background:#050505;border:1px solid #1a1a1a;border-radius:6px;padding:12px;position:relative;';
    div.innerHTML = `
        <button onclick="removeSubSection('${id}', ${n})"
            style="position:absolute;top:8px;right:8px;background:var(--danger);color:#fff;border:none;padding:2px 8px;border-radius:3px;font-size:0.6rem;cursor:pointer;">✕</button>
        <div style="font-size:0.6rem;color:#c5a059;letter-spacing:1px;margin-bottom:8px;font-weight:bold;">SUB-SECTION ${n}</div>
        <div style="font-size:0.58rem;color:#555;margin-bottom:4px;">SUB-TITLE</div>
        <input type="text" placeholder="Sub-section title..."
            style="width:100%;background:#111;color:#fff;border:1px solid #222;padding:7px;border-radius:4px;font-size:0.72rem;margin-bottom:8px;"
            data-sub-title="${n}">
        <div style="display:flex;gap:6px;margin-bottom:8px;">
            <button onclick="switchSubTab(${n},'file')" id="subTabFile_${n}"
                style="padding:4px 10px;border-radius:3px;font-size:0.62rem;font-weight:bold;cursor:pointer;border:1px solid var(--gold);background:#1a1200;color:var(--gold);">
                📁 FILE
            </button>
            <button onclick="switchSubTab(${n},'text')" id="subTabText_${n}"
                style="padding:4px 10px;border-radius:3px;font-size:0.62rem;font-weight:bold;cursor:pointer;border:1px solid #333;background:#111;color:#666;">
                ✏ TEXT
            </button>
        </div>
        <div id="subFile_${n}">
            <div onclick="document.getElementById('subFileInput_${n}').click()"
                style="border:1px dashed #333;border-radius:4px;padding:14px;text-align:center;cursor:pointer;font-size:0.68rem;color:#555;">
                📁 Click to upload file
            </div>
            <input type="file" id="subFileInput_${n}" style="display:none" accept="*/*"
                onchange="handleSubFile(${n}, this.files[0])">
            <div id="subFilePreview_${n}" style="display:none;margin-top:6px;background:#111;border:1px solid #222;border-radius:4px;padding:8px;font-size:0.68rem;color:#888;"></div>
        </div>
        <div id="subText_${n}" style="display:none;">
            <textarea placeholder="Sub-section content..."
                style="width:100%;background:#111;color:#ccc;border:1px solid #222;padding:8px;border-radius:4px;font-size:0.7rem;resize:vertical;min-height:80px;line-height:1.5;"
                data-sub-text="${n}"></textarea>
        </div>`;
    container.appendChild(div);
};

window.removeSubSection = function(divId, n) {
    const el = document.getElementById(divId);
    if (el) el.remove();
    _kbSubFiles.delete(String(n));
};

window.switchSubTab = function(n, tab) {
    const sf = document.getElementById('subFile_' + n);
    const st = document.getElementById('subText_' + n);
    const bf = document.getElementById('subTabFile_' + n);
    const bt = document.getElementById('subTabText_' + n);
    if (!sf || !st) return;
    sf.style.display = tab === 'file' ? 'block' : 'none';
    st.style.display = tab === 'text' ? 'block' : 'none';
    if (bf) bf.style.cssText += tab==='file' ? ';border-color:var(--gold);background:#1a1200;color:var(--gold);' : ';border-color:#333;background:#111;color:#666;';
    if (bt) bt.style.cssText += tab==='text' ? ';border-color:var(--gold);background:#1a1200;color:var(--gold);' : ';border-color:#333;background:#111;color:#666;';
};

window.handleSubFile = function(n, file) {
    if (!file) return;
    const ext = file.name.split('.').pop().toLowerCase();
    _kbSubFiles.set(String(n), file);  // Store raw File in Map
    const prev = document.getElementById('subFilePreview_' + n);
    if (!prev) return;
    prev.style.display = 'block';
    prev.innerHTML = `${getFileIcon(ext)} <b>${file.name}</b> · ${(file.size/1024/1024).toFixed(2)}MB
        <span style="font-size:0.55rem;color:#00c805;margin-left:6px;">✓ Ready</span>`;
    prev.dataset.name = file.name;
    prev.dataset.type = file.type;
    prev.dataset.ext  = ext;
};

// ═══════════════════════════════
// UPLOAD TO FIREBASE STORAGE
// with real-time progress bar
// ═══════════════════════════════
function setProgressBar(pct, label, transferred, total) {
    const bar     = document.getElementById('kbUploadBar');
    const fill    = document.getElementById('kbUploadBarFill');
    const pctEl   = document.getElementById('kbUploadBarPct');
    const bytesEl = document.getElementById('kbUploadBytes');
    const btn     = document.querySelector('button[onclick="saveKBEntry()"]');

    if (bar)   bar.style.display = 'block';
    if (fill)  fill.style.width  = Math.min(pct, 100) + '%';
    if (pctEl) pctEl.textContent = `⏳ ${label} — ${Math.round(pct)}%`;
    if (bytesEl && transferred !== undefined) {
        bytesEl.textContent = `${(transferred/1024/1024).toFixed(2)} MB / ${(total/1024/1024).toFixed(2)} MB`;
    }
    if (btn) {
        btn.textContent = `⏳ ${Math.round(pct)}%`;
        btn.disabled    = true;
        btn.style.background = '#1a1200';
        btn.style.color      = '#c5a059';
        btn.style.border     = '1px solid #c5a059';
    }
}

function clearProgressBar() {
    const bar = document.getElementById('kbUploadBar');
    if (bar) bar.style.display = 'none';
}

function resetSaveBtn(text, isErr) {
    clearProgressBar();
    const btn = document.querySelector('button[onclick="saveKBEntry()"]');
    if (!btn) return;
    btn.textContent = text;
    btn.disabled    = false;
    btn.style.border = '';
    btn.style.background = isErr ? 'var(--danger)' : 'var(--gold)';
    btn.style.color      = isErr ? '#fff' : '#000';
}

async function uploadOneFile(file, storagePath) {
    return new Promise((resolve, reject) => {
        const storageRef = sRef(storage, storagePath);
        const task = uploadBytesResumable(storageRef, file);
        task.on('state_changed',
            (snap) => {
                const pct = (snap.bytesTransferred / snap.totalBytes) * 100;
                setProgressBar(pct, `Uploading ${file.name}`, snap.bytesTransferred, snap.totalBytes);
            },
            (err) => reject(new Error('Upload failed: ' + err.message)),
            async () => {
                try {
                    const url = await getDownloadURL(task.snapshot.ref);
                    resolve(url);
                } catch(e) { reject(e); }
            }
        );
    });
}

// ═══════════════════════════════
// SAVE ENTRY
// ═══════════════════════════════
window.saveKBEntry = async function() {
    const title = (document.getElementById('kbEntryTitle')?.value || '').trim();
    if (!title) { alert('Title required!'); return; }

    const btn = document.querySelector('button[onclick="saveKBEntry()"]');
    if (btn) { btn.textContent = '⏳ Preparing...'; btn.disabled = true; btn.style.background='#1a1200'; btn.style.color='#c5a059'; }

    try {
        const entryId = _kbEditKey || ('kb_' + Date.now().toString(36));

        // ── 1. Upload main file ──
        let fileData = null;
        if (_kbActiveTab === 'upload' && _kbFileData?.file instanceof File) {
            const safeName    = _kbFileData.name.replace(/[^a-zA-Z0-9._-]/g, '_');
            const storagePath = `knowledge/${entryId}/main_${safeName}`;
            const url = await uploadOneFile(_kbFileData.file, storagePath);
            fileData = {
                url,
                name:  _kbFileData.name,
                type:  _kbFileData.type  || '',
                ext:   _kbFileData.ext   || '',
                size:  _kbFileData.size  || 0,
                path:  storagePath
            };
        } else if (_kbFileData?.url) {
            fileData = _kbFileData; // existing — keep
        }

        // ── 2. Upload sub-section files ──
        const subs = {};
        const subTitleEls = document.querySelectorAll('[data-sub-title]');
        let si = 0;
        for (const el of subTitleEls) {
            si++;
            const n   = el.dataset.subTitle;
            const txt = (document.querySelector(`[data-sub-text="${n}"]`)?.value || '').trim();
            const fp  = document.getElementById('subFilePreview_' + n);
            let subFile = null;

            const rawFile = _kbSubFiles.get(String(n));
            if (rawFile instanceof File) {
                const safeSub = rawFile.name.replace(/[^a-zA-Z0-9._-]/g, '_');
                const subPath = `knowledge/${entryId}/sub${n}_${safeSub}`;
                const subUrl  = await uploadOneFile(rawFile, subPath);
                subFile = {
                    url:  subUrl,
                    name: fp?.dataset?.name || rawFile.name,
                    type: fp?.dataset?.type || rawFile.type,
                    ext:  fp?.dataset?.ext  || rawFile.name.split('.').pop().toLowerCase(),
                    path: subPath
                };
            } else if (fp?.dataset?.url) {
                subFile = { url: fp.dataset.url, name: fp.dataset.name, type: fp.dataset.type, ext: fp.dataset.ext };
            }

            if (el.value.trim() || txt || subFile) {
                subs['sub' + n] = { title: el.value.trim(), text: txt, file: subFile };
            }
        }

        // ── 3. Build entry object ──
        const entry = {
            title,
            type:        document.getElementById('kbEntryType')?.value   || 'SOP',
            desc:        (document.getElementById('kbEntryDesc')?.value   || '').trim(),
            tags:        (document.getElementById('kbEntryTags')?.value   || '').trim(),
            linkedTo:    document.getElementById('kbEntryLink')?.value    || '',
            content:     _kbActiveTab === 'text'
                            ? (document.getElementById('kbEntryContent')?.value || '').trim()
                            : '',
            file:        fileData,
            subSections: Object.keys(subs).length ? subs : null,
            updatedAt:   new Date().toISOString()
        };

        // ── 4. Save to Realtime DB ──
        if (btn) { btn.textContent = '⏳ Saving...'; }
        clearProgressBar();

        if (_kbEditKey) {
            await update(ref(db, `isi_v6/knowledge/entries/${_kbEditKey}`), entry);
        } else {
            entry.createdAt = new Date().toISOString();
            await _fbPush(ref(db, 'isi_v6/knowledge/entries'), entry);
        }

        resetSaveBtn('✅ Saved!', false);
        setTimeout(() => closeKBModal(), 700);

    } catch(err) {
        console.error('saveKBEntry:', err);
        resetSaveBtn('❌ ' + err.message.slice(0, 35), true);
        setTimeout(() => resetSaveBtn('💾 SAVE TO FIREBASE', false), 3500);
    }
};

// ── Render list ──
function renderKBList() {
    const container = document.getElementById('kbSettingsList');
    if (!container) return;

    let entries = Object.entries(_kbEntries);
    if (_kbActiveCat !== 'ALL') entries = entries.filter(([,e]) => e.type === _kbActiveCat);
    entries.sort((a,b) => (b[1].createdAt||'').localeCompare(a[1].createdAt||''));

    if (!entries.length) {
        container.innerHTML = `<div style="text-align:center;padding:24px;color:#333;font-size:0.72rem;border:1px dashed #1a1a1a;border-radius:6px;">
            Koi entry nahi. "+ ADD ENTRY" se shuru karo.</div>`;
        return;
    }

    const typeCols  = {SOP:'#4a9eff',Checklist:'#00c805',Notes:'var(--gold)',Training:'#cc44ff',Structure:'#ff5252'};
    const typeIcons = {SOP:'📘',Checklist:'✅',Notes:'📝',Training:'🎓',Structure:'📊'};

    container.innerHTML = entries.map(([key,e]) => {
        const col      = typeCols[e.type]  || '#888';
        const ico      = typeIcons[e.type] || '📁';
        const children = Object.entries(_kbEntries).filter(([,en]) => en.linkedTo === key);
        const hasFile  = !!(e.file?.url);
        const hasSubs  = e.subSections && Object.keys(e.subSections).length > 0;

        return `
        <div style="background:#0a0a0a;border:1px solid #1a1a1a;border-left:4px solid ${col};border-radius:6px;margin-bottom:8px;overflow:hidden;">
            <div style="display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:pointer;" onclick="toggleKBCard('kbc_${key}')">
                <span>${ico}</span>
                <span style="font-size:0.5rem;border:1px solid ${col};color:${col};padding:1px 5px;border-radius:3px;font-weight:bold;text-transform:uppercase;">${e.type}</span>
                <span style="flex:1;font-size:0.75rem;font-weight:bold;color:#ddd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${e.title}</span>
                ${hasFile  ? '<span style="font-size:0.5rem;background:#001a10;color:#00c805;border:1px solid #003a1a;padding:1px 5px;border-radius:3px;">📎 FILE</span>' : ''}
                ${hasSubs  ? `<span style="font-size:0.5rem;background:#0a0800;color:var(--gold);border:1px solid #2a1a00;padding:1px 5px;border-radius:3px;">${Object.keys(e.subSections).length} SUBS</span>` : ''}
                <span style="font-size:0.58rem;color:#333;">${e.createdAt ? new Date(e.createdAt).toLocaleDateString('en-GB') : ''}</span>
                <div style="display:flex;gap:4px;flex-shrink:0;" onclick="event.stopPropagation()">
                    <button onclick="openKBInPage('${key}')" style="background:transparent;border:1px solid #222;color:#555;padding:3px 8px;border-radius:3px;font-size:0.6rem;cursor:pointer;" onmouseover="this.style.borderColor='#4a9eff';this.style.color='#4a9eff'" onmouseout="this.style.borderColor='#222';this.style.color='#555'">VIEW</button>
                    <button onclick="openKBEditEntry('${key}')" style="background:transparent;border:1px solid #222;color:#555;padding:3px 8px;border-radius:3px;font-size:0.6rem;cursor:pointer;" onmouseover="this.style.borderColor='var(--gold)';this.style.color='var(--gold)'" onmouseout="this.style.borderColor='#222';this.style.color='#555'">EDIT</button>
                    <button onclick="deleteKBEntry('${key}')" style="background:transparent;border:1px solid #222;color:#555;padding:3px 8px;border-radius:3px;font-size:0.6rem;cursor:pointer;" onmouseover="this.style.borderColor='var(--danger)';this.style.color='var(--danger)'" onmouseout="this.style.borderColor='#222';this.style.color='#555'">🗑</button>
                </div>
            </div>
            <div id="kbc_${key}" style="display:none;padding:10px 12px;border-top:1px solid #0d0d0d;background:#050505;font-size:0.68rem;color:#555;line-height:1.6;">
                ${e.desc ? `<div style="margin-bottom:6px;color:#666;">${e.desc}</div>` : ''}
                ${e.content ? `<div style="max-height:50px;overflow:hidden;">${e.content.slice(0,160)}...</div>` : ''}
                ${children.length ? `
                <div style="margin-top:8px;padding-top:6px;border-top:1px solid #0a0a0a;">
                    <div style="font-size:0.53rem;color:#333;letter-spacing:1px;margin-bottom:4px;">🔗 LINKED</div>
                    ${children.map(([ck,ce]) => `<span onclick="openKBInPage('${ck}')" style="display:inline-flex;align-items:center;gap:4px;background:#0a0a0a;border:1px solid #1a1a1a;padding:2px 7px;border-radius:3px;font-size:0.6rem;color:#555;cursor:pointer;margin:2px;">${typeIcons[ce.type]||'📁'} ${ce.title}</span>`).join('')}
                </div>` : ''}
            </div>
        </div>`;
    }).join('');
}

window.toggleKBCard = function(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
};

window.openKBInPage = function(key) {
    window.open('knowledge.html#' + key, '_blank');
};

function updateKBStats() {
    const all = Object.values(_kbEntries);
    const el  = document.getElementById('kbSettingsStats');
    if (!el) return;
    const c   = t => all.filter(e => e.type === t).length;
    el.textContent = `Total: ${all.length}  ·  SOP: ${c('SOP')}  ·  Checklist: ${c('Checklist')}  ·  Notes: ${c('Notes')}  ·  Training: ${c('Training')}`;
}

function buildKBLinkDropdown() {
    const sel = document.getElementById('kbEntryLink');
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">— No parent link —</option>';
    Object.entries(_kbEntries).forEach(([k,e]) => {
        if (k === _kbEditKey) return;
        const opt = document.createElement('option');
        opt.value = k;
        opt.textContent = `[${e.type}] ${e.title}`;
        sel.appendChild(opt);
    });
    if (cur) sel.value = cur;
}

// ── Open add modal ──
window.openKBAddEntry = function() {
    _kbEditKey = null;
    _kbFileData = null;
    _kbSubCount = 0;
    _kbSubFiles.clear();

    document.getElementById('kbModalHeading').textContent = 'ADD NEW ENTRY';
    ['kbEntryTitle','kbEntryDesc','kbEntryContent','kbEntryTags'].forEach(id => {
        const el = document.getElementById(id); if (el) el.value = '';
    });
    document.getElementById('kbEntryType').value = (_kbActiveCat !== 'ALL') ? _kbActiveCat : 'SOP';
    document.getElementById('kbSubSections').innerHTML = '';
    clearKBFile();
    buildKBLinkDropdown();
    switchKBTab('upload');
    resetSaveBtn('💾 SAVE TO FIREBASE', false);
    clearProgressBar();

    document.getElementById('kbAddModal').style.display = 'flex';
    setTimeout(() => document.getElementById('kbEntryTitle')?.focus(), 100);
};

// ── Open edit modal ──
window.openKBEditEntry = function(key) {
    const e = _kbEntries[key]; if (!e) return;
    _kbEditKey = key;
    _kbFileData = null;
    _kbSubCount = 0;
    _kbSubFiles.clear();

    document.getElementById('kbModalHeading').textContent = 'EDIT ENTRY';
    document.getElementById('kbEntryTitle').value   = e.title   || '';
    document.getElementById('kbEntryDesc').value    = e.desc    || '';
    document.getElementById('kbEntryContent').value = e.content || '';
    document.getElementById('kbEntryTags').value    = e.tags    || '';
    document.getElementById('kbEntryType').value    = e.type    || 'SOP';
    document.getElementById('kbSubSections').innerHTML = '';

    buildKBLinkDropdown();
    document.getElementById('kbEntryLink').value = e.linkedTo || '';

    if (e.file?.url) {
        _kbFileData = e.file; // existing url — no raw File
        switchKBTab('upload');
        document.getElementById('kbFilePreview').style.display = 'block';
        document.getElementById('kbDropZone').style.display    = 'none';
        document.getElementById('kbFileIcon').textContent = getFileIcon(e.file.ext || '');
        document.getElementById('kbFileName').textContent = e.file.name || 'File';
        document.getElementById('kbFileSize').textContent = ((e.file.size || 0) / 1024 / 1024).toFixed(2) + ' MB';
    } else if (e.content) {
        switchKBTab('text');
    } else {
        switchKBTab('upload');
    }

    resetSaveBtn('💾 SAVE TO FIREBASE', false);
    clearProgressBar();
    document.getElementById('kbAddModal').style.display = 'flex';
};

// ── Close modal ──
window.closeKBModal = function() {
    document.getElementById('kbAddModal').style.display = 'none';
    _kbEditKey  = null;
    _kbFileData = null;
    _kbSubFiles.clear();
    _kbSubCount = 0;
    clearProgressBar();
    resetSaveBtn('💾 SAVE TO FIREBASE', false);
};

// ── Delete with math captcha ──
window.deleteKBEntry = function(key) {
    const e = _kbEntries[key]; if (!e) return;
    const ops = ['+','-','×'];
    const op  = ops[Math.floor(Math.random() * 3)];
    let a = Math.floor(Math.random() * 10) + 1;
    let b = Math.floor(Math.random() * 10) + 1;
    if (op === '-' && b > a) [a, b] = [b, a];
    const ans = op === '+' ? a+b : op === '-' ? a-b : a*b;
    const userAns = prompt(`⚠ DELETE "${e.title}"?\n\nSolve to confirm: ${a} ${op} ${b} = ?`);
    if (userAns === null) return;
    if (parseInt(userAns) !== ans) { alert('❌ Wrong answer! Delete cancelled.'); return; }
    remove(ref(db, `isi_v6/knowledge/entries/${key}`));
};

// ── Init ──
document.addEventListener('DOMContentLoaded', () => {
    buildAIDropdown();
});

// ══════════════════════════════════════════════════════════════════
// CAPITAL TRANSACTION — DEPOSIT / WITHDRAWAL
// Path: isi_v6/transactions/{clusterId}/{nodeIdx}/{pushKey}
// Balance update: isi_v6/stats/{clusterId}/{nodeIdx}/currentBal
// ══════════════════════════════════════════════════════════════════

let _txType = 'DEPOSIT'; // default

// Populate cluster dropdown for transaction section
function populateTxClusters() {
    const sel = document.getElementById('txClusterSel');
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = '<option value="">— Cluster Select Karo —</option>';
    Object.entries(clusters).forEach(([id, c]) => {
        const o = document.createElement('option');
        o.value = id; o.textContent = c.title;
        sel.appendChild(o);
    });
    if (current && clusters[current]) sel.value = current;
}

window.onTxClusterChange = function() {
    const cId = document.getElementById('txClusterSel').value;
    const accSel = document.getElementById('txAccountSel');
    accSel.innerHTML = '<option value="">— Account Chuno —</option>';
    if (!cId) { accSel.disabled = true; accSel.style.opacity = '0.5'; return; }
    const nodes = clusters[cId]?.nodes || [];
    nodes.forEach((n, i) => {
        const o = document.createElement('option');
        const s = (liveStatsCache[cId]?.[String(i)]) || {};
        const bal = s.currentBal ?? n.balance ?? 0;
        o.value = i;
        o.textContent = `${n.title || 'Account '+(i+1)}  [${n.curr || '$'}${bal.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}]`;
        accSel.appendChild(o);
    });
    accSel.disabled = false;
    accSel.style.opacity = '1';
};

window.setTxType = function(type) {
    _txType = type;
    const dBtn = document.getElementById('txTypeDeposit');
    const wBtn = document.getElementById('txTypeWithdraw');
    if (type === 'DEPOSIT') {
        dBtn.style.cssText = 'flex:1;padding:8px;border-radius:4px;font-size:0.7rem;font-weight:bold;cursor:pointer;border:2px solid var(--accent);background:#001a00;color:var(--accent);letter-spacing:1px;';
        wBtn.style.cssText = 'flex:1;padding:8px;border-radius:4px;font-size:0.7rem;font-weight:bold;cursor:pointer;border:1px solid #333;background:#111;color:#555;letter-spacing:1px;';
    } else {
        wBtn.style.cssText = 'flex:1;padding:8px;border-radius:4px;font-size:0.7rem;font-weight:bold;cursor:pointer;border:2px solid var(--danger);background:#1a0000;color:var(--danger);letter-spacing:1px;';
        dBtn.style.cssText = 'flex:1;padding:8px;border-radius:4px;font-size:0.7rem;font-weight:bold;cursor:pointer;border:1px solid #333;background:#111;color:#555;letter-spacing:1px;';
    }
};

// Stats live listener for transaction section
onValue(ref(db, 'isi_v6/stats'), snap => {
    liveStatsCache = snap.val() || {};
    populateTxClusters();
});
// Note: clusters onValue is set at line 430 — populateTxClusters also called from there

window.submitTransaction = async function() {
    const cId    = document.getElementById('txClusterSel').value;
    const nIdx   = document.getElementById('txAccountSel').value;
    const amount = parseFloat(document.getElementById('txAmount').value);
    const date   = document.getElementById('txDate').value;
    const note   = document.getElementById('txNote').value.trim();
    const pass   = document.getElementById('txPassword').value;
    const btn    = document.getElementById('txSubmitBtn');

    // Validations
    if (!cId)              return showTxToast('❌ Cluster select karo', 'error');
    if (nIdx === '')       return showTxToast('❌ Account select karo', 'error');
    if (!amount || amount <= 0) return showTxToast('❌ Valid amount daalo', 'error');
    if (!date)             return showTxToast('❌ Date select karo', 'error');

    // Password check
    const clusterPass = clusters[cId]?.resetKey || '';
    if (!clusterPass)  return showTxToast('❌ Cluster password not found', 'error');
    if (pass !== clusterPass) return showTxToast('❌ Wrong password!', 'error');

    const node = clusters[cId]?.nodes[parseInt(nIdx)];
    if (!node) return showTxToast('❌ Account not found', 'error');

    btn.disabled = true;
    btn.textContent = '⏳ Saving...';

    try {
        // 1. Get current live balance
        const statsSnap = await get(ref(db, `isi_v6/stats/${cId}/${String(nIdx)}`));
        const stats = statsSnap.val() || {};
        const oldBal = stats.currentBal ?? node.balance ?? 0;

        // 2. Calculate new balance
        const signedAmt = _txType === 'DEPOSIT' ? Math.abs(amount) : -Math.abs(amount);
        const newBal = oldBal + signedAmt;

        // 3. Save transaction record
        const txRecord = {
            type:      _txType,
            amount:    signedAmt,
            absAmount: Math.abs(amount),
            date:      date,
            note:      note || '',
            balBefore: oldBal,
            balAfter:  newBal,
            currency:  node.curr || '$',
            nodeTitle: node.title || 'Account ' + (parseInt(nIdx)+1),
            clusterTitle: clusters[cId]?.title || cId,
            savedAt:   new Date().toISOString()
        };
        await _fbPush(ref(db, `isi_v6/transactions/${cId}/${String(nIdx)}`), txRecord);

        // 4. Update live balance in stats path
        await update(ref(db, `isi_v6/stats/${cId}/${String(nIdx)}`), {
            currentBal: newBal
        });

        // 5. Success popup
        showTxToast(
            `✅ ${_txType === 'DEPOSIT' ? 'Deposit' : 'Withdrawal'} Successful!\n${node.curr || '$'}${Math.abs(amount).toLocaleString('en-US',{minimumFractionDigits:2})} → New Balance: ${node.curr || '$'}${newBal.toLocaleString('en-US',{minimumFractionDigits:2})}`,
            'success'
        );

        // Reset form
        document.getElementById('txAmount').value   = '';
        document.getElementById('txNote').value     = '';
        document.getElementById('txPassword').value = '';

    } catch(e) {
        showTxToast('❌ Error: ' + e.message, 'error');
    }

    btn.disabled = false;
    btn.textContent = '💰 SUBMIT TRANSACTION';
};

function showTxToast(msg, type = 'success') {
    // Remove existing toast
    document.getElementById('txToastEl')?.remove();

    const isSuccess = type === 'success';
    const bg  = isSuccess ? '#001a00' : '#1a0000';
    const bc  = isSuccess ? '#00c805' : '#ff3b3b';
    const col = isSuccess ? '#00c805' : '#ff5252';

    const toast = document.createElement('div');
    toast.id = 'txToastEl';
    toast.style.cssText = `
        position:fixed; bottom:24px; right:24px; z-index:99999;
        background:${bg}; border:1.5px solid ${bc}; color:${col};
        padding:14px 20px; border-radius:8px; font-size:0.78rem;
        font-weight:bold; max-width:340px; line-height:1.6;
        box-shadow: 0 4px 24px rgba(0,0,0,0.7);
        white-space: pre-line;
        animation: txFadeIn 0.3s ease;
    `;
    toast.textContent = msg;

    // Add animation keyframe once
    if (!document.getElementById('txToastStyle')) {
        const st = document.createElement('style');
        st.id = 'txToastStyle';
        st.textContent = '@keyframes txFadeIn { from{opacity:0;transform:translateY(12px)} to{opacity:1;transform:translateY(0)} }';
        document.head.appendChild(st);
    }

    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), isSuccess ? 5000 : 4000);
}

// Set today's date on load
document.addEventListener('DOMContentLoaded', () => {
    const txDateEl = document.getElementById('txDate');
    if (txDateEl) txDateEl.value = new Date().toISOString().slice(0,10);
    setTxType('DEPOSIT');
});

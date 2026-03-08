import { initializeApp }   from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getDatabase, ref, onValue, remove } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";
import { getStorage, ref as sRef, deleteObject } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js";

const firebaseConfig = {
    apiKey: "AIzaSyBhVpnVtlLMy0laY8U5A5Y8lLY9s3swjkE",
    authDomain: "trading-terminal-b8006.firebaseapp.com",
    projectId: "trading-terminal-b8006",
    storageBucket: "trading-terminal-b8006.firebasestorage.app",
    messagingSenderId: "690730161822",
    appId: "1:690730161822:web:81dabfd7b4575e86860d8f",
    databaseURL: "https://trading-terminal-b8006-default-rtdb.firebaseio.com"
};
const app     = initializeApp(firebaseConfig);
const db      = getDatabase(app);
const storage = getStorage(app);

// ── STATE ──
let allEntries    = {};
let allCustomCats = {};
let activeCat     = 'ALL';
let activeEntry   = null; // currently open in reader

const TYPE_COLS  = {SOP:'#4a9eff',Checklist:'#00c805',Notes:'#c5a059',Training:'#cc44ff',Structure:'#ff5252'};
const TYPE_ICONS = {SOP:'📘',Checklist:'✅',Notes:'📝',Training:'🎓',Structure:'📊'};

// ── FIREBASE LISTENERS ──
onValue(ref(db, 'isi_v6/knowledge/entries'), snap => {
    allEntries = snap.val() || {};
    renderSidebar();
    renderCards();
    updateStats();
    checkHash();
});

onValue(ref(db, 'isi_v6/knowledge/categories'), snap => {
    allCustomCats = snap.val() || {};
    renderSidebar();
});

// ── HASH: direct entry open from Settings "VIEW" ──
function checkHash() {
    const hash = location.hash.replace('#','');
    if (hash && allEntries[hash]) {
        openReader(hash);
        location.hash = '';
    }
}

// ── SIDEBAR ──
function renderSidebar() {
    const counts = { ALL: Object.keys(allEntries).length };
    Object.values(allEntries).forEach(e => {
        counts[e.type] = (counts[e.type] || 0) + 1;
    });

    ['ALL','SOP','Checklist','Notes','Training','Structure'].forEach(k => {
        const el = document.getElementById('c_' + k);
        if (el) el.textContent = counts[k] || 0;
    });

    // Highlight active
    document.querySelectorAll('.sb-item').forEach(el => el.classList.remove('active'));
    const active = document.querySelector(`.sb-item[onclick="setCat('${activeCat}')"]`);
    if (active) active.classList.add('active');

    // Custom categories
    const customDiv = document.getElementById('sbCustom');
    if (!customDiv) return;
    customDiv.innerHTML = Object.entries(allCustomCats).map(([k, c]) => {
        const cnt = Object.values(allEntries).filter(e => e.type === k).length;
        return `<div class="sb-item ${activeCat===k?'active':''}" onclick="setCat('${k}')">
            <span>${c.icon||'📁'}</span><span style="flex:1">${c.label}</span>
            <span class="sb-cnt">${cnt}</span>
        </div>`;
    }).join('');
}

window.setCat = function(key) {
    activeCat = key;
    document.getElementById('kbSearch').value = '';

    const DEF = {ALL:'All Entries',SOP:'SOP',Checklist:'Checklist',Notes:'Notes',Training:'Training',Structure:'Structure'};
    const custom = allCustomCats[key];
    const name = DEF[key] || custom?.label || key;
    document.getElementById('catTitle').textContent = name.toUpperCase();
    document.getElementById('catSub').textContent =
        key === 'ALL'
            ? 'Sabhi categories · ' + Object.keys(allEntries).length + ' entries'
            : Object.values(allEntries).filter(e=>e.type===key).length + ' entries';

    renderSidebar();
    renderCards();
};

// ── STATS ──
function updateStats() {
    const all = Object.values(allEntries);
    document.getElementById('s_total').textContent = all.length;
    document.getElementById('s_sop').textContent   = all.filter(e=>e.type==='SOP').length;
    document.getElementById('s_chk').textContent   = all.filter(e=>e.type==='Checklist').length;
    document.getElementById('s_nt').textContent    = all.filter(e=>e.type==='Notes').length;
    document.getElementById('s_tr').textContent    = all.filter(e=>e.type==='Training').length;
}

// ── RENDER CARDS ──
window.renderCards = function() {
    const search = (document.getElementById('kbSearch')?.value || '').toLowerCase();
    const container = document.getElementById('kbCards');
    if (!container) return;

    let entries = Object.entries(allEntries);
    if (activeCat !== 'ALL') entries = entries.filter(([,e]) => e.type === activeCat);
    if (search) entries = entries.filter(([,e]) =>
        (e.title||'').toLowerCase().includes(search) ||
        (e.content||'').toLowerCase().includes(search) ||
        (e.tags||'').toLowerCase().includes(search)
    );
    entries.sort((a,b) => (b[1].createdAt||'').localeCompare(a[1].createdAt||''));

    if (!entries.length) {
        container.innerHTML = `<div class="kb-empty">
            <div style="font-size:1.8rem;margin-bottom:8px;">${search?'🔍':'📄'}</div>
            ${search ? `No results for "${search}"` : 'Koi entry nahi. Settings mein jaake add karo.'}
        </div>`;
        return;
    }

    container.innerHTML = entries.map(([key, e]) => {
        const col  = TYPE_COLS[e.type]  || '#888';
        const icon = TYPE_ICONS[e.type] || '📁';
        const tc   = ['SOP','Checklist','Notes','Training','Structure'].includes(e.type) ? 'tp-'+e.type : 'tp-Custom';
        const hasFile = !!(e.file?.url);
        const subCount = e.subSections ? Object.keys(e.subSections).length : 0;
        const children = Object.entries(allEntries).filter(([,en]) => en.linkedTo === key);
        const date = e.createdAt ? new Date(e.createdAt).toLocaleDateString('en-GB') : '';

        return `
        <div class="kcard" id="kc_${key}" style="border-left:4px solid ${col};">
            <div class="kcard-head" onclick="toggleCard('${key}')">
                <span>${icon}</span>
                <span class="type-pill ${tc}">${e.type}</span>
                <span class="kcard-title">${e.title}</span>
                ${hasFile  ? `<span class="fbadge">📎 FILE</span>` : ''}
                ${subCount ? `<span class="sbadge">${subCount} SUBS</span>` : ''}
                <span class="kcard-date">${date}</span>
                <div class="kbtns" onclick="event.stopPropagation()">
                    <button class="kbtn v" onclick="openReader('${key}')">👁 VIEW</button>
                    <button class="kbtn d" onclick="openDelete('${key}')">🗑</button>
                </div>
            </div>

            <div class="kcard-body" id="kb_${key}">
                ${e.desc ? `<div style="padding:10px 13px;font-size:0.7rem;color:#555;border-bottom:1px solid #0a0a0a;">${e.desc}</div>` : ''}
                ${e.content ? `<div style="padding:10px 13px;font-size:0.7rem;color:#444;line-height:1.6;max-height:70px;overflow:hidden;">${e.content.slice(0,200)}${e.content.length>200?'...':''}</div>` : ''}
                ${hasFile ? `<div style="padding:8px 13px;display:flex;align-items:center;gap:8px;border-bottom:1px solid #0a0a0a;">
                    <span style="font-size:0.65rem;">${getFileIcon(e.file.ext||'')}</span>
                    <span style="font-size:0.65rem;color:#555;">${e.file.name}</span>
                    <a href="${e.file.url}" target="_blank" style="font-size:0.6rem;color:var(--gold);border:1px solid var(--gold);padding:2px 7px;border-radius:3px;text-decoration:none;margin-left:auto;">Open ↗</a>
                </div>` : ''}
                ${e.tags ? `<div style="padding:7px 13px;border-bottom:1px solid #0a0a0a;">
                    ${e.tags.split(',').map(t=>`<span style="background:#0d0d0d;border:1px solid #1a1a1a;color:#333;padding:2px 6px;border-radius:3px;font-size:0.55rem;margin:2px;display:inline-block;">${t.trim()}</span>`).join('')}
                </div>` : ''}
                ${children.length ? `
                <div class="linked-row">
                    <div class="linked-lbl">🔗 LINKED ENTRIES</div>
                    ${children.map(([ck,ce])=>`
                    <span class="lchip" onclick="openReader('${ck}')">
                        <span class="type-pill ${['SOP','Checklist','Notes','Training','Structure'].includes(ce.type)?'tp-'+ce.type:'tp-Custom'}" style="font-size:0.45rem;padding:1px 4px;">${ce.type}</span>
                        ${ce.title}
                    </span>`).join('')}
                </div>` : ''}
                <div style="padding:8px 13px;">
                    <button class="kbtn v" onclick="openReader('${key}')" style="font-size:0.63rem;padding:5px 12px;">📖 Read Full Entry</button>
                </div>
            </div>
        </div>`;
    }).join('');
};

window.toggleCard = function(key) {
    const el = document.getElementById('kb_'+key);
    if (el) el.classList.toggle('open');
};

// ── READER VIEW ──
window.openReader = function(key) {
    const e = allEntries[key];
    if (!e) return;
    activeEntry = { ...e, _key: key };

    const tc = ['SOP','Checklist','Notes','Training','Structure'].includes(e.type) ? 'tp-'+e.type : 'tp-Custom';
    const pill = document.getElementById('rPill');
    pill.textContent = e.type;
    pill.className = 'type-pill ' + tc;

    // Show/hide original download button
    const btnOrig = document.getElementById('btnOrig');
    if (btnOrig) btnOrig.style.display = e.file?.url ? 'inline-block' : 'none';

    // Build reader body
    const date = e.createdAt ? new Date(e.createdAt).toLocaleDateString('en-GB', {day:'2-digit',month:'short',year:'numeric'}) : '';
    let html = `
        <div class="reader-title">${e.title}</div>
        <div class="reader-meta">
            <span>${e.type}</span>
            ${date ? `<span>Added: ${date}</span>` : ''}
            ${e.tags  ? `<span>🏷 ${e.tags}</span>` : ''}
        </div>
        ${e.desc ? `<div class="reader-desc">${e.desc}</div>` : ''}`;

    // Main file viewer
    if (e.file?.url) {
        html += buildFileViewer(e.file, 'main');
    }

    // Text content
    if (e.content) {
        html += `<div style="margin-bottom:20px;">
            <div style="font-size:0.58rem;color:#3a3a3a;letter-spacing:2px;margin-bottom:10px;text-transform:uppercase;">Content</div>
            <div class="reader-text">${e.content}</div>
        </div>`;
    }

    // Sub-sections
    if (e.subSections) {
        html += `<div style="height:1px;background:#111;margin:20px 0;"></div>
            <div style="font-size:0.58rem;color:#3a3a3a;letter-spacing:2px;margin-bottom:12px;text-transform:uppercase;">Sub-Sections</div>`;
        Object.entries(e.subSections).forEach(([sk, sub], i) => {
            if (!sub.title && !sub.text && !sub.file?.url) return;
            html += `<div class="sub-card">
                <div class="sub-head" onclick="toggleSub('sub_${i}')">
                    <span>${sub.title || 'Sub-Section ' + (i+1)}</span>
                    <span style="font-size:0.65rem;color:#555;">▼</span>
                </div>
                <div class="sub-body" id="sub_${i}">
                    ${sub.file?.url ? buildFileViewer(sub.file, 'sub_'+i) : ''}
                    ${sub.text ? `<div class="reader-text" style="margin-top:${sub.file?.url?'12px':'0'}">${sub.text}</div>` : ''}
                </div>
            </div>`;
        });
    }

    // Linked children
    const children = Object.entries(allEntries).filter(([,en]) => en.linkedTo === key);
    if (children.length) {
        html += `<div style="height:1px;background:#111;margin:20px 0;"></div>
            <div style="font-size:0.58rem;color:#3a3a3a;letter-spacing:2px;margin-bottom:10px;text-transform:uppercase;">🔗 Linked Entries</div>
            <div style="display:flex;flex-wrap:wrap;gap:8px;">
            ${children.map(([ck,ce]) => `
            <span class="lchip" onclick="openReader('${ck}')">
                <span class="type-pill ${['SOP','Checklist','Notes','Training','Structure'].includes(ce.type)?'tp-'+ce.type:'tp-Custom'}" style="font-size:0.45rem;padding:1px 4px;">${ce.type}</span>
                ${ce.title}
            </span>`).join('')}
            </div>`;
    }

    // Download row
    html += `<div class="dl-row">
        ${e.file?.url ? `<button onclick="dlOrig()" class="bdl bdl-orig">⬇ Original File</button>` : ''}
        <button onclick="dlTXT()"  class="bdl bdl-txt">⬇ Download TXT</button>
        <button onclick="dlPDF()"  class="bdl bdl-pdf">⬇ Download PDF</button>
    </div>`;

    document.getElementById('readerBody').innerHTML = html;
    document.getElementById('reader').classList.add('open');
    document.body.style.overflow = 'hidden';
};

window.closeReader = function() {
    document.getElementById('reader').classList.remove('open');
    document.body.style.overflow = '';
    activeEntry = null;
};

window.toggleSub = function(id) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('open');
};

// ── FILE VIEWER BUILDER ──
function buildFileViewer(file, id) {
    const ext  = (file.ext || file.name?.split('.').pop() || '').toLowerCase();
    const url  = file.url;
    const icon = getFileIcon(ext);
    const isImage = ['jpg','jpeg','png','gif','webp','svg','bmp'].includes(ext);
    const isPDF   = ext === 'pdf';
    const isText  = ['txt','md','csv','json','js','html','css','py'].includes(ext);

    let viewer = '';
    if (isPDF) {
        viewer = `<iframe src="${url}" style="width:100%;min-height:620px;border:none;background:#fff;"></iframe>`;
    } else if (isImage) {
        viewer = `<div style="padding:12px;text-align:center;"><img src="${url}" alt="${file.name}" style="max-width:100%;max-height:600px;border-radius:4px;"></div>`;
    } else if (isText) {
        viewer = `<div id="textView_${id}" style="padding:14px;font-size:0.72rem;color:#aaa;font-family:monospace;line-height:1.7;white-space:pre-wrap;max-height:500px;overflow-y:auto;background:#050505;">
            <div style="color:#444;font-style:italic;">Loading text...</div>
        </div>
        <script>
            fetch('${url}').then(r=>r.text()).then(t=>{
                const el=document.getElementById('textView_${id}');
                if(el)el.textContent=t;
            }).catch(()=>{});
        <\/script>`;
    } else {
        // Generic — show open button for Excel, Word, etc.
        viewer = `<div style="padding:24px;text-align:center;">
            <div style="font-size:2rem;margin-bottom:8px;">${icon}</div>
            <div style="font-size:0.75rem;color:#666;margin-bottom:14px;">${file.name}</div>
            <a href="${url}" target="_blank" download="${file.name}"
                style="background:var(--gold);color:#000;padding:9px 20px;border-radius:5px;text-decoration:none;font-weight:bold;font-size:0.73rem;letter-spacing:1px;">
                📥 Download & Open
            </a>
            <div style="margin-top:10px;font-size:0.6rem;color:#333;">Excel/Word files browser mein directly nahi khulte — download karo phir open karo</div>
        </div>`;
    }

    return `<div class="file-viewer" style="margin-bottom:16px;">
        <div class="file-viewer-head">
            <span style="font-size:1.1rem;">${icon}</span>
            <div style="flex:1;">
                <div style="font-size:0.72rem;font-weight:bold;color:#ccc;">${file.name}</div>
                <div style="font-size:0.58rem;color:#3a3a3a;">${ext.toUpperCase()} · ${((file.size||0)/1024/1024).toFixed(2)} MB</div>
            </div>
            <a href="${url}" target="_blank" style="font-size:0.6rem;color:var(--gold);border:1px solid var(--gold);padding:3px 8px;border-radius:3px;text-decoration:none;">Open ↗</a>
        </div>
        <div class="file-viewer">${viewer}</div>
    </div>`;
}

function getFileIcon(ext) {
    const m = {
        pdf:'📄', doc:'📝', docx:'📝', xls:'📊', xlsx:'📊',
        csv:'📊', ppt:'📊', pptx:'📊', txt:'📃', md:'📃',
        jpg:'🖼', jpeg:'🖼', png:'🖼', gif:'🖼', webp:'🖼', svg:'🖼',
        mp4:'🎬', mp3:'🎵', zip:'📦', rar:'📦', json:'⚙', js:'⚙', html:'🌐', py:'🐍'
    };
    return m[ext] || '📁';
}

// ── DOWNLOADS ──
window.dlOrig = function() {
    if (!activeEntry?.file?.url) return;
    const a = document.createElement('a');
    a.href = activeEntry.file.url;
    a.download = activeEntry.file.name;
    a.target = '_blank';
    a.click();
};

window.dlTXT = function() {
    if (!activeEntry) return;
    const e = activeEntry;
    let text = `${e.title}\n${'═'.repeat(Math.min(e.title.length, 60))}\n\n`;
    text += `Type: ${e.type}\n`;
    text += `Date: ${e.createdAt ? new Date(e.createdAt).toLocaleDateString() : '—'}\n`;
    if (e.tags)  text += `Tags: ${e.tags}\n`;
    if (e.desc)  text += `\nDescription:\n${e.desc}\n`;
    if (e.file?.name) text += `\nAttached File: ${e.file.name}\nFile URL: ${e.file.url}\n`;
    if (e.content) text += `\nContent:\n${e.content}`;
    if (e.subSections) {
        Object.entries(e.subSections).forEach(([,s], i) => {
            text += `\n\n── Sub-Section ${i+1}: ${s.title||''} ──\n`;
            if (s.file?.name) text += `File: ${s.file.name}\nURL: ${s.file.url}\n`;
            if (s.text) text += s.text;
        });
    }
    const blob = new Blob([text], { type:'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (e.title||'entry').replace(/[^a-z0-9]/gi,'_') + '.txt';
    a.click();
};

window.dlPDF = function() {
    if (!activeEntry) return;
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit:'mm', format:'a4' });
    const e   = activeEntry;
    const pageW = 210, m = 14, lw = pageW - m*2;
    let y = 20;

    // Gold header bar
    doc.setFillColor(197,160,89);
    doc.rect(0,0,210,10,'F');
    doc.setTextColor(0,0,0); doc.setFontSize(7); doc.setFont('helvetica','bold');
    doc.text('ISI TERMINAL · KNOWLEDGE BASE · INFLLAX', m, 7);

    // Type badge
    doc.setFillColor(20,20,20);
    doc.rect(m, y-4, 20, 6, 'F');
    doc.setTextColor(197,160,89); doc.setFontSize(7);
    doc.text(e.type||'', m+2, y);

    // Title
    y += 8;
    doc.setTextColor(197,160,89); doc.setFontSize(17); doc.setFont('helvetica','bold');
    const titleLines = doc.splitTextToSize(e.title||'Untitled', lw);
    doc.text(titleLines, m, y);
    y += titleLines.length * 7;

    // Meta
    doc.setTextColor(100,100,100); doc.setFontSize(9); doc.setFont('helvetica','normal');
    const metaStr = [
        e.createdAt ? new Date(e.createdAt).toLocaleDateString() : '',
        e.tags ? 'Tags: '+e.tags : ''
    ].filter(Boolean).join('   ·   ');
    doc.text(metaStr, m, y+=5);

    if (e.desc) {
        doc.setTextColor(150,150,150); doc.setFontSize(10);
        const dl = doc.splitTextToSize(e.desc, lw);
        dl.forEach(l => { if(y>270){doc.addPage();y=20;} doc.text(l, m, y+=6); });
    }

    // Divider
    doc.setDrawColor(40,40,40); doc.line(m, y+=6, pageW-m, y);

    // File info
    if (e.file?.url) {
        y+=2;
        doc.setFillColor(10,20,10);
        doc.rect(m, y, lw, 8, 'F');
        doc.setTextColor(0,200,5); doc.setFontSize(9);
        doc.text(`📎 Attached: ${e.file.name}`, m+3, y+5.5);
        y+=10;
    }

    // Content
    if (e.content) {
        doc.setTextColor(200,200,200); doc.setFontSize(10); doc.setFont('helvetica','normal');
        const lines = doc.splitTextToSize(e.content, lw);
        lines.forEach(l => {
            if (y>272){doc.addPage();y=20;}
            doc.text(l, m, y+=6);
        });
    }

    // Sub-sections
    if (e.subSections) {
        Object.entries(e.subSections).forEach(([,s], i) => {
            if (y>265){doc.addPage();y=20;}
            doc.setDrawColor(80,60,0); doc.line(m, y+=8, pageW-m, y);
            doc.setTextColor(197,160,89); doc.setFontSize(11); doc.setFont('helvetica','bold');
            doc.text(`Sub-Section ${i+1}: ${s.title||''}`, m, y+=6);
            if (s.file?.url) {
                doc.setTextColor(0,200,5); doc.setFontSize(9); doc.setFont('helvetica','normal');
                doc.text(`📎 File: ${s.file.name}`, m, y+=6);
            }
            if (s.text) {
                doc.setTextColor(180,180,180); doc.setFontSize(10);
                doc.splitTextToSize(s.text, lw).forEach(l => {
                    if(y>270){doc.addPage();y=20;}
                    doc.text(l, m, y+=6);
                });
            }
        });
    }

    // Footer
    doc.setFillColor(8,8,8);
    doc.rect(0,285,210,12,'F');
    doc.setTextColor(60,60,60); doc.setFontSize(7);
    doc.text('© 2025 INFLLAX · ISI TERMINAL KNOWLEDGE BASE · All Rights Reserved', m, 292);

    doc.save((e.title||'entry').replace(/[^a-z0-9]/gi,'_') + '.pdf');
};

// ── DELETE WITH MATH CAPTCHA ──
let _delTarget = null, _capAns = 0;

window.openDelete = function(key) {
    const e = allEntries[key]; if(!e) return;
    _delTarget = key;
    const ops=['+','-','×'];
    const op=ops[Math.floor(Math.random()*3)];
    let a=Math.floor(Math.random()*12)+1, b=Math.floor(Math.random()*12)+1;
    if(op==='-'&&b>a)[a,b]=[b,a];
    _capAns = op==='+'?a+b:op==='-'?a-b:a*b;
    document.getElementById('capQ').textContent = `${a} ${op} ${b} = ?`;
    document.getElementById('capLbl').textContent = `"${e.title}"`;
    document.getElementById('capAns').value = '';
    document.getElementById('capErr').textContent = '';
    document.getElementById('capOvl').classList.add('open');
    setTimeout(()=>document.getElementById('capAns').focus(),100);
};

window.closeCap = function() {
    document.getElementById('capOvl').classList.remove('open');
    _delTarget = null;
};

window.doDelete = async function() {
    const ans = parseInt(document.getElementById('capAns').value);
    const errEl = document.getElementById('capErr');
    if (isNaN(ans) || ans !== _capAns) {
        errEl.textContent = '❌ Galat answer! Try again.';
        document.getElementById('capAns').value = '';
        document.getElementById('capAns').style.borderColor = 'var(--danger)';
        setTimeout(()=>{ document.getElementById('capAns').style.borderColor='#333'; errEl.textContent=''; }, 1500);
        return;
    }
    const e = allEntries[_delTarget];
    // Delete files from Storage if present
    try {
        if (e?.file?.path) await deleteObject(sRef(storage, e.file.path));
        if (e?.subSections) {
            for (const s of Object.values(e.subSections)) {
                if (s.file?.path) await deleteObject(sRef(storage, s.file.path)).catch(()=>{});
            }
        }
    } catch(err) { console.warn('Storage delete:', err); }
    await remove(ref(db, `isi_v6/knowledge/entries/${_delTarget}`));
    closeCap();
};

// ESC key
document.addEventListener('keydown', ev => {
    if (ev.key==='Escape') {
        closeReader();
        closeCap();
    }
});

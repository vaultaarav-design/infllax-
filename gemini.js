// ============================================================
// ISI TERMINAL — MULTI-AI ENGINE v3.0
// 4 Providers: Gemini, Groq, OpenRouter, Cohere
// Auto-fallback: ek fail → agla try
// Keys: localStorage + hardcoded fallback
// ============================================================

const HARDCODED = {
    gemini:     'AIzaSyDoWQ7VQDtp6LBB-dBIOgSjva1GZR-Rk28',
    groq:       '',
    openrouter: '',
    cohere:     ''
};

function getKey(p) {
    return localStorage.getItem('isi_key_' + p) || HARDCODED[p] || '';
}

// ── ISI SYSTEM CONTEXT ──
const SYS = `Tu ISI Terminal ka AI trading coach hai. Institutional trading journal system.
Direct, concise, Hindi-English mixed mein baat kar. Max 220 words.
Kabhi false confidence mat de. Data incomplete ho toh bol.`;

// ── 4 PROVIDERS ──
const AI = {
    gemini: {
        label: 'Gemini 2.0 Flash', icon: '🟡', free: true,
        available: () => !!getKey('gemini'),
        call: async (prompt) => {
            const r = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${getKey('gemini')}`,
                { method:'POST', headers:{'Content-Type':'application/json'},
                  body: JSON.stringify({ contents:[{parts:[{text:prompt}]}],
                    generationConfig:{temperature:0.7,maxOutputTokens:500} }) }
            );
            if (!r.ok) { const e=await r.json().catch(()=>({})); throw new Error(`${r.status}:${e?.error?.message||'err'}`); }
            const d = await r.json();
            return d?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        }
    },

    groq: {
        label: 'Groq Llama 3.3 70B', icon: '🟢', free: true,
        available: () => !!getKey('groq'),
        call: async (prompt) => {
            const r = await fetch('https://api.groq.com/openai/v1/chat/completions',
                { method:'POST',
                  headers:{'Content-Type':'application/json','Authorization':'Bearer '+getKey('groq')},
                  body: JSON.stringify({ model:'llama-3.3-70b-versatile',
                    messages:[{role:'user',content:prompt}], max_tokens:500, temperature:0.7 }) }
            );
            if (!r.ok) { const e=await r.json().catch(()=>({})); throw new Error(`${r.status}:${e?.error?.message||'err'}`); }
            const d = await r.json();
            return d?.choices?.[0]?.message?.content || '';
        }
    },

    openrouter: {
        label: 'OpenRouter Mistral', icon: '🔵', free: true,
        available: () => !!getKey('openrouter'),
        call: async (prompt) => {
            const model = localStorage.getItem('isi_or_model') || 'mistralai/mistral-7b-instruct:free';
            const r = await fetch('https://openrouter.ai/api/v1/chat/completions',
                { method:'POST',
                  headers:{'Content-Type':'application/json','Authorization':'Bearer '+getKey('openrouter'),
                    'HTTP-Referer':location.origin,'X-Title':'ISI Terminal'},
                  body: JSON.stringify({ model, messages:[{role:'user',content:prompt}], max_tokens:500 }) }
            );
            if (!r.ok) { const e=await r.json().catch(()=>({})); throw new Error(`${r.status}:${e?.error?.message||'err'}`); }
            const d = await r.json();
            return d?.choices?.[0]?.message?.content || '';
        }
    },

    cohere: {
        label: 'Cohere Command', icon: '🟣', free: true,
        available: () => !!getKey('cohere'),
        call: async (prompt) => {
            const r = await fetch('https://api.cohere.ai/v1/generate',
                { method:'POST',
                  headers:{'Content-Type':'application/json','Authorization':'Bearer '+getKey('cohere')},
                  body: JSON.stringify({ model:'command', prompt, max_tokens:500, temperature:0.7 }) }
            );
            if (!r.ok) { const e=await r.json().catch(()=>({})); throw new Error(`${r.status}:${e?.error?.message||'err'}`); }
            const d = await r.json();
            return d?.generations?.[0]?.text || '';
        }
    }
};

// ── ACTIVE PROVIDER ──
function activeProvider() {
    const pref = localStorage.getItem('isi_ai_provider') || 'auto';
    if (pref !== 'auto' && AI[pref]?.available()) return pref;
    for (const p of ['groq','gemini','openrouter','cohere']) {
        if (AI[p].available()) return p;
    }
    return null;
}

// ── CORE CALL WITH AUTO FALLBACK ──
export async function callAI(prompt, boxId = null) {
    const pref = localStorage.getItem('isi_ai_provider') || 'auto';
    const order = pref !== 'auto' && AI[pref]?.available()
        ? [pref, ...['groq','gemini','openrouter','cohere'].filter(p=>p!==pref && AI[p].available())]
        : ['groq','gemini','openrouter','cohere'].filter(p => AI[p].available());

    if (!order.length) {
        return { error:true, text:'⚠ Koi AI key set nahi hai. Settings page pe jaake key add karo.' };
    }

    const full = SYS + '\n\n' + prompt;

    for (let i = 0; i < order.length; i++) {
        const pk = order[i];
        try {
            _showLoading(boxId, pk);
            const text = await AI[pk].call(full);
            if (!text.trim()) throw new Error('Empty');
            return { error:false, text:text.trim(), pk, label:AI[pk].label, icon:AI[pk].icon };
        } catch(err) {
            const isRate = err.message.includes('429') || err.message.toLowerCase().includes('rate');
            if (isRate && i < order.length-1) {
                // Rate limit — countdown then try next
                await _countdown(boxId, pk, order[i+1], 12);
                continue;
            } else if (isRate) {
                await _countdown(boxId, pk, null, 15);
                try {
                    const text = await AI[pk].call(full);
                    if (text.trim()) return { error:false, text:text.trim(), pk, label:AI[pk].label, icon:AI[pk].icon };
                } catch(e2) {}
            }
            console.warn(pk + ' failed:', err.message);
        }
    }

    return { error:true, text:'❌ Sab AI providers fail ho gaye. Keys check karo Settings mein.' };
}

function _showLoading(boxId, pk) {
    const el = boxId && document.getElementById(boxId);
    if (!el) return;
    el.style.display = 'block';
    el.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;padding:11px;background:#0a0a0a;border-radius:6px;border:1px solid #1a1a1a;">
            <div style="width:15px;height:15px;border:2px solid #c5a059;border-top-color:transparent;
                border-radius:50%;animation:spin .8s linear infinite;flex-shrink:0;"></div>
            <span style="color:#888;font-size:0.72rem;">
                ${AI[pk].icon} <b style="color:#c5a059;">${AI[pk].label}</b> analyzing...
            </span>
            <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
        </div>`;
}

async function _countdown(boxId, fromPk, nextPk, secs) {
    return new Promise(resolve => {
        const iv = setInterval(() => {
            secs--;
            const el = boxId && document.getElementById(boxId);
            if (el) el.innerHTML = `
                <div style="padding:10px;background:#1a0800;border:1px solid #ff6600;border-radius:6px;font-size:0.72rem;color:#ff9944;">
                    ⏳ ${AI[fromPk].icon} ${AI[fromPk].label} rate limit —
                    <b style="color:#ffcc00;">${secs}s</b>
                    ${nextPk ? `→ switching to ${AI[nextPk].icon} ${AI[nextPk].label}` : '· retrying...'}
                </div>`;
            if (secs <= 0) { clearInterval(iv); resolve(); }
        }, 1000);
    });
}

// ── SHOW LOADING (external) ──
export function showAILoading(boxId) {
    const p = activeProvider();
    _showLoading(boxId, p || 'gemini');
}

// ── RENDER RESPONSE ──
export function renderAIResponse(boxId, result, title='🤖 AI Analysis') {
    const el = boxId && document.getElementById(boxId);
    if (!el) return;
    el.style.display = 'block';

    if (result.error) {
        el.innerHTML = `<div style="padding:12px;background:#1a0000;border:1px solid #d32f2f;
            border-radius:6px;font-size:0.75rem;color:#ff5252;">${result.text}</div>`;
        return;
    }

    const fmt = result.text
        .replace(/\n\n/g,'<br><br>').replace(/\n/g,'<br>')
        .replace(/\*\*(.*?)\*\*/g,'<b>$1</b>').replace(/\*(.*?)\*/g,'<i>$1</i>');

    el.innerHTML = `
        <div style="background:#000;border:1px solid #1a2a00;border-left:4px solid #c5a059;border-radius:6px;padding:14px;margin-top:8px;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:9px;">
                <span style="font-size:0.6rem;color:#c5a059;letter-spacing:2px;font-weight:bold;text-transform:uppercase;">${title}</span>
                <span style="background:#111;border:1px solid #222;padding:2px 8px;border-radius:3px;font-size:0.58rem;color:#666;">
                    ${result.icon||'🤖'} ${result.label||'AI'}
                </span>
            </div>
            <div style="font-size:0.75rem;color:#ccc;line-height:1.8;">${fmt}</div>
        </div>`;
}

// ── NAMED ANALYSIS EXPORTS ──
export async function aiValidateSetup(d) {
    return callAI(`Pre-entry setup validate karo:\n
HTF: ${d.htf?.ms||'?'} | Zone: ${d.htf?.zone||'?'}
LTF: ${d.ltf?.ms||'?'} | Candle: ${d.ltf?.candle||'?'}
SMC: ${Object.keys(d.smm||{}).filter(k=>d.smm[k]).join(', ')||'None'}
Market: ${d.mstate||'?'} | Vol: ${d.volatility||'?'}
Direction: ${d.direction||'?'} | RR: ${d.rrPlanned||'?'}
Time: ${Math.floor((d.timerSecs||0)/60)}m | Readiness: ${Object.values(d.readiness||{}).filter(Boolean).length}/6
Score: ${d._score||0}/100
${d._conflict?'CONFLICT: '+d._conflict:'No conflict'}

1. Valid setup? (haan/nahi seedha)
2. Strongest confluence?
3. Biggest risk?
4. TRADE / WAIT / AVOID — kyun?`, 'aiValidateBox');
}

export async function aiMarketContext(htfMs,ltfMs,htfZone,mstate,vol,smc) {
    return callAI(`Market institutional analysis:\n
HTF: ${htfMs||'?'} Zone: ${htfZone||'?'} | LTF: ${ltfMs||'?'}
State: ${mstate||'?'} | Vol: ${vol||'?'} | SMC: ${smc||'None'}

1. Price institutional location?
2. Banks/institutions kya kar rahe hain?
3. Retail kahan phans raha hai?
4. Best entry scenario?`, 'aiMarketBox');
}

export async function aiTradeReview(t) {
    return callAI(`Post-trade review:\n
Asset: ${t.asset||'—'} | ${t.position||'—'} | ${t.type||'—'} | Grade: ${t.grade||'—'}
P/L: ${(t.pl||0)>=0?'+':''}${(t.pl||0).toFixed(2)}
HTF: ${t.htfMs||'—'} ${t.htfZone||''} | LTF: ${t.ltfMs||'—'} ${t.ltfCandle||''}
SMC: ${(t.smcFlags||[]).join(', ')||'None'} | Vios: ${(t.vios||[]).join(', ')||'None'}
Bias: ${t.biasResult||'—'}
${t.conflict?'Conflict: '+t.conflict.slice(0,80):''}

1. ${t.type==='Target'?'✅ Win':'❌ Loss'} — kyun?
2. Execution A/B/C grade aur kyun
3. Next trade ke liye 1 specific improvement
4. Violations ka impact`, 'aiTradeReviewBox');
}

export async function aiWeeklyCoach(s) {
    return callAI(`Weekly coaching:\n
Trades:${s.trades} W:${s.wins} L:${s.losses} WR:${s.winRate}% PL:${s.totalPL.toFixed(2)}
Violations: ${s.violations.slice(0,5).join(', ')||'None'}
Grades: ${JSON.stringify(s.grades)} | Best asset: ${s.assets[0]||'—'} | Best day: ${s.days[0]||'—'}

1. Performance summary
2. Best pattern — kab jeet raha hai
3. Worst pattern — kab haar raha hai
4. Top 3 next week action items
5. Mental/discipline note`, 'aiCoachBox');
}

// ── EXPORT PROVIDER INFO FOR SETTINGS PAGE ──
export { AI, activeProvider, getKey };

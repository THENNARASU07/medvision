import { useState, useEffect, useRef, useCallback } from "react";

/* ─────────────────────────────────────────────────────────────
   EXTERNAL LIBS (loaded from CDN via script injection)
   • jsPDF  — client-side PDF generation
   • SheetJS (xlsx) — client-side Excel generation
───────────────────────────────────────────────────────────── */
function loadScript(src, globalKey) {
  return new Promise((res, rej) => {
    if (window[globalKey]) { res(window[globalKey]); return; }
    const s = document.createElement("script");
    s.src = src; s.onload = () => res(window[globalKey]); s.onerror = rej;
    document.head.appendChild(s);
  });
}

/* ─────────────────────────────────────────────────────────────
   DATABASE LAYER  — window.storage (persistent across sessions)
   Mirrors SQL table: analysis_history
   Key format:  "ah:UUID"
   Index key:   "ah:index"  → sorted array of UUIDs newest-first
───────────────────────────────────────────────────────────── */
function uuidv4() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = Math.random()*16|0, v = c==="x"?r:(r&0x3|0x8);
    return v.toString(16);
  });
}

const DB = {
  // Insert one row — never blocks UI (fire-and-forget with error surfacing)
  async insert(row) {
    const id = uuidv4();
    const record = {
      id,
      created_at:        new Date().toISOString(),
      modality:          row.modality          || "",
      anatomy:           row.anatomy           || "",
      report_text:       row.report_text       || "",
      image_hash:        row.image_hash        || "",
      qa_score:          row.qa_score          ?? null,
      image_condition:   row.image_condition   || "",
      confidence:        row.confidence        ?? null,
      risk_level:        row.risk_level        || "",
      ai_response_json:  row.ai_response_json  || {},
      processing_time_ms:row.processing_time_ms?? 0,
      type:              row.type              || "text", // "text"|"image"|"combined"
    };
    try {
      await window.storage.set(`ah:${id}`, JSON.stringify(record));
      // Update index
      let idx = [];
      try { const r = await window.storage.get("ah:index"); if(r) idx=JSON.parse(r.value); } catch{}
      idx.unshift(id);
      await window.storage.set("ah:index", JSON.stringify(idx));
      return { ok: true, id };
    } catch(e) {
      console.warn("DB insert failed:", e);
      return { ok: false, error: e.message };
    }
  },

  // Fetch all records, newest first, with optional filters
  async query({ search="", modality="", abnormalOnly=false, page=1, limit=10 } = {}) {
    try {
      let idx = [];
      try { const r = await window.storage.get("ah:index"); if(r) idx=JSON.parse(r.value); } catch{}
      const records = [];
      for (const id of idx) {
        try {
          const r = await window.storage.get(`ah:${id}`);
          if (r) records.push(JSON.parse(r.value));
        } catch{}
      }
      let filtered = records;
      if (search) {
        const q = search.toLowerCase();
        filtered = filtered.filter(r =>
          r.modality.toLowerCase().includes(q) ||
          r.anatomy.toLowerCase().includes(q)  ||
          r.image_condition.toLowerCase().includes(q) ||
          r.report_text.toLowerCase().includes(q)
        );
      }
      if (modality && modality !== "All") filtered = filtered.filter(r => r.modality === modality);
      if (abnormalOnly) filtered = filtered.filter(r => r.risk_level === "High" || r.risk_level === "Moderate" || (r.qa_score !== null && r.qa_score < 65));
      const total = filtered.length;
      const pages = Math.max(1, Math.ceil(total / limit));
      const data  = filtered.slice((page-1)*limit, page*limit);
      return { ok: true, data, total, pages };
    } catch(e) {
      return { ok: false, data: [], total: 0, pages: 1, error: e.message };
    }
  },

  // Fetch one by id
  async get(id) {
    try {
      const r = await window.storage.get(`ah:${id}`);
      return r ? JSON.parse(r.value) : null;
    } catch { return null; }
  },

  // Stats for analytics
  async stats() {
    try {
      let idx = [];
      try { const r = await window.storage.get("ah:index"); if(r) idx=JSON.parse(r.value); } catch{}
      const records = [];
      for (const id of idx) {
        try { const r = await window.storage.get(`ah:${id}`); if(r) records.push(JSON.parse(r.value)); } catch{}
      }
      const total    = records.length;
      const withScore= records.filter(r=>r.qa_score!=null);
      const avgScore = withScore.length ? Math.round(withScore.reduce((a,r)=>a+r.qa_score,0)/withScore.length) : null;
      const abnormal = records.filter(r=>r.risk_level==="High"||r.risk_level==="Moderate"||(r.qa_score!=null&&r.qa_score<65));
      const abnormalRate = total ? Math.round(abnormal.length/total*100) : 0;
      const condCounts = {};
      records.filter(r=>r.image_condition).forEach(r=>{ condCounts[r.image_condition]=(condCounts[r.image_condition]||0)+1; });
      const topCondition = Object.entries(condCounts).sort((a,b)=>b[1]-a[1])[0]?.[0] || "—";
      return { total, avgScore, abnormalRate, topCondition };
    } catch { return { total:0, avgScore:null, abnormalRate:0, topCondition:"—" }; }
  },

  // Delete all (for testing)
  async clear() {
    try {
      let idx = [];
      try { const r = await window.storage.get("ah:index"); if(r) idx=JSON.parse(r.value); } catch{}
      for (const id of idx) { try { await window.storage.delete(`ah:${id}`); } catch{} }
      await window.storage.delete("ah:index");
      return true;
    } catch { return false; }
  }
};

/* ─────────────────────────────────────────────────────────────
   STYLES
───────────────────────────────────────────────────────────── */
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=JetBrains+Mono:wght@400;500&family=Inter:wght@300;400;500;600&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0F172A;--bg2:#0D1526;--card:#1E293B;--card2:#243047;
  --blue:#3B82F6;--blue2:#2563EB;--bglow:rgba(59,130,246,.25);
  --cyan:#06B6D4;--green:#10B981;--yellow:#F59E0B;--red:#EF4444;--purple:#8B5CF6;
  --tx:#E2E8F0;--tx2:#94A3B8;--tx3:#64748B;
  --br:rgba(59,130,246,.15);--br2:rgba(255,255,255,.06);--glass:rgba(30,41,59,.8);
}
html{scroll-behavior:smooth}
body{font-family:'Inter',sans-serif;background:var(--bg);color:var(--tx);min-height:100vh;overflow-x:hidden}
::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:var(--bg2)}
::-webkit-scrollbar-thumb{background:rgba(59,130,246,.3);border-radius:3px}

/* watermark */
.wm{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
    width:min(520px,70vw);height:auto;pointer-events:none;z-index:-1;
    opacity:0.05;filter:blur(2px);color:#3B82F6}

/* keyframes */
@keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}
@keyframes fadeIn{from{opacity:0}to{opacity:1}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes skel{0%{background-position:200% 0}100%{background-position:-200% 0}}
@keyframes scan{0%{top:-3px}100%{top:100%}}
@keyframes bpulse{0%,100%{border-color:rgba(59,130,246,.2)}50%{border-color:rgba(59,130,246,.75)}}
.fu{animation:fadeUp .4s ease forwards}.fi{animation:fadeIn .3s ease forwards}
.spin{animation:spin .85s linear infinite}

/* skeleton */
.sk{background:linear-gradient(90deg,var(--card) 25%,#243047 50%,var(--card) 75%);
    background-size:400% 100%;animation:skel 1.3s ease infinite;border-radius:7px}
.sk16{height:16px;margin-bottom:8px}.sk22{height:22px;margin-bottom:12px}
.skCircle{width:130px;height:130px;border-radius:50%}

/* cards */
.card{background:var(--card);border:1px solid var(--br2);border-radius:16px;position:relative;overflow:hidden}
.card::before{content:'';position:absolute;inset:0;background:linear-gradient(135deg,rgba(59,130,246,.022) 0%,transparent 55%);pointer-events:none}
.glowCard{border-color:rgba(59,130,246,.35)!important;box-shadow:0 0 26px rgba(59,130,246,.08)}

/* nav */
.nav{position:sticky;top:0;z-index:200;background:rgba(13,21,38,.9);backdrop-filter:blur(22px);
     border-bottom:1px solid var(--br);padding:0 28px;height:66px;display:flex;align-items:center;justify-content:space-between}
.logoTxt{font-family:'Syne',sans-serif;font-weight:800;font-size:20px;
         background:linear-gradient(128deg,#fff 0%,var(--blue) 100%);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.pill{background:rgba(59,130,246,.1);border:1px solid rgba(59,130,246,.22);border-radius:20px;
      padding:3px 11px;font-size:11px;color:var(--blue);font-weight:600;font-family:'JetBrains Mono',monospace}

/* tabs */
.tabs{display:flex;gap:3px;background:rgba(0,0,0,.35);border:1px solid var(--br2);border-radius:12px;padding:4px}
.tab{padding:9px 19px;border-radius:8px;font-size:13px;font-weight:500;cursor:pointer;border:none;
     transition:all .17s;display:flex;align-items:center;gap:7px;font-family:'Inter',sans-serif;white-space:nowrap}
.tabOn{background:linear-gradient(135deg,var(--blue2),var(--blue));color:#fff;box-shadow:0 0 16px rgba(59,130,246,.4)}
.tabOff{background:transparent;color:var(--tx2)}.tabOff:hover{background:rgba(59,130,246,.07);color:var(--tx)}

/* form */
select,textarea,input[type=text],input[type=email],input[type=password],input[type=tel]{
  background:rgba(0,0,0,.3);border:1px solid var(--br);border-radius:10px;color:var(--tx);
  font-family:'Inter',sans-serif;font-size:14px;padding:11px 14px;width:100%;outline:none;
  transition:border-color .17s,box-shadow .17s}
select:focus,textarea:focus,input:focus{border-color:var(--blue);box-shadow:0 0 0 3px rgba(59,130,246,.12)}
select option{background:#1E293B}
label{display:block;font-size:11px;font-weight:600;color:var(--tx3);margin-bottom:6px;
      text-transform:uppercase;letter-spacing:.07em}
textarea{resize:vertical;min-height:200px;line-height:1.75}

/* buttons */
.btn{border:none;border-radius:10px;font-family:'Inter',sans-serif;font-weight:600;cursor:pointer;
     transition:all .17s;display:inline-flex;align-items:center;gap:8px}
.btnP{background:linear-gradient(135deg,var(--blue2),var(--blue));color:#fff;padding:12px 26px;
      font-size:14px;box-shadow:0 4px 16px rgba(59,130,246,.28)}
.btnP:hover{transform:translateY(-1px);box-shadow:0 8px 26px rgba(59,130,246,.44)}
.btnP:active{transform:translateY(0)}.btnP:disabled{opacity:.42;cursor:not-allowed;transform:none;box-shadow:none}
.btnG{background:rgba(255,255,255,.04);border:1px solid var(--br);color:var(--tx2);padding:9px 15px;font-size:13px}
.btnG:hover{background:rgba(255,255,255,.07);color:var(--tx)}
.btnGreen{background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.28);color:var(--green);padding:9px 15px;font-size:13px}
.btnGreen:hover{background:rgba(16,185,129,.2)}
.btnWA{background:rgba(37,211,102,.12);border:1px solid rgba(37,211,102,.3);color:#25d366;padding:9px 15px;font-size:13px}
.btnWA:hover{background:rgba(37,211,102,.22)}

/* badges */
.badge{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:20px;
       font-size:10px;font-weight:700;font-family:'JetBrains Mono',monospace;letter-spacing:.04em}
.bBlue{background:rgba(59,130,246,.13);color:var(--blue);border:1px solid rgba(59,130,246,.28)}
.bGreen{background:rgba(16,185,129,.13);color:var(--green);border:1px solid rgba(16,185,129,.28)}
.bYellow{background:rgba(245,158,11,.13);color:var(--yellow);border:1px solid rgba(245,158,11,.28)}
.bRed{background:rgba(239,68,68,.13);color:var(--red);border:1px solid rgba(239,68,68,.28)}
.bPurple{background:rgba(139,92,246,.13);color:var(--purple);border:1px solid rgba(139,92,246,.28)}
.bCyan{background:rgba(6,182,212,.13);color:var(--cyan);border:1px solid rgba(6,182,212,.28)}

/* alerts */
.alert{padding:12px 14px;border-radius:10px;font-size:13.5px;display:flex;gap:9px;align-items:flex-start;margin-bottom:7px}
.aRed{background:rgba(239,68,68,.07);border:1px solid rgba(239,68,68,.22);color:#fca5a5}
.aYellow{background:rgba(245,158,11,.07);border:1px solid rgba(245,158,11,.22);color:#fde68a}
.aBlue{background:rgba(59,130,246,.07);border:1px solid rgba(59,130,246,.22);color:#93c5fd}
.aGreen{background:rgba(16,185,129,.07);border:1px solid rgba(16,185,129,.22);color:#6ee7b7}
.aMismatch{background:rgba(245,158,11,.09);border:2px solid rgba(245,158,11,.44);color:var(--yellow);border-radius:12px;padding:15px}

/* drop zone */
.drop{border:2px dashed rgba(59,130,246,.2);border-radius:16px;padding:42px 28px;text-align:center;
      transition:all .17s;cursor:pointer;background:rgba(0,0,0,.15)}
.drop:hover,.dropOn{border-color:var(--blue)!important;background:rgba(59,130,246,.04)!important;
                    animation:bpulse 1.3s ease infinite}

/* progress */
.pTrack{height:5px;background:rgba(255,255,255,.05);border-radius:3px;overflow:hidden}
.pFill{height:100%;border-radius:3px;transition:width 1.3s cubic-bezier(.16,1,.3,1)}

/* grids */
.g2{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.g3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px}
.g4{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
@media(max-width:900px){.g3,.g4{grid-template-columns:1fr 1fr}}
@media(max-width:600px){.g2,.g3,.g4{grid-template-columns:1fr}.nav{padding:0 12px}}

/* misc */
.secTitle{font-family:'Syne',sans-serif;font-weight:700;font-size:18px;color:var(--tx);
          display:flex;align-items:center;gap:9px;margin-bottom:5px}
.secSub{font-size:13px;color:var(--tx3);margin-bottom:22px}
.mono{font-family:'JetBrains Mono',monospace}
.statNum{font-family:'Syne',sans-serif;font-weight:800;font-size:29px}
.imgPrev{position:relative;border-radius:12px;overflow:hidden;background:#000;max-width:400px;margin:0 auto}
.imgPrev img{width:100%;height:200px;object-fit:cover;display:block}
.scanLine{position:absolute;left:0;right:0;height:2px;
          background:linear-gradient(90deg,transparent,var(--cyan),transparent);animation:scan 2s linear infinite;top:0}
.cacheBadge{background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.22);border-radius:7px;
            padding:4px 9px;font-size:10px;color:var(--green);font-family:'JetBrains Mono',monospace;
            display:inline-flex;align-items:center;gap:5px}
.hashBadge{background:rgba(139,92,246,.1);border:1px solid rgba(139,92,246,.22);border-radius:7px;
           padding:4px 9px;font-size:10px;color:var(--purple);font-family:'JetBrains Mono',monospace;
           display:inline-flex;align-items:center;gap:5px}

/* required-section status bar */
.secStatusBar{display:flex;gap:8px;flex-wrap:wrap;padding:14px 16px;
              background:rgba(0,0,0,.2);border:1px solid var(--br2);border-radius:12px;margin-bottom:14px}
.secStatusItem{display:flex;align-items:center;gap:5px;font-size:12px;font-weight:600;padding:4px 10px;
               border-radius:8px;font-family:'JetBrains Mono',monospace}
.secOk{background:rgba(16,185,129,.1);color:var(--green);border:1px solid rgba(16,185,129,.22)}
.secMissing{background:rgba(239,68,68,.1);color:var(--red);border:1px solid rgba(239,68,68,.28)}

/* dropdown menu */
.dropMenu{position:relative;display:inline-block}
.dropMenuList{position:absolute;top:calc(100% + 5px);right:0;
              background:var(--card2);border:1px solid var(--br);border-radius:10px;
              padding:5px;min-width:170px;z-index:400;box-shadow:0 14px 36px rgba(0,0,0,.45)}
.dropMenuItem{display:flex;align-items:center;gap:8px;padding:8px 11px;border-radius:7px;
              font-size:13px;cursor:pointer;color:var(--tx2);transition:all .14s;border:none;
              background:none;width:100%;font-family:'Inter',sans-serif}
.dropMenuItem:hover{background:rgba(59,130,246,.09);color:var(--tx)}

/* share panel */
.sharePanel{background:rgba(0,0,0,.2);border:1px solid var(--br);border-radius:14px;
            padding:20px;margin-top:10px}

/* section-cap warning */
.capWarn{background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.3);border-radius:10px;
         padding:13px 16px;display:flex;gap:10px;margin-bottom:12px}

/* ── Toast notifications ──────────────────────────────────── */
.toastContainer{position:fixed;bottom:24px;right:24px;z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none}
.toast{pointer-events:all;padding:12px 16px;border-radius:11px;font-size:13px;font-weight:500;
       display:flex;align-items:center;gap:9px;min-width:260px;max-width:380px;
       backdrop-filter:blur(18px);box-shadow:0 8px 32px rgba(0,0,0,.4);
       animation:slideIn .25s cubic-bezier(.16,1,.3,1) forwards}
@keyframes slideIn{from{opacity:0;transform:translateX(40px)}to{opacity:1;transform:translateX(0)}}
.toast-success{background:rgba(16,185,129,.18);border:1px solid rgba(16,185,129,.4);color:#6ee7b7}
.toast-error  {background:rgba(239,68,68,.18);border:1px solid rgba(239,68,68,.4);color:#fca5a5}
.toast-warn   {background:rgba(245,158,11,.18);border:1px solid rgba(245,158,11,.4);color:#fde68a}
.toast-info   {background:rgba(59,130,246,.18);border:1px solid rgba(59,130,246,.4);color:#93c5fd}

/* ── Sidebar layout ───────────────────────────────────────── */
.appShell{display:flex;min-height:calc(100vh - 66px)}
.sidebar{width:214px;flex-shrink:0;background:rgba(13,21,38,.96);border-right:1px solid var(--br2);
         padding:16px 10px;display:flex;flex-direction:column;gap:2px}
.sideItem{display:flex;align-items:center;gap:9px;padding:9px 12px;border-radius:10px;cursor:pointer;
          font-size:13px;font-weight:500;transition:all .15s;border:1px solid transparent;width:100%;
          font-family:'Inter',sans-serif;text-align:left;white-space:nowrap;background:none}
.sideOn {background:rgba(59,130,246,.15)!important;color:var(--blue)!important;border-color:rgba(59,130,246,.3)!important}
.sideOff{color:var(--tx2)}.sideOff:hover{background:rgba(255,255,255,.05);color:var(--tx)}
.sideSec{font-size:9px;font-weight:700;color:var(--tx3);letter-spacing:.1em;text-transform:uppercase;
         padding:14px 12px 5px;font-family:'JetBrains Mono',monospace}
.mainContent{flex:1;min-width:0;padding:26px 28px;overflow-x:hidden}
@media(max-width:860px){.sidebar{width:180px}.mainContent{padding:16px}}
@media(max-width:640px){.sidebar{display:none}.mainContent{padding:14px}}

/* ── History table ────────────────────────────────────────── */
.histTable{width:100%;border-collapse:collapse}
.histTable th{font-size:10px;font-weight:700;color:var(--tx3);text-transform:uppercase;
              letter-spacing:.07em;padding:10px 14px;text-align:left;
              border-bottom:1px solid var(--br2);font-family:'JetBrains Mono',monospace}
.histTable td{padding:11px 14px;font-size:13px;border-bottom:1px solid rgba(255,255,255,.03);vertical-align:middle}
.histTable tr:hover td{background:rgba(59,130,246,.04)}
.histTable tr:last-child td{border-bottom:none}

/* ── Detail modal ─────────────────────────────────────────── */
.modalBackdrop{position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:500;
               display:flex;align-items:flex-start;justify-content:center;
               padding:28px 16px;overflow-y:auto;backdrop-filter:blur(7px)}
.modalBox{background:#131e35;border:1px solid rgba(59,130,246,.2);border-radius:20px;
          width:100%;max-width:840px;padding:30px;box-shadow:0 32px 80px rgba(0,0,0,.65);
          animation:fadeUp .3s ease forwards}

/* ── Pagination ───────────────────────────────────────────── */
.pagBtn{padding:6px 13px;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;
        border:1px solid var(--br2);background:rgba(255,255,255,.04);color:var(--tx2);
        font-family:'JetBrains Mono',monospace;transition:all .14s}
.pagBtn:hover:not(:disabled){background:rgba(59,130,246,.12);color:var(--blue);border-color:rgba(59,130,246,.3)}
.pagBtn:disabled{opacity:.3;cursor:not-allowed}
.pagActive{background:rgba(59,130,246,.17)!important;color:var(--blue)!important;border-color:rgba(59,130,246,.45)!important}

/* ── Search ───────────────────────────────────────────────── */
.searchWrap{position:relative}
.searchWrap input{padding-left:37px}
.searchIco{position:absolute;left:11px;top:50%;transform:translateY(-50%);pointer-events:none;color:var(--tx3)}

/* login */
.loginBg{min-height:100vh;display:flex;align-items:center;justify-content:center;
         background:radial-gradient(ellipse at 30% 50%,rgba(59,130,246,.11) 0%,transparent 56%),
                    radial-gradient(ellipse at 78% 20%,rgba(6,182,212,.07) 0%,transparent 46%),var(--bg)}
.loginCard{background:var(--glass);backdrop-filter:blur(30px);border:1px solid rgba(59,130,246,.18);
           border-radius:22px;padding:44px;width:100%;max-width:416px;
           box-shadow:0 26px 66px rgba(0,0,0,.55)}

/* ── MedVision Pro 2.0 panels ─────────────────────────────────────────────── */
.svHigh{background:rgba(239,68,68,.09);border:1px solid rgba(239,68,68,.24);border-radius:10px;padding:13px 15px;margin-bottom:8px}
.svMod{background:rgba(245,158,11,.07);border:1px solid rgba(245,158,11,.22);border-radius:10px;padding:13px 15px;margin-bottom:8px}
.svDoc{background:rgba(59,130,246,.06);border:1px solid rgba(59,130,246,.18);border-radius:10px;padding:13px 15px;margin-bottom:8px}
.autoFix{background:rgba(16,185,129,.07);border:1px solid rgba(16,185,129,.2);border-radius:8px;padding:9px 13px;margin-top:8px;font-size:12px;color:var(--green);font-family:'JetBrains Mono',monospace;cursor:pointer;display:flex;align-items:flex-start;gap:7px;transition:background .15s}
.autoFix:hover{background:rgba(16,185,129,.13)}
.autoFixLabel{font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--green);margin-bottom:4px}
.svLabel{font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:2px 8px;border-radius:20px;display:inline-block;margin-bottom:6px}
.svLabelHigh{background:rgba(239,68,68,.2);color:#fca5a5}
.svLabelMod{background:rgba(245,158,11,.2);color:#fde68a}
.svLabelDoc{background:rgba(59,130,246,.2);color:#93c5fd}
.riskGauge{height:8px;border-radius:4px;overflow:hidden;background:rgba(255,255,255,.06);margin-top:6px}
.riskFill{height:100%;border-radius:4px;transition:width .4s ease}
.triageChip{display:inline-flex;align-items:center;gap:7px;padding:7px 13px;border-radius:20px;font-weight:700;font-size:12px;font-family:'Syne',sans-serif}
.triageImmediate{background:rgba(239,68,68,.18);border:1px solid rgba(239,68,68,.4);color:#fca5a5}
.triageUrgent{background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.3);color:#fca5a5}
.triagePriority{background:rgba(245,158,11,.12);border:1px solid rgba(245,158,11,.3);color:#fde68a}
.triageRoutine{background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.25);color:#6ee7b7}
.tnmBadge{font-family:'JetBrains Mono',monospace;font-size:15px;font-weight:700;letter-spacing:.04em;color:var(--cyan);background:rgba(6,182,212,.1);border:1px solid rgba(6,182,212,.25);border-radius:8px;padding:6px 13px;display:inline-block;margin-top:6px}
.confMeter{position:relative;height:9px;border-radius:5px;background:rgba(255,255,255,.06);overflow:hidden;margin-top:5px}
.confFill{height:100%;border-radius:5px;transition:width .5s cubic-bezier(.16,1,.3,1)}
.findingChip{background:rgba(139,92,246,.07);border:1px solid rgba(139,92,246,.18);border-radius:8px;padding:7px 12px;font-size:12px;margin-bottom:5px;display:flex;gap:8px;line-height:1.5}
.pro20Badge{background:linear-gradient(135deg,rgba(59,130,246,.18),rgba(139,92,246,.18));border:1px solid rgba(139,92,246,.3);border-radius:20px;padding:2px 10px;font-size:10px;font-weight:700;color:var(--purple);letter-spacing:.06em;font-family:'JetBrains Mono',monospace}
`;

/* ─────────────────────────────────────────────────────────────
   CONSTANTS
───────────────────────────────────────────────────────────── */
const MODS  = ["CT","X-Ray","MRI","Mammography","Ultrasound","PET-CT","Fluoroscopy"];
const ANATS = ["Brain","Chest","Abdomen","Heart","Spine","Pelvis","Extremity","Neck"];
const PROTS = ["With Contrast","Without Contrast","Screening","Emergency","Dual-Phase","High-Resolution"];
const BAD_COMBOS = [["Mammography","Brain"],["Mammography","Abdomen"],["Mammography","Heart"],["Mammography","Spine"],["Mammography","Pelvis"],["PET-CT","Extremity"]];
const HOSPITAL = "MedVision Regional Hospital";

const SAMPLE = `Clinical History: 58-year-old male with persistent cough and weight loss.

Technique: CT chest without contrast, 1mm axial sections reconstructed in lung and mediastinal windows.

Findings: A 2.3 cm spiculated mass is identified in the right upper lobe. Mediastinal lymphadenopathy with nodes measuring up to 1.8 cm in the right paratracheal region. No pleural effusion. Mild emphysematous changes bilateral upper lobes.

Impression: Findings are suspicious for primary lung malignancy with possible mediastinal nodal involvement. Recommend PET-CT for staging and tissue sampling.`;

/* ─────────────────────────────────────────────────────────────
   SECTION DETECTION — UPDATE 1
───────────────────────────────────────────────────────────── */
function detectSections(report) {
  const L = report.toLowerCase();
  const has = (...kw) => kw.some(k => L.includes(k));
  return {
    history:    has("clinical history","indication","reason for exam","reason:","history:"),
    technique:  has("technique","protocol","technical","acquisition"),
    findings:   has("findings","observation","finding:"),
    impression: has("impression","conclusion","summary","assessment"),
  };
}

function buildTemplate(sections) {
  const lines = [];
  if (!sections.history)    lines.push("Clinical History: [Enter patient symptoms and indication]");
  if (!sections.technique)  lines.push("\nTechnique: [Describe modality protocol, contrast, positioning]");
  if (!sections.findings)   lines.push("\nFindings: [Describe imaging observations]");
  if (!sections.impression) lines.push("\nImpression: [Provide clinical impression and recommendations]");
  return lines.join("\n");
}

/* ─────────────────────────────────────────────────────────────
   IN-MEMORY CACHE — 24 hr TTL
───────────────────────────────────────────────────────────── */
const _cache = new Map();
const TTL = 86_400_000;
function cacheGet(k) { const e = _cache.get(k); if (!e) return null; if (Date.now()-e.ts>TTL){_cache.delete(k);return null;} return e.val; }
function cacheSet(k,v) { _cache.set(k,{val:v,ts:Date.now()}); }
function cacheSize() { return _cache.size; }

/* ─────────────────────────────────────────────────────────────
   SHA-256 HASHING
───────────────────────────────────────────────────────────── */
async function sha256(str) {
  try {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
    return Array.from(new Uint8Array(buf)).map(b=>b.toString(16).padStart(2,"0")).join("");
  } catch {
    let h=5381; for(let i=0;i<str.length;i++){h=((h<<5)+h)^str.charCodeAt(i);h>>>=0;}
    return "djb2_"+h.toString(16).padStart(8,"0");
  }
}
const textHash  = async(m,a,p,r) => "txt_"+await sha256(`${m}||${a}||${p}||${r.trim()}`);
const imageHash = async(b64)     => "img_"+await sha256(b64.slice(0,8192));

/* ─────────────────────────────────────────────────────────────
   RULE ENGINE — deterministic
   UPDATE 1: History & Technique are now hard errors (not warnings)
             Score capped at 70 if either is missing
───────────────────────────────────────────────────────────── */
function runRules(report, modality, anatomy) {
  const secs    = detectSections(report);
  const errors  = [], warnings = [], info = [];
  const L = report.toLowerCase();
  const has = (...kw) => kw.some(k => L.includes(k));

  // Critical required sections — hard errors
  if (!secs.history)    errors.push("🔴 Clinical History section missing");
  if (!secs.technique)  errors.push("🔴 Technique section missing");
  if (!secs.findings)   errors.push("🔴 Findings section missing");
  if (!secs.impression) errors.push("🔴 Impression section missing");

  // Modality-specific
  if (modality==="Mammography") {
    if (!has("bi-rads","birads"))         errors.push("BI-RADS category required for Mammography");
    if (!has("density","fibroglandular")) warnings.push("Breast density classification not documented");
  }
  if (modality==="CT" && anatomy==="Chest") {
    if (!has("lung","parenchyma","lobe")) warnings.push("Pulmonary parenchyma evaluation expected for CT Chest");
    if (!has("mediastin"))                warnings.push("Mediastinal assessment missing for CT Chest");
  }
  if (modality==="MRI" && anatomy==="Brain") {
    if (!has("white matter","cortex","ventricle"))
      warnings.push("Brain MRI should document white matter and ventricular system");
  }

  // Vague language
  ["unremarkable","grossly normal","appears to","seems","possibly","cannot exclude","questionable","may represent"]
    .forEach(w => { if (L.includes(w)) info.push(`Vague: "${w}" — use specific descriptors`); });

  // Findings–Impression consistency
  const fi=L.indexOf("findings"), ii=L.indexOf("impression");
  if (fi!==-1 && ii!==-1) {
    const fB=L.slice(fi,ii), iB=L.slice(ii);
    ["mass","nodule","lesion","opacity","effusion","consolidation","fracture","hemorrhage","infarct","tumor","edema","adenopathy"]
      .forEach(t => { if (fB.includes(t)&&!iB.includes(t)) warnings.push(`"${t}" in Findings not addressed in Impression`); });
  }

  if (has("mass","lesion","nodule","malignancy","suspicious","abnormal") &&
      !has("follow-up","followup","recommend","correlation","biopsy"))
    warnings.push("Abnormal finding present — follow-up recommendation missing");

  // Cap flag: score must not exceed 70 if history or technique missing
  const hardCap = !secs.history || !secs.technique;

  return { errors, warnings, info, secs, hardCap };
}

function calcScore(rules, ai) {
  // Pro 2.0: Use compliance_score.overall_score as primary, blend with rule engine
  let ruleScore = 100;
  ruleScore -= rules.errors.length   * 15;
  ruleScore -= rules.warnings.length *  7;
  ruleScore -= rules.info.length > 2 ?  5 : 0;
  ruleScore = Math.max(0, Math.min(100, ruleScore));

  // If Pro 2.0 response: blend with ai compliance_score
  let score = ruleScore;
  if (ai?.compliance_score?.overall_score != null) {
    const aiScore = ai.compliance_score.overall_score;
    score = Math.round(ruleScore * 0.40 + aiScore * 0.60);
  }
  // Hard cap at 70 if history or technique missing
  if (rules.hardCap) score = Math.min(score, 70);
  return Math.max(0, Math.min(100, score));
}

/* ─────────────────────────────────────────────────────────────
   IMAGE COMPRESSION — UPDATE 4: EXIF strip + timeout
───────────────────────────────────────────────────────────── */
function compressImg(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    // UPDATE 4: 10s timeout
    const timer = setTimeout(() => { URL.revokeObjectURL(url); reject(new Error("Image load timeout")); }, 10000);
    img.onload = () => {
      clearTimeout(timer);
      const MAX=512; let {width:w, height:h}=img;
      if (w>MAX||h>MAX){ if(w>=h){h=Math.round(h*MAX/w);w=MAX;}else{w=Math.round(w*MAX/h);h=MAX;} }
      const cv=document.createElement("canvas"); cv.width=w; cv.height=h;
      // EXIF is stripped automatically when redrawing on canvas
      cv.getContext("2d").drawImage(img,0,0,w,h);
      URL.revokeObjectURL(url);
      const dataUrl=cv.toDataURL("image/jpeg",0.70);
      resolve({ base64: dataUrl.split(",")[1], mime:"image/jpeg", w, h, dataUrl });
    };
    img.onerror = ()=>{ clearTimeout(timer); URL.revokeObjectURL(url); reject(new Error("Image decode failed")); };
    img.src=url;
  });
}

/* ─────────────────────────────────────────────────────────────
   AI SERVICE — MedVision AI Pro 2.0 · temperature:0 · 15s timeout
───────────────────────────────────────────────────────────── */
const SYS_TEXT = `You are MedVision AI Pro 2.0 — a clinical-grade radiology QA and decision-support engine.

Your responsibilities:
1. Perform structured radiology report audit.
2. Detect critical omissions and inconsistencies.
3. Assign severity levels.
4. Generate auto-fix suggestions.
5. Calculate compliance metrics.
6. Provide staging assistance when applicable.
7. Estimate malignancy risk.
8. Provide model confidence transparency.
9. Escalate cases requiring urgent attention.
10. Maintain conservative, safety-first clinical reasoning.

OUTPUT FORMAT (STRICT JSON — no markdown, no prose, no code fences, no extra keys):

{"critical_issues":[{"issue":"","severity":"High Impact","explanation":"","auto_fix_text":""}],"rule_violations":[{"issue":"","severity":"Moderate","explanation":"","auto_fix_text":""}],"improvement_suggestions":[{"suggestion":"","auto_fix_text":""}],"compliance_score":{"overall_score":0,"completeness":0,"impression_consistency":0,"terminology_standardization":0,"explanation":""},"structured_impression":{"text":"","guideline_aligned":true},"ai_staging_assistant":{"activated":false,"suspected_TNM":"","lymph_node_station_standardized":"","staging_explanation":""},"risk_escalation_engine":{"malignancy_risk_percentage":0,"risk_category":"Low","escalation_required":false,"recommended_action":""},"dynamic_triage_timer":{"urgency_level":"Routine","recommended_followup_time":"","justification":""},"ai_clinical_justification_block":{"reasoning_summary":"","supporting_findings":[],"guideline_reference_logic":""},"model_confidence":{"confidence_percentage":0,"overconfidence_alert":"","low_confidence_alert":""}}

SEVERITY TAGGING: High Impact = missing staging/impression inconsistency/unaddressed mass/life-threatening. Moderate = incomplete anatomic coverage/no comparison. Documentation = formatting/signatures/terminology.
AUTO FIX: Every issue must include ready-to-insert clinical sentence. Guideline-consistent. Neutral tone.
COMPLIANCE: Start 100, deduct -10 High Impact, -5 Moderate, -2 Documentation.
STRUCTURED IMPRESSION: Never say "raises strong suspicion". Use "Findings are highly suspicious for...". Always action-oriented. Always conservative.
AI STAGING: Activate if mass + nodes detected. Lung mass>3cm=T2+. Paratracheal node=N2. Contralateral=N3. State "Preliminary radiologic staging — requires clinical correlation."
RISK: Estimate malignancy from spiculation/size>2cm/lymphadenopathy/smoking. Low<30%, Intermediate 30-70%, High>70%. High=escalation_required=true.
TRIAGE: Suspicious malignancy=Priority(7 days). Life-threatening=Immediate. Incidental benign=Routine.
CONFIDENCE: If confidence_percentage<60 set low_confidence_alert to "⚠️ Low Confidence Prediction – Manual Review Required." Never claim certainty.
CRITICAL: Output ONLY the JSON. No prose before or after. Keep each string value concise (max 2 sentences). Do not truncate — complete ALL 9 blocks before ending.
Same input = same output always.`;

const SYS_IMAGE = `You are a deterministic radiology image classification engine. 100% reproducible responses required.
ABSOLUTE RULES:
1. Output ONLY a raw JSON object. No markdown, no prose, no code fences.
2. EXACTLY these keys: detected_image_type, is_radiology_image, is_low_resolution, condition, confidence, risk_level, findings, explanation, recommendations, modality_match, modality_note, recommendation
3. confidence: float 0.0-1.0. risk_level: exactly "Low","Moderate", or "High".
4. findings[]: max 5 strings. explanation: 2 sentences. recommendations[]: 2-4 strings.
5. recommendation: single string summarising primary clinical next step.
6. Same image = same output always.
OUTPUT: {"detected_image_type":"","is_radiology_image":true,"is_low_resolution":false,"condition":"","confidence":0.0,"risk_level":"Low","findings":[],"explanation":"","recommendations":[],"modality_match":true,"modality_note":"","recommendation":""}`;

function validateTextSchema(o) {
  // Pro 2.0 schema — all top-level blocks required
  for (const k of ["critical_issues","rule_violations","improvement_suggestions","compliance_score","structured_impression","ai_staging_assistant","risk_escalation_engine","dynamic_triage_timer","ai_clinical_justification_block","model_confidence"])
    if (!(k in o)) throw new Error(`Pro 2.0 Missing: ${k}`);
  if (typeof o.compliance_score?.overall_score !== "number") throw new Error("Missing compliance_score.overall_score");
}

function validateImageSchema(o) {
  for (const k of ["detected_image_type","is_radiology_image","condition","confidence","risk_level","findings","explanation","recommendations","modality_match"])
    if (!(k in o)) throw new Error(`Missing: ${k}`);
  if (!["Low","Moderate","High"].includes(o.risk_level)) throw new Error(`Bad risk_level: ${o.risk_level}`);
}

// Safe defaults normalizer for Pro 2.0 AI response
function normalizeTextAI(o) {
  const ci = Array.isArray(o.critical_issues) ? o.critical_issues : [];
  const rv = Array.isArray(o.rule_violations)  ? o.rule_violations  : [];
  const is = Array.isArray(o.improvement_suggestions) ? o.improvement_suggestions : [];
  const cs = o.compliance_score || {};
  const si = o.structured_impression || {};
  const sa = o.ai_staging_assistant  || {};
  const re = o.risk_escalation_engine|| {};
  const dt = o.dynamic_triage_timer  || {};
  const jb = o.ai_clinical_justification_block || {};
  const mc = o.model_confidence || {};
  return {
    critical_issues: ci.map(x=>({issue:x.issue||"",severity:x.severity||"Moderate",explanation:x.explanation||"",auto_fix_text:x.auto_fix_text||""})),
    rule_violations:  rv.map(x=>({issue:x.issue||"",severity:x.severity||"Documentation",explanation:x.explanation||"",auto_fix_text:x.auto_fix_text||""})),
    improvement_suggestions: is.map(x=>({suggestion:x.suggestion||"",auto_fix_text:x.auto_fix_text||""})),
    compliance_score: {
      overall_score:               typeof cs.overall_score==="number"               ? cs.overall_score               : 0,
      completeness:                typeof cs.completeness==="number"                ? cs.completeness                : 0,
      impression_consistency:      typeof cs.impression_consistency==="number"      ? cs.impression_consistency      : 0,
      terminology_standardization: typeof cs.terminology_standardization==="number" ? cs.terminology_standardization : 0,
      explanation: cs.explanation||"",
    },
    structured_impression: { text: si.text||"", guideline_aligned: si.guideline_aligned!==false },
    ai_staging_assistant: {
      activated:                     !!sa.activated,
      suspected_TNM:                 sa.suspected_TNM||"",
      lymph_node_station_standardized: sa.lymph_node_station_standardized||"",
      staging_explanation:           sa.staging_explanation||"",
    },
    risk_escalation_engine: {
      malignancy_risk_percentage: typeof re.malignancy_risk_percentage==="number" ? re.malignancy_risk_percentage : 0,
      risk_category:    ["Low","Intermediate","High"].includes(re.risk_category)    ? re.risk_category    : "Low",
      escalation_required: !!re.escalation_required,
      recommended_action:  re.recommended_action||"",
    },
    dynamic_triage_timer: {
      urgency_level:            ["Routine","Priority","Urgent","Immediate"].includes(dt.urgency_level) ? dt.urgency_level : "Routine",
      recommended_followup_time: dt.recommended_followup_time||"",
      justification:             dt.justification||"",
    },
    ai_clinical_justification_block: {
      reasoning_summary:        jb.reasoning_summary||"",
      supporting_findings:      Array.isArray(jb.supporting_findings)?jb.supporting_findings:[],
      guideline_reference_logic: jb.guideline_reference_logic||"",
    },
    model_confidence: {
      confidence_percentage:  typeof mc.confidence_percentage==="number" ? mc.confidence_percentage : 0,
      overconfidence_alert:   mc.overconfidence_alert||"",
      low_confidence_alert:   mc.low_confidence_alert||"",
    },
  };
}

// Repair truncated JSON by closing unclosed brackets/braces/strings
function repairJSON(str) {
  try {
    // Try adding common closings until it parses
    const closings = ["}", "}}", "}}}"  , "]}", "]}}" ];
    for (const suffix of closings) {
      try {
        const attempt = str.trimEnd().replace(/[,\s]+$/, "") + suffix;
        const parsed = JSON.parse(attempt);
        if (typeof parsed === "object" && parsed !== null) return parsed;
      } catch {}
    }
    // Deeper repair: count unclosed { and [
    let depth = 0, inStr = false, escape = false;
    for (const ch of str) {
      if (escape)          { escape=false; continue; }
      if (ch==="\\")       { escape=true; continue; }
      if (ch==='"')        { inStr=!inStr; continue; }
      if (inStr)           continue;
      if (ch==="{"||ch==="[") depth++;
      if (ch==="}"||ch==="]") depth--;
    }
    if (inStr) { str += '"'; }
    let fixed = str.trimEnd().replace(/[,\s]+$/, "");
    // Close all open structures
    for (let i=0; i<Math.max(0,depth); i++) fixed += "}";
    return JSON.parse(fixed);
  } catch { return null; }
}

// Pro 2.0: callAI with 15s AbortController timeout
async function callAI(messages, system, maxTokens) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      signal: ctrl.signal,
      body: JSON.stringify({
        model:"claude-sonnet-4-20250514",
        max_tokens: maxTokens,
        temperature: 0,
        system,
        messages,
      }),
    });
    clearTimeout(timer);
    if (!resp.ok) {
      const t = await resp.text().catch(()=>"");
      throw new Error(`API ${resp.status}: ${t.slice(0,100)}`);
    }
    const data = await resp.json();
    const raw = (data.content||[]).map(b=>b.text||"").join("").trim();
    const clean = raw.replace(/^```(?:json)?\s*/i,"").replace(/\s*```\s*$/,"").trim();
    if (!clean.startsWith("{")) throw new Error("Response not JSON");
    // Attempt direct parse first
    try {
      return JSON.parse(clean);
    } catch(parseErr) {
      // JSON truncated — attempt repair by closing unclosed structures
      const repaired = repairJSON(clean);
      if (!repaired) throw new Error("Truncated JSON — could not repair: " + parseErr.message);
      return repaired;
    }
  } catch(err) {
    clearTimeout(timer);
    if (err.name==="AbortError") throw new Error("Request timed out after 10 seconds");
    throw err;
  }
}

/* ─────────────────────────────────────────────────────────────
   ▶ BACKEND API ROUTE SIMULATION
   POST /api/analyze-image
   ─────────────────────────────────────────────────────────────
   In production this would be an Express/FastAPI/Next.js route.
   Here it is implemented as a pure async service function with
   all the same guarantees: timeout, validation, structured JSON,
   never hangs, always returns success or error shape.

   Contract:
     Input : { base64, mime, modality, anatomy }
     Output: { success:true,  condition, confidence, risk_level,
               explanation, findings, recommendations,
               recommendation, detected_image_type,
               is_radiology_image, modality_match, modality_note,
               processing_time_ms, cached }
           | { success:false, error: string, processing_time_ms }
─────────────────────────────────────────────────────────────── */
async function apiAnalyzeImage({ base64, mime, modality, anatomy }) {
  const t0 = Date.now();

  // ① MIME validation
  const ALLOWED_MIME = ["image/jpeg","image/jpg","image/png","image/webp"];
  if (!ALLOWED_MIME.includes(mime)) {
    return { success:false, error:`Unsupported MIME type: ${mime}. Use JPEG or PNG.`, processing_time_ms: Date.now()-t0 };
  }

  // ② Base64 sanity check
  if (!base64 || base64.length < 100) {
    return { success:false, error:"Invalid or empty image data.", processing_time_ms: Date.now()-t0 };
  }

  // ③ SHA-256 hash for cache lookup
  const key = await imageHash(base64);
  const cached = cacheGet(key);
  if (cached) {
    return {
      success: true,
      ...cached,
      cached: true,
      _hash: key.slice(0,12),
      processing_time_ms: Date.now()-t0,
    };
  }

  // ④ Call AI with 15-second timeout (backend route gets extra 5s vs frontend)
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      signal: ctrl.signal,
      body: JSON.stringify({
        model:"claude-sonnet-4-20250514",
        max_tokens: 580,
        temperature: 0,
        system: SYS_IMAGE,
        messages:[{
          role:"user",
          content:[
            {type:"image", source:{type:"base64", media_type:mime, data:base64}},
            {type:"text",  text:`Stated modality: ${modality}. Stated anatomy: ${anatomy}. Classify this image.`},
          ],
        }],
      }),
    });
    clearTimeout(timer);

    if (!resp.ok) {
      const errText = await resp.text().catch(()=>"");
      return { success:false, error:`API error ${resp.status}: ${errText.slice(0,80)}`, processing_time_ms:Date.now()-t0 };
    }

    const data  = await resp.json();
    const raw   = (data.content||[]).map(b=>b.text||"").join("").trim();
    const clean = raw.replace(/^```(?:json)?\s*/i,"").replace(/\s*```\s*$/,"").trim();

    if (!clean.startsWith("{")) {
      return { success:false, error:"AI returned non-JSON response.", processing_time_ms:Date.now()-t0 };
    }

    const parsed = JSON.parse(clean);
    validateImageSchema(parsed); // throws on bad schema

    // ⑤ Normalise all fields with safe defaults
    const result = {
      detected_image_type: parsed.detected_image_type || "Unknown",
      is_radiology_image:  parsed.is_radiology_image !== false,
      is_low_resolution:   !!parsed.is_low_resolution,
      condition:           parsed.condition           || "Unspecified",
      confidence:          typeof parsed.confidence==="number" ? parsed.confidence : 0,
      risk_level:          ["Low","Moderate","High"].includes(parsed.risk_level) ? parsed.risk_level : "Low",
      findings:            Array.isArray(parsed.findings)       ? parsed.findings       : [],
      explanation:         parsed.explanation         || "",
      recommendations:     Array.isArray(parsed.recommendations)? parsed.recommendations: [],
      modality_match:      parsed.modality_match      !== false,
      modality_note:       parsed.modality_note       || "",
      recommendation:      parsed.recommendation      || "",
    };

    // ⑥ Store in cache
    cacheSet(key, result);

    return {
      success: true,
      ...result,
      cached: false,
      _hash: key.slice(0,12),
      processing_time_ms: Date.now()-t0,
    };

  } catch(err) {
    clearTimeout(timer);
    const msg = err.name==="AbortError"
      ? "Image analysis timed out after 15 seconds."
      : `Image analysis failed: ${err.message}`;
    return { success:false, error:msg, processing_time_ms:Date.now()-t0 };
  }
}

/* ─────────────────────────────────────────────────────────────
   TEXT AI (thin wrapper around callAI)
─────────────────────────────────────────────────────────────── */
async function analyzeTextAI(mod, an, prot, report) {
  const key = await textHash(mod,an,prot,report);
  const hit = cacheGet(key); if (hit) return {...normalizeTextAI(hit), _cached:true, _hash:key.slice(0,12)};
  const result = await callAI(
    [{role:"user",content:`Modality:${mod}\nAnatomy:${an}\nProtocol:${prot}\n\nREPORT:\n${report.trim()}\n\nOutput ONLY the JSON object — no prose, no markdown, no fences.`}],
    SYS_TEXT, 4000  // Pro 2.0 rich schema needs 4000 tokens
  );
  validateTextSchema(result);
  const normalized = normalizeTextAI(result);
  cacheSet(key, normalized);
  return {...normalized, _cached:false, _hash:key.slice(0,12)};
}

async function analyzeImageAI(base64, mime, mod, an) {
  const key = await imageHash(base64);
  const hit = cacheGet(key); if (hit) return {...hit, _cached:true, _hash:key.slice(0,12)};
  const result = await callAI(
    [{role:"user",content:[
      {type:"image",source:{type:"base64",media_type:mime,data:base64}},
      {type:"text", text:`Stated modality:${mod}. Stated anatomy:${an}. Classify this image.`},
    ]}],
    SYS_IMAGE, 580
  );
  validateImageSchema(result);
  cacheSet(key, result);
  return {...result, _cached:false, _hash:key.slice(0,12)};
}

/* ─────────────────────────────────────────────────────────────
   CROSS-MODAL VALIDATION
───────────────────────────────────────────────────────────── */
function crossValidate(textResult, imgResult) {
  if (!textResult?.ai || !imgResult?.condition) return null;
  const imp      = (textResult.ai.structured_impression||"").toLowerCase();
  const cond     = (imgResult.condition||"").toLowerCase();
  const condMatch = cond.split(/\s+/).filter(w=>w.length>4).some(w=>imp.includes(w));
  const toRisk   = s => s>=75?"Low":s>=50?"Moderate":"High";
  const textRisk = toRisk(textResult.score);
  const imgRisk  = imgResult.risk_level||"Low";
  return { consistent:condMatch&&textRisk===imgRisk, condMatch, riskMatch:textRisk===imgRisk, textRisk, imgRisk, condition:imgResult.condition };
}

/* ─────────────────────────────────────────────────────────────
   UPDATE 2: PDF EXPORT (jsPDF via CDN)
───────────────────────────────────────────────────────────── */
async function exportPDF(textResults, imgResult, meta) {
  const jspdf = await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js","jspdf");
  const { jsPDF } = jspdf;
  const doc = new jsPDF({ unit:"mm", format:"a4" });
  const W=210, margin=18, lineH=6.5;
  let y = margin;

  // Helpers
  const heading = (txt, size=14, color=[59,130,246]) => {
    doc.setFont("helvetica","bold"); doc.setFontSize(size); doc.setTextColor(...color);
    doc.text(txt, margin, y); y+=lineH+2;
  };
  const row = (label, val, labelColor=[148,163,184], valColor=[226,232,240]) => {
    doc.setFont("helvetica","bold"); doc.setFontSize(9); doc.setTextColor(...labelColor);
    doc.text(label, margin, y);
    doc.setFont("helvetica","normal"); doc.setTextColor(...valColor);
    doc.text(String(val), margin+52, y); y+=lineH;
  };
  const hr = (col=[59,130,246]) => { doc.setDrawColor(...col); doc.setLineWidth(0.3); doc.line(margin,y,W-margin,y); y+=4; };
  const ensurePage = (needed=20) => { if (y+needed>280){ doc.addPage(); y=margin; } };
  const wrap = (txt,x,maxW) => {
    const lines = doc.splitTextToSize(String(txt||""),maxW);
    doc.text(lines,x,y); y+=lines.length*lineH;
  };

  // ── Header ──
  doc.setFillColor(15,23,42); doc.rect(0,0,W,28,"F");
  doc.setFont("helvetica","bold"); doc.setFontSize(18); doc.setTextColor(255,255,255);
  doc.text("MedVision AI — Radiology QA Report",margin,13);
  doc.setFontSize(9); doc.setTextColor(148,163,184);
  doc.text(HOSPITAL, margin, 20);
  doc.text(`Generated: ${new Date().toLocaleString()}`, W-margin, 20, {align:"right"});
  y=36;

  // ── Study Metadata ──
  heading("Study Metadata",12,[226,232,240]); hr();
  row("Modality:",    meta.mod);
  row("Anatomy:",     meta.an);
  row("Protocol:",    meta.prot);
  row("Analyzed by:", meta.user||"AI Engine");
  row("Report hash:", meta.hash||"—");
  y+=4;

  // ── QA Score ──
  ensurePage(30);
  heading("QA Score Summary",12,[59,130,246]); hr();
  const score = textResults?.score ?? "—";
  const scoreColor = score>=80?[16,185,129]:score>=60?[245,158,11]:[239,68,68];
  doc.setFontSize(38); doc.setFont("helvetica","bold"); doc.setTextColor(...scoreColor);
  doc.text(String(score), margin, y); y+=12;
  doc.setFontSize(9); doc.setTextColor(148,163,184);
  doc.text(score>=85?"✓ Ready for Sign-Off":score>=65?"Needs Review":"Requires Revision", margin+18, y-12);

  if (textResults?.ai?.breakdown) {
    y+=2;
    const bd = textResults.ai.breakdown;
    const cats = [["Completeness",bd.completeness],["Technique",bd.technique],["Impression",bd.impression],["Clinical Relevance",bd.clinical_relevance],["Compliance",bd.compliance]];
    cats.forEach(([l,v]) => {
      doc.setFontSize(9); doc.setFont("helvetica","bold"); doc.setTextColor(148,163,184); doc.text(l,margin,y);
      doc.setFillColor(30,41,59); doc.rect(margin+50,y-3.5,80,5,"F");
      const fillCol = v>=80?[16,185,129]:v>=60?[245,158,11]:[239,68,68];
      doc.setFillColor(...fillCol); doc.rect(margin+50,y-3.5,(80*v/100),5,"F");
      doc.setFont("helvetica","normal"); doc.setTextColor(226,232,240); doc.text(`${v}%`,margin+134,y); y+=lineH+1;
    });
  }
  y+=4;

  // ── Critical Issues ──
  if (textResults?.rules?.errors?.length) {
    ensurePage(20);
    heading("Critical Errors",11,[239,68,68]); hr([239,68,68]);
    textResults.rules.errors.forEach(e => { ensurePage(8); doc.setFontSize(9); doc.setTextColor(252,165,165); doc.setFont("helvetica","normal"); wrap("• "+e, margin, W-2*margin); });
    y+=4;
  }

  if (textResults?.ai?.critical_issues?.length) {
    ensurePage(16);
    heading("AI Critical Issues",11,[239,68,68]); hr([239,68,68]);
    textResults.ai.critical_issues.forEach(e => { ensurePage(8); doc.setFontSize(9); doc.setTextColor(252,165,165); doc.setFont("helvetica","normal"); wrap("• "+e, margin, W-2*margin); });
    y+=4;
  }

  // ── AI Impression ──
  if (textResults?.ai?.structured_impression) {
    ensurePage(24);
    heading("AI Structured Impression",11,[139,92,246]); hr([139,92,246]);
    doc.setFontSize(9); doc.setFont("helvetica","normal"); doc.setTextColor(226,232,240);
    wrap(textResults.ai.structured_impression, margin, W-2*margin); y+=4;
  }

  // ── Image Analysis ──
  if (imgResult && !imgResult.error) {
    ensurePage(30);
    doc.addPage(); y=margin;
    heading("Image Analysis",12,[6,182,212]); hr([6,182,212]);
    row("Detected Type:",  imgResult.detected_image_type||"—");
    row("Condition:",       imgResult.condition||"—");
    row("Confidence:",      `${Math.round((imgResult.confidence||0)*100)}%`);
    row("Risk Level:",      imgResult.risk_level||"—");
    row("Modality Match:", imgResult.modality_match?"Yes":"No");
    y+=4;
    if (imgResult.findings?.length) {
      doc.setFontSize(10); doc.setFont("helvetica","bold"); doc.setTextColor(148,163,184); doc.text("Visual Findings:",margin,y); y+=lineH;
      imgResult.findings.forEach(f => { doc.setFontSize(9); doc.setFont("helvetica","normal"); doc.setTextColor(226,232,240); wrap("▸ "+f, margin+4, W-2*margin-4); });
      y+=2;
    }
    if (imgResult.explanation) {
      doc.setFontSize(10); doc.setFont("helvetica","bold"); doc.setTextColor(148,163,184); doc.text("Explanation:",margin,y); y+=lineH;
      doc.setFontSize(9); doc.setFont("helvetica","normal"); doc.setTextColor(226,232,240); wrap(imgResult.explanation, margin+4, W-2*margin-4);
    }
    if (imgResult.recommendations?.length) {
      y+=2; doc.setFontSize(10); doc.setFont("helvetica","bold"); doc.setTextColor(148,163,184); doc.text("Recommendations:",margin,y); y+=lineH;
      imgResult.recommendations.forEach((r,i) => { doc.setFontSize(9); doc.setFont("helvetica","normal"); doc.setTextColor(226,232,240); wrap(`${i+1}. ${r}`, margin+4, W-2*margin-4); });
    }
  }

  // ── Footer ──
  const pages = doc.internal.getNumberOfPages();
  for (let i=1;i<=pages;i++) {
    doc.setPage(i); doc.setFontSize(8); doc.setTextColor(100,116,139);
    doc.text(`MedVision AI PRO 2.0 — ${HOSPITAL} — Page ${i}/${pages}`, W/2, 290, {align:"center"});
  }

  doc.save(`MedVision_QA_${new Date().toISOString().split("T")[0]}.pdf`);
}

/* ─────────────────────────────────────────────────────────────
   UPDATE 2: EXCEL EXPORT (SheetJS via CDN)
   Sheet 1: QA Summary | Sheet 2: Score Breakdown
   Sheet 3: Image Analysis | Sheet 4: Compliance Checklist
───────────────────────────────────────────────────────────── */
async function exportExcel(textResults, imgResult, meta) {
  const XLSX = await loadScript("https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js","XLSX");

  const wb = XLSX.utils.book_new();

  // ── Sheet 1: QA Summary ──
  const summary = [
    ["Field","Value"],
    ["Hospital", HOSPITAL],
    ["Generated At", new Date().toLocaleString()],
    ["Modality", meta.mod],
    ["Anatomy", meta.an],
    ["Protocol", meta.prot],
    ["Radiologist", meta.user||"AI Engine"],
    ["Report Hash (SHA-256)", meta.hash||"—"],
    ["",""],
    ["FINAL QA SCORE", textResults?.score ?? "—"],
    ["Status", textResults?.score>=85?"Ready for Sign-Off":textResults?.score>=65?"Needs Review":"Requires Revision"],
    ["AI Confidence", textResults?.ai?.confidence!=null ? `${Math.round(textResults.ai.confidence*100)}%` : "—"],
    ["Score Cap Applied (Missing Sections)", textResults?.rules?.hardCap?"YES — capped at 70":"No"],
    ["",""],
    ["Critical Errors (Rule Engine)", textResults?.rules?.errors?.join("; ")||"None"],
    ["Warnings", textResults?.rules?.warnings?.join("; ")||"None"],
    ["Style Flags", textResults?.rules?.info?.join("; ")||"None"],
    ["",""],
    ["AI Structured Impression", textResults?.ai?.structured_impression||"—"],
    ["AI Clinical Insight", textResults?.ai?.ai_insight||"—"],
  ];
  const ws1 = XLSX.utils.aoa_to_sheet(summary);
  ws1["!cols"] = [{wch:34},{wch:72}];
  XLSX.utils.book_append_sheet(wb, ws1, "QA Summary");

  // ── Sheet 2: Score Breakdown ──
  const bd = textResults?.ai?.breakdown || {};
  const breakdown = [
    ["Category","Score (0–100)","Status"],
    ["Completeness",    bd.completeness    ??"-", (bd.completeness??0)>=80?"Good":(bd.completeness??0)>=60?"Fair":"Poor"],
    ["Technique",       bd.technique       ??"-", (bd.technique??0)>=80?"Good":(bd.technique??0)>=60?"Fair":"Poor"],
    ["Impression",      bd.impression      ??"-", (bd.impression??0)>=80?"Good":(bd.impression??0)>=60?"Fair":"Poor"],
    ["Clinical Relevance",bd.clinical_relevance??"-",(bd.clinical_relevance??0)>=80?"Good":(bd.clinical_relevance??0)>=60?"Fair":"Poor"],
    ["Compliance",      bd.compliance      ??"-", (bd.compliance??0)>=80?"Good":(bd.compliance??0)>=60?"Fair":"Poor"],
    ["","",""],
    ["OVERALL SCORE", textResults?.score??"-","=AVERAGE(B2:B6)"],
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(breakdown);
  ws2["!cols"] = [{wch:22},{wch:16},{wch:12}];
  XLSX.utils.book_append_sheet(wb, ws2, "Score Breakdown");

  // ── Sheet 3: Image Analysis ──
  const imgRows = [
    ["Field","Value"],
    ["Detected Image Type",  imgResult?.detected_image_type ||"Not analyzed"],
    ["Condition Detected",   imgResult?.condition           ||"—"],
    ["Confidence",           imgResult?.confidence!=null?`${Math.round(imgResult.confidence*100)}%`:"—"],
    ["Risk Level",           imgResult?.risk_level          ||"—"],
    ["Modality Match",       imgResult?.modality_match===false?"NO":"Yes"],
    ["Modality Note",        imgResult?.modality_note       ||"—"],
    ["Low Resolution",       imgResult?.is_low_resolution?"Yes":"No"],
    ["",""],
    ["Findings",""],
    ...(imgResult?.findings||[]).map((f,i)=>[`Finding ${i+1}`, f]),
    ["",""],
    ["Recommendations",""],
    ...(imgResult?.recommendations||[]).map((r,i)=>[`Recommendation ${i+1}`, r]),
    ["",""],
    ["Primary Recommendation", imgResult?.recommendation||"—"],
    ["Explanation",            imgResult?.explanation   ||"—"],
  ];
  const ws3 = XLSX.utils.aoa_to_sheet(imgRows);
  ws3["!cols"] = [{wch:26},{wch:68}];
  XLSX.utils.book_append_sheet(wb, ws3, "Image Analysis");

  // ── Sheet 4: Compliance Checklist ──
  const secs = textResults?.rules?.secs || detectSections("");
  const checklist = [
    ["Requirement","Present?","Notes"],
    ["Clinical History Section",  secs.history   ?"✅ YES":"❌ MISSING", secs.history   ?"":"REQUIRED — score capped at 70"],
    ["Technique Section",         secs.technique  ?"✅ YES":"❌ MISSING", secs.technique  ?"":"REQUIRED — score capped at 70"],
    ["Findings Section",          secs.findings   ?"✅ YES":"❌ MISSING", secs.findings   ?"":"Required for complete report"],
    ["Impression Section",        secs.impression ?"✅ YES":"❌ MISSING", secs.impression ?"":"Required for complete report"],
    ["Follow-up Recommendation",  "—",            "Check warnings for details"],
    ["BI-RADS (if Mammography)",  "—",            "Check errors for details"],
    ["","",""],
    ["Modality",  meta.mod,  ""],
    ["Anatomy",   meta.an,   ""],
    ["Protocol",  meta.prot, ""],
    ["","",""],
    ["Vague Language Flags",  String(textResults?.rules?.info?.length||0), textResults?.rules?.info?.join("; ")||"None"],
  ];
  const ws4 = XLSX.utils.aoa_to_sheet(checklist);
  ws4["!cols"] = [{wch:32},{wch:14},{wch:52}];
  XLSX.utils.book_append_sheet(wb, ws4, "Compliance Checklist");

  XLSX.writeFile(wb, `MedVision_QA_${new Date().toISOString().split("T")[0]}.xlsx`);
}

/* ─────────────────────────────────────────────────────────────
   UPDATE 2: JSON EXPORT (fixed blob download)
───────────────────────────────────────────────────────────── */
function exportJSON(textResults, imgResult, meta) {
  const payload = {
    hospital: HOSPITAL,
    generated_at: new Date().toISOString(),
    study: { modality:meta.mod, anatomy:meta.an, protocol:meta.prot },
    final_score: textResults?.score,
    score_capped: textResults?.rules?.hardCap||false,
    sections_present: textResults?.rules?.secs||{},
    rule_engine: textResults?.rules,
    ai_analysis: textResults?.ai,
    image_analysis: imgResult||null,
    report_hash: meta.hash||"—",
  };
  const blob = new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href=url; a.download=`MedVision_QA_${new Date().toISOString().split("T")[0]}.json`;
  document.body.appendChild(a); a.click();
  setTimeout(()=>{ document.body.removeChild(a); URL.revokeObjectURL(url); },500);
}

/* ─────────────────────────────────────────────────────────────
   UPDATE 3: SHARE HELPERS
   Email: mailto: with prefilled body (PDF must be downloaded separately)
   WhatsApp: wa.me link with prefilled message
───────────────────────────────────────────────────────────── */
function shareViaEmail(toEmail, textResults, imgResult, meta) {
  const score = textResults?.score ?? "—";
  const status = score>=85?"Ready for Sign-Off":score>=65?"Needs Review":"Requires Revision";
  const body = encodeURIComponent(
`MedVision AI — Radiology QA Report

Hospital: ${HOSPITAL}
Date: ${new Date().toLocaleString()}
Modality: ${meta.mod} | Anatomy: ${meta.an} | Protocol: ${meta.prot}

QA SCORE: ${score}/100 — ${status}
${textResults?.rules?.hardCap?"⚠ Score capped at 70 (missing required section)":""}

Score Breakdown:
• Completeness:      ${textResults?.ai?.breakdown?.completeness??"-"}
• Technique:         ${textResults?.ai?.breakdown?.technique??"-"}
• Impression:        ${textResults?.ai?.breakdown?.impression??"-"}
• Clinical Relevance:${textResults?.ai?.breakdown?.clinical_relevance??"-"}
• Compliance:        ${textResults?.ai?.breakdown?.compliance??"-"}

${textResults?.rules?.errors?.length ? "Critical Errors:\n"+textResults.rules.errors.map(e=>"  • "+e).join("\n") : "No critical errors."}

AI Clinical Insight:
${textResults?.ai?.ai_insight||"—"}

${imgResult&&!imgResult.error ? `Image Analysis:
• Condition: ${imgResult.condition}
• Risk Level: ${imgResult.risk_level}
• Confidence: ${Math.round((imgResult.confidence||0)*100)}%
• Recommendation: ${imgResult.recommendation||"—"}` : ""}

⚕ This is an AI-generated QA report. Please verify before clinical sign-off.
Powered by MedVision AI PRO 2.0`
  );
  const subject = encodeURIComponent(`MedVision QA Report — ${meta.mod}/${meta.an} — Score: ${score}/100`);
  window.open(`mailto:${toEmail}?subject=${subject}&body=${body}`, "_blank");
  return true;
}

function shareViaWhatsApp(phone, textResults, imgResult, meta) {
  const score  = textResults?.score??"—";
  const status = score>=85?"✅ Ready for Sign-Off":score>=65?"⚠ Needs Review":"🔴 Requires Revision";
  const expiry = new Date(Date.now()+86400000).toLocaleString();
  const msg = encodeURIComponent(
`🏥 *MedVision AI Report Ready*

*Hospital:* ${HOSPITAL}
*Study:* ${meta.mod} / ${meta.an}
*Date:* ${new Date().toLocaleDateString()}

*QA Score: ${score}/100* — ${status}
${textResults?.rules?.hardCap?"⚠ Score capped at 70 (missing required section)\n":""}
${imgResult&&!imgResult.error?`*Image Finding:* ${imgResult.condition} (${imgResult.risk_level} Risk)\n`:""}
📄 *AI Insight:* ${textResults?.ai?.ai_insight||"—"}

⚠ This report link expires: ${expiry}
Powered by MedVision AI PRO 2.0`
  );
  const cleaned = phone.replace(/[^0-9]/g,"");
  window.open(`https://wa.me/${cleaned}?text=${msg}`, "_blank");
  return true;
}

/* ─────────────────────────────────────────────────────────────
   AUTH
───────────────────────────────────────────────────────────── */
const USERS = [
  {id:1,email:"demo@medvision.ai",password:"demo",name:"Dr. Alex Morgan",role:"Senior Radiologist",avatar:"AM"},
  {id:2,email:"dr.smith@hospital.com",password:"password",name:"Dr. Sarah Smith",role:"Chief Radiologist",avatar:"SS"},
];
const authLogin = (email,pw) => {
  const u = USERS.find(x=>x.email===email&&x.password===pw); if(!u) return null;
  const tok = btoa(JSON.stringify({id:u.id,email:u.email,exp:Date.now()+86400000}));
  return {tok, user:{...u}};
};
const authGet = () => {
  try {
    const t=sessionStorage.getItem("mv_tok"); if(!t) return null;
    const p=JSON.parse(atob(t)); if(p.exp<Date.now()){sessionStorage.removeItem("mv_tok");return null;}
    return USERS.find(x=>x.id===p.id)||null;
  } catch { return null; }
};

/* ─────────────────────────────────────────────────────────────
   TOAST SYSTEM
───────────────────────────────────────────────────────────── */
const toastBus = { listeners: [], emit(t){ this.listeners.forEach(fn=>fn(t)); }, on(fn){ this.listeners.push(fn); return ()=>{ this.listeners=this.listeners.filter(f=>f!==fn); }; } };

function toast(msg, type="info", duration=3500) {
  toastBus.emit({ id: Date.now()+Math.random(), msg, type, duration });
}

function ToastContainer() {
  const [toasts, setToasts] = useState([]);
  useEffect(() => {
    return toastBus.on(t => {
      setToasts(prev => [...prev, t]);
      setTimeout(() => setToasts(prev => prev.filter(x => x.id !== t.id)), t.duration);
    });
  }, []);
  if (!toasts.length) return null;
  return (
    <div className="toastContainer">
      {toasts.map(t => (
        <div key={t.id} className={`toast toast-${t.type}`}>
          <span style={{flexShrink:0}}>
            {t.type==="success"?"✓":t.type==="error"?"✗":t.type==="warn"?"⚠":"ℹ"}
          </span>
          <span style={{flex:1}}>{t.msg}</span>
          <span style={{cursor:"pointer",opacity:.6,fontSize:15}} onClick={()=>setToasts(p=>p.filter(x=>x.id!==t.id))}>×</span>
        </div>
      ))}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   DB-CONNECTED ANALYSIS WRAPPERS
───────────────────────────────────────────────────────────── */
async function runTextAnalysisWithDB(mod, an, prot, report, user) {
  const t0 = Date.now();
  const rules = runRules(report, mod, an);
  const ai    = await analyzeTextAI(mod, an, prot, report);
  const score = calcScore(rules, ai);
  const ms    = Date.now() - t0;
  const hashKey = await textHash(mod, an, prot, report);
  ;(async () => {
    const riskCat = ai?.risk_escalation_engine?.risk_category||"";
    const cond = ai?.risk_escalation_engine?.escalation_required?"Escalation Required":
                 ai?.ai_staging_assistant?.activated?`Staging: ${ai.ai_staging_assistant.suspected_TNM||"unknown"}`:"";
    const res = await DB.insert({ type:"text", modality:mod, anatomy:an, report_text:report,
      qa_score:score, image_condition:cond, risk_level:riskCat,
      ai_response_json:{rules,ai,score}, processing_time_ms:ms });
    if (res.ok) toast("Analysis saved to history","success");
    else        toast("Analysis completed but not saved to history","warn");
  })();
  return { rules, ai, score, meta:{ mod, an, prot, hash:hashKey.slice(0,16), user:user?.name }, ms };
}

async function runImageAnalysisWithDB(base64, mime, mod, an) {
  // Delegates to the backend API route (POST /api/analyze-image simulation)
  const response = await apiAnalyzeImage({ base64, mime, modality:mod, anatomy:an });
  if (!response.success) throw new Error(response.error || "Image analysis failed.");

  const { processing_time_ms:ms, cached, _hash, success:_ok, ...aiFields } = response;
  const safe = { ...aiFields, _cached: cached, _hash };

  // Fire-and-forget DB insert — never blocks UI
  ;(async () => {
    const res = await DB.insert({
      type:"image", modality:mod, anatomy:an,
      image_hash:_hash||"", image_condition:safe.condition,
      confidence:safe.confidence, risk_level:safe.risk_level,
      ai_response_json:safe, processing_time_ms:ms });
    if (res.ok) toast("Image analysis saved to history","success");
    else        toast("Image analysis completed but not saved","warn");
  })();
  return { safe, ms };
}

/* ─────────────────────────────────────────────────────────────
   HISTORY PAGE
───────────────────────────────────────────────────────────── */
function HistoryPage() {
  const [rows,      setRows]      = useState([]);
  const [total,     setTotal]     = useState(0);
  const [pages,     setPages]     = useState(1);
  const [page,      setPage]      = useState(1);
  const [search,    setSearch]    = useState("");
  const [filterMod, setFilterMod] = useState("All");
  const [abnOnly,   setAbnOnly]   = useState(false);
  const [sortDir,   setSortDir]   = useState("desc");
  const [loading,   setLoading]   = useState(true);
  const [detail,    setDetail]    = useState(null);
  const [stats,     setStats]     = useState(null);
  const LIMIT = 10;

  const load = useCallback(async (p) => {
    setLoading(true);
    const res = await DB.query({ search, modality:filterMod, abnormalOnly:abnOnly, page:p, limit:LIMIT });
    const sorted = sortDir==="asc" ? [...res.data].reverse() : res.data;
    setRows(sorted); setTotal(res.total); setPages(res.pages);
    setLoading(false);
  }, [search, filterMod, abnOnly, sortDir]);

  useEffect(() => { setPage(1); load(1); }, [search, filterMod, abnOnly, sortDir]);
  useEffect(() => { load(page); }, [page]);
  useEffect(() => { DB.stats().then(setStats); }, []);

  const goPage = p => { if(p<1||p>pages) return; setPage(p); };
  const scoreColor = s => s==null?"var(--tx3)":s>=80?"var(--green)":s>=60?"var(--yellow)":"var(--red)";
  const riskCls    = r => r==="High"?"bRed":r==="Moderate"?"bYellow":r==="Low"?"bGreen":"bBlue";
  const fmtDate    = iso => { try { return new Date(iso).toLocaleString("en-US",{month:"short",day:"numeric",year:"numeric",hour:"2-digit",minute:"2-digit"}); } catch{return iso||"—";} };

  return (
    <div className="fu">
      {detail && <DetailModal record={detail} onClose={()=>setDetail(null)}/>}

      <div className="secTitle" style={{marginBottom:4}}>
        <Ico n="db" s={20} c="var(--blue)"/>Analysis History
        {stats && <span className="badge bBlue mono" style={{marginLeft:6}}>{stats.total} records</span>}
      </div>
      <p className="secSub">All past analyses · Searchable · Paginated · Persistent storage</p>

      {stats && (
        <div className="g4" style={{marginBottom:18}}>
          {[
            {l:"Total Analyses", v:stats.total,                         c:"var(--blue)"},
            {l:"Avg QA Score",   v:stats.avgScore!=null?`${stats.avgScore}/100`:"—", c:"var(--green)"},
            {l:"Abnormal Rate",  v:`${stats.abnormalRate}%`,            c:"var(--yellow)"},
            {l:"Top Condition",  v:stats.topCondition,                  c:"var(--cyan)"},
          ].map((s,i)=>(
            <div key={i} className="card" style={{padding:15}}>
              <div style={{fontSize:9,color:"var(--tx3)",textTransform:"uppercase",letterSpacing:".08em",marginBottom:5}}>{s.l}</div>
              <div style={{fontFamily:"'Syne',sans-serif",fontWeight:700,fontSize:20,color:s.c}}>{s.v||"—"}</div>
            </div>
          ))}
        </div>
      )}

      <div className="card" style={{padding:14,marginBottom:14}}>
        <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
          <div className="searchWrap" style={{flex:"1 1 200px"}}>
            <span className="searchIco"><Ico n="search" s={14} c="var(--tx3)"/></span>
            <input type="text" placeholder="Search condition, modality, anatomy, report…"
              value={search} onChange={e=>setSearch(e.target.value)} style={{fontSize:13}}/>
          </div>
          <select value={filterMod} onChange={e=>setFilterMod(e.target.value)}
            style={{width:"auto",fontSize:13,padding:"10px 12px"}}>
            <option>All</option>{MODS.map(m=><option key={m}>{m}</option>)}
          </select>
          <button className={`btn ${abnOnly?"btnP":"btnG"}`} onClick={()=>setAbnOnly(o=>!o)}
            style={{padding:"9px 14px",fontSize:12}}>
            <Ico n="alert" s={12} c={abnOnly?"white":"var(--yellow)"}/>Abnormal Only
          </button>
          <button className="btn btnG" onClick={()=>setSortDir(d=>d==="desc"?"asc":"desc")}
            style={{padding:"9px 14px",fontSize:12}}>
            <Ico n="chevron" s={12} c="var(--tx2)"/>
            {sortDir==="desc"?"Newest":"Oldest"}
          </button>
          <button className="btn btnG" onClick={()=>load(page)} style={{padding:"9px 12px",fontSize:12}} title="Refresh">
            <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          </button>
        </div>
      </div>

      <div className="card" style={{padding:0,overflow:"hidden"}}>
        {loading ? (
          <div style={{padding:24}}>
            {[1,2,3,4,5].map(i=><div key={i} className="sk" style={{height:40,marginBottom:6,borderRadius:7}}/>)}
          </div>
        ) : rows.length===0 ? (
          <div style={{padding:48,textAlign:"center",color:"var(--tx3)"}}>
            <div style={{fontSize:36,marginBottom:10}}>🔍</div>
            <div style={{fontFamily:"'Syne',sans-serif",fontWeight:600,fontSize:15,marginBottom:5}}>No analyses found</div>
            <div style={{fontSize:13}}>{search||filterMod!=="All"||abnOnly
              ?"Try adjusting your filters"
              :"Run a Text QA or Image Analysis to populate history"}</div>
          </div>
        ) : (
          <div style={{overflowX:"auto"}}>
            <table className="histTable">
              <thead>
                <tr>
                  <th>Date</th><th>Type</th><th>Modality</th><th>Anatomy</th>
                  <th>QA Score</th><th>Condition</th><th>Conf.</th><th>Risk</th><th>Time</th><th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r=>(
                  <tr key={r.id}>
                    <td><span className="mono" style={{fontSize:11,color:"var(--tx3)"}}>{fmtDate(r.created_at)}</span></td>
                    <td><span className={`badge ${r.type==="image"?"bCyan":r.type==="combined"?"bPurple":"bBlue"}`} style={{fontSize:9}}>{r.type||"—"}</span></td>
                    <td><span style={{fontWeight:600,fontSize:13}}>{r.modality||"—"}</span></td>
                    <td style={{color:"var(--tx2)",fontSize:13}}>{r.anatomy||"—"}</td>
                    <td>
                      {r.qa_score!=null
                        ? <span style={{fontFamily:"'Syne',sans-serif",fontWeight:700,fontSize:15,color:scoreColor(r.qa_score)}}>{r.qa_score}</span>
                        : <span style={{color:"var(--tx3)"}}>—</span>}
                    </td>
                    <td style={{color:"var(--tx2)",maxWidth:130,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",fontSize:13}}>{r.image_condition||"—"}</td>
                    <td>{r.confidence!=null
                      ? <span className="mono" style={{fontSize:12,color:"var(--cyan)"}}>{Math.round(r.confidence*100)}%</span>
                      : <span style={{color:"var(--tx3)"}}>—</span>}</td>
                    <td>{r.risk_level
                      ? <span className={`badge ${riskCls(r.risk_level)}`} style={{fontSize:9}}>{r.risk_level}</span>
                      : <span style={{color:"var(--tx3)"}}>—</span>}</td>
                    <td><span className="mono" style={{fontSize:11,color:"var(--tx3)"}}>{r.processing_time_ms?`${r.processing_time_ms}ms`:"—"}</span></td>
                    <td>
                      <button className="btn btnG" style={{padding:"5px 11px",fontSize:11}} onClick={()=>setDetail(r)}>
                        <Ico n="info" s={11} c="var(--blue)"/>View
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!loading && rows.length>0 && (
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"12px 18px",borderTop:"1px solid var(--br2)"}}>
            <span style={{fontSize:12,color:"var(--tx3)"}} className="mono">
              {total} total · page {page}/{pages}
            </span>
            <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
              <button className="pagBtn" disabled={page<=1} onClick={()=>goPage(1)}>«</button>
              <button className="pagBtn" disabled={page<=1} onClick={()=>goPage(page-1)}>‹</button>
              {Array.from({length:Math.min(5,pages)},(_,i)=>{
                const start = Math.max(1, Math.min(page-2, pages-4));
                const p = start+i;
                return p<=pages ? (
                  <button key={p} className={`pagBtn ${p===page?"pagActive":""}`} onClick={()=>goPage(p)}>{p}</button>
                ) : null;
              })}
              <button className="pagBtn" disabled={page>=pages} onClick={()=>goPage(page+1)}>›</button>
              <button className="pagBtn" disabled={page>=pages} onClick={()=>goPage(pages)}>»</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   DETAIL MODAL
───────────────────────────────────────────────────────────── */
function DetailModal({record, onClose}) {
  const r  = record;
  const ai = r.ai_response_json || {};
  const fmtDate = iso => { try { return new Date(iso).toLocaleString("en-US",{dateStyle:"full",timeStyle:"short"}); } catch{return iso;} };
  const scoreColor = s => s>=80?"var(--green)":s>=60?"var(--yellow)":"var(--red)";
  const textAI = r.type==="text"?ai.ai:null;
  const imgAI  = r.type==="image"?ai:null;
  const bd     = textAI?.breakdown||{};

  return (
    <div className="modalBackdrop" onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div className="modalBox">
        <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:22}}>
          <div>
            <div style={{fontFamily:"'Syne',sans-serif",fontWeight:800,fontSize:20,marginBottom:4}}>Analysis Detail</div>
            <div style={{fontSize:12,color:"var(--tx3)"}} className="mono">{fmtDate(r.created_at)} · ID: {r.id?.slice(0,8)}…</div>
          </div>
          <div style={{display:"flex",gap:8,flexShrink:0}}>
            <DownloadDropdown
              textResults={r.type==="text"?{score:r.qa_score,rules:ai.rules||{errors:[],warnings:[],info:[],secs:{},hardCap:false},ai:textAI||{},meta:{mod:r.modality,an:r.anatomy,prot:"—"}}:null}
              imgResult={r.type==="image"?imgAI:null}
              meta={{mod:r.modality,an:r.anatomy,prot:"—",hash:r.image_hash||"—"}}
            />
            <button className="btn btnG" style={{padding:"8px 14px",fontSize:13}} onClick={onClose}>
              <Ico n="x" s={14} c="var(--tx2)"/>Close
            </button>
          </div>
        </div>

        <div className="g4" style={{marginBottom:16}}>
          {[["Modality",r.modality||"—"],["Anatomy",r.anatomy||"—"],["Type",r.type||"—"],["Time",r.processing_time_ms?`${r.processing_time_ms}ms`:"—"]].map(([l,v])=>(
            <div key={l} style={{background:"rgba(0,0,0,.2)",borderRadius:10,padding:"10px 13px"}}>
              <div style={{fontSize:9,color:"var(--tx3)",textTransform:"uppercase",letterSpacing:".08em",marginBottom:4}}>{l}</div>
              <div style={{fontWeight:600,fontSize:13}}>{v}</div>
            </div>
          ))}
        </div>

        {r.qa_score!=null && (
          <div style={{display:"flex",alignItems:"center",gap:20,padding:"14px 18px",background:"rgba(0,0,0,.2)",borderRadius:12,marginBottom:14}}>
            <div style={{flexShrink:0}}>
              <div style={{fontSize:9,color:"var(--tx3)",textTransform:"uppercase",letterSpacing:".08em",marginBottom:3}}>QA Score</div>
              <div style={{fontFamily:"'Syne',sans-serif",fontWeight:800,fontSize:38,color:scoreColor(r.qa_score)}}>{r.qa_score}<span style={{fontSize:14,color:"var(--tx3)",fontWeight:400}}>/100</span></div>
            </div>
            {Object.keys(bd).length>0&&(
              <div style={{flex:1}}>
                {[["Completeness",bd.completeness,"var(--blue)"],["Technique",bd.technique,"var(--cyan)"],["Impression",bd.impression,"var(--purple)"],["Relevance",bd.clinical_relevance,"var(--green)"],["Compliance",bd.compliance,"var(--yellow)"]].map(([l,v,c])=>v!=null&&<ConfBar key={l} label={l} value={v} color={c}/>)}
              </div>
            )}
          </div>
        )}

        {r.type==="image" && imgAI && (
          <div style={{padding:"14px 18px",background:"rgba(6,182,212,.05)",border:"1px solid rgba(6,182,212,.15)",borderRadius:12,marginBottom:14}}>
            <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:10}}>
              <Ico n="img" s={14} c="var(--cyan)"/>
              <span style={{fontFamily:"'Syne',sans-serif",fontWeight:600,fontSize:14}}>Image Analysis</span>
            </div>
            <div className="g2">
              <div>
                <div style={{fontSize:11,color:"var(--tx3)",marginBottom:3}}>Condition</div>
                <div style={{fontWeight:600,fontSize:15,marginBottom:8}}>{imgAI.condition||"—"}</div>
                <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                  <span className={`badge ${imgAI.risk_level==="High"?"bRed":imgAI.risk_level==="Moderate"?"bYellow":"bGreen"}`}>{imgAI.risk_level} Risk</span>
                  <span className="badge bCyan mono">{Math.round((imgAI.confidence||0)*100)}% confidence</span>
                </div>
              </div>
              <div>{imgAI.findings?.slice(0,3).map((f,i)=>(
                <div key={i} style={{fontSize:12,color:"var(--tx2)",marginBottom:4,display:"flex",gap:5}}>
                  <span style={{color:"var(--cyan)"}}>▸</span>{f}
                </div>
              ))}</div>
            </div>
            {imgAI.explanation&&<p style={{fontSize:13,color:"var(--tx2)",marginTop:10,lineHeight:1.7}}>{imgAI.explanation}</p>}
          </div>
        )}

        {textAI?.structured_impression&&(
          <div style={{padding:"14px 18px",background:"rgba(139,92,246,.05)",border:"1px solid rgba(139,92,246,.15)",borderRadius:12,marginBottom:14}}>
            <div style={{fontSize:10,color:"var(--tx3)",textTransform:"uppercase",letterSpacing:".07em",marginBottom:6}}>AI Structured Impression</div>
            <p style={{fontSize:13.5,lineHeight:1.8,color:"var(--tx)"}}>{textAI.structured_impression}</p>
          </div>
        )}
        {textAI?.ai_insight&&(
          <div className="alert aBlue" style={{marginBottom:14}}>
            <Ico n="brain" s={14} c="var(--blue)"/>
            <span style={{fontSize:13,lineHeight:1.7}}>{textAI.ai_insight}</span>
          </div>
        )}

        {r.report_text&&(
          <div>
            <div style={{fontSize:10,color:"var(--tx3)",textTransform:"uppercase",letterSpacing:".08em",marginBottom:8}}>Full Report Text</div>
            <pre style={{background:"rgba(0,0,0,.3)",border:"1px solid var(--br2)",borderRadius:10,padding:14,
                         fontSize:12,lineHeight:1.8,color:"var(--tx2)",whiteSpace:"pre-wrap",wordBreak:"break-word",
                         maxHeight:200,overflowY:"auto",fontFamily:"'JetBrains Mono',monospace"}}>
              {r.report_text}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   CADUCEUS SVG
───────────────────────────────────────────────────────────── */
function CaduceusSVG() {
  return (
    <svg viewBox="0 0 200 460" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <rect x="97" y="88" width="6" height="330" rx="3"/>
      <circle cx="100" cy="38" r="18"/>
      <circle cx="100" cy="38" r="11" fill="#0D1526"/>
      <path d="M100 86 C100 86 68 64 22 74 C38 94 70 100 100 100 Z"/>
      <path d="M100 86 C100 86 132 64 178 74 C162 94 130 100 100 100 Z"/>
      <path d="M100 90 C76 76 46 70 22 74" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" opacity="0.55"/>
      <path d="M100 94 C78 84 54 80 34 82" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" opacity="0.38"/>
      <path d="M100 90 C124 76 154 70 178 74" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" opacity="0.55"/>
      <path d="M100 94 C122 84 146 80 166 82" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" opacity="0.38"/>
      <path d="M100 100 Q138 124 130 158 Q122 188 100 198 Q78 208 72 238 Q66 268 100 282 Q134 296 130 326 Q126 350 100 364" fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round"/>
      <path d="M100 100 Q62 124 70 158 Q78 188 100 198 Q122 208 128 238 Q134 268 100 282 Q66 296 70 326 Q74 350 100 364" fill="none" stroke="currentColor" strokeWidth="8" strokeLinecap="round"/>
      <ellipse cx="128" cy="376" rx="15" ry="10" transform="rotate(-22 128 376)"/>
      <ellipse cx="72"  cy="376" rx="15" ry="10" transform="rotate(22 72 376)"/>
      <circle cx="134" cy="372" r="2.8" fill="#0D1526"/>
      <circle cx="66"  cy="372" r="2.8" fill="#0D1526"/>
      <path d="M138 382 L145 389 M138 382 L144 378" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
      <path d="M62  382 L55  389 M62  382 L56  378" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
    </svg>
  );
}

/* ─────────────────────────────────────────────────────────────
   ICONS
───────────────────────────────────────────────────────────── */
const ICONS = {
  brain:    (s,c)=><svg width={s}height={s}viewBox="0 0 24 24"fill="none"stroke={c}strokeWidth="1.8"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96-.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.44-4.16Z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96-.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.44-4.16Z"/></svg>,
  scan:     (s,c)=><svg width={s}height={s}viewBox="0 0 24 24"fill="none"stroke={c}strokeWidth="1.8"><path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><line x1="7"y1="12"x2="17"y2="12"/></svg>,
  img:      (s,c)=><svg width={s}height={s}viewBox="0 0 24 24"fill="none"stroke={c}strokeWidth="1.8"><rect x="3"y="3"width="18"height="18"rx="2"/><circle cx="8.5"cy="8.5"r="1.5"/><path d="m21 15-5-5L5 21"/></svg>,
  chart:    (s,c)=><svg width={s}height={s}viewBox="0 0 24 24"fill="none"stroke={c}strokeWidth="1.8"><line x1="18"y1="20"x2="18"y2="10"/><line x1="12"y1="20"x2="12"y2="4"/><line x1="6"y1="20"x2="6"y2="14"/></svg>,
  alert:    (s,c)=><svg width={s}height={s}viewBox="0 0 24 24"fill="none"stroke={c}strokeWidth="1.8"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12"y1="9"x2="12"y2="13"/><line x1="12"y1="17"x2="12.01"y2="17"/></svg>,
  check:    (s,c)=><svg width={s}height={s}viewBox="0 0 24 24"fill="none"stroke={c}strokeWidth="2.5"><path d="M20 6 9 17l-5-5"/></svg>,
  x:        (s,c)=><svg width={s}height={s}viewBox="0 0 24 24"fill="none"stroke={c}strokeWidth="2.5"><line x1="18"y1="6"x2="6"y2="18"/><line x1="6"y1="6"x2="18"y2="18"/></svg>,
  sparkle:  (s,c)=><svg width={s}height={s}viewBox="0 0 24 24"fill="none"stroke={c}strokeWidth="1.8"><path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z"/><path d="M19 3l.5 1.5L21 5l-1.5.5L19 7l-.5-1.5L17 5l1.5-.5z"/></svg>,
  upload:   (s,c)=><svg width={s}height={s}viewBox="0 0 24 24"fill="none"stroke={c}strokeWidth="1.8"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12"y1="3"x2="12"y2="15"/></svg>,
  logout:   (s,c)=><svg width={s}height={s}viewBox="0 0 24 24"fill="none"stroke={c}strokeWidth="1.8"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21"y1="12"x2="9"y2="12"/></svg>,
  doc:      (s,c)=><svg width={s}height={s}viewBox="0 0 24 24"fill="none"stroke={c}strokeWidth="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>,
  download: (s,c)=><svg width={s}height={s}viewBox="0 0 24 24"fill="none"stroke={c}strokeWidth="1.8"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12"y1="15"x2="12"y2="3"/></svg>,
  info:     (s,c)=><svg width={s}height={s}viewBox="0 0 24 24"fill="none"stroke={c}strokeWidth="1.8"><circle cx="12"cy="12"r="10"/><line x1="12"y1="16"x2="12"y2="12"/><line x1="12"y1="8"x2="12.01"y2="8"/></svg>,
  shield:   (s,c)=><svg width={s}height={s}viewBox="0 0 24 24"fill="none"stroke={c}strokeWidth="1.8"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  zap:      (s,c)=><svg width={s}height={s}viewBox="0 0 24 24"fill="none"stroke={c}strokeWidth="1.8"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>,
  db:       (s,c)=><svg width={s}height={s}viewBox="0 0 24 24"fill="none"stroke={c}strokeWidth="1.8"><ellipse cx="12"cy="5"rx="9"ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>,
  hash:     (s,c)=><svg width={s}height={s}viewBox="0 0 24 24"fill="none"stroke={c}strokeWidth="1.8"><line x1="4"y1="9"x2="20"y2="9"/><line x1="4"y1="15"x2="20"y2="15"/><line x1="10"y1="3"x2="8"y2="21"/><line x1="16"y1="3"x2="14"y2="21"/></svg>,
  mail:     (s,c)=><svg width={s}height={s}viewBox="0 0 24 24"fill="none"stroke={c}strokeWidth="1.8"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>,
  share:    (s,c)=><svg width={s}height={s}viewBox="0 0 24 24"fill="none"stroke={c}strokeWidth="1.8"><circle cx="18"cy="5"r="3"/><circle cx="6"cy="12"r="3"/><circle cx="18"cy="19"r="3"/><line x1="8.59"y1="13.51"x2="15.42"y2="17.49"/><line x1="15.41"y1="6.51"x2="8.59"y2="10.49"/></svg>,
  excel:    (s,c)=><svg width={s}height={s}viewBox="0 0 24 24"fill="none"stroke={c}strokeWidth="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8"y1="13"x2="16"y2="13"/><line x1="8"y1="17"x2="16"y2="17"/></svg>,
  pdf:      (s,c)=><svg width={s}height={s}viewBox="0 0 24 24"fill="none"stroke={c}strokeWidth="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><path d="M9 15h2a2 2 0 0 0 0-4H9v6"/></svg>,
  phone:    (s,c)=><svg width={s}height={s}viewBox="0 0 24 24"fill="none"stroke={c}strokeWidth="1.8"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 2.18L6.6 2a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.6 9.91a16 16 0 0 0 6.29 6.29l1.28-1.28a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>,
  template: (s,c)=><svg width={s}height={s}viewBox="0 0 24 24"fill="none"stroke={c}strokeWidth="1.8"><rect x="3"y="3"width="18"height="18"rx="2"/><line x1="3"y1="9"x2="21"y2="9"/><line x1="9"y1="21"x2="9"y2="9"/></svg>,
  chevron:  (s,c)=><svg width={s}height={s}viewBox="0 0 24 24"fill="none"stroke={c}strokeWidth="2"><polyline points="6 9 12 15 18 9"/></svg>,
  search:   (s,c)=><svg width={s}height={s}viewBox="0 0 24 24"fill="none"stroke={c}strokeWidth="1.8"><circle cx="11"cy="11"r="8"/><line x1="21"y1="21"x2="16.65"y2="16.65"/></svg>,
  history:  (s,c)=><svg width={s}height={s}viewBox="0 0 24 24"fill="none"stroke={c}strokeWidth="1.8"><polyline points="12 8 12 12 14 14"/><path d="M3.05 11a9 9 0 1 0 .5-4.5"/><polyline points="3 3 3 9 9 9"/></svg>,
  users:    (s,c)=><svg width={s}height={s}viewBox="0 0 24 24"fill="none"stroke={c}strokeWidth="1.8"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9"cy="7"r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
  refresh:  (s,c)=><svg width={s}height={s}viewBox="0 0 24 24"fill="none"stroke={c}strokeWidth="1.8"><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>,
};
const Ico = ({n,s=18,c="currentColor"}) => ICONS[n]?ICONS[n](s,c):null;

/* ─────────────────────────────────────────────────────────────
   SCORE RING
───────────────────────────────────────────────────────────── */
function ScoreRing({score,size=130}) {
  const R=50,circ=2*Math.PI*R,col=score>=80?"#10B981":score>=60?"#F59E0B":"#EF4444";
  return (
    <div style={{position:"relative",width:size,height:size,flexShrink:0}}>
      <svg width={size}height={size}viewBox="0 0 120 120">
        <circle cx={60}cy={60}r={R}fill="none"stroke="rgba(255,255,255,.04)"strokeWidth={8}/>
        <circle cx={60}cy={60}r={R}fill="none"stroke={col}strokeWidth={8}opacity={.13}strokeDasharray={circ}transform="rotate(-90 60 60)"/>
        <circle cx={60}cy={60}r={R}fill="none"stroke={col}strokeWidth={8}strokeLinecap="round"
          strokeDasharray={circ}strokeDashoffset={circ*(1-score/100)}transform="rotate(-90 60 60)"
          style={{transition:"stroke-dashoffset 1.4s cubic-bezier(.16,1,.3,1)"}}/>
      </svg>
      <div style={{position:"absolute",inset:0,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
        fontFamily:"'Syne',sans-serif",fontWeight:800,fontSize:36,color:col}}>
        {score}
        <span style={{fontSize:11,color:"var(--tx3)",fontFamily:"'Inter',sans-serif",fontWeight:400,marginTop:2}}>/100</span>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   CONF BAR
───────────────────────────────────────────────────────────── */
function ConfBar({label,value,color="var(--blue)"}) {
  return (
    <div style={{marginBottom:9}}>
      <div style={{display:"flex",justifyContent:"space-between",fontSize:12,marginBottom:5}}>
        <span style={{color:"var(--tx2)"}}>{label}</span>
        <span style={{color,fontFamily:"'JetBrains Mono',monospace"}}>{value}%</span>
      </div>
      <div className="pTrack">
        <div className="pFill" style={{width:`${value}%`,background:`linear-gradient(90deg,${color}44,${color})`}}/>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   EXPAND
───────────────────────────────────────────────────────────── */
function Expand({title,icon,badge,children,open:def=true}) {
  const [open,setOpen]=useState(def);
  return (
    <div className="card" style={{padding:20,marginBottom:10}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",cursor:"pointer"}} onClick={()=>setOpen(o=>!o)}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>{icon}<span style={{fontFamily:"'Syne',sans-serif",fontWeight:600,fontSize:14}}>{title}</span>{badge}</div>
        <span style={{color:"var(--tx3)",fontSize:20,lineHeight:1,userSelect:"none"}}>{open?"−":"+"}</span>
      </div>
      {open&&<div style={{marginTop:13}}>{children}</div>}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   SKELETON LOADERS
───────────────────────────────────────────────────────────── */
function SkeletonQA() {
  return (
    <div className="fi">
      <div className="card glowCard" style={{padding:26,marginBottom:12}}>
        <div style={{display:"flex",gap:24,alignItems:"center"}}>
          <div className="sk skCircle"/>
          <div style={{flex:1}}>
            <div className="sk sk22" style={{width:"44%"}}/>
            {[90,78,84,68,80].map((w,i)=>(
              <div key={i} style={{marginBottom:10}}>
                <div className="sk sk16" style={{width:`${w}%`}}/><div className="sk" style={{height:5,width:"100%"}}/>
              </div>
            ))}
          </div>
        </div>
      </div>
      {[1,2,3].map(i=>(
        <div key={i} className="card" style={{padding:20,marginBottom:10}}>
          <div className="sk sk22" style={{width:"38%"}}/>
          {[88,74,62].map((w,j)=><div key={j} className="sk sk16" style={{width:`${w}%`}}/>)}
        </div>
      ))}
    </div>
  );
}

function SkeletonImage() {
  return (
    <div className="card fi" style={{padding:22}}>
      <div className="sk sk22" style={{width:"50%"}}/>
      <div className="g2" style={{marginTop:14}}>
        {[[80,62,90],[70,85,56]].map((ws,i)=>(
          <div key={i}>{ws.map((w,j)=><div key={j} className="sk sk16" style={{width:`${w}%`,marginBottom:10}}/>)}</div>
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   UPDATE 1: REQUIRED SECTIONS STATUS BAR
───────────────────────────────────────────────────────────── */
function SectionStatusBar({secs}) {
  const items = [
    {key:"history",    label:"History"},
    {key:"technique",  label:"Technique"},
    {key:"findings",   label:"Findings"},
    {key:"impression", label:"Impression"},
  ];
  return (
    <div className="secStatusBar">
      <span style={{fontSize:11,color:"var(--tx3)",fontWeight:600,alignSelf:"center",marginRight:4,fontFamily:"'Syne',sans-serif"}}>
        Required Sections:
      </span>
      {items.map(({key,label})=>(
        <span key={key} className={`secStatusItem ${secs[key]?"secOk":"secMissing"}`}>
          {secs[key]?"✔":"✗"} {label}
        </span>
      ))}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   DOWNLOAD DROPDOWN — UPDATE 2
───────────────────────────────────────────────────────────── */
function DownloadDropdown({textResults, imgResult, meta, disabled}) {
  const [open,setOpen]=useState(false);
  const [busy,setBusy]=useState("");
  const ref=useRef(null);
  useEffect(()=>{
    const h=(e)=>{ if(ref.current&&!ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown",h); return()=>document.removeEventListener("mousedown",h);
  },[]);

  const run=async(type)=>{
    setOpen(false); setBusy(type);
    try {
      if (type==="pdf")   await exportPDF(textResults,imgResult,meta);
      if (type==="excel") await exportExcel(textResults,imgResult,meta);
      if (type==="json")  exportJSON(textResults,imgResult,meta);
    } catch(e){alert("Export failed: "+e.message);}
    setBusy("");
  };

  return (
    <div className="dropMenu" ref={ref}>
      <button className="btn btnG" disabled={disabled||!!busy} onClick={()=>setOpen(o=>!o)}>
        {busy?<svg width={14}height={14}viewBox="0 0 24 24"fill="none"stroke="currentColor"strokeWidth="2.5"className="spin"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>:<Ico n="download" s={14} c="var(--tx2)"/>}
        {busy?`Generating ${busy.toUpperCase()}…`:"Export"} <Ico n="chevron" s={12} c="var(--tx3)"/>
      </button>
      {open&&(
        <div className="dropMenuList fi">
          <button className="dropMenuItem" onClick={()=>run("pdf")}>
            <Ico n="pdf" s={14} c="var(--red)"/>Export as PDF
          </button>
          <button className="dropMenuItem" onClick={()=>run("excel")}>
            <Ico n="excel" s={14} c="var(--green)"/>Export as Excel (.xlsx)
          </button>
          <button className="dropMenuItem" onClick={()=>run("json")}>
            <Ico n="doc" s={14} c="var(--blue)"/>Export as JSON
          </button>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   SHARE PANEL — UPDATE 3
───────────────────────────────────────────────────────────── */
function SharePanel({textResults, imgResult, meta}) {
  const [emailTo,  setEmailTo]  = useState("");
  const [phone,    setPhone]    = useState("");
  const [emailMsg, setEmailMsg] = useState("");
  const [waMsg,    setWaMsg]    = useState("");

  const doEmail = () => {
    if (!emailTo.includes("@")) { setEmailMsg("⚠ Enter a valid email address."); return; }
    shareViaEmail(emailTo, textResults, imgResult, meta);
    setEmailMsg("✅ Email client opened — verify details and send.");
  };
  const doWA = () => {
    if (!phone||phone.replace(/\D/g,"").length<7) { setWaMsg("⚠ Enter a valid phone number with country code."); return; }
    shareViaWhatsApp(phone, textResults, imgResult, meta);
    setWaMsg("✅ WhatsApp opened — report link expires in 24 h.");
  };

  return (
    <div className="sharePanel fi">
      <div style={{fontFamily:"'Syne',sans-serif",fontWeight:700,fontSize:15,marginBottom:18,display:"flex",alignItems:"center",gap:8}}>
        <Ico n="share" s={16} c="var(--cyan)"/>Share Report
      </div>
      <div className="g2">
        {/* Email */}
        <div>
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:10}}>
            <Ico n="mail" s={14} c="var(--blue)"/>
            <span style={{fontFamily:"'Syne',sans-serif",fontWeight:600,fontSize:13}}>Email Report</span>
          </div>
          <label>Recipient Email</label>
          <input type="email" value={emailTo} onChange={e=>setEmailTo(e.target.value)}
            placeholder="doctor@hospital.com" style={{marginBottom:8}}/>
          <button className="btn btnG" onClick={doEmail} disabled={!textResults}
            style={{width:"100%",justifyContent:"center",padding:"10px 0"}}>
            <Ico n="mail" s={13} c="var(--blue)"/>Send via Email
          </button>
          {emailMsg&&<p style={{fontSize:11,marginTop:7,color:emailMsg.startsWith("✅")?"var(--green)":"var(--yellow)"}}>{emailMsg}</p>}
          <p style={{fontSize:10,color:"var(--tx3)",marginTop:5}}>Opens your mail client with report pre-filled.</p>
        </div>
        {/* WhatsApp */}
        <div>
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:10}}>
            <Ico n="phone" s={14} c="#25d366"/>
            <span style={{fontFamily:"'Syne',sans-serif",fontWeight:600,fontSize:13}}>WhatsApp</span>
          </div>
          <label>Phone Number (with country code)</label>
          <input type="tel" value={phone} onChange={e=>setPhone(e.target.value)}
            placeholder="+1 555 000 0000" style={{marginBottom:8}}/>
          <button className="btn btnWA" onClick={doWA} disabled={!textResults}
            style={{width:"100%",justifyContent:"center",padding:"10px 0"}}>
            <svg width={13}height={13}viewBox="0 0 24 24"fill="#25d366"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M11.976 0C5.372 0 .013 5.359.013 11.963c0 2.102.548 4.127 1.585 5.913L0 24l6.317-1.567A11.93 11.93 0 0 0 11.976 24c6.602 0 11.96-5.358 11.96-11.963S18.578 0 11.976 0zm0 21.856a9.897 9.897 0 0 1-5.048-1.383l-.362-.215-3.748.93.969-3.65-.235-.374A9.827 9.827 0 0 1 2.057 11.963C2.057 6.467 6.48 2.044 11.976 2.044c5.495 0 9.919 4.423 9.919 9.919s-4.424 9.893-9.919 9.893z"/></svg>
            Share via WhatsApp
          </button>
          {waMsg&&<p style={{fontSize:11,marginTop:7,color:waMsg.startsWith("✅")?"var(--green)":"var(--yellow)"}}>{waMsg}</p>}
          <p style={{fontSize:10,color:"var(--tx3)",marginTop:5}}>Link expires in 24 h. Requires WhatsApp on device.</p>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   PRO 2.0 SUB-COMPONENTS
───────────────────────────────────────────────────────────── */
function AutoFixBox({text}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(text).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),1800);});
  };
  return (
    <div className="autoFix" onClick={copy} title="Click to copy auto-fix text">
      <div style={{flex:1}}>
        <div className="autoFixLabel">{copied?"✓ Copied!":"⚡ Auto-Fix (click to copy)"}</div>
        <div style={{lineHeight:1.65,fontSize:12}}>{text}</div>
      </div>
      <span style={{flexShrink:0,fontSize:14,opacity:.7}}>{copied?"✓":"⎘"}</span>
    </div>
  );
}

function IssueCard({item}) {
  const svClass = item.severity==="High Impact"?"svHigh":item.severity==="Moderate"?"svMod":"svDoc";
  const lblClass = item.severity==="High Impact"?"svLabelHigh":item.severity==="Moderate"?"svLabelMod":"svLabelDoc";
  return (
    <div className={svClass}>
      <span className={`svLabel ${lblClass}`}>{item.severity}</span>
      <div style={{fontWeight:600,fontSize:13,marginBottom:4}}>{item.issue}</div>
      {item.explanation&&<p style={{fontSize:12,color:"var(--tx2)",lineHeight:1.6,marginBottom:item.auto_fix_text?6:0}}>{item.explanation}</p>}
      {item.auto_fix_text&&<AutoFixBox text={item.auto_fix_text}/>}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   TEXT QA MODULE — with all updates
───────────────────────────────────────────────────────────── */
function TextQAModule({user, onResults, imgResult}) {
  const [mod,     setMod]     = useState("CT");
  const [an,      setAn]      = useState("Chest");
  const [prot,    setProt]    = useState("Without Contrast");
  const [report,  setReport]  = useState(SAMPLE);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState(null);
  const [combErr, setCombErr] = useState("");
  const [showShare,setShowShare]=useState(false);
  const resRef = useRef(null);

  // Live section detection
  const liveSecs = detectSections(report);

  const checkCombo = (m,a) =>
    setCombErr(BAD_COMBOS.some(([bm,ba])=>bm===m&&ba===a)?`⚠ Invalid combination: ${m} + ${a}`:"");

  const chMod = v=>{setMod(v);checkCombo(v,an);};
  const chAn  = v=>{setAn(v);checkCombo(mod,v);};

  // INSERT TEMPLATE for missing sections
  const insertTemplate = () => {
    const tpl = buildTemplate(liveSecs);
    if (!tpl.trim()) return;
    setReport(r => (r.trim()?r+"\n\n":"")+tpl.trim());
  };

  const analyze = async() => {
    if (combErr||!report.trim()) return;
    setLoading(true); setResults(null);
    try {
      const out = await runTextAnalysisWithDB(mod, an, prot, report, user);
      setResults(out);
      onResults?.(out);
      setTimeout(()=>resRef.current?.scrollIntoView({behavior:"smooth",block:"start"}),120);
    } catch(err) {
      toast("Analysis temporarily unavailable: "+err.message, "error");
      setResults({error:"Analysis temporarily unavailable. ("+err.message+")"});
    }
    setLoading(false);
  };

  const status = !results?.score?null:
    results.score>=85?{lbl:"Ready for Sign-Off",cls:"bGreen",dot:"var(--green)"}:
    results.score>=65?{lbl:"Needs Review",cls:"bYellow",dot:"var(--yellow)"}:
                     {lbl:"Requires Revision",cls:"bRed",dot:"var(--red)"};

  // Pro 2.0 derived blocks for rendering
  const ai        = results?.ai;
  const cs        = ai?.compliance_score;
  const si        = ai?.structured_impression;
  const staging   = ai?.ai_staging_assistant;
  const riskEng   = ai?.risk_escalation_engine;
  const timerPanel= ai?.dynamic_triage_timer;
  const triage    = timerPanel?.urgency_level;
  const jb        = ai?.ai_clinical_justification_block;
  const mc        = ai?.model_confidence;
  const aiCI      = ai?.critical_issues   || [];
  const aiRV      = ai?.rule_violations   || [];
  const aiIS      = ai?.improvement_suggestions || [];
  // Legacy compat
  const bd = cs ? { completeness:cs.completeness, technique:cs.completeness, impression:cs.impression_consistency, clinical_relevance:cs.impression_consistency, compliance:cs.terminology_standardization } : {};
  const missingCount = Object.values(liveSecs).filter(v=>!v).length;

  return (
    <div className="fu">
      <div className="secTitle"><Ico n="doc" s={20} c="var(--blue)"/>Text-Based Radiology QA</div>
      <p className="secSub">MedVision AI Pro 2.0 · 9-block clinical schema · Severity tagging · Auto-fix · TNM staging · Risk escalation · temperature=0</p>

      {/* UPDATE 1: Live section status bar */}
      <SectionStatusBar secs={liveSecs}/>

      {/* Cap warning */}
      {(!liveSecs.history||!liveSecs.technique) && (
        <div className="capWarn">
          <Ico n="alert" s={16} c="var(--yellow)"/>
          <div>
            <strong style={{fontSize:13}}>Score Cap Active</strong>
            <p style={{fontSize:12,color:"var(--tx2)",marginTop:2}}>
              {!liveSecs.history&&"Clinical History is missing. "}{!liveSecs.technique&&"Technique section is missing. "}
              Final QA score will be capped at <strong>70/100</strong> until these sections are added.
            </p>
            <button className="btn btnG" style={{marginTop:8,padding:"6px 12px",fontSize:12}} onClick={insertTemplate}>
              <Ico n="template" s={12} c="var(--yellow)"/>Insert Missing Templates
            </button>
          </div>
        </div>
      )}

      {/* Metadata */}
      <div className="card" style={{padding:22,marginBottom:14}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:15}}>
          <Ico n="scan" s={15} c="var(--blue)"/>
          <span style={{fontFamily:"'Syne',sans-serif",fontWeight:600,fontSize:13}}>Study Metadata</span>
          <span style={{marginLeft:"auto",fontSize:11,color:"var(--tx3)"}} className="mono">cache: {cacheSize()} entries</span>
        </div>
        <div className="g3">
          <div><label>Modality</label><select value={mod} onChange={e=>chMod(e.target.value)}>{MODS.map(m=><option key={m}>{m}</option>)}</select></div>
          <div><label>Anatomy</label><select value={an} onChange={e=>chAn(e.target.value)}>{ANATS.map(a=><option key={a}>{a}</option>)}</select></div>
          <div><label>Protocol</label><select value={prot} onChange={e=>setProt(e.target.value)}>{PROTS.map(p=><option key={p}>{p}</option>)}</select></div>
        </div>
        {combErr&&<div className="alert aRed" style={{marginTop:10}}><Ico n="alert" s={13} c="var(--red)"/>{combErr}</div>}
      </div>

      {/* Report input */}
      <div className="card" style={{padding:22,marginBottom:18}}>
        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:13}}>
          <Ico n="doc" s={15} c="var(--blue)"/>
          <span style={{fontFamily:"'Syne',sans-serif",fontWeight:600,fontSize:13}}>Draft Radiology Report</span>
          <span style={{marginLeft:"auto",fontSize:11,color:"var(--tx3)"}} className="mono">{report.trim().split(/\s+/).filter(Boolean).length} words</span>
          {missingCount>0&&<span className="badge bYellow">{missingCount} section{missingCount>1?"s":""} missing</span>}
        </div>
        <textarea value={report} onChange={e=>setReport(e.target.value)} placeholder="Paste draft report…"/>
        <div style={{display:"flex",justifyContent:"flex-end",gap:8,marginTop:13,flexWrap:"wrap"}}>
          <button className="btn btnG" onClick={()=>{setReport("");setResults(null);onResults?.(null);setShowShare(false);}}>Clear</button>
          <button className="btn btnP" onClick={analyze} disabled={loading||!!combErr||!report.trim()}>
            <Ico n="sparkle" s={15} c="white"/>Analyze Report
          </button>
        </div>
      </div>

      {loading&&<SkeletonQA/>}

      {!loading&&results&&!results.error&&(
        <div ref={resRef} className="fu">
          {/* ═══════════════════════════════════════════════════
              PRO 2.0 — SCORE HEADER
          ═══════════════════════════════════════════════════ */}
          <div className="card glowCard" style={{padding:26,marginBottom:14,background:"linear-gradient(135deg,rgba(59,130,246,.07),rgba(30,41,59,.97))"}}>
            <div style={{display:"flex",gap:24,alignItems:"flex-start",flexWrap:"wrap"}}>
              <ScoreRing score={results.score}/>
              <div style={{flex:1,minWidth:220}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10,flexWrap:"wrap"}}>
                  <span style={{fontFamily:"'Syne',sans-serif",fontWeight:800,fontSize:18}}>QA Score</span>
                  <span className={`badge ${status.cls}`}>
                    <span style={{width:5,height:5,borderRadius:"50%",background:status.dot,display:"inline-block"}}/>
                    {status.lbl}
                  </span>
                  <span className="pro20Badge">PRO 2.0</span>
                  {results.ai._cached&&<span className="cacheBadge"><Ico n="db" s={10} c="var(--green)"/>Cache Hit</span>}
                  <span className="hashBadge"><Ico n="hash" s={10} c="var(--purple)"/>SHA-256: {results.ai._hash}</span>
                </div>
                {results.rules.hardCap&&(
                  <div className="alert aYellow" style={{marginBottom:10}}>
                    <Ico n="alert" s={13} c="var(--yellow)"/>
                    <strong>Score capped at 70</strong> — add Clinical History and/or Technique to remove cap
                  </div>
                )}
                {results.score>=90&&(
                  <div className="alert aGreen" style={{marginBottom:10}}>
                    <Ico n="check" s={14} c="var(--green)"/><strong>Ready for Final Clinical Sign-Off</strong>
                  </div>
                )}
                {/* Pro 2.0 compliance sub-scores */}
                {cs&&(
                  <>
                    <ConfBar label="Completeness"             value={cs.completeness??0}                color="var(--blue)"/>
                    <ConfBar label="Impression Consistency"   value={cs.impression_consistency??0}      color="var(--purple)"/>
                    <ConfBar label="Terminology Standardization" value={cs.terminology_standardization??0} color="var(--cyan)"/>
                    {cs.explanation&&<p style={{fontSize:11,color:"var(--tx3)",marginTop:6,lineHeight:1.65,fontStyle:"italic"}}>{cs.explanation}</p>}
                  </>
                )}
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:8,alignSelf:"flex-start",minWidth:140}}>
                <DownloadDropdown textResults={results} imgResult={imgResult} meta={results.meta}/>
                <button className="btn btnGreen" onClick={()=>setShowShare(s=>!s)}>
                  <Ico n="share" s={13} c="var(--green)"/>Share Report
                </button>
                {/* Triage chip */}
                {triage&&(
                  <div className={`triageChip ${triage==="Immediate"?"triageImmediate":triage==="Urgent"?"triageUrgent":triage==="Priority"?"triagePriority":"triageRoutine"}`}>
                    <span style={{fontSize:10}}>⏱</span>{triage}
                  </div>
                )}
                {mc?.confidence_percentage!=null&&(
                  <div>
                    <div style={{fontSize:9,color:"var(--tx3)",textTransform:"uppercase",letterSpacing:".07em",marginBottom:4}}>Model Confidence</div>
                    <div className="confMeter">
                      <div className="confFill" style={{width:`${mc.confidence_percentage}%`,background:mc.confidence_percentage>=75?"var(--green)":mc.confidence_percentage>=50?"var(--yellow)":"var(--red)"}}/>
                    </div>
                    <div style={{fontSize:11,color:"var(--tx2)",marginTop:4,fontFamily:"'JetBrains Mono',monospace"}}>{mc.confidence_percentage}%</div>
                    {mc.low_confidence_alert&&<div style={{fontSize:10,color:"var(--yellow)",marginTop:4}}>{mc.low_confidence_alert}</div>}
                    {mc.overconfidence_alert&&<div style={{fontSize:10,color:"var(--orange)",marginTop:4}}>{mc.overconfidence_alert}</div>}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Section status bar */}
          <SectionStatusBar secs={results.rules.secs}/>

          {/* Meta strip */}
          <div style={{display:"flex",gap:7,marginBottom:14,alignItems:"center",flexWrap:"wrap"}}>
            <span className="badge bPurple mono">temperature=0</span>
            <span className="badge bBlue  mono">{results.rules.errors.length+results.rules.warnings.length} rule alerts</span>
            <span className="badge bCyan  mono">{results.rules.info.length} style flags</span>
            {results.rules.hardCap&&<span className="badge bYellow mono">⚠ cap: ≤70</span>}
            {riskEng?.escalation_required&&<span className="badge bRed">🚨 ESCALATION REQUIRED</span>}
            <span style={{fontSize:11,color:"var(--tx3)",marginLeft:"auto"}}>{results.ai._cached?"⚡ from cache":"✓ fresh — cached 24 h"}</span>
          </div>

          {/* ═══════════════════════════════════════════════════
              PANEL 1 — RISK ESCALATION ENGINE
          ═══════════════════════════════════════════════════ */}
          {riskEng&&(riskEng.risk_category!=="Low"||riskEng.escalation_required)&&(
            <div className="card" style={{padding:20,marginBottom:12,borderColor:riskEng.escalation_required?"rgba(239,68,68,.4)":"rgba(245,158,11,.3)",background:riskEng.escalation_required?"rgba(239,68,68,.04)":"rgba(245,158,11,.03)"}}>
              <div style={{display:"flex",alignItems:"center",gap:9,marginBottom:12}}>
                <Ico n="alert" s={16} c={riskEng.escalation_required?"var(--red)":"var(--yellow)"}/>
                <span style={{fontFamily:"'Syne',sans-serif",fontWeight:700,fontSize:14}}>Risk Escalation Engine</span>
                <span className={`badge ${riskEng.risk_category==="High"?"bRed":riskEng.risk_category==="Intermediate"?"bYellow":"bGreen"}`}>
                  {riskEng.risk_category} Risk
                </span>
                {riskEng.escalation_required&&<span className="badge bRed" style={{marginLeft:4}}>🚨 Escalate</span>}
              </div>
              <div style={{display:"flex",gap:20,alignItems:"center",flexWrap:"wrap"}}>
                <div style={{minWidth:120}}>
                  <div style={{fontSize:9,color:"var(--tx3)",textTransform:"uppercase",letterSpacing:".08em",marginBottom:4}}>Malignancy Risk</div>
                  <div style={{fontFamily:"'Syne',sans-serif",fontWeight:800,fontSize:30,color:riskEng.malignancy_risk_percentage>=70?"var(--red)":riskEng.malignancy_risk_percentage>=30?"var(--yellow)":"var(--green)"}}>{riskEng.malignancy_risk_percentage}<span style={{fontSize:14,fontWeight:400}}>%</span></div>
                  <div className="riskGauge"><div className="riskFill" style={{width:`${riskEng.malignancy_risk_percentage}%`,background:riskEng.malignancy_risk_percentage>=70?"var(--red)":riskEng.malignancy_risk_percentage>=30?"var(--yellow)":"var(--green)"}}/></div>
                </div>
                <div style={{flex:1,minWidth:160}}>
                  <div style={{fontSize:10,color:"var(--tx3)",textTransform:"uppercase",letterSpacing:".07em",marginBottom:5}}>Recommended Action</div>
                  <p style={{fontSize:13,color:"var(--tx)",lineHeight:1.65}}>{riskEng.recommended_action||"—"}</p>
                </div>
              </div>
            </div>
          )}

          {/* ═══════════════════════════════════════════════════
              PANEL 2 — CRITICAL ISSUES (AI Pro 2.0)
          ═══════════════════════════════════════════════════ */}
          {(results.rules.errors.length>0||aiCI.length>0)&&(
            <Expand
              title="Critical Issues"
              badge={<span className="badge bRed">{results.rules.errors.length+aiCI.length}</span>}
              icon={<Ico n="x" s={14} c="var(--red)"/>}
            >
              {results.rules.errors.map((e,i)=>(
                <div key={`re${i}`} className="svHigh">
                  <span className="svLabel svLabelHigh">HIGH IMPACT · Rule Engine</span>
                  <div style={{fontWeight:600,fontSize:13,marginBottom:3}}>{e}</div>
                </div>
              ))}
              {aiCI.map((ci,i)=>(
                <IssueCard key={`ci${i}`} item={ci}/>
              ))}
            </Expand>
          )}

          {/* ═══════════════════════════════════════════════════
              PANEL 3 — RULE VIOLATIONS (AI Pro 2.0)
          ═══════════════════════════════════════════════════ */}
          {(results.rules.warnings.length>0||aiRV.length>0)&&(
            <Expand
              title="Rule Violations"
              badge={<span className="badge bYellow">{results.rules.warnings.length+aiRV.length}</span>}
              icon={<Ico n="alert" s={14} c="var(--yellow)"/>}
              open={false}
            >
              {results.rules.warnings.map((w,i)=>(
                <div key={`rw${i}`} className="svMod">
                  <span className="svLabel svLabelMod">MODERATE · Rule Engine</span>
                  <div style={{fontSize:13,color:"var(--tx2)"}}>{w}</div>
                </div>
              ))}
              {aiRV.map((rv,i)=>(
                <IssueCard key={`rv${i}`} item={rv}/>
              ))}
            </Expand>
          )}

          {/* ═══════════════════════════════════════════════════
              PANEL 4 — IMPROVEMENT SUGGESTIONS
          ═══════════════════════════════════════════════════ */}
          {(results.rules.info.length>0||aiIS.length>0)&&(
            <Expand
              title="Improvement Suggestions"
              badge={<span className="badge bBlue">{results.rules.info.length+aiIS.length}</span>}
              icon={<Ico n="zap" s={14} c="var(--blue)"/>}
              open={false}
            >
              {results.rules.info.map((w,i)=>(
                <div key={`ri${i}`} className="svDoc">
                  <span className="svLabel svLabelDoc">DOCUMENTATION</span>
                  <div style={{fontSize:13,color:"var(--tx2)"}}>{w}</div>
                </div>
              ))}
              {aiIS.map((is,i)=>(
                <div key={`is${i}`} className="svDoc">
                  <span className="svLabel svLabelDoc">SUGGESTION</span>
                  <div style={{fontSize:13,color:"var(--tx2)",marginBottom:is.auto_fix_text?6:0}}>{is.suggestion}</div>
                  {is.auto_fix_text&&<AutoFixBox text={is.auto_fix_text}/>}
                </div>
              ))}
            </Expand>
          )}

          {/* ═══════════════════════════════════════════════════
              PANEL 5 — STRUCTURED IMPRESSION (Pro 2.0)
          ═══════════════════════════════════════════════════ */}
          {si?.text&&(
            <Expand
              title="AI Structured Impression"
              badge={<span className="badge bPurple">Pro 2.0 · temp=0</span>}
              icon={<Ico n="sparkle" s={14} c="var(--purple)"/>}
            >
              <div style={{background:"rgba(139,92,246,.06)",border:"1px solid rgba(139,92,246,.18)",borderRadius:10,padding:17,fontSize:14,lineHeight:1.85,fontStyle:"italic"}}>
                {si.text}
              </div>
              <div style={{display:"flex",gap:8,marginTop:8,flexWrap:"wrap",alignItems:"center"}}>
                {si.guideline_aligned
                  ? <span className="badge bGreen"><Ico n="check" s={10} c="var(--green)"/>Guideline-aligned</span>
                  : <span className="badge bYellow"><Ico n="alert" s={10} c="var(--yellow)"/>Review guideline alignment</span>}
                <span style={{fontSize:10,color:"var(--tx3)"}}>⚕ AI-generated at temperature=0 — verify before sign-off</span>
              </div>
            </Expand>
          )}

          {/* ═══════════════════════════════════════════════════
              PANEL 6 — AI STAGING ASSISTANT
          ═══════════════════════════════════════════════════ */}
          {staging?.activated&&(
            <Expand
              title="AI Staging Assistant"
              badge={<span className="badge bCyan">TNM</span>}
              icon={<Ico n="scan" s={14} c="var(--cyan)"/>}
            >
              <div style={{padding:"14px 18px",background:"rgba(6,182,212,.05)",border:"1px solid rgba(6,182,212,.18)",borderRadius:12}}>
                <div className="g2">
                  <div>
                    <div style={{fontSize:10,color:"var(--tx3)",textTransform:"uppercase",letterSpacing:".08em",marginBottom:6}}>Suspected TNM Staging</div>
                    {staging.suspected_TNM&&<div className="tnmBadge">{staging.suspected_TNM}</div>}
                    {staging.lymph_node_station_standardized&&(
                      <div style={{marginTop:10}}>
                        <div style={{fontSize:10,color:"var(--tx3)",textTransform:"uppercase",letterSpacing:".08em",marginBottom:4}}>Lymph Node Station</div>
                        <div style={{fontSize:13,color:"var(--tx2)"}}>{staging.lymph_node_station_standardized}</div>
                      </div>
                    )}
                  </div>
                  <div>
                    {staging.staging_explanation&&(
                      <>
                        <div style={{fontSize:10,color:"var(--tx3)",textTransform:"uppercase",letterSpacing:".08em",marginBottom:6}}>Staging Rationale</div>
                        <p style={{fontSize:13,color:"var(--tx2)",lineHeight:1.7}}>{staging.staging_explanation}</p>
                      </>
                    )}
                  </div>
                </div>
                <div className="alert aYellow" style={{marginTop:12,padding:"9px 12px"}}>
                  <Ico n="info" s={12} c="var(--yellow)"/>
                  <span style={{fontSize:11}}>Preliminary radiologic staging — requires clinical correlation and multidisciplinary team review.</span>
                </div>
              </div>
            </Expand>
          )}

          {/* ═══════════════════════════════════════════════════
              PANEL 7 — DYNAMIC TRIAGE TIMER
          ═══════════════════════════════════════════════════ */}
          {timerPanel&&timerPanel.urgency_level!=="Routine"&&(
            <Expand
              title="Dynamic Triage Timer"
              badge={<span className={`badge ${triage==="Immediate"||triage==="Urgent"?"bRed":"bYellow"}`}>{triage}</span>}
              icon={<Ico n="zap" s={14} c={triage==="Immediate"||triage==="Urgent"?"var(--red)":"var(--yellow)"}/>}
            >
              <div style={{padding:"14px 18px",background:triage==="Immediate"?"rgba(239,68,68,.06)":"rgba(245,158,11,.05)",border:`1px solid ${triage==="Immediate"?"rgba(239,68,68,.25)":"rgba(245,158,11,.2)"}`,borderRadius:12}}>
                <div style={{display:"flex",gap:16,alignItems:"center",flexWrap:"wrap"}}>
                  <div>
                    <div style={{fontSize:10,color:"var(--tx3)",textTransform:"uppercase",letterSpacing:".07em",marginBottom:5}}>Follow-up Window</div>
                    <div style={{fontFamily:"'Syne',sans-serif",fontWeight:700,fontSize:18,color:triage==="Immediate"?"var(--red)":"var(--yellow)"}}>{timerPanel.recommended_followup_time||"—"}</div>
                  </div>
                  <div style={{flex:1,minWidth:160}}>
                    <div style={{fontSize:10,color:"var(--tx3)",textTransform:"uppercase",letterSpacing:".07em",marginBottom:5}}>Justification</div>
                    <p style={{fontSize:13,color:"var(--tx2)",lineHeight:1.65}}>{timerPanel.justification||"—"}</p>
                  </div>
                </div>
              </div>
            </Expand>
          )}

          {/* ═══════════════════════════════════════════════════
              PANEL 8 — CLINICAL JUSTIFICATION BLOCK
          ═══════════════════════════════════════════════════ */}
          {jb?.reasoning_summary&&(
            <Expand
              title="AI Clinical Justification"
              badge={<span className="badge bPurple">Tumor Board</span>}
              icon={<Ico n="brain" s={14} c="var(--purple)"/>}
              open={false}
            >
              <div style={{padding:"15px 18px",background:"rgba(139,92,246,.04)",border:"1px solid rgba(139,92,246,.15)",borderRadius:12,marginBottom:10}}>
                <div style={{fontSize:10,color:"var(--tx3)",textTransform:"uppercase",letterSpacing:".08em",marginBottom:7}}>Reasoning Summary</div>
                <p style={{fontSize:13.5,lineHeight:1.8,color:"var(--tx)"}}>{jb.reasoning_summary}</p>
              </div>
              {jb.supporting_findings?.length>0&&(
                <div style={{marginBottom:10}}>
                  <div style={{fontSize:10,color:"var(--tx3)",textTransform:"uppercase",letterSpacing:".08em",marginBottom:7}}>Supporting Findings</div>
                  {jb.supporting_findings.map((f,i)=>(
                    <div key={i} className="findingChip">
                      <span style={{color:"var(--purple)",flexShrink:0}}>▸</span>
                      <span style={{fontSize:13,color:"var(--tx2)"}}>{f}</span>
                    </div>
                  ))}
                </div>
              )}
              {jb.guideline_reference_logic&&(
                <div className="alert aBlue">
                  <Ico n="info" s={13} c="var(--blue)"/>
                  <span style={{fontSize:13,lineHeight:1.7}}>{jb.guideline_reference_logic}</span>
                </div>
              )}
            </Expand>
          )}

          {/* Share panel */}
          {showShare&&(
            <SharePanel textResults={results} imgResult={imgResult} meta={results.meta}/>
          )}
        </div>
      )}

      {!loading&&results?.error&&(
        <div className="alert aRed" style={{marginTop:12}}><Ico n="alert" s={14} c="var(--red)"/>{results.error}</div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   IMAGE MODULE — UPDATE 4 fixes
───────────────────────────────────────────────────────────── */
function ImageModule({textResults}) {
  const [file,    setFile]    = useState(null);
  const [preview, setPreview] = useState(null);
  const [dragOn,  setDragOn]  = useState(false);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState(null);
  const [mod,     setMod]     = useState("X-Ray");
  const [an,      setAn]      = useState("Chest");
  const inputRef = useRef(null);
  const resRef   = useRef(null);

  const handleFile = useCallback(f => {
    if (!f||!f.type.startsWith("image/")) return;
    setFile(f); setResults(null);
    const r=new FileReader();
    r.onload=e=>setPreview(e.target.result);
    r.readAsDataURL(f);
  },[]);

  const onDrop      = e=>{e.preventDefault();setDragOn(false);handleFile(e.dataTransfer.files[0]);};
  const onDragOver  = e=>{e.preventDefault();setDragOn(true);};
  const onDragLeave = ()=>setDragOn(false);

  // UPDATE 4: proper async chain with timeout + error fallback
  const analyze = async() => {
    if (!file) return;
    setLoading(true); setResults(null);
    try {
      // Await compression promise properly
      const compressed = await compressImg(file);
      // Await AI call with 10s timeout built into callAI
      const ai = await analyzeImageAI(compressed.base64, compressed.mime, mod, an);
      // Ensure all required fields have defaults before rendering
      const safe = {
        detected_image_type: ai.detected_image_type||"Unknown",
        is_radiology_image:  ai.is_radiology_image!==false,
        is_low_resolution:   !!ai.is_low_resolution,
        condition:           ai.condition||"Unspecified",
        confidence:          typeof ai.confidence==="number"?ai.confidence:0,
        risk_level:          ["Low","Moderate","High"].includes(ai.risk_level)?ai.risk_level:"Low",
        findings:            Array.isArray(ai.findings)?ai.findings:[],
        explanation:         ai.explanation||"",
        recommendations:     Array.isArray(ai.recommendations)?ai.recommendations:[],
        modality_match:      ai.modality_match!==false,
        modality_note:       ai.modality_note||"",
        recommendation:      ai.recommendation||"",
        _cached:             ai._cached,
        _hash:               ai._hash,
      };
      setResults(safe);
      setTimeout(()=>resRef.current?.scrollIntoView({behavior:"smooth",block:"start"}),120);
    } catch(err) {
      setResults({error:`Image analysis temporarily unavailable. ${err.message}`});
    }
    // Always clear loading — no infinite spinner
    setLoading(false);
  };

  const cross = crossValidate(textResults, results);

  return (
    <div className="fu">
      <div className="secTitle"><Ico n="img" s={20} c="var(--cyan)"/>AI Radiology Image Analyzer</div>
      <p className="secSub">Auto-compressed 512 px · JPEG 70% · EXIF stripped · SHA-256 hash cache · temperature=0 · 10s timeout</p>

      <div className="g2" style={{marginBottom:14}}>
        <div><label>Expected Modality</label><select value={mod} onChange={e=>setMod(e.target.value)}>{MODS.map(m=><option key={m}>{m}</option>)}</select></div>
        <div><label>Expected Anatomy</label><select value={an} onChange={e=>setAn(e.target.value)}>{ANATS.map(a=><option key={a}>{a}</option>)}</select></div>
      </div>

      <div className={`drop ${dragOn?"dropOn":""}`} style={{marginBottom:14}}
        onDrop={onDrop} onDragOver={onDragOver} onDragLeave={onDragLeave}
        onClick={()=>inputRef.current?.click()}>
        <input ref={inputRef} type="file" accept="image/*" style={{display:"none"}} onChange={e=>handleFile(e.target.files[0])}/>
        {preview?(
          <div className="imgPrev">
            <img src={preview} alt="scan"/>
            <div className="scanLine"/>
            <div style={{position:"absolute",top:8,right:8}}>
              <span className="badge bCyan mono">{file?.name?.slice(0,22)}</span>
            </div>
          </div>
        ):(
          <>
            <div style={{width:56,height:56,borderRadius:"50%",background:"rgba(6,182,212,.08)",border:"1px solid rgba(6,182,212,.18)",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 13px"}}>
              <Ico n="upload" s={22} c="var(--cyan)"/>
            </div>
            <div style={{fontFamily:"'Syne',sans-serif",fontWeight:600,fontSize:15,marginBottom:6}}>Drop radiology image here</div>
            <div style={{fontSize:13,color:"var(--tx3)",marginBottom:12}}>JPEG/PNG — auto-resized to 512px, 70% quality, EXIF stripped</div>
            <div style={{display:"flex",gap:6,justifyContent:"center",flexWrap:"wrap"}}>
              {["Chest X-Ray","Brain MRI","CT Slice","Abdominal CT"].map(t=><span key={t} className="badge bCyan">{t}</span>)}
            </div>
          </>
        )}
      </div>

      {preview&&(
        <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginBottom:16}}>
          <button className="btn btnG" onClick={()=>{setFile(null);setPreview(null);setResults(null);}}>
            <Ico n="x" s={13} c="var(--tx2)"/>Remove
          </button>
          <button className="btn btnP" onClick={analyze} disabled={loading}>
            {loading
              ?<><svg width={14}height={14}viewBox="0 0 24 24"fill="none"stroke="white"strokeWidth="2.5"className="spin"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>Analyzing…</>
              :<><Ico n="sparkle" s={15} c="white"/>Analyze Image</>}
          </button>
        </div>
      )}

      {/* Cross-modal */}
      {cross&&(
        <div style={{marginBottom:14}}>
          {cross.consistent?(
            <div className="alert aGreen">
              <Ico n="check" s={14} c="var(--green)"/>
              <div><strong>Text–Image Consistent</strong><br/><span style={{fontSize:12}}>Impression aligns with image finding ({cross.condition}). Risk tiers match ({cross.imgRisk}).</span></div>
            </div>
          ):(
            <div className="aMismatch">
              <div style={{display:"flex",gap:9,alignItems:"flex-start"}}>
                <Ico n="alert" s={17} c="var(--yellow)"/>
                <div>
                  <strong style={{fontSize:15}}>⚠ Text–Image Inconsistency</strong>
                  <p style={{fontSize:13,marginTop:5,lineHeight:1.65,color:"var(--tx2)"}}>
                    Image detected: <strong style={{color:"var(--yellow)"}}>{cross.condition}</strong><br/>
                    {!cross.condMatch&&"→ Not referenced in text impression. "}
                    {!cross.riskMatch&&`→ Risk mismatch: text=${cross.textRisk}, image=${cross.imgRisk}`}
                  </p>
                  <p style={{fontSize:12,color:"var(--red)",marginTop:6,fontWeight:600}}>Reconcile before sign-off.</p>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* UPDATE 4: skeleton shown during load, always cleared after */}
      {loading&&<SkeletonImage/>}

      {!loading&&results&&!results.error&&(
        <div ref={resRef} className="fu">
          {results.is_radiology_image===false&&(
            <div className="alert aRed" style={{marginBottom:10,padding:16}}>
              <Ico n="alert" s={16} c="var(--red)"/>
              <div><strong>Unsupported Image</strong><br/><span style={{fontSize:12}}>Not a radiology image. Upload a chest X-ray, CT, or MRI.</span></div>
            </div>
          )}
          {results.is_low_resolution&&(
            <div className="alert aYellow" style={{marginBottom:10}}>
              <Ico n="alert" s={14} c="var(--yellow)"/>Low resolution detected — upload higher-quality image.
            </div>
          )}
          {results.modality_match===false&&results.modality_note&&(
            <div className="alert aYellow" style={{marginBottom:10}}>
              <Ico n="info" s={14} c="var(--yellow)"/>{results.modality_note}
            </div>
          )}

          <div className="card glowCard" style={{padding:26,marginBottom:12,background:"linear-gradient(135deg,rgba(6,182,212,.05),rgba(30,41,59,.97))"}}>
            <div className="g2">
              <div>
                <div style={{fontSize:10,color:"var(--tx3)",textTransform:"uppercase",letterSpacing:".08em",marginBottom:4}}>Detected Image Type</div>
                <div style={{fontFamily:"'Syne',sans-serif",fontWeight:700,fontSize:15,marginBottom:13,color:"var(--cyan)"}}>{results.detected_image_type}</div>
                <div style={{fontSize:10,color:"var(--tx3)",textTransform:"uppercase",letterSpacing:".08em",marginBottom:4}}>Detected Condition</div>
                <div style={{fontFamily:"'Syne',sans-serif",fontWeight:600,fontSize:14,marginBottom:13}}>{results.condition}</div>
                {results.recommendation&&(
                  <div style={{fontSize:12,color:"var(--cyan)",marginBottom:10,fontStyle:"italic"}}>→ {results.recommendation}</div>
                )}
                <div style={{display:"flex",gap:7,flexWrap:"wrap"}}>
                  <span className={`badge ${results.risk_level==="High"?"bRed":results.risk_level==="Moderate"?"bYellow":"bGreen"}`}>◉ {results.risk_level} Risk</span>
                  <span className="badge bCyan mono">{Math.round(results.confidence*100)}% confidence</span>
                  {results._cached&&<span className="cacheBadge"><Ico n="db" s={10} c="var(--green)"/>Cache Hit</span>}
                  <span className="hashBadge"><Ico n="hash" s={10} c="var(--purple)"/>SHA-256: {results._hash}</span>
                </div>
              </div>
              <div>
                <ConfBar value={Math.round(results.confidence*100)} label="AI Confidence" color="var(--cyan)"/>
                {results.findings?.length>0&&(
                  <>
                    <div style={{fontSize:10,color:"var(--tx3)",textTransform:"uppercase",letterSpacing:".07em",margin:"12px 0 7px"}}>Visual Findings</div>
                    {results.findings.map((f,i)=>(
                      <div key={i} style={{display:"flex",gap:6,marginBottom:5,fontSize:13,color:"var(--tx2)"}}>
                        <span style={{color:"var(--cyan)",flexShrink:0}}>▸</span>{f}
                      </div>
                    ))}
                  </>
                )}
              </div>
            </div>
          </div>

          {results.explanation&&(
            <div className="card" style={{padding:19,marginBottom:10}}>
              <div style={{display:"flex",gap:7,alignItems:"center",marginBottom:8}}>
                <Ico n="brain" s={14} c="var(--cyan)"/>
                <span style={{fontFamily:"'Syne',sans-serif",fontWeight:600,fontSize:13}}>AI Pattern Analysis</span>
                <span className="badge bPurple mono" style={{marginLeft:"auto"}}>temp=0</span>
              </div>
              <p style={{fontSize:13.5,lineHeight:1.8,color:"var(--tx2)"}}>{results.explanation}</p>
            </div>
          )}

          {results.recommendations?.length>0&&(
            <div className="card" style={{padding:19}}>
              <div style={{display:"flex",gap:7,alignItems:"center",marginBottom:10}}>
                <Ico n="shield" s={14} c="var(--green)"/>
                <span style={{fontFamily:"'Syne',sans-serif",fontWeight:600,fontSize:13}}>Recommended Next Steps</span>
              </div>
              {results.recommendations.map((r,i)=>(
                <div key={i} style={{display:"flex",gap:8,padding:"8px 12px",background:"rgba(16,185,129,.04)",borderLeft:"3px solid var(--green)",borderRadius:"0 8px 8px 0",marginBottom:5,fontSize:13,color:"var(--tx2)"}}>
                  <span style={{color:"var(--green)",fontWeight:700,flexShrink:0}}>{i+1}.</span>{r}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {!loading&&results?.error&&(
        <div className="alert aRed"><Ico n="alert" s={14} c="var(--red)"/>{results.error}</div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   ANALYTICS
───────────────────────────────────────────────────────────── */
function BarChart({data}) {
  const max=Math.max(...data.map(d=>d.v));
  return (
    <div style={{display:"flex",alignItems:"flex-end",gap:6,height:88,padding:"4px 0"}}>
      {data.map((d,i)=>{
        const col=d.v>=75?"var(--green)":d.v>=50?"var(--blue)":"var(--red)";
        return (
          <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:3}}>
            <span style={{fontSize:9,color:"var(--tx3)"}} className="mono">{d.v}</span>
            <div style={{width:"100%",height:70,display:"flex",alignItems:"flex-end"}}>
              <div style={{width:"100%",borderRadius:"4px 4px 0 0",background:`linear-gradient(180deg,${col},${col}55)`,height:`${(d.v/max)*100}%`,transition:"height 1s cubic-bezier(.16,1,.3,1)"}}/>
            </div>
            <span style={{fontSize:8,color:"var(--tx3)"}}>{d.l}</span>
          </div>
        );
      })}
    </div>
  );
}
function MiniPie({segments}) {
  let cum=0;const tot=segments.reduce((a,b)=>a+b.v,0);
  const arcs=segments.map(s=>{const pct=s.v/tot,st=cum,en=cum+pct*2*Math.PI;cum=en;const x1=50+40*Math.cos(st-Math.PI/2),y1=50+40*Math.sin(st-Math.PI/2),x2=50+40*Math.cos(en-Math.PI/2),y2=50+40*Math.sin(en-Math.PI/2);return {...s,d:`M50,50 L${x1},${y1} A40,40 0 ${pct>.5?1:0},1 ${x2},${y2} Z`};});
  return (
    <div style={{display:"flex",alignItems:"center",gap:16}}>
      <svg width={96}height={96}viewBox="0 0 100 100">{arcs.map((a,i)=><path key={i}d={a.d}fill={a.col}opacity={.85}/>)}<circle cx={50}cy={50}r={22}fill="var(--card)"/></svg>
      <div style={{display:"flex",flexDirection:"column",gap:5}}>
        {segments.map((s,i)=>(
          <div key={i} style={{display:"flex",alignItems:"center",gap:7,fontSize:12}}>
            <div style={{width:7,height:7,borderRadius:"50%",background:s.col,flexShrink:0}}/>
            <span style={{color:"var(--tx2)"}}>{s.l}</span>
            <span style={{color:"var(--tx3)",marginLeft:"auto"}} className="mono">{s.v}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}
function Analytics() {
  const stats=[{l:"Reports Analyzed",v:"1,247",d:"+12%",c:"var(--blue)"},{l:"Avg QA Score",v:"84.2",d:"+3.1",c:"var(--green)"},{l:"Abnormality Rate",v:"34.7%",d:"-2.1%",c:"var(--yellow)"},{l:"Compliance Rate",v:"91.4%",d:"+1.8%",c:"var(--purple)"}];
  const bars=[{l:"Mon",v:82},{l:"Tue",v:91},{l:"Wed",v:76},{l:"Thu",v:88},{l:"Fri",v:94},{l:"Sat",v:67},{l:"Sun",v:79}];
  const pie=[{l:"Chest CT",v:38,col:"var(--blue)"},{l:"Brain MRI",v:24,col:"var(--purple)"},{l:"X-Ray",v:21,col:"var(--cyan)"},{l:"Other",v:17,col:"var(--tx3)"}];
  const conds=[{l:"Normal",p:34,c:"var(--green)"},{l:"Pneumonia",p:28,c:"var(--red)"},{l:"Effusion",p:16,c:"var(--blue)"},{l:"Nodule",p:13,c:"var(--yellow)"},{l:"Other",p:9,c:"var(--tx3)"}];
  return (
    <div className="fu">
      <div className="secTitle"><Ico n="chart" s={20} c="var(--blue)"/>Analytics Dashboard</div>
      <p className="secSub">Platform-wide metrics and performance insights</p>
      <div className="g4" style={{marginBottom:14}}>
        {stats.map((s,i)=>(
          <div key={i} className="card" style={{padding:18}}>
            <div style={{fontSize:10,color:"var(--tx3)",marginBottom:6,textTransform:"uppercase",letterSpacing:".07em"}}>{s.l}</div>
            <div className="statNum" style={{background:`linear-gradient(135deg,white,${s.c})`,WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>{s.v}</div>
            <div style={{fontSize:10,color:s.d.startsWith("+")?"var(--green)":"var(--red)",marginTop:3}} className="mono">{s.d} this week</div>
          </div>
        ))}
      </div>
      <div className="g2" style={{marginBottom:14}}>
        <div className="card" style={{padding:20}}><div style={{fontFamily:"'Syne',sans-serif",fontWeight:600,fontSize:13,marginBottom:12}}>QA Score — 7-day Trend</div><BarChart data={bars}/></div>
        <div className="card" style={{padding:20}}><div style={{fontFamily:"'Syne',sans-serif",fontWeight:600,fontSize:13,marginBottom:12}}>Study Type Distribution</div><MiniPie segments={pie}/></div>
      </div>
      <div className="card" style={{padding:20}}>
        <div style={{fontFamily:"'Syne',sans-serif",fontWeight:600,fontSize:13,marginBottom:12}}>Top Detected Conditions</div>
        {conds.map((c,i)=><ConfBar key={i} value={c.p} label={c.l} color={c.c}/>)}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   LOGIN
───────────────────────────────────────────────────────────── */
function LoginPage({onLogin}) {
  const [email,   setEmail]   = useState("demo@medvision.ai");
  const [pw,      setPw]      = useState("demo");
  const [err,     setErr]     = useState("");
  const [loading, setLoading] = useState(false);

  const submit=async()=>{
    if(!email||!pw) return; setLoading(true); setErr("");
    await new Promise(r=>setTimeout(r,580));
    const s=authLogin(email,pw);
    if(s){sessionStorage.setItem("mv_tok",s.tok);onLogin(s.user);}
    else setErr("Invalid credentials — use demo@medvision.ai / demo");
    setLoading(false);
  };

  return (
    <div className="loginBg">
      <div style={{position:"fixed",inset:0,backgroundImage:"linear-gradient(rgba(59,130,246,.022) 1px,transparent 1px),linear-gradient(90deg,rgba(59,130,246,.022) 1px,transparent 1px)",backgroundSize:"44px 44px",pointerEvents:"none"}}/>
      <div className="wm"><CaduceusSVG/></div>
      <div className="loginCard fu">
        <div style={{textAlign:"center",marginBottom:32}}>
          <div style={{width:52,height:52,borderRadius:13,background:"linear-gradient(135deg,var(--blue2),var(--cyan))",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 12px",boxShadow:"0 0 26px rgba(59,130,246,.36)"}}>
            <Ico n="brain" s={24} c="white"/>
          </div>
          <div style={{fontFamily:"'Syne',sans-serif",fontWeight:800,fontSize:23,background:"linear-gradient(128deg,#fff,var(--blue))",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>MedVision AI</div>
          <div style={{fontSize:12,color:"var(--tx3)",marginTop:3}}>Intelligent Radiology QA Platform · PRO 2.0</div>
        </div>
        <div style={{marginBottom:13}}><label>Email Address</label><input type="email" value={email} onChange={e=>setEmail(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()} placeholder="your@hospital.com"/></div>
        <div style={{marginBottom:20}}><label>Password</label><input type="password" value={pw} onChange={e=>setPw(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()} placeholder="••••••••"/></div>
        {err&&<div className="alert aRed" style={{marginBottom:13}}><Ico n="alert" s={13} c="var(--red)"/><span style={{fontSize:13}}>{err}</span></div>}
        <button className="btn btnP" onClick={submit} disabled={loading} style={{width:"100%",justifyContent:"center",padding:"13px 0",fontSize:14}}>
          {loading?<><svg width={14}height={14}viewBox="0 0 24 24"fill="none"stroke="white"strokeWidth="2.5"className="spin"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>Authenticating…</>:<><Ico n="shield" s={14} c="white"/>Access Dashboard</>}
        </button>
        <div style={{marginTop:16,padding:11,background:"rgba(59,130,246,.05)",border:"1px solid rgba(59,130,246,.12)",borderRadius:9,fontSize:11,color:"var(--tx3)",fontFamily:"'JetBrains Mono',monospace",textAlign:"center"}}>demo@medvision.ai · demo</div>
        <div style={{marginTop:14,display:"flex",gap:6,justifyContent:"center",flexWrap:"wrap"}}>
          {["HIPAA Compliant","temp=0 AI","SHA-256 Cache","Excel Export","Share Report"].map(t=><span key={t} className="badge bBlue" style={{fontSize:9}}>{t}</span>)}
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   DASHBOARD
───────────────────────────────────────────────────────────── */
function Dashboard({user, onLogout}) {
  const [tab,         setTab]         = useState("text");
  const [showProfile, setShowProfile] = useState(false);
  const [textResults, setTextResults] = useState(null);
  const [imgResult,   setImgResult]   = useState(null);

  const handleImgResult = (r) => setImgResult(r);

  const SIDENAV = [
    { section: "ANALYSIS" },
    { id:"text",      lbl:"Text QA",        ico:"doc"     },
    { id:"image",     lbl:"Image Analysis", ico:"img"     },
    { section: "DATA" },
    { id:"history",   lbl:"History",        ico:"history" },
    { id:"analytics", lbl:"Analytics",      ico:"chart"   },
  ];

  return (
    <div style={{minHeight:"100vh",position:"relative",background:"var(--bg)"}}>
      <div className="wm"><CaduceusSVG/></div>
      <div style={{position:"fixed",inset:0,backgroundImage:"linear-gradient(rgba(59,130,246,.016) 1px,transparent 1px),linear-gradient(90deg,rgba(59,130,246,.016) 1px,transparent 1px)",backgroundSize:"44px 44px",pointerEvents:"none",zIndex:0}}/>

      {/* ── Top Nav ── */}
      <nav className="nav" style={{zIndex:200,position:"sticky",top:0}}>
        <div style={{display:"flex",alignItems:"center",gap:11}}>
          <div style={{width:33,height:33,borderRadius:9,background:"linear-gradient(135deg,var(--blue2),var(--cyan))",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 0 13px rgba(59,130,246,.36)"}}>
            <Ico n="brain" s={15} c="white"/>
          </div>
          <span className="logoTxt">MedVision AI</span>
          <span className="pill">PRO 2.0</span>
          <span className="badge bGreen" style={{fontSize:9,marginLeft:2}}>DB ●</span>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontSize:11,color:"var(--tx3)"}} className="mono">
            {new Date().toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}
          </span>
          <div style={{position:"relative"}}>
            <button className="btn btnG" onClick={()=>setShowProfile(o=>!o)}>
              <div style={{width:25,height:25,borderRadius:"50%",background:"linear-gradient(135deg,var(--blue2),var(--purple))",
                display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:700,color:"white"}}>{user.avatar}</div>
              <span style={{fontSize:13}}>{user.name}</span>
            </button>
            {showProfile&&(
              <div style={{position:"absolute",right:0,top:"calc(100% + 7px)",background:"var(--card)",
                border:"1px solid var(--br)",borderRadius:12,padding:7,minWidth:200,
                boxShadow:"0 16px 40px rgba(0,0,0,.45)",zIndex:300}} className="fi">
                <div style={{padding:"9px 12px",borderBottom:"1px solid var(--br2)",marginBottom:5}}>
                  <div style={{fontWeight:600,fontSize:13}}>{user.name}</div>
                  <div style={{fontSize:11,color:"var(--tx3)"}}>{user.role}</div>
                </div>
                {[
                  {id:"text",      lbl:"Text QA",        ico:"doc"},
                  {id:"image",     lbl:"Image Analysis", ico:"img"},
                  {id:"history",   lbl:"History",        ico:"history"},
                  {id:"analytics", lbl:"Analytics",      ico:"chart"},
                ].map(t=>(
                  <button key={t.id} onClick={()=>{setTab(t.id);setShowProfile(false);}}
                    style={{width:"100%",display:"flex",alignItems:"center",gap:8,padding:"8px 12px",
                      background:tab===t.id?"rgba(59,130,246,.08)":"none",border:"none",cursor:"pointer",
                      color:tab===t.id?"var(--blue)":"var(--tx2)",fontSize:13,borderRadius:7,fontFamily:"'Inter',sans-serif"}}>
                    <Ico n={t.ico} s={13} c={tab===t.id?"var(--blue)":"var(--tx2)"}/>
                    {t.lbl}
                  </button>
                ))}
                <div style={{borderTop:"1px solid var(--br2)",marginTop:5,paddingTop:5}}>
                  <button onClick={onLogout} style={{width:"100%",display:"flex",alignItems:"center",gap:7,
                    padding:"7px 11px",background:"none",border:"none",cursor:"pointer",
                    color:"var(--red)",fontSize:13,borderRadius:7,fontFamily:"'Inter',sans-serif"}}>
                    <Ico n="logout" s={13} c="var(--red)"/>Sign Out
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </nav>

      {/* ── Shell: Sidebar + Main ── */}
      <div className="appShell" style={{position:"relative",zIndex:1}}>

        {/* Sidebar */}
        <nav className="sidebar">
          {SIDENAV.map((item, i) =>
            item.section ? (
              <div key={i} className="sideSec">{item.section}</div>
            ) : (
              <button key={item.id} className={`sideItem ${tab===item.id?"sideOn":"sideOff"}`}
                onClick={()=>setTab(item.id)}>
                <Ico n={item.ico} s={15} c={tab===item.id?"var(--blue)":"var(--tx2)"}/>
                {item.lbl}
                {item.id==="history" && <span className="badge bBlue" style={{marginLeft:"auto",fontSize:8,padding:"2px 6px"}}>DB</span>}
              </button>
            )
          )}
          {/* DB Status */}
          <div style={{marginTop:"auto",paddingTop:20,borderTop:"1px solid var(--br2)"}}>
            <div style={{padding:"10px 12px",background:"rgba(16,185,129,.06)",border:"1px solid rgba(16,185,129,.15)",borderRadius:9}}>
              <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                <div style={{width:6,height:6,borderRadius:"50%",background:"var(--green)",flexShrink:0}}/>
                <span style={{fontSize:10,color:"var(--green)",fontWeight:600,fontFamily:"'JetBrains Mono',monospace"}}>Storage Active</span>
              </div>
              <div style={{fontSize:9,color:"var(--tx3)"}}>Persistent · No server needed</div>
            </div>
          </div>
        </nav>

        {/* Main content */}
        <main className="mainContent">
          {tab==="text"      && <TextQAModule user={user} onResults={setTextResults} imgResult={imgResult}/>}
          {tab==="image"     && <ImageModuleWrapper textResults={textResults} onResult={handleImgResult}/>}
          {tab==="history"   && <HistoryPage/>}
          {tab==="analytics" && <Analytics/>}
        </main>
      </div>

      <ToastContainer/>
    </div>
  );
}

/* Wrapper that feeds imgResult up */
function ImageModuleWrapper({textResults, onResult}) {
  return <ImageModuleConnected textResults={textResults} onResult={onResult}/>;
}
function ImageModuleConnected({textResults, onResult}) {
  const [file,    setFile]    = useState(null);
  const [preview, setPreview] = useState(null);
  const [dragOn,  setDragOn]  = useState(false);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState(null);
  const [mod,     setMod]     = useState("X-Ray");
  const [an,      setAn]      = useState("Chest");
  const inputRef = useRef(null);
  const resRef   = useRef(null);

  const handleFile = useCallback(f=>{
    if(!f||!f.type.startsWith("image/")) return;
    setFile(f); setResults(null);
    const r=new FileReader(); r.onload=e=>setPreview(e.target.result); r.readAsDataURL(f);
  },[]);

  const onDrop=e=>{e.preventDefault();setDragOn(false);handleFile(e.dataTransfer.files[0]);};
  const onDragOver=e=>{e.preventDefault();setDragOn(true);};
  const onDragLeave=()=>setDragOn(false);

  const analyze=async()=>{
    if(!file) return;
    // 5 MB file size guard
    if(file.size > 5*1024*1024){ toast("File too large (max 5 MB). Please compress and retry.","error"); return; }
    // MIME guard
    if(!["image/jpeg","image/png","image/jpg","image/webp"].includes(file.type)){ toast("Unsupported format. Use JPEG or PNG.","error"); return; }
    setLoading(true); setResults(null);
    try {
      const compressed = await compressImg(file);
      const { safe } = await runImageAnalysisWithDB(compressed.base64, compressed.mime, mod, an);
      setResults(safe);
      onResult?.(safe);
      setTimeout(()=>resRef.current?.scrollIntoView({behavior:"smooth",block:"start"}),120);
    } catch(err) {
      toast("Image analysis temporarily unavailable: "+err.message, "error");
      setResults({error:`Image analysis temporarily unavailable. ${err.message}`});
      onResult?.(null);
    }
    setLoading(false); // ALWAYS clears — no infinite spinner
  };

  const cross=crossValidate(textResults, results);

  return (
    <div className="fu">
      <div className="secTitle"><Ico n="img" s={20} c="var(--cyan)"/>AI Radiology Image Analyzer</div>
      <p className="secSub">Auto-compressed 512 px · JPEG 70% · EXIF stripped · SHA-256 cache · temperature=0 · 10s timeout</p>

      <div className="g2" style={{marginBottom:14}}>
        <div><label>Expected Modality</label><select value={mod} onChange={e=>setMod(e.target.value)}>{MODS.map(m=><option key={m}>{m}</option>)}</select></div>
        <div><label>Expected Anatomy</label><select value={an} onChange={e=>setAn(e.target.value)}>{ANATS.map(a=><option key={a}>{a}</option>)}</select></div>
      </div>

      <div className={`drop ${dragOn?"dropOn":""}`} style={{marginBottom:14}}
        onDrop={onDrop} onDragOver={onDragOver} onDragLeave={onDragLeave}
        onClick={()=>inputRef.current?.click()}>
        <input ref={inputRef} type="file" accept="image/*" style={{display:"none"}} onChange={e=>handleFile(e.target.files[0])}/>
        {preview?(
          <div className="imgPrev">
            <img src={preview} alt="scan"/>
            <div className="scanLine"/>
            <div style={{position:"absolute",top:8,right:8}}><span className="badge bCyan mono">{file?.name?.slice(0,22)}</span></div>
          </div>
        ):(
          <>
            <div style={{width:56,height:56,borderRadius:"50%",background:"rgba(6,182,212,.08)",border:"1px solid rgba(6,182,212,.18)",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 13px"}}>
              <Ico n="upload" s={22} c="var(--cyan)"/>
            </div>
            <div style={{fontFamily:"'Syne',sans-serif",fontWeight:600,fontSize:15,marginBottom:6}}>Drop radiology image here</div>
            <div style={{fontSize:13,color:"var(--tx3)",marginBottom:12}}>JPEG/PNG — auto-resized 512px, 70% quality, EXIF stripped</div>
            <div style={{display:"flex",gap:6,justifyContent:"center",flexWrap:"wrap"}}>
              {["Chest X-Ray","Brain MRI","CT Slice","Abdominal CT"].map(t=><span key={t} className="badge bCyan">{t}</span>)}
            </div>
          </>
        )}
      </div>

      {preview&&(
        <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginBottom:16}}>
          <button className="btn btnG" onClick={()=>{setFile(null);setPreview(null);setResults(null);onResult?.(null);}}>
            <Ico n="x" s={13} c="var(--tx2)"/>Remove
          </button>
          <button className="btn btnP" onClick={analyze} disabled={loading}>
            {loading?<><svg width={14}height={14}viewBox="0 0 24 24"fill="none"stroke="white"strokeWidth="2.5"className="spin"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>Analyzing…</>:<><Ico n="sparkle" s={15} c="white"/>Analyze Image</>}
          </button>
        </div>
      )}

      {cross&&(
        <div style={{marginBottom:14}}>
          {cross.consistent?(
            <div className="alert aGreen"><Ico n="check" s={14} c="var(--green)"/><div><strong>Text–Image Consistent</strong><br/><span style={{fontSize:12}}>Impression aligns with {cross.condition}. Risk tiers match ({cross.imgRisk}).</span></div></div>
          ):(
            <div className="aMismatch">
              <div style={{display:"flex",gap:9,alignItems:"flex-start"}}>
                <Ico n="alert" s={17} c="var(--yellow)"/>
                <div>
                  <strong style={{fontSize:15}}>⚠ Text–Image Inconsistency</strong>
                  <p style={{fontSize:13,marginTop:5,lineHeight:1.65,color:"var(--tx2)"}}>Image detected: <strong style={{color:"var(--yellow)"}}>{cross.condition}</strong><br/>{!cross.condMatch&&"→ Not in text impression. "}{!cross.riskMatch&&`→ Risk: text=${cross.textRisk}, image=${cross.imgRisk}`}</p>
                  <p style={{fontSize:12,color:"var(--red)",marginTop:6,fontWeight:600}}>Reconcile before sign-off.</p>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {loading&&<SkeletonImage/>}

      {!loading&&results&&!results.error&&(
        <div ref={resRef} className="fu">
          {!results.is_radiology_image&&<div className="alert aRed" style={{marginBottom:10,padding:16}}><Ico n="alert" s={16} c="var(--red)"/><div><strong>Unsupported Image</strong><br/><span style={{fontSize:12}}>Not a radiology image.</span></div></div>}
          {results.is_low_resolution&&<div className="alert aYellow" style={{marginBottom:10}}><Ico n="alert" s={14} c="var(--yellow)"/>Low resolution — upload higher quality.</div>}
          {results.modality_match===false&&results.modality_note&&<div className="alert aYellow" style={{marginBottom:10}}><Ico n="info" s={14} c="var(--yellow)"/>{results.modality_note}</div>}
          <div className="card glowCard" style={{padding:26,marginBottom:12,background:"linear-gradient(135deg,rgba(6,182,212,.05),rgba(30,41,59,.97))"}}>
            <div className="g2">
              <div>
                <div style={{fontSize:10,color:"var(--tx3)",textTransform:"uppercase",letterSpacing:".08em",marginBottom:4}}>Detected Image Type</div>
                <div style={{fontFamily:"'Syne',sans-serif",fontWeight:700,fontSize:15,marginBottom:13,color:"var(--cyan)"}}>{results.detected_image_type}</div>
                <div style={{fontSize:10,color:"var(--tx3)",textTransform:"uppercase",letterSpacing:".08em",marginBottom:4}}>Detected Condition</div>
                <div style={{fontFamily:"'Syne',sans-serif",fontWeight:600,fontSize:14,marginBottom:10}}>{results.condition}</div>
                {results.recommendation&&<div style={{fontSize:12,color:"var(--cyan)",marginBottom:10,fontStyle:"italic"}}>→ {results.recommendation}</div>}
                <div style={{display:"flex",gap:7,flexWrap:"wrap"}}>
                  <span className={`badge ${results.risk_level==="High"?"bRed":results.risk_level==="Moderate"?"bYellow":"bGreen"}`}>◉ {results.risk_level} Risk</span>
                  <span className="badge bCyan mono">{Math.round(results.confidence*100)}% conf</span>
                  {results._cached&&<span className="cacheBadge"><Ico n="db" s={10} c="var(--green)"/>Cache Hit</span>}
                  {results._hash&&<span className="hashBadge"><Ico n="hash" s={10} c="var(--purple)"/>SHA-256: {results._hash}</span>}
                </div>
              </div>
              <div>
                <ConfBar value={Math.round(results.confidence*100)} label="AI Confidence" color="var(--cyan)"/>
                {results.findings?.length>0&&(<>
                  <div style={{fontSize:10,color:"var(--tx3)",textTransform:"uppercase",letterSpacing:".07em",margin:"12px 0 7px"}}>Visual Findings</div>
                  {results.findings.map((f,i)=><div key={i} style={{display:"flex",gap:6,marginBottom:5,fontSize:13,color:"var(--tx2)"}}><span style={{color:"var(--cyan)",flexShrink:0}}>▸</span>{f}</div>)}
                </>)}
              </div>
            </div>
          </div>
          {results.explanation&&(
            <div className="card" style={{padding:19,marginBottom:10}}>
              <div style={{display:"flex",gap:7,alignItems:"center",marginBottom:8}}>
                <Ico n="brain" s={14} c="var(--cyan)"/><span style={{fontFamily:"'Syne',sans-serif",fontWeight:600,fontSize:13}}>AI Pattern Analysis</span>
                <span className="badge bPurple mono" style={{marginLeft:"auto"}}>temp=0</span>
              </div>
              <p style={{fontSize:13.5,lineHeight:1.8,color:"var(--tx2)"}}>{results.explanation}</p>
            </div>
          )}
          {results.recommendations?.length>0&&(
            <div className="card" style={{padding:19}}>
              <div style={{display:"flex",gap:7,alignItems:"center",marginBottom:10}}><Ico n="shield" s={14} c="var(--green)"/><span style={{fontFamily:"'Syne',sans-serif",fontWeight:600,fontSize:13}}>Recommended Next Steps</span></div>
              {results.recommendations.map((r,i)=>(
                <div key={i} style={{display:"flex",gap:8,padding:"8px 12px",background:"rgba(16,185,129,.04)",borderLeft:"3px solid var(--green)",borderRadius:"0 8px 8px 0",marginBottom:5,fontSize:13,color:"var(--tx2)"}}>
                  <span style={{color:"var(--green)",fontWeight:700,flexShrink:0}}>{i+1}.</span>{r}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {!loading&&results?.error&&<div className="alert aRed"><Ico n="alert" s={14} c="var(--red)"/>{results.error}</div>}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────
   APP ROOT
───────────────────────────────────────────────────────────── */
export default function App() {
  const [user,  setUser]  = useState(null);
  const [ready, setReady] = useState(false);
  useEffect(()=>{ const u=authGet(); if(u) setUser(u); setReady(true); },[]);
  const logout=()=>{ sessionStorage.removeItem("mv_tok"); setUser(null); };
  if (!ready) return null;
  return (
    <>
      <style>{CSS}</style>
      {user ? <Dashboard user={user} onLogout={logout}/> : <LoginPage onLogin={setUser}/>}
      <ToastContainer/>
    </>
  );
}

/* GNOME dashboard — vanilla JS, no build step, no external deps */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const api = async (path, opts = {}) => {
    const res = await fetch('/api' + path, {
      ...opts,
      headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {},
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const j = await res.json().catch(() => ({}));
    if (res.status === 401) { location.href = '/login'; throw new Error('login required'); }
    if (!res.ok) throw new Error(j.error || res.status);
    return j;
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---- labels ------------------------------------------------------------
  const LABEL = { temp_c: 'อุณหภูมิ', rh_pct: 'ความชื้นอากาศ', lux: 'แสง', press_hpa: 'ความดัน', dht_temp_c: 'อุณหภูมิ (DHT)', dht_rh_pct: 'ความชื้น (DHT)' };
  const label = (k) => LABEL[k] || (k.match(/^soil(\d+)_pct$/) ? `ดิน ${k.match(/^soil(\d+)_pct$/)[1]}` : k.match(/^soil(\d+)_raw$/) ? `ดิน ${k.match(/^soil(\d+)_raw$/)[1]} (raw)` : k);
  const unit = (k, n) => n?.meta?.sensor_meta?.[k]?.unit || (n?.meta?.sensors || []).find((s) => s.key === k)?.unit || (k.endsWith('_c') ? '°C' : k.endsWith('_pct') ? '%' : k === 'lux' ? 'lx' : k === 'press_hpa' ? 'hPa' : '');
  const fmtV = (v) => (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('th-TH') : Number.isInteger(v) ? String(v) : v.toFixed(1));
  const ago = (iso) => {
    if (!iso) return '—';
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return `${Math.round(s)} วิ.ที่แล้ว`;
    if (s < 3600) return `${Math.round(s / 60)} นาทีที่แล้ว`;
    if (s < 86400) return `${Math.round(s / 3600)} ชม.ที่แล้ว`;
    return `${Math.round(s / 86400)} วันที่แล้ว`;
  };
  const fmtTs = (iso) => new Date(iso).toLocaleString('th-TH', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const toast = (msg, err) => {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast' + (err ? ' err' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add('hidden'), 3200);
  };

  // ---- external session: show logout only when accessed from outside (via tunnel)
  fetch('/api/me').then((r) => r.json()).then((me) => { if (me.external) { const b = $('#logout'); b.classList.remove('hidden'); b.onclick = async () => { await fetch('/api/logout', { method: 'POST' }); location.href = '/login'; }; } }).catch(() => {});

  // ---- theme ---------------------------------------------------------------
  const root = document.documentElement;
  const savedTheme = localStorage.getItem('gnome-theme');
  if (savedTheme) root.dataset.theme = savedTheme;
  $('#theme').onclick = () => {
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    localStorage.setItem('gnome-theme', root.dataset.theme);
    chart.draw();
  };

  // ---- tabs ------------------------------------------------------------------
  const showTab = (name) => {
    $$('#tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === name));
    $$('.tab').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + name));
    if (name === 'chart') chart.load();
    if (name === 'events') loadEvents();
    if (name === 'rules') loadRules();
    if (name === 'settings') loadDiscord();
  };
  $$('#tabs a').forEach((a) => (a.onclick = (e) => { e.preventDefault(); location.hash = a.dataset.tab; showTab(a.dataset.tab); }));

  // ---- state -------------------------------------------------------------
  const nodes = new Map(); // node -> json from /api/nodes
  let rules = [];
  let events = [];

  async function loadNodes() {
    const list = await api('/nodes');
    nodes.clear();
    for (const n of list) nodes.set(n.node, n);
    renderStatus();
    fillSelectors();
  }

  // ---- (e) กล้อง / Watcher ---------------------------------------------------
  const camState = { list: [], day: {}, frames: {}, playing: {} };
  async function renderCam() {
    try { camState.list = await api('/cam'); } catch (e) { toast('โหลดกล้องไม่ได้: ' + e.message, true); return; }
    $('#cam-empty').classList.toggle('hidden', camState.list.length > 0);
    $('#cam-list').innerHTML = camState.list.map((c) => `<article class="card node cam-card ${c.online ? '' : 'offline'}" data-node="${esc(c.node)}">
      <div class="head"><span class="status-dot ${c.online ? 'on' : ''}"></span><span class="name">${esc(c.node)}</span><span class="badge cam">watcher</span>
        <span class="muted small" style="margin-left:auto">${c.latest ? esc(ago(c.latest.ts)) : 'ยังไม่มีภาพ'} · ${c.count} ภาพ</span></div>
      <div class="cam-view"><img class="cam-img" src="${c.latest ? esc(c.latest.url) : ''}" alt="" style="${c.latest ? '' : 'display:none'}"><div class="cam-ts muted small">${c.latest ? esc(fmtTs(c.latest.ts)) : ''}</div></div>
      <div class="row">
        <button class="small" data-snap="1" ${c.online ? '' : 'disabled'}>📸 ถ่ายตอนนี้</button>
        <button class="small" data-live="1" ${c.online ? '' : 'disabled'}>▶ ดูสด</button>
        <select class="small cam-day" title="เลือกวัน"><option value="">— time-lapse: เลือกวัน —</option></select>
        <button class="small" data-play="1" disabled>▶ เล่น</button>
        <span class="muted small cam-prog"></span>
        ${c.ip ? `<a class="btn" href="http://${esc(c.ip)}/" target="_blank" rel="noopener">⚙ ตั้งค่า</a>` : ''}
        <button class="ghost small danger" data-delday="1" title="ลบภาพของวันที่เลือกใน time-lapse">ลบวันนี้</button>
        <button class="ghost small danger" data-delall="1" title="ลบภาพทั้งหมดของกล้องนี้">ลบทั้งหมด</button>
      </div>
      ${c.cam?.servo ? `<div class="row pan"><span class="muted small">หัน</span>
        <input type="range" class="pan-range" min="0" max="180" value="${c.cam.angle ?? 90}" ${c.online ? '' : 'disabled'}>
        <span class="pan-val muted small">${c.cam.angle ?? 90}°</span>
        ${(c.cam.presets || []).map((p) => `<button class="small" data-preset="${esc(p.name)}" title="${p.angle}°" ${c.online ? '' : 'disabled'}>${esc(p.name)}</button>`).join('')}
        ${(c.cam.presets || []).length > 1 ? `<button class="small" data-patrol="1" ${c.online ? '' : 'disabled'} title="หันไปทุก preset แล้วถ่ายทีละมุม">🔄 ถ่ายทุกมุม</button>` : ''}
      </div>` : ''}
      ${c.angles?.length ? `<div class="muted small">มุมที่มีภาพ: ${c.angles.map((a) => `${a.angle}° (${a.count})`).join(' · ')}</div>` : ''}
      <div class="film"></div>
    </article>`).join('');
    for (const c of camState.list) loadDays(c.node);
  }
  async function loadDays(node) {
    const card = $(`.cam-card[data-node="${node}"]`); if (!card) return;
    const days = await api(`/cam/${node}/days`).catch(() => []);
    const sel = $('.cam-day', card);
    sel.innerHTML = '<option value="">— time-lapse: เลือกวัน —</option>' + days.map((d) => `<option value="${d.day}">${d.day} (${d.count})</option>`).join('');
    if (days.length) { sel.value = days[0].day; loadFrames(node, days[0].day); }
  }
  async function loadFrames(node, day) {
    const card = $(`.cam-card[data-node="${node}"]`); if (!card) return;
    const frames = await api(`/cam/${node}/snapshots?day=${day}`).catch(() => []);
    camState.frames[node] = frames; camState.day[node] = day;
    $('[data-play]', card).disabled = frames.length < 2;
    $('.film', card).innerHTML = frames.slice(-40).map((f, i) => `<img src="${esc(f.url)}" title="${esc(fmtTs(f.ts))}" data-i="${frames.length - Math.min(40, frames.length) + i}" loading="lazy">`).join('');
    $('.cam-prog', card).textContent = `${frames.length} ภาพ`;
  }
  function onSnapshot(m) {
    const card = $(`.cam-card[data-node="${m.node}"]`);
    if (!card) { if ($('#tab-cam').classList.contains('active')) renderCam(); return; }
    const img = $('.cam-img', card); if (camState.live?.[m.node]) { camState.live[m.node] = m.url; return; } img.src = m.url; img.style.display = '';
    $('.cam-ts', card).textContent = fmtTs(m.ts);
    const c = camState.list.find((x) => x.node === m.node); if (c) { c.latest = { ts: m.ts, url: m.url }; c.count++; }
    const today = camState.day[m.node]; if (today && m.ts.startsWith(today) === false) return; if (today) loadFrames(m.node, today);
  }
  $('#cam-list').addEventListener('input', (e) => { const r = e.target.closest('.pan-range'); if (r) $('.pan-val', r.closest('.pan')).textContent = r.value + '°'; });
  $('#cam-list').addEventListener('change', async (e) => {
    const sel = e.target.closest('.cam-day'); if (sel) { const node = sel.closest('.cam-card').dataset.node; if (sel.value) loadFrames(node, sel.value); return; }
    const r = e.target.closest('.pan-range'); if (!r) return;
    const node = r.closest('.cam-card').dataset.node;
    try { await api(`/cam/${node}/pan`, { method: 'POST', body: { angle: Number(r.value), snap: true } }); toast(`หันไป ${r.value}° แล้วถ่าย`); } catch (err) { toast('ผิดพลาด: ' + err.message, true); }
  });
  $('#cam-list').addEventListener('click', async (e) => {
    const card = e.target.closest('.cam-card'); if (!card) return; const node = card.dataset.node;
    const img = e.target.closest('.film img'); if (img) { const f = camState.frames[node]?.[Number(img.dataset.i)]; if (f) { $('.cam-img', card).src = f.url; $('.cam-ts', card).textContent = fmtTs(f.ts); } return; }
    const btn = e.target.closest('button'); if (!btn) return;
    try {
      if (btn.dataset.snap) { await api(`/nodes/${node}/cmd`, { method: 'POST', body: { cmd: 'snap' } }); toast(`สั่งถ่าย → ${node}`); }
      else if (btn.dataset.preset) { await api(`/cam/${node}/pan`, { method: 'POST', body: { preset: btn.dataset.preset, snap: true } }); toast(`หันไป ${btn.dataset.preset} แล้วถ่าย`); }
      else if (btn.dataset.patrol) { await api(`/cam/${node}/pan`, { method: 'POST', body: { patrol: true } }); toast('กำลังถ่ายทุกมุม…'); }
      else if (btn.dataset.delday) { const day = camState.day[node]; if (!day) return toast('เลือกวันใน time-lapse ก่อน', true); if (!confirm(`ลบภาพของ ${node} วันที่ ${day} ทั้งหมด?`)) return; const r = await api(`/cam/${node}/snapshots?day=${day}`, { method: 'DELETE' }); toast(`ลบ ${r.deleted} ภาพ`); renderCam(); }
      else if (btn.dataset.delall) { if (!confirm(`ลบภาพทั้งหมดของ ${node}? (กู้คืนไม่ได้)`)) return; const r = await api(`/cam/${node}/snapshots`, { method: 'DELETE' }); toast(`ลบ ${r.deleted} ภาพ`); renderCam(); }
      else if (btn.dataset.live) {
        const img = $('.cam-img', card), ts = $('.cam-ts', card);
        if (camState.live?.[node]) { img.src = camState.live[node]; camState.live[node] = null; btn.textContent = '▶ ดูสด'; ts.textContent = 'หยุดดูสดแล้ว'; return; }
        camState.live = camState.live || {}; camState.live[node] = img.src; img.style.display = '';
        img.src = `/api/cam/${node}/live?t=${Date.now()}`; ts.textContent = '🔴 สด (ผ่าน Hut)'; btn.textContent = '⏹ หยุดดูสด';
        img.onerror = () => { if (camState.live?.[node]) { toast('สตรีมหลุด — กล้องอาจไม่ว่างหรือ WiFi อ่อน', true); img.src = camState.live[node]; camState.live[node] = null; btn.textContent = '▶ ดูสด'; } };
      }
      else if (btn.dataset.play) {
        if (camState.playing[node]) { clearInterval(camState.playing[node]); camState.playing[node] = null; btn.textContent = '▶ เล่น'; return; }
        const frames = camState.frames[node] || []; let i = 0; btn.textContent = '⏸ หยุด';
        const view = $('.cam-img', card), ts = $('.cam-ts', card), prog = $('.cam-prog', card);
        camState.playing[node] = setInterval(() => { const f = frames[i]; if (!f) { clearInterval(camState.playing[node]); camState.playing[node] = null; btn.textContent = '▶ เล่น'; return; } view.src = f.url; ts.textContent = fmtTs(f.ts); prog.textContent = `${i + 1}/${frames.length}`; i++; }, 200);
      }
    } catch (err) { toast('ผิดพลาด: ' + err.message, true); }
  });

  // ---- (f) Sage ------------------------------------------------------------
  const sage = { plots: [], open: null, frameIdx: 0 };
  // สรุปแหล่งข้อมูลแวดล้อมของแปลงไว้โชว์บนการ์ด
  const envSummary = (p) => {
    const src = Array.isArray(p.env_sources) ? p.env_sources : [];
    if (src.length) return ' · แวดล้อม ' + esc(src.map((x) => `${label(x.key)}@${x.node}`).join(', '));
    return p.sensor_node ? ' · เซ็นเซอร์ ' + esc(p.sensor_node) : '';
  };
  const STAGE_TH = { empty_soil: 'ดินเปล่า', germinating: 'กำลังงอก', seedling: 'ต้นกล้า', vegetative: 'เติบโตทางใบ', budding: 'ติดตุ่มดอก', flowering: 'ออกดอก', fruiting: 'ติดผล', declining: 'โทรม', unknown: 'ไม่แน่ใจ' };
  const HEALTH_TH = { good: 'แข็งแรง', mild_stress: 'เครียดเล็กน้อย', wilting: 'เหี่ยว', pest_or_disease: 'โรค/แมลง', unknown: '?' };
  const MS_ICON = { planted: '🌱', germinated: '🌿', first_true_leaves: '🍃', leaf_count: '🍃', first_bud: '🌸', first_flower: '🌼', peak_bloom: '💐', stress: '⚠️', recovery: '💚', other: '📌' };
  async function renderSage() {
    try {
      const cfg = await api('/sage/config');
      $('#sage-cfg').textContent = cfg.ready ? `โมเดล: ${cfg.model} (${cfg.provider}) · สูงสุด ${cfg.maxFrames} ภาพ/ครั้ง` : 'ยังไม่ได้ตั้งค่า AI — ใส่ ANTHROPIC_API_KEY ใน infra/.env แล้วรีสตาร์ท Hut';
      const camSel = $('#pl-cam');
      const list = [...nodes.values()];
      camSel.innerHTML = list.filter((n) => n.role === 'cam').map((n) => `<option value="${esc(n.node)}">${esc(n.node)}</option>`).join('') || '<option value="">(ไม่มี Watcher)</option>';
      buildEnvPicker();
      sage.plots = await api('/plots');
      $('#plots').innerHTML = sage.plots.map((p) => { const la = p.last_analysis; const st = la?.status; const pr = la?.progress || {};
        return `<div class="card plot" data-id="${p.id}"><div class="row-between"><div><b>${esc(p.name)}</b> <span class="muted small">กล้อง ${esc(p.cam_node)}${p.cam_angle != null ? ' @' + p.cam_angle + '°' : ''}${envSummary(p)} · ${p.snapshots} ภาพ${p.from_ts ? ' · ตั้งแต่ ' + p.from_ts.slice(0, 10) : ''}${p.to_ts ? ' ถึง ' + p.to_ts.slice(0, 10) : ''}</span></div>
          <div class="row"><span class="muted small sage-st">${st === 'running' ? `⏳ กำลังวิเคราะห์ ${pr.step === 'observe' ? `ภาพ ${pr.done}/${pr.total}` : pr.step === 'synthesize' ? 'สรุปรายงาน…' : ''}` : st === 'done' ? `✅ วิเคราะห์ล่าสุด ${esc(ago(la.created_at))}` : st === 'failed' ? '❌ ล้มเหลว' : st === 'queued' ? '⏳ รอคิว' : 'ยังไม่เคยวิเคราะห์'}</span>
          <button class="primary small" data-analyze="1" ${st === 'running' || st === 'queued' ? 'disabled' : ''}>🔍 วิเคราะห์</button>${st === 'done' ? `<button class="small" data-report="${la.id}">📄 ดูรายงาน</button>` : ''}<button class="small" data-env="1">🌡 แวดล้อม</button><button class="ghost small danger" data-del="1">ลบ</button></div></div><div class="plot-env hidden"></div></div>`; }).join('') || '<p class="muted">ยังไม่มีแปลง — สร้างด้านบน (ต้องมีภาพจาก Watcher ก่อน)</p>';
    } catch (e) { toast('Sage: ' + e.message, true); }
  }
  // แหล่งข้อมูลแวดล้อมของแปลง — ติ๊กข้าม node ได้ (เช่น อุณหภูมิจาก earth + แสงจาก sky)
  const envPick = new Set();
  const sensorsByNode = () => {
    const m = new Map();
    for (const n of [...nodes.values()].sort((a, b) => a.node.localeCompare(b.node))) {
      const keys = Object.keys(n.latest || {}).sort();
      if (keys.length) m.set(n.node, keys);
    }
    return m;
  };
  // วาดชิปติ๊กลงใน el โดยผูกกับ Set ที่ส่งมา (ใช้ทั้งฟอร์มสร้างแปลงและตอนแก้แปลงเดิม)
  function renderEnvPicker(el, picked, onChange) {
    const byNode = sensorsByNode();
    el.innerHTML = [...byNode].map(([n, keys]) => `<div class="grp"><b>${esc(n)}</b>${keys.map((k) => {
      const s = sid(n, k), on = picked.has(s);
      return `<label class="chip${on ? ' on' : ''}"><input type="checkbox" data-sid="${esc(s)}"${on ? ' checked' : ''}><i style="background:${on ? 'var(--leaf)' : 'var(--axis)'}"></i>${esc(label(k))}</label>`;
    }).join('')}</div>`).join('');
    $$('input', el).forEach((i) => (i.onchange = () => {
      i.checked ? picked.add(i.dataset.sid) : picked.delete(i.dataset.sid);
      renderEnvPicker(el, picked, onChange); onChange?.();
    }));
  }
  function buildEnvPicker() {
    const byNode = sensorsByNode();
    for (const s of [...envPick]) { const [n, k] = unsid(s); if (!byNode.get(n)?.includes(k)) envPick.delete(s); }
    renderEnvPicker($('#pl-env'), envPick);
  }

  $('#pl-create').addEventListener('click', async () => {
    const env_sources = [...envPick].map((s) => { const [node, key] = unsid(s); return { node, key }; });
    try {
      await api('/plots', { method: 'POST', body: { name: $('#pl-name').value, cam_node: $('#pl-cam').value, env_sources, from: $('#pl-from').value || undefined, to: $('#pl-to').value ? $('#pl-to').value + 'T23:59:59' : undefined, notes: $('#pl-notes').value || undefined, cam_angle: $('#pl-angle').value || undefined } });
      $('#pl-name').value = ''; envPick.clear(); buildEnvPicker(); toast('สร้างแปลงแล้ว'); renderSage();
    } catch (e) { toast('ผิดพลาด: ' + e.message, true); }
  });
  $('#plots').addEventListener('click', async (e) => {
    const btn = e.target.closest('button'); if (!btn) return; const id = btn.closest('.plot').dataset.id;
    try {
      if (btn.dataset.env) { toggleEnvEditor(btn.closest('.plot'), id); return; }
      if (btn.dataset.envsave) {
        const card = btn.closest('.plot'), picked = card._pick;
        await api(`/plots/${id}`, { method: 'PATCH', body: { env_sources: [...picked].map((x) => { const [node, key] = unsid(x); return { node, key }; }) } });
        toast('บันทึกแหล่งข้อมูลแวดล้อมแล้ว'); renderSage(); return;
      }
      if (btn.dataset.analyze) { const r = await api(`/plots/${id}/analyze`, { method: 'POST', body: {} }); toast(`เริ่มวิเคราะห์ (#${r.analysis_id})`); renderSage(); }
      else if (btn.dataset.report) { openReport(Number(btn.dataset.report)); }
      else if (btn.dataset.del) { if (!confirm('ลบแปลงนี้และรายงานทั้งหมด?')) return; await api(`/plots/${id}`, { method: 'DELETE' }); renderSage(); }
    } catch (err) { toast('ผิดพลาด: ' + err.message, true); }
  });
  // เปิด/ปิดแผงแก้แหล่งข้อมูลแวดล้อมใต้การ์ดแปลง
  function toggleEnvEditor(card, id) {
    const box = $('.plot-env', card);
    if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
    const p = sage.plots.find((x) => String(x.id) === String(id));
    const picked = new Set((p?.env_sources || []).map((x) => sid(x.node, x.key)));
    card._pick = picked;
    box.innerHTML = '<span class="flab">ค่าที่ให้ Sage ใช้วิเคราะห์แปลงนี้</span><div class="picker"></div><div class="row"><button class="primary small" data-envsave="1">บันทึก</button></div>';
    renderEnvPicker($('.picker', box), picked);
    box.classList.remove('hidden');
  }

  function onSageProgress(m) {
    if (!$('#tab-sage').classList.contains('active')) return;
    if (m.status === 'done' || m.status === 'failed') { renderSage(); if (m.status === 'done') openReport(m.id); return; }
    const card = [...$$('.plot')].find((c) => sage.plots.find((p) => String(p.id) === c.dataset.id)?.last_analysis?.id === m.id);
    if (card) $('.sage-st', card).textContent = `⏳ กำลังวิเคราะห์ ${m.step === 'observe' ? `ภาพ ${m.done}/${m.total}${m.last ? ' · ' + m.last.date + ' ' + (STAGE_TH[m.last.stage] || '') : ''}` : m.step === 'synthesize' ? 'สรุปรายงาน…' : ''}`;
    else renderSage();
  }
  // ---- report + interactive timeline
  async function openReport(id) {
    const a = await api(`/analyses/${id}`); sage.open = a; sage.frameIdx = a.frames.length - 1;
    const box = $('#sage-report'); box.classList.remove('hidden');
    if (a.status !== 'done') { box.innerHTML = `<div class="card">สถานะ: ${a.status} ${a.error ? '— ' + esc(a.error) : ''}</div>`; return; }
    const r = a.report, F = a.frames, E = a.env;
    const dates = F.map((f) => f.date);
    const t0 = new Date(F[0].ts), t1 = new Date(F[F.length - 1].ts); const spanMs = Math.max(3600000, t1 - t0);
    const d0 = new Date(dates[0]); const span = Math.max(1, (new Date(dates[dates.length - 1]) - d0) / 86400000);
    const x = (when) => 4 + 92 * Math.min(1, Math.max(0, (new Date(when) - t0) / spanMs));   // % across (ตามเวลาจริง)
    const ms = r.milestones.filter((m) => m.date >= dates[0] && m.date <= dates[dates.length - 1]);
    box.innerHTML = `<div class="card">
      <div class="row-between"><h3>📄 ${esc(a.name)} — รายงานการเจริญเติบโต</h3><span class="muted small">${esc(a.model)} · ${F.length} ภาพ · tokens ${a.tokens_in + a.tokens_out} · ${esc(fmtTs(a.created_at))} <button class="ghost small" id="rep-close">ปิด</button></span></div>
      <p>${esc(r.summary)}</p>
      <h4>Timeline</h4>
      <div class="tl"><div class="tl-track">
        ${F.map((f, i) => `<i class="tl-dot" style="left:${x(f.ts)}%" data-i="${i}" title="${esc(f.date)} ${esc(f.time)} ${STAGE_TH[f.stage] || ''}"></i>`).join('')}
        ${ms.map((m) => `<span class="tl-ms" style="left:${x(m.date + 'T12:00:00')}%" data-date="${esc(m.date)}" title="${esc(m.date)} ${esc(m.label)}">${MS_ICON[m.type] || '📌'}<b>${esc(m.label)}</b></span>`).join('')}
      </div><div class="tl-axis"><span>${esc(F[0].date)} ${esc(F[0].time)}</span><span>${esc(F[F.length - 1].date)} ${esc(F[F.length - 1].time)}</span></div></div>
      <input type="range" id="tl-range" min="0" max="${F.length - 1}" value="${F.length - 1}" style="width:100%">
      <div class="grid2">
        <div><img id="tl-img" src="" alt="" style="width:100%;border-radius:10px;background:#000;aspect-ratio:4/3;object-fit:contain"><div id="tl-cap" class="muted small"></div></div>
        <div id="tl-obs"></div>
      </div>
      <h4>การเติบโต</h4>${miniChart([{ name: 'ใบ (จำนวน)', color: 'var(--s1)', pts: r.growth_series.map((g) => [g.date, g.leaf_count]) }, { name: 'สูง (cm)', color: 'var(--s2)', pts: r.growth_series.map((g) => [g.date, g.height_cm]) }], d0, span)}
      ${E.length ? `<h4>สิ่งแวดล้อม (เฉลี่ยรายวัน)</h4>${envCharts(E, d0, span)}` : '<p class="muted small">ไม่มีข้อมูลเซ็นเซอร์ในช่วงนี้ — ติ๊กค่าแวดล้อมตอนสร้างแปลง เพื่อให้ Sage เชื่อมโยงสภาพแวดล้อมได้</p>'}
      <div class="grid2"><div><h4>Milestones</h4><ul>${r.milestones.map((m) => `<li><b>${esc(m.date)}</b> ${MS_ICON[m.type] || ''} ${esc(m.label)} <span class="muted small">— ${esc(m.evidence)}</span></li>`).join('') || '<li class="muted">ไม่พบ</li>'}</ul></div>
      <div><h4>สิ่งแวดล้อมมีผลอย่างไร</h4><ul>${r.env_insights.map((s) => `<li>${esc(s)}</li>`).join('')}</ul><h4>คำแนะนำ</h4><ul>${r.recommendations.map((s) => `<li>${esc(s)}</li>`).join('')}</ul><p class="muted small">ข้อจำกัดข้อมูล: ${esc(r.data_quality)}</p></div></div>
    </div>`;
    const show = (i) => { const f = F[i]; if (!f) return; sage.frameIdx = i; $('#tl-img').src = f.url; $('#tl-cap').textContent = `${f.date} ${f.time} · ภาพ ${i + 1}/${F.length}`;
      const e = E.find((x) => x.date === f.date);
      $('#tl-obs').innerHTML = `<div class="tiles"><div class="tile"><div class="k">ระยะ</div><div class="v">${STAGE_TH[f.stage] || f.stage}</div></div><div class="tile"><div class="k">ใบ</div><div class="v">${f.leaf_count ?? '—'}</div></div><div class="tile"><div class="k">สูง</div><div class="v">${f.height_cm_est ?? '—'}<small>cm</small></div></div><div class="tile"><div class="k">ดอก/ตุ่ม</div><div class="v">${f.flower_count}/${f.bud_count}</div></div><div class="tile"><div class="k">สุขภาพ</div><div class="v" style="font-size:15px">${HEALTH_TH[f.health] || f.health}</div></div><div class="tile"><div class="k">ความมั่นใจ</div><div class="v">${Math.round(f.confidence * 100)}<small>%</small></div></div></div>
        <p><b>เปลี่ยนจากภาพก่อน:</b> ${esc(f.change_from_previous)}</p><p>${esc(f.notes)}</p>
        ${e ? `<p class="muted small">วันนี้: ${esc(envDayLine(e, E))}</p>` : ''}`;
      $$('.tl-dot').forEach((d) => d.classList.toggle('on', Number(d.dataset.i) === i)); $('#tl-range').value = i; };
    show(sage.frameIdx);
    $('#tl-range').addEventListener('input', (ev) => show(Number(ev.target.value)));
    box.addEventListener('click', (ev) => { const dot = ev.target.closest('.tl-dot'); if (dot) return show(Number(dot.dataset.i));
      const m = ev.target.closest('.tl-ms'); if (m) { const i = F.findIndex((f) => f.date >= m.dataset.date); if (i >= 0) show(i); return; }
      if (ev.target.id === 'rep-close') box.classList.add('hidden'); });
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  // ---- สิ่งแวดล้อมในรายงาน: รองรับหลาย node/หลายค่า (และรายงานเก่าที่ยังเป็นคีย์แบน) ----
  const envUnit = (k) => (k.endsWith('_c') ? '°C' : k.endsWith('_pct') ? '%' : k === 'lux' ? 'lx' : k === 'press_hpa' ? 'hPa' : '');
  // คืน [{id,node,key,name,unit}] เรียงคงที่จากข้อมูลที่มีจริงในรายงาน
  function envSeries(E) {
    const seen = new Map();
    for (const e of E) {
      if (e.src) { for (const id of Object.keys(e.src)) if (!seen.has(id)) { const [node, key] = unsid(id); seen.set(id, { id, node, key, legacy: false }); } }
      else for (const k of Object.keys(e)) if (k !== 'date' && e[k] && typeof e[k] === 'object') if (!seen.has(k)) seen.set(k, { id: k, node: '', key: k, legacy: true });
    }
    const multi = new Set([...seen.values()].map((x) => x.node)).size > 1;
    return [...seen.values()].map((x) => ({ ...x, name: label(x.key) + (multi && x.node ? ` · ${x.node}` : ''), unit: envUnit(x.key) }));
  }
  const envVal = (e, s) => (s.legacy ? e[s.id] : e.src?.[s.id]) || null;
  // แผงละหน่วย — ไม่ยัดสองสเกลในกราฟเดียว
  function envCharts(E, d0, span) {
    const list = envSeries(E);
    if (!list.length) return '<p class="muted small">ไม่มีข้อมูล</p>';
    const groups = [];
    list.forEach((s, i) => {
      const g = groups.find((x) => x.unit === s.unit) || (groups.push({ unit: s.unit, items: [] }), groups[groups.length - 1]);
      g.items.push({ ...s, color: `var(--c${(i % 8) + 1})` });
    });
    return groups.map((g) => miniChart(g.items.map((s) => ({
      name: `${s.name}${s.unit ? ' ' + s.unit : ''}`, color: s.color,
      pts: E.map((e) => [e.date, envVal(e, s)?.avg ?? null]),
    })), d0, span)).join('');
  }
  function envDayLine(e, E) {
    return envSeries(E).map((s) => { const v = envVal(e, s); return v ? `${s.name} ${v.min}–${v.max}${s.unit}` : null; }).filter(Boolean).join(' · ') || 'ไม่มีข้อมูล';
  }

  function miniChart(series, d0, span) {
    const W = 600, H = 120, L = 34, R = 8, T = 8, B = 18;
    const vals = series.flatMap((s) => s.pts.map((p) => p[1]).filter((v) => v != null)); if (!vals.length) return '<p class="muted small">ไม่มีข้อมูล</p>';
    const lo = Math.min(...vals), hi = Math.max(...vals); const y = (v) => T + (H - T - B) * (1 - (v - lo) / Math.max(1e-6, hi - lo)); const xx = (date) => L + (W - L - R) * ((new Date(date) - d0) / 86400000) / span;
    return `<div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div><svg viewBox="0 0 ${W} ${H}" class="mini">
      <line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" stroke="var(--axis)"/><text x="2" y="${T + 10}" class="ax">${hi}</text><text x="2" y="${H - B}" class="ax">${lo}</text>
      ${series.map((s) => { const p = s.pts.filter((q) => q[1] != null); return `<polyline fill="none" stroke="${s.color}" stroke-width="2" points="${p.map((q) => `${xx(q[0]).toFixed(1)},${y(q[1]).toFixed(1)}`).join(' ')}"/>${p.map((q) => `<circle cx="${xx(q[0]).toFixed(1)}" cy="${y(q[1]).toFixed(1)}" r="3" fill="${s.color}"><title>${esc(q[0])}: ${q[1]}</title></circle>`).join('')}`; }).join('')}
    </svg>`;
  }

  // ---- (a) status -----------------------------------------------------------
  function renderBanner() {
    const all = [...nodes.values()];
    const off = all.filter((n) => !n.online);
    const b = $('#banner');
    if (all.length === 0) { b.className = 'banner'; b.textContent = 'ยังไม่มี node เชื่อมต่อ'; return; }
    if (off.length === 0) { b.className = 'banner ok'; b.innerHTML = `<strong>ระบบพร้อม</strong> ${all.length}/${all.length} node ออนไลน์`; return; }
    b.className = 'banner warn';
    b.innerHTML = `<strong>ออฟไลน์ ${off.length} node:</strong> ${off.map((n) => `<span class="badge">${esc(n.node)} · ${esc(ago(n.last_seen))}</span>`).join(' ')} <span class="muted small">(${all.length - off.length}/${all.length} ออนไลน์)</span>`;
  }

  function tileHtml(n, k, v) {
    const stale = Date.now() - new Date(v.ts).getTime() > 5 * 60e3;
    const pct = k.endsWith('_pct');
    return `<div class="tile ${stale ? 'stale' : ''}" data-key="${esc(k)}" title="${esc(k)} · ${esc(fmtTs(v.ts))}">
      <div class="k">${esc(label(k))}</div>
      <div class="v">${fmtV(v.value)}<small>${esc(unit(k, n))}</small></div>
      ${pct ? `<div class="bar"><i style="width:${Math.max(0, Math.min(100, v.value))}%"></i></div>` : ''}
    </div>`;
  }

  let fwInfo = { firmware: {}, nodes: [] }, fwAt = 0;
  async function loadFirmware() { if (Date.now() - fwAt < 30000) return fwInfo; try { fwInfo = await api('/firmware'); fwAt = Date.now(); } catch {} return fwInfo; }
  const fwFor = (node) => fwInfo.nodes.find((x) => x.node === node);

  function nodeCard(n) {
    const keys = Object.keys(n.latest).sort();
    const metaSw = Array.isArray(n.meta?.switches) ? n.meta.switches : [];
    const swKeys = [...new Set([...metaSw.map((s) => s.key), ...Object.keys(n.switches || {})])];
    const dbg = n.debug || {};
    const role = n.role || (swKeys.length ? 'keeper' : 'scout');
    return `<article class="card node ${n.online ? '' : 'offline'}" data-node="${esc(n.node)}">
      <div class="head">
        <span class="status-dot ${n.online ? 'on' : ''}" title="${n.online ? 'ออนไลน์' : 'ออฟไลน์'}"></span>
        <span class="name">${esc(n.node)}</span>
        <span class="badge ${esc(role)}">${esc(role)}</span>
        <span class="muted small" style="margin-left:auto">${n.online ? 'ออนไลน์' : 'ออฟไลน์'} · ${esc(ago(n.last_seen))}</span>
      </div>
      <div class="meta">
        ${dbg.rssi !== undefined ? `<span>RSSI ${esc(dbg.rssi)} dBm</span>` : ''}
        ${n.ip ? `<span>IP ${esc(n.ip)}</span>` : ''}
        ${n.fw ? `<span>${esc(n.fw)}</span>` : ''}
        ${(() => { const f = fwFor(n.node); return f?.update ? `<span class="fw-new">มีเวอร์ชัน ${esc(f.available)}</span>` : ''; })()}
        ${dbg.uptime_s !== undefined ? `<span>up ${Math.floor(dbg.uptime_s / 3600)}h${Math.floor((dbg.uptime_s % 3600) / 60)}m</span>` : ''}
        ${dbg.heap !== undefined ? `<span>heap ${Math.round(dbg.heap / 1024)}k</span>` : ''}
      </div>
      ${keys.length ? `<div class="tiles">${keys.map((k) => tileHtml(n, k, n.latest[k])).join('')}</div>` : ''}
      ${swKeys.length ? `<div class="switches">${swKeys.map((k) => {
        const st = n.switches?.[k]?.state || '—';
        const m = metaSw.find((s) => s.key === k) || n.meta?.switch_meta?.[k] || {};
        return `<div class="sw" data-key="${esc(k)}">
          <span class="k">${esc(k)}</span>
          <span class="st ${esc(st)}">${esc(st)}</span>
          <input type="number" min="0" step="10" value="60" title="วินาที (0 = ไม่จำกัด ≤ max_on_s)"><span class="unit">วิ.</span>
          <button class="on small" data-act="ON" ${n.online ? '' : 'disabled'}>เปิด</button>
          <button class="off small" data-act="OFF" ${n.online ? '' : 'disabled'}>ปิด</button>
          ${m.max_on_s ? `<span class="muted small">max ${m.max_on_s}s</span>` : ''}
        </div>`;
      }).join('')}</div>` : ''}
      <div class="row">
        ${n.ip ? `<a class="btn primary" href="http://${esc(n.ip)}/" target="_blank" rel="noopener" title="เปิดหน้าตั้งค่าของ ${esc(n.node)} (http://${esc(n.node)}.local/)">⚙ ตั้งค่า</a>` : ''}
        <button class="ghost small" data-cmd="identify" title="กระพริบ LED 10 วิ.">identify</button>
        <button class="ghost small danger" data-cmd="reboot">reboot</button>
        ${n.online ? '' : `<button class="ghost small danger" data-forget="1" title="ลบ node นี้และข้อมูลย้อนหลังออกจาก Hut">ลบ</button>`}
        ${(() => { const f = fwFor(n.node); return f?.env && f.available ? `<button class="ghost small ${f.update ? 'primary' : ''}" data-ota="${esc(f.env)}" ${n.online ? '' : 'disabled'} title="OTA จาก server: ${esc(f.env)} ${esc(f.available)}">${f.update ? 'อัปเดต OTA → ' + esc(f.available) : 'flash ซ้ำ OTA'}</button>` : ''; })()}
      </div>
    </article>`;
  }

  async function renderStatus() {
    renderBanner();
    await loadFirmware();
    const list = [...nodes.values()].sort((a, b) => a.node.localeCompare(b.node));
    $('#nodes').innerHTML = list.map(nodeCard).join('');
    $('#nodes-empty').classList.toggle('hidden', list.length > 0);
    const pending = fwInfo.nodes.filter((x) => x.update && x.online).length;
    const b = $('#ota-all'); if (b) { b.classList.toggle('hidden', pending === 0); b.textContent = `อัปเดต OTA ทุก node ที่ล้าสมัย (${pending})`; }
  }
  $('#ota-all')?.addEventListener('click', async () => {
    if (!confirm('ส่งคำสั่ง OTA ไปทุก node ที่มีเวอร์ชันใหม่กว่า?')) return;
    try { const r = await api('/ota', { method: 'POST', body: {} }); toast(`ส่ง OTA ${r.sent.length} node`); fwAt = 0; } catch (err) { toast('ผิดพลาด: ' + err.message, true); }
  });

  $('#nodes').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const node = btn.closest('.node').dataset.node;
    try {
      if (btn.dataset.act) {
        const sw = btn.closest('.sw');
        const key = sw.dataset.key;
        const seconds = Number(sw.querySelector('input').value) || undefined;
        const r = await api('/switch', { method: 'POST', body: { node, key, state: btn.dataset.act, seconds: btn.dataset.act === 'ON' ? seconds : undefined } });
        toast(`ส่ง ${r.payload} → ${node}.${key}`);
      } else if (btn.dataset.forget) {
        if (!confirm(`ลบ ${node} และข้อมูลย้อนหลังทั้งหมดออกจาก Hut?`)) return;
        await api(`/nodes/${node}`, { method: 'DELETE' });
        nodes.delete(node); renderStatus(); toast(`ลบ ${node} แล้ว`);
      } else if (btn.dataset.ota) {
        if (!confirm(`ส่ง OTA (${btn.dataset.ota}) ไปที่ ${node}? node จะรีบูตเมื่ออัปเดตเสร็จ`)) return;
        const r = await api(`/nodes/${node}/ota`, { method: 'POST', body: { env: btn.dataset.ota } });
        toast(`ส่ง OTA ${r.version} → ${node}`); fwAt = 0;
      } else if (btn.dataset.cmd) {
        if (btn.dataset.cmd === 'reboot' && !confirm(`reboot ${node}?`)) return;
        await api(`/nodes/${node}/cmd`, { method: 'POST', body: { cmd: btn.dataset.cmd } });
        toast(`ส่ง ${btn.dataset.cmd} → ${node}`);
      }
    } catch (err) { toast('ผิดพลาด: ' + err.message, true); }
  });

  // periodic "ago" refresh
  // refresh สถานะทุก 5 วินาทีขณะเปิดแท็บสถานะ (ดึงจาก server ใหม่ ไม่ใช่แค่วาดจาก memory)
  setInterval(() => { if ($('#tab-status').classList.contains('active') && !document.hidden) loadNodes().catch(() => renderStatus()); }, 5000);

  // ---- (b) chart : หลายเส้น หลาย node ในแกนเวลาเดียวกัน ------------------------
  // เส้นที่หน่วยเดียวกันอยู่แผงเดียวกัน หน่วยต่างกันแยกแผง (ไม่ใช้สองแกน Y ในแผงเดียว)
  const CPAL = ['--c1', '--c2', '--c3', '--c4', '--c5', '--c6', '--c7', '--c8'];
  const MAXSER = 8;
  const sid = (node, key) => `${node}|${key}`;
  const unsid = (s) => { const i = s.indexOf('|'); return [s.slice(0, i), s.slice(i + 1)]; };

  const chart = {
    range: '24h',
    sel: new Set(),           // sid ที่เลือกไว้
    data: new Map(),          // sid -> { rows:[{t,v,min,max}], res }
    order: [],                // sid ทั้งหมดที่มี (เรียงแล้ว) — ใช้ล็อกสีให้ติดกับ "ตัวเซ็นเซอร์" ไม่ใช่ลำดับที่เลือก
    canvas: $('#chart'), tip: $('#c-tip'), hover: null, reqId: 0,

    colorOf(s) { const i = this.order.indexOf(s); return CPAL[(i < 0 ? 0 : i) % CPAL.length]; },
    unitOf(s) { const [n, k] = unsid(s); return unit(k, nodes.get(n)) || ''; },
    nameOf(s) { const [n, k] = unsid(s); return `${label(k)} · ${n}`; },

    restore() {
      try { const v = JSON.parse(localStorage.getItem('gnome-chart-sel') || '[]'); if (Array.isArray(v)) this.sel = new Set(v); } catch {}
      const r = localStorage.getItem('gnome-chart-range'); if (r) this.range = r;
      $$('#c-range button').forEach((b) => b.classList.toggle('active', b.dataset.range === this.range));
    },
    save() {
      localStorage.setItem('gnome-chart-sel', JSON.stringify([...this.sel]));
      localStorage.setItem('gnome-chart-range', this.range);
    },

    // สร้างรายการติ๊ก จัดกลุ่มตาม node
    buildPicker() {
      const all = [];
      for (const n of [...nodes.values()].sort((a, b) => a.node.localeCompare(b.node)))
        for (const k of Object.keys(n.latest).sort()) all.push(sid(n.node, k));
      this.order = all;
      // ทิ้ง sid ที่ไม่มีแล้ว
      for (const s of [...this.sel]) if (!all.includes(s)) this.sel.delete(s);
      // ยังไม่เคยเลือก → เลือกค่าแรกให้ดูก่อน
      if (!this.sel.size && all.length && !localStorage.getItem('gnome-chart-sel')) this.sel.add(all[0]);
      const full = this.sel.size >= MAXSER;
      const byNode = new Map();
      for (const s of all) { const [n] = unsid(s); if (!byNode.has(n)) byNode.set(n, []); byNode.get(n).push(s); }
      $('#c-picker').innerHTML = [...byNode].map(([n, list]) => `<div class="grp"><b>${esc(n)}</b>${list.map((s) => {
        const on = this.sel.has(s), [, k] = unsid(s);
        return `<label class="chip${on ? ' on' : ''}${full && !on ? ' full' : ''}"${on ? ` style="color:var(${this.colorOf(s)})"` : ''}>
          <input type="checkbox" data-sid="${esc(s)}"${on ? ' checked' : ''}${full && !on ? ' disabled' : ''}>
          <i style="background:${on ? `var(${this.colorOf(s)})` : 'var(--axis)'}"></i>${esc(label(k))}</label>`;
      }).join('')}</div>`).join('');
      $$('#c-picker input').forEach((el) => (el.onchange = () => {
        const s = el.dataset.sid;
        if (el.checked) { if (this.sel.size >= MAXSER) { el.checked = false; toast(`ดูพร้อมกันได้สูงสุด ${MAXSER} เส้น`, true); return; } this.sel.add(s); }
        else this.sel.delete(s);
        this.save(); this.buildPicker(); this.load();
      }));
    },

    async load() {
      this.buildPicker();
      const want = [...this.sel];
      $('#c-empty').classList.toggle('hidden', want.length > 0);
      if (!want.length) { this.data.clear(); $('#c-info').textContent = ''; $('#c-legend').innerHTML = ''; this.draw(); return; }
      const my = ++this.reqId;
      const ms = { '24h': 86400e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3 }[this.range];
      const since = new Date(Date.now() - ms).toISOString();
      $('#c-info').textContent = 'กำลังโหลด…';
      const got = await Promise.all(want.map(async (s) => {
        const [n, k] = unsid(s);
        try {
          const r = await api(`/readings?node=${encodeURIComponent(n)}&key=${encodeURIComponent(k)}&since=${since}`);
          return [s, { rows: r.rows.map((x) => ({ t: new Date(x.ts).getTime(), v: x.value, min: x.min, max: x.max })), res: r.res }];
        } catch { return [s, { rows: [], res: 'raw' }]; }
      }));
      if (my !== this.reqId) return;               // มีคำขอใหม่แซงมาแล้ว
      this.data = new Map(got);
      const pts = got.reduce((a, [, d]) => a + d.rows.length, 0);
      const res = got.some(([, d]) => d.res === '5m') ? 'เฉลี่ย 5 นาที' : 'ค่าดิบ';
      $('#c-info').textContent = `${want.length} เส้น · ${pts.toLocaleString('th-TH')} จุด · ${res}`;
      $('#c-empty').classList.toggle('hidden', pts > 0);
      if (!pts) $('#c-empty').textContent = 'ไม่มีข้อมูลในช่วงนี้';
      this.draw();
    },

    // แบ่งแผงตามหน่วย เรียงตามลำดับสีเพื่อให้คงที่
    panels() {
      const out = [];
      for (const s of this.order) {
        if (!this.sel.has(s) || !(this.data.get(s)?.rows.length)) continue;
        const u = this.unitOf(s);
        let p = out.find((x) => x.unit === u);
        if (!p) out.push((p = { unit: u, series: [] }));
        p.series.push(s);
      }
      return out;
    },

    draw() {
      const c = this.canvas, dpr = devicePixelRatio || 1;
      const panels = this.panels();
      const PH = panels.length > 2 ? 150 : panels.length === 2 ? 190 : 300;   // สูงต่อแผง
      const AX = 26, GAP = 14;
      const H = Math.max(140, panels.length ? panels.length * PH + (panels.length - 1) * GAP + AX : 200);
      c.parentElement.style.setProperty('--ch', H + 'px');
      const W = c.clientWidth || 600;
      if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
      const ctx = c.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      this._panels = null;
      if (!panels.length) { this.tip.classList.add('hidden'); $('#c-legend').innerHTML = ''; return; }
      const cs = getComputedStyle(root), col = (v) => cs.getPropertyValue(v).trim();
      const padL = 50, padR = 12;

      // แกนเวลาเดียวกันทุกแผง
      let t0 = Infinity, t1 = -Infinity;
      for (const p of panels) for (const s of p.series) for (const r of this.data.get(s).rows) { if (r.t < t0) t0 = r.t; if (r.t > t1) t1 = r.t; }
      if (!(t1 > t0)) t1 = t0 + 1;
      const X = (t) => padL + ((t - t0) / (t1 - t0)) * (W - padL - padR);
      const plotB = H - AX;

      ctx.font = '11px system-ui'; ctx.lineJoin = 'round';
      const boxes = [];
      panels.forEach((p, pi) => {
        const top = pi * (PH + GAP) + 10, bot = top + PH - 10;
        let lo = Infinity, hi = -Infinity;
        for (const s of p.series) for (const r of this.data.get(s).rows) { const a = r.min ?? r.v, b = r.max ?? r.v; if (a < lo) lo = a; if (b > hi) hi = b; }
        const rawLo = lo, rawHi = hi;
        if (hi === lo) { hi += 1; lo -= 1; }
        const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
        // อย่าให้แกนหลุดไปติดลบ/เกิน 100% ในเมื่อค่าจริงไม่เคยไปถึง (lux, %, ฯลฯ)
        if (rawLo >= 0 && lo < 0) lo = 0;
        if (p.unit === '%' && rawHi <= 100 && hi > 100) hi = 100;
        const Y = (v) => bot - ((v - lo) / (hi - lo)) * (bot - top);
        boxes.push({ top, bot, Y, unit: p.unit, series: p.series });
        // เส้นกริด + แกน Y
        ctx.strokeStyle = col('--grid'); ctx.lineWidth = 1; ctx.fillStyle = col('--muted'); ctx.textAlign = 'right';
        for (let i = 0; i <= 3; i++) {
          const v = lo + ((hi - lo) * i) / 3, y = Y(v);
          ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
          ctx.fillText(fmtV(v), padL - 6, y + 4);
        }
        ctx.strokeStyle = col('--axis'); ctx.beginPath(); ctx.moveTo(padL, top); ctx.lineTo(padL, bot); ctx.lineTo(W - padR, bot); ctx.stroke();
        // ชื่อหน่วยกำกับแผง
        ctx.textAlign = 'left'; ctx.fillStyle = col('--ink2');
        ctx.fillText(p.unit || 'ไม่มีหน่วย', padL + 4, top - 1);
        // แถบ min–max เฉพาะตอนมีเส้นเดียวในแผง (ซ้อนกันหลายเส้นจะอ่านไม่ออก)
        if (p.series.length === 1) {
          const d = this.data.get(p.series[0]);
          if (d.res === '5m' && d.rows.length > 1) {
            ctx.fillStyle = col(this.colorOf(p.series[0])) + '33';
            ctx.beginPath();
            d.rows.forEach((r, i) => (i ? ctx.lineTo(X(r.t), Y(r.max)) : ctx.moveTo(X(r.t), Y(r.max))));
            for (let i = d.rows.length - 1; i >= 0; i--) ctx.lineTo(X(d.rows[i].t), Y(d.rows[i].min));
            ctx.closePath(); ctx.fill();
          }
        }
        // เส้นข้อมูล
        for (const s of p.series) {
          const rows = this.data.get(s).rows;
          ctx.strokeStyle = col(this.colorOf(s)); ctx.lineWidth = 2; ctx.beginPath();
          rows.forEach((r, i) => (i ? ctx.lineTo(X(r.t), Y(r.v)) : ctx.moveTo(X(r.t), Y(r.v))));
          ctx.stroke();
          if (rows.length === 1) { ctx.fillStyle = ctx.strokeStyle; ctx.beginPath(); ctx.arc(X(rows[0].t), Y(rows[0].v), 4, 0, 7); ctx.fill(); }
        }
      });

      // ป้ายแกนเวลา (อันเดียว ใช้ร่วมกันทุกแผง)
      const span = t1 - t0, nx = Math.max(2, Math.min(6, Math.floor(W / 140)));
      ctx.textAlign = 'center'; ctx.fillStyle = col('--muted');
      for (let i = 0; i <= nx; i++) {
        const t = t0 + (span * i) / nx, d = new Date(t);
        const s = span > 2 * 86400e3 ? d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' }) : d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
        ctx.fillText(s, Math.min(W - 26, Math.max(26, X(t))), plotB + 17);
      }

      // crosshair เส้นเดียว พาดทุกแผง + tooltip รวมทุกค่า ณ เวลานั้น
      const rowsAt = [];
      if (this.hover != null) {
        const x = Math.max(padL, Math.min(W - padR, this.hover));
        const t = t0 + ((x - padL) / (W - padL - padR)) * (t1 - t0);
        ctx.strokeStyle = col('--ink2'); ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(x, 8); ctx.lineTo(x, plotB); ctx.stroke(); ctx.setLineDash([]);
        for (const b of boxes) for (const s of b.series) {
          const rows = this.data.get(s).rows;
          let best = null, bd = Infinity;
          for (const r of rows) { const d = Math.abs(r.t - t); if (d < bd) { bd = d; best = r; } }
          if (!best || bd > Math.max(span / 40, 120e3)) continue;
          const px = X(best.t), py = b.Y(best.v);
          ctx.fillStyle = col('--surface'); ctx.beginPath(); ctx.arc(px, py, 5, 0, 7); ctx.fill();
          ctx.fillStyle = col(this.colorOf(s)); ctx.beginPath(); ctx.arc(px, py, 3.5, 0, 7); ctx.fill();
          rowsAt.push({ s, r: best });
        }
        const tip = this.tip;
        if (rowsAt.length) {
          const ts = rowsAt.reduce((a, o) => (a == null || o.r.t > a ? o.r.t : a), null);
          tip.innerHTML = `<b>${esc(fmtTs(new Date(ts).toISOString()))}</b><table>${rowsAt.map((o) =>
            `<tr><td><i style="background:${col(this.colorOf(o.s))}"></i>${esc(this.nameOf(o.s))}</td><td class="n">${fmtV(o.r.v)}${esc(this.unitOf(o.s))}</td></tr>`).join('')}</table>`;
          tip.classList.remove('hidden');
          const tw = tip.offsetWidth, th = tip.offsetHeight;
          tip.style.left = Math.max(0, Math.min(W - tw - 4, x + 12)) + 'px';
          tip.style.top = Math.max(0, Math.min(H - th - 4, (rowsAt.length ? 20 : 20))) + 'px';
        } else tip.classList.add('hidden');
      } else this.tip.classList.add('hidden');

      // legend: มีทุกครั้งที่ >= 2 เส้น (ไม่ให้แยกด้วยสีอย่างเดียว) + โชว์ค่าล่าสุด
      const sels = panels.flatMap((p) => p.series);
      $('#c-legend').innerHTML = sels.length < 2 ? '' : sels.map((s) => {
        const rows = this.data.get(s).rows, last = rows[rows.length - 1];
        return `<span><i style="background:var(${this.colorOf(s)})"></i>${esc(this.nameOf(s))} <b>${last ? fmtV(last.v) + esc(this.unitOf(s)) : '—'}</b></span>`;
      }).join('');
      this._geo = { X, padL, padR, W, H };
    },
  };

  const onMove = (e) => {
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const x = cx - chart.canvas.getBoundingClientRect().left;
    if (Math.abs((chart.hover ?? -1e9) - x) < 1) return;
    chart.hover = x; chart.draw();
  };
  chart.canvas.addEventListener('mousemove', onMove);
  chart.canvas.addEventListener('touchstart', onMove, { passive: true });
  chart.canvas.addEventListener('touchmove', onMove, { passive: true });
  chart.canvas.addEventListener('mouseleave', () => { chart.hover = null; chart.draw(); });
  addEventListener('resize', () => chart.draw());
  $('#c-clear').onclick = () => { chart.sel.clear(); chart.save(); chart.load(); };
  $$('#c-range button').forEach((b) => (b.onclick = () => {
    $$('#c-range button').forEach((x) => x.classList.toggle('active', x === b));
    chart.range = b.dataset.range; chart.save(); chart.load();
  }));
  chart.restore();

  function fillSelectors() {
    chart.buildPicker();
    $('#node-list').innerHTML = [...nodes.keys()].map((n) => `<option value="${esc(n)}">`).join('');
    const sensors = [];
    for (const n of nodes.values()) for (const k of Object.keys(n.latest)) sensors.push(`${n.node}.${k}`);
    $('#sensor-list').innerHTML = sensors.sort().map((s) => `<option value="${esc(s)}">`).join('');
  }

  // ---- (c) rules ----------------------------------------------------------------
  const OPS_TH = { '<': 'น้อยกว่า', '<=': 'ไม่เกิน', '>': 'มากกว่า', '>=': 'ไม่ต่ำกว่า', '==': 'เท่ากับ', '!=': 'ไม่เท่ากับ' };
  function describe(j) {
    const t = j.trigger || {};
    let s = '';
    if (t.type === 'cron') s = `เวลา ${t.expr}${t.tz ? ' (' + t.tz + ')' : ''}`;
    else if (t.type === 'threshold') s = `เมื่อ ${t.sensor} ${OPS_TH[t.op] || t.op} ${t.value}${t.hysteresis ? ` (hyst ${t.hysteresis})` : ''}`;
    else if (t.type === 'node_offline') s = `เมื่อ ${t.node || 'node ใดก็ได้'} ออฟไลน์`;
    else if (t.type === 'event') s = `เมื่อเกิดเหตุการณ์ ${t.event || 'ใดๆ'}${t.node ? ' จาก ' + t.node : ''}`;
    if (j.conditions?.length) s += ` และ ${j.conditions.map((c) => `${c.sensor} ${c.op} ${c.value}`).join(', ')}`;
    const acts = (j.actions || []).map((a) => {
      if (a.switch) return `${a.state === 'ON' ? 'เปิด' : 'ปิด'} ${a.switch}${a.max_minutes ? ` ≤${a.max_minutes} นาที` : ''}${a.until ? ` จนกว่า ${a.until.sensor} ${a.until.op} ${a.until.value}` : ''}`;
      if (a.discord || a.notify) return `แจ้ง "${(a.discord || a.notify).slice(0, 40)}"`;
      return '?';
    });
    return `${s} → ${acts.join('; ')}`;
  }
  async function loadRules() {
    rules = await api('/rules');
    $('#rules').innerHTML = rules.map((r) => `<div class="card rule ${r.enabled ? '' : 'disabled'}" data-id="${r.id}">
      <label class="switch" title="เปิด/ปิดกฎ"><input type="checkbox" data-toggle ${r.enabled ? 'checked' : ''}><span></span></label>
      <div class="body"><div class="name">${esc(r.name)} <span class="muted small">#${r.id}</span></div>
        <div class="desc">${esc(describe(r.json))}</div>
        <div class="muted small">ทำงานล่าสุด: ${r.last_fired ? esc(fmtTs(r.last_fired)) : 'ยังไม่เคย'} · cooldown ${r.json.cooldown_s ?? 300} วิ.</div></div>
      <div class="actions"><button class="ghost small" data-edit>แก้ไข</button><button class="ghost small danger" data-del>ลบ</button></div>
    </div>`).join('');
    $('#rules-empty').classList.toggle('hidden', rules.length > 0);
  }
  $('#rules').addEventListener('click', async (e) => {
    const card = e.target.closest('.rule');
    if (!card) return;
    const id = Number(card.dataset.id), rule = rules.find((r) => r.id === id);
    try {
      if (e.target.matches('[data-toggle]')) {
        await api(`/rules/${id}`, { method: 'PUT', body: { enabled: e.target.checked } });
        toast(e.target.checked ? 'เปิดใช้กฎแล้ว' : 'ปิดกฎแล้ว'); loadRules();
      } else if (e.target.matches('[data-del]')) {
        if (!confirm(`ลบกฎ "${rule.name}"?`)) return;
        await api(`/rules/${id}`, { method: 'DELETE' }); toast('ลบแล้ว'); loadRules();
      } else if (e.target.matches('[data-edit]')) openEditor(rule);
    } catch (err) { toast('ผิดพลาด: ' + err.message, true); }
  });

  // editor
  let editingId = null;
  const ed = $('#r-editor');
  function condRow(c = {}) {
    return `<div class="rowitem cond">
      <label>เซนเซอร์ <input class="c-sensor" list="sensor-list" value="${esc(c.sensor || '')}" placeholder="node.key"></label>
      <label>เงื่อนไข <select class="c-op">${Object.keys(OPS_TH).map((o) => `<option ${o === c.op ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>
      <label>ค่า <input class="c-value" type="number" step="any" value="${c.value ?? ''}"></label>
      <button class="ghost small rm" type="button">ลบ</button></div>`;
  }
  function actRow(a = {}) {
    if (a.switch !== undefined || a.state) {
      const u = a.until || {};
      return `<div class="rowitem act act-switch">
        <label>สวิตช์ <input class="a-switch" list="switch-list" value="${esc(a.switch || '')}" placeholder="node.key"></label>
        <label>สถานะ <select class="a-state"><option ${a.state === 'ON' ? 'selected' : ''}>ON</option><option ${a.state === 'OFF' ? 'selected' : ''}>OFF</option></select></label>
        <label>สูงสุด (นาที) <input class="a-max" type="number" step="any" min="0" value="${a.max_minutes ?? ''}"></label>
        <label>จนกว่า: เซนเซอร์ <input class="a-usensor" list="sensor-list" value="${esc(u.sensor || '')}" placeholder="(ไม่บังคับ)"></label>
        <label>เงื่อนไข <select class="a-uop">${Object.keys(OPS_TH).map((o) => `<option ${o === u.op ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>
        <label>ค่า <input class="a-uvalue" type="number" step="any" value="${u.value ?? ''}"></label>
        <button class="ghost small rm" type="button">ลบ</button></div>`;
    }
    return `<div class="rowitem act act-discord">
      <label style="grid-column:1/-2">ข้อความ Discord <input class="a-text" value="${esc(a.discord || a.notify || '')}" placeholder="รดน้ำเสร็จ {duration} นาที ดิน {ground.soil1_pct}%"></label>
      <button class="ghost small rm" type="button">ลบ</button></div>`;
  }
  function formToJson() {
    const type = $('#t-type').value;
    let trigger = { type };
    if (type === 'threshold') {
      trigger = { type, sensor: $('#t-sensor').value.trim(), op: $('#t-op').value, value: Number($('#t-value').value) };
      if ($('#t-hyst').value !== '') trigger.hysteresis = Number($('#t-hyst').value);
    } else if (type === 'cron') trigger = { type, expr: $('#t-expr').value.trim(), tz: $('#t-tz').value.trim() || 'Asia/Bangkok' };
    else if (type === 'node_offline') { if ($('#t-node').value.trim()) trigger.node = $('#t-node').value.trim(); }
    else if (type === 'event') { if ($('#t-event-type').value.trim()) trigger.event = $('#t-event-type').value.trim(); if ($('#t-event-node').value.trim()) trigger.node = $('#t-event-node').value.trim(); }
    const conditions = $$('#conds .cond').map((r) => ({ sensor: $('.c-sensor', r).value.trim(), op: $('.c-op', r).value, value: Number($('.c-value', r).value) })).filter((c) => c.sensor);
    const actions = $$('#acts .act').map((r) => {
      if (r.classList.contains('act-switch')) {
        const a = { switch: $('.a-switch', r).value.trim(), state: $('.a-state', r).value };
        if ($('.a-max', r).value !== '') a.max_minutes = Number($('.a-max', r).value);
        if ($('.a-usensor', r).value.trim()) a.until = { sensor: $('.a-usensor', r).value.trim(), op: $('.a-uop', r).value, value: Number($('.a-uvalue', r).value) };
        return a;
      }
      return { discord: $('.a-text', r).value };
    });
    const j = { name: $('#r-name').value.trim(), cooldown_s: Number($('#r-cooldown').value) || 300, trigger, actions };
    if (conditions.length) j.conditions = conditions;
    return j;
  }
  function jsonToForm(j) {
    $('#r-name').value = j.name || '';
    $('#r-cooldown').value = j.cooldown_s ?? 300;
    const t = j.trigger || { type: 'threshold' };
    $('#t-type').value = t.type || 'threshold';
    $('#t-sensor').value = t.sensor || ''; $('#t-op').value = t.op || '<'; $('#t-value').value = t.value ?? ''; $('#t-hyst').value = t.hysteresis ?? '';
    $('#t-expr').value = t.expr || ''; $('#t-tz').value = t.tz || 'Asia/Bangkok';
    $('#t-node').value = t.type === 'node_offline' ? t.node || '' : '';
    $('#t-event-type').value = t.event || ''; $('#t-event-node').value = t.type === 'event' ? t.node || '' : '';
    showTriggerFields();
    $('#conds').innerHTML = (j.conditions || []).map(condRow).join('');
    $('#acts').innerHTML = (j.actions || []).map(actRow).join('');
  }
  function showTriggerFields() {
    const t = $('#t-type').value;
    $$('.tfields').forEach((d) => d.classList.toggle('hidden', d.id !== 't-' + t));
  }
  function syncJson() { $('#r-json').value = JSON.stringify(formToJson(), null, 2); $('#r-err').textContent = ''; }
  function openEditor(rule) {
    editingId = rule ? rule.id : null;
    $('#r-title').textContent = rule ? `แก้ไขกฎ #${rule.id}` : 'เพิ่มกฎ';
    $('#r-enabled').checked = rule ? rule.enabled : true;
    jsonToForm(rule ? rule.json : { trigger: { type: 'threshold', op: '<' }, actions: [{ switch: '', state: 'ON', max_minutes: 5 }] });
    // switch datalist
    let dl = $('#switch-list');
    if (!dl) { dl = document.createElement('datalist'); dl.id = 'switch-list'; document.body.appendChild(dl); }
    const sws = [];
    for (const n of nodes.values()) for (const k of new Set([...(n.meta?.switches || []).map((s) => s.key), ...Object.keys(n.switches || {})])) sws.push(`${n.node}.${k}`);
    dl.innerHTML = sws.map((s) => `<option value="${esc(s)}">`).join('');
    syncJson();
    ed.classList.remove('hidden');
    ed.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  $('#r-new').onclick = () => openEditor(null);
  $('#r-cancel').onclick = () => ed.classList.add('hidden');
  $('#t-type').onchange = () => { showTriggerFields(); syncJson(); };
  $('#cond-add').onclick = () => { $('#conds').insertAdjacentHTML('beforeend', condRow({ op: '<' })); syncJson(); };
  $('#act-add-switch').onclick = () => { $('#acts').insertAdjacentHTML('beforeend', actRow({ switch: '', state: 'ON' })); syncJson(); };
  $('#act-add-discord').onclick = () => { $('#acts').insertAdjacentHTML('beforeend', actRow({ discord: '' })); syncJson(); };
  ed.addEventListener('click', (e) => { if (e.target.matches('.rm')) { e.target.closest('.rowitem').remove(); syncJson(); } });
  ed.addEventListener('input', (e) => { if (e.target.id !== 'r-json' && e.target.id !== 'r-enabled') syncJson(); });
  $('#r-json-apply').onclick = () => {
    try { jsonToForm(JSON.parse($('#r-json').value)); syncJson(); toast('โหลด JSON เข้าฟอร์มแล้ว'); } catch (e) { $('#r-err').textContent = 'JSON ไม่ถูกต้อง: ' + e.message; }
  };
  $('#r-save').onclick = async () => {
    let json;
    try { json = JSON.parse($('#r-json').value); } catch (e) { $('#r-err').textContent = 'JSON ไม่ถูกต้อง: ' + e.message; return; }
    const name = json.name || $('#r-name').value.trim();
    if (!name) { $('#r-err').textContent = 'ต้องตั้งชื่อกฎ'; return; }
    const body = { name, enabled: $('#r-enabled').checked, json };
    try {
      if (editingId) await api(`/rules/${editingId}`, { method: 'PUT', body });
      else await api('/rules', { method: 'POST', body });
      toast('บันทึกกฎแล้ว'); ed.classList.add('hidden'); loadRules();
    } catch (err) { $('#r-err').textContent = err.message; }
  };

  // ---- (d) events ---------------------------------------------------------------
  const BAD = new Set(['node_offline', 'max_on_reached', 'failsafe_off', 'sensor_error', 'interlock_blocked']);
  const GOOD = new Set(['node_online', 'rule_fired', 'boot']);
  const evRow = (e) => `<tr><td class="ts">${esc(fmtTs(e.ts))}</td><td>${esc(e.node || '—')}</td><td><span class="evtype ${BAD.has(e.type) ? 'bad' : GOOD.has(e.type) ? 'good' : ''}">${esc(e.type)}</span></td><td class="pl" title="${esc(JSON.stringify(e.payload))}">${esc(e.payload ? JSON.stringify(e.payload) : '')}</td></tr>`;
  function renderEvents() { $('#events tbody').innerHTML = events.map(evRow).join('') || '<tr><td colspan="4" class="muted">ยังไม่มีเหตุการณ์</td></tr>'; }
  async function loadEvents() { events = await api('/events?limit=200'); renderEvents(); }
  $('#ev-refresh').onclick = loadEvents;

  // ---- websocket -----------------------------------------------------------------
  let ws, wsTimer;
  function connectWs() {
    clearTimeout(wsTimer);
    try { ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'); } catch { return retry(); }
    ws.onopen = () => { $('#ws').className = 'ws on'; };
    ws.onclose = ws.onerror = () => { $('#ws').className = 'ws off'; retry(); };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      const n = m.node ? nodes.get(m.node) : null;
      switch (m.type) {
        case 'hello': nodes.clear(); for (const x of m.nodes) nodes.set(x.node, x); renderStatus(); fillSelectors(); break;
        case 'reading':
          if (!n) return loadNodes();
          n.latest[m.key] = { value: m.value, ts: m.ts }; n.last_seen = m.ts;
          updateTile(m);
          if ($('#tab-chart').classList.contains('active')) {
            const d = chart.data.get(sid(m.node, m.key));
            if (d) { d.rows.push({ t: new Date(m.ts).getTime(), v: m.value }); chart.draw(); }
          }
          break;
        case 'switch': if (!n) return loadNodes(); n.switches = n.switches || {}; n.switches[m.key] = { state: m.state, ts: m.ts }; renderStatus(); break;
        case 'status': if (!n) return loadNodes(); n.online = m.online; if (m.online) n.last_seen = m.ts; renderStatus(); break;
        case 'debug': if (!n) return loadNodes(); n.debug = { ...m.debug, ts: m.ts }; if (m.debug.ip) n.ip = m.debug.ip; n.last_seen = m.ts; renderStatus(); break;
        case 'node': loadNodes(); break;
        case 'snapshot': onSnapshot(m); break;
        case 'sage': onSageProgress(m); break;
        case 'event': events.unshift({ id: m.id, ts: m.ts, node: m.node, type: m.event, payload: m.payload }); events = events.slice(0, 200); if ($('#tab-events').classList.contains('active')) renderEvents(); break;
        case 'rules': if ($('#tab-rules').classList.contains('active')) loadRules(); break;
      }
    };
  }
  function retry() { clearTimeout(wsTimer); wsTimer = setTimeout(connectWs, 3000); }
  function updateTile(m) {
    const card = $(`.node[data-node="${m.node}"]`);
    if (!card) return renderStatus();
    const tile = $(`.tile[data-key="${m.key}"]`, card);
    if (!tile) return renderStatus();
    const n = nodes.get(m.node);
    tile.outerHTML = tileHtml(n, m.key, { value: m.value, ts: m.ts });
    if (!n.online) renderStatus();
  }


  // ---- (g) ตั้งค่า Discord ------------------------------------------------------
  // server ไม่ส่ง webhook URL กลับมา (เป็นความลับ) ช่องนี้จึงว่างเสมอ
  // เว้นว่างไว้ = ใช้ของเดิมต่อ พิมพ์ใหม่ = เปลี่ยน
  async function loadDiscord() {
    try {
      const d = await api('/settings/discord');
      $('#ds-enabled').checked = !!d.enabled;
      $('#ds-node').checked = !!d.node_status;
      $('#ds-sensor').checked = !!d.sensor_error;
      $('#ds-rules').checked = !!d.rules;
      $('#ds-summary').checked = !!d.daily_summary;
      $('#ds-debounce').value = d.node_debounce_s ?? 180;
      $('#ds-summary-time').value = d.summary_time || '07:00';
      $('#ds-quiet-start').value = d.quiet_start || '';
      $('#ds-quiet-end').value = d.quiet_end || '';
      $('#ds-url').value = '';
      $('#ds-url-note').textContent = d.webhook_set
        ? `ตั้งไว้แล้ว${d.webhook_id ? ` (webhook id ${d.webhook_id})` : ''}${d.from_env ? ' · มาจาก infra/.env' : ''} — เว้นช่องนี้ว่างไว้ถ้าไม่ต้องการเปลี่ยน`
        : 'ยังไม่ได้ตั้ง webhook — วางลิงก์จาก Discord ลงช่องด้านบน';
      $('#ds-state').textContent = !d.webhook_set ? 'ยังไม่ได้ตั้ง webhook' : d.enabled ? '🟢 เปิดใช้งานอยู่' : '⚪️ ปิดอยู่';
    } catch (e) { toast('โหลดตั้งค่าไม่ได้: ' + e.message, true); }
  }

  const dsBody = () => {
    const body = {
      enabled: $('#ds-enabled').checked,
      node_status: $('#ds-node').checked,
      sensor_error: $('#ds-sensor').checked,
      rules: $('#ds-rules').checked,
      daily_summary: $('#ds-summary').checked,
      node_debounce_s: Number($('#ds-debounce').value || 0),
      summary_time: $('#ds-summary-time').value || '07:00',
      quiet_start: $('#ds-quiet-start').value || null,
      quiet_end: $('#ds-quiet-end').value || null,
    };
    const url = $('#ds-url').value.trim();
    if (url) body.webhook_url = url;
    return body;
  };

  $('#ds-save').onclick = async () => {
    try { await api('/settings/discord', { method: 'PUT', body: dsBody() }); toast('บันทึกแล้ว'); loadDiscord(); }
    catch (e) { toast('ผิดพลาด: ' + e.message, true); }
  };
  $('#ds-test').onclick = async () => {
    try {
      const url = $('#ds-url').value.trim();
      if (url) await api('/settings/discord', { method: 'PUT', body: dsBody() });   // บันทึกก่อน แล้วค่อยยิงทดสอบ
      await api('/settings/discord/test', { method: 'POST', body: {} });
      toast('ส่งแล้ว — ไปดูในห้อง Discord'); loadDiscord();
    } catch (e) { toast('ส่งไม่สำเร็จ: ' + e.message, true); }
  };
  $('#ds-clear').onclick = async () => {
    if (!confirm('ลบ webhook ที่บันทึกไว้?')) return;
    try { await api('/settings/discord', { method: 'PUT', body: { clear_webhook: true } }); toast('ลบแล้ว'); loadDiscord(); }
    catch (e) { toast('ผิดพลาด: ' + e.message, true); }
  };

  // ---- boot ---------------------------------------------------------------------------
  (async () => {
    try { await loadNodes(); } catch (e) { $('#banner').textContent = 'เชื่อมต่อ server ไม่ได้: ' + e.message; $('#banner').className = 'banner warn'; }
    connectWs();
    const tab = location.hash.replace('#', '');
    showTab(['status', 'chart', 'rules', 'events', 'cam', 'sage', 'settings'].includes(tab) ? tab : 'status');
    if (tab === 'cam') renderCam();
    if (tab === 'sage') { renderSage(); const q = new URLSearchParams(location.search).get('analysis'); if (q) openReport(Number(q)); }
  })();
})();

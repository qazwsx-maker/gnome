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
        ${c.cam?.stream ? `<a class="btn" href="${esc(c.cam.stream)}" target="_blank" rel="noopener">▶ ดูสด</a>` : ''}
        <select class="small cam-day" title="เลือกวัน"><option value="">— time-lapse: เลือกวัน —</option></select>
        <button class="small" data-play="1" disabled>▶ เล่น</button>
        <span class="muted small cam-prog"></span>
        ${c.ip ? `<a class="btn" href="http://${esc(c.ip)}/" target="_blank" rel="noopener">⚙ ตั้งค่า</a>` : ''}
      </div>
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
    const img = $('.cam-img', card); img.src = m.url; img.style.display = '';
    $('.cam-ts', card).textContent = fmtTs(m.ts);
    const c = camState.list.find((x) => x.node === m.node); if (c) { c.latest = { ts: m.ts, url: m.url }; c.count++; }
    const today = camState.day[m.node]; if (today && m.ts.startsWith(today) === false) return; if (today) loadFrames(m.node, today);
  }
  $('#cam-list').addEventListener('change', (e) => { const sel = e.target.closest('.cam-day'); if (!sel) return; const node = sel.closest('.cam-card').dataset.node; if (sel.value) loadFrames(node, sel.value); });
  $('#cam-list').addEventListener('click', async (e) => {
    const card = e.target.closest('.cam-card'); if (!card) return; const node = card.dataset.node;
    const img = e.target.closest('.film img'); if (img) { const f = camState.frames[node]?.[Number(img.dataset.i)]; if (f) { $('.cam-img', card).src = f.url; $('.cam-ts', card).textContent = fmtTs(f.ts); } return; }
    const btn = e.target.closest('button'); if (!btn) return;
    try {
      if (btn.dataset.snap) { await api(`/nodes/${node}/cmd`, { method: 'POST', body: { cmd: 'snap' } }); toast(`สั่งถ่าย → ${node}`); }
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
  const STAGE_TH = { empty_soil: 'ดินเปล่า', germinating: 'กำลังงอก', seedling: 'ต้นกล้า', vegetative: 'เติบโตทางใบ', budding: 'ติดตุ่มดอก', flowering: 'ออกดอก', fruiting: 'ติดผล', declining: 'โทรม', unknown: 'ไม่แน่ใจ' };
  const HEALTH_TH = { good: 'แข็งแรง', mild_stress: 'เครียดเล็กน้อย', wilting: 'เหี่ยว', pest_or_disease: 'โรค/แมลง', unknown: '?' };
  const MS_ICON = { planted: '🌱', germinated: '🌿', first_true_leaves: '🍃', leaf_count: '🍃', first_bud: '🌸', first_flower: '🌼', peak_bloom: '💐', stress: '⚠️', recovery: '💚', other: '📌' };
  async function renderSage() {
    try {
      const cfg = await api('/sage/config');
      $('#sage-cfg').textContent = cfg.ready ? `โมเดล: ${cfg.model} (${cfg.provider}) · สูงสุด ${cfg.maxFrames} ภาพ/ครั้ง` : 'ยังไม่ได้ตั้งค่า AI — ใส่ ANTHROPIC_API_KEY ใน infra/.env แล้วรีสตาร์ท Hut';
      const camSel = $('#pl-cam'), senSel = $('#pl-sensor');
      const list = [...nodes.values()];
      camSel.innerHTML = list.filter((n) => n.role === 'cam').map((n) => `<option value="${esc(n.node)}">${esc(n.node)}</option>`).join('') || '<option value="">(ไม่มี Watcher)</option>';
      senSel.innerHTML = '<option value="">— ไม่มี —</option>' + list.filter((n) => n.role === 'scout').map((n) => `<option value="${esc(n.node)}">${esc(n.node)}</option>`).join('');
      sage.plots = await api('/plots');
      $('#plots').innerHTML = sage.plots.map((p) => { const la = p.last_analysis; const st = la?.status; const pr = la?.progress || {};
        return `<div class="card plot" data-id="${p.id}"><div class="row-between"><div><b>${esc(p.name)}</b> <span class="muted small">กล้อง ${esc(p.cam_node)}${p.sensor_node ? ' · เซ็นเซอร์ ' + esc(p.sensor_node) : ''} · ${p.snapshots} ภาพ${p.from_ts ? ' · ตั้งแต่ ' + p.from_ts.slice(0, 10) : ''}${p.to_ts ? ' ถึง ' + p.to_ts.slice(0, 10) : ''}</span></div>
          <div class="row"><span class="muted small sage-st">${st === 'running' ? `⏳ กำลังวิเคราะห์ ${pr.step === 'observe' ? `ภาพ ${pr.done}/${pr.total}` : pr.step === 'synthesize' ? 'สรุปรายงาน…' : ''}` : st === 'done' ? `✅ วิเคราะห์ล่าสุด ${esc(ago(la.created_at))}` : st === 'failed' ? '❌ ล้มเหลว' : st === 'queued' ? '⏳ รอคิว' : 'ยังไม่เคยวิเคราะห์'}</span>
          <button class="primary small" data-analyze="1" ${st === 'running' || st === 'queued' ? 'disabled' : ''}>🔍 วิเคราะห์</button>${st === 'done' ? `<button class="small" data-report="${la.id}">📄 ดูรายงาน</button>` : ''}<button class="ghost small danger" data-del="1">ลบ</button></div></div></div>`; }).join('') || '<p class="muted">ยังไม่มีแปลง — สร้างด้านบน (ต้องมีภาพจาก Watcher ก่อน)</p>';
    } catch (e) { toast('Sage: ' + e.message, true); }
  }
  $('#pl-create').addEventListener('click', async () => {
    try { await api('/plots', { method: 'POST', body: { name: $('#pl-name').value, cam_node: $('#pl-cam').value, sensor_node: $('#pl-sensor').value || undefined, from: $('#pl-from').value || undefined, to: $('#pl-to').value ? $('#pl-to').value + 'T23:59:59' : undefined, notes: $('#pl-notes').value || undefined } }); $('#pl-name').value = ''; toast('สร้างแปลงแล้ว'); renderSage(); } catch (e) { toast('ผิดพลาด: ' + e.message, true); }
  });
  $('#plots').addEventListener('click', async (e) => {
    const btn = e.target.closest('button'); if (!btn) return; const id = btn.closest('.plot').dataset.id;
    try {
      if (btn.dataset.analyze) { const r = await api(`/plots/${id}/analyze`, { method: 'POST', body: {} }); toast(`เริ่มวิเคราะห์ (#${r.analysis_id})`); renderSage(); }
      else if (btn.dataset.report) { openReport(Number(btn.dataset.report)); }
      else if (btn.dataset.del) { if (!confirm('ลบแปลงนี้และรายงานทั้งหมด?')) return; await api(`/plots/${id}`, { method: 'DELETE' }); renderSage(); }
    } catch (err) { toast('ผิดพลาด: ' + err.message, true); }
  });
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
      ${E.length ? `<h4>สิ่งแวดล้อม (เฉลี่ยรายวัน)</h4>${miniChart([{ name: 'อุณหภูมิ °C', color: 'var(--s2)', pts: E.map((e) => [e.date, e.temp_c?.avg ?? null]) }, { name: 'ความชื้น %', color: 'var(--s1)', pts: E.map((e) => [e.date, e.rh_pct?.avg ?? null]) }, { name: 'ดิน %', color: 'var(--leaf)', pts: E.map((e) => [e.date, e.soil1_pct?.avg ?? null]) }], d0, span)}${miniChart([{ name: 'แสงสูงสุด lx', color: '#eda100', pts: E.map((e) => [e.date, e.lux?.max ?? null]) }], d0, span)}` : '<p class="muted small">ไม่มีข้อมูลเซ็นเซอร์ในช่วงนี้ — ผูก node เซ็นเซอร์กับแปลงเพื่อให้ Sage เชื่อมโยงสภาพแวดล้อมได้</p>'}
      <div class="grid2"><div><h4>Milestones</h4><ul>${r.milestones.map((m) => `<li><b>${esc(m.date)}</b> ${MS_ICON[m.type] || ''} ${esc(m.label)} <span class="muted small">— ${esc(m.evidence)}</span></li>`).join('') || '<li class="muted">ไม่พบ</li>'}</ul></div>
      <div><h4>สิ่งแวดล้อมมีผลอย่างไร</h4><ul>${r.env_insights.map((s) => `<li>${esc(s)}</li>`).join('')}</ul><h4>คำแนะนำ</h4><ul>${r.recommendations.map((s) => `<li>${esc(s)}</li>`).join('')}</ul><p class="muted small">ข้อจำกัดข้อมูล: ${esc(r.data_quality)}</p></div></div>
    </div>`;
    const show = (i) => { const f = F[i]; if (!f) return; sage.frameIdx = i; $('#tl-img').src = f.url; $('#tl-cap').textContent = `${f.date} ${f.time} · ภาพ ${i + 1}/${F.length}`;
      const e = E.find((x) => x.date === f.date);
      $('#tl-obs').innerHTML = `<div class="tiles"><div class="tile"><div class="k">ระยะ</div><div class="v">${STAGE_TH[f.stage] || f.stage}</div></div><div class="tile"><div class="k">ใบ</div><div class="v">${f.leaf_count ?? '—'}</div></div><div class="tile"><div class="k">สูง</div><div class="v">${f.height_cm_est ?? '—'}<small>cm</small></div></div><div class="tile"><div class="k">ดอก/ตุ่ม</div><div class="v">${f.flower_count}/${f.bud_count}</div></div><div class="tile"><div class="k">สุขภาพ</div><div class="v" style="font-size:15px">${HEALTH_TH[f.health] || f.health}</div></div><div class="tile"><div class="k">ความมั่นใจ</div><div class="v">${Math.round(f.confidence * 100)}<small>%</small></div></div></div>
        <p><b>เปลี่ยนจากภาพก่อน:</b> ${esc(f.change_from_previous)}</p><p>${esc(f.notes)}</p>
        ${e ? `<p class="muted small">วันนี้: ${e.temp_c ? `อุณหภูมิ ${e.temp_c.min}–${e.temp_c.max}°C` : ''} ${e.rh_pct ? `· ความชื้น ${e.rh_pct.min}–${e.rh_pct.max}%` : ''} ${e.lux ? `· แสงสูงสุด ${e.lux.max} lx` : ''} ${e.soil1_pct ? `· ดิน ${e.soil1_pct.avg}%` : ''}</p>` : ''}`;
      $$('.tl-dot').forEach((d) => d.classList.toggle('on', Number(d.dataset.i) === i)); $('#tl-range').value = i; };
    show(sage.frameIdx);
    $('#tl-range').addEventListener('input', (ev) => show(Number(ev.target.value)));
    box.addEventListener('click', (ev) => { const dot = ev.target.closest('.tl-dot'); if (dot) return show(Number(dot.dataset.i));
      const m = ev.target.closest('.tl-ms'); if (m) { const i = F.findIndex((f) => f.date >= m.dataset.date); if (i >= 0) show(i); return; }
      if (ev.target.id === 'rep-close') box.classList.add('hidden'); });
    box.scrollIntoView({ behavior: 'smooth', block: 'start' });
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

  // ---- (b) chart ---------------------------------------------------------------
  const chart = {
    node: null, key: null, range: '24h', rows: [], res: 'raw',
    canvas: $('#chart'), tip: $('#c-tip'), hover: null,
    async load() {
      const node = $('#c-node').value, key = $('#c-key').value;
      if (!node || !key) { this.rows = []; this.draw(); return; }
      this.node = node; this.key = key;
      const ms = { '24h': 86400e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3 }[this.range];
      const since = new Date(Date.now() - ms).toISOString();
      try {
        const r = await api(`/readings?node=${encodeURIComponent(node)}&key=${encodeURIComponent(key)}&since=${since}`);
        this.rows = r.rows.map((x) => ({ t: new Date(x.ts).getTime(), v: x.value, min: x.min, max: x.max }));
        this.res = r.res;
        $('#c-info').textContent = `${this.rows.length} จุด · ${r.res === '5m' ? 'เฉลี่ย 5 นาที' : 'ค่าดิบ'}`;
      } catch (e) { this.rows = []; $('#c-info').textContent = e.message; }
      $('#c-empty').classList.toggle('hidden', this.rows.length > 0);
      this.draw();
    },
    draw() {
      const c = this.canvas, dpr = devicePixelRatio || 1;
      const W = c.clientWidth || 600, H = 320;
      if (c.width !== W * dpr || c.height !== H * dpr) { c.width = W * dpr; c.height = H * dpr; }
      const ctx = c.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const cs = getComputedStyle(root);
      const col = (v) => cs.getPropertyValue(v).trim();
      const pad = { l: 48, r: 12, t: 12, b: 28 };
      const rows = this.rows;
      if (!rows.length) return;
      const t0 = rows[0].t, t1 = rows[rows.length - 1].t || t0 + 1;
      let lo = Math.min(...rows.map((r) => r.min ?? r.v)), hi = Math.max(...rows.map((r) => r.max ?? r.v));
      if (hi === lo) { hi += 1; lo -= 1; }
      const padY = (hi - lo) * 0.08; lo -= padY; hi += padY;
      const X = (t) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - pad.l - pad.r);
      const Y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b);
      // grid + y axis
      ctx.font = '11px system-ui'; ctx.fillStyle = col('--muted'); ctx.strokeStyle = col('--grid'); ctx.lineWidth = 1;
      for (let i = 0; i <= 4; i++) {
        const v = lo + ((hi - lo) * i) / 4, y = Y(v);
        ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(W - pad.r, y); ctx.stroke();
        ctx.textAlign = 'right'; ctx.fillText(fmtV(v), pad.l - 6, y + 4);
      }
      // x axis labels
      const span = t1 - t0, nx = Math.max(2, Math.min(6, Math.floor(W / 140)));
      ctx.textAlign = 'center';
      for (let i = 0; i <= nx; i++) {
        const t = t0 + (span * i) / nx, d = new Date(t);
        const s = span > 2 * 86400e3 ? d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' }) : d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
        ctx.fillText(s, X(t), H - 8);
      }
      ctx.strokeStyle = col('--axis'); ctx.beginPath(); ctx.moveTo(pad.l, pad.t); ctx.lineTo(pad.l, H - pad.b); ctx.lineTo(W - pad.r, H - pad.b); ctx.stroke();
      // min/max band for 5m
      if (this.res === '5m') {
        ctx.fillStyle = col('--seq250') + '55';
        ctx.beginPath();
        rows.forEach((r, i) => (i ? ctx.lineTo(X(r.t), Y(r.max)) : ctx.moveTo(X(r.t), Y(r.max))));
        for (let i = rows.length - 1; i >= 0; i--) ctx.lineTo(X(rows[i].t), Y(rows[i].min));
        ctx.closePath(); ctx.fill();
      }
      // line
      ctx.strokeStyle = col('--s1'); ctx.lineWidth = 1.8; ctx.lineJoin = 'round'; ctx.beginPath();
      rows.forEach((r, i) => (i ? ctx.lineTo(X(r.t), Y(r.v)) : ctx.moveTo(X(r.t), Y(r.v))));
      ctx.stroke();
      if (rows.length === 1) { ctx.fillStyle = col('--s1'); ctx.beginPath(); ctx.arc(X(rows[0].t), Y(rows[0].v), 3, 0, 7); ctx.fill(); }
      // crosshair
      if (this.hover != null) {
        const r = rows[this.hover], x = X(r.t), y = Y(r.v);
        ctx.strokeStyle = col('--ink2'); ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, H - pad.b); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = col('--s1'); ctx.beginPath(); ctx.arc(x, y, 4, 0, 7); ctx.fill();
        const tip = this.tip;
        tip.innerHTML = `<b>${fmtV(r.v)}${esc(unit(this.key, nodes.get(this.node)))}</b>${r.min !== undefined ? ` <span class="muted">(${fmtV(r.min)}–${fmtV(r.max)})</span>` : ''}<br>${esc(fmtTs(new Date(r.t).toISOString()))}`;
        tip.classList.remove('hidden');
        const tw = tip.offsetWidth;
        tip.style.left = Math.min(W - tw - 4, Math.max(0, x + 10)) + 'px';
        tip.style.top = Math.max(0, y - 44) + 'px';
      } else this.tip.classList.add('hidden');
      this._X = X; this._pad = pad; this._W = W;
    },
    pointAt(clientX) {
      if (!this.rows.length || !this._X) return null;
      const rect = this.canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      let best = 0, bd = Infinity;
      this.rows.forEach((r, i) => { const d = Math.abs(this._X(r.t) - x); if (d < bd) { bd = d; best = i; } });
      return best;
    },
  };
  const onMove = (e) => { const cx = e.touches ? e.touches[0].clientX : e.clientX; const i = chart.pointAt(cx); if (i !== chart.hover) { chart.hover = i; chart.draw(); } };
  chart.canvas.addEventListener('mousemove', onMove);
  chart.canvas.addEventListener('touchstart', onMove, { passive: true });
  chart.canvas.addEventListener('touchmove', onMove, { passive: true });
  chart.canvas.addEventListener('mouseleave', () => { chart.hover = null; chart.draw(); });
  addEventListener('resize', () => chart.draw());
  $('#c-node').onchange = () => { fillKeys(); chart.load(); };
  $('#c-key').onchange = () => chart.load();
  $$('#c-range button').forEach((b) => (b.onclick = () => { $$('#c-range button').forEach((x) => x.classList.toggle('active', x === b)); chart.range = b.dataset.range; chart.load(); }));

  function fillKeys() {
    const n = nodes.get($('#c-node').value);
    const sel = $('#c-key'), cur = sel.value;
    const keys = n ? Object.keys(n.latest).sort() : [];
    sel.innerHTML = keys.map((k) => `<option value="${esc(k)}">${esc(label(k))} (${esc(k)})</option>`).join('');
    if (keys.includes(cur)) sel.value = cur;
  }
  function fillSelectors() {
    const sel = $('#c-node'), cur = sel.value;
    const list = [...nodes.values()].filter((n) => Object.keys(n.latest).length).map((n) => n.node).sort();
    sel.innerHTML = list.map((n) => `<option>${esc(n)}</option>`).join('');
    if (list.includes(cur)) sel.value = cur;
    fillKeys();
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
          updateTile(m); if (chart.node === m.node && chart.key === m.key && $('#tab-chart').classList.contains('active')) { chart.rows.push({ t: new Date(m.ts).getTime(), v: m.value }); chart.draw(); }
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

  // ---- boot ---------------------------------------------------------------------------
  (async () => {
    try { await loadNodes(); } catch (e) { $('#banner').textContent = 'เชื่อมต่อ server ไม่ได้: ' + e.message; $('#banner').className = 'banner warn'; }
    connectWs();
    const tab = location.hash.replace('#', '');
    showTab(['status', 'chart', 'rules', 'events', 'cam', 'sage'].includes(tab) ? tab : 'status');
    if (tab === 'cam') renderCam();
    if (tab === 'sage') { renderSage(); const q = new URLSearchParams(location.search).get('analysis'); if (q) openReport(Number(q)); }
  })();
})();

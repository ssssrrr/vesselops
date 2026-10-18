/* VesselOps 화면
 *
 *   선단·편차·알람·추세 : 업무 API(/api/v1) 주기 조회
 *   계측값 실시간 갱신   : 육상 수집기 WebSocket(/ws) 푸시
 *   시연 패널           : 시뮬레이터·Edge 제어(/sim)
 */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, digits = 1) => (v === null || v === undefined || Number.isNaN(v) ? '—' : Number(v).toFixed(digits));
const timeOf = (iso) => (iso ? new Date(iso).toLocaleTimeString('ko-KR', { hour12: false }) : '—');

const VESSEL_TYPES = { CONTAINER: '컨테이너선', LNG_CARRIER: 'LNG 운반선', BULK_CARRIER: '벌크선', TANKER: '탱커', PCTC: '자동차운반선' };
const STATUSES = { AT_SEA: '항해 중', IN_PORT: '정박 중', ANCHORED: '묘박 중', DRYDOCK: '입거 중' };
const LEVEL_CHIP = { NORMAL: 'chip-ok', WARN: 'chip-warn', ALARM: 'chip-alarm', CRITICAL: 'chip-critical' };
const LEVEL_TEXT = { NORMAL: '정상', WARN: '주의', ALARM: '경보', CRITICAL: '위험', STOPPED: '정지' };
// 정상은 회색으로 물러나게 두고, 벗어난 실린더만 색을 입힌다 (style.css 의 상태색과 같은 계열)
const LEVEL_COLOR = { NORMAL: '#9aa1ab', WARN: '#e3a008', ALARM: '#d03b3b', CRITICAL: '#9f1239', STOPPED: '#cdd2d9' };
const INK = { text: '#1f2328', muted: '#6b7280', grid: '#e8eaee', axis: '#aab0b9' };
const SEVERITY_CHIP = { HIHI: 'chip-critical', LOLO: 'chip-critical', HI: 'chip-alarm', LO: 'chip-alarm', WARN: 'chip-warn' };
const STATE_TEXT = { ACTIVE: '발생', ACKED: '확인됨', CLEARED: '해제' };
const EQUIPMENT_NAMES = { ME: '주기관', DG1: '1번 발전기관', DG2: '2번 발전기관', TC1: '과급기', SHAFT: '추진축계' };
// 이웃한 색끼리 색각 이상에서도 구분되도록 순서를 고정한 8색 (흰 바탕 기준)
const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];

const KPI_TAGS = ['ME_LOAD', 'ME_RPM', 'SHAFT_POWER', 'ME_FO_FLOW', 'ME_LO_P', 'ME_SCAV_P', 'ME_THRUST_BRG_T', 'ME_JCW_OUT_T'];
const KPI_DIGITS = { ME_LOAD: 1, ME_RPM: 1, SHAFT_POWER: 0, ME_FO_FLOW: 0, ME_LO_P: 2, ME_SCAV_P: 2, ME_THRUST_BRG_T: 1, ME_JCW_OUT_T: 1 };

const state = {
  imo: null,
  vessels: [],
  tags: new Map(),        // code → { name, unit, normalMin, normalMax, equipment, value, quality }
  trendGroup: 'exh',
  trendMinutes: 15,
  alarmState: 'OPEN',
  link: new Map(),        // imo → Edge 상태
  mq: { rows: [], nextId: 1, paused: false, pinned: null, dirty: false, stats: null, prev: null, rate: null },
  ws: null,
  chart: null,
};

async function api(path, options) {
  const res = await fetch(path, options);
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `요청 실패 (${res.status})`);
  return body;
}

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

const current = () => state.vessels.find((v) => v.imo === state.imo);

// ----------------------------------------------------------------------
// 선단
// ----------------------------------------------------------------------
async function loadFleet() {
  state.vessels = await api('/api/v1/vessels');
  if (!state.imo && state.vessels.length) selectVessel(state.vessels[0].imo);
  renderFleet();
  renderVesselHead();
}

function renderFleet() {
  $('#fleet').innerHTML = state.vessels.map((v) => `
    <button class="vessel-card ${v.imo === state.imo ? 'selected' : ''}" data-imo="${esc(v.imo)}">
      <div class="row">
        <span class="name">${esc(v.name)}</span>
        <span class="chip ${LEVEL_CHIP[v.alarmLevel] || 'chip-muted'}">${v.openAlarmCount ? `알람 ${v.openAlarmCount}` : '정상'}</span>
      </div>
      <div class="row meta">
        <span>${esc(VESSEL_TYPES[v.vesselType] || v.vesselType)} · ${esc(STATUSES[v.status] || v.status)}</span>
        <span><span class="dot ${v.online ? 'dot-on' : 'dot-off'}"></span> ${v.online ? '통신 정상' : '통신 단절'}</span>
      </div>
      <div class="nums">
        <div class="num"><b>${fmt(v.loadPct, 0)}</b><span>부하 %</span></div>
        <div class="num"><b>${fmt(v.rpm, 1)}</b><span>회전수 rpm</span></div>
        <div class="num"><b>${fmt(v.maxCylinderDeviation, 0)}</b><span>최대 편차 ℃</span></div>
      </div>
    </button>`).join('');
}

function renderVesselHead() {
  const v = current();
  if (!v) return;
  $('#vessel-head').innerHTML = `
    <h1>${esc(v.name)}</h1>
    <span class="meta">IMO ${esc(v.imo)} · 주기관 ${esc(v.engineModel || '—')} (${v.cylinderCount ?? '—'}기통) · ${esc(v.classSociety || '')}</span>
    <span class="chip ${v.online ? 'chip-ok' : 'chip-critical'}">${v.online ? '통신 정상' : '통신 단절'}</span>
    <span class="chip chip-muted">마지막 수신 ${timeOf(v.lastSeenAt)}</span>`;
}

function selectVessel(imo) {
  if (state.imo === imo) return;
  const prev = state.imo;
  state.imo = imo;
  state.tags.clear();
  if (state.ws?.readyState === 1) {
    if (prev) state.ws.send(JSON.stringify({ action: 'unsubscribe', imo: prev }));
    state.ws.send(JSON.stringify({ action: 'subscribe', imo }));
  }
  renderFleet();
  renderVesselHead();
  renderCylinderOptions();
  loadDetail().then(() => {
    loadTrend();
  });
  loadDeviation();
  loadAlarms();
  loadSim();
}

// ----------------------------------------------------------------------
// 선박 상세: 계측점 정의 + 최신값
// ----------------------------------------------------------------------
async function loadDetail() {
  if (!state.imo) return;
  const imo = state.imo;
  const detail = await api(`/api/v1/vessels/${imo}`);
  if (imo !== state.imo) return;
  for (const eq of detail.equipment) {
    for (const t of eq.tags) {
      const cur = state.tags.get(t.code);
      state.tags.set(t.code, { ...t, equipment: eq.code, value: cur?.liveAt ? cur.value : t.value, liveAt: cur?.liveAt });
    }
  }
  renderKpis();
  renderTags();
}

function outOfRange(t) {
  const rpm = state.tags.get('ME_RPM')?.value;
  // 주기관이 정지해 있으면 정상범위 이탈로 표시하지 않는다
  if (t.equipment !== 'DG1' && t.equipment !== 'DG2' && !(rpm >= 5)) return false;
  if (t.equipment.startsWith('DG') && !(state.tags.get(`${t.equipment}_RPM`)?.value >= 5)) return false;
  if (t.value === null || t.value === undefined) return false;
  return (t.normalMin !== null && t.value < t.normalMin) || (t.normalMax !== null && t.value > t.normalMax);
}

function renderKpis() {
  $('#kpis').innerHTML = KPI_TAGS.map((code) => {
    const t = state.tags.get(code);
    if (!t) return '';
    return `
      <div class="kpi ${outOfRange(t) ? 'out' : ''}">
        <div class="label">${esc(t.name)}</div>
        <div class="value">${fmt(t.value, KPI_DIGITS[code] ?? 1)}<span class="unit">${esc(t.unit === 'degC' ? '℃' : t.unit)}</span></div>
        <div class="range">정상 ${fmt(t.normalMin, 0)} ~ ${fmt(t.normalMax, 0)}</div>
      </div>`;
  }).join('');
}

function renderTags() {
  const groups = new Map();
  for (const t of state.tags.values()) {
    if (!groups.has(t.equipment)) groups.set(t.equipment, []);
    groups.get(t.equipment).push(t);
  }
  $('#tag-count').textContent = `계측점 ${state.tags.size}개`;
  $('#tags').innerHTML = [...groups].map(([eq, tags]) => `
    <div class="tag-group">
      <h3>${esc(EQUIPMENT_NAMES[eq] || eq)}</h3>
      ${tags.map((t) => `
        <div class="tag-row" title="${esc(t.code)}">
          <span class="n">${esc(t.name)}</span>
          <span class="v ${outOfRange(t) ? 'out' : ''}">${fmt(t.value, 2)}<small>${esc(t.unit === 'degC' ? '℃' : t.unit || '')}</small></span>
        </div>`).join('')}
    </div>`).join('');
}

// ----------------------------------------------------------------------
// 실린더 편차
// ----------------------------------------------------------------------
async function loadDeviation() {
  if (!state.imo) return;
  const imo = state.imo;
  const d = await api(`/api/v1/vessels/${imo}/cylinder-deviation`);
  if (imo !== state.imo) return;
  renderDeviation(d);
}

function renderDeviation(d) {
  const box = $('#deviation');
  const summary = $('#dev-summary');
  if (!d.cylinders.length) {
    summary.textContent = '';
    box.innerHTML = '<div class="empty">표시할 실린더 값이 없습니다.</div>';
    return;
  }
  if (!d.engineRunning) {
    summary.className = 'chip chip-muted';
    summary.textContent = '주기관 정지';
  } else {
    const worst = d.cylinders.reduce((a, c) => (Math.abs(c.deviation) > Math.abs(a.deviation) ? c : a));
    summary.className = `chip ${LEVEL_CHIP[worst.level] || 'chip-muted'}`;
    summary.textContent = `평균 ${fmt(d.mean, 0)}℃ · 최대 편차 ${worst.no}번 ${worst.deviation >= 0 ? '+' : ''}${fmt(worst.deviation, 0)}℃`;
  }

  // 0(평균)을 기준선으로 위아래 막대를 그린다. 경보 기준은 DB 의 룰 값이다.
  const W = 720, H = 300, padL = 44, padR = 64, mid = 140, half = 110;
  const hi = d.limitHi ?? 50, hihi = d.limitHiHi ?? 80;
  const span = Math.max(hihi * 1.25, ...d.cylinders.map((c) => Math.abs(c.deviation) * 1.1));
  const y = (dev) => mid - (dev / span) * half;
  const slot = (W - padL - padR) / d.cylinders.length;
  const barW = Math.min(54, slot * 0.6);

  const limitLine = (dev, color, label) => `
    <line x1="${padL}" x2="${W - padR}" y1="${y(dev)}" y2="${y(dev)}" stroke="${color}" stroke-dasharray="5 4" stroke-width="1"/>
    <text x="${W - padR + 6}" y="${y(dev) + 4}" fill="${color}" font-size="11">${label}</text>`;

  const bars = d.cylinders.map((c, i) => {
    const cx = padL + slot * i + slot / 2;
    const top = Math.min(y(c.deviation), mid);
    const h = Math.max(2, Math.abs(y(c.deviation) - mid));
    const color = LEVEL_COLOR[c.level] || LEVEL_COLOR.NORMAL;
    const labelY = c.deviation >= 0 ? top - 6 : top + h + 14;
    return `
      <rect x="${cx - barW / 2}" y="${top}" width="${barW}" height="${h}" rx="3" fill="${color}">
        <title>${c.no}번 실린더 ${fmt(c.value, 1)}℃ (평균 대비 ${c.deviation >= 0 ? '+' : ''}${fmt(c.deviation, 1)}℃)</title>
      </rect>
      <text x="${cx}" y="${labelY}" fill="${INK.text}" font-size="12" text-anchor="middle" font-weight="${c.level === 'NORMAL' ? 500 : 700}">${c.deviation >= 0 ? '+' : ''}${fmt(c.deviation, 0)}</text>
      <text x="${cx}" y="${H - 30}" fill="${INK.text}" font-size="12" text-anchor="middle">${c.no}번</text>
      <text x="${cx}" y="${H - 12}" fill="${INK.muted}" font-size="12" text-anchor="middle">${fmt(c.value, 0)}℃</text>`;
  }).join('');

  box.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="실린더별 배기온도 편차">
      ${limitLine(hihi, LEVEL_COLOR.CRITICAL, `+${hihi}℃`)}
      ${limitLine(hi, LEVEL_COLOR.ALARM, `+${hi}℃`)}
      ${limitLine(-hi, LEVEL_COLOR.ALARM, `−${hi}℃`)}
      ${limitLine(-hihi, LEVEL_COLOR.CRITICAL, `−${hihi}℃`)}
      <line x1="${padL}" x2="${W - padR}" y1="${mid}" y2="${mid}" stroke="${INK.axis}" stroke-width="1"/>
      <text x="${padL - 6}" y="${mid + 4}" fill="${INK.muted}" font-size="11" text-anchor="end">평균</text>
      ${bars}
    </svg>`;
}

// ----------------------------------------------------------------------
// 추세
// ----------------------------------------------------------------------
function trendTags() {
  const v = current();
  switch (state.trendGroup) {
    case 'temp': return ['ME_THRUST_BRG_T', 'ME_JCW_OUT_T', 'ME_LO_T', 'ME_SCAV_T'];
    case 'press': return ['ME_LO_P', 'ME_SCAV_P', 'TC_LO_P'];
    case 'load': return ['ME_LOAD', 'ME_RPM'];
    default:
      return Array.from({ length: v?.cylinderCount || 6 }, (_, i) => `ME_EXH_T_CYL${String(i + 1).padStart(2, '0')}`);
  }
}

async function loadTrend() {
  if (!state.imo || !window.Chart) return;
  const imo = state.imo;
  const tags = trendTags();
  const t = await api(`/api/v1/vessels/${imo}/trend?tags=${tags.join(',')}&minutes=${state.trendMinutes}`);
  if (imo !== state.imo) return;

  const datasets = t.series.map((s, i) => ({
    label: s.name,
    data: s.points.map(([x, y]) => ({ x, y })),
    borderColor: SERIES_COLORS[i % SERIES_COLORS.length],
    backgroundColor: SERIES_COLORS[i % SERIES_COLORS.length],
    borderWidth: 2,
    pointRadius: 0,
    tension: 0.2,
    spanGaps: false,
  }));
  const range = { min: new Date(t.from).getTime(), max: new Date(t.to).getTime() };

  if (!state.chart) {
    state.chart = new Chart($('#trend'), {
      type: 'line',
      data: { datasets },
      options: {
        animation: false,
        maintainAspectRatio: false,
        interaction: { mode: 'nearest', axis: 'x', intersect: false },
        scales: {
          x: {
            type: 'linear', ...range,
            ticks: { color: INK.muted, maxTicksLimit: 7, callback: (v) => new Date(v).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit' }) },
            grid: { color: INK.grid },
            border: { color: INK.axis },
          },
          y: { ticks: { color: INK.muted }, grid: { color: INK.grid }, border: { display: false } },
        },
        plugins: {
          legend: { labels: { color: INK.text, boxWidth: 10, boxHeight: 10, font: { size: 11 } } },
          tooltip: { callbacks: { title: (items) => new Date(items[0].parsed.x).toLocaleTimeString('ko-KR', { hour12: false }) } },
        },
      },
    });
  } else {
    state.chart.data.datasets = datasets;
    Object.assign(state.chart.options.scales.x, range);
    state.chart.update('none');
  }
}

// ----------------------------------------------------------------------
// 알람
// ----------------------------------------------------------------------
async function loadAlarms() {
  if (!state.imo) return;
  const imo = state.imo;
  const q = new URLSearchParams({ imo, size: '50' });
  if (state.alarmState) q.set('state', state.alarmState);
  const page = await api(`/api/v1/alarms?${q}`);
  if (imo !== state.imo) return;
  const body = $('#alarms tbody');
  if (!page.content.length) {
    body.innerHTML = `<tr><td colspan="5" class="empty">${state.alarmState ? '미해제 알람이 없습니다.' : '알람 이력이 없습니다.'}</td></tr>`;
    return;
  }
  body.innerHTML = page.content.map((a) => `
    <tr>
      <td class="time">${timeOf(a.raisedAt)}</td>
      <td><span class="chip ${SEVERITY_CHIP[a.severity] || 'chip-muted'}">${esc(a.severity)}</span></td>
      <td>${esc(a.message)}</td>
      <td class="nowrap">${esc(STATE_TEXT[a.state] || a.state)}${a.clearedAt ? ` <span class="time">${timeOf(a.clearedAt)}</span>` : ''}</td>
      <td class="nowrap">${a.state === 'ACTIVE' ? `<button class="btn btn-sm" data-ack="${a.id}">확인</button>` : ''}</td>
    </tr>`).join('');
}

// ----------------------------------------------------------------------
// 시연 패널
// ----------------------------------------------------------------------
function renderCylinderOptions() {
  const v = current();
  $('#fault-cyl').innerHTML = Array.from({ length: v?.cylinderCount || 6 }, (_, i) => `<option value="${i + 1}">${i + 1}번</option>`).join('');
}

async function loadSim() {
  const [sim, link] = await Promise.all([api('/sim/state'), api('/sim/link')]);
  for (const e of link.vessels) state.link.set(e.imo, e);
  const edge = state.link.get(state.imo);
  const v = current();

  const faults = sim.faults.filter((f) => f.imo === state.imo);
  const lines = faults.map((f) => `
    <div class="line"><span class="chip chip-alarm">${esc(f.label)}${f.cylinder ? ` ${f.cylinder}번` : ''}</span>
      <span class="muted">${f.auto ? '자동 발생' : '주입'} 후 ${f.elapsedSec}초 경과</span></div>`);
  if (!faults.length) lines.push('<div class="line muted">주입된 고장이 없습니다.</div>');
  if (edge) {
    lines.push(`
      <div class="line">
        <span class="chip ${edge.linkUp ? 'chip-ok' : 'chip-critical'}">위성 링크 ${edge.linkUp ? '정상' : '단절'}</span>
        <span class="muted">전송 모드 ${edge.mode === 'raw' ? '1초 원본' : '1분 요약'} · 본선 버퍼 ${edge.queuedValues.toLocaleString()}건 · Pre-trigger ${edge.ringSec}초</span>
      </div>`);
    const btn = $('#btn-link');
    btn.textContent = edge.linkUp ? '위성 링크 단절' : '위성 링크 복구';
    btn.className = edge.linkUp ? 'btn' : 'btn btn-danger';
  }
  $('#demo-state').innerHTML = lines.join('');
  $('#btn-inject').disabled = v?.status === 'IN_PORT';
  $('#btn-inject').title = v?.status === 'IN_PORT' ? '정박 중인 선박은 주기관이 정지 상태입니다.' : '';
}

async function injectFault() {
  const type = $('#fault-type').value;
  const body = { imo: state.imo, type };
  if (type === 'CYL_EXH_DEVIATION') body.cylinder = Number($('#fault-cyl').value);
  await api('/sim/fault', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  toast('고장을 주입했습니다. 값이 서서히 변합니다.');
  loadSim();
}

async function clearFaults() {
  await api('/sim/fault', { method: 'DELETE' });
  toast('전 선박을 정상으로 되돌렸습니다.');
  loadSim();
}

async function toggleLink() {
  const edge = state.link.get(state.imo);
  const connected = !(edge?.linkUp ?? true);
  await api('/sim/link', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ imo: state.imo, connected }) });
  toast(connected ? '링크를 복구했습니다. 본선 버퍼가 소급 전송됩니다.' : '링크를 끊었습니다. 값은 본선 버퍼에 쌓입니다.');
  loadSim();
}

// ----------------------------------------------------------------------
// WebSocket
// ----------------------------------------------------------------------
function connectWs() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  state.ws = ws;
  const chip = $('#ws-state');
  ws.onopen = () => {
    chip.className = 'chip chip-ok';
    chip.textContent = '실시간 연결됨';
    if (state.imo) ws.send(JSON.stringify({ action: 'subscribe', imo: state.imo }));
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    // 수신 현황은 선택한 선박과 무관하게 전 선박분을 받는다
    if (msg.type === 'mqtt') return onMqttTrace(msg);
    if (msg.type === 'ingestStats') return onIngestStats(msg);
    if (msg.imo !== state.imo) return;
    if (msg.type === 'telemetry') {
      for (const [code, value] of Object.entries(msg.values)) {
        const t = state.tags.get(code);
        if (t) {
          t.value = value;
          t.liveAt = Date.now();
        }
      }
      scheduleRender();
    } else if (msg.type === 'vesselStatus') {
      loadFleet().catch(() => {});
    }
  };
  ws.onclose = () => {
    chip.className = 'chip chip-critical';
    chip.textContent = '실시간 연결 끊김 — 재연결 중';
    setTimeout(connectWs, 3000);
  };
}

// ----------------------------------------------------------------------
// MQTT 수신 현황 — 육상 수집기가 받은 메시지를 건별로 보여 준다
// ----------------------------------------------------------------------
const MQ_KEEP = 60;
const KIND = {
  status: ['상태', 'chip-muted'], buffered: ['소급', 'chip-warn'],
  raw: ['원본', 'chip-accent'], summary: ['요약', 'chip-ok'],
};

function onMqttTrace(m) {
  const mq = state.mq;
  if (mq.paused) return;
  m.id = mq.nextId++;
  m.fresh = true;
  mq.rows.unshift(m);
  if (mq.rows.length > MQ_KEEP) mq.rows.length = MQ_KEEP;
  mq.dirty = true;
}

function onIngestStats(s) {
  const mq = state.mq;
  if (mq.prev) {
    const dt = (new Date(s.at) - new Date(mq.prev.at)) / 1000;
    if (dt > 0) mq.rate = { messages: (s.messages - mq.prev.messages) / dt, values: (s.received - mq.prev.received) / dt };
  }
  mq.prev = mq.stats = s;
  renderMqStats();
}

function renderMqStats() {
  const { stats: s, rate } = state.mq;
  if (!s) return;
  const t = s.transport || {};
  const chip = $('#mq-transport');
  if (!t.connected) {
    chip.className = 'chip chip-critical';
    chip.textContent = '브로커 접속 끊김';
  } else if (t.tls) {
    chip.className = 'chip chip-ok';
    chip.textContent = `암호화 접속 ${t.tls}${t.identity ? ` · 인증서 ${t.identity}` : ''}`;
    chip.title = `${t.url} · ${t.cipher || ''}`;
  } else {
    chip.className = 'chip chip-warn';
    chip.textContent = '평문 접속';
    chip.title = t.url || '';
  }
  $('#mq-link-label').textContent = t.tls ? `MQTT · ${t.tls}` : 'MQTT · 평문';

  const n = (v) => Number(v).toLocaleString();
  const tile = (label, value, unit = '', bad = false) => `
    <div class="mq-stat ${bad ? 'bad' : ''}"><div class="label">${label}</div>
      <div class="value">${value}<small>${unit}</small></div></div>`;
  $('#mq-stats').innerHTML = [
    tile('초당 메시지', rate ? fmt(rate.messages, 0) : '—', '건/초'),
    tile('초당 계측값', rate ? fmt(rate.values, 0) : '—', '건/초'),
    tile('누적 수신 계측값', n(s.received), '건'),
    tile('DB 적재', n(s.inserted), '건'),
    tile('중복 제거', n(s.duplicated), '건'),
    tile('거부 · 격리', n(s.rejected), '건', s.rejected > 0),
  ].join('');
}

function mqKind(m) {
  if (m.topic.startsWith('vesselops/status/')) return KIND.status;
  if (m.buffered) return KIND.buffered;
  return KIND[m.mode] || ['—', 'chip-muted'];
}

function mqResult(m) {
  if (m.topic.startsWith('vesselops/status/')) return '<span class="chip chip-muted">반영</span>';
  if (m.rejected > 0) return `<span class="chip chip-alarm">거부 ${m.rejected}</span>`;
  return '<span class="chip chip-ok">적재</span>';
}

function renderMqLog() {
  const mq = state.mq;
  if (!mq.dirty) return;
  mq.dirty = false;
  const names = new Map(state.vessels.map((v) => [v.imo, v.name]));
  const hms = (iso) => {
    const d = new Date(iso);
    const p = (n, len = 2) => String(n).padStart(len, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  };
  $('#mq-log tbody').innerHTML = mq.rows.map((m) => {
    const [kind, kindChip] = mqKind(m);
    const delay = m.sentAt ? `${Math.max(0, new Date(m.recvAt) - new Date(m.sentAt))} ms` : '—';
    const row = `
      <tr data-id="${m.id}" class="${m.fresh ? 'fresh' : ''} ${mq.pinned === m.id ? 'pinned' : ''}">
        <td>${hms(m.recvAt)}</td>
        <td>${esc(names.get(m.imo) || m.imo || '—')}</td>
        <td class="topic">${esc(m.topic)}</td>
        <td><span class="chip ${kindChip}">${kind}</span></td>
        <td class="r">${m.count || '—'}</td>
        <td class="r">${m.seq ?? '—'}</td>
        <td class="r">${delay}</td>
        <td class="r">${m.bytes.toLocaleString()} B</td>
        <td>${mqResult(m)}</td>
      </tr>`;
    m.fresh = false;
    return row;
  }).join('');
  if (mq.pinned === null) showMqRaw(mq.rows[0], false);
}

function showMqRaw(m, pinned) {
  if (!m) return;
  const more = m.count > 3 ? `\n… 값 ${m.count - 3}건 생략 (전체 ${m.count}건)` : '';
  $('#mq-raw').textContent = (m.preview ? JSON.stringify(m.preview, null, 2) : '(JSON 이 아닌 본문)') + more;
  $('#mq-raw-meta').textContent = pinned ? `고정됨 · ${m.topic}` : `최신 · ${m.topic}`;
}

// 초당 여러 메시지가 와도 화면은 한 번만 다시 그린다
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderKpis();
    renderTags();
  });
}

// ----------------------------------------------------------------------
// 시작
// ----------------------------------------------------------------------
function every(ms, fn) {
  const run = () => fn().catch((err) => console.warn(err.message));
  setInterval(run, ms);
}

function bindSegment(sel, attr, onChange) {
  $(sel).addEventListener('click', (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    for (const b of $(sel).children) b.classList.toggle('on', b === btn);
    onChange(btn.dataset[attr]);
  });
}

function init() {
  $('#fleet').addEventListener('click', (ev) => {
    const card = ev.target.closest('[data-imo]');
    if (card) selectVessel(card.dataset.imo);
  });
  $('#alarms').addEventListener('click', async (ev) => {
    const id = ev.target.dataset.ack;
    if (!id) return;
    try {
      await api(`/api/v1/alarms/${id}/ack`, { method: 'POST' });
      toast('알람을 확인 처리했습니다.');
    } catch (err) {
      toast(err.message);
    }
    loadAlarms();
  });
  bindSegment('#trend-groups', 'group', (g) => { state.trendGroup = g; loadTrend(); });
  bindSegment('#trend-range', 'min', (m) => { state.trendMinutes = Number(m); loadTrend(); });
  bindSegment('#alarm-filter', 'state', (s) => { state.alarmState = s; loadAlarms(); });

  const guard = (fn) => () => fn().catch((err) => toast(err.message));
  $('#btn-inject').addEventListener('click', guard(injectFault));
  $('#btn-clear').addEventListener('click', guard(clearFaults));
  $('#btn-link').addEventListener('click', guard(toggleLink));
  $('#mq-pause').addEventListener('click', (ev) => {
    const mq = state.mq;
    mq.paused = !mq.paused;
    ev.target.textContent = mq.paused ? '목록 다시 보기' : '목록 멈춤';
    ev.target.setAttribute('aria-pressed', String(mq.paused));
  });
  // 행을 누르면 그 메시지의 원문을 고정한다. 같은 행을 다시 누르면 최신 메시지로 돌아간다
  $('#mq-log').addEventListener('click', (ev) => {
    const tr = ev.target.closest('tr[data-id]');
    if (!tr) return;
    const mq = state.mq;
    const id = Number(tr.dataset.id);
    mq.pinned = mq.pinned === id ? null : id;
    if (mq.pinned !== null) showMqRaw(mq.rows.find((m) => m.id === id), true);
    mq.dirty = true;
    renderMqLog();
  });
  setInterval(renderMqLog, 300);
  $('#fault-type').addEventListener('change', (ev) => {
    $('#cyl-wrap').style.display = ev.target.value === 'CYL_EXH_DEVIATION' ? '' : 'none';
  });

  setInterval(() => { $('#clock').textContent = `${new Date().toISOString().slice(11, 19)} UTC`; }, 1000);

  loadFleet().catch((err) => toast(`선단 조회 실패: ${err.message}`));
  connectWs();
  every(3000, loadFleet);
  every(2000, loadDeviation);
  every(3000, loadAlarms);
  every(3000, loadSim);
  every(5000, loadTrend);
  every(15000, loadDetail);
}

document.addEventListener('DOMContentLoaded', init);

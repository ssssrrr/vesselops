/**
 * 육상 수집기
 *
 *   MQTT 수신 → 검증 → 태그 해석(캐시) → 배치 적재(IF-03)
 *                                      └→ WebSocket 푸시(IF-04)
 *
 * 수집 경로는 업무 API(Spring Boot)와 분리돼 있다. API 를 재배포해도 수집은 끊기지 않고,
 * 수집량이 늘면 이 프로세스만 따로 증설할 수 있다.
 */
import fs from 'node:fs';
import http from 'node:http';
import mqtt from 'mqtt';
import pg from 'pg';
import { WebSocketServer } from 'ws';
import { validateHeader, validateValue } from './validate.js';

const env = process.env;
const PORT = Number(env.INGEST_PORT || 3001);
const BATCH_SIZE = Number(env.INGEST_BATCH_SIZE || 200);
const FLUSH_MS = Number(env.INGEST_FLUSH_MS || 1000);
const HOLD_LIMIT = 10_000;   // DB 장애 시 메모리 보류 상한

const log = (msg) => console.log(`${new Date().toISOString()} [ingest] ${msg}`);

const pool = new pg.Pool({
  host: env.POSTGRES_HOST || 'localhost',
  port: Number(env.POSTGRES_PORT || 5432),
  database: env.POSTGRES_DB || 'vesselops',
  user: env.POSTGRES_USER || 'vesselops',
  password: env.POSTGRES_PASSWORD || 'vesselops_dev',
  max: 5,
});
pool.on('error', (err) => log(`DB 풀 오류: ${err.message}`));

// messages 는 MQTT 메시지 수, 나머지는 계측값 건수
const stats = { messages: 0, received: 0, inserted: 0, duplicated: 0, rejected: 0, held: 0, discarded: 0 };
// 브로커 접속 방식 — 화면의 수신 현황에 표시한다
const transport = { connected: false, url: null, tls: null, cipher: null, identity: null };

// ----------------------------------------------------------------------
// 태그 캐시: (imo, 장비, 태그코드) → tag_id
// 값마다 조회하면 초당 142회 질의가 발생하므로 메모리에 둔다.
// ----------------------------------------------------------------------
let tagCache = new Map();
let vesselIds = new Map();

async function loadMaster() {
  const tags = await pool.query(
    `SELECT t.id, v.imo_no, e.code AS eq, t.code
       FROM tag t
       JOIN equipment e ON e.id = t.equipment_id
       JOIN vessel v ON v.id = e.vessel_id
      WHERE t.enabled`,
  );
  tagCache = new Map(tags.rows.map((r) => [`${r.imo_no}/${r.eq}/${r.code}`, r.id]));
  const vessels = await pool.query('SELECT id, imo_no FROM vessel');
  vesselIds = new Map(vessels.rows.map((r) => [r.imo_no, r.id]));
  log(`마스터 적재 — 선박 ${vesselIds.size}척, 계측점 ${tagCache.size}개`);
}

// ----------------------------------------------------------------------
// 배치 적재
// ----------------------------------------------------------------------
let rawBuf = [];       // [ts, tagId, value, quality]
let summaryBuf = [];   // [bucket, tagId, period, avg, min, max, sd, n, quality]
let flushing = false;

const RAW_SQL = `
  INSERT INTO telemetry (ts, tag_id, value, quality)
  SELECT * FROM unnest($1::timestamptz[], $2::bigint[], $3::float8[], $4::smallint[])
  ON CONFLICT (tag_id, ts) DO NOTHING`;

const SUMMARY_SQL = `
  INSERT INTO telemetry_summary
         (bucket, tag_id, period_sec, avg_value, min_value, max_value, sd_value, sample_count, quality)
  SELECT * FROM unnest($1::timestamptz[], $2::bigint[], $3::int[], $4::float8[], $5::float8[],
                       $6::float8[], $7::float8[], $8::int[], $9::smallint[])
  ON CONFLICT (tag_id, bucket) DO NOTHING`;

const columns = (rows, width) => Array.from({ length: width }, (_, c) => rows.map((r) => r[c]));

async function insertChunked(sql, rows, width) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const chunk = rows.slice(i, i + BATCH_SIZE);
    const res = await pool.query(sql, columns(chunk, width));
    inserted += res.rowCount;
  }
  return inserted;
}

async function flush() {
  if (flushing || (rawBuf.length === 0 && summaryBuf.length === 0)) return;
  flushing = true;
  const raw = rawBuf;
  const summary = summaryBuf;
  rawBuf = [];
  summaryBuf = [];
  try {
    const inserted = (await insertChunked(RAW_SQL, raw, 4)) + (await insertChunked(SUMMARY_SQL, summary, 9));
    stats.inserted += inserted;
    // 재전송분은 유니크 제약에 걸려 조용히 무시된다 (FR-156)
    stats.duplicated += raw.length + summary.length - inserted;
  } catch (err) {
    // 버리지 않고 다음 주기에 다시 시도한다. 상한을 넘으면 오래된 것부터 폐기.
    log(`적재 실패(${err.message}) — ${raw.length + summary.length}건 보류`);
    rawBuf = raw.concat(rawBuf);
    summaryBuf = summary.concat(summaryBuf);
    const over = rawBuf.length - HOLD_LIMIT;
    if (over > 0) {
      rawBuf.splice(0, over);
      stats.discarded += over;
    }
  } finally {
    stats.held = rawBuf.length + summaryBuf.length;
    flushing = false;
  }
}

async function reject(topic, payload, reason) {
  stats.rejected += 1;
  try {
    await pool.query('INSERT INTO telemetry_rejected (topic, payload, reason) VALUES ($1, $2, $3)', [
      topic,
      JSON.stringify(payload),
      reason,
    ]);
  } catch (err) {
    log(`격리 테이블 적재 실패: ${err.message}`);
  }
}

// ----------------------------------------------------------------------
// WebSocket (IF-04)
// ----------------------------------------------------------------------
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'UP', clients: wss.clients.size, tags: tagCache.size, ...stats }));
  }
  res.writeHead(404).end();
});
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
const vesselStatus = new Map();   // imo → { online, mode, at }

wss.on('connection', (socket) => {
  socket.subscriptions = new Set();
  socket.isAlive = true;
  socket.on('pong', () => (socket.isAlive = true));
  socket.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (typeof msg.imo !== 'string') return;
    if (msg.action === 'subscribe') {
      socket.subscriptions.add(msg.imo);
      const st = vesselStatus.get(msg.imo);
      if (st) socket.send(JSON.stringify({ type: 'vesselStatus', imo: msg.imo, ...st }));
    } else if (msg.action === 'unsubscribe') {
      socket.subscriptions.delete(msg.imo);
    }
  });
});

// 죽은 연결 정리
setInterval(() => {
  for (const socket of wss.clients) {
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 30_000);

/** imo 를 구독한 클라이언트에게만 보낸다. '*' 구독은 전 선박. */
function broadcast(imo, message) {
  const text = JSON.stringify(message);
  for (const socket of wss.clients) {
    if (socket.readyState !== 1) continue;
    if (socket.subscriptions.has(imo) || socket.subscriptions.has('*')) socket.send(text);
  }
}

/** 구독과 무관하게 접속한 전원에게 보낸다 (수신 현황). */
function broadcastAll(message) {
  if (wss.clients.size === 0) return;
  const text = JSON.stringify(message);
  for (const socket of wss.clients) {
    if (socket.readyState === 1) socket.send(text);
  }
}

/**
 * 받은 MQTT 메시지 한 건의 요약을 화면에 알린다.
 * 본문은 값 3건까지만 싣는다 — 화면은 "무엇이 오가는지"를 보여주면 되고 전량은 DB 에 있다.
 */
function trace(topic, bytes, recvAt, msg, result) {
  if (wss.clients.size === 0) return;
  const values = Array.isArray(msg?.values) ? msg.values : null;
  broadcastAll({
    type: 'mqtt',
    topic,
    bytes,
    recvAt: new Date(recvAt).toISOString(),
    imo: typeof msg?.imo === 'string' ? msg.imo : null,
    mode: msg?.mode ?? null,
    buffered: msg?.buffered === true,
    seq: msg?.seq ?? null,
    sentAt: msg?.sentAt ?? null,
    count: values ? values.length : 0,
    accepted: result?.accepted ?? 0,
    rejected: result?.rejected ?? 0,
    preview: values ? { ...msg, values: values.slice(0, 3) } : msg,
  });
}

setInterval(() => broadcastAll({ type: 'ingestStats', at: new Date().toISOString(), ...stats, transport }), 1000);

// ----------------------------------------------------------------------
// MQTT 수신
// ----------------------------------------------------------------------
async function onTelemetry(topic, msg) {
  const headerError = validateHeader(msg);
  if (headerError) {
    await reject(topic, msg, headerError);
    return { accepted: 0, rejected: Array.isArray(msg?.values) ? msg.values.length : 1 };
  }

  const now = Date.now();
  const bad = new Map();   // 사유 → 값 목록
  const live = {};

  for (const value of msg.values) {
    stats.received += 1;
    let reason = validateValue(msg.mode, value, now);
    const tagId = reason ? null : tagCache.get(`${msg.imo}/${msg.eq}/${value.t}`);
    // 미등록 태그는 자동 등록하지 않는다. 오타·설정 오류가 조용히 유입되는 것을 막는다 (FR-154)
    if (!reason && tagId === undefined) reason = 'UNKNOWN_TAG';
    if (reason) {
      if (!bad.has(reason)) bad.set(reason, []);
      bad.get(reason).push(value);
      continue;
    }
    if (msg.mode === 'raw') {
      rawBuf.push([value.ts, tagId, value.v, value.q]);
      live[value.t] = value.v;
    } else {
      summaryBuf.push([value.ts, tagId, msg.period, value.avg, value.min, value.max, value.sd, value.n, value.q]);
      live[value.t] = value.avg;
    }
  }

  let rejected = 0;
  for (const [reason, values] of bad) {
    log(`거부 ${reason} ${topic} ${values.length}건`);
    rejected += values.length;
    await reject(topic, { ...msg, values }, reason);
  }

  // 소급 전송분은 과거 데이터이므로 실시간 화면에는 밀어 넣지 않는다
  if (!msg.buffered && Object.keys(live).length > 0) {
    broadcast(msg.imo, { type: 'telemetry', imo: msg.imo, eq: msg.eq, mode: msg.mode, at: msg.sentAt, values: live });
  }
  if (rawBuf.length + summaryBuf.length >= BATCH_SIZE) flush();
  return { accepted: msg.values.length - rejected, rejected };
}

async function onStatus(msg) {
  if (!msg || typeof msg.imo !== 'string') return;
  const prev = vesselStatus.get(msg.imo);
  const status = { online: msg.online === true, mode: msg.mode || prev?.mode || null, at: msg.at || new Date().toISOString() };
  vesselStatus.set(msg.imo, status);
  broadcast(msg.imo, { type: 'vesselStatus', imo: msg.imo, ...status });
  if (!prev || prev.online !== status.online) log(`선박 ${msg.imo} ${status.online ? '온라인' : '오프라인'}`);

  // 전송 모드 전환 이력 (NFR-08·NFR-11 측정 근거)
  if (msg.online && msg.reason && msg.mode && vesselIds.has(msg.imo)) {
    await pool.query(
      `INSERT INTO edge_mode_event (vessel_id, mode, reason, trigger_tag_id, occurred_at)
       SELECT $1, $2, $3, $4, $5
        WHERE NOT EXISTS (SELECT 1 FROM edge_mode_event WHERE vessel_id = $1 AND occurred_at = $5)`,
      [
        vesselIds.get(msg.imo),
        msg.mode.toUpperCase(),
        msg.reason,
        msg.triggerTag ? findTagId(msg.imo, msg.triggerTag) : null,
        msg.at,
      ],
    );
    log(`선박 ${msg.imo} 전송 모드 → ${msg.mode} (${msg.reason})`);
  }
}

function findTagId(imo, tagCode) {
  for (const [key, id] of tagCache) {
    if (key.startsWith(`${imo}/`) && key.endsWith(`/${tagCode}`)) return id;
  }
  return null;
}

async function main() {
  // DB 가 늦게 뜨는 경우를 대비해 기동 시 재시도한다
  for (let attempt = 1; ; attempt++) {
    try {
      await loadMaster();
      break;
    } catch (err) {
      log(`DB 접속 대기 #${attempt}: ${err.message}`);
      await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5))));
    }
  }
  setInterval(flush, FLUSH_MS);
  setInterval(() => loadMaster().catch((err) => log(`마스터 갱신 실패: ${err.message}`)), 5 * 60_000);

  const mqttUrl = env.MQTT_URL || 'mqtt://localhost:1883';
  // TLS: CA 파일을 주면 서버 인증서를 검증하고 클라이언트 인증서로 자신을 증명한다.
  // 파일이 없으면 여기서 멈춘다 — 평문으로 조용히 내려가지 않는다.
  const tls = env.MQTT_CA_FILE
    ? {
        ca: fs.readFileSync(env.MQTT_CA_FILE),
        cert: fs.readFileSync(env.MQTT_CERT_FILE),
        key: fs.readFileSync(env.MQTT_KEY_FILE),
        rejectUnauthorized: true,
      }
    : {};
  const client = mqtt.connect(mqttUrl, {
    clientId: env.MQTT_CLIENT_ID || 'ingest-1',
    clean: false,
    reconnectPeriod: 2000,
    username: env.MQTT_USERNAME || undefined,
    password: env.MQTT_PASSWORD || undefined,
    ...tls,
  });
  client.on('connect', () => {
    const socket = client.stream;
    Object.assign(transport, {
      connected: true,
      url: mqttUrl,
      tls: socket?.getProtocol?.() ?? null,
      cipher: socket?.getCipher?.()?.name ?? null,
      identity: socket?.getCertificate?.()?.subject?.CN ?? null,
    });
    log(`브로커 접속 ${mqttUrl}${transport.tls ? ` (${transport.tls}, ${transport.cipher})` : ' (평문)'}`);
    client.subscribe({ 'vesselops/telemetry/+/+': { qos: 1 }, 'vesselops/status/+': { qos: 1 } });
  });
  client.on('close', () => { transport.connected = false; });
  client.on('error', (err) => log(`MQTT 오류: ${err.message}`));
  client.on('message', (topic, buf) => {
    const recvAt = Date.now();
    stats.messages += 1;
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      trace(topic, buf.length, recvAt, null, { accepted: 0, rejected: 1 });
      return reject(topic, { raw: buf.toString().slice(0, 2000) }, 'SCHEMA_INVALID');
    }
    const handler = topic.startsWith('vesselops/telemetry/') ? onTelemetry(topic, msg) : onStatus(msg);
    handler
      .then((result) => trace(topic, buf.length, recvAt, msg, result))
      .catch((err) => log(`처리 오류 ${topic}: ${err.message}`));
  });

  httpServer.listen(PORT, () => log(`WebSocket/health :${PORT}`));

  const shutdown = async () => {
    await flush();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[ingest] 기동 실패', err);
  process.exit(1);
});

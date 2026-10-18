/**
 * 선박 1척분의 Edge 전송 로직 (IF-02)
 *
 *   표본(1초) → Pre-trigger 링버퍼 → 전송 모드 판정 → Deadband/요약 → 우선순위 큐 → MQTT
 *
 * 실선에서는 선박마다 Edge 장비가 1대씩 있으므로 MQTT 접속도 선박 단위로 분리한다.
 * 접속이 분리돼야 유언 메시지(LWT)가 선박별 통신 상태를 정확히 알려준다.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import mqtt from 'mqtt';
import { deadbandOf, TRIGGERS } from './config.js';

const round3 = (x) => Math.round(x * 1000) / 1000;
const isCylTag = (tag) => /^ME_EXH_T_CYL\d+$/.test(tag);

export class VesselEdge {
  constructor({ imo, config, log }) {
    this.imo = imo;
    this.cfg = config;
    this.log = (msg) => log(`[${imo}] ${msg}`);

    this.linkUp = true;                 // 시연용 위성 링크 스위치
    this.seq = 0;
    this.queues = [[], [], []];         // P0 상태·알람 / P1 원본 / P2 요약
    this.queuedValues = 0;
    this.dropped = 0;
    this.published = 0;

    this.lastSent = new Map();          // tag → { v, q, at }
    this.ring = [];                     // [{ ts, snap }]
    this.mode = config.adaptiveEnabled ? 'summary' : 'raw';
    this.lastAbnormalAt = 0;
    this.badCount = new Map();
    this.summary = { bucket: null, stats: new Map() };

    this.statusTopic = `vesselops/status/${imo}`;
  }

  /**
   * 선박별 클라이언트 인증서. CN 이 IMO 번호이고, 브로커는 그 번호의 토픽에만 발행을 허용한다.
   * 서버 인증서도 같은 CA 로 검증한다 (rejectUnauthorized).
   */
  tlsOptions() {
    if (!this.cfg.mqttCaFile) return {};
    return {
      ca: readFileSync(this.cfg.mqttCaFile),
      cert: readFileSync(join(this.cfg.mqttCertDir, `${this.imo}.crt`)),
      key: readFileSync(join(this.cfg.mqttCertDir, `${this.imo}.key`)),
      rejectUnauthorized: true,
    };
  }

  start() {
    let tls;
    try {
      tls = this.tlsOptions();
    } catch (err) {
      // 인증서가 없는 선박 한 척 때문에 나머지 선박의 수집까지 멈추지 않게 한다
      this.log(`인증서를 읽지 못해 브로커에 접속하지 않는다: ${err.message}`);
      return;
    }
    this.client = mqtt.connect(this.cfg.mqttUrl, {
      clientId: `edge-${this.imo}`,
      clean: false,                     // 세션 보존 — 단절이 잦은 구간의 필수 설정
      keepalive: 60,
      reconnectPeriod: 2000,
      username: this.cfg.mqttUsername,
      password: this.cfg.mqttPassword,
      ...tls,
      will: {
        topic: this.statusTopic,
        payload: JSON.stringify({ imo: this.imo, online: false, at: null, reason: 'unexpected_disconnect' }),
        qos: 1,
        retain: true,
      },
    });
    this.client.on('connect', () => {
      this.log('브로커 접속');
      this.publishStatus();
    });
    this.client.on('error', (err) => this.log(`MQTT 오류: ${err.message}`));
  }

  canSend() {
    return this.linkUp && this.client?.connected;
  }

  /** 시연: 위성 링크 단절/복구. 정상 종료 절차 없이 끊어 LWT 가 발행되게 한다. */
  setLink(connected) {
    if (connected === this.linkUp) return;
    this.linkUp = connected;
    if (connected) {
      this.log(`링크 복구 — 버퍼 ${this.queuedValues}건 재전송 시작`);
      this.client?.reconnect();
    } else {
      this.log('링크 단절 — 로컬 버퍼링 시작');
      this.client?.end(true);
    }
  }

  publishStatus(extra = {}) {
    const payload = {
      imo: this.imo,
      online: true,
      at: new Date().toISOString(),
      mode: this.mode,
      ...extra,
    };
    this.enqueue(0, { topic: this.statusTopic, retain: true, payload, n: 0 });
    this.drain();
  }

  // ------------------------------------------------------------------
  // 1초 틱
  // ------------------------------------------------------------------
  tick(nowMs, snap) {
    if (snap.length === 0) return;
    const ts = new Date(Math.floor(nowMs / 1000) * 1000).toISOString();

    // 전송 모드와 무관하게 원본은 항상 링버퍼에 남긴다 (FR-109)
    this.ring.push({ ts, snap });
    if (this.ring.length > this.cfg.ringSec) this.ring.shift();

    if (this.cfg.adaptiveEnabled) this.evaluateMode(nowMs, snap);

    if (this.mode === 'raw') this.emitRaw(ts, snap, nowMs);
    else this.accumulateSummary(snap, nowMs);

    this.drain();
  }

  // ------------------------------------------------------------------
  // 원본 전송: Deadband + Heartbeat (FR-103)
  // ------------------------------------------------------------------
  emitRaw(ts, snap, nowMs) {
    const byEq = new Map();
    for (const s of snap) {
      const last = this.lastSent.get(s.tag);
      const changed =
        !last ||
        s.q !== last.q ||
        s.v === null ||
        last.v === null ||
        Math.abs(s.v - last.v) >= deadbandOf(s.tag) ||
        nowMs - last.at >= this.cfg.heartbeatSec * 1000;
      if (!changed) continue;
      this.lastSent.set(s.tag, { v: s.v, q: s.q, at: nowMs });
      if (!byEq.has(s.eq)) byEq.set(s.eq, []);
      byEq.get(s.eq).push({ t: s.tag, ts, v: s.v, q: s.q });
    }
    for (const [eq, values] of byEq) this.enqueueTelemetry(1, eq, 'raw', values);
  }

  // ------------------------------------------------------------------
  // 요약 전송: 1분 통계 (FR-108)
  // ------------------------------------------------------------------
  accumulateSummary(snap, nowMs) {
    const periodMs = this.cfg.summaryPeriodSec * 1000;
    const bucket = Math.floor(nowMs / periodMs) * periodMs;
    if (this.summary.bucket !== null && bucket !== this.summary.bucket) this.flushSummary();
    this.summary.bucket = bucket;

    for (const s of snap) {
      let st = this.summary.stats.get(s.tag);
      if (!st) {
        st = { eq: s.eq, n: 0, sum: 0, sumSq: 0, min: Infinity, max: -Infinity, q: 192 };
        this.summary.stats.set(s.tag, st);
      }
      st.q = Math.min(st.q, s.q);   // 구간 내 최악 품질
      if (s.v === null) continue;
      st.n += 1;
      st.sum += s.v;
      st.sumSq += s.v * s.v;
      st.min = Math.min(st.min, s.v);
      st.max = Math.max(st.max, s.v);
    }
  }

  flushSummary() {
    const ts = new Date(this.summary.bucket).toISOString();
    const byEq = new Map();
    for (const [tag, st] of this.summary.stats) {
      if (st.n === 0) continue;
      const avg = st.sum / st.n;
      const variance = Math.max(0, st.sumSq / st.n - avg * avg);
      if (!byEq.has(st.eq)) byEq.set(st.eq, []);
      // 평균만 보내면 순간 스파이크가 사라지므로 min/max/sd 를 함께 보낸다
      byEq.get(st.eq).push({
        t: tag, ts, avg: round3(avg), min: st.min, max: st.max, sd: round3(Math.sqrt(variance)), n: st.n, q: st.q,
      });
    }
    for (const [eq, values] of byEq) {
      this.enqueueTelemetry(2, eq, 'summary', values, { period: this.cfg.summaryPeriodSec });
    }
    this.summary.stats.clear();
  }

  // ------------------------------------------------------------------
  // 전송 모드 판정 — 본선에서 자체 수행한다 (FR-108, 3.8.3)
  // ------------------------------------------------------------------
  evaluateMode(nowMs, snap) {
    const byTag = new Map(snap.map((s) => [s.tag, s]));
    const good = (tag) => {
      const s = byTag.get(tag);
      return s && s.q === 192 && s.v !== null ? s.v : null;
    };
    const rpm = good('ME_RPM');
    const running = rpm !== null && rpm >= TRIGGERS.engineRunningRpm;
    let trigger = null;

    // 품질 저하 연속
    for (const s of snap) {
      const n = s.q === 192 ? 0 : (this.badCount.get(s.tag) || 0) + 1;
      this.badCount.set(s.tag, n);
      if (n >= TRIGGERS.badQualityCount && !trigger) trigger = { reason: 'QUALITY', tag: s.tag };
    }

    if (running) {
      // 실린더 편차 확대
      const cyl = snap.filter((s) => isCylTag(s.tag) && s.q === 192 && s.v !== null);
      if (cyl.length >= 2) {
        const mean = cyl.reduce((a, s) => a + s.v, 0) / cyl.length;
        const worst = cyl.reduce((a, s) => (Math.abs(s.v - mean) > Math.abs(a.v - mean) ? s : a));
        if (Math.abs(worst.v - mean) >= TRIGGERS.deviation) trigger = { reason: 'DEVIATION', tag: worst.tag };
      }
      // 임계값 근접
      for (const r of TRIGGERS.thresholdNear) {
        const v = good(r.tag);
        if (v === null) continue;
        if ((r.op === '>=' && v >= r.limit) || (r.op === '<=' && v <= r.limit)) {
          trigger = trigger || { reason: 'THRESHOLD_NEAR', tag: r.tag };
        }
      }
      // 변화율 초과 — 링버퍼의 과거 값과 비교
      for (const r of TRIGGERS.rate) {
        const past = this.ring[this.ring.length - 1 - r.windowSec];
        const before = past?.snap.find((s) => s.tag === r.tag);
        const v = good(r.tag);
        if (v === null || !before || before.v === null) continue;
        if (Math.abs(v - before.v) >= r.limit) trigger = trigger || { reason: 'RATE', tag: r.tag };
      }
    }

    if (trigger) {
      this.lastAbnormalAt = nowMs;
      if (this.mode === 'summary') this.switchToRaw(trigger);
    } else if (this.mode === 'raw' && nowMs - this.lastAbnormalAt >= this.cfg.returnSec * 1000) {
      // 조건 해소 후 정상이 충분히 지속돼야 복귀한다 (채터링 방지)
      this.mode = 'summary';
      this.summary = { bucket: null, stats: new Map() };
      this.log('전송 모드 raw → summary (정상 지속)');
      this.publishStatus({ reason: 'RECOVERED' });
    }
  }

  switchToRaw(trigger) {
    this.mode = 'raw';
    this.summary = { bucket: null, stats: new Map() };
    this.lastSent.clear();
    this.log(`전송 모드 summary → raw (${trigger.reason} ${trigger.tag}) — Pre-trigger ${this.ring.length - 1}초분 소급 전송`);
    this.publishStatus({ reason: trigger.reason, triggerTag: trigger.tag });

    // 이상 확정 이전 구간을 소급 전송한다. 현재 틱은 emitRaw 가 보낸다.
    const byEq = new Map();
    for (const entry of this.ring.slice(0, -1)) {
      for (const s of entry.snap) {
        if (!byEq.has(s.eq)) byEq.set(s.eq, []);
        byEq.get(s.eq).push({ t: s.tag, ts: entry.ts, v: s.v, q: s.q });
      }
    }
    for (const [eq, values] of byEq) this.enqueueTelemetry(1, eq, 'raw', values, { buffered: true });
  }

  // ------------------------------------------------------------------
  // 송신 우선순위 큐 (FR-110) + 단절 버퍼 (FR-104)
  // ------------------------------------------------------------------
  enqueueTelemetry(prio, eq, mode, values, extra = {}) {
    const max = this.cfg.maxValuesPerMessage;
    for (let i = 0; i < values.length; i += max) {
      const chunk = values.slice(i, i + max);
      this.enqueue(prio, {
        topic: `vesselops/telemetry/${this.imo}/${eq}`,
        retain: false,
        n: chunk.length,
        payload: {
          imo: this.imo,
          eq,
          buffered: extra.buffered === true || !this.canSend(),
          mode,
          ...(extra.period ? { period: extra.period } : {}),
          values: chunk,
        },
      });
    }
  }

  enqueue(prio, item) {
    this.queues[prio].push(item);
    this.queuedValues += item.n;
    // 상한 초과 시 낮은 우선순위의 오래된 것부터 폐기
    while (this.queuedValues > this.cfg.backlogLimit) {
      const victim = this.queues[2].shift() || this.queues[1].shift();
      if (!victim) break;
      this.queuedValues -= victim.n;
      this.dropped += victim.n;
    }
  }

  drain() {
    let budget = this.cfg.drainPerTick;
    while (budget > 0 && this.canSend()) {
      const item = this.queues[0].shift() || this.queues[1].shift() || this.queues[2].shift();
      if (!item) break;
      this.queuedValues -= item.n;
      const body = item.n > 0
        ? { ...item.payload, seq: ++this.seq, sentAt: new Date().toISOString() }
        : item.payload;
      this.client.publish(item.topic, JSON.stringify(body), { qos: 1, retain: item.retain });
      this.published += 1;
      budget -= 1;
    }
  }

  info() {
    return {
      imo: this.imo,
      linkUp: this.linkUp,
      mqttConnected: !!this.client?.connected,
      mode: this.mode,
      queuedValues: this.queuedValues,
      ringSec: this.ring.length,
      published: this.published,
      dropped: this.dropped,
    };
  }
}

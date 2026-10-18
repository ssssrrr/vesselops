/**
 * 선단 시뮬레이터 진입점
 *
 *   1초 틱 → 물리모델 산출 → OPC UA 변수 갱신
 *   REST(/sim/*) → 고장 주입·해제 (IF-06)
 */
import express from 'express';
import { FLEET, VOYAGE_PROFILES, findVessel } from './fleet.js';
import {
  driftLoad,
  mainEngineTags,
  shaftTags,
  turbochargerTags,
  generatorTags,
} from './engine-model.js';
import { FaultBook, FAULT_TYPES } from './faults.js';
import { startOpcUaServer } from './opcua-server.js';

const OPCUA_PORT = Number(process.env.OPCUA_PORT || 4840);
const HTTP_PORT = Number(process.env.SIM_HTTP_PORT || 3000);
const TICK_MS = Number(process.env.SIM_INTERVAL_MS || 1000);
const AUTO_FAULT = process.env.SIM_AUTO_FAULT !== 'false';

const faults = new FaultBook({ idleResetSec: Number(process.env.SIM_IDLE_RESET_SEC || 600) });

function pickProfile() {
  const total = VOYAGE_PROFILES.reduce((s, p) => s + p.weight, 0);
  let r = Math.random() * total;
  for (const p of VOYAGE_PROFILES) {
    r -= p.weight;
    if (r <= 0) return p;
  }
  return VOYAGE_PROFILES[0];
}

const minutes = (min, max) => (min + Math.random() * (max - min)) * 60_000;

// 선박별 운전 상태
const states = new Map(
  FLEET.map((v) => {
    const profile = pickProfile();
    return [
      v.imo,
      {
        load: profile.load,
        profile,
        nextProfileAt: Date.now() + minutes(30, 60),
        dgLoad: 0.55,
        thrustBase: null,   // 추력베어링 온도의 열 관성 상태
      },
    ];
  }),
);

/** 선박 1척의 한 틱 계측값. 반환: { 장비코드: { 태그코드: 값 } } */
function sample(vessel, nowMs) {
  const st = states.get(vessel.imo);
  const dt = TICK_MS / 1000;

  if (nowMs >= st.nextProfileAt) {
    st.profile = pickProfile();
    st.nextProfileAt = nowMs + minutes(30, 60);
  }
  st.load = driftLoad(st.load, st.profile.load, dt);
  st.dgLoad = Math.min(0.85, Math.max(0.35, st.dgLoad + (Math.random() - 0.5) * 0.004));

  const fx = faults.effects(vessel.imo, nowMs);

  const me = mainEngineTags(vessel, st.load, { ...fx, thrustBias: 0 });
  // 베어링은 열용량이 커서 부하 변화를 수 분 늦게 따라간다.
  // 이 지연이 없으면 정상적인 부하 변경이 변화율 알람(FR-303)을 오작동시킨다.
  if (st.thrustBase === null) st.thrustBase = me.ME_THRUST_BRG_T;
  st.thrustBase += (me.ME_THRUST_BRG_T - st.thrustBase) * (dt / 300);
  me.ME_THRUST_BRG_T = st.thrustBase + (Math.random() - 0.5) * 0.3 + fx.thrustBias;

  const out = {
    ME: me,
    SHAFT: shaftTags(vessel, st.load),
    TC1: turbochargerTags(vessel, st.load, fx),
  };
  for (let i = 1; i <= vessel.dgCount; i++) {
    out[`DG${i}`] = generatorTags(`DG${i}`, i <= vessel.dgRunning, st.dgLoad);
  }
  return out;
}

/** 평상시에도 알람 이력이 쌓이도록 가끔 경미한 이상을 발생시킨다 (8.3) */
let nextAutoFaultAt = Date.now() + minutes(20, 40);
function maybeAutoFault(nowMs) {
  if (!AUTO_FAULT || nowMs < nextAutoFaultAt) return;
  nextAutoFaultAt = nowMs + minutes(40, 80);
  const atSea = FLEET.filter((v) => v.status === 'AT_SEA');
  const vessel = atSea[Math.floor(Math.random() * atSea.length)];
  faults.inject(
    {
      imo: vessel.imo,
      type: 'CYL_EXH_DEVIATION',
      cylinder: 1 + Math.floor(Math.random() * vessel.engine.cylinders),
      severity: 70 + Math.random() * 10,
      auto: true,
    },
    nowMs,
  );
}

async function main() {
  // 주소공간 구성을 위해 첫 표본으로 태그 목록을 뽑는다
  const first = Date.now();
  const initial = {};
  const layout = FLEET.map((v) => {
    const s = sample(v, first);
    for (const [eq, tags] of Object.entries(s)) {
      for (const [tag, value] of Object.entries(tags)) {
        initial[`${v.imo}.${eq}.${tag}`] = Math.round(value * 1000) / 1000;
      }
    }
    return {
      imo: v.imo,
      name: v.name,
      equipment: Object.fromEntries(Object.entries(s).map(([eq, tags]) => [eq, Object.keys(tags)])),
    };
  });

  const opc = await startOpcUaServer({ port: OPCUA_PORT, layout, initial });
  console.log(`[sim] OPC UA 서버 기동 ${opc.endpoint} (노드 ${opc.nodeCount}개)`);

  const tick = () => {
    const nowMs = Date.now();
    const ts = new Date(Math.floor(nowMs / 1000) * 1000);   // 초 단위로 정렬
    faults.expire(nowMs);
    maybeAutoFault(nowMs);
    for (const vessel of FLEET) {
      const s = sample(vessel, nowMs);
      for (const [eq, tags] of Object.entries(s)) {
        for (const [tag, value] of Object.entries(tags)) {
          opc.update(vessel.imo, eq, tag, Math.round(value * 1000) / 1000, ts);
        }
      }
    }
  };
  // setInterval 은 조금씩 밀려 초 경계를 건너뛰는 틱이 생긴다. 매번 다음 주기 경계에 맞춰 다시 건다.
  const schedule = () => {
    setTimeout(() => {
      tick();
      schedule();
    }, TICK_MS - (Date.now() % TICK_MS));
  };
  schedule();

  // ---- 시연 제어 API (IF-06) ----
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => res.json({ status: 'UP', nodes: opc.nodeCount }));

  app.get('/sim/state', (_req, res) => {
    res.json({
      faultTypes: FAULT_TYPES,
      faults: faults.list(),
      vessels: FLEET.map((v) => ({
        imo: v.imo,
        name: v.name,
        status: v.status,
        cylinders: v.engine.cylinders,
        profile: states.get(v.imo).profile.name,
        load: Math.round(states.get(v.imo).load * 1000) / 10,
      })),
    });
  });

  app.post('/sim/fault', (req, res) => {
    const { imo, type, cylinder, severity } = req.body || {};
    const vessel = findVessel(String(imo));
    if (!vessel) return res.status(404).json({ code: 'VESSEL_NOT_FOUND', message: '선박을 찾을 수 없습니다.' });
    const def = FAULT_TYPES[type];
    if (!def) return res.status(400).json({ code: 'FAULT_TYPE_INVALID', message: '지원하지 않는 고장 종류입니다.' });
    if (vessel.status === 'IN_PORT') {
      return res.status(409).json({ code: 'ENGINE_STOPPED', message: '정박 중인 선박은 주기관이 정지 상태입니다.' });
    }
    if (def.needsCylinder && !(Number.isInteger(cylinder) && cylinder >= 1 && cylinder <= vessel.engine.cylinders)) {
      return res.status(400).json({ code: 'CYLINDER_INVALID', message: `실린더 번호는 1~${vessel.engine.cylinders} 입니다.` });
    }
    const fault = faults.inject({ imo: vessel.imo, type, cylinder, severity: Number(severity) });
    console.log(`[sim] 고장 주입 ${vessel.name} ${type}${fault.cylinder ? ` #${fault.cylinder}` : ''} severity=${fault.severity}`);
    res.status(201).json(fault);
  });

  app.delete('/sim/fault', (req, res) => {
    faults.clear(req.query.imo ? String(req.query.imo) : undefined);
    console.log('[sim] 고장 해제');
    res.status(204).end();
  });

  app.listen(HTTP_PORT, () => console.log(`[sim] 시연 제어 API :${HTTP_PORT}`));

  const shutdown = async () => {
    await opc.stop();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[sim] 기동 실패', err);
  process.exit(1);
});

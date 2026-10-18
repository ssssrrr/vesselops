/**
 * 선박 주기관 물리 모델
 *
 * 설계 원칙: 부하율(load, 0~1) 하나가 상태를 결정하고 나머지 계측값은 전부 여기서 파생된다.
 * 센서값을 각각 독립적으로 난수 생성하면 회전수는 낮은데 출력은 높은 식의
 * 물리적으로 모순된 데이터가 나온다.
 */

const rand = (amp) => (Math.random() * 2 - 1) * amp;

/** 표준정규 근사 (Box-Muller) — 부하 표류에 사용 */
function randn() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * 부하 표류 (평균회귀 랜덤워크)
 * 실제 항해에서 부하는 파도·기상으로 천천히 흔들릴 뿐 튀지 않는다.
 */
export function driftLoad(current, target, dtSec) {
  const theta = 0.02;   // 목표로 되돌아가는 속도
  const sigma = 0.004;  // 흔들림 크기
  const next = current + theta * (target - current) * dtSec + sigma * randn() * Math.sqrt(dtSec);
  return Math.min(1.0, Math.max(0.15, next));
}

/**
 * SFOC (연료소비율, g/kWh) — U자 곡선
 * 대형 저속 2행정 기관은 75% 부하 부근이 최적이고, 그보다 낮거나 높으면 나빠진다.
 */
export function sfoc(load, sfocMin) {
  const OPTIMAL = 0.75;
  const CURVE = 95;   // 곡률: 최적점에서 25%p 벗어나면 약 +6 g/kWh
  return sfocMin + CURVE * Math.pow(load - OPTIMAL, 2);
}

/**
 * 주기관 계측값 일괄 산출
 * @param {object} vessel  fleet.js 의 선박 정의
 * @param {number} load    부하율 0~1
 * @param {object} fx      고장 효과 { cylBias:{}, loPressDrop, tcFouling, thrustBias }
 * @returns {Object<string, number>} 태그코드 → 값
 */
export function mainEngineTags(vessel, load, fx = {}) {
  const e = vessel.engine;
  const out = {};

  // --- 정지 중(정박)이면 주기관 관련 값은 0 ---
  if (vessel.status === 'IN_PORT') {
    out.ME_RPM = 0;
    out.ME_LOAD = 0;
    out.ME_SCAV_P = 0;
    out.ME_SCAV_T = 28 + rand(1);
    out.ME_TC_RPM = 0;
    out.ME_LO_P = 0.2 + rand(0.05);        // 대기펌프만 운전
    out.ME_LO_T = 35 + rand(0.5);
    out.ME_JCW_IN_T = 45 + rand(0.5);      // 예열 상태 유지
    out.ME_JCW_OUT_T = 46 + rand(0.5);
    out.ME_FO_FLOW = 0;
    out.ME_FO_T = 130 + rand(2);           // 중유 점도 유지를 위해 계속 가열
    out.ME_THRUST_BRG_T = 28 + rand(0.5) + (fx.thrustBias || 0);
    out.ME_VIB_RMS = 0.2 + rand(0.05);
    for (let i = 1; i <= e.cylinders; i++) {
      out[`ME_EXH_T_CYL${String(i).padStart(2, '0')}`] = 40 + rand(2);
    }
    return out;
  }

  // --- 과급기 오염 효과 ---
  const foulScav = fx.tcFouling ? 1 - 0.15 * fx.tcFouling : 1;   // 소기압 저하
  const foulExh = fx.tcFouling ? 25 * fx.tcFouling : 0;          // 배기온도 상승
  const foulFuel = fx.tcFouling ? 1 + 0.05 * fx.tcFouling : 1;   // 연료소비 증가

  // --- 프로펠러 법칙: 출력 ∝ 회전수³ ---
  out.ME_RPM = e.ratedRpm * Math.cbrt(load) + rand(0.15);
  out.ME_LOAD = load * 100 + rand(0.3);

  const powerKw = e.ratedPowerKw * load;

  // --- 연료 ---
  const g = sfoc(load, vessel.sfocMin) * foulFuel;
  out.ME_FO_FLOW = (powerKw * g) / 1000 + rand(4);   // kg/h
  out.ME_FO_T = 138 + rand(1.5);                     // 점도 제어로 거의 일정

  // --- 과급 ---
  out.ME_SCAV_P = e.maxScavBar * Math.pow(load, 1.4) * foulScav + rand(0.02);
  out.ME_SCAV_T = 32 + 14 * load + rand(0.6);
  out.ME_TC_RPM = e.tcRatedRpm * Math.pow(load, 0.55) * foulScav + rand(30);

  // --- 배기온도: 고부하로 갈수록 상승폭이 둔해진다 ---
  const exhMean = 295 + 170 * load - 65 * load * load + foulExh;
  for (let i = 1; i <= e.cylinders; i++) {
    const code = `ME_EXH_T_CYL${String(i).padStart(2, '0')}`;
    const bias = (fx.cylBias && fx.cylBias[i]) || 0;   // 고장 주입분
    out[code] = exhMean + vessel.cylOffsets[i - 1] + rand(3) + bias;
  }

  // --- 윤활 ---
  out.ME_LO_P = 3.9 + 0.15 * load + rand(0.04) - (fx.loPressDrop || 0);
  out.ME_LO_T = 42 + 12 * load + rand(0.4);

  // --- 냉각수: 입구는 온도조절밸브가 잡아주고, 출구는 부하만큼 올라간다 ---
  out.ME_JCW_IN_T = 70 + rand(0.4);
  out.ME_JCW_OUT_T = out.ME_JCW_IN_T + 6 + 9 * load + rand(0.5);

  // --- 축계·진동 ---
  // 전부하에서도 60℃ 미만 — Edge 의 임계값 근접 기준(60℃)이 정상 운전에서 걸리지 않게 한다
  out.ME_THRUST_BRG_T = 40 + 16 * load + rand(0.6) + (fx.thrustBias || 0);
  out.ME_VIB_RMS = vessel.vibBase + 1.6 * load + rand(0.25);

  return out;
}

/** 축계 계측값 (주기관 출력에서 파생) */
export function shaftTags(vessel, load) {
  if (vessel.status === 'IN_PORT') {
    return { SHAFT_RPM: 0, SHAFT_POWER: 0, SHAFT_TORQUE: 0 };
  }
  const e = vessel.engine;
  const rpm = e.ratedRpm * Math.cbrt(load);
  const powerKw = e.ratedPowerKw * load * 0.98;          // 전달효율
  const omega = (2 * Math.PI * rpm) / 60;                // rad/s
  return {
    SHAFT_RPM: rpm + rand(0.1),
    SHAFT_POWER: powerKw + rand(20),
    SHAFT_TORQUE: (powerKw * 1000) / omega / 1000 + rand(3),   // kNm
  };
}

/** 과급기 계측값 */
export function turbochargerTags(vessel, load, fx = {}) {
  if (vessel.status === 'IN_PORT') {
    return { TC_EXH_IN_T: 40 + rand(2), TC_EXH_OUT_T: 35 + rand(2), TC_LO_P: 0.1 };
  }
  const foulExh = fx.tcFouling ? 25 * fx.tcFouling : 0;
  const exhMean = 295 + 170 * load - 65 * load * load + foulExh;
  const inT = exhMean - 15 + rand(2);
  return {
    TC_EXH_IN_T: inT,
    TC_EXH_OUT_T: inT - 130 - 40 * load + rand(2),   // 터빈에서 팽창하며 온도 강하
    TC_LO_P: 2.2 + 0.3 * load + rand(0.03),
  };
}

/**
 * 발전기관 계측값
 * 동기발전기라 회전수는 720rpm 고정이고 부하만 변한다.
 */
export function generatorTags(code, running, dgLoad) {
  if (!running) {
    return {
      [`${code}_RPM`]: 0,
      [`${code}_POWER`]: 0,
      [`${code}_EXH_T`]: 45 + rand(2),
      [`${code}_LO_P`]: 0.1 + rand(0.02),
      [`${code}_JCW_T`]: 48 + rand(1),
    };
  }
  return {
    [`${code}_RPM`]: 720 + rand(1.5),
    [`${code}_POWER`]: 3000 * dgLoad + rand(8),
    [`${code}_EXH_T`]: 300 + 180 * dgLoad + rand(4),
    [`${code}_LO_P`]: 4.5 + 0.2 * dgLoad + rand(0.05),
    [`${code}_JCW_T`]: 78 + 8 * dgLoad + rand(0.5),
  };
}

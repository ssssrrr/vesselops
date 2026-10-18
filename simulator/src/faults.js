/**
 * 고장 모델 (IF-06 시연 제어)
 *
 * 고장은 "값을 바로 바꾸는 것"이 아니라 시간에 따라 진행되는 효과로 표현한다.
 * 실제 고장은 계단처럼 튀지 않고 서서히 진행되며, 그래야 dwell(지속시간) 판정과
 * 변화율 알람이 의미 있게 동작한다.
 */

export const FAULT_TYPES = {
  // 한 실린더가 오르면 평균도 함께 오르므로, 편차 50℃ 를 확실히 넘기려면 75℃ 를 올린다
  CYL_EXH_DEVIATION: { label: '실린더 배기온도 편차', needsCylinder: true, defaultSeverity: 75 },
  LO_PRESSURE_DROP: { label: '윤활유 압력 저하', defaultSeverity: 1 },
  TC_FOULING: { label: '과급기 오염', defaultSeverity: 0.8 },
  THRUST_BRG_HEATING: { label: '추력베어링 과열', defaultSeverity: 1 },
};

const ramp = (elapsedSec, fullSec) => Math.min(1, Math.max(0, elapsedSec / fullSec));

export class FaultBook {
  constructor({ idleResetSec = 600 } = {}) {
    this.faults = [];            // { imo, type, cylinder, severity, startedAt, auto }
    this.idleResetSec = idleResetSec;
    this.lastTouchedAt = 0;
  }

  inject({ imo, type, cylinder, severity, auto = false }, nowMs = Date.now()) {
    const def = FAULT_TYPES[type];
    // 같은 선박·같은 종류(·같은 실린더)는 덮어쓴다 — 버튼을 여러 번 눌러도 누적되지 않게
    this.faults = this.faults.filter(
      (f) => !(f.imo === imo && f.type === type && (f.cylinder ?? null) === (cylinder ?? null)),
    );
    const fault = {
      imo,
      type,
      cylinder: def.needsCylinder ? cylinder : undefined,
      severity: Number.isFinite(severity) ? severity : def.defaultSeverity,
      startedAt: nowMs,
      auto,
    };
    this.faults.push(fault);
    if (!auto) this.lastTouchedAt = nowMs;
    return fault;
  }

  clear(imo) {
    this.faults = imo ? this.faults.filter((f) => f.imo !== imo) : [];
  }

  /** 마지막 조작 후 일정 시간이 지나면 정상 복귀 (8.3 유휴 자동 복귀) */
  expire(nowMs = Date.now()) {
    const manual = this.faults.some((f) => !f.auto);
    if (manual && nowMs - this.lastTouchedAt > this.idleResetSec * 1000) {
      this.faults = this.faults.filter((f) => f.auto);
    }
    // 자동 발생분은 자체 수명(5분)을 가진다
    this.faults = this.faults.filter((f) => !f.auto || nowMs - f.startedAt < 300_000);
  }

  list(nowMs = Date.now()) {
    return this.faults.map((f) => ({
      ...f,
      label: FAULT_TYPES[f.type].label,
      startedAt: new Date(f.startedAt).toISOString(),
      elapsedSec: Math.round((nowMs - f.startedAt) / 1000),
    }));
  }

  /** engine-model 이 받는 고장 효과(fx)로 환산 */
  effects(imo, nowMs = Date.now()) {
    const fx = { cylBias: {}, loPressDrop: 0, tcFouling: 0, thrustBias: 0 };
    for (const f of this.faults) {
      if (f.imo !== imo) continue;
      const t = (nowMs - f.startedAt) / 1000;
      switch (f.type) {
        case 'CYL_EXH_DEVIATION':
          // 120초에 걸쳐 목표 편차까지 상승
          fx.cylBias[f.cylinder] = (fx.cylBias[f.cylinder] || 0) + f.severity * ramp(t, 120);
          break;
        case 'LO_PRESSURE_DROP':
          // 3.9 → 1.8 bar, 90초에 걸쳐 하강
          fx.loPressDrop += 2.1 * f.severity * ramp(t, 90);
          break;
        case 'TC_FOULING':
          fx.tcFouling = Math.min(1, fx.tcFouling + f.severity * ramp(t, 60));
          break;
        case 'THRUST_BRG_HEATING':
          // 분당 +8℃, 최대 +50℃
          fx.thrustBias += Math.min(50, (t / 60) * 8 * f.severity);
          break;
      }
    }
    return fx;
  }
}

/**
 * 계측값 페이로드 검증 (FR-152, 인터페이스 정의서 5.2)
 *
 * 검증에 실패한 값은 버리지 않고 사유와 함께 돌려준다. 호출부가 격리 테이블에 적재한다.
 * 조용히 버리면 본선 Edge 의 설정 오류를 추적할 방법이 없다.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const QUALITIES = new Set([192, 64, 0]);

export function validateHeader(msg) {
  if (!msg || typeof msg !== 'object') return 'SCHEMA_INVALID';
  if (typeof msg.imo !== 'string' || typeof msg.eq !== 'string') return 'SCHEMA_INVALID';
  if (msg.mode !== 'raw' && msg.mode !== 'summary') return 'SCHEMA_INVALID';
  if (!Array.isArray(msg.values) || msg.values.length === 0 || msg.values.length > 200) return 'SCHEMA_INVALID';
  if (msg.mode === 'summary' && !Number.isInteger(msg.period)) return 'SCHEMA_INVALID';
  return null;
}

/** @returns {string|null} 거부 사유 코드 또는 null(정상) */
export function validateValue(mode, value, nowMs) {
  if (!value || typeof value.t !== 'string' || typeof value.ts !== 'string') return 'SCHEMA_INVALID';
  if (!QUALITIES.has(value.q)) return 'SCHEMA_INVALID';

  const ts = Date.parse(value.ts);
  if (Number.isNaN(ts)) return 'SCHEMA_INVALID';
  if (Math.abs(ts - nowMs) > DAY_MS) return 'TS_OUT_OF_RANGE';

  if (mode === 'raw') {
    // 품질 불량 값은 null 로 올 수 있다. 센서 고장 자체가 진단 대상이라 그대로 적재한다.
    if (value.v !== null && typeof value.v !== 'number') return 'SCHEMA_INVALID';
    if (value.v !== null && !Number.isFinite(value.v)) return 'VALUE_NOT_FINITE';
    return null;
  }
  for (const key of ['avg', 'min', 'max', 'sd']) {
    if (typeof value[key] !== 'number') return 'SCHEMA_INVALID';
    if (!Number.isFinite(value[key])) return 'VALUE_NOT_FINITE';
  }
  if (!Number.isInteger(value.n) || value.n < 0) return 'SCHEMA_INVALID';
  return null;
}

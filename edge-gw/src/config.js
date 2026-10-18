/**
 * Edge 수집기 설정
 *
 * 육상 DB 의 알람 룰을 본선에서 조회할 수 없으므로(위성 구간), 전송 모드 전환에 쓰는
 * 기준값은 본선 설정으로 따로 가진다. 육상 알람 기준보다 낮게 잡아 먼저 반응하게 한다.
 */
const env = process.env;

export const config = {
  opcuaEndpoint: env.OPCUA_ENDPOINT || 'opc.tcp://localhost:4840/vesselops',
  mqttUrl: env.MQTT_URL || 'mqtt://localhost:1883',
  mqttUsername: env.MQTT_USERNAME || undefined,
  mqttPassword: env.MQTT_PASSWORD || undefined,
  // TLS: CA 파일을 주면 선박별 클라이언트 인증서({IMO}.crt / {IMO}.key)로 접속한다
  mqttCaFile: env.MQTT_CA_FILE || undefined,
  mqttCertDir: env.MQTT_CERT_DIR || '/certs',
  httpPort: Number(env.EDGE_HTTP_PORT || 3002),

  collectMode: env.COLLECT_MODE || 'subscribe',     // subscribe | poll
  tickMs: 1000,

  // 시연 프로파일은 false(항상 원본), 실선 프로파일은 true
  adaptiveEnabled: env.ADAPTIVE_ENABLED === 'true',
  summaryPeriodSec: Number(env.SUMMARY_PERIOD_SEC || 60),
  ringSec: Number(env.RING_SEC || 600),             // Pre-trigger 보관 구간
  returnSec: Number(env.RETURN_SEC || 600),         // 정상 지속 후 요약 복귀

  heartbeatSec: 60,
  maxValuesPerMessage: 200,
  backlogLimit: 100_000,                            // 단절 버퍼 상한(계측값 건수)
  drainPerTick: Number(env.DRAIN_PER_TICK || 60),   // 틱당 발행 메시지 수 상한
};

/** 태그코드 → Deadband (인터페이스 정의서 3.4) */
const DEADBAND_RULES = [
  [/^ME_EXH_T_CYL\d+$/, 0.5],
  [/^ME_(RPM|LOAD|SCAV_T|LO_T|JCW_IN_T|JCW_OUT_T|THRUST_BRG_T)$/, 0.5],
  [/^ME_(SCAV_P|LO_P)$/, 0.05],
  [/^ME_TC_RPM$/, 50],
  [/^ME_FO_FLOW$/, 5],
  [/^ME_FO_T$/, 1.0],
  [/^ME_VIB_RMS$/, 0.1],
  [/^DG\d_(RPM|EXH_T)$/, 1.0],
  [/^DG\d_POWER$/, 10],
  [/^DG\d_LO_P$/, 0.05],
  [/^DG\d_JCW_T$/, 0.5],
  [/^TC_EXH_(IN|OUT)_T$/, 1.0],
  [/^TC_LO_P$/, 0.05],
  [/^SHAFT_RPM$/, 0.5],
  [/^SHAFT_POWER$/, 20],
  [/^SHAFT_TORQUE$/, 5],
];

export function deadbandOf(tag) {
  for (const [re, db] of DEADBAND_RULES) if (re.test(tag)) return db;
  return 0;
}

/** 전송 모드 전환 트리거 (인터페이스 정의서 3.8.3) */
export const TRIGGERS = {
  deviation: 30,                  // 편차 알람 50℃ 의 60%
  thresholdNear: [
    { tag: 'ME_THRUST_BRG_T', op: '>=', limit: 60 },   // HI 75℃ 의 80%
    { tag: 'ME_JCW_OUT_T', op: '>=', limit: 86 },
    { tag: 'ME_LO_P', op: '<=', limit: 2.5 },          // LO 2.0 bar 의 125%
  ],
  rate: [
    { tag: 'ME_THRUST_BRG_T', windowSec: 60, limit: 4 },
    { tag: 'ME_LO_P', windowSec: 60, limit: 0.4 },
  ],
  badQualityCount: 5,
  engineRunningRpm: 5,            // 이 미만이면 주기관 정지로 보고 판정하지 않는다
};

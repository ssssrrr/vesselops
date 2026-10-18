/**
 * 선단 정의 — db/init/02-seed.sql 의 선박/장비와 1:1 대응해야 한다.
 * 여기 IMO 번호와 장비 code 가 DB 시드와 어긋나면 수집기가 태그를 못 찾는다.
 */

// 실린더 고유 오프셋(℃). 실제 엔진의 개체차를 모사한다.
// 합이 0에 가깝도록 둬서 평균이 왜곡되지 않게 한다.
const CYL_OFFSETS = {
  '9876543': [-4, 6, -2, 1, 3, -5, 1],
  '9876544': [2, -3, 5, -1, -4, 2, -1],
  '9812345': [3, -2, -4, 1, 4, -2],
  '9754321': [-5, 2, 6, -3, 1, -1],
};

export const FLEET = [
  {
    imo: '9876543',
    name: 'STELLA PIONEER',
    type: 'CONTAINER',
    status: 'AT_SEA',
    engine: {
      code: 'ME',
      model: '7S60ME-C10.5',
      ratedPowerKw: 15400,
      ratedRpm: 89,
      cylinders: 7,
      tcRatedRpm: 17500,
      maxScavBar: 3.6,
    },
    // 노후도/개체차 보정
    sfocMin: 168.0,      // g/kWh, 최적 부하에서의 연료소비율
    vibBase: 1.8,
    cylOffsets: CYL_OFFSETS['9876543'],
    dgCount: 2,
    dgRunning: 1,        // 항해 중에는 보통 1대만 운전
  },
  {
    imo: '9876544',
    name: 'STELLA VOYAGER',
    type: 'CONTAINER',
    status: 'AT_SEA',
    engine: {
      code: 'ME',
      model: '7S60ME-C10.5',
      ratedPowerKw: 15400,
      ratedRpm: 89,
      cylinders: 7,
      tcRatedRpm: 17500,
      maxScavBar: 3.6,
    },
    // 동형선이지만 1.5% 연비가 좋다 — 비교 화면이 의미를 가지려면 차이가 있어야 한다
    sfocMin: 165.5,
    vibBase: 1.7,
    cylOffsets: CYL_OFFSETS['9876544'],
    dgCount: 2,
    dgRunning: 1,
  },
  {
    imo: '9812345',
    name: 'ARCTIC AURORA',
    type: 'LNG_CARRIER',
    status: 'AT_SEA',
    engine: {
      code: 'ME',
      model: '6G70ME-C10.5',
      ratedPowerKw: 18300,
      ratedRpm: 72,
      cylinders: 6,
      tcRatedRpm: 16000,
      maxScavBar: 3.8,
    },
    sfocMin: 164.0,
    vibBase: 1.6,
    cylOffsets: CYL_OFFSETS['9812345'],
    dgCount: 2,
    dgRunning: 1,
  },
  {
    imo: '9754321',
    name: 'PACIFIC HARVEST',
    type: 'BULK_CARRIER',
    status: 'IN_PORT',   // 정박 중 — 주기관 정지, 발전기 2대 운전
    engine: {
      code: 'ME',
      model: '6S50ME-B9.5',
      ratedPowerKw: 8700,
      ratedRpm: 99,
      cylinders: 6,
      tcRatedRpm: 19000,
      maxScavBar: 3.4,
    },
    // 2016년 건조, 운전시간 62,870h — 노후로 연비 악화·진동 증가
    sfocMin: 175.0,
    vibBase: 2.6,
    cylOffsets: CYL_OFFSETS['9754321'],
    dgCount: 2,
    dgRunning: 2,
  },
];

// 운항 상황별 목표 부하. 30~60분마다 이 중 하나로 바뀐다.
export const VOYAGE_PROFILES = [
  { name: 'FULL_AHEAD', load: 0.82, weight: 5 },
  { name: 'SEA_PASSAGE', load: 0.75, weight: 4 },
  { name: 'SLOW_STEAMING', load: 0.55, weight: 3 },
  { name: 'MANOEUVRING', load: 0.35, weight: 1 },
];

export function findVessel(imo) {
  return FLEET.find((v) => v.imo === imo);
}

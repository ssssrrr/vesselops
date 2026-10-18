-- =====================================================================
-- VesselOps 시드 데이터 (선박 / 기관 / 계측점 / 알람룰)
--
-- 사용자 계정은 여기에 없다. BCrypt 해시를 SQL에 박으면 평문을 알 수 없고
-- 운영까지 그대로 따라가므로, Spring Boot 기동 시 생성한다.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 선박 4척 (STELLA 2척은 동형선 — 성능 비교 대상)
-- ---------------------------------------------------------------------
INSERT INTO vessel (imo_no, name, vessel_type, class_society, flag_state, built_year, dwt, sister_group, status) VALUES
 ('9876543', 'STELLA PIONEER',  'CONTAINER',    'KR',  'Republic of Korea', 2019, 118000, 'SP-CLASS', 'AT_SEA'),
 ('9876544', 'STELLA VOYAGER',  'CONTAINER',    'KR',  'Republic of Korea', 2020, 118000, 'SP-CLASS', 'AT_SEA'),
 ('9812345', 'ARCTIC AURORA',   'LNG_CARRIER',  'DNV', 'Marshall Islands',  2021,  95000, NULL,       'AT_SEA'),
 ('9754321', 'PACIFIC HARVEST', 'BULK_CARRIER', 'NK',  'Panama',            2016,  82000, NULL,       'IN_PORT');

-- ---------------------------------------------------------------------
-- 주기관 (선박별 1기)
-- ---------------------------------------------------------------------
INSERT INTO equipment (vessel_id, code, name, equip_type, maker, model, rated_power_kw, rated_rpm, cylinder_count, running_hours, installed_on)
SELECT v.id, 'ME', '주기관', 'MAIN_ENGINE', e.maker, e.model, e.kw, e.rpm, e.cyl, e.hours, e.inst
FROM vessel v
JOIN (VALUES
    ('9876543', 'Hanwha Engine', '7S60ME-C10.5', 15400.0, 89.0, 7, 41250.5, DATE '2019-03-11'),
    ('9876544', 'Hanwha Engine', '7S60ME-C10.5', 15400.0, 89.0, 7, 33980.0, DATE '2020-05-22'),
    ('9812345', 'Hanwha Engine', '6G70ME-C10.5', 18300.0, 72.0, 6, 27410.2, DATE '2021-01-18'),
    ('9754321', 'Hanwha Engine', '6S50ME-B9.5',   8700.0, 99.0, 6, 62870.9, DATE '2016-08-30')
) AS e(imo, maker, model, kw, rpm, cyl, hours, inst) ON e.imo = v.imo_no;

-- ---------------------------------------------------------------------
-- 발전기 (선박별 2기), 과급기, 축계
-- ---------------------------------------------------------------------
INSERT INTO equipment (vessel_id, code, name, equip_type, maker, model, rated_power_kw, rated_rpm, cylinder_count)
SELECT v.id, 'DG' || g, g || '번 발전기관', 'GEN_ENGINE', 'Hanwha Engine', '6H32/40', 3000.0, 720.0, 6
FROM vessel v CROSS JOIN generate_series(1, 2) g;

INSERT INTO equipment (vessel_id, code, name, equip_type, maker, model, rated_rpm)
SELECT v.id, 'TC1', '주기관 과급기', 'TURBOCHARGER', 'ABB', 'A175-L', 18000.0
FROM vessel v;

INSERT INTO equipment (vessel_id, code, name, equip_type)
SELECT v.id, 'SHAFT', '추진축계', 'SHAFTING'
FROM vessel v;

-- ---------------------------------------------------------------------
-- 주기관 실린더별 배기온도 — 편차 진단(FR-302)의 대상
-- 실린더 수가 선박마다 다르므로 cylinder_count 만큼 자동 생성한다.
-- ---------------------------------------------------------------------
INSERT INTO tag (equipment_id, code, name, unit, cylinder_no, normal_min, normal_max, scan_ms)
SELECT e.id,
       'ME_EXH_T_CYL' || lpad(g::text, 2, '0'),
       g || '번 실린더 배기온도',
       'degC', g, 280, 430, 1000
FROM equipment e
CROSS JOIN LATERAL generate_series(1, e.cylinder_count) g
WHERE e.equip_type = 'MAIN_ENGINE';

-- ---------------------------------------------------------------------
-- 주기관 공통 계측점
-- ---------------------------------------------------------------------
INSERT INTO tag (equipment_id, code, name, unit, normal_min, normal_max, scan_ms)
SELECT e.id, t.code, t.name, t.unit, t.nmin, t.nmax, t.scan
FROM equipment e
CROSS JOIN (VALUES
    ('ME_RPM',          '주기관 회전수',        'rpm',   40.0,  95.0, 1000),
    ('ME_LOAD',         '주기관 부하율',        '%',     20.0, 100.0, 1000),
    ('ME_SCAV_P',       '소기압력',            'bar',    1.0,   3.6, 1000),
    ('ME_SCAV_T',       '소기온도',            'degC',  25.0,  55.0, 1000),
    ('ME_TC_RPM',       '과급기 회전수',        'rpm', 6000.0,17500.0, 1000),
    ('ME_LO_P',         '윤활유 압력',          'bar',    2.0,   5.0, 1000),
    ('ME_LO_T',         '윤활유 온도',          'degC',  40.0,  60.0, 1000),
    ('ME_JCW_IN_T',     '실린더냉각수 입구온도',  'degC',  60.0,  75.0, 1000),
    ('ME_JCW_OUT_T',    '실린더냉각수 출구온도',  'degC',  75.0,  90.0, 1000),
    ('ME_FO_FLOW',      '연료유 유량',          'kg/h',   0.0,3500.0, 1000),
    ('ME_FO_T',         '연료유 온도',          'degC', 120.0, 150.0, 5000),
    ('ME_THRUST_BRG_T', '추력베어링 온도',       'degC',  40.0,  75.0, 1000),
    ('ME_VIB_RMS',      '주기관 진동 실효값',     'mm/s',   0.0,   7.1, 1000)
) AS t(code, name, unit, nmin, nmax, scan)
WHERE e.equip_type = 'MAIN_ENGINE';

-- ---------------------------------------------------------------------
-- 발전기관 계측점
-- ---------------------------------------------------------------------
INSERT INTO tag (equipment_id, code, name, unit, normal_min, normal_max, scan_ms)
SELECT e.id, e.code || '_' || t.code, e.code || ' ' || t.name, t.unit, t.nmin, t.nmax, 2000
FROM equipment e
CROSS JOIN (VALUES
    ('RPM',      '회전수',       'rpm',  0.0, 750.0),
    ('POWER',    '발전출력',     'kW',   0.0,3000.0),
    ('EXH_T',    '배기온도',     'degC', 0.0, 480.0),
    ('LO_P',     '윤활유 압력',   'bar',  2.5,   6.0),
    ('JCW_T',    '냉각수 온도',   'degC', 0.0,  95.0)
) AS t(code, name, unit, nmin, nmax)
WHERE e.equip_type = 'GEN_ENGINE';

-- ---------------------------------------------------------------------
-- 과급기 / 축계 계측점
-- ---------------------------------------------------------------------
INSERT INTO tag (equipment_id, code, name, unit, normal_min, normal_max, scan_ms)
SELECT e.id, t.code, t.name, t.unit, t.nmin, t.nmax, 1000
FROM equipment e
CROSS JOIN (VALUES
    ('TC_EXH_IN_T',  '과급기 입구 배기온도', 'degC', 200.0, 480.0),
    ('TC_EXH_OUT_T', '과급기 출구 배기온도', 'degC', 150.0, 350.0),
    ('TC_LO_P',      '과급기 윤활유 압력',   'bar',    1.5,   3.0)
) AS t(code, name, unit, nmin, nmax)
WHERE e.equip_type = 'TURBOCHARGER';

INSERT INTO tag (equipment_id, code, name, unit, normal_min, normal_max, scan_ms)
SELECT e.id, t.code, t.name, t.unit, t.nmin, t.nmax, 1000
FROM equipment e
CROSS JOIN (VALUES
    ('SHAFT_POWER',  '축 출력',   'kW',  0.0, 20000.0),
    ('SHAFT_TORQUE', '축 토크',   'kNm', 0.0,  2200.0),
    ('SHAFT_RPM',    '축 회전수', 'rpm', 0.0,   100.0)
) AS t(code, name, unit, nmin, nmax)
WHERE e.equip_type = 'SHAFTING';

-- =====================================================================
-- 알람 룰
-- =====================================================================

-- 1) 편차 알람 — 이 시스템의 핵심 진단(FR-302)
--    실린더별 배기온도가 전 실린더 평균 대비 ±50℃ 이상 벌어지면 경보.
--    절대값이 정상범위 안이어도 잡힌다 = 연료분사밸브·배기밸브 이상 조기징후.
INSERT INTO alarm_rule (equipment_id, rule_type, severity, deviation_limit, dwell_sec, message_template)
SELECT e.id, 'DEVIATION', 'HI', 50.0, 30,
       '{cylinder}번 실린더 배기온도가 평균 대비 {deviation}℃ 편차 (연료분사밸브/배기밸브 점검 필요)'
FROM equipment e WHERE e.equip_type = 'MAIN_ENGINE';

INSERT INTO alarm_rule (equipment_id, rule_type, severity, deviation_limit, dwell_sec, message_template)
SELECT e.id, 'DEVIATION', 'HIHI', 80.0, 15,
       '{cylinder}번 실린더 배기온도 편차 {deviation}℃ — 즉시 확인 필요'
FROM equipment e WHERE e.equip_type = 'MAIN_ENGINE';

-- 2) 임계값 알람
INSERT INTO alarm_rule (tag_id, rule_type, severity, limit_value, dwell_sec, message_template)
SELECT t.id, 'THRESHOLD', r.sev, r.lim, r.dwell, r.msg
FROM tag t
JOIN (VALUES
    ('ME_LO_P',         'LO',   2.0,  5, '주기관 윤활유 압력 저하 ({value} bar)'),
    ('ME_LO_P',         'LOLO', 1.5,  2, '주기관 윤활유 압력 위험 ({value} bar) — 정지 검토'),
    ('ME_LO_T',         'HI',   60.0, 30, '주기관 윤활유 온도 상승 ({value}℃)'),
    ('ME_JCW_OUT_T',    'HI',   90.0, 30, '실린더냉각수 출구온도 상승 ({value}℃)'),
    ('ME_JCW_OUT_T',    'HIHI', 95.0, 10, '실린더냉각수 출구온도 위험 ({value}℃)'),
    ('ME_THRUST_BRG_T', 'HI',   75.0, 30, '추력베어링 온도 상승 ({value}℃)'),
    ('ME_THRUST_BRG_T', 'HIHI', 85.0, 10, '추력베어링 온도 위험 ({value}℃) — 축계 점검'),
    ('ME_VIB_RMS',      'HI',    7.1, 60, '주기관 진동 증가 ({value} mm/s, ISO 10816 Zone C)'),
    ('ME_SCAV_T',       'HI',   55.0, 60, '소기온도 상승 ({value}℃) — 소기냉각기 점검')
) AS r(code, sev, lim, dwell, msg) ON r.code = t.code;

-- 3) 변화율 알람 — 절대값보다 "갑자기 변하는 것"이 위험한 항목
--    rate_limit 의 부호가 감시 방향이다: 양수는 상승, 음수는 하강.
INSERT INTO alarm_rule (tag_id, rule_type, severity, rate_limit, rate_window_sec, dwell_sec, message_template)
SELECT t.id, 'RATE_OF_CHANGE', 'WARN', 5.0, 60, 0,
       '추력베어링 온도 급상승 (60초간 {value}℃ 상승)'
FROM tag t WHERE t.code = 'ME_THRUST_BRG_T';

INSERT INTO alarm_rule (tag_id, rule_type, severity, rate_limit, rate_window_sec, dwell_sec, message_template)
SELECT t.id, 'RATE_OF_CHANGE', 'WARN', -0.5, 60, 0,
       '윤활유 압력 급강하 (60초간 {value} bar 변화)'
FROM tag t WHERE t.code = 'ME_LO_P';

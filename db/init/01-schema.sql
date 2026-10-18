-- =====================================================================
-- VesselOps : 선박 기관 원격 상태감시 플랫폼 스키마
-- PostgreSQL 16 + TimescaleDB
-- =====================================================================
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ---------------------------------------------------------------------
-- 1. 선박 마스터
-- ---------------------------------------------------------------------
CREATE TABLE vessel (
    id            BIGSERIAL PRIMARY KEY,
    imo_no        VARCHAR(10)  NOT NULL UNIQUE,   -- IMO 선박식별번호 (국제 고유키)
    name          VARCHAR(100) NOT NULL,
    vessel_type   VARCHAR(30)  NOT NULL,          -- CONTAINER | BULK_CARRIER | LNG_CARRIER | TANKER | PCTC
    class_society VARCHAR(10),                    -- KR | DNV | LR | ABS | NK
    flag_state    VARCHAR(40),
    built_year    INT,
    dwt           INT,                            -- 재화중량톤수
    sister_group  VARCHAR(40),                    -- 동형선 그룹 (성능 비교 기준, FR-204)
    status        VARCHAR(15)  NOT NULL DEFAULT 'AT_SEA',
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT ck_vessel_status CHECK (status IN ('AT_SEA','IN_PORT','ANCHORED','DRYDOCK'))
);
CREATE INDEX idx_vessel_sister ON vessel (sister_group) WHERE sister_group IS NOT NULL;

-- ---------------------------------------------------------------------
-- 2. 사용자 / 권한
-- ---------------------------------------------------------------------
CREATE TABLE app_user (
    id            BIGSERIAL PRIMARY KEY,
    username      VARCHAR(50)  NOT NULL UNIQUE,
    password_hash VARCHAR(100) NOT NULL,
    display_name  VARCHAR(80)  NOT NULL,
    email         VARCHAR(120),
    role          VARCHAR(10)  NOT NULL,   -- ADMIN | SHORE | CREW
    vessel_id     BIGINT REFERENCES vessel(id),  -- CREW 전용: 소속 선박 (행 수준 제한, FR-503)
    enabled       BOOLEAN      NOT NULL DEFAULT TRUE,
    last_login_at TIMESTAMPTZ,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT ck_user_role CHECK (role IN ('ADMIN','SHORE','CREW')),
    -- CREW 는 반드시 소속 선박이 있어야 하고, 그 외 역할은 선박에 묶이지 않는다
    CONSTRAINT ck_user_vessel CHECK (
        (role = 'CREW' AND vessel_id IS NOT NULL) OR
        (role <> 'CREW' AND vessel_id IS NULL)
    )
);

-- ---------------------------------------------------------------------
-- 3. 기관 / 장비
-- ---------------------------------------------------------------------
CREATE TABLE equipment (
    id             BIGSERIAL PRIMARY KEY,
    vessel_id      BIGINT       NOT NULL REFERENCES vessel(id) ON DELETE CASCADE,
    code           VARCHAR(20)  NOT NULL,   -- ME | DG1 | DG2 | DG3 | TC1 | SHAFT
    name           VARCHAR(100) NOT NULL,
    equip_type     VARCHAR(20)  NOT NULL,
    maker          VARCHAR(60),
    model          VARCHAR(60),             -- 예: 7S60ME-C10.5
    rated_power_kw NUMERIC(10,2),
    rated_rpm      NUMERIC(8,2),
    cylinder_count INT,                     -- 실린더 수 (편차 계산의 분모)
    running_hours  NUMERIC(10,1) DEFAULT 0, -- 누적 운전시간
    installed_on   DATE,
    CONSTRAINT uq_equipment UNIQUE (vessel_id, code),
    CONSTRAINT ck_equip_type CHECK (equip_type IN
        ('MAIN_ENGINE','GEN_ENGINE','TURBOCHARGER','SHAFTING','BOILER'))
);
CREATE INDEX idx_equipment_vessel ON equipment (vessel_id);

-- ---------------------------------------------------------------------
-- 4. 계측점(Tag) 정의
-- ---------------------------------------------------------------------
CREATE TABLE tag (
    id           BIGSERIAL PRIMARY KEY,
    equipment_id BIGINT       NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
    code         VARCHAR(60)  NOT NULL,     -- 예: ME_EXH_T_CYL03
    name         VARCHAR(120) NOT NULL,
    unit         VARCHAR(20),               -- degC | bar | rpm | kW | kg/h | mm/s
    data_type    VARCHAR(10)  NOT NULL DEFAULT 'FLOAT',
    -- 실린더별 태그면 실린더 번호, 공통 태그면 NULL.
    -- 편차 알람(FR-302)이 태그명 문자열 파싱이 아니라 이 컬럼으로 그룹핑한다.
    cylinder_no  INT,
    normal_min   DOUBLE PRECISION,
    normal_max   DOUBLE PRECISION,
    scan_ms      INT          NOT NULL DEFAULT 1000,
    enabled      BOOLEAN      NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_tag UNIQUE (equipment_id, code)
);
CREATE INDEX idx_tag_equipment ON tag (equipment_id);
CREATE INDEX idx_tag_cylinder  ON tag (equipment_id, cylinder_no) WHERE cylinder_no IS NOT NULL;

-- ---------------------------------------------------------------------
-- 5. 텔레메트리 (시계열 / Hypertable)
-- ---------------------------------------------------------------------
CREATE TABLE telemetry (
    ts      TIMESTAMPTZ      NOT NULL,
    tag_id  BIGINT           NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
    value   DOUBLE PRECISION,
    quality SMALLINT         NOT NULL DEFAULT 192   -- OPC UA 품질코드: 192 = Good
);

-- 1일 단위 청크
SELECT create_hypertable('telemetry', 'ts', chunk_time_interval => INTERVAL '1 day');

-- 재전송 중복 차단(FR-106). 파티셔닝 컬럼(ts)이 반드시 포함돼야 한다.
CREATE UNIQUE INDEX uq_telemetry ON telemetry (tag_id, ts DESC);

-- 압축: 7일 지난 청크는 tag_id 기준으로 묶어 압축
ALTER TABLE telemetry SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'tag_id',
    timescaledb.compress_orderby   = 'ts DESC'
);
SELECT add_compression_policy('telemetry', INTERVAL '7 days');

-- 보존정책: 원본 30일 (NFR-04)
SELECT add_retention_policy('telemetry', INTERVAL '30 days');

-- ---------------------------------------------------------------------
-- 5-1. 연속 집계 (다운샘플링) — 24시간 트렌드 조회 500ms 목표(NFR-03)
-- ---------------------------------------------------------------------
CREATE MATERIALIZED VIEW telemetry_1m
WITH (timescaledb.continuous) AS
SELECT tag_id,
       time_bucket(INTERVAL '1 minute', ts) AS bucket,
       avg(value) AS avg_value,
       min(value) AS min_value,
       max(value) AS max_value,
       count(*)   AS sample_count
FROM telemetry
GROUP BY tag_id, bucket
WITH NO DATA;

SELECT add_continuous_aggregate_policy('telemetry_1m',
    start_offset      => INTERVAL '3 hours',
    end_offset        => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute');
SELECT add_retention_policy('telemetry_1m', INTERVAL '1 year');

CREATE MATERIALIZED VIEW telemetry_1h
WITH (timescaledb.continuous) AS
SELECT tag_id,
       time_bucket(INTERVAL '1 hour', ts) AS bucket,
       avg(value) AS avg_value,
       min(value) AS min_value,
       max(value) AS max_value,
       count(*)   AS sample_count
FROM telemetry
GROUP BY tag_id, bucket
WITH NO DATA;

SELECT add_continuous_aggregate_policy('telemetry_1h',
    start_offset      => INTERVAL '3 days',
    end_offset        => INTERVAL '1 hour',
    schedule_interval => INTERVAL '10 minutes');
SELECT add_retention_policy('telemetry_1h', INTERVAL '5 years');

-- ---------------------------------------------------------------------
-- 5-1b. 계측 요약 (적응형 전송 FR-108 수신분)
--
--   요약 모드에서는 원본이 육상에 오지 않으므로 연속집계(telemetry_1m)의
--   재료 자체가 없다. Edge 가 본선에서 산출해 보낸 통계를 여기에 적재한다.
--   원본이 있는 구간은 telemetry_1m, 없는 구간은 이 테이블을 사용한다(병합 조회).
-- ---------------------------------------------------------------------
CREATE TABLE telemetry_summary (
    bucket       TIMESTAMPTZ      NOT NULL,   -- 집계 구간 시작 시각
    tag_id       BIGINT           NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
    period_sec   INT              NOT NULL DEFAULT 60,
    avg_value    DOUBLE PRECISION,
    min_value    DOUBLE PRECISION,
    max_value    DOUBLE PRECISION,
    sd_value     DOUBLE PRECISION,
    sample_count INT              NOT NULL DEFAULT 0,
    quality      SMALLINT         NOT NULL DEFAULT 192   -- 구간 내 최악 품질
);

-- 원본의 1/60 건수라 청크를 크게 잡는다
SELECT create_hypertable('telemetry_summary', 'bucket', chunk_time_interval => INTERVAL '7 days');
CREATE UNIQUE INDEX uq_telemetry_summary ON telemetry_summary (tag_id, bucket DESC);
SELECT add_retention_policy('telemetry_summary', INTERVAL '1 year');

-- ---------------------------------------------------------------------
-- 5-1c. 전송 모드 전환 이력 (FR-108, NFR-08/NFR-11 측정 근거)
--
--   occurred_at : Edge 가 전환을 판정한 시각
--   received_at : 육상이 그 사실을 수신한 시각
--   두 시각과 첫 RAW 데이터 적재 시각의 차이로 성능 지표를 측정한다.
--   측정할 수 없는 지표는 요구사항이 아니라 희망사항이므로 기록 테이블을 둔다.
-- ---------------------------------------------------------------------
CREATE TABLE edge_mode_event (
    id             BIGSERIAL PRIMARY KEY,
    vessel_id      BIGINT      NOT NULL REFERENCES vessel(id) ON DELETE CASCADE,
    mode           VARCHAR(10) NOT NULL,   -- SUMMARY | RAW
    reason         VARCHAR(40),            -- THRESHOLD_NEAR | DEVIATION | RATE | QUALITY | MANUAL | RECOVERED
    trigger_tag_id BIGINT      REFERENCES tag(id) ON DELETE SET NULL,
    occurred_at    TIMESTAMPTZ NOT NULL,
    received_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_edge_mode CHECK (mode IN ('SUMMARY','RAW'))
);
CREATE INDEX idx_edge_mode_vessel ON edge_mode_event (vessel_id, occurred_at DESC);

-- ---------------------------------------------------------------------
-- 5-2. 불량 데이터 격리 (FR-102)
--      스키마 검증 실패분을 버리지 않고 보관 — 본선 Edge 설정오류 추적용
-- ---------------------------------------------------------------------
CREATE TABLE telemetry_rejected (
    id          BIGSERIAL PRIMARY KEY,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    topic       VARCHAR(200),
    payload     JSONB,
    reason      VARCHAR(200) NOT NULL
);
CREATE INDEX idx_rejected_at ON telemetry_rejected (received_at DESC);

-- ---------------------------------------------------------------------
-- 6. 알람
-- ---------------------------------------------------------------------
CREATE TABLE alarm_rule (
    id               BIGSERIAL PRIMARY KEY,
    -- THRESHOLD / RATE_OF_CHANGE 는 태그 단위, DEVIATION 은 장비 단위로 건다
    tag_id           BIGINT REFERENCES tag(id) ON DELETE CASCADE,
    equipment_id     BIGINT REFERENCES equipment(id) ON DELETE CASCADE,
    rule_type        VARCHAR(20) NOT NULL,
    severity         VARCHAR(10) NOT NULL,
    limit_value      DOUBLE PRECISION,       -- THRESHOLD 용
    deviation_limit  DOUBLE PRECISION,       -- DEVIATION 용: 전 실린더 평균 대비 허용 편차
    rate_limit       DOUBLE PRECISION,       -- RATE_OF_CHANGE 용: 단위시간당 변화량
    rate_window_sec  INT,
    dwell_sec        INT NOT NULL DEFAULT 5, -- 채터링 방지(FR-304): 이 시간 이상 지속돼야 확정
    message_template TEXT,
    enabled          BOOLEAN NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_rule_type CHECK (rule_type IN ('THRESHOLD','DEVIATION','RATE_OF_CHANGE')),
    CONSTRAINT ck_rule_sev  CHECK (severity  IN ('HIHI','HI','LO','LOLO','WARN')),
    -- 룰 종류별로 필요한 대상과 파라미터가 채워져 있는지 DB가 보장
    CONSTRAINT ck_rule_target CHECK (
        (rule_type = 'DEVIATION'      AND equipment_id IS NOT NULL AND deviation_limit IS NOT NULL) OR
        (rule_type = 'THRESHOLD'      AND tag_id IS NOT NULL AND limit_value IS NOT NULL) OR
        (rule_type = 'RATE_OF_CHANGE' AND tag_id IS NOT NULL AND rate_limit IS NOT NULL)
    )
);
CREATE INDEX idx_rule_tag   ON alarm_rule (tag_id)       WHERE enabled;
CREATE INDEX idx_rule_equip ON alarm_rule (equipment_id) WHERE enabled;

CREATE TABLE alarm_event (
    id            BIGSERIAL PRIMARY KEY,
    rule_id       BIGINT      REFERENCES alarm_rule(id) ON DELETE SET NULL,
    vessel_id     BIGINT      NOT NULL REFERENCES vessel(id) ON DELETE CASCADE,
    equipment_id  BIGINT      REFERENCES equipment(id) ON DELETE SET NULL,
    tag_id        BIGINT      REFERENCES tag(id) ON DELETE SET NULL,
    severity      VARCHAR(10) NOT NULL,
    message       TEXT        NOT NULL,
    trigger_value DOUBLE PRECISION,
    raised_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    cleared_at    TIMESTAMPTZ,
    ack_by        BIGINT      REFERENCES app_user(id) ON DELETE SET NULL,
    ack_at        TIMESTAMPTZ,
    state         VARCHAR(10) NOT NULL DEFAULT 'ACTIVE',
    CONSTRAINT ck_alarm_state CHECK (state IN ('ACTIVE','ACKED','CLEARED'))
);
CREATE INDEX idx_alarm_vessel ON alarm_event (vessel_id, raised_at DESC);
CREATE INDEX idx_alarm_active ON alarm_event (state, raised_at DESC) WHERE state <> 'CLEARED';

-- 동일 룰이 해제되기 전에 중복 발생하지 않도록 (활성 알람은 룰당 1건)
CREATE UNIQUE INDEX uq_alarm_open ON alarm_event (rule_id) WHERE state <> 'CLEARED';

-- ---------------------------------------------------------------------
-- 7. 갱신시각 자동 관리
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $fn$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

CREATE TRIGGER trg_vessel_updated BEFORE UPDATE ON vessel
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

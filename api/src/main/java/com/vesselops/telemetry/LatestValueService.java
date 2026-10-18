package com.vesselops.telemetry;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.List;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * 전 계측점의 최신값 스냅샷.
 *
 * 알람 엔진(1초 주기)과 조회 API 가 같은 스냅샷을 쓴다. 짧게 캐시해 화면 접속자가 늘어도
 * DB 질의 수가 따라 늘지 않게 한다.
 */
@Service
public class LatestValueService {

    private static final long CACHE_MS = 800;

    // 원본(telemetry)이 있으면 원본을, 요약 모드 구간이면 1분 요약의 평균을 최신값으로 쓴다.
    private static final String SQL = """
            SELECT t.id AS tag_id, v.id AS vessel_id, v.imo_no, e.id AS equipment_id, e.code AS eq, e.equip_type,
                   t.code, t.name, t.unit, t.cylinder_no, t.normal_min, t.normal_max,
                   l.ts, l.value, l.quality
              FROM tag t
              JOIN equipment e ON e.id = t.equipment_id
              JOIN vessel v ON v.id = e.vessel_id
              LEFT JOIN LATERAL (
                    SELECT u.ts, u.value, u.quality
                      FROM (
                            (SELECT m.ts, m.value, m.quality
                               FROM telemetry m
                              WHERE m.tag_id = t.id AND m.ts > now() - INTERVAL '10 minutes'
                              ORDER BY m.ts DESC LIMIT 1)
                            UNION ALL
                            (SELECT s.bucket + make_interval(secs => s.period_sec) AS ts, s.avg_value, s.quality
                               FROM telemetry_summary s
                              WHERE s.tag_id = t.id AND s.bucket > now() - INTERVAL '10 minutes'
                              ORDER BY s.bucket DESC LIMIT 1)
                           ) u
                     ORDER BY u.ts DESC LIMIT 1
                   ) l ON TRUE
             WHERE t.enabled
             ORDER BY v.id, e.id, t.cylinder_no NULLS LAST, t.id
            """;

    private final JdbcClient jdbc;
    private volatile List<LatestValue> cache = List.of();
    private volatile long cachedAt;

    public LatestValueService(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public List<LatestValue> snapshot() {
        long now = System.currentTimeMillis();
        if (now - cachedAt < CACHE_MS) {
            return cache;
        }
        synchronized (this) {
            if (System.currentTimeMillis() - cachedAt < CACHE_MS) {
                return cache;
            }
            cache = jdbc.sql(SQL).query((rs, i) -> {
                OffsetDateTime ts = rs.getObject("ts", OffsetDateTime.class);
                return new LatestValue(
                        rs.getLong("tag_id"),
                        rs.getLong("vessel_id"),
                        rs.getString("imo_no"),
                        rs.getLong("equipment_id"),
                        rs.getString("eq"),
                        rs.getString("equip_type"),
                        rs.getString("code"),
                        rs.getString("name"),
                        rs.getString("unit"),
                        rs.getObject("cylinder_no", Integer.class),
                        rs.getObject("normal_min", Double.class),
                        rs.getObject("normal_max", Double.class),
                        ts == null ? null : ts.toInstant(),
                        rs.getObject("value", Double.class),
                        rs.getObject("quality", Integer.class));
            }).list();
            cachedAt = System.currentTimeMillis();
            return cache;
        }
    }

    public List<LatestValue> forVessel(String imo) {
        return snapshot().stream().filter(v -> v.imo().equals(imo)).toList();
    }

    public Instant lastSeen(List<LatestValue> values) {
        return values.stream().map(LatestValue::ts).filter(t -> t != null).max(Instant::compareTo).orElse(null);
    }
}

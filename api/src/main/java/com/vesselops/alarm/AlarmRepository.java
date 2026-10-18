package com.vesselops.alarm;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
public class AlarmRepository {

    public record AlarmView(
            long id,
            String imo,
            String vesselName,
            String equipment,
            String tag,
            String tagName,
            String ruleType,
            String severity,
            String message,
            Double triggerValue,
            Instant raisedAt,
            Instant clearedAt,
            Instant ackAt,
            String state) {
    }

    private static final String VIEW_SQL = """
            SELECT a.id, v.imo_no, v.name AS vessel_name, e.code AS eq, t.code AS tag, t.name AS tag_name,
                   r.rule_type, a.severity, a.message, a.trigger_value,
                   a.raised_at, a.cleared_at, a.ack_at, a.state
              FROM alarm_event a
              JOIN vessel v ON v.id = a.vessel_id
              LEFT JOIN equipment e ON e.id = a.equipment_id
              LEFT JOIN tag t ON t.id = a.tag_id
              LEFT JOIN alarm_rule r ON r.id = a.rule_id
            """;

    private final JdbcClient jdbc;

    public AlarmRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public List<AlarmRule> findEnabledRules() {
        return jdbc.sql("""
                SELECT r.id, r.tag_id, e.id AS equipment_id, e.vessel_id, e.equip_type, r.rule_type, r.severity,
                       r.limit_value, r.deviation_limit, r.rate_limit, r.rate_window_sec, r.dwell_sec,
                       r.message_template
                  FROM alarm_rule r
                  LEFT JOIN tag t ON t.id = r.tag_id
                  JOIN equipment e ON e.id = COALESCE(r.equipment_id, t.equipment_id)
                 WHERE r.enabled
                 ORDER BY r.id
                """)
                .query((rs, i) -> new AlarmRule(
                        rs.getLong("id"),
                        rs.getObject("tag_id", Long.class),
                        rs.getLong("equipment_id"),
                        rs.getLong("vessel_id"),
                        rs.getString("equip_type"),
                        rs.getString("rule_type"),
                        rs.getString("severity"),
                        rs.getObject("limit_value", Double.class),
                        rs.getObject("deviation_limit", Double.class),
                        rs.getObject("rate_limit", Double.class),
                        rs.getObject("rate_window_sec", Integer.class),
                        rs.getInt("dwell_sec"),
                        rs.getString("message_template")))
                .list();
    }

    /** 해제되지 않은 알람: rule_id → alarm_event.id */
    public Map<Long, Long> findOpenByRule() {
        Map<Long, Long> open = new HashMap<>();
        jdbc.sql("SELECT rule_id, id FROM alarm_event WHERE state <> 'CLEARED' AND rule_id IS NOT NULL")
                .query((rs, i) -> open.put(rs.getLong("rule_id"), rs.getLong("id")))
                .list();
        return open;
    }

    /**
     * 알람 발생. 룰당 미해제 알람은 1건만 허용하는 부분 유니크 인덱스에 걸리면 넣지 않는다.
     * API 를 여러 대 띄워도 같은 알람이 중복 발생하지 않는다.
     */
    public Optional<Long> raise(AlarmRule rule, Long tagId, String message, Double triggerValue) {
        return jdbc.sql("""
                INSERT INTO alarm_event (rule_id, vessel_id, equipment_id, tag_id, severity, message, trigger_value)
                VALUES (:ruleId, :vesselId, :equipmentId, :tagId, :severity, :message, :value)
                ON CONFLICT (rule_id) WHERE state <> 'CLEARED' DO NOTHING
                RETURNING id
                """)
                .param("ruleId", rule.id())
                .param("vesselId", rule.vesselId())
                .param("equipmentId", rule.equipmentId())
                .param("tagId", tagId)
                .param("severity", rule.severity())
                .param("message", message)
                .param("value", triggerValue)
                .query(Long.class)
                .optional();
    }

    public void clear(long alarmId) {
        jdbc.sql("UPDATE alarm_event SET state = 'CLEARED', cleared_at = now() WHERE id = :id AND state <> 'CLEARED'")
                .param("id", alarmId)
                .update();
    }

    /** @return 확인 처리된 행 수. 0 이면 이미 확인됐거나 해제된 알람이다. */
    public int acknowledge(long alarmId) {
        return jdbc.sql("UPDATE alarm_event SET state = 'ACKED', ack_at = now() WHERE id = :id AND state = 'ACTIVE'")
                .param("id", alarmId)
                .update();
    }

    public Optional<AlarmView> findById(long id) {
        return jdbc.sql(VIEW_SQL + " WHERE a.id = :id").param("id", id).query(this::mapView).optional();
    }

    public List<AlarmView> search(String imo, String state, int page, int size) {
        return jdbc.sql(VIEW_SQL + where(state) + " ORDER BY a.raised_at DESC LIMIT :size OFFSET :offset")
                .param("imo", imo)
                .param("size", size)
                .param("offset", (long) page * size)
                .query(this::mapView)
                .list();
    }

    public long count(String imo, String state) {
        return jdbc.sql("SELECT count(*) FROM alarm_event a JOIN vessel v ON v.id = a.vessel_id" + where(state))
                .param("imo", imo)
                .query(Long.class)
                .single();
    }

    /** 선박별 미해제 알람 수와 가장 높은 등급 */
    public Map<String, OpenSummary> openSummaryByImo() {
        Map<String, OpenSummary> out = new HashMap<>();
        jdbc.sql("""
                SELECT v.imo_no, count(*) AS cnt,
                       min(CASE a.severity WHEN 'HIHI' THEN 1 WHEN 'LOLO' THEN 1
                                           WHEN 'HI' THEN 2 WHEN 'LO' THEN 2 ELSE 3 END) AS rank
                  FROM alarm_event a JOIN vessel v ON v.id = a.vessel_id
                 WHERE a.state <> 'CLEARED'
                 GROUP BY v.imo_no
                """)
                .query((rs, i) -> out.put(rs.getString("imo_no"),
                        new OpenSummary(rs.getInt("cnt"), switch (rs.getInt("rank")) {
                            case 1 -> "CRITICAL";
                            case 2 -> "ALARM";
                            default -> "WARN";
                        })))
                .list();
        return out;
    }

    public record OpenSummary(int count, String level) {
    }

    // state: OPEN(미해제) | ACTIVE | ACKED | CLEARED | null(전체). 값은 컨트롤러에서 검증한다.
    private String where(String state) {
        String sql = " WHERE (CAST(:imo AS varchar) IS NULL OR v.imo_no = :imo)";
        if ("OPEN".equals(state)) {
            sql += " AND a.state <> 'CLEARED'";
        } else if (state != null) {
            sql += " AND a.state = '" + state + "'";
        }
        return sql;
    }

    private AlarmView mapView(java.sql.ResultSet rs, int i) throws java.sql.SQLException {
        return new AlarmView(
                rs.getLong("id"),
                rs.getString("imo_no"),
                rs.getString("vessel_name"),
                rs.getString("eq"),
                rs.getString("tag"),
                rs.getString("tag_name"),
                rs.getString("rule_type"),
                rs.getString("severity"),
                rs.getString("message"),
                rs.getObject("trigger_value", Double.class),
                instant(rs, "raised_at"),
                instant(rs, "cleared_at"),
                instant(rs, "ack_at"),
                rs.getString("state"));
    }

    private static Instant instant(java.sql.ResultSet rs, String column) throws java.sql.SQLException {
        OffsetDateTime t = rs.getObject(column, OffsetDateTime.class);
        return t == null ? null : t.toInstant();
    }
}

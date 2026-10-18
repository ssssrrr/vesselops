package com.vesselops.vessel;

import com.vesselops.alarm.AlarmRepository;
import com.vesselops.alarm.AlarmRepository.OpenSummary;
import com.vesselops.common.ApiException;
import com.vesselops.diagnosis.CylinderDeviation;
import com.vesselops.telemetry.LatestValue;
import com.vesselops.telemetry.LatestValueService;
import com.vesselops.vessel.VesselDtos.CylinderDeviationView;
import com.vesselops.vessel.VesselDtos.CylinderStatus;
import com.vesselops.vessel.VesselDtos.EquipmentValues;
import com.vesselops.vessel.VesselDtos.TagValue;
import com.vesselops.vessel.VesselDtos.Trend;
import com.vesselops.vessel.VesselDtos.TrendSeries;
import com.vesselops.vessel.VesselDtos.VesselDetail;
import com.vesselops.vessel.VesselDtos.VesselSummary;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

@Service
public class VesselService {

    private static final int TREND_MAX_POINTS = 240;

    private record VesselRow(String imo, String name, String vesselType, String classSociety, String status,
                             String sisterGroup, String engineModel, Integer cylinderCount) {
    }

    private final JdbcClient jdbc;
    private final LatestValueService latest;
    private final AlarmRepository alarms;
    private final Duration onlineTimeout;
    private final Duration freshness;
    private final double engineRunningRpm;

    public VesselService(
            JdbcClient jdbc,
            LatestValueService latest,
            AlarmRepository alarms,
            @Value("${vesselops.online.timeout-seconds}") long onlineTimeoutSeconds,
            @Value("${vesselops.alarm.fresh-seconds}") long freshSeconds,
            @Value("${vesselops.alarm.engine-running-rpm}") double engineRunningRpm) {
        this.jdbc = jdbc;
        this.latest = latest;
        this.alarms = alarms;
        this.onlineTimeout = Duration.ofSeconds(onlineTimeoutSeconds);
        this.freshness = Duration.ofSeconds(freshSeconds);
        this.engineRunningRpm = engineRunningRpm;
    }

    public List<VesselSummary> list() {
        Map<String, List<LatestValue>> byImo = latest.snapshot().stream()
                .collect(Collectors.groupingBy(LatestValue::imo));
        Map<String, OpenSummary> openAlarms = alarms.openSummaryByImo();
        return vesselRows(null).stream()
                .map(row -> summarize(row, byImo.getOrDefault(row.imo(), List.of()), openAlarms.get(row.imo())))
                .toList();
    }

    public VesselDetail detail(String imo) {
        VesselRow row = requireVessel(imo);
        List<LatestValue> values = latest.forVessel(imo);
        Map<String, List<LatestValue>> byEquipment = values.stream()
                .collect(Collectors.groupingBy(LatestValue::equipment, LinkedHashMap::new, Collectors.toList()));
        List<EquipmentValues> equipment = byEquipment.entrySet().stream()
                .map(e -> new EquipmentValues(
                        e.getKey(),
                        e.getValue().get(0).equipType(),
                        e.getValue().stream()
                                .map(v -> new TagValue(v.code(), v.name(), v.unit(), v.cylinderNo(),
                                        v.normalMin(), v.normalMax(), v.value(), v.quality(), v.ts()))
                                .toList()))
                .toList();
        return new VesselDetail(summarize(row, values, alarms.openSummaryByImo().get(imo)), equipment);
    }

    public CylinderDeviationView cylinderDeviation(String imo) {
        requireVessel(imo);
        Instant now = Instant.now();
        List<LatestValue> values = latest.forVessel(imo);
        Double rpm = value(values, "ME_RPM");
        boolean running = rpm != null && rpm >= engineRunningRpm;

        List<CylinderDeviation.Reading> readings = values.stream()
                .filter(v -> v.cylinderNo() != null && v.usable(now, freshness))
                .map(v -> new CylinderDeviation.Reading(v.cylinderNo(), v.tagId(), v.code(), v.value()))
                .toList();
        CylinderDeviation.Result result = CylinderDeviation.analyze(readings);

        // 화면의 경고선은 DB 에 등록된 룰 값을 그대로 쓴다. 화면과 알람 기준이 어긋나지 않게 한다.
        Map<String, Double> limits = new LinkedHashMap<>();
        jdbc.sql("""
                SELECT r.severity, r.deviation_limit
                  FROM alarm_rule r
                  JOIN equipment e ON e.id = r.equipment_id
                  JOIN vessel v ON v.id = e.vessel_id
                 WHERE v.imo_no = :imo AND r.rule_type = 'DEVIATION' AND r.enabled
                """)
                .param("imo", imo)
                .query((rs, i) -> limits.put(rs.getString("severity"), rs.getDouble("deviation_limit")))
                .list();
        Double hi = limits.get("HI");
        Double hihi = limits.get("HIHI");

        if (result == null) {
            return new CylinderDeviationView(imo, running, null, null, hi, hihi, latest.lastSeen(values), List.of());
        }
        List<CylinderStatus> cylinders = result.cylinders().stream()
                .map(c -> new CylinderStatus(c.no(), c.tag(), round(c.value()), round(c.deviation()),
                        level(running, Math.abs(c.deviation()), hi, hihi)))
                .toList();
        return new CylinderDeviationView(imo, running, round(result.mean()), round(result.maxAbsDeviation()), hi, hihi,
                latest.lastSeen(values), cylinders);
    }

    public Trend trend(String imo, List<String> tags, int minutes) {
        requireVessel(imo);
        if (tags.isEmpty() || tags.size() > 12) {
            throw ApiException.badRequest("TAGS_INVALID", "tags 는 1~12개를 지정합니다.");
        }
        if (minutes < 1 || minutes > 24 * 60) {
            throw ApiException.badRequest("RANGE_INVALID", "minutes 는 1~1440 입니다.");
        }
        // 기간이 길어져도 응답 크기가 일정하도록 구간 폭을 기간에 맞춘다
        int bucketSec = Math.max(1, minutes * 60 / TREND_MAX_POINTS);
        Instant to = Instant.now();
        Instant from = to.minus(Duration.ofMinutes(minutes));

        Map<String, TrendSeries> series = new LinkedHashMap<>();
        jdbc.sql("""
                SELECT t.code, t.name, t.unit,
                       extract(epoch FROM time_bucket(make_interval(secs => :bucket), m.ts)) * 1000 AS bucket_ms,
                       avg(m.value) AS value
                  FROM telemetry m
                  JOIN tag t ON t.id = m.tag_id
                  JOIN equipment e ON e.id = t.equipment_id
                  JOIN vessel v ON v.id = e.vessel_id
                 WHERE v.imo_no = :imo
                   AND t.code IN (:tags)
                   AND m.ts > now() - make_interval(mins => :minutes)
                   AND m.value IS NOT NULL
                   AND m.quality = 192
                 GROUP BY t.code, t.name, t.unit, bucket_ms
                 ORDER BY bucket_ms
                """)
                .param("bucket", bucketSec)
                .param("imo", imo)
                .param("tags", tags)
                .param("minutes", minutes)
                .query((rs, i) -> {
                    TrendSeries s = series.computeIfAbsent(rs.getString("code"),
                            code -> newSeries(code, rs));
                    s.points().add(new double[] {rs.getDouble("bucket_ms"), round(rs.getDouble("value"))});
                    return s;
                })
                .list();

        // 요청한 순서대로 돌려준다
        List<TrendSeries> ordered = tags.stream().map(series::get).filter(s -> s != null).toList();
        return new Trend(imo, from, to, bucketSec, ordered);
    }

    // ------------------------------------------------------------------

    private VesselSummary summarize(VesselRow row, List<LatestValue> values, OpenSummary open) {
        Instant now = Instant.now();
        Instant lastSeen = latest.lastSeen(values);
        boolean online = lastSeen != null && lastSeen.isAfter(now.minus(onlineTimeout));

        List<CylinderDeviation.Reading> readings = values.stream()
                .filter(v -> v.cylinderNo() != null && v.usable(now, freshness))
                .map(v -> new CylinderDeviation.Reading(v.cylinderNo(), v.tagId(), v.code(), v.value()))
                .toList();
        Double rpm = value(values, "ME_RPM");
        CylinderDeviation.Result deviation =
                rpm != null && rpm >= engineRunningRpm ? CylinderDeviation.analyze(readings) : null;

        return new VesselSummary(
                row.imo(), row.name(), row.vesselType(), row.classSociety(), row.status(), row.sisterGroup(),
                row.engineModel(), row.cylinderCount(),
                online, lastSeen,
                value(values, "ME_LOAD"), rpm, value(values, "ME_FO_FLOW"), value(values, "SHAFT_POWER"),
                deviation == null ? null : round(deviation.maxAbsDeviation()),
                open == null ? 0 : open.count(),
                open == null ? "NORMAL" : open.level());
    }

    private List<VesselRow> vesselRows(String imo) {
        return jdbc.sql("""
                SELECT v.imo_no, v.name, v.vessel_type, v.class_society, v.status, v.sister_group,
                       e.model, e.cylinder_count
                  FROM vessel v
                  LEFT JOIN equipment e ON e.vessel_id = v.id AND e.equip_type = 'MAIN_ENGINE'
                 WHERE CAST(:imo AS varchar) IS NULL OR v.imo_no = :imo
                 ORDER BY v.id
                """)
                .param("imo", imo)
                .query((rs, i) -> new VesselRow(
                        rs.getString("imo_no"), rs.getString("name"), rs.getString("vessel_type"),
                        rs.getString("class_society"), rs.getString("status"), rs.getString("sister_group"),
                        rs.getString("model"), rs.getObject("cylinder_count", Integer.class)))
                .list();
    }

    private VesselRow requireVessel(String imo) {
        return vesselRows(imo).stream().findFirst()
                .orElseThrow(() -> ApiException.notFound("VESSEL_NOT_FOUND", "선박을 찾을 수 없습니다."));
    }

    private static Double value(List<LatestValue> values, String code) {
        return values.stream().filter(v -> v.code().equals(code)).map(LatestValue::value)
                .filter(v -> v != null).findFirst().orElse(null);
    }

    private static String level(boolean running, double absDeviation, Double hi, Double hihi) {
        if (!running) {
            return "STOPPED";
        }
        if (hihi != null && absDeviation >= hihi) {
            return "CRITICAL";
        }
        if (hi != null && absDeviation >= hi) {
            return "ALARM";
        }
        // 알람 기준의 60% 부터 주의 — Edge 가 고해상도 전송으로 전환하는 기준과 같다
        if (hi != null && absDeviation >= hi * 0.6) {
            return "WARN";
        }
        return "NORMAL";
    }

    private static TrendSeries newSeries(String code, java.sql.ResultSet rs) {
        try {
            return new TrendSeries(code, rs.getString("name"), rs.getString("unit"), new ArrayList<>());
        } catch (java.sql.SQLException e) {
            throw new IllegalStateException(e);
        }
    }

    private static double round(double v) {
        return Math.round(v * 100) / 100.0;
    }
}

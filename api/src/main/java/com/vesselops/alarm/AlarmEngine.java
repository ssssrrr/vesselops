package com.vesselops.alarm;

import com.vesselops.diagnosis.CylinderDeviation;
import com.vesselops.telemetry.LatestValue;
import com.vesselops.telemetry.LatestValueService;
import jakarta.annotation.PostConstruct;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.stream.Collectors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * 알람 룰 엔진 (FR-301 ~ FR-304).
 *
 * 1초마다 최신값 스냅샷을 룰에 대어 본다. 룰은 세 종류다.
 *   THRESHOLD       절대 임계값 초과/미달
 *   DEVIATION       실린더 간 배기온도 편차 — 절대값이 정상이어도 잡는 조기 진단
 *   RATE_OF_CHANGE  단위시간당 변화량 — 값보다 "갑자기 변하는 것"이 위험한 항목
 *
 * 조건이 dwell 시간 이상 지속돼야 발생시키고, 해소도 일정 시간 지속돼야 해제한다.
 * 경계값에서 값이 흔들릴 때 알람이 켜졌다 꺼졌다 하는 채터링을 막기 위해서다.
 */
@Component
public class AlarmEngine {

    private static final Logger log = LoggerFactory.getLogger(AlarmEngine.class);
    private static final Duration RULE_CACHE = Duration.ofSeconds(60);

    private final AlarmRepository alarms;
    private final LatestValueService latest;
    private final JdbcClient jdbc;
    private final Duration freshness;
    private final Duration clearHold;
    private final double engineRunningRpm;

    private List<AlarmRule> rules = List.of();
    private Instant rulesLoadedAt = Instant.EPOCH;

    private final Map<Long, Instant> pendingSince = new HashMap<>();   // ruleId → 조건 성립 시작
    private final Map<Long, Instant> normalSince = new HashMap<>();    // ruleId → 조건 해소 시작
    private final Map<Long, Long> open = new HashMap<>();              // ruleId → 미해제 알람 id

    /** 룰 1건의 판정 결과. active=false 면 정상. */
    record Evaluation(boolean active, Long tagId, Double value, String message) {

        static Evaluation normal() {
            return new Evaluation(false, null, null, null);
        }
    }

    public AlarmEngine(
            AlarmRepository alarms,
            LatestValueService latest,
            JdbcClient jdbc,
            @Value("${vesselops.alarm.fresh-seconds}") long freshSeconds,
            @Value("${vesselops.alarm.clear-hold-seconds}") long clearHoldSeconds,
            @Value("${vesselops.alarm.engine-running-rpm}") double engineRunningRpm) {
        this.alarms = alarms;
        this.latest = latest;
        this.jdbc = jdbc;
        this.freshness = Duration.ofSeconds(freshSeconds);
        this.clearHold = Duration.ofSeconds(clearHoldSeconds);
        this.engineRunningRpm = engineRunningRpm;
    }

    /** 재기동해도 열려 있던 알람을 이어받는다. 그러지 않으면 재기동 때마다 해제가 누락된다. */
    @PostConstruct
    void restoreOpenAlarms() {
        try {
            open.putAll(alarms.findOpenByRule());
            log.info("미해제 알람 {}건 복원", open.size());
        } catch (Exception e) {
            log.warn("미해제 알람 복원 실패 — 다음 평가에서 재시도: {}", e.getMessage());
        }
    }

    @Scheduled(fixedDelayString = "${vesselops.alarm.interval-ms}")
    public void evaluateAll() {
        try {
            Instant now = Instant.now();
            if (Duration.between(rulesLoadedAt, now).compareTo(RULE_CACHE) > 0) {
                rules = alarms.findEnabledRules();
                rulesLoadedAt = now;
            }
            // 품질 Good 이고 최근인 값만 판정에 쓴다. 품질 불량 값으로 오경보를 내지 않는다.
            Map<Long, LatestValue> usable = latest.snapshot().stream()
                    .filter(v -> v.usable(now, freshness))
                    .collect(Collectors.toMap(LatestValue::tagId, v -> v));
            Map<Long, List<LatestValue>> byEquipment = usable.values().stream()
                    .collect(Collectors.groupingBy(LatestValue::equipmentId));
            Map<Long, Double> rpmByVessel = usable.values().stream()
                    .filter(v -> "ME_RPM".equals(v.code()))
                    .collect(Collectors.toMap(LatestValue::vesselId, LatestValue::value));

            for (AlarmRule rule : rules) {
                Optional<Evaluation> result = evaluate(rule, usable, byEquipment, rpmByVessel);
                // 판정할 데이터가 없으면(통신 단절 등) 상태를 그대로 둔다. 단절을 정상 복귀로 오인하지 않는다.
                result.ifPresent(ev -> transition(rule, ev, now));
            }
        } catch (Exception e) {
            log.warn("알람 평가 실패: {}", e.getMessage());
        }
    }

    private Optional<Evaluation> evaluate(
            AlarmRule rule,
            Map<Long, LatestValue> usable,
            Map<Long, List<LatestValue>> byEquipment,
            Map<Long, Double> rpmByVessel) {

        if (rule.onMainEngine()) {
            Double rpm = rpmByVessel.get(rule.vesselId());
            if (rpm == null) {
                return Optional.empty();
            }
            // 주기관 정지 중에는 윤활유 압력 등이 당연히 낮다. 정지 상태의 알람은 억제한다.
            if (rpm < engineRunningRpm) {
                return Optional.of(Evaluation.normal());
            }
        }
        return switch (rule.ruleType()) {
            case "THRESHOLD" -> threshold(rule, usable.get(rule.tagId()));
            case "DEVIATION" -> deviation(rule, byEquipment.get(rule.equipmentId()));
            case "RATE_OF_CHANGE" -> rateOfChange(rule, usable.get(rule.tagId()));
            default -> Optional.empty();
        };
    }

    private Optional<Evaluation> threshold(AlarmRule rule, LatestValue cur) {
        if (cur == null) {
            return Optional.empty();
        }
        boolean active = rule.lowSide() ? cur.value() <= rule.limitValue() : cur.value() >= rule.limitValue();
        return Optional.of(active
                ? new Evaluation(true, cur.tagId(), cur.value(), format(rule, cur.value(), null, null))
                : Evaluation.normal());
    }

    private Optional<Evaluation> deviation(AlarmRule rule, List<LatestValue> equipmentValues) {
        if (equipmentValues == null) {
            return Optional.empty();
        }
        List<CylinderDeviation.Reading> readings = equipmentValues.stream()
                .filter(v -> v.cylinderNo() != null)
                .map(v -> new CylinderDeviation.Reading(v.cylinderNo(), v.tagId(), v.code(), v.value()))
                .toList();
        CylinderDeviation.Result result = CylinderDeviation.analyze(readings);
        if (result == null) {
            return Optional.empty();
        }
        if (result.maxAbsDeviation() < rule.deviationLimit()) {
            return Optional.of(Evaluation.normal());
        }
        CylinderDeviation.Cylinder worst = result.worst();
        return Optional.of(new Evaluation(true, worst.tagId(), worst.value(),
                format(rule, worst.value(), worst.deviation(), worst.no())));
    }

    /** rate_limit 이 양수면 상승, 음수면 하강을 감시한다. */
    private Optional<Evaluation> rateOfChange(AlarmRule rule, LatestValue cur) {
        if (cur == null) {
            return Optional.empty();
        }
        int window = rule.rateWindowSec() == null ? 60 : rule.rateWindowSec();
        Optional<Double> past = jdbc.sql("""
                SELECT value FROM telemetry
                 WHERE tag_id = :tagId AND quality = 192 AND value IS NOT NULL
                   AND ts <= now() - make_interval(secs => :window)
                   AND ts >  now() - make_interval(secs => :lookback)
                 ORDER BY ts DESC LIMIT 1
                """)
                .param("tagId", cur.tagId())
                .param("window", window)
                .param("lookback", window + freshness.toSeconds())
                .query(Double.class)
                .optional();
        if (past.isEmpty()) {
            return Optional.empty();
        }
        double change = cur.value() - past.get();
        boolean active = rule.rateLimit() >= 0 ? change >= rule.rateLimit() : change <= rule.rateLimit();
        return Optional.of(active
                ? new Evaluation(true, cur.tagId(), cur.value(), format(rule, Math.abs(change), null, null))
                : Evaluation.normal());
    }

    private void transition(AlarmRule rule, Evaluation ev, Instant now) {
        Long openId = open.get(rule.id());
        if (ev.active()) {
            normalSince.remove(rule.id());
            if (openId != null) {
                return;
            }
            Instant since = pendingSince.computeIfAbsent(rule.id(), k -> now);
            if (Duration.between(since, now).getSeconds() >= rule.dwellSec()) {
                pendingSince.remove(rule.id());
                alarms.raise(rule, ev.tagId(), ev.message(), ev.value()).ifPresent(id -> {
                    open.put(rule.id(), id);
                    log.info("알람 발생 #{} [{}] {}", id, rule.severity(), ev.message());
                });
            }
        } else {
            pendingSince.remove(rule.id());
            if (openId == null) {
                return;
            }
            Instant since = normalSince.computeIfAbsent(rule.id(), k -> now);
            if (Duration.between(since, now).compareTo(clearHold) >= 0) {
                alarms.clear(openId);
                open.remove(rule.id());
                normalSince.remove(rule.id());
                log.info("알람 해제 #{}", openId);
            }
        }
    }

    private static String format(AlarmRule rule, Double value, Double deviation, Integer cylinder) {
        String message = rule.messageTemplate() == null ? rule.ruleType() : rule.messageTemplate();
        if (value != null) {
            message = message.replace("{value}", String.format("%.1f", value));
        }
        if (deviation != null) {
            message = message.replace("{deviation}", String.format("%+.1f", deviation));
        }
        if (cylinder != null) {
            message = message.replace("{cylinder}", String.valueOf(cylinder));
        }
        return message;
    }
}

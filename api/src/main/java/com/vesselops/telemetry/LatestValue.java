package com.vesselops.telemetry;

import java.time.Duration;
import java.time.Instant;

/** 계측점 1개의 정의와 가장 최근 값. 값이 아직 없으면 ts·value 가 null 이다. */
public record LatestValue(
        long tagId,
        long vesselId,
        String imo,
        long equipmentId,
        String equipment,
        String equipType,
        String code,
        String name,
        String unit,
        Integer cylinderNo,
        Double normalMin,
        Double normalMax,
        Instant ts,
        Double value,
        Integer quality) {

    public static final int QUALITY_GOOD = 192;

    /** 알람 판정에 쓸 수 있는 값인가 — 품질 Good 이고 충분히 최근이어야 한다. */
    public boolean usable(Instant now, Duration freshness) {
        return value != null
                && quality != null && quality == QUALITY_GOOD
                && ts != null && ts.isAfter(now.minus(freshness));
    }
}

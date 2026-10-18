package com.vesselops.vessel;

import java.time.Instant;
import java.util.List;

/** 조회 API 응답 모델 */
public final class VesselDtos {

    private VesselDtos() {
    }

    public record VesselSummary(
            String imo,
            String name,
            String vesselType,
            String classSociety,
            String status,
            String sisterGroup,
            String engineModel,
            Integer cylinderCount,
            boolean online,
            Instant lastSeenAt,
            Double loadPct,
            Double rpm,
            Double foFlowKgH,
            Double shaftPowerKw,
            Double maxCylinderDeviation,
            int openAlarmCount,
            String alarmLevel) {
    }

    public record TagValue(
            String code,
            String name,
            String unit,
            Integer cylinderNo,
            Double normalMin,
            Double normalMax,
            Double value,
            Integer quality,
            Instant ts) {
    }

    public record EquipmentValues(String code, String equipType, List<TagValue> tags) {
    }

    public record VesselDetail(VesselSummary vessel, List<EquipmentValues> equipment) {
    }

    public record CylinderStatus(int no, String tag, double value, double deviation, String level) {
    }

    public record CylinderDeviationView(
            String imo,
            boolean engineRunning,
            Double mean,
            Double maxDeviation,
            Double limitHi,
            Double limitHiHi,
            Instant at,
            List<CylinderStatus> cylinders) {
    }

    public record TrendSeries(String tag, String name, String unit, List<double[]> points) {
    }

    public record Trend(String imo, Instant from, Instant to, int bucketSec, List<TrendSeries> series) {
    }
}

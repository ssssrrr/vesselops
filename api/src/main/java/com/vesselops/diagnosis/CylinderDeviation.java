package com.vesselops.diagnosis;

import java.util.Comparator;
import java.util.List;

/**
 * 실린더별 배기온도 편차 진단 (FR-302).
 *
 * 각 실린더 배기온도를 전 실린더 평균과 비교한다. 절대값이 정상범위 안이어도 한 실린더만
 * 평균에서 벌어지면 연료분사밸브·배기밸브 이상의 조기 징후다. 부하가 바뀌면 전 실린더가
 * 함께 오르내리므로, 평균 대비 편차는 부하 변화에 흔들리지 않는다.
 *
 * DB·프레임워크에 의존하지 않는 순수 계산이라 단위 테스트로 검증한다.
 */
public final class CylinderDeviation {

    private CylinderDeviation() {
    }

    public record Reading(int cylinderNo, long tagId, String tagCode, double value) {
    }

    public record Cylinder(int no, long tagId, String tag, double value, double deviation) {
    }

    public record Result(double mean, List<Cylinder> cylinders, Cylinder worst) {

        public double maxAbsDeviation() {
            return worst == null ? 0 : Math.abs(worst.deviation());
        }
    }

    /**
     * @param readings 유효한(품질 Good·최신) 실린더 값. 2개 미만이면 편차를 정의할 수 없어 null.
     */
    public static Result analyze(List<Reading> readings) {
        if (readings == null || readings.size() < 2) {
            return null;
        }
        double mean = readings.stream().mapToDouble(Reading::value).average().orElse(0);
        List<Cylinder> cylinders = readings.stream()
                .sorted(Comparator.comparingInt(Reading::cylinderNo))
                .map(r -> new Cylinder(r.cylinderNo(), r.tagId(), r.tagCode(), r.value(), r.value() - mean))
                .toList();
        Cylinder worst = cylinders.stream()
                .max(Comparator.comparingDouble(c -> Math.abs(c.deviation())))
                .orElse(null);
        return new Result(mean, cylinders, worst);
    }
}

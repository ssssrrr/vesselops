package com.vesselops.alarm;

/**
 * 알람 룰. THRESHOLD·RATE_OF_CHANGE 는 태그 단위, DEVIATION 은 장비 단위로 걸린다.
 * equipmentId·vesselId 는 조회 시 태그에서 풀어 채운다.
 */
public record AlarmRule(
        long id,
        Long tagId,
        long equipmentId,
        long vesselId,
        String equipType,
        String ruleType,
        String severity,
        Double limitValue,
        Double deviationLimit,
        Double rateLimit,
        Integer rateWindowSec,
        int dwellSec,
        String messageTemplate) {

    public boolean onMainEngine() {
        return "MAIN_ENGINE".equals(equipType);
    }

    /** LO·LOLO 는 하한 경보, 그 외는 상한 경보 */
    public boolean lowSide() {
        return "LO".equals(severity) || "LOLO".equals(severity);
    }
}

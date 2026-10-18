package com.vesselops.diagnosis;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

import com.vesselops.diagnosis.CylinderDeviation.Reading;
import com.vesselops.diagnosis.CylinderDeviation.Result;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

class CylinderDeviationTest {

    private static List<Reading> readings(double... values) {
        List<Reading> list = new ArrayList<>();
        for (int i = 0; i < values.length; i++) {
            list.add(new Reading(i + 1, 100 + i, "ME_EXH_T_CYL0" + (i + 1), values[i]));
        }
        return list;
    }

    @Test
    void 전_실린더가_비슷하면_편차가_작다() {
        Result result = CylinderDeviation.analyze(readings(381, 385, 383, 384, 382, 386));

        assertThat(result.mean()).isCloseTo(383.5, within(0.01));
        assertThat(result.maxAbsDeviation()).isLessThan(5);
    }

    @Test
    void 절대값이_정상범위여도_한_실린더만_벌어지면_잡아낸다() {
        // 4번 실린더 428℃ 는 정상범위(280~430℃) 안이라 임계값 감시로는 잡히지 않는다
        Result result = CylinderDeviation.analyze(readings(365, 368, 366, 428, 367, 364));

        assertThat(result.worst().no()).isEqualTo(4);
        assertThat(result.worst().deviation()).isGreaterThan(50);
    }

    @Test
    void 온도가_낮게_벌어진_실린더도_잡아낸다() {
        // 실화(misfire)는 배기온도가 떨어지는 방향으로 나타난다
        Result result = CylinderDeviation.analyze(readings(385, 383, 310, 384, 386, 382));

        assertThat(result.worst().no()).isEqualTo(3);
        assertThat(result.worst().deviation()).isLessThan(-50);
        assertThat(result.maxAbsDeviation()).isGreaterThan(50);
    }

    @Test
    void 부하가_올라_전_실린더가_함께_오르면_편차는_그대로다() {
        Result low = CylinderDeviation.analyze(readings(340, 344, 342, 343, 341, 345));
        Result high = CylinderDeviation.analyze(readings(400, 404, 402, 403, 401, 405));

        assertThat(high.maxAbsDeviation()).isCloseTo(low.maxAbsDeviation(), within(0.01));
    }

    @Test
    void 유효한_실린더가_2개_미만이면_판정하지_않는다() {
        assertThat(CylinderDeviation.analyze(readings(380))).isNull();
        assertThat(CylinderDeviation.analyze(List.of())).isNull();
    }
}

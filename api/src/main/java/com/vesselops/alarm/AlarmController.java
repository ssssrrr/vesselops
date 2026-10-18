package com.vesselops.alarm;

import com.vesselops.alarm.AlarmRepository.AlarmView;
import com.vesselops.common.ApiException;
import java.util.List;
import java.util.Set;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/alarms")
public class AlarmController {

    private static final Set<String> STATES = Set.of("OPEN", "ACTIVE", "ACKED", "CLEARED");

    public record AlarmPage(List<AlarmView> content, int page, int size, long total) {
    }

    private final AlarmRepository alarms;

    public AlarmController(AlarmRepository alarms) {
        this.alarms = alarms;
    }

    @GetMapping
    public AlarmPage list(
            @RequestParam(required = false) String imo,
            @RequestParam(required = false) String state,
            @RequestParam(defaultValue = "0") int page,
            @RequestParam(defaultValue = "50") int size) {
        if (state != null && !STATES.contains(state)) {
            throw ApiException.badRequest("STATE_INVALID", "state 는 OPEN, ACTIVE, ACKED, CLEARED 중 하나입니다.");
        }
        if (page < 0 || size < 1 || size > 200) {
            throw ApiException.badRequest("PAGE_INVALID", "page 는 0 이상, size 는 1~200 입니다.");
        }
        return new AlarmPage(alarms.search(imo, state, page, size), page, size, alarms.count(imo, state));
    }

    @PostMapping("/{id}/ack")
    public AlarmView acknowledge(@PathVariable long id) {
        AlarmView alarm = alarms.findById(id)
                .orElseThrow(() -> ApiException.notFound("ALARM_NOT_FOUND", "알람을 찾을 수 없습니다."));
        if (alarms.acknowledge(id) == 0) {
            throw ApiException.conflict("ALARM_NOT_ACTIVE", "이미 확인됐거나 해제된 알람입니다. (현재 상태: " + alarm.state() + ")");
        }
        return alarms.findById(id).orElseThrow();
    }
}

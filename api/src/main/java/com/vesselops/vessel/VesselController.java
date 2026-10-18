package com.vesselops.vessel;

import com.vesselops.vessel.VesselDtos.CylinderDeviationView;
import com.vesselops.vessel.VesselDtos.Trend;
import com.vesselops.vessel.VesselDtos.VesselDetail;
import com.vesselops.vessel.VesselDtos.VesselSummary;
import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** 선단·선박 조회 (IF-05). 조회는 게스트에게 열려 있다. */
@RestController
@RequestMapping("/api/v1/vessels")
public class VesselController {

    private final VesselService vessels;

    public VesselController(VesselService vessels) {
        this.vessels = vessels;
    }

    @GetMapping
    public List<VesselSummary> list() {
        return vessels.list();
    }

    @GetMapping("/{imo}")
    public VesselDetail detail(@PathVariable String imo) {
        return vessels.detail(imo);
    }

    @GetMapping("/{imo}/cylinder-deviation")
    public CylinderDeviationView cylinderDeviation(@PathVariable String imo) {
        return vessels.cylinderDeviation(imo);
    }

    @GetMapping("/{imo}/trend")
    public Trend trend(
            @PathVariable String imo,
            @RequestParam List<String> tags,
            @RequestParam(defaultValue = "30") int minutes) {
        return vessels.trend(imo, tags, minutes);
    }
}

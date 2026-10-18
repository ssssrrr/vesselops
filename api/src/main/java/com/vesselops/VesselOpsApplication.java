package com.vesselops;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class VesselOpsApplication {

    public static void main(String[] args) {
        SpringApplication.run(VesselOpsApplication.class, args);
    }
}

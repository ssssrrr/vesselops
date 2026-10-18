# ---- 빌드 단계: Gradle 로 실행 가능한 jar 생성 (단위 테스트 포함) ----
FROM gradle:8.14-jdk21 AS build
WORKDIR /workspace
COPY settings.gradle build.gradle ./
# 의존성만 먼저 받아 계층 캐시에 남긴다. 소스만 바뀌면 이 단계는 재사용된다.
RUN gradle dependencies --no-daemon -q > /dev/null
COPY src ./src
RUN gradle build --no-daemon -q

# ---- 실행 단계: JRE 만 담는다 ----
FROM eclipse-temurin:21-jre
WORKDIR /app
RUN useradd --system --no-create-home vesselops
COPY --from=build /workspace/build/libs/*.jar app.jar
USER vesselops
EXPOSE 8080
# 컨테이너 메모리 한도 안에서 힙을 잡는다
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=70", "-jar", "app.jar"]

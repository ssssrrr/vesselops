# VesselOps

[![CI](https://github.com/ssssrrr/vesselops/actions/workflows/ci.yml/badge.svg)](https://github.com/ssssrrr/vesselops/actions/workflows/ci.yml)

**선박 기관 원격 상태감시·예지보전 플랫폼.**

**라이브 데모: http://15.135.85.42** · 저장소: https://github.com/ssssrrr/vesselops
본선의 기관 운전 데이터를 수집해 육상으로 보내고, 저장하고, 이상을 진단해 화면으로 보여준다.

![주 화면](docs/images/screen-main.png)

> 표시되는 데이터는 전부 시뮬레이터가 만든 합성 데이터다. 실선·실제 설비의 데이터는 포함하지 않는다.

---

## 무엇을 하는가

| | |
|---|---|
| **실린더 배기온도 편차 진단** | 각 실린더를 전 실린더 평균과 비교한다. 절대 온도가 정상범위여도 한 실린더만 벌어지면 연료분사밸브·배기밸브 이상의 조기 징후다. 임계값 감시로는 잡히지 않는다 |
| **적응형 전송** | 평상시에는 1분 요약만 보내 위성 통신량을 줄이고, 본선에서 이상 징후를 감지하면 1초 원본으로 바꾼다 |
| **Pre-trigger 소급 전송** | 1초 원본을 본선에 10분간 항상 보관했다가, 이상 감지 시 **그 직전 구간까지** 소급해 보낸다. 진단에 가장 필요한 구간을 잃지 않는다 |
| **단절 버퍼링** | 통신이 끊기면 본선에 쌓아 두고, 복구되면 시간순으로 다시 보낸다. 중복은 DB 제약으로 걸러낸다 |
| **선박별 인증서** | 본선과 육상 사이는 TLS 로 암호화하고, 선박마다 다른 인증서로 접속한다. 브로커는 인증서의 선박 번호와 같은 토픽에만 발행을 받아, 한 선박이 다른 선박 행세를 하지 못한다 |
| **읽기 전용** | 감시 계통은 제어 계통에 쓰지 않는다. 원격 제어 기능은 의도적으로 만들지 않았다 |

---

## 구조

```
 [본선]                                    [육상 클라우드]

 sim-fleet ──OPC UA──> edge-gw ─MQTT/TLS─> broker ─> ingest ──> db (TimescaleDB)
 기관 물리모델           Deadband                    검증          ▲
 고장 주입              적응형 전송                   배치 적재      │
 (Node.js)             Pre-trigger                 WebSocket    api (Spring Boot)
                       단절 버퍼                    (Node.js)     알람 룰 엔진
                       (Node.js)                       │         조회 API
                                                       ▼            │
                                                     web (Nginx) <──┘
```

| 구간 | 기술 | 이유 |
|---|---|---|
| 수집·전송 | Node.js 22, node-opcua, MQTT over TLS | 연결을 오래 유지하며 작은 메시지를 많이 주고받는 I/O 중심 구간 |
| 판정·조회 | Java 21, Spring Boot 3.5 | 룰·상태 전이·이력처럼 정합성이 중요한 업무 규칙 구간 |
| 저장 | PostgreSQL 16 + TimescaleDB | 시계열과 마스터를 한 DB 에서 조인한다 |
| 배포 | Docker Compose | 로컬과 클라우드가 같은 파일을 쓴다 |
| CI/CD | GitHub Actions | push 마다 단위 시험과 컨테이너 7개 기동 확인을 돌리고, 통과한 커밋만 서버에 반영한다 |

두 구간은 서로를 직접 호출하지 않는다. 브로커와 DB 를 사이에 두므로 한쪽을 재배포해도 다른 쪽은 계속 동작한다.

---

## 실행

Docker 만 있으면 된다.

```bash
cp .env.example .env
docker compose up -d --build
```

브라우저에서 `http://localhost` 를 열고, 화면의 **시연 패널**에서 고장을 주입해 본다.
실린더 편차를 주입하면 약 2분 뒤 편차 알람이 발생한다.

---

## 문서

설계와 검증 과정을 문서로 남겼다. 전체 목록은 [`docs/README.md`](docs/README.md).

| 문서 | 내용 |
|---|---|
| [요구사항정의서](docs/01-requirements.md) | 기능 39건, 비기능 11건 |
| [아키텍처 설계서](docs/02-architecture.md) | 구조와 설계 결정 기록(ADR) 11건 |
| [인터페이스 정의서](docs/03-interface-spec.md) | OPC UA 태그맵, MQTT 페이로드, REST·WebSocket 규격 |
| [DB 설계서](docs/04-database-design.md) | ERD, 테이블 정의, 시계열 설계, 제약조건의 의도 |
| [프로그램 설계서](docs/06-function-spec.md) | 모듈 구성, 처리 절차, 알람 엔진, API 명세 |
| [테스트 결과서](docs/08-test.md) | 시험 항목과 실측 결과 |
| [요구사항 추적표](docs/10-traceability.md) | 요구사항별 설계·구현·시험 연결, 미구현 항목 |

---

## 폴더

```
simulator/   선단 시뮬레이터 (OPC UA 서버)
edge-gw/     본선 Edge 수집기
ingest/      육상 수집기
api/         업무 API (Spring Boot)
web/         화면
db/init/     스키마·시드 SQL
deploy/      Nginx·Mosquitto 설정
docs/        설계·시험 문서
.github/     CI/CD 워크플로
```

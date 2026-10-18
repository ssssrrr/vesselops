# VesselOps 배포·운영 가이드

| 항목 | 내용 |
|---|---|
| 문서명 | 선박 기관 원격 상태감시 플랫폼 배포·운영 가이드 |
| 버전 | v1.4 |
| 작성일 | 2026-10-18 |
| 작성자 | 최승렬 |
| 선행문서 | `02-architecture.md` (v1.4), `06-function-spec.md` (v1.0) |

---

## 목차

1. [구성 요약](#1-구성-요약)
2. [로컬 실행](#2-로컬-실행)
3. [클라우드 배포 — AWS EC2](#3-클라우드-배포--aws-ec2)
4. [배포 후 확인](#4-배포-후-확인)
5. [운영](#5-운영)
6. [장애 대응](#6-장애-대응)
7. [CI/CD](#7-cicd)
8. [변경 이력](#8-변경-이력)

---

## 1. 구성 요약

`docker compose up` 한 줄로 컨테이너 7개가 뜬다. 로컬과 클라우드가 **같은 파일**을 쓴다.
그 전에 인증서 발급용 `vesselops-pki` 가 한 번 실행되고 종료한다 (`docker compose ps -a` 에서 `Exited (0)`).

| 컨테이너 | 이미지 | 포트 | 외부 공개 |
|---|---|---|---|
| `vesselops-web` | nginx:1.27-alpine | 80 | ✅ 유일한 진입점 |
| `vesselops-api` | 자체 빌드 (Temurin 21 JRE) | 8080 | ❌ |
| `vesselops-ingest` | 자체 빌드 (Node 22) | 3001 | ❌ |
| `vesselops-edge` | 자체 빌드 (Node 22) | 3002 | ❌ |
| `vesselops-sim` | 자체 빌드 (Node 22) | 4840, 3000 | ❌ |
| `vesselops-broker` | eclipse-mosquitto:2.0 | 8883 (TLS) | ❌ 호스트 127.0.0.1 에만. 클라이언트 인증서 필수 |
| `vesselops-db` | timescale/timescaledb:2.17.2-pg16 | 5432 | ❌ 호스트 127.0.0.1 에만 |
| `vesselops-pki` | 자체 빌드 (Alpine + OpenSSL) | — | 기동 시 1회 실행 후 종료 |

사용한 이미지는 전부 amd64·arm64 를 함께 제공한다. ARM 인스턴스에서 그대로 빌드된다.

---

## 2. 로컬 실행

필요한 것은 Docker 뿐이다. JDK·Node.js·Gradle 은 이미지 빌드 단계 안에서 쓰므로 설치하지 않아도 된다.

```bash
git clone <저장소 주소> vesselops
cd vesselops
cp .env.example .env          # 필요하면 WEB_PORT 를 바꾼다
docker compose up -d --build  # 최초 빌드는 수 분 걸린다
docker compose ps             # 7개가 모두 Up 인지 확인
```

브라우저에서 `http://localhost` (또는 `http://localhost:<WEB_PORT>`) 를 연다.

> DB 스키마와 시드는 **볼륨이 비어 있는 최초 기동 때 한 번만** 실행된다.
> `db/init/*.sql` 을 고친 뒤 다시 적용하려면 볼륨을 지워야 하며, 이때 쌓인 데이터도 함께 사라진다.

---

## 3. 클라우드 배포 — AWS EC2

> **실제 배포 (2026-10-16 ~ 18)** 데모 주소 **http://15.135.85.42**.
> 처음에는 Oracle Cloud 무료 ARM 인스턴스를 계획했으나 가입이 거절돼 AWS 무료 플랜(크레딧)으로 바꿨다.
> compose 파일은 그대로 썼다. 사용한 이미지가 amd64·arm64 를 모두 제공하므로 어느 쪽이든 같은 명령으로 올라간다.

### 3.1 인스턴스 사양

| 항목 | 값 | 비고 |
|---|---|---|
| 리전 | ap-southeast-2 (시드니) | 무료 플랜은 가입 시 정해진 리전 1곳만 쓸 수 있다. 운영이라면 지연·데이터 국외 이전 규정 때문에 서울(ap-northeast-2)을 쓴다 |
| 인스턴스 유형 | c7i-flex.large (2 vCPU / 4 GB, x86_64) | t3.micro(1 GB)는 컨테이너 7개를 돌리지 못한다 |
| 이미지 | Ubuntu 26.04 LTS | 24.04 도 같은 절차 |
| 스토리지 | 30 GB gp3 | 시연 프로파일은 30일 보존 기준 약 12 GB (`04-database-design.md` 8장) |
| 공인 IP | **탄력적 IP** 연결 | 기본 공인 IP 는 중지·시작 때 바뀐다. 제출한 주소가 바뀌지 않도록 고정 |
| 종료 방지 | 활성화 | 실수로 삭제하면 DB 볼륨도 함께 사라진다 |

비용: 24시간 가동 시 월 약 80달러(서버 + 디스크 + IP)가 크레딧에서 차감된다. 무료 플랜은 크레딧이 끝나면 청구 없이 정지된다.

### 3.2 방화벽 — 보안 그룹

| 유형 | 포트 | 소스 | 용도 |
|---|---|---|---|
| SSH | 22 | 관리자 IP (`/32`) | 서버 관리 |
| HTTP | 80 | `0.0.0.0/0` | 화면 |

그 밖의 포트(5432, 8883, 4840, 8080)는 **열지 않는다.** 컨테이너끼리는 서버 안에서만 통신한다.
EC2 의 Ubuntu 이미지는 안쪽 방화벽이 열려 있어 별도 설정이 필요 없다(Oracle Cloud 는 iptables 를 따로 열어야 한다).

SSH 키(.pem)는 Windows OpenSSH 가 권한 검사를 하므로 본인만 읽게 바꾼다.

```bat
icacls vesselops-aws.pem /inheritance:r
icacls vesselops-aws.pem /remove "NT AUTHORITY\Authenticated Users" "BUILTIN\Users"
icacls vesselops-aws.pem /grant:r "%USERNAME%:R"
ssh -i vesselops-aws.pem -o ServerAliveInterval=60 ubuntu@<서버 IP>
```

### 3.3 설치와 기동

```bash
# Docker 설치
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh
sudo usermod -aG docker ubuntu     # sudo 없이 docker 사용 (CD 가 이 계정으로 실행). 다시 로그인해야 적용

# 소스 받기
git clone https://github.com/ssssrrr/vesselops.git
cd vesselops

# 운영 설정 — DB 비밀번호를 반드시 바꾼다
cp .env.example .env
nano .env                          # POSTGRES_PASSWORD 변경

# 기동 (c7i-flex.large 에서 최초 빌드 약 2분)
docker compose up -d --build
docker compose ps
```

### 3.4 갱신 배포

```bash
cd vesselops
git pull
docker compose up -d --build   # 바뀐 이미지의 컨테이너만 다시 만든다
```

DB 볼륨은 유지된다. `api` 를 다시 올려도 수집(`edge-gw` → `ingest` → `db`)은 끊기지 않는다.

---

## 4. 배포 후 확인

| # | 확인 | 명령 | 기대 결과 |
|---|---|---|---|
| 1 | 컨테이너 | `docker compose ps` | 7개 Up, `db`·`broker`·`api` 는 healthy |
| 2 | 마스터 | `docker exec vesselops-db psql -U vesselops -d vesselops -c "SELECT count(*) FROM tag"` | 142 |
| 3 | 수집 | `docker logs vesselops-edge --tail 5` | `구독 생성 — 감시 항목 142개` |
| 4 | 적재 | `docker exec vesselops-ingest wget -qO- http://localhost:3001/health` | `inserted` 증가, `rejected` 0 |
| 5 | API | `curl http://localhost/api/v1/vessels` | 선박 4척, `online: true` |
| 6 | 화면 | 브라우저로 `http://<공인 IP>` | 선단 카드 4개, 값이 1초마다 변함 |
| 7 | 진단 | 시연 패널에서 실린더 편차 주입 | 약 2분 뒤 편차 알람 발생 |
| 8 | 암호화 접속 | `docker logs vesselops-ingest \| grep "브로커 접속"` | `mqtts://broker:8883 (TLSv1.3, …)` |

---

## 5. 운영

### 5.1 로그

```bash
docker compose logs -f --tail 100            # 전체
docker logs vesselops-api --since 10m        # 알람 발생·해제 기록
docker logs vesselops-ingest --since 10m     # 거부·적재 실패 기록
```

### 5.2 상태 점검 주소 (컨테이너 내부)

| 프로그램 | 주소 | 내용 |
|---|---|---|
| ingest | `:3001/health` | 수신·적재·중복·거부·보류 건수, WebSocket 접속 수 |
| edge-gw | `:3002/health` | OPC UA 접속 상태, 선박별 링크·전송 모드·버퍼 건수 |
| sim-fleet | `:3000/health` | OPC UA 노드 수 |
| api | `:8080/actuator/health` | 기동 상태 |

### 5.3 전송 프로파일 전환

```bash
# .env 에서 ADAPTIVE_ENABLED=true 로 바꾼 뒤
docker compose up -d edge-gw
```

실선 프로파일로 바꾸면 평상시 화면 갱신이 1분 간격이 된다. 시연 사이트는 `false` 로 둔다.

### 5.4 백업

```bash
# 마스터와 알람 이력만 백업한다. 시계열은 제외한다 (04-database-design.md 10장)
docker exec vesselops-db pg_dump -U vesselops -d vesselops \
  -t vessel -t equipment -t tag -t alarm_rule -t alarm_event -t app_user -t edge_mode_event \
  > backup_$(date +%Y%m%d).sql
```

현재는 수동이다. 일 1회 자동화(cron)는 차기 과제다.

### 5.5 하면 안 되는 것

| 명령 | 결과 |
|---|---|
| `docker compose down -v` | **`-v` 가 DB 볼륨을 지운다.** 쌓인 시계열과 알람 이력이 전부 사라진다 |
| 운영 중 `POSTGRES_PASSWORD` 변경 | DB 에는 최초 기동 때의 비밀번호가 남아 있어 접속이 전부 실패한다 |
| 5432 포트 공개 | DB 가 인터넷에 노출된다 |
| `pki_*` 볼륨 삭제 | CA 와 인증서가 전부 새로 발급된다. 본선을 다른 장비로 분리해 둔 경우 그쪽 인증서가 무효가 된다 |

### 5.6 인증서 관리

선박↔육상 MQTT 구간은 상호 TLS 다 (`02-architecture.md` ADR-011). 인증서는 `vesselops-pki` 가 발급한다 (`deploy/pki/gen-certs.sh`).

| 항목 | 내용 |
|---|---|
| 보관 위치 | Docker 볼륨 4개 — `pki_ca`(CA, 발급 컨테이너만 접근), `pki_broker`, `pki_edge`, `pki_ingest`. 개인키는 쓰는 프로그램의 볼륨에만 있다 |
| 유효기간 | CA 10년, 그 밖 825일 |
| 재발급 | 이미 있는 인증서는 다시 만들지 않는다. 기동할 때마다 접근 제어 파일만 최신본으로 바꾼다 |
| 선박 추가 | `.env` 의 `PKI_VESSELS` 에 IMO 번호를 더하고 `docker compose up -d` — 새 선박분만 발급된다. 접근 제어 설정은 고칠 필요가 없다 |
| 만료일 확인 | `docker compose run --rm --no-deps --entrypoint sh pki -c "openssl x509 -enddate -noout -in /pki/broker/broker.crt"` |
| 저장소 | 인증서와 개인키는 저장소에 없다. 서버마다 따로 발급된다 |

**본선을 다른 장비로 분리할 때**

1. 육상 서버의 `.env` 에 `MQTT_BIND=0.0.0.0`, `PKI_BROKER_SAN=DNS:<도메인>` 또는 `IP:<공인 IP>` 를 넣는다. 브로커 인증서가 그 주소로 다시 발급된다.
2. 방화벽에서 8883 을 연다 (3.2 의 두 곳 모두).
3. `pki_edge` 볼륨의 `ca.crt`, `{IMO}.crt`, `{IMO}.key` 를 본선 장비로 옮긴다.
4. 본선 장비의 Edge 수집기에 `MQTT_URL=mqtts://<육상 주소>:8883` 을 준다.

> 이 절차는 **실행해 보지 않았다.** TLS 접속은 한 서버 안에서만 시험했다 (`08-test.md` 10장).

**아직 없는 것** — 폐기 목록(CRL), 만료 전 자동 갱신. 지금은 특정 선박의 인증서만 무효로 만들 방법이 없다.
시연 환경에서는 CA 개인키가 같은 서버에 있다. 운영에서는 CA 를 서버 밖에 두고 선박 등록 시 발급한다.

---

## 6. 장애 대응

| 증상 | 확인 | 조치 |
|---|---|---|
| 화면이 뜨지 않는다 | 방화벽 두 겹(3.2), `docker compose ps` | 보안 목록·iptables 규칙 추가 |
| 전 선박 "통신 단절" | `docker logs vesselops-edge` | OPC UA 접속 재시도 중이면 `sim-fleet` 상태 확인. Edge 는 자동 재접속한다 |
| Edge 로그에 `인증서를 읽지 못해` | `PKI_VESSELS` 에 그 선박이 있는지 | IMO 번호를 추가하고 `docker compose up -d` 후 `docker compose restart edge-gw` |
| 브로커 로그에 `certificate verify failed` | 인증서가 지금의 CA 로 발급된 것인지 (`pki_*` 볼륨을 일부만 지웠을 때 생긴다) | `pki_*` 볼륨 4개를 함께 지우고 다시 기동 |
| 한 선박만 "통신 단절" | 시연 패널의 위성 링크 상태 | 누군가 링크를 끊어 둔 것. [위성 링크 복구] 를 누른다 |
| 값은 오는데 알람이 안 난다 | `docker logs vesselops-api` | `알람 평가 실패` 로그 확인. 주기관 정지 중이면 정상(억제) |
| `rejected` 가 증가한다 | `SELECT reason, count(*) FROM telemetry_rejected GROUP BY 1` | `UNKNOWN_TAG` 면 태그 마스터와 Edge 태그맵 불일치 |
| 디스크 사용량 증가 | `docker system df`, `SELECT hypertable_size('telemetry')` | 보존정책(30일) 동작 확인. 빌드 캐시는 `docker builder prune` |

---

## 7. CI/CD

GitHub Actions 워크플로 2개로 구성한다. 선택 근거는 `02-architecture.md` ADR-010.

> **상태 (2026-10-16)** CI 는 저장소 공개 후 첫 실행에서 전 단계 통과했다(`08-test.md` 10.1).
> CD 는 서버에 배포 설정(7.3)을 넣기 전이라 아직 실행하지 않았다.

```
push ──> CI (ci.yml) ──통과──> CD (deploy.yml) ──SSH──> 서버: git merge --ff-only → docker compose up -d --build
            │ 실패
            └──> 배포하지 않는다
```

### 7.1 CI — `.github/workflows/ci.yml`

`main`·`master` 로의 push 와 모든 PR 에서 실행한다.

| 작업 | 내용 | 실패하는 경우 |
|---|---|---|
| `api-test` | 업무 API 단위 시험 (`gradle test`). 보고서를 산출물로 보관 | 진단 계산이 틀렸을 때 |
| `node-check` | `simulator`·`edge-gw`·`ingest` 각각 `npm ci` + 문법 검사 | `package-lock.json` 불일치, 문법 오류 |
| `smoke` | 컨테이너 7개를 띄워 4장의 1·2·5·8번을 확인 — 7개 기동, 계측점 142건, **선박 4척 online**, TLS 접속, 인증서 없는 접속 거부 | 이미지 빌드 실패, 프로그램 사이 연결이 끊겼을 때, 브로커가 평문·익명 접속을 받게 됐을 때 |

`smoke` 는 앞의 두 작업이 통과해야 시작한다. Node.js 3개 프로그램에는 아직 단위 시험이 없다.

### 7.2 CD — `.github/workflows/deploy.yml`

push 로 실행된 CI 가 성공하면 이어서 실행한다. PR 의 CI 결과로는 배포하지 않는다.
Actions 화면에서 수동 실행(`workflow_dispatch`)도 할 수 있다.

| 단계 | 내용 |
|---|---|
| 1 | 러너가 SSH 로 서버에 접속한다. 서버 지문은 미리 등록한 값과 대조한다 |
| 2 | 서버에서 `git fetch` → **CI 가 검증한 그 커밋**으로 `git merge --ff-only` → `docker compose up -d --build` |
| 3 | 밖에서 `http://<서버>/api/v1/vessels` 를 조회해 선박 4척이 나오는지 확인한다 (최대 2분 재시도) |

서버의 `.env` 와 DB 볼륨은 건드리지 않는다. 서버에서 소스를 직접 고쳐 둔 경우 2단계에서 멈추고 덮어쓰지 않는다.

### 7.3 저장소 설정

서버(3장)를 만든 뒤 GitHub 저장소의 Settings → Secrets and variables → Actions 에 넣는다.
`DEPLOY_ENABLED` 를 넣기 전에는 CD 가 실행되지 않고 건너뛴다.

| 구분 | 이름 | 값 |
|---|---|---|
| Variable | `DEPLOY_ENABLED` | `true` |
| Secret | `DEPLOY_HOST` | 서버 공인 IP |
| Secret | `DEPLOY_USER` | 접속 계정 (예: `ubuntu`) |
| Secret | `DEPLOY_SSH_KEY` | 배포 전용 개인키 전체 |
| Secret | `DEPLOY_KNOWN_HOSTS` | `ssh-keyscan <서버 IP>` 의 출력 |

배포 전용 키는 개인 접속용 키와 따로 만든다. 유출되면 그 키만 지우면 된다.

```bash
# 내 PC 에서 — 배포 전용 키 생성
ssh-keygen -t ed25519 -f deploy_key -N "" -C "vesselops-deploy"

# 서버에서 — 공개키 등록
cat deploy_key.pub >> ~/.ssh/authorized_keys
```

서버에는 3.3 의 절차로 `~/vesselops` 에 저장소가 받아져 있어야 한다.

### 7.4 되돌리기

| 상황 | 방법 |
|---|---|
| 배포한 커밋에 문제가 있다 | `git revert <커밋>` 후 push. CI 를 거쳐 다시 배포된다 |
| 자동 배포를 잠시 끄고 싶다 | `DEPLOY_ENABLED` 를 지우거나 `false` 로 바꾼다 |
| 자동 배포가 고장 났다 | 서버에 접속해 3.4 의 수동 절차를 그대로 쓴다 |

---

## 8. 변경 이력

| 버전 | 일자 | 내용 |
|---|---|---|
| v1.0 | 2026-10-10 | 최초 작성. 로컬 실행, Oracle Cloud 배포 절차, 운영·장애 대응 정리 |
| v1.1 | 2026-10-12 | 7장 CI/CD 신설 (워크플로 구성, 저장소 설정, 되돌리기) |
| v1.4 | 2026-10-18 | **3장을 실제 배포한 AWS EC2 기준으로 개정**(Oracle 가입 거절). 데모 주소, 인스턴스 사양, 보안 그룹, 탄력적 IP, 비용 기재 |
| v1.3 | 2026-10-16 | 7장 상태 갱신(CI 통과, CD 미실행) |
| v1.2 | 2026-10-12 | 브로커를 TLS 8883 으로 변경, `pki` 컨테이너 추가. 5.6 인증서 관리 신설. 확인 절차·금지 사항·장애 대응 보강 |

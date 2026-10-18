#!/bin/sh
# 시연용 사설 PKI — 최초 기동 때 한 번 인증서를 발급한다.
#
#   Root CA ─┬─ broker        서버 인증서 (CN=broker)
#            ├─ {IMO}         선박별 클라이언트 인증서 (CN=IMO 번호)
#            ├─ ingest-1      육상 수집기 클라이언트 인증서
#            └─ healthcheck   브로커 상태 점검용
#
# 개인키는 쓰는 쪽의 볼륨에만 둔다. CA 개인키는 이 컨테이너만 볼 수 있다.
# 이미 발급된 인증서는 다시 만들지 않는다. 전부 새로 발급하려면 pki_* 볼륨을 지운다.
#
# 운영에서는 CA 를 서버 밖에 두고, 선박을 등록할 때 인증서를 발급해 본선 장비에 넣는다.
set -eu

CA=/pki/ca
BROKER=/pki/broker
EDGE=/pki/edge
INGEST=/pki/ingest

VESSELS="${PKI_VESSELS:-9876543 9876544 9812345 9754321}"
# 브로커를 밖에 공개할 때 인증서에 올릴 주소. 예) DNS:mqtt.example.com,IP:203.0.113.10
EXTRA_SAN="${PKI_BROKER_SAN:-}"
BROKER_SAN="DNS:broker,DNS:localhost,IP:127.0.0.1${EXTRA_SAN:+,$EXTRA_SAN}"

mkdir -p "$CA" "$BROKER" "$EDGE" "$INGEST"

newkey() {
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$1" 2>/dev/null
}

if [ ! -f "$CA/ca.key" ]; then
  newkey "$CA/ca.key"
  openssl req -x509 -new -key "$CA/ca.key" -sha256 -days 3650 \
    -subj "/O=VesselOps/CN=VesselOps Demo Root CA" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -out "$CA/ca.crt"
  echo "[pki] Root CA 발급"
fi

# issue <디렉터리> <파일명> <CN> <OU> <serverAuth|clientAuth> [SAN]
issue() {
  dir=$1; name=$2; cn=$3; ou=$4; eku=$5; san=${6:-}
  # 같은 CA 가 발급했고 SAN 이 그대로면 건너뛴다
  if [ -f "$dir/$name.crt" ] && openssl verify -CAfile "$CA/ca.crt" "$dir/$name.crt" >/dev/null 2>&1 \
     && [ "$(cat "$dir/$name.san" 2>/dev/null || true)" = "$san" ]; then
    return 0
  fi
  ext=$(mktemp)
  {
    echo "basicConstraints=critical,CA:FALSE"
    echo "keyUsage=critical,digitalSignature"
    echo "extendedKeyUsage=$eku"
    [ -n "$san" ] && echo "subjectAltName=$san"
  } > "$ext"
  newkey "$dir/$name.key"
  openssl req -new -key "$dir/$name.key" -subj "/O=VesselOps/OU=$ou/CN=$cn" -out "$dir/$name.csr"
  openssl x509 -req -in "$dir/$name.csr" -CA "$CA/ca.crt" -CAkey "$CA/ca.key" -CAcreateserial \
    -days 825 -sha256 -extfile "$ext" -out "$dir/$name.crt" 2>/dev/null
  printf '%s' "$san" > "$dir/$name.san"
  rm -f "$dir/$name.csr" "$ext"
  echo "[pki] 발급 $cn ($eku)"
}

issue "$BROKER" broker broker shore serverAuth "$BROKER_SAN"
issue "$BROKER" healthcheck healthcheck shore clientAuth
issue "$INGEST" ingest-1 ingest-1 shore clientAuth
for imo in $VESSELS; do
  issue "$EDGE" "$imo" "$imo" vessel clientAuth
done

for dir in "$BROKER" "$EDGE" "$INGEST"; do
  cp "$CA/ca.crt" "$dir/ca.crt"
  chmod 644 "$dir"/*.crt
  chmod 600 "$dir"/*.key
done

# 접근 제어 파일은 기동할 때마다 최신본으로 바꾼다
if [ -f /pki/acl.conf ]; then
  tr -d '\r' < /pki/acl.conf > "$BROKER/acl.conf"
  chmod 600 "$BROKER/acl.conf"
fi

# 각 프로그램의 실행 계정만 자기 개인키를 읽는다 (mosquitto=1883, node=1000)
chown -R 1883:1883 "$BROKER"
chown -R 1000:1000 "$EDGE" "$INGEST"
chmod 700 "$CA" "$BROKER" "$EDGE" "$INGEST"

echo "[pki] 준비 완료 — 선박 인증서: $VESSELS"

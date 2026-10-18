FROM alpine:3.20

RUN apk add --no-cache openssl

COPY gen-certs.sh /usr/local/bin/gen-certs.sh
# Windows 에서 받은 소스의 줄바꿈(CRLF)이 섞여도 실행되게 한다
RUN sed -i 's/\r$//' /usr/local/bin/gen-certs.sh && chmod +x /usr/local/bin/gen-certs.sh

CMD ["gen-certs.sh"]

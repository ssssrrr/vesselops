# 멀티 아키텍처(amd64/arm64) 공식 이미지 — Oracle Cloud ARM 인스턴스에서 그대로 빌드된다
FROM node:22-bookworm-slim

# node-opcua 가 최초 기동 시 자체 서명 인증서를 만들 때 openssl 을 사용한다
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src

ENV NODE_ENV=production
EXPOSE 4840 3000
USER node
CMD ["node", "src/index.js"]

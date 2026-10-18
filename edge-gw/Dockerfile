FROM node:22-bookworm-slim

# node-opcua 클라이언트도 최초 기동 시 자체 서명 인증서를 만든다
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src

ENV NODE_ENV=production
EXPOSE 3002
USER node
CMD ["node", "src/index.js"]

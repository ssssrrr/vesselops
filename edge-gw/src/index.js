/**
 * Edge 수집기 진입점
 *
 * 시연 환경에서는 프로세스 하나가 선박 4척분의 Edge 를 함께 구동한다.
 * 선박별 로직과 MQTT 접속은 VesselEdge 로 분리돼 있어, 실선에서는 1척분만 띄우면 된다.
 */
import http from 'node:http';
import { config } from './config.js';
import { startCollector } from './opcua-collector.js';
import { VesselEdge } from './vessel-edge.js';

const log = (msg) => console.log(`${new Date().toISOString()} [edge] ${msg}`);

async function main() {
  const collector = await startCollector({
    endpoint: config.opcuaEndpoint,
    mode: config.collectMode,
    log,
  });

  const edges = new Map();
  for (const imo of collector.vessels()) {
    const edge = new VesselEdge({ imo, config, log });
    edge.start();
    edges.set(imo, edge);
  }
  log(`선박 ${edges.size}척 수집 시작 (적응형 전송 ${config.adaptiveEnabled ? '사용' : '미사용'})`);

  // 매초 0.5초 지점에 표본을 뜬다. setInterval 은 조금씩 밀려 같은 초를 두 번 찍거나
  // 한 초를 건너뛰므로(Pre-trigger 결측의 원인), 매번 다음 지점에 맞춰 다시 건다.
  //
  // 타이머는 이벤트 루프의 캐시된 시각을 기준으로 돌아 수십 ms 일찍 깨기도 한다. 그러면 같은 초에
  // 틱이 두 번 돌아 같은 (태그, 시각)이 두 번 발행된다. 마지막으로 찍은 초를 기억해 한 초에 한 번만 찍는다.
  let lastSlot = 0;
  const schedule = () => {
    const now = Date.now();
    let target = Math.floor(now / config.tickMs) * config.tickMs + config.tickMs / 2;
    if (Math.floor(target / config.tickMs) <= lastSlot || target <= now) target += config.tickMs;
    setTimeout(() => {
      const at = Date.now();
      const slot = Math.floor(at / config.tickMs);
      if (slot > lastSlot) {
        lastSlot = slot;
        for (const [imo, edge] of edges) edge.tick(at, collector.snapshot(imo));
      }
      schedule();
    }, target - now);
  };
  schedule();

  // ---- 시연 제어: 위성 링크 단절/복구 (IF-06 8.2) ----
  const server = http.createServer((req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    const state = () => ({
      opcua: { connected: collector.state.connected, mode: collector.state.mode, nodes: collector.state.nodes.length },
      vessels: [...edges.values()].map((e) => e.info()),
    });

    if (req.method === 'GET' && (req.url === '/health' || req.url === '/link')) return send(200, state());

    if (req.method === 'POST' && req.url === '/link') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        let body;
        try {
          body = JSON.parse(raw || '{}');
        } catch {
          return send(400, { code: 'BODY_INVALID', message: 'JSON 형식이 아닙니다.' });
        }
        const edge = edges.get(String(body.imo));
        if (!edge) return send(404, { code: 'VESSEL_NOT_FOUND', message: '선박을 찾을 수 없습니다.' });
        if (typeof body.connected !== 'boolean') {
          return send(400, { code: 'PARAM_INVALID', message: 'connected 는 true/false 입니다.' });
        }
        edge.setLink(body.connected);
        send(200, edge.info());
      });
      return;
    }
    send(404, { code: 'NOT_FOUND', message: '지원하지 않는 경로입니다.' });
  });
  server.listen(config.httpPort, () => log(`제어 API :${config.httpPort}`));
}

main().catch((err) => {
  console.error('[edge] 기동 실패', err);
  process.exit(1);
});

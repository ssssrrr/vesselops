/**
 * OPC UA 수집부 (IF-01)
 *
 * - 주소공간을 탐색해 태그 목록을 스스로 구성한다. 실선에서도 AMS 제조사마다 NodeId 형식이
 *   달라 문서보다 탐색 결과가 정확하다.
 * - 구독(Subscription)이 기본이고, 미지원 서버에서는 주기 읽기(Read)로 대체한다.
 * - Write/Method 호출은 구현하지 않는다 (FR-107 읽기 전용).
 */
import {
  OPCUAClient,
  AttributeIds,
  BrowseDirection,
  MessageSecurityMode,
  NodeClass,
  SecurityPolicy,
  TimestampsToReturn,
} from 'node-opcua';

/** OPC UA StatusCode → OPC 관례 품질코드 (인터페이스 정의서 3.6) */
function toQuality(statusCode) {
  const severity = (statusCode?.value ?? 0) >>> 30;
  if (severity === 0) return 192;   // Good
  if (severity === 1) return 64;    // Uncertain
  return 0;                         // Bad
}

async function browseChildren(session, nodeId) {
  const result = await session.browse({
    nodeId,
    referenceTypeId: 'HierarchicalReferences',
    includeSubtypes: true,
    browseDirection: BrowseDirection.Forward,
    resultMask: 0x3f,
  });
  return result.references || [];
}

/** Vessels → 선박 → 장비 → 태그 3단계를 탐색해 변수 노드 목록을 만든다 */
async function discoverNodes(session) {
  const nodes = [];
  for (const vessel of await browseChildren(session, 'ns=1;s=Vessels')) {
    if (vessel.nodeClass !== NodeClass.Object) continue;
    for (const equipment of await browseChildren(session, vessel.nodeId)) {
      if (equipment.nodeClass !== NodeClass.Object) continue;
      for (const variable of await browseChildren(session, equipment.nodeId)) {
        if (variable.nodeClass !== NodeClass.Variable) continue;
        // s=IMO9876543.ME.ME_RPM
        const [vesselPart, eq, tag] = String(variable.nodeId.value).split('.');
        nodes.push({
          imo: vesselPart.replace(/^IMO/, ''),
          eq,
          tag,
          nodeId: variable.nodeId.toString(),
        });
      }
    }
  }
  return nodes;
}

export async function startCollector({ endpoint, mode, log }) {
  const latest = new Map();   // nodeId → { v, q }
  const state = { connected: false, mode, nodes: [] };

  const client = OPCUAClient.create({
    applicationName: 'VesselOps Edge Gateway',
    securityMode: MessageSecurityMode.None,
    securityPolicy: SecurityPolicy.None,
    endpointMustExist: false,
    keepSessionAlive: true,
    requestedSessionTimeout: 60_000,
    // 지수 백오프 재접속 1초 → 최대 30초 (인터페이스 정의서 9장)
    connectionStrategy: { initialDelay: 1000, maxDelay: 30_000, maxRetry: -1 },
  });
  client.on('backoff', (retry, delay) => log(`OPC UA 접속 재시도 #${retry} (${delay}ms 후)`));
  client.on('connection_lost', () => {
    state.connected = false;
    log('OPC UA 연결 끊김');
  });
  client.on('connection_reestablished', () => {
    state.connected = true;
    log('OPC UA 연결 복구');
  });

  await client.connect(endpoint);
  const session = await client.createSession();
  state.connected = true;
  state.nodes = await discoverNodes(session);
  log(`OPC UA 접속 ${endpoint} — 변수 노드 ${state.nodes.length}개 탐색`);

  const store = (node, dataValue) => {
    const raw = dataValue?.value?.value;
    latest.set(node.nodeId, {
      v: typeof raw === 'number' ? raw : null,
      q: toQuality(dataValue?.statusCode),
    });
  };

  const readAll = async () => {
    const values = await session.read(
      state.nodes.map((n) => ({ nodeId: n.nodeId, attributeId: AttributeIds.Value })),
    );
    values.forEach((dv, i) => store(state.nodes[i], dv));
  };

  const startPolling = () => {
    state.mode = 'poll';
    setInterval(() => {
      if (!state.connected) return;
      readAll().catch((err) => log(`OPC UA 읽기 실패: ${err.message}`));
    }, 1000);
  };

  // 구독은 값이 변할 때만 통지하므로 초기값은 한 번 읽어 채운다
  await readAll();

  if (mode === 'poll') {
    startPolling();
  } else {
    try {
      const subscription = await session.createSubscription2({
        requestedPublishingInterval: 1000,
        requestedLifetimeCount: 1000,
        requestedMaxKeepAliveCount: 10,
        maxNotificationsPerPublish: 0,
        publishingEnabled: true,
        priority: 10,
      });
      const group = await subscription.monitorItems(
        state.nodes.map((n) => ({ nodeId: n.nodeId, attributeId: AttributeIds.Value })),
        { samplingInterval: 1000, discardOldest: true, queueSize: 10 },
        TimestampsToReturn.Both,
      );
      group.on('changed', (_item, dataValue, index) => store(state.nodes[index], dataValue));
      log(`구독 생성 — 감시 항목 ${state.nodes.length}개`);
    } catch (err) {
      log(`구독 생성 실패(${err.message}) → 주기 읽기로 대체`);
      startPolling();
    }
  }

  return {
    state,
    /** 선박 1척의 현재 표본. OPC UA 가 끊겨 있으면 품질을 Bad 로 내린다. */
    snapshot(imo) {
      const out = [];
      for (const node of state.nodes) {
        if (node.imo !== imo) continue;
        const cur = latest.get(node.nodeId);
        if (!cur) continue;
        out.push({ eq: node.eq, tag: node.tag, v: cur.v, q: state.connected ? cur.q : 0 });
      }
      return out;
    },
    vessels() {
      return [...new Set(state.nodes.map((n) => n.imo))];
    },
  };
}

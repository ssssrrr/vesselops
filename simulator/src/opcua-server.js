/**
 * OPC UA 서버 (IF-01)
 *
 * 실선의 AMS(Alarm Monitoring System) 자리를 대신한다.
 * 주소공간: Objects/Vessels/IMO{imo}/{장비}/{태그}
 * NodeId  : ns=1;s=IMO{imo}.{장비코드}.{태그코드}
 *
 * 모든 변수는 읽기 전용이다. 감시 계통이 제어 계통에 쓰지 못하게 하는 원칙(FR-107).
 */
import { OPCUAServer, DataType, StatusCodes } from 'node-opcua';

/**
 * @param {object} opt
 * @param {number} opt.port
 * @param {Array<{imo:string, name:string, equipment:Object<string,string[]>}>} opt.layout
 * @param {Object<string, number>} opt.initial  "imo.장비.태그" → 초기값
 */
export async function startOpcUaServer({ port, layout, initial = {} }) {
  const server = new OPCUAServer({
    port,
    resourcePath: '/vesselops',
    // 컨테이너 호스트명이 아니라 서비스 이름으로 접속해 오므로 인증서에 함께 올린다
    alternateHostname: (process.env.OPCUA_ALT_HOSTNAME || 'sim-fleet,localhost').split(','),
    buildInfo: {
      productName: 'VesselOps Fleet Simulator',
      buildNumber: '1',
      buildDate: new Date(),
    },
  });
  await server.initialize();

  const addressSpace = server.engine.addressSpace;
  const ns = addressSpace.getOwnNamespace();   // 인덱스 1
  const variables = new Map();                 // "imo.eq.tag" → UAVariable

  const vesselsFolder = ns.addFolder(addressSpace.rootFolder.objects, {
    browseName: 'Vessels',
    nodeId: 's=Vessels',
  });

  for (const vessel of layout) {
    const vesselObj = ns.addObject({
      organizedBy: vesselsFolder,
      browseName: `IMO${vessel.imo}`,
      displayName: vessel.name,
      nodeId: `s=IMO${vessel.imo}`,
    });
    for (const [eq, tags] of Object.entries(vessel.equipment)) {
      const eqObj = ns.addObject({
        componentOf: vesselObj,
        browseName: eq,
        nodeId: `s=IMO${vessel.imo}.${eq}`,
      });
      for (const tag of tags) {
        const key = `${vessel.imo}.${eq}.${tag}`;
        const variable = ns.addVariable({
          componentOf: eqObj,
          browseName: tag,
          nodeId: `s=IMO${key}`,
          dataType: 'Double',
          accessLevel: 'CurrentRead',
          userAccessLevel: 'CurrentRead',
          minimumSamplingInterval: 500,
        });
        // 첫 틱 전에 접속한 클라이언트가 0 을 정상값으로 읽어 가지 않도록 초기 표본으로 채운다
        variable.setValueFromSource({ dataType: DataType.Double, value: initial[key] ?? 0 });
        variables.set(key, variable);
      }
    }
  }

  await server.start();

  return {
    endpoint: server.getEndpointUrl(),
    nodeCount: variables.size,
    /** 틱마다 호출 — 값과 소스 타임스탬프를 갱신한다 */
    update(imo, eq, tag, value, sourceTimestamp) {
      const variable = variables.get(`${imo}.${eq}.${tag}`);
      if (!variable) return;
      variable.setValueFromSource(
        { dataType: DataType.Double, value },
        StatusCodes.Good,
        sourceTimestamp,
      );
    },
    async stop() {
      await server.shutdown(1000);
    },
  };
}

/**
 * Server-specific TypeScript types for telemetry messages
 * @packageDocumentation
 */

export interface TelemetryMessage {
  type: 'NODE_STATUS' | 'PACKET_SENT' | 'PACKET_RECEIVED' | 'ROUTE_LOOKUP' | 'CLIENT_CONNECT';
  nodeId: string;
  timestamp: string;
  data: object;
}

export interface NodeStatusMessage extends TelemetryMessage {
  type: 'NODE_STATUS';
  data: {
    routes: { prefix: string; nextHop: string }[];
    peers: { id: string; url: string; connected: boolean }[];
    health: 'healthy' | 'unhealthy' | 'starting';
    uptime: number;
    peersConnected: number;
    totalPeers: number;
  };
}

export interface PacketSentMessage extends TelemetryMessage {
  type: 'PACKET_SENT';
  data: {
    packetId: string;
    nextHop: string;
    timestamp: string;
  };
}

export interface PacketReceivedMessage extends TelemetryMessage {
  type: 'PACKET_RECEIVED';
  data: {
    packetId: string;
    packetType: 'PREPARE' | 'FULFILL' | 'REJECT';
    source: string;
    destination: string;
    amount: string;
  };
}

export interface RouteLookupMessage extends TelemetryMessage {
  type: 'ROUTE_LOOKUP';
  data: {
    destination: string;
    selectedPeer: string;
    reason: string;
  };
}

/**
 * Type guard to validate if a message is a valid TelemetryMessage
 * Note: Payment channel telemetry events (PAYMENT_CHANNEL_*) and settlement events
 * (ACCOUNT_BALANCE, SETTLEMENT_*) don't have a data field - they have fields directly on the event
 */
export function isTelemetryMessage(msg: unknown): msg is TelemetryMessage {
  // First check if msg is an object
  if (typeof msg !== 'object' || msg === null) {
    return false;
  }

  // Type narrow to object with type property
  const obj = msg as { type?: unknown; nodeId?: unknown; timestamp?: unknown; data?: unknown };

  // Check if type field exists and is a string
  if (typeof obj.type !== 'string') {
    return false;
  }

  // Payment channel and settlement events don't have a data field
  const isPaymentChannelOrSettlementEvent =
    obj.type === 'PAYMENT_CHANNEL_OPENED' ||
    obj.type === 'PAYMENT_CHANNEL_BALANCE_UPDATE' ||
    obj.type === 'PAYMENT_CHANNEL_SETTLED' ||
    obj.type === 'ACCOUNT_BALANCE' ||
    obj.type === 'SETTLEMENT_TRIGGERED' ||
    obj.type === 'SETTLEMENT_COMPLETED';

  if (isPaymentChannelOrSettlementEvent) {
    return typeof obj.nodeId === 'string' && typeof obj.timestamp === 'string';
  }

  return (
    typeof obj.nodeId === 'string' &&
    typeof obj.timestamp === 'string' &&
    typeof obj.data === 'object' &&
    obj.data !== null
  );
}

/**
 * Type guard for NODE_STATUS messages
 */
export function isNodeStatusMessage(msg: unknown): msg is NodeStatusMessage {
  if (!isTelemetryMessage(msg) || msg.type !== 'NODE_STATUS') {
    return false;
  }

  const data = msg.data as {
    routes?: unknown;
    peers?: unknown;
    health?: unknown;
    uptime?: unknown;
    peersConnected?: unknown;
    totalPeers?: unknown;
  };
  return (
    Array.isArray(data.routes) &&
    Array.isArray(data.peers) &&
    typeof data.health === 'string' &&
    ['healthy', 'unhealthy', 'starting'].includes(data.health) &&
    typeof data.uptime === 'number' &&
    typeof data.peersConnected === 'number' &&
    typeof data.totalPeers === 'number'
  );
}

/**
 * Type guard for PACKET_SENT messages
 */
export function isPacketSentMessage(msg: unknown): msg is PacketSentMessage {
  if (!isTelemetryMessage(msg) || msg.type !== 'PACKET_SENT') {
    return false;
  }

  const data = msg.data as { packetId?: unknown; nextHop?: unknown; timestamp?: unknown };
  return (
    typeof data.packetId === 'string' &&
    typeof data.nextHop === 'string' &&
    typeof data.timestamp === 'string'
  );
}

/**
 * Type guard for PACKET_RECEIVED messages
 */
export function isPacketReceivedMessage(msg: unknown): msg is PacketReceivedMessage {
  if (!isTelemetryMessage(msg) || msg.type !== 'PACKET_RECEIVED') {
    return false;
  }

  const data = msg.data as {
    packetId?: unknown;
    packetType?: unknown;
    source?: unknown;
    destination?: unknown;
    amount?: unknown;
  };
  return (
    typeof data.packetId === 'string' &&
    typeof data.packetType === 'string' &&
    ['PREPARE', 'FULFILL', 'REJECT'].includes(data.packetType) &&
    typeof data.source === 'string' &&
    typeof data.destination === 'string' &&
    typeof data.amount === 'string'
  );
}

/**
 * Type guard for ROUTE_LOOKUP messages
 */
export function isRouteLookupMessage(msg: unknown): msg is RouteLookupMessage {
  if (!isTelemetryMessage(msg) || msg.type !== 'ROUTE_LOOKUP') {
    return false;
  }

  const data = msg.data as { destination?: unknown; selectedPeer?: unknown; reason?: unknown };
  return (
    typeof data.destination === 'string' &&
    typeof data.selectedPeer === 'string' &&
    typeof data.reason === 'string'
  );
}

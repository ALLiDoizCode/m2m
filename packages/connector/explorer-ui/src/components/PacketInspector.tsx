import * as React from 'react';
import { TelemetryEvent } from '@/lib/event-types';
import { cn } from '@/lib/utils';
import { useExpiryCountdown } from '@/hooks/useExpiryCountdown';
import { PeerField } from './FieldDisplay';

export interface PacketInspectorProps {
  event: TelemetryEvent;
}

/**
 * ILP Packet types
 */
const PACKET_TYPES: Record<number, string> = {
  12: 'Prepare',
  13: 'Fulfill',
  14: 'Reject',
};

/**
 * ILP Error code categories and common codes
 */
const ERROR_CATEGORIES: Record<string, string> = {
  F: 'Final (permanent failure)',
  T: 'Temporary (can retry)',
  R: 'Relative (protocol violation)',
};

const ERROR_CODES: Record<string, string> = {
  F00: 'Bad Request',
  F01: 'Invalid Packet',
  F02: 'Unreachable',
  F03: 'Invalid Amount',
  F04: 'Insufficient Destination Amount',
  F05: 'Wrong Condition',
  F06: 'Unexpected Payment',
  F07: 'Cannot Receive',
  F08: 'Amount Too Large',
  F09: 'Invalid Peer Response',
  F99: 'Application Error',
  T00: 'Internal Error',
  T01: 'Peer Unreachable',
  T02: 'Peer Busy',
  T03: 'Connector Busy',
  T04: 'Insufficient Liquidity',
  T05: 'Rate Limited',
  T99: 'Application Error',
  R00: 'Transfer Timed Out',
  R01: 'Insufficient Source Amount',
  R02: 'Insufficient Timeout',
  R99: 'Application Error',
};

/**
 * Format amount for human-readable display
 */
function formatAmount(amount: string | number | bigint | undefined): string {
  if (amount === undefined || amount === null) return 'N/A';
  const amountStr = String(amount);
  try {
    const num = BigInt(amountStr);
    // Format with thousands separators
    return num.toLocaleString() + ' units';
  } catch {
    return amountStr + ' units';
  }
}

/**
 * Format hex string for display (truncate if too long)
 */
function formatHex(hex: string | undefined, maxLength = 32): string {
  if (!hex) return 'N/A';
  if (hex.length <= maxLength) return hex;
  return hex.slice(0, maxLength / 2) + '...' + hex.slice(-maxLength / 2);
}

/**
 * Format timestamp for display
 */
function formatTimestamp(ts: string | number | Date | undefined): string {
  if (!ts) return 'N/A';
  try {
    const date = new Date(ts);
    return date.toLocaleString();
  } catch {
    return String(ts);
  }
}

/**
 * Expiry countdown display with live updates
 */
function ExpiryCountdownField({ expiresAt }: { expiresAt: string | number }) {
  const { countdown, isExpired } = useExpiryCountdown(expiresAt);

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground uppercase tracking-wide">Expires At</span>
      <div className="flex flex-col gap-1">
        <span className="text-sm">{formatTimestamp(expiresAt)}</span>
        <span className={cn('text-xs font-mono', isExpired ? 'text-red-400' : 'text-green-400')}>
          {countdown}
        </span>
      </div>
    </div>
  );
}

/**
 * Field display component
 */
function Field({
  label,
  value,
  className,
  mono = false,
}: {
  label: string;
  value: React.ReactNode;
  className?: string;
  mono?: boolean;
}) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <span className="text-xs text-muted-foreground uppercase tracking-wide">{label}</span>
      <span className={cn('text-sm', mono && 'font-mono break-all')}>{value}</span>
    </div>
  );
}

/**
 * Extract packet data from telemetry event
 */
function extractPacketData(event: TelemetryEvent): {
  packetType: string;
  packetTypeCode: number;
  amount?: string;
  from?: string;
  to?: string;
  destination?: string;
  executionCondition?: string;
  expiresAt?: string | number;
  fulfillment?: string;
  errorCode?: string;
  triggeredBy?: string;
  errorMessage?: string;
  dataSize?: number;
  source?: string;
  packetId?: string;
} | null {
  const data = event as Record<string, unknown>;

  // Check for packet event types
  const eventType = data.type as string;

  // Handle AGENT_CHANNEL_PAYMENT_SENT events (contains ILP packet data)
  if (eventType === 'AGENT_CHANNEL_PAYMENT_SENT') {
    // Extract packet type from the event, default to PREPARE
    const rawPacketType = (data.packetType as string) || 'prepare';
    const normalizedType = rawPacketType.toUpperCase();
    const packetTypeCode =
      normalizedType === 'PREPARE'
        ? 12
        : normalizedType === 'FULFILL'
          ? 13
          : normalizedType === 'REJECT'
            ? 14
            : 12;

    return {
      packetType: normalizedType,
      packetTypeCode,
      amount: data.amount as string | undefined,
      from: data.from as string | undefined,
      to: data.to as string | undefined,
      destination: data.destination as string | undefined,
      executionCondition: data.executionCondition as string | undefined,
      expiresAt: data.expiresAt as string | number | undefined,
      fulfillment: data.fulfillment as string | undefined,
      errorCode: data.errorCode as string | undefined,
      errorMessage: data.errorMessage as string | undefined,
      packetId: data.channelId as string | undefined,
    };
  }

  if (!['PACKET_RECEIVED', 'PACKET_FORWARDED', 'PACKET_SENT'].includes(eventType)) {
    return null;
  }

  // Extract from event data or nested data field
  const payload = (data.data || data) as Record<string, unknown>;

  const packetTypeStr = (payload.packetType as string) || 'PREPARE';
  const packetTypeCode =
    packetTypeStr === 'PREPARE'
      ? 12
      : packetTypeStr === 'FULFILL'
        ? 13
        : packetTypeStr === 'REJECT'
          ? 14
          : 0;

  return {
    packetType: packetTypeStr,
    packetTypeCode,
    amount: payload.amount as string | undefined,
    from: payload.from as string | undefined,
    to: payload.to as string | undefined,
    destination: payload.destination as string | undefined,
    executionCondition: (payload.executionCondition || payload.packetId) as string | undefined,
    expiresAt: payload.expiresAt as string | number | undefined,
    fulfillment: payload.fulfillment as string | undefined,
    errorCode: payload.errorCode as string | undefined,
    triggeredBy: payload.triggeredBy as string | undefined,
    errorMessage: (payload.message || payload.errorMessage) as string | undefined,
    dataSize: payload.dataSize as number | undefined,
    source: payload.source as string | undefined,
    packetId: payload.packetId as string | undefined,
  };
}

/**
 * PacketInspector - Display decoded ILP packet fields
 *
 * Shows:
 * - Prepare: Type, Amount, Destination, Execution Condition, Expires At, Data size
 * - Fulfill: Type, Fulfillment, Data size
 * - Reject: Type, Error Code, Triggered By, Message
 */
export function PacketInspector({ event }: PacketInspectorProps) {
  const packetData = extractPacketData(event);

  if (!packetData) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        This event does not contain ILP packet data.
      </div>
    );
  }

  const { packetType, packetTypeCode } = packetData;

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* Packet Type Header */}
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'px-2 py-1 rounded text-xs font-medium',
            packetType === 'PREPARE' && 'bg-blue-500/20 text-blue-400',
            packetType === 'FULFILL' && 'bg-green-500/20 text-green-400',
            packetType === 'REJECT' && 'bg-red-500/20 text-red-400'
          )}
        >
          {PACKET_TYPES[packetTypeCode] || packetType}
        </span>
        <span className="text-xs text-muted-foreground">Type {packetTypeCode}</span>
      </div>

      {/* Routing Info */}
      <div className="grid grid-cols-1 gap-4">
        <h4 className="text-xs font-medium text-muted-foreground uppercase">Routing</h4>

        {packetData.from && <PeerField label="From (Sender)" value={packetData.from} />}

        {packetData.to && <PeerField label="To (Next Hop)" value={packetData.to} />}

        {packetData.destination && (
          <Field label="Destination (Final)" value={packetData.destination} mono />
        )}
      </div>

      {/* Common Fields */}
      <div className="grid grid-cols-1 gap-4 border-t border-border pt-4">
        <h4 className="text-xs font-medium text-muted-foreground uppercase">Payment Details</h4>

        {packetData.amount && <Field label="Amount" value={formatAmount(packetData.amount)} />}

        {packetData.packetId && (
          <Field label="Channel ID" value={formatHex(packetData.packetId, 64)} mono />
        )}

        {packetData.source && <Field label="Source (Legacy)" value={packetData.source} />}
      </div>

      {/* Prepare-specific Fields */}
      {packetType === 'PREPARE' && (
        <div className="grid grid-cols-1 gap-4 border-t border-border pt-4">
          <h4 className="text-xs font-medium text-muted-foreground uppercase">Prepare Fields</h4>

          {packetData.executionCondition && (
            <Field
              label="Execution Condition"
              value={
                <span className="font-mono text-xs break-all">
                  {formatHex(packetData.executionCondition, 64)}
                </span>
              }
            />
          )}

          {packetData.expiresAt && <ExpiryCountdownField expiresAt={packetData.expiresAt} />}

          {packetData.dataSize !== undefined && (
            <Field label="Data Size" value={`${packetData.dataSize} bytes`} />
          )}
        </div>
      )}

      {/* Fulfill-specific Fields */}
      {packetType === 'FULFILL' && (
        <div className="grid grid-cols-1 gap-4 border-t border-border pt-4">
          <h4 className="text-xs font-medium text-muted-foreground uppercase">Fulfill Fields</h4>

          {packetData.fulfillment && (
            <Field
              label="Fulfillment"
              value={
                <span className="font-mono text-xs break-all">
                  {formatHex(packetData.fulfillment, 64)}
                </span>
              }
            />
          )}

          {packetData.dataSize !== undefined && (
            <Field label="Data Size" value={`${packetData.dataSize} bytes`} />
          )}
        </div>
      )}

      {/* Reject-specific Fields */}
      {packetType === 'REJECT' && (
        <div className="grid grid-cols-1 gap-4 border-t border-border pt-4">
          <h4 className="text-xs font-medium text-muted-foreground uppercase">Reject Fields</h4>

          {packetData.errorCode && (
            <Field
              label="Error Code"
              value={
                <span className="flex flex-col gap-1">
                  <span className="font-mono text-red-400">{packetData.errorCode}</span>
                  <span className="text-xs text-muted-foreground">
                    {ERROR_CODES[packetData.errorCode] || 'Unknown error'}
                    {packetData.errorCode && ERROR_CATEGORIES[packetData.errorCode[0]] && (
                      <span className="ml-2">({ERROR_CATEGORIES[packetData.errorCode[0]]})</span>
                    )}
                  </span>
                </span>
              }
            />
          )}

          {packetData.triggeredBy && (
            <Field label="Triggered By" value={packetData.triggeredBy} mono />
          )}

          {packetData.errorMessage && <Field label="Message" value={packetData.errorMessage} />}

          {packetData.dataSize !== undefined && (
            <Field label="Data Size" value={`${packetData.dataSize} bytes`} />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Check if an event is a packet event
 */
export function isPacketEvent(event: TelemetryEvent): boolean {
  const type = (event as Record<string, unknown>).type as string;
  return [
    'PACKET_RECEIVED',
    'PACKET_FORWARDED',
    'PACKET_SENT',
    'AGENT_CHANNEL_PAYMENT_SENT',
  ].includes(type);
}

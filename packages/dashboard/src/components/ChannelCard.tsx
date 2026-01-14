/**
 * ChannelCard component - Individual payment channel card for display in PaymentChannelsPanel
 * Shows channel status, deposits, transferred amounts, and settlement timeout
 */

import { useMemo } from 'react';
import type { DashboardChannelState } from '@m2m/shared';
import { Card, CardContent, CardHeader } from './ui/card';
import { Badge } from './ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';

export interface ChannelCardProps {
  /** Channel state to display */
  channel: DashboardChannelState;
}

/**
 * Format balance string for display with commas
 * @param balance - Balance as string (bigint serialized)
 * @returns Formatted balance string
 */
function formatBalance(balance: string): string {
  try {
    // Parse balance as BigInt
    const balanceBigInt = BigInt(balance);
    // Convert to number for display (may lose precision for very large values)
    const balanceNumber = Number(balanceBigInt);
    // Format with commas
    return balanceNumber.toLocaleString('en-US');
  } catch {
    return balance; // Return original if parsing fails
  }
}

/**
 * Format XRP drops as "10000000000 drops (10,000 XRP)"
 * @param drops - XRP amount in drops (string for bigint precision)
 * @returns Formatted string with drops and XRP
 */
function formatXRPAmount(drops: string): string {
  try {
    const dropsNum = BigInt(drops);
    const xrp = Number(dropsNum) / 1_000_000;
    return `${Number(dropsNum).toLocaleString()} drops (${xrp.toLocaleString()} XRP)`;
  } catch {
    return drops;
  }
}

/**
 * ChannelCard component renders individual payment channel information
 */
export const ChannelCard = ({ channel }: ChannelCardProps): JSX.Element => {
  // Calculate time remaining until settlement timeout
  const timeRemaining = useMemo(() => {
    if (channel.status !== 'closing' && channel.status !== 'settling') {
      return null;
    }
    const closedAt = new Date(channel.settledAt || channel.lastActivityAt).getTime();
    const timeoutMs = channel.settlementTimeout * 1000;
    const remainingMs = closedAt + timeoutMs - Date.now();
    const remainingHours = Math.max(0, remainingMs / 1000 / 60 / 60);
    return remainingHours;
  }, [channel.status, channel.settlementTimeout, channel.settledAt, channel.lastActivityAt]);

  // Status badge color mapping
  const statusColorClass = {
    opening: 'bg-yellow-500',
    active: 'bg-green-500',
    closing: 'bg-yellow-500',
    settling: 'bg-yellow-500',
    settled: 'bg-gray-500',
  }[channel.status];

  // Determine settlement method badge (AC: 6)
  const settlementBadge =
    channel.settlementMethod === 'xrp' ? (
      <Badge variant="outline" className="bg-orange-500 text-white">
        🔗 XRP
      </Badge>
    ) : (
      <Badge variant="outline" className="bg-blue-500 text-white">
        🔗 EVM
      </Badge>
    );

  return (
    <Card className={`border-l-4 ${statusColorClass}`}>
      <CardHeader className="pb-3">
        <div className="flex justify-between items-center gap-2">
          <span className="text-sm font-medium text-gray-600">Peer: {channel.peerId}</span>
          <Badge variant="outline" className="text-xs">
            {channel.tokenSymbol}
          </Badge>
          {settlementBadge}
          <Badge className={statusColorClass}>
            {channel.status.charAt(0).toUpperCase() + channel.status.slice(1)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {/* XRP Channel Details with Tooltip (AC: 7) */}
        {channel.settlementMethod === 'xrp' && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="text-xs text-gray-500 cursor-help">
                  Channel ID: {channel.channelId.slice(0, 10)}...{channel.channelId.slice(-6)}
                </div>
              </TooltipTrigger>
              <TooltipContent className="max-w-sm">
                <div className="space-y-1 text-xs">
                  <div>
                    <strong>Channel ID:</strong> {channel.channelId}
                  </div>
                  <div>
                    <strong>Account:</strong> {channel.xrpAccount}
                  </div>
                  <div>
                    <strong>Destination:</strong> {channel.xrpDestination}
                  </div>
                  <div>
                    <strong>Amount:</strong> {formatXRPAmount(channel.xrpAmount || '0')}
                  </div>
                  <div>
                    <strong>Balance:</strong> {formatXRPAmount(channel.xrpBalance || '0')}
                  </div>
                  <div>
                    <strong>Settle Delay:</strong>{' '}
                    {((channel.xrpSettleDelay || 0) / 3600).toFixed(1)} hours
                  </div>
                </div>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}

        {/* EVM Channel Details */}
        {channel.settlementMethod !== 'xrp' && (
          <div className="text-xs text-gray-500">
            Channel ID: {channel.channelId.slice(0, 10)}...{channel.channelId.slice(-6)}
          </div>
        )}

        {/* XRP Amount Display */}
        {channel.settlementMethod === 'xrp' ? (
          <div className="grid grid-cols-2 gap-2 text-sm">
            <div>
              <span className="text-gray-500">Total Amount:</span>
              <div className="font-medium">{formatXRPAmount(channel.xrpAmount || '0')}</div>
            </div>
            <div>
              <span className="text-gray-500">Claimed:</span>
              <div className="font-medium">{formatXRPAmount(channel.xrpBalance || '0')}</div>
            </div>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div>
                <span className="text-gray-500">My Deposit:</span>
                <div className="font-medium">
                  {formatBalance(channel.deposits[channel.participants[0]] || '0')}{' '}
                  {channel.tokenSymbol}
                </div>
              </div>
              <div>
                <span className="text-gray-500">Their Deposit:</span>
                <div className="font-medium">
                  {formatBalance(channel.deposits[channel.participants[1]] || '0')}{' '}
                  {channel.tokenSymbol}
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div>
                <span className="text-gray-500">Transferred:</span>
                <div className="font-medium">
                  {formatBalance(channel.myTransferred)} {channel.tokenSymbol}
                </div>
                <div className="text-xs text-gray-400">Nonce: {channel.myNonce}</div>
              </div>
              <div>
                <span className="text-gray-500">Received:</span>
                <div className="font-medium">
                  {formatBalance(channel.theirTransferred)} {channel.tokenSymbol}
                </div>
                <div className="text-xs text-gray-400">Nonce: {channel.theirNonce}</div>
              </div>
            </div>
          </>
        )}

        {timeRemaining !== null && (
          <div className="text-sm text-yellow-600 font-medium">
            Settlement Timeout: {timeRemaining.toFixed(1)} hours remaining
          </div>
        )}
      </CardContent>
    </Card>
  );
};

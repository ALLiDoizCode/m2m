/**
 * Channel Indicators Component
 * Renders payment channel indicators as overlays on network graph edges
 * Shows status badges and tooltips with channel details
 */

import React, { useEffect, useState, useCallback } from 'react';
import Cytoscape from 'cytoscape';
import { ChannelState } from '../hooks/useChannelState';
import { Badge } from './ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from './ui/tooltip';

export interface ChannelIndicatorsProps {
  channels: Map<string, ChannelState>;
  cyInstance: Cytoscape.Core | null;
  getChannelsByParticipants: (p1: string, p2: string) => ChannelState[];
}

interface IndicatorPosition {
  x: number;
  y: number;
  channelStates: ChannelState[];
  edgeId: string;
}

/**
 * ChannelIndicators component renders badges on network graph edges
 * showing active payment channels between peers
 */
export const ChannelIndicators: React.FC<ChannelIndicatorsProps> = ({
  channels,
  cyInstance,
  getChannelsByParticipants,
}) => {
  const [indicators, setIndicators] = useState<IndicatorPosition[]>([]);

  // Update indicator positions when cytoscape renders or channels change
  const updateIndicatorPositions = useCallback(() => {
    if (!cyInstance) return;

    const newIndicators: IndicatorPosition[] = [];

    // Iterate through all edges in the graph
    cyInstance.edges().forEach((edge) => {
      const sourceId = edge.source().id();
      const targetId = edge.target().id();

      // Check if there are channels between these peers
      const edgeChannels = getChannelsByParticipants(sourceId, targetId);

      if (edgeChannels.length > 0) {
        // Get edge midpoint position in screen coordinates
        const sourcePos = edge.source().renderedPosition();
        const targetPos = edge.target().renderedPosition();
        const midX = (sourcePos.x + targetPos.x) / 2;
        const midY = (sourcePos.y + targetPos.y) / 2;

        newIndicators.push({
          x: midX,
          y: midY,
          channelStates: edgeChannels,
          edgeId: edge.id(),
        });
      }
    });

    setIndicators(newIndicators);
  }, [cyInstance, getChannelsByParticipants]);

  // Listen to cytoscape render events to update positions
  useEffect(() => {
    if (!cyInstance) return;

    updateIndicatorPositions();

    // Update positions on pan, zoom, or layout changes
    cyInstance.on('render', updateIndicatorPositions);
    cyInstance.on('zoom pan', updateIndicatorPositions);

    return () => {
      cyInstance.off('render', updateIndicatorPositions);
      cyInstance.off('zoom pan', updateIndicatorPositions);
    };
  }, [cyInstance, updateIndicatorPositions]);

  // Trigger update when channels change
  useEffect(() => {
    updateIndicatorPositions();
  }, [channels, updateIndicatorPositions]);

  // Helper function to get status color
  const getStatusColor = (status: ChannelState['status']): string => {
    switch (status) {
      case 'active':
        return 'bg-green-500';
      case 'settling':
        return 'bg-yellow-500';
      case 'disputed':
        return 'bg-red-500';
      case 'settled':
        return 'bg-gray-500';
      default:
        return 'bg-gray-400';
    }
  };

  // Helper function to format bigint strings with token symbol
  const formatAmount = (amount: string, tokenSymbol: string): string => {
    // Convert bigint string to number (assumes 18 decimals for display)
    const numAmount = Number(BigInt(amount)) / 1e18;
    return `${numAmount.toFixed(4)} ${tokenSymbol}`;
  };

  // Helper function to format time remaining
  const formatTimeRemaining = (openedAt: number, settlementTimeout: number): string => {
    const now = Date.now();
    const elapsed = (now - openedAt) / 1000; // seconds
    const remaining = settlementTimeout - elapsed;

    if (remaining <= 0) return 'Expired';

    const hours = Math.floor(remaining / 3600);
    const minutes = Math.floor((remaining % 3600) / 60);

    return `${hours}h ${minutes}m remaining`;
  };

  if (!cyInstance || indicators.length === 0) return null;

  return (
    <TooltipProvider>
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
        }}
      >
        {indicators.map((indicator, index) => (
          <div
            key={`${indicator.edgeId}-${index}`}
            style={{
              position: 'absolute',
              left: indicator.x,
              top: indicator.y,
              transform: 'translate(-50%, -50%)',
              pointerEvents: 'auto',
            }}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex gap-1">
                  {indicator.channelStates.map((channel) => (
                    <Badge
                      key={channel.channelId}
                      className={`${getStatusColor(channel.status)} text-white text-xs px-1.5 py-0.5`}
                    >
                      🔗
                    </Badge>
                  ))}
                </div>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs">
                <div className="space-y-2">
                  {indicator.channelStates.map((channel) => (
                    <div key={channel.channelId} className="text-xs space-y-1">
                      <div className="font-semibold">
                        Channel: {channel.channelId.substring(0, 10)}...
                      </div>
                      <div>Token: {channel.tokenSymbol}</div>
                      <div>
                        My Deposit:{' '}
                        {formatAmount(
                          channel.initialDeposits[channel.participants[0]] || '0',
                          channel.tokenSymbol
                        )}
                      </div>
                      <div>
                        Transferred:{' '}
                        {formatAmount(channel.currentBalances.myTransferred, channel.tokenSymbol)}{' '}
                        (Nonce: {channel.currentBalances.myNonce})
                      </div>
                      <div>
                        Settlement Timeout:{' '}
                        {channel.status === 'settled'
                          ? 'Settled'
                          : formatTimeRemaining(channel.openedAt, channel.settlementTimeout)}
                      </div>
                      <div>
                        Status:{' '}
                        <span
                          className={`inline-block w-2 h-2 rounded-full ${getStatusColor(channel.status)}`}
                        />{' '}
                        {channel.status.charAt(0).toUpperCase() + channel.status.slice(1)}
                      </div>
                    </div>
                  ))}
                </div>
              </TooltipContent>
            </Tooltip>
          </div>
        ))}
      </div>
    </TooltipProvider>
  );
};

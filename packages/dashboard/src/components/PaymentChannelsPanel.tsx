/**
 * PaymentChannelsPanel component - Display all active payment channels with filtering
 * Shows channel cards for all channels received from telemetry
 */

import { useState, useMemo } from 'react';
import type { DashboardChannelState } from '@m2m/shared';
import { ChannelCard } from './ChannelCard';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Input } from './ui/input';

export interface PaymentChannelsPanelProps {
  /** List of payment channels to display */
  channels: DashboardChannelState[];
}

/**
 * PaymentChannelsPanel component renders payment channel list with filters
 */
export const PaymentChannelsPanel = ({ channels }: PaymentChannelsPanelProps): JSX.Element => {
  const [filterPeer, setFilterPeer] = useState<string>('');
  const [filterToken, setFilterToken] = useState<string>('');

  // Filter channels based on peer and token filters
  const filteredChannels = useMemo(() => {
    return channels.filter((channel) => {
      const peerMatch =
        !filterPeer || channel.peerId.toLowerCase().includes(filterPeer.toLowerCase());
      const tokenMatch =
        !filterToken || channel.tokenSymbol.toLowerCase().includes(filterToken.toLowerCase());
      return peerMatch && tokenMatch;
    });
  }, [channels, filterPeer, filterToken]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Payment Channels ({channels.length})</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Filter inputs */}
        <div className="flex gap-4">
          <Input
            type="text"
            placeholder="Filter by peer..."
            value={filterPeer}
            onChange={(e) => setFilterPeer(e.target.value)}
            className="flex-1"
          />
          <Input
            type="text"
            placeholder="Filter by token..."
            value={filterToken}
            onChange={(e) => setFilterToken(e.target.value)}
            className="flex-1"
          />
        </div>

        {/* Channel list */}
        <div className="space-y-3">
          {filteredChannels.length === 0 ? (
            <div className="text-center text-gray-400 py-8">
              {channels.length === 0
                ? 'No payment channels open'
                : 'No channels match filter criteria'}
            </div>
          ) : (
            filteredChannels.map((channel) => (
              <ChannelCard key={channel.channelId} channel={channel} />
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
};

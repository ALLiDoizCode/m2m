/**
 * Payment Channels Panel Component
 * Displays list of all active payment channels with filtering capabilities
 */

import React, { useState, useMemo } from 'react';
import { ChannelState } from '../hooks/useChannelState';
import { Badge } from './ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Input } from './ui/input';

export interface PaymentChannelsPanelProps {
  channels: ChannelState[];
  connected: boolean;
}

/**
 * PaymentChannelsPanel displays all payment channels in a filterable table
 */
export const PaymentChannelsPanel: React.FC<PaymentChannelsPanelProps> = ({
  channels,
  connected,
}) => {
  const [tokenFilter, setTokenFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [peerFilter, setPeerFilter] = useState<string>('');
  const [expandedChannel, setExpandedChannel] = useState<string | null>(null);

  // Extract unique tokens from channels
  const uniqueTokens = useMemo(() => {
    const tokens = new Set<string>();
    channels.forEach((channel) => tokens.add(channel.tokenSymbol));
    return Array.from(tokens).sort();
  }, [channels]);

  // Filter channels based on selected filters
  const filteredChannels = useMemo(() => {
    return channels.filter((channel) => {
      // Token filter
      if (tokenFilter !== 'all' && channel.tokenSymbol !== tokenFilter) {
        return false;
      }

      // Status filter
      if (statusFilter !== 'all' && channel.status !== statusFilter) {
        return false;
      }

      // Peer filter (search in participants)
      if (peerFilter) {
        const peerMatch = channel.participants.some((p) =>
          p.toLowerCase().includes(peerFilter.toLowerCase())
        );
        if (!peerMatch) return false;
      }

      return true;
    });
  }, [channels, tokenFilter, statusFilter, peerFilter]);

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

    return `${hours}h ${minutes}m`;
  };

  // Toggle channel expansion
  const toggleExpanded = (channelId: string) => {
    setExpandedChannel(expandedChannel === channelId ? null : channelId);
  };

  return (
    <Card className="bg-gray-800 border-gray-700">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Payment Channels
          <Badge variant="outline" className="ml-2">
            {filteredChannels.length}
          </Badge>
        </CardTitle>
        {!connected && <div className="text-sm text-red-400">Telemetry not connected</div>}
      </CardHeader>
      <CardContent>
        {/* Filters */}
        <div className="flex gap-4 mb-4 flex-wrap">
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-400">Token:</label>
            <Select value={tokenFilter} onValueChange={setTokenFilter}>
              <SelectTrigger className="w-[120px]">
                <SelectValue placeholder="All" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                {uniqueTokens.map((token) => (
                  <SelectItem key={token} value={token}>
                    {token}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-400">Status:</label>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[120px]">
                <SelectValue placeholder="All" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="settling">Settling</SelectItem>
                <SelectItem value="settled">Settled</SelectItem>
                <SelectItem value="disputed">Disputed</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-400">Peer:</label>
            <Input
              type="text"
              placeholder="Search by address..."
              value={peerFilter}
              onChange={(e) => setPeerFilter(e.target.value)}
              className="w-[200px] text-sm"
            />
          </div>
        </div>

        {/* Channels Table */}
        {filteredChannels.length === 0 ? (
          <div className="text-center py-8 text-gray-400">
            {channels.length === 0
              ? 'No payment channels found. Waiting for channel events...'
              : 'No channels match the current filters.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Peer</TableHead>
                  <TableHead>Token</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Channel ID</TableHead>
                  <TableHead>My Deposit</TableHead>
                  <TableHead>Transferred</TableHead>
                  <TableHead>Settlement</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredChannels.map((channel) => (
                  <React.Fragment key={channel.channelId}>
                    <TableRow
                      className="cursor-pointer hover:bg-gray-700/50"
                      onClick={() => toggleExpanded(channel.channelId)}
                    >
                      <TableCell className="font-medium">
                        {channel.participants[1].substring(0, 10)}...
                      </TableCell>
                      <TableCell>{channel.tokenSymbol}</TableCell>
                      <TableCell>
                        <Badge className={`${getStatusColor(channel.status)} text-white`}>
                          {channel.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {channel.channelId.substring(0, 10)}...
                      </TableCell>
                      <TableCell>
                        {formatAmount(
                          channel.initialDeposits[channel.participants[0]] || '0',
                          channel.tokenSymbol
                        )}
                      </TableCell>
                      <TableCell>
                        {formatAmount(channel.currentBalances.myTransferred, channel.tokenSymbol)}{' '}
                        (N:{channel.currentBalances.myNonce})
                      </TableCell>
                      <TableCell>
                        {channel.status === 'settled'
                          ? 'Settled'
                          : formatTimeRemaining(channel.openedAt, channel.settlementTimeout)}
                      </TableCell>
                    </TableRow>
                    {expandedChannel === channel.channelId && (
                      <TableRow>
                        <TableCell colSpan={7} className="bg-gray-900/50">
                          <div className="p-4 space-y-2 text-sm">
                            <div className="grid grid-cols-2 gap-4">
                              <div>
                                <div className="font-semibold text-gray-300">Full Channel ID:</div>
                                <div className="font-mono text-xs text-gray-400">
                                  {channel.channelId}
                                </div>
                              </div>
                              <div>
                                <div className="font-semibold text-gray-300">Token Address:</div>
                                <div className="font-mono text-xs text-gray-400">
                                  {channel.tokenAddress}
                                </div>
                              </div>
                              <div>
                                <div className="font-semibold text-gray-300">Participant 1:</div>
                                <div className="font-mono text-xs text-gray-400">
                                  {channel.participants[0]}
                                </div>
                                <div className="text-xs text-gray-500">
                                  Deposit:{' '}
                                  {formatAmount(
                                    channel.initialDeposits[channel.participants[0]] || '0',
                                    channel.tokenSymbol
                                  )}
                                </div>
                              </div>
                              <div>
                                <div className="font-semibold text-gray-300">Participant 2:</div>
                                <div className="font-mono text-xs text-gray-400">
                                  {channel.participants[1]}
                                </div>
                                <div className="text-xs text-gray-500">
                                  Deposit:{' '}
                                  {formatAmount(
                                    channel.initialDeposits[channel.participants[1]] || '0',
                                    channel.tokenSymbol
                                  )}
                                </div>
                              </div>
                              <div>
                                <div className="font-semibold text-gray-300">My Balance:</div>
                                <div className="text-gray-400">
                                  Nonce: {channel.currentBalances.myNonce}, Transferred:{' '}
                                  {formatAmount(
                                    channel.currentBalances.myTransferred,
                                    channel.tokenSymbol
                                  )}
                                </div>
                              </div>
                              <div>
                                <div className="font-semibold text-gray-300">Their Balance:</div>
                                <div className="text-gray-400">
                                  Nonce: {channel.currentBalances.theirNonce}, Transferred:{' '}
                                  {formatAmount(
                                    channel.currentBalances.theirTransferred,
                                    channel.tokenSymbol
                                  )}
                                </div>
                              </div>
                              <div>
                                <div className="font-semibold text-gray-300">Opened:</div>
                                <div className="text-gray-400">
                                  {new Date(channel.openedAt).toLocaleString()}
                                </div>
                              </div>
                              {channel.settledAt && (
                                <div>
                                  <div className="font-semibold text-gray-300">Settled:</div>
                                  <div className="text-gray-400">
                                    {new Date(channel.settledAt).toLocaleString()} (
                                    {channel.settlementType})
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </React.Fragment>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

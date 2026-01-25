import { Wallet, AlertTriangle, Link2, Users } from 'lucide-react';
import { useAccountBalances } from '@/hooks/useAccountBalances';
import { usePaymentChannels } from '@/hooks/usePaymentChannels';
import { AccountCard } from './AccountCard';
import { PaymentChannelCard } from './PaymentChannelCard';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * AccountsView component - displays peer account balances and settlement status
 * Story 14.6: Settlement and Balance Visualization
 */
export function AccountsView() {
  const { accounts, status, totalAccounts, nearThresholdCount } = useAccountBalances();

  const { channels, activeChannelCount } = usePaymentChannels();

  // Merge channel info into accounts
  const accountsWithChannels = accounts.map((account) => {
    const accountChannels = channels.filter(
      (ch) => ch.peerId === account.peerId && ch.status === 'active'
    );
    const hasActiveChannel = accountChannels.length > 0;
    const channelType = hasActiveChannel ? accountChannels[0].settlementMethod || 'evm' : undefined;

    return {
      ...account,
      hasActiveChannel,
      channelType,
    };
  });

  // Empty state
  if (totalAccounts === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
        <Wallet className="h-12 w-12 mb-4 opacity-50" />
        <p className="text-lg font-medium">No peer accounts yet</p>
        <p className="text-sm mt-1">
          Balance events will appear as packets flow through the connector.
        </p>
        {status === 'connecting' && (
          <p className="text-xs mt-4 animate-pulse">Connecting to event stream...</p>
        )}
        {status === 'error' && (
          <p className="text-xs mt-4 text-destructive">
            Failed to connect to event stream. Please check the connector is running.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="py-3">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Users className="h-4 w-4" />
              Total Accounts
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalAccounts}</div>
          </CardContent>
        </Card>

        <Card className="py-3">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              Near Threshold
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div
              className={`text-2xl font-bold ${nearThresholdCount > 0 ? 'text-yellow-500' : ''}`}
            >
              {nearThresholdCount}
            </div>
            <p className="text-xs text-muted-foreground">&gt;70% of settlement threshold</p>
          </CardContent>
        </Card>

        <Card className="py-3">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Link2 className="h-4 w-4" />
              Active Channels
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div
              className={`text-2xl font-bold ${activeChannelCount > 0 ? 'text-emerald-500' : ''}`}
            >
              {activeChannelCount}
            </div>
            <p className="text-xs text-muted-foreground">Payment channels open</p>
          </CardContent>
        </Card>
      </div>

      {/* Account Cards Grid */}
      <div>
        <h3 className="text-sm font-medium text-muted-foreground mb-3">Peer Accounts</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {accountsWithChannels.map((account) => (
            <AccountCard
              key={`${account.peerId}:${account.tokenId}`}
              peerId={account.peerId}
              tokenId={account.tokenId}
              debitBalance={account.debitBalance}
              creditBalance={account.creditBalance}
              netBalance={account.netBalance}
              creditLimit={account.creditLimit}
              settlementThreshold={account.settlementThreshold}
              settlementState={account.settlementState}
              balanceHistory={account.balanceHistory}
              hasActiveChannel={account.hasActiveChannel}
              channelType={account.channelType}
            />
          ))}
        </div>
      </div>

      {/* Payment Channels Section */}
      {channels.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-muted-foreground mb-3">Payment Channels</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {channels.map((channel) => (
              <PaymentChannelCard key={channel.channelId} channel={channel} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

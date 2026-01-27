import * as React from 'react';
import { Wallet, AlertTriangle, Link2, Users } from 'lucide-react';
import { useAccountBalances } from '@/hooks/useAccountBalances';
import { usePaymentChannels } from '@/hooks/usePaymentChannels';
import { useWalletBalances } from '@/hooks/useWalletBalances';
import { AccountCard } from './AccountCard';
import { PaymentChannelCard } from './PaymentChannelCard';
import { WalletOverview } from './WalletOverview';

/**
 * AccountsView component - displays peer account balances and settlement status
 * Story 14.6: Settlement and Balance Visualization
 * Story 15.2: Performance optimized with React.memo and useMemo
 */
export const AccountsView = React.memo(function AccountsView() {
  const {
    accounts,
    status: accountsStatus,
    totalAccounts,
    nearThresholdCount,
  } = useAccountBalances();
  const { channels, status: channelsStatus, activeChannelCount } = usePaymentChannels();
  const {
    data: walletData,
    loading: walletLoading,
    lastUpdated: walletLastUpdated,
    refresh: refreshWallet,
  } = useWalletBalances();

  // Merge channel info into accounts - memoized to avoid recomputation on unrelated re-renders
  const accountsWithChannels = React.useMemo(
    () =>
      accounts.map((account) => {
        const accountChannels = channels.filter(
          (ch) => ch.peerId === account.peerId && ch.status === 'active'
        );
        const hasActiveChannel = accountChannels.length > 0;
        const channelType = hasActiveChannel
          ? accountChannels[0].settlementMethod || 'evm'
          : undefined;

        return {
          ...account,
          hasActiveChannel,
          channelType,
        };
      }),
    [accounts, channels]
  );

  const isLoading =
    accountsStatus === 'hydrating' ||
    accountsStatus === 'connecting' ||
    channelsStatus === 'hydrating' ||
    channelsStatus === 'connecting';

  // If no peer accounts and no wallet data, show skeleton or empty state
  if (totalAccounts === 0 && channels.length === 0 && !walletData) {
    // Show skeleton loaders while hydrating or connecting
    if (isLoading) {
      return (
        <div className="space-y-6">
          {/* Skeleton summary stats */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="rounded-lg border border-border bg-card pl-0 overflow-hidden">
                <div className="flex items-stretch">
                  <div className="w-1 bg-muted animate-pulse shrink-0" />
                  <div className="flex items-center gap-3 px-4 py-3">
                    <div className="h-5 w-5 bg-muted animate-pulse rounded" />
                    <div>
                      <div className="h-7 w-10 bg-muted animate-pulse rounded mb-1" />
                      <div className="h-3 w-20 bg-muted animate-pulse rounded" />
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
          {/* Skeleton account cards */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="rounded-lg border border-border bg-card p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="h-4 w-28 bg-muted animate-pulse rounded" />
                  <div className="h-5 w-12 bg-muted animate-pulse rounded" />
                </div>
                <div className="h-4 w-16 bg-muted animate-pulse rounded" />
                <div className="grid grid-cols-3 gap-2">
                  {Array.from({ length: 3 }).map((_, j) => (
                    <div key={j} className="text-center space-y-1">
                      <div className="h-3 w-12 bg-muted animate-pulse rounded mx-auto" />
                      <div className="h-4 w-10 bg-muted animate-pulse rounded mx-auto" />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      );
    }

    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
        <Wallet className="h-12 w-12 mb-4 opacity-50" />
        <p className="text-lg font-medium">No peer accounts yet</p>
        <p className="text-sm mt-1">
          Balance events will appear as packets flow through the connector.
        </p>
        {accountsStatus === 'error' && (
          <p className="text-xs mt-4 text-destructive">
            Failed to connect to event stream. Please check the connector is running.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* On-Chain Wallet Panel */}
      {walletLoading && !walletData ? (
        <div className="rounded-lg border border-border bg-card p-4 space-y-4">
          <div className="flex items-center justify-between">
            <div className="h-4 w-32 bg-muted animate-pulse rounded" />
            <div className="h-3 w-20 bg-muted animate-pulse rounded" />
          </div>
          <div className="h-3 w-48 bg-muted animate-pulse rounded" />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="rounded-lg border p-3 space-y-2">
                <div className="h-3 w-12 bg-muted animate-pulse rounded" />
                <div className="h-6 w-24 bg-muted animate-pulse rounded" />
              </div>
            ))}
          </div>
        </div>
      ) : walletData ? (
        <WalletOverview
          data={walletData}
          lastUpdated={walletLastUpdated}
          onRefresh={refreshWallet}
        />
      ) : null}

      {/* Summary Stats */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="rounded-lg border border-border bg-card pl-0 overflow-hidden hover:border-primary/30 transition-colors">
          <div className="flex items-stretch">
            <div className="w-1 bg-blue-500 shrink-0" />
            <div className="flex items-center gap-3 px-4 py-3">
              <Users className="h-5 w-5 text-blue-500 shrink-0" />
              <div>
                <div className="text-2xl font-bold leading-tight">{totalAccounts}</div>
                <div className="text-xs text-muted-foreground mt-0.5">Total Accounts</div>
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card pl-0 overflow-hidden hover:border-primary/30 transition-colors">
          <div className="flex items-stretch">
            <div
              className={`w-1 shrink-0 ${nearThresholdCount > 0 ? 'bg-yellow-500' : 'bg-yellow-500/50'}`}
            />
            <div className="flex items-center gap-3 px-4 py-3">
              <AlertTriangle
                className={`h-5 w-5 shrink-0 ${nearThresholdCount > 0 ? 'text-yellow-500' : 'text-yellow-500/50'}`}
              />
              <div>
                <div
                  className={`text-2xl font-bold leading-tight ${nearThresholdCount > 0 ? 'text-yellow-500' : ''}`}
                >
                  {nearThresholdCount}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">Near Threshold</div>
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card pl-0 overflow-hidden hover:border-primary/30 transition-colors">
          <div className="flex items-stretch">
            <div
              className={`w-1 shrink-0 ${activeChannelCount > 0 ? 'bg-emerald-500' : 'bg-emerald-500/50'}`}
            />
            <div className="flex items-center gap-3 px-4 py-3">
              <Link2
                className={`h-5 w-5 shrink-0 ${activeChannelCount > 0 ? 'text-emerald-500' : 'text-emerald-500/50'}`}
              />
              <div>
                <div
                  className={`text-2xl font-bold leading-tight ${activeChannelCount > 0 ? 'text-emerald-500' : ''}`}
                >
                  {activeChannelCount}
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">Active Channels</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Account Cards Grid */}
      {accountsWithChannels.length > 0 && (
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
      )}

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
});

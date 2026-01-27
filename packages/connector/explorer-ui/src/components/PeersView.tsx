import * as React from 'react';
import { Network, Copy, Check } from 'lucide-react';
import { usePeers, PeerInfo } from '@/hooks/usePeers';
import { useRoutingTable, RoutingEntry } from '@/hooks/useRoutingTable';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/**
 * Truncate an address string for display (first 6 + last 4 chars).
 */
function truncateAddress(address: string): string {
  if (address.length <= 14) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * CopyButton — click-to-copy with brief checkmark feedback.
 */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable — ignore silently
    }
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      className="inline-flex items-center text-muted-foreground hover:text-foreground transition-colors"
      title={`Copy: ${text}`}
    >
      {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

/**
 * PeerCard — displays a single peer's information.
 */
const PeerCard = React.memo(function PeerCard({ peer, id }: { peer: PeerInfo; id: string }) {
  return (
    <Card
      id={id}
      className="rounded-lg border border-border bg-card p-4 space-y-3 hover:border-primary/50 transition-colors"
    >
      {/* Peer ID + Connection Status */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full shrink-0 ${peer.connected ? 'bg-green-500' : 'bg-gray-500'}`}
          />
          <span className="font-mono text-sm font-medium truncate">
            {peer.petname || peer.peerId}
          </span>
        </div>
        <Badge variant={peer.connected ? 'default' : 'secondary'} className="text-xs">
          {peer.connected ? 'Connected' : 'Disconnected'}
        </Badge>
      </div>

      {/* ILP Address */}
      {peer.ilpAddress && (
        <div className="space-y-0.5">
          <div className="text-xs text-muted-foreground">ILP Address</div>
          <div className="flex items-center gap-1">
            <span className="font-mono text-xs break-all">{peer.ilpAddress}</span>
            <CopyButton text={peer.ilpAddress} />
          </div>
        </div>
      )}

      {/* EVM Address */}
      {peer.evmAddress && (
        <div className="space-y-0.5">
          <div className="text-xs text-muted-foreground">EVM Address</div>
          <div className="flex items-center gap-1">
            <span className="font-mono text-xs" title={peer.evmAddress}>
              {truncateAddress(peer.evmAddress)}
            </span>
            <CopyButton text={peer.evmAddress} />
          </div>
        </div>
      )}

      {/* XRP Address */}
      {peer.xrpAddress && (
        <div className="space-y-0.5">
          <div className="text-xs text-muted-foreground">XRP Address</div>
          <div className="flex items-center gap-1">
            <span className="font-mono text-xs" title={peer.xrpAddress}>
              {truncateAddress(peer.xrpAddress)}
            </span>
            <CopyButton text={peer.xrpAddress} />
          </div>
        </div>
      )}

      {/* Pubkey (if different from petname/peerId) */}
      {peer.pubkey && (
        <div className="space-y-0.5">
          <div className="text-xs text-muted-foreground">Pubkey</div>
          <div className="flex items-center gap-1">
            <span className="font-mono text-xs" title={peer.pubkey}>
              {truncateAddress(peer.pubkey)}
            </span>
            <CopyButton text={peer.pubkey} />
          </div>
        </div>
      )}
    </Card>
  );
});

/**
 * RoutingTable — displays routing table entries.
 */
const RoutingTableView = React.memo(function RoutingTableView({
  routes,
  onPeerClick,
}: {
  routes: RoutingEntry[];
  onPeerClick: (peerId: string) => void;
}) {
  const sorted = React.useMemo(
    () => [...routes].sort((a, b) => a.prefix.localeCompare(b.prefix)),
    [routes]
  );

  if (sorted.length === 0) {
    return <p className="text-sm text-muted-foreground py-4">No routing entries configured</p>;
  }

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[50%]">Prefix</TableHead>
            <TableHead className="w-[35%]">Next Hop</TableHead>
            <TableHead className="w-[15%] text-right">Priority</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((route, idx) => (
            <TableRow key={`${route.prefix}-${idx}`}>
              <TableCell className="font-mono text-xs">{route.prefix}</TableCell>
              <TableCell>
                <button
                  className="font-mono text-xs text-blue-400 hover:text-blue-300 hover:underline transition-colors"
                  onClick={() => onPeerClick(route.nextHop)}
                >
                  {route.nextHop}
                </button>
              </TableCell>
              <TableCell className="text-right text-xs text-muted-foreground">
                {route.priority !== undefined ? route.priority : '—'}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
});

/**
 * PeersView — main component showing connected peers and routing table.
 * Story 15.6: Peers & Routing Table View
 */
export const PeersView = React.memo(function PeersView() {
  const { peers, loading: peersLoading, error: peersError } = usePeers();
  const { routes, loading: routesLoading } = useRoutingTable();

  const isLoading = peersLoading || routesLoading;

  const handlePeerClick = React.useCallback((peerId: string) => {
    // Find the peer card element and scroll to it
    const el = document.getElementById(`peer-card-${peerId}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Brief highlight effect
      el.classList.add('ring-2', 'ring-primary');
      setTimeout(() => el.classList.remove('ring-2', 'ring-primary'), 2000);
    }
  }, []);

  // Loading state
  if (isLoading && peers.length === 0 && routes.length === 0) {
    return (
      <div className="space-y-6">
        {/* Skeleton peer cards */}
        <div>
          <div className="h-4 w-32 bg-muted animate-pulse rounded mb-3" />
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="rounded-lg border border-border bg-card p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="h-2 w-2 bg-muted animate-pulse rounded-full" />
                    <div className="h-4 w-24 bg-muted animate-pulse rounded" />
                  </div>
                  <div className="h-5 w-16 bg-muted animate-pulse rounded" />
                </div>
                <div className="space-y-2">
                  <div className="h-3 w-12 bg-muted animate-pulse rounded" />
                  <div className="h-3 w-40 bg-muted animate-pulse rounded" />
                </div>
                <div className="space-y-2">
                  <div className="h-3 w-16 bg-muted animate-pulse rounded" />
                  <div className="h-3 w-28 bg-muted animate-pulse rounded" />
                </div>
              </div>
            ))}
          </div>
        </div>
        {/* Skeleton routing table */}
        <div>
          <div className="h-4 w-28 bg-muted animate-pulse rounded mb-3" />
          <div className="rounded-lg border border-border p-4 space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-4 w-full bg-muted animate-pulse rounded" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Empty state
  if (peers.length === 0 && routes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
        <Network className="h-12 w-12 mb-4 opacity-50" />
        <p className="text-lg font-medium">No peers connected yet</p>
        <p className="text-sm mt-1">Waiting for BTP connections...</p>
        {peersError && (
          <p className="text-xs mt-4 text-destructive">
            Failed to fetch peer data. Please check the connector is running.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Connected Peers */}
      <div>
        <h3 className="text-sm font-medium text-muted-foreground mb-3">
          Connected Peers ({peers.length})
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {peers.map((peer) => (
            <PeerCard
              key={peer.peerId}
              peer={peer}
              id={`peer-card-${peer.petname || peer.peerId}`}
            />
          ))}
        </div>
      </div>

      {/* Routing Table */}
      <div>
        <h3 className="text-sm font-medium text-muted-foreground mb-3">
          Routing Table ({routes.length} entries)
        </h3>
        <RoutingTableView routes={routes} onPeerClick={handlePeerClick} />
      </div>
    </div>
  );
});

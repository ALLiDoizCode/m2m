import * as React from 'react';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TelemetryEvent, StoredEvent, formatRelativeTime } from '@/lib/event-types';
import { JsonViewer } from './JsonViewer';
import { PacketInspector, isPacketEvent } from './PacketInspector';
import { ToonViewer, hasNostrEvent } from './ToonViewer';
import { useRelatedEvents, hasPacketId } from '@/hooks/useRelatedEvents';
import { CopyButton, AddressField, AmountField, PeerField } from './FieldDisplay';
import { Badge } from '@/components/ui/badge';
import { Loader2, ExternalLink } from 'lucide-react';
import { useMediaQuery } from '@/hooks/useMediaQuery';

export interface EventDetailPanelProps {
  event: TelemetryEvent | StoredEvent | null;
  onClose: () => void;
  onEventSelect?: (event: StoredEvent) => void;
}

// localStorage key for remembering last tab
const LAST_TAB_KEY = 'explorer-detail-panel-tab';

/**
 * Extract display data from either TelemetryEvent or StoredEvent
 */
function getDisplayData(event: TelemetryEvent | StoredEvent | null) {
  if (!event) return null;

  // Check if it's a StoredEvent (has 'payload' property)
  if ('payload' in event && event.payload) {
    const stored = event as StoredEvent;
    return {
      type: stored.event_type,
      timestamp: stored.timestamp,
      nodeId: stored.node_id,
      peerId: stored.peer_id,
      packetId: stored.packet_id,
      amount: stored.amount,
      destination: stored.destination,
      payload: stored.payload,
      id: stored.id,
      direction: stored.direction,
    };
  }

  // It's a TelemetryEvent
  const telemetry = event as TelemetryEvent;
  return {
    type: telemetry.type,
    timestamp:
      typeof telemetry.timestamp === 'string'
        ? new Date(telemetry.timestamp).getTime()
        : telemetry.timestamp,
    nodeId: telemetry.nodeId,
    peerId: telemetry.peerId,
    packetId: (telemetry as Record<string, unknown>).packetId as string | undefined,
    amount: (telemetry as Record<string, unknown>).amount as string | undefined,
    destination: (telemetry as Record<string, unknown>).destination as string | undefined,
    payload: telemetry,
    id: undefined,
    direction: (telemetry as Record<string, unknown>).direction as string | undefined,
  };
}

/**
 * RelatedEventsTab - Display related events with click navigation
 */
function RelatedEventsTab({
  event,
  onEventSelect,
}: {
  event: TelemetryEvent | StoredEvent;
  onEventSelect?: (event: StoredEvent) => void;
}) {
  const { relatedEvents, loading, error, refresh } = useRelatedEvents(event);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 text-sm text-red-400">
        <p>Failed to load related events: {error}</p>
        <button
          onClick={refresh}
          className="mt-2 text-xs underline hover:no-underline transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-background rounded"
        >
          Try again
        </button>
      </div>
    );
  }

  if (relatedEvents.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        No related events found for this packet.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-4">
      <p className="text-xs text-muted-foreground mb-2">
        Found {relatedEvents.length} related event{relatedEvents.length !== 1 ? 's' : ''}
      </p>
      {relatedEvents.map((related) => (
        <button
          key={related.id}
          onClick={() => onEventSelect?.(related)}
          className="flex items-center justify-between p-3 rounded-md border border-border hover:bg-muted/50 transition-colors text-left focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-background"
        >
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-xs">
                {related.event_type}
              </Badge>
              {related.direction && (
                <span className="text-xs text-muted-foreground">{related.direction}</span>
              )}
            </div>
            <span className="text-xs text-muted-foreground">
              {formatRelativeTime(related.timestamp)}
            </span>
          </div>
          <ExternalLink className="w-4 h-4 text-muted-foreground" />
        </button>
      ))}
    </div>
  );
}

/**
 * EventDetailPanel - Slide-out panel showing comprehensive event information
 *
 * Tabs:
 * - Raw: JSON with syntax highlighting
 * - ILP Packet: Decoded packet fields (for packet events)
 * - TOON: Nostr event viewer (when TOON data detected)
 * - Related: Links to related events
 */
/**
 * Shared content rendered in both Dialog and Sheet modes
 */
function DetailPanelContent({
  displayData,
  selectedTab,
  handleTabChange,
  showPacketTab,
  showToonTab,
  showRelatedTab,
  event,
  onEventSelect,
}: {
  displayData: ReturnType<typeof getDisplayData>;
  selectedTab: string;
  handleTabChange: (value: string) => void;
  showPacketTab: boolean;
  showToonTab: boolean;
  showRelatedTab: boolean;
  event: TelemetryEvent | StoredEvent;
  onEventSelect?: (event: StoredEvent) => void;
}) {
  if (!displayData) return null;

  return (
    <div className="flex flex-col gap-4 flex-1 overflow-hidden">
      {/* Event metadata summary */}
      <div className="grid grid-cols-2 gap-3 px-4 shrink-0">
        {displayData.nodeId && (
          <div className="col-span-2">
            <AddressField label="Node" value={displayData.nodeId} />
          </div>
        )}
        {displayData.peerId && <PeerField label="Peer" value={displayData.peerId} />}
        {displayData.packetId && <AddressField label="Packet ID" value={displayData.packetId} />}
        {displayData.amount && <AmountField label="Amount" value={displayData.amount} />}
        {displayData.destination && (
          <div className="col-span-2">
            <AddressField label="Destination" value={displayData.destination} />
          </div>
        )}
      </div>

      {/* Tabs */}
      <Tabs
        value={selectedTab}
        onValueChange={handleTabChange}
        className="flex-1 flex flex-col overflow-hidden"
      >
        <TabsList className="mx-4 shrink-0">
          <TabsTrigger value="raw">Raw</TabsTrigger>
          {showPacketTab && <TabsTrigger value="packet">ILP Packet</TabsTrigger>}
          {showToonTab && <TabsTrigger value="toon">TOON</TabsTrigger>}
          {showRelatedTab && <TabsTrigger value="related">Related</TabsTrigger>}
        </TabsList>

        <div className="flex-1 overflow-y-auto">
          <TabsContent value="raw" className="mt-0 p-4">
            <div className="flex justify-end mb-2">
              <CopyButton value={JSON.stringify(displayData.payload, null, 2)} label="Copy JSON" />
            </div>
            <JsonViewer data={displayData.payload} />
          </TabsContent>

          {showPacketTab && (
            <TabsContent value="packet" className="mt-0">
              <PacketInspector event={displayData.payload as TelemetryEvent} />
            </TabsContent>
          )}

          {showToonTab && (
            <TabsContent value="toon" className="mt-0">
              <ToonViewer data={displayData.payload} />
            </TabsContent>
          )}

          {showRelatedTab && (
            <TabsContent value="related" className="mt-0">
              <RelatedEventsTab event={event} onEventSelect={onEventSelect} />
            </TabsContent>
          )}
        </div>
      </Tabs>
    </div>
  );
}

export function EventDetailPanel({ event, onClose, onEventSelect }: EventDetailPanelProps) {
  const isDesktop = useMediaQuery('(min-width: 768px)');

  // Remember last selected tab
  const [selectedTab, setSelectedTab] = React.useState(() => {
    try {
      return localStorage.getItem(LAST_TAB_KEY) || 'raw';
    } catch {
      return 'raw';
    }
  });

  // Handle keyboard escape
  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && event) {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [event, onClose]);

  // Save tab selection to localStorage
  const handleTabChange = (value: string) => {
    setSelectedTab(value);
    try {
      localStorage.setItem(LAST_TAB_KEY, value);
    } catch {
      // localStorage not available
    }
  };

  const displayData = getDisplayData(event);

  // Determine which tabs to show
  const showPacketTab = event && isPacketEvent(displayData?.payload as TelemetryEvent);
  const showToonTab = event && hasNostrEvent(displayData?.payload);
  const showRelatedTab = event && hasPacketId(event);

  // If current tab is not available, switch to raw
  React.useEffect(() => {
    if (!event) return;
    if (selectedTab === 'packet' && !showPacketTab) setSelectedTab('raw');
    if (selectedTab === 'toon' && !showToonTab) setSelectedTab('raw');
    if (selectedTab === 'related' && !showRelatedTab) setSelectedTab('raw');
  }, [event, selectedTab, showPacketTab, showToonTab, showRelatedTab]);

  // Desktop: Sheet side panel
  if (isDesktop) {
    return (
      <Sheet open={!!event} onOpenChange={(open) => !open && onClose()}>
        <SheetContent side="right" className="w-full sm:max-w-lg overflow-hidden flex flex-col">
          <SheetHeader className="shrink-0">
            <SheetTitle className="flex items-center gap-2">
              <Badge variant="outline">{displayData?.type || 'Event Details'}</Badge>
              {displayData?.direction && (
                <span className="text-xs text-muted-foreground">({displayData.direction})</span>
              )}
            </SheetTitle>
            <SheetDescription>
              {displayData?.timestamp && (
                <span className="text-xs">
                  {new Date(displayData.timestamp).toLocaleString()}
                  <span className="ml-2 text-muted-foreground">
                    ({formatRelativeTime(displayData.timestamp)})
                  </span>
                </span>
              )}
            </SheetDescription>
          </SheetHeader>

          {event && (
            <DetailPanelContent
              displayData={displayData}
              selectedTab={selectedTab}
              handleTabChange={handleTabChange}
              showPacketTab={!!showPacketTab}
              showToonTab={!!showToonTab}
              showRelatedTab={!!showRelatedTab}
              event={event}
              onEventSelect={onEventSelect}
            />
          )}
        </SheetContent>
      </Sheet>
    );
  }

  // Mobile: Dialog overlay (full-screen)
  return (
    <Dialog open={!!event} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-[100vw] h-[100vh] max-h-[100vh] overflow-hidden flex flex-col p-4">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <Badge variant="outline">{displayData?.type || 'Event Details'}</Badge>
            {displayData?.direction && (
              <span className="text-xs text-muted-foreground">({displayData.direction})</span>
            )}
          </DialogTitle>
          <DialogDescription>
            {displayData?.timestamp && (
              <span className="text-xs">
                {new Date(displayData.timestamp).toLocaleString()}
                <span className="ml-2 text-muted-foreground">
                  ({formatRelativeTime(displayData.timestamp)})
                </span>
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        {event && (
          <DetailPanelContent
            displayData={displayData}
            selectedTab={selectedTab}
            handleTabChange={handleTabChange}
            showPacketTab={!!showPacketTab}
            showToonTab={!!showToonTab}
            showRelatedTab={!!showRelatedTab}
            event={event}
            onEventSelect={onEventSelect}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

import { useState, useCallback, useEffect, lazy, Suspense } from 'react';
import { useEventFilters } from './hooks/useEventFilters';
import { useEvents, EventMode } from './hooks/useEvents';
import { EventTable } from './components/EventTable';
import { Header } from './components/Header';
import { JumpToLive } from './components/JumpToLive';
import { AccountsView } from './components/AccountsView';
import { PeersView } from './components/PeersView';
import { TelemetryEvent, StoredEvent } from './lib/event-types';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { KeyboardHelpDialog } from './components/KeyboardHelpDialog';
import { Radio, History, Wallet, ListTree, Network } from 'lucide-react';

const FilterBar = lazy(() =>
  import('./components/FilterBar').then((m) => ({ default: m.FilterBar }))
);
const EventDetailPanel = lazy(() =>
  import('./components/EventDetailPanel').then((m) => ({ default: m.EventDetailPanel }))
);

/** Tab view types */
type TabView = 'events' | 'accounts' | 'peers';

function App() {
  // Filter state management
  const { filters, setFilters, resetFilters, hasActiveFilters, activeFilterCount } =
    useEventFilters();

  // Combined event management (live + history)
  const {
    mode,
    setMode,
    events,
    total,
    loading,
    error,
    connectionStatus,
    loadMore,
    hasMore,
    jumpToLive,
  } = useEvents({
    filters,
    pageSize: 50,
    maxLiveEvents: 1000,
  });

  // Selected event for detail panel (Story 14.5)
  const [selectedEvent, setSelectedEvent] = useState<TelemetryEvent | StoredEvent | null>(null);

  // Tab view state (Story 14.6)
  const [activeTab, setActiveTab] = useState<TabView>('events');

  // Help dialog state (Task 3)
  const [helpOpen, setHelpOpen] = useState(false);

  // Scroll state tracking (used by EventTable)
  const handleScrollStateChange = useCallback((_isAtTop: boolean) => {
    // Reserved for future scroll-position-aware features
  }, []);

  // Global keyboard shortcuts (Task 2)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Guard: don't activate when input/textarea/select/contenteditable has focus
      const el = document.activeElement;
      if (el) {
        const tag = el.tagName.toUpperCase();
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (
          (el as HTMLElement).isContentEditable ||
          (el as HTMLElement).getAttribute('contenteditable') === 'true'
        ) {
          return;
        }
      }

      switch (e.key) {
        case '1':
          setActiveTab('events');
          break;
        case '2':
          setActiveTab('accounts');
          break;
        case '3':
          setActiveTab('peers');
          break;
        case '/': {
          e.preventDefault();
          const searchInput = document.getElementById('explorer-search-input');
          if (searchInput) {
            searchInput.focus();
          }
          break;
        }
        case '?':
          setHelpOpen(true);
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleEventClick = useCallback((event: TelemetryEvent) => {
    setSelectedEvent(event);
  }, []);

  const handleDetailPanelClose = useCallback(() => {
    setSelectedEvent(null);
  }, []);

  const handleRelatedEventSelect = useCallback((event: StoredEvent) => {
    setSelectedEvent(event);
  }, []);

  const handleModeToggle = useCallback(
    (newMode: EventMode) => {
      setMode(newMode);
    },
    [setMode]
  );

  return (
    <div className="min-h-screen bg-background text-foreground dark">
      <Header
        status={connectionStatus}
        eventCount={events.length}
        onHelpOpen={() => setHelpOpen(true)}
      />

      {/* Mode toggle */}
      <div className="flex items-center gap-2 px-4 md:px-6 py-2 border-b border-border flex-wrap">
        <span className="text-sm font-medium text-muted-foreground">View:</span>
        <Button
          variant={mode === 'live' ? 'secondary' : 'ghost'}
          size="sm"
          onClick={() => handleModeToggle('live')}
          className={`gap-2 ${mode === 'live' ? 'border border-green-500/30' : ''}`}
        >
          {mode === 'live' && <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />}
          <Radio className={`h-4 w-4 ${mode === 'live' ? 'text-green-500' : ''}`} />
          Live
        </Button>
        <Button
          variant={mode === 'history' ? 'secondary' : 'ghost'}
          size="sm"
          onClick={() => handleModeToggle('history')}
          className={`gap-2 ${mode === 'history' ? 'border border-muted-foreground/30' : ''}`}
        >
          <History className={`h-4 w-4 ${mode === 'history' ? 'text-muted-foreground' : ''}`} />
          History
        </Button>

        {mode === 'live' && connectionStatus === 'connected' && (
          <span className="ml-2 text-xs text-green-500 flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
            Streaming
          </span>
        )}

        {mode === 'live' && connectionStatus === 'connecting' && (
          <span className="ml-2 text-xs text-yellow-500 flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse" />
            Connecting...
          </span>
        )}

        {mode === 'history' && (
          <span className="ml-2 text-xs text-muted-foreground">
            {total.toLocaleString()} total events
          </span>
        )}
      </div>

      {/* Tab navigation (Story 14.6) */}
      <div className="px-4 md:px-6 py-2 border-b border-border">
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TabView)}>
          <TabsList>
            <TabsTrigger value="events" className="gap-2">
              <ListTree className="h-4 w-4" />
              Events
            </TabsTrigger>
            <TabsTrigger value="accounts" className="gap-2">
              <Wallet className="h-4 w-4" />
              Accounts
            </TabsTrigger>
            <TabsTrigger value="peers" className="gap-2">
              <Network className="h-4 w-4" />
              Peers
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* Filter bar - only show on events tab */}
      {activeTab === 'events' && (
        <Suspense fallback={null}>
          <FilterBar
            filters={filters}
            onFilterChange={setFilters}
            onReset={resetFilters}
            activeFilterCount={activeFilterCount}
          />
        </Suspense>
      )}

      <main className="px-4 md:px-6 py-4">
        {error && (
          <div className="mb-4 p-4 border border-destructive rounded-md bg-destructive/10 text-destructive">
            {error}
          </div>
        )}

        {activeTab === 'events' ? (
          <EventTable
            events={events}
            onEventClick={handleEventClick}
            loading={loading}
            showPagination={mode === 'history'}
            total={total}
            onLoadMore={hasMore ? loadMore : undefined}
            connectionStatus={connectionStatus}
            hasActiveFilters={hasActiveFilters}
            onClearFilters={resetFilters}
            onScrollStateChange={handleScrollStateChange}
          />
        ) : activeTab === 'accounts' ? (
          <AccountsView />
        ) : (
          <PeersView />
        )}
      </main>

      {/* Jump to live button (shown in history mode on events tab) */}
      <JumpToLive
        visible={mode === 'history' && activeTab === 'events'}
        connectionStatus={connectionStatus}
        onClick={jumpToLive}
      />

      {/* Event detail panel (Story 14.5) - only on events tab */}
      {activeTab === 'events' && (
        <Suspense fallback={null}>
          <EventDetailPanel
            event={selectedEvent}
            onClose={handleDetailPanelClose}
            onEventSelect={handleRelatedEventSelect}
          />
        </Suspense>
      )}

      {/* Keyboard shortcuts help dialog (Story 15.3) */}
      <KeyboardHelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  );
}

export default App;

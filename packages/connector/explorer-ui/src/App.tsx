import { useState } from 'react';
import { useEventFilters } from './hooks/useEventFilters';
import { useEvents, EventMode } from './hooks/useEvents';
import { EventTable } from './components/EventTable';
import { Header } from './components/Header';
import { FilterBar } from './components/FilterBar';
import { JumpToLive } from './components/JumpToLive';
import { EventDetailPanel } from './components/EventDetailPanel';
import { AccountsView } from './components/AccountsView';
import { TelemetryEvent, StoredEvent } from './lib/event-types';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Radio, History, Wallet, ListTree } from 'lucide-react';

/** Tab view types */
type TabView = 'events' | 'accounts';

function App() {
  // Filter state management
  const { filters, setFilters, resetFilters } = useEventFilters();

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

  const handleEventClick = (event: TelemetryEvent) => {
    setSelectedEvent(event);
  };

  const handleDetailPanelClose = () => {
    setSelectedEvent(null);
  };

  const handleRelatedEventSelect = (event: StoredEvent) => {
    setSelectedEvent(event);
  };

  const handleModeToggle = (newMode: EventMode) => {
    setMode(newMode);
  };

  return (
    <div className="min-h-screen bg-background text-foreground dark">
      <Header status={connectionStatus} eventCount={events.length} />

      {/* Mode toggle */}
      <div className="flex items-center gap-2 px-6 py-2 border-b border-border">
        <span className="text-sm font-medium text-muted-foreground">View:</span>
        <Button
          variant={mode === 'live' ? 'secondary' : 'ghost'}
          size="sm"
          onClick={() => handleModeToggle('live')}
          className="gap-2"
        >
          <Radio className={`h-4 w-4 ${mode === 'live' ? 'animate-pulse text-green-500' : ''}`} />
          Live
        </Button>
        <Button
          variant={mode === 'history' ? 'secondary' : 'ghost'}
          size="sm"
          onClick={() => handleModeToggle('history')}
          className="gap-2"
        >
          <History className="h-4 w-4" />
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
      <div className="px-6 py-2 border-b border-border">
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
          </TabsList>
        </Tabs>
      </div>

      {/* Filter bar - only show on events tab */}
      {activeTab === 'events' && (
        <FilterBar filters={filters} onFilterChange={setFilters} onReset={resetFilters} />
      )}

      <main className="px-6 py-4">
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
          />
        ) : (
          <AccountsView />
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
        <EventDetailPanel
          event={selectedEvent}
          onClose={handleDetailPanelClose}
          onEventSelect={handleRelatedEventSelect}
        />
      )}
    </div>
  );
}

export default App;

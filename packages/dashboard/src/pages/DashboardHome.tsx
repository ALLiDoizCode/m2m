import { useState } from 'react';
import { useTelemetry } from '../hooks/useTelemetry';
import { useNetworkGraph } from '../hooks/useNetworkGraph';
import { usePacketAnimation } from '../hooks/usePacketAnimation';
import { usePacketDetail } from '../hooks/usePacketDetail';
import { useNodeStatus } from '../hooks/useNodeStatus';
import { useLogViewer } from '../hooks/useLogViewer';
import { usePaymentChannels } from '../hooks/usePaymentChannels';
import { NetworkGraph } from '../components/NetworkGraph';
import { PacketAnimation } from '../components/PacketAnimation';
import { PacketDetailPanel } from '../components/PacketDetailPanel';
import { NodeStatusPanel } from '../components/NodeStatusPanel';
import { LogViewer } from '../components/LogViewer';
import { SettlementStatusPanel } from '../components/SettlementStatusPanel';
import { SettlementTimeline } from '../components/SettlementTimeline';
import { PaymentChannelsPanel } from '../components/PaymentChannelsPanel';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Toaster } from '@/components/ui/toaster';
import Cytoscape from 'cytoscape';

function DashboardHome(): JSX.Element {
  const { events, connected, error } = useTelemetry();
  const { graphData } = useNetworkGraph(events);
  const { activePackets } = usePacketAnimation(events);
  const { selectedPacketId, selectPacket, clearSelection, getSelectedPacket, recentPackets } =
    usePacketDetail(events);
  const {
    selectedNodeId,
    selectNode,
    clearSelection: clearNodeSelection,
    getSelectedNode,
  } = useNodeStatus(events);
  const {
    logEntries,
    filteredEntries,
    levelFilter,
    nodeFilter,
    searchText,
    autoScroll,
    toggleLevelFilter,
    toggleNodeFilter,
    setSearchText,
    toggleAutoScroll,
    clearFilters,
  } = useLogViewer(events);
  const { channels } = usePaymentChannels();
  const [cyInstance, setCyInstance] = useState<Cytoscape.Core | null>(null);

  return (
    <div className="p-6">
      {/* Header and connection status */}
      <div className="mb-6">
        <h1 className="text-3xl font-bold mb-2">ILP Network Topology</h1>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-400">Telemetry Status:</span>
            <span
              className={`text-sm font-medium ${connected ? 'text-green-500' : 'text-red-500'}`}
            >
              {connected ? 'Connected' : 'Not Connected'}
            </span>
          </div>
          {error && <div className="text-sm text-red-400">Error: {error.message}</div>}
        </div>
      </div>

      {/* Main Tabs: Network View vs Settlement View */}
      <Tabs defaultValue="network" className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="network">Network</TabsTrigger>
          <TabsTrigger value="settlement">Settlement</TabsTrigger>
        </TabsList>

        {/* Network Tab Content */}
        <TabsContent value="network" className="mt-0">
          {/* Node status legend */}
          <div className="mb-4 flex items-center gap-6 text-sm">
            <span className="text-gray-400">Node Status:</span>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-green-500"></div>
              <span className="text-gray-300">Healthy</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-amber-500"></div>
              <span className="text-gray-300">Starting</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-3 h-3 rounded-full bg-red-500"></div>
              <span className="text-gray-300">Unhealthy</span>
            </div>
          </div>

          {/* Split Layout: Network Graph (top) + Log Viewer (bottom) */}
          <div className="flex flex-col gap-4" style={{ height: 'calc(100vh - 300px)' }}>
            {/* Network graph visualization - 60% height */}
            <div className="bg-gray-800 rounded-lg p-4" style={{ height: '60%' }}>
              {graphData.nodes.length === 0 ? (
                <div className="flex items-center justify-center h-full text-gray-400">
                  <div className="text-center">
                    <p className="text-lg mb-2">No nodes detected</p>
                    <p className="text-sm">
                      {connected
                        ? 'Waiting for NODE_STATUS telemetry events...'
                        : 'Telemetry server not connected'}
                    </p>
                  </div>
                </div>
              ) : (
                <>
                  <NetworkGraph
                    graphData={graphData}
                    onCyReady={setCyInstance}
                    onNodeClick={selectNode}
                  />
                  <PacketAnimation
                    activePackets={activePackets}
                    cyInstance={cyInstance}
                    onPacketClick={selectPacket}
                  />
                </>
              )}
            </div>

            {/* Log Viewer - 40% height */}
            <div style={{ height: '40%' }}>
              <LogViewer
                logEntries={filteredEntries}
                allLogEntries={logEntries}
                autoScroll={autoScroll}
                onAutoScrollChange={toggleAutoScroll}
                levelFilter={levelFilter}
                toggleLevelFilter={toggleLevelFilter}
                nodeFilter={nodeFilter}
                toggleNodeFilter={toggleNodeFilter}
                searchText={searchText}
                setSearchText={setSearchText}
                clearFilters={clearFilters}
              />
            </div>
          </div>

          {/* Graph interaction instructions */}
          <div className="mt-4 text-sm text-gray-400">
            <p>
              <strong>Interactions:</strong> Scroll to zoom, drag background to pan, drag nodes to
              reposition, double-click background to reset layout, click packets to inspect details,
              click nodes to view status
            </p>
          </div>
        </TabsContent>

        {/* Settlement Tab Content */}
        <TabsContent value="settlement" className="mt-0">
          <div className="flex flex-col gap-6" style={{ height: 'calc(100vh - 300px)' }}>
            {/* Settlement Status Panel */}
            <div>
              <SettlementStatusPanel events={events} connected={connected} />
            </div>

            {/* Payment Channels Panel (Story 8.10) */}
            <div>
              <PaymentChannelsPanel channels={channels} />
            </div>

            {/* Settlement Timeline */}
            <div>
              <SettlementTimeline events={events} connected={connected} />
            </div>
          </div>
        </TabsContent>
      </Tabs>

      {/* Packet Detail Panel */}
      <PacketDetailPanel
        open={!!selectedPacketId}
        onOpenChange={(open) => !open && clearSelection()}
        packet={getSelectedPacket()}
        recentPacketIds={recentPackets}
        onSelectPacket={selectPacket}
      />

      {/* Node Status Panel */}
      <NodeStatusPanel
        open={!!selectedNodeId}
        onOpenChange={(open) => !open && clearNodeSelection()}
        node={getSelectedNode()}
      />

      {/* Toast notifications */}
      <Toaster />
    </div>
  );
}

export default DashboardHome;

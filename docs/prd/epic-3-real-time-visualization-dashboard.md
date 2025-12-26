# Epic 3: Real-Time Visualization Dashboard

**Goal:** Build a React-based web dashboard that visualizes the ILP connector network as an interactive graph, displays real-time animated packet flow between nodes, and provides detailed packet inspection capabilities. This epic delivers the core observability feature that differentiates this project from production ILP implementations.

## Story 3.1: Create React Dashboard Application with Routing

As a developer,
I want a React application scaffold with routing and basic layout,
so that I can build the visualization dashboard UI.

### Acceptance Criteria

1. React 18+ application initialized in `packages/dashboard` with TypeScript and Vite build tool
2. TailwindCSS configured for styling with dark theme as default
3. React Router configured (even if single-page for MVP, structure for future expansion)
4. Main layout component created with header (app name, version) and content area
5. Basic responsive layout works on desktop resolutions (1366x768 to 1920x1080+)
6. Application builds successfully with `npm run build` and dev server runs with `npm run dev`
7. Production build assets optimized (code splitting, minification)
8. Dashboard Dockerfile created to serve built React app via nginx or Node.js static server
9. Dashboard service added to docker-compose.yml accessible at http://localhost:8080
10. README documentation updated with instructions to access dashboard

---

## Story 3.2: Implement Network Topology Graph Visualization

As a user,
I want to see a visual graph of all connector nodes and their BTP connections,
so that I understand the network topology at a glance.

### Acceptance Criteria

1. Cytoscape.js integrated into React dashboard for graph rendering
2. Graph displays connector nodes as labeled circles with node ID
3. Graph displays BTP connections as directed edges between nodes
4. Graph uses automatic layout algorithm (e.g., breadth-first, force-directed) to position nodes clearly
5. Graph nodes are color-coded by health status (green=healthy, yellow=degraded, red=down)
6. Graph is interactive: nodes can be dragged to reposition, zoom/pan supported
7. Graph updates when topology changes (new node appears, connection drops)
8. Graph styling follows minimal technical aesthetic (dark background, clear labels, no decorative elements)
9. Graph scales to display up to 10 nodes clearly without overlap
10. Graph renders without performance issues (smooth interactions, <100ms render time)

---

## Story 3.3: Implement Telemetry WebSocket Server in Dashboard Backend

As a dashboard,
I want to receive telemetry data from all connector nodes via WebSocket,
so that I can aggregate packet events for visualization.

### Acceptance Criteria

1. WebSocket server implemented in `packages/dashboard/server` (or as separate package) using `ws` library
2. Server listens on configurable port (default 9000) for connector telemetry connections
3. Server accepts telemetry messages in JSON format: {type, nodeId, timestamp, data}
4. Server validates telemetry message format and logs warnings for malformed messages
5. Server supports telemetry message types: NODE_STATUS, PACKET_SENT, PACKET_RECEIVED, ROUTE_LOOKUP
6. Server broadcasts telemetry to all connected dashboard browser clients via WebSocket
7. Server handles multiple connector connections and multiple browser client connections concurrently
8. Server logs connection events (connector connected/disconnected) for debugging
9. Dashboard backend starts telemetry server on application startup
10. Integration test verifies telemetry flow from mock connector to dashboard server to browser client

---

## Story 3.4: Implement Connector Telemetry Emission

As a connector,
I want to send telemetry data about packet operations to the dashboard,
so that my activity can be visualized in real-time.

### Acceptance Criteria

1. Connector initializes WebSocket client connection to dashboard telemetry server on startup
2. Connector sends NODE_STATUS telemetry on startup (nodeId, routes, peers, health status)
3. Connector sends PACKET_RECEIVED telemetry when BTP packet arrives (packetId, type, source, destination, amount, timestamp)
4. Connector sends ROUTE_LOOKUP telemetry when routing table lookup occurs (destination, selectedPeer, reason)
5. Connector sends PACKET_SENT telemetry when packet forwarded via BTP (packetId, nextHop, timestamp)
6. Telemetry messages include connector node ID for dashboard to differentiate sources
7. Telemetry emission is non-blocking (failures don't block packet processing)
8. Telemetry connection failures are logged but don't crash connector
9. Dashboard telemetry server URL configured via environment variable in docker-compose.yml
10. End-to-end test verifies telemetry appears in dashboard when packet flows through connector

---

## Story 3.5: Display Real-Time Packet Flow Animation

As a user,
I want to see animated visualizations of packets moving between connector nodes,
so that I can observe payment flow in real-time.

### Acceptance Criteria

1. Dashboard listens to PACKET_SENT telemetry and creates animated packet visualization
2. Packets rendered as small colored circles moving along edges from source to destination node
3. Packet color corresponds to type: blue=Prepare, green=Fulfill, red=Reject (per FR8)
4. Packet animation duration calibrated to represent time in transit (~500ms-1s for visual clarity)
5. Multiple packets can be in flight simultaneously without visual collision
6. Packet animation smoothly interpolates position along edge (no jumpy movement)
7. Animation performance remains smooth with up to 10 concurrent packets (60fps target)
8. Packets disappear after reaching destination node (clean up to avoid visual clutter)
9. Animation uses requestAnimationFrame or CSS transitions for efficiency
10. Packet flow visualization updates in <100ms of PACKET_SENT telemetry (NFR2 requirement)

---

## Story 3.6: Implement Packet Detail Inspection Panel

As a user,
I want to click on a packet to see its full ILP packet structure and metadata,
so that I can debug packet contents and routing decisions.

### Acceptance Criteria

1. Clicking on animated packet opens side panel with packet details
2. Detail panel displays packet ID, type, timestamp, source, destination
3. Detail panel displays ILP-specific fields: amount, executionCondition, expiresAt, data payload
4. Detail panel displays routing path (sequence of connector nodes packet has traversed)
5. Detail panel formats binary data (condition, fulfillment) as hex strings
6. Detail panel includes JSON view option showing raw packet structure
7. Detail panel closes when user clicks close button or clicks elsewhere on graph
8. Detail panel remains open while packet animates (doesn't auto-close prematurely)
9. Detail panel styled consistently with dark theme and monospace fonts for technical data
10. Multiple packet detail panels can be opened for comparison (side-by-side or stacked)

---

## Story 3.7: Implement Node Status Inspection Panel

As a user,
I want to click on a connector node to see its routing table and connection status,
so that I can understand how that node is configured.

### Acceptance Criteria

1. Clicking on connector node in graph opens side panel with node details
2. Panel displays node ID, health status, uptime
3. Panel displays current routing table (all routes: prefix → nextHop peer)
4. Panel displays list of BTP peer connections with status (connected/disconnected)
5. Panel displays packet statistics: total packets received, forwarded, rejected
6. Panel updates in real-time as routing table or peer status changes
7. Panel includes visual indicators for health (icon or color)
8. Panel closes when user clicks close button or selects different node
9. Panel styled with monospace fonts for addresses and tabular data for routing table
10. Panel accessible even when packets are animating (doesn't interfere with click targets)

---

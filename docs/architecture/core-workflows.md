# Core Workflows

## Packet Forwarding Workflow (Multi-Hop)

The following sequence diagram illustrates the core ILP packet forwarding flow through multiple connector hops with telemetry emission:

```mermaid
sequenceDiagram
    participant Sender as Test Packet Sender
    participant ConnA as Connector A
    participant DashA as Dashboard
    participant ConnB as Connector B
    participant ConnC as Connector C

    Note over Sender,ConnC: Scenario: Send packet from A to C via B

    Sender->>ConnA: Send ILP Prepare (destination: g.connectorC.dest)
    activate ConnA
    ConnA->>ConnA: BTPServer receives packet
    ConnA->>ConnA: PacketHandler.validatePacket()
    ConnA->>ConnA: RoutingTable.lookup("g.connectorC.dest")
    ConnA->>ConnA: Result: nextHop = "connectorB"
    ConnA->>DashA: Telemetry: PACKET_RECEIVED
    ConnA->>DashA: Telemetry: ROUTE_LOOKUP (peer=connectorB)
    ConnA->>ConnB: BTPClient.sendPacket() via WebSocket
    ConnA->>DashA: Telemetry: PACKET_SENT (nextHop=connectorB)
    deactivate ConnA

    activate ConnB
    ConnB->>ConnB: BTPServer receives packet
    ConnB->>ConnB: PacketHandler.validatePacket()
    ConnB->>ConnB: RoutingTable.lookup("g.connectorC.dest")
    ConnB->>ConnB: Result: nextHop = "connectorC"
    ConnB->>DashA: Telemetry: PACKET_RECEIVED
    ConnB->>DashA: Telemetry: ROUTE_LOOKUP (peer=connectorC)
    ConnB->>ConnC: BTPClient.sendPacket() via WebSocket
    ConnB->>DashA: Telemetry: PACKET_SENT (nextHop=connectorC)
    deactivate ConnB

    activate ConnC
    ConnC->>ConnC: BTPServer receives packet
    ConnC->>ConnC: PacketHandler.validatePacket()
    ConnC->>ConnC: Packet delivered (destination reached)
    ConnC->>DashA: Telemetry: PACKET_RECEIVED
    ConnC->>ConnB: ILP Fulfill (propagate back)
    deactivate ConnC

    activate ConnB
    ConnB->>ConnA: ILP Fulfill (propagate back)
    deactivate ConnB

    activate ConnA
    ConnA->>Sender: ILP Fulfill (final response)
    deactivate ConnA

    Note over DashA: Dashboard animates packet flow in real-time
```

## Dashboard Telemetry and Visualization Workflow

```mermaid
sequenceDiagram
    participant Conn as Connector Nodes (A, B, C)
    participant TelServer as Dashboard Telemetry Server
    participant Browser as Browser Client
    participant Cytoscape as Cytoscape.js Graph

    Note over Conn,Cytoscape: Initialization Phase

    Conn->>TelServer: WebSocket Connect (telemetry connection)
    TelServer->>TelServer: Register connector
    Conn->>TelServer: Telemetry: NODE_STATUS (routes, peers)
    Browser->>TelServer: WebSocket Connect (UI client)
    TelServer->>Browser: Broadcast NODE_STATUS events
    Browser->>Cytoscape: Render network topology graph

    Note over Conn,Cytoscape: Runtime - Packet Flow Visualization

    Conn->>TelServer: Telemetry: PACKET_SENT (packetId, nextHop)
    TelServer->>Browser: Broadcast PACKET_SENT event
    Browser->>Browser: Create packet animation object
    Browser->>Cytoscape: Animate packet along edge (source → destination)
    Note over Cytoscape: Packet moves smoothly over 500ms

    Browser->>Browser: User clicks animated packet
    Browser->>Browser: Display PacketDetailPanel with ILP packet structure

    Note over Conn,Cytoscape: Log Viewer Updates

    Conn->>TelServer: Telemetry: LOG (structured log entry)
    TelServer->>Browser: Broadcast LOG event
    Browser->>Browser: Append to LogViewer component
    Browser->>Browser: Apply user filters (level, nodeId)
```

## Connector Startup and BTP Connection Establishment

```mermaid
sequenceDiagram
    participant Docker as Docker Compose
    participant ConnA as Connector A
    participant ConnB as Connector B
    participant Dashboard as Dashboard

    Note over Docker,Dashboard: Startup Sequence

    Docker->>Dashboard: Start dashboard container
    activate Dashboard
    Dashboard->>Dashboard: Start Express HTTP server
    Dashboard->>Dashboard: Start WebSocket telemetry server (port 9000)
    Dashboard->>Dashboard: Health check: READY
    deactivate Dashboard

    Docker->>ConnA: Start connector-a container
    activate ConnA
    ConnA->>ConnA: Load config.yaml (routes, peers)
    ConnA->>ConnA: Initialize RoutingTable from config
    ConnA->>ConnA: Start BTPServer (port 3000)
    ConnA->>ConnA: Health check: STARTING
    deactivate ConnA

    Docker->>ConnB: Start connector-b container
    activate ConnB
    ConnB->>ConnB: Load config.yaml
    ConnB->>ConnB: Initialize RoutingTable
    ConnB->>ConnB: Start BTPServer (port 3000)
    deactivate ConnB

    Note over ConnA,ConnB: BTP Peer Connection Phase

    activate ConnA
    ConnA->>ConnB: BTPClient connects (ws://connector-b:3000)
    ConnB->>ConnA: BTP AUTH response (handshake)
    ConnA->>ConnA: Mark peer "connectorB" as CONNECTED
    ConnA->>ConnA: Health check: READY
    deactivate ConnA

    activate ConnB
    ConnB->>ConnA: BTPClient connects (ws://connector-a:3000)
    ConnA->>ConnB: BTP AUTH response
    ConnB->>ConnB: Mark peer "connectorA" as CONNECTED
    ConnB->>ConnB: Health check: READY
    deactivate ConnB

    Note over ConnA,Dashboard: Telemetry Registration

    ConnA->>Dashboard: WebSocket connect (telemetry)
    ConnA->>Dashboard: Telemetry: NODE_STATUS (routes, peers)
    ConnB->>Dashboard: WebSocket connect (telemetry)
    ConnB->>Dashboard: Telemetry: NODE_STATUS (routes, peers)

    Note over Docker: All containers healthy - system operational
```

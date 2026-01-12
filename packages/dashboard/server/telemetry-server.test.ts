/**
 * Integration tests for TelemetryServer
 * Tests real WebSocket connections and message flow
 */

import { TelemetryServer } from './telemetry-server';
import { logger } from './logger';
import WebSocket from 'ws';

describe('TelemetryServer Integration Tests', () => {
  let server: TelemetryServer;
  const TEST_PORT = 9999;
  const TEST_WS_URL = `ws://localhost:${TEST_PORT}`;

  beforeEach(() => {
    server = new TelemetryServer(TEST_PORT, logger);
  });

  afterEach(() => {
    if (server) {
      server.stop();
    }
  });

  describe('Server Startup and Port Binding', () => {
    test('should start server and listen on configured port', (done) => {
      server.start();

      // Attempt to connect to verify server is listening
      const ws = new WebSocket(TEST_WS_URL);

      ws.on('open', () => {
        expect(ws.readyState).toBe(WebSocket.OPEN);
        ws.close();
        done();
      });

      ws.on('error', (error) => {
        done(error);
      });
    });

    test('should accept multiple WebSocket connections', (done) => {
      server.start();

      const ws1 = new WebSocket(TEST_WS_URL);
      const ws2 = new WebSocket(TEST_WS_URL);

      let openCount = 0;

      const handleOpen = () => {
        openCount++;
        if (openCount === 2) {
          ws1.close();
          ws2.close();
          done();
        }
      };

      ws1.on('open', handleOpen);
      ws2.on('open', handleOpen);
    });
  });

  describe('Message Reception and Validation', () => {
    test('should accept valid NODE_STATUS telemetry message', (done) => {
      server.start();

      const ws = new WebSocket(TEST_WS_URL);

      ws.on('open', () => {
        const validMessage = {
          type: 'NODE_STATUS',
          nodeId: 'connector-test',
          timestamp: new Date().toISOString(),
          data: {
            routes: [],
            peers: [],
            health: 'healthy',
            uptime: 100,
            peersConnected: 0,
            totalPeers: 0,
          },
        };

        ws.send(JSON.stringify(validMessage));

        // Wait a bit to ensure message is processed
        setTimeout(() => {
          ws.close();
          done();
        }, 100);
      });
    });

    test('should handle malformed JSON gracefully', (done) => {
      server.start();

      const ws = new WebSocket(TEST_WS_URL);

      ws.on('open', () => {
        // Send invalid JSON
        ws.send('{invalid json}');

        // Server should not crash - wait and verify connection still works
        setTimeout(() => {
          expect(ws.readyState).toBe(WebSocket.OPEN);
          ws.close();
          done();
        }, 100);
      });
    });

    test('should reject message with missing required fields', (done) => {
      server.start();

      const ws = new WebSocket(TEST_WS_URL);

      ws.on('open', () => {
        // Message missing nodeId and timestamp
        const invalidMessage = {
          type: 'NODE_STATUS',
          data: {},
        };

        ws.send(JSON.stringify(invalidMessage));

        // Server should not crash
        setTimeout(() => {
          expect(ws.readyState).toBe(WebSocket.OPEN);
          ws.close();
          done();
        }, 100);
      });
    });
  });

  describe('Broadcasting Mechanism', () => {
    test('should broadcast telemetry to all connected clients', (done) => {
      server.start();

      // Connect a connector
      const connector = new WebSocket(TEST_WS_URL);

      // Connect two browser clients
      const client1 = new WebSocket(TEST_WS_URL);
      const client2 = new WebSocket(TEST_WS_URL);

      let client1Received = false;
      let client2Received = false;

      client1.on('open', () => {
        // Identify as client
        client1.send(
          JSON.stringify({
            type: 'CLIENT_CONNECT',
            nodeId: 'client1',
            timestamp: new Date().toISOString(),
            data: {},
          })
        );
      });

      client2.on('open', () => {
        // Identify as client
        client2.send(
          JSON.stringify({
            type: 'CLIENT_CONNECT',
            nodeId: 'client2',
            timestamp: new Date().toISOString(),
            data: {},
          })
        );
      });

      client1.on('message', (data) => {
        const message = JSON.parse(data.toString());
        if (message.type === 'PACKET_SENT') {
          client1Received = true;
          checkComplete();
        }
      });

      client2.on('message', (data) => {
        const message = JSON.parse(data.toString());
        if (message.type === 'PACKET_SENT') {
          client2Received = true;
          checkComplete();
        }
      });

      const checkComplete = () => {
        if (client1Received && client2Received) {
          connector.close();
          client1.close();
          client2.close();
          done();
        }
      };

      // Wait for all connections to establish, then send telemetry
      setTimeout(() => {
        connector.send(
          JSON.stringify({
            type: 'PACKET_SENT',
            nodeId: 'connector-a',
            timestamp: new Date().toISOString(),
            data: {
              packetId: 'test-packet',
              nextHop: 'connector-b',
              timestamp: new Date().toISOString(),
            },
          })
        );
      }, 200);
    }, 10000);
  });

  describe('Connection Lifecycle', () => {
    test('should handle connector disconnection', (done) => {
      server.start();

      const ws = new WebSocket(TEST_WS_URL);

      ws.on('open', () => {
        // Register as connector
        ws.send(
          JSON.stringify({
            type: 'NODE_STATUS',
            nodeId: 'connector-test',
            timestamp: new Date().toISOString(),
            data: {
              routes: [],
              peers: [],
              health: 'healthy',
              uptime: 0,
              peersConnected: 0,
              totalPeers: 0,
            },
          })
        );

        // Disconnect after registration
        setTimeout(() => {
          ws.close();
        }, 100);
      });

      ws.on('close', () => {
        // Verify server still operational by connecting again
        const newWs = new WebSocket(TEST_WS_URL);
        newWs.on('open', () => {
          newWs.close();
          done();
        });
      });
    });

    test('should handle client disconnection gracefully', (done) => {
      server.start();

      const ws = new WebSocket(TEST_WS_URL);

      ws.on('open', () => {
        // Identify as client
        ws.send(
          JSON.stringify({
            type: 'CLIENT_CONNECT',
            nodeId: 'client',
            timestamp: new Date().toISOString(),
            data: {},
          })
        );

        setTimeout(() => {
          ws.close();
        }, 100);
      });

      ws.on('close', () => {
        // Verify server still operational
        const newWs = new WebSocket(TEST_WS_URL);
        newWs.on('open', () => {
          newWs.close();
          done();
        });
      });
    });
  });

  describe('Concurrent Connections', () => {
    test('should handle multiple connectors and clients concurrently', (done) => {
      server.start();

      const connector1 = new WebSocket(TEST_WS_URL);
      const connector2 = new WebSocket(TEST_WS_URL);
      const connector3 = new WebSocket(TEST_WS_URL);
      const client1 = new WebSocket(TEST_WS_URL);
      const client2 = new WebSocket(TEST_WS_URL);

      let connectionsReady = 0;
      const totalConnections = 5;

      const handleReady = () => {
        connectionsReady++;
        if (connectionsReady === totalConnections) {
          // All connections established
          // Send telemetry from connector1
          connector1.send(
            JSON.stringify({
              type: 'NODE_STATUS',
              nodeId: 'connector-1',
              timestamp: new Date().toISOString(),
              data: {
                routes: [],
                peers: [],
                health: 'healthy',
                uptime: 0,
                peersConnected: 0,
                totalPeers: 0,
              },
            })
          );
        }
      };

      let messagesReceived = 0;

      client1.on('message', () => {
        messagesReceived++;
        if (messagesReceived === 2) {
          // Both clients received the message
          connector1.close();
          connector2.close();
          connector3.close();
          client1.close();
          client2.close();
          done();
        }
      });

      client2.on('message', () => {
        messagesReceived++;
        if (messagesReceived === 2) {
          connector1.close();
          connector2.close();
          connector3.close();
          client1.close();
          client2.close();
          done();
        }
      });

      connector1.on('open', handleReady);
      connector2.on('open', handleReady);
      connector3.on('open', handleReady);

      client1.on('open', () => {
        client1.send(
          JSON.stringify({
            type: 'CLIENT_CONNECT',
            nodeId: 'client1',
            timestamp: new Date().toISOString(),
            data: {},
          })
        );
        handleReady();
      });

      client2.on('open', () => {
        client2.send(
          JSON.stringify({
            type: 'CLIENT_CONNECT',
            nodeId: 'client2',
            timestamp: new Date().toISOString(),
            data: {},
          })
        );
        handleReady();
      });
    }, 10000);
  });

  describe('NODE_STATUS Caching and Replay (AC 6, 7)', () => {
    test('should cache NODE_STATUS messages in lastNodeStatus map', (done) => {
      server.start();

      const connector = new WebSocket(TEST_WS_URL);

      connector.on('open', () => {
        // Send NODE_STATUS message
        connector.send(
          JSON.stringify({
            type: 'NODE_STATUS',
            nodeId: 'connector-test',
            timestamp: new Date().toISOString(),
            data: {
              routes: [{ prefix: 'g.test', nextHop: 'peer1', priority: 1 }],
              peers: [],
              health: 'healthy',
              uptime: 1000,
              peersConnected: 0,
              totalPeers: 0,
            },
          })
        );

        // Wait for message to be processed
        setTimeout(() => {
          connector.close();
          done();
        }, 100);
      });
    });

    test('should update cache when multiple NODE_STATUS messages from same node', (done) => {
      server.start();

      const connector = new WebSocket(TEST_WS_URL);

      connector.on('open', () => {
        // Send first NODE_STATUS
        connector.send(
          JSON.stringify({
            type: 'NODE_STATUS',
            nodeId: 'connector-test',
            timestamp: new Date().toISOString(),
            data: {
              routes: [],
              peers: [],
              health: 'healthy',
              uptime: 100,
              peersConnected: 0,
              totalPeers: 0,
            },
          })
        );

        // Send second NODE_STATUS with different data (latest should win)
        setTimeout(() => {
          connector.send(
            JSON.stringify({
              type: 'NODE_STATUS',
              nodeId: 'connector-test',
              timestamp: new Date().toISOString(),
              data: {
                routes: [{ prefix: 'g.updated', nextHop: 'peer2', priority: 2 }],
                peers: [],
                health: 'healthy',
                uptime: 200,
                peersConnected: 0,
                totalPeers: 0,
              },
            })
          );

          setTimeout(() => {
            connector.close();
            done();
          }, 100);
        }, 100);
      });
    });

    test('should send cached messages in correct JSON format', (done) => {
      server.start();

      const connector = new WebSocket(TEST_WS_URL);
      const client = new WebSocket(TEST_WS_URL);

      let connectorReady = false;
      let receivedMessage: unknown = null;

      connector.on('open', () => {
        // Send NODE_STATUS to cache
        connector.send(
          JSON.stringify({
            type: 'NODE_STATUS',
            nodeId: 'connector-test',
            timestamp: new Date().toISOString(),
            data: {
              routes: [],
              peers: [],
              health: 'healthy',
              uptime: 500,
              peersConnected: 0,
              totalPeers: 0,
            },
          })
        );

        connectorReady = true;
        connectClient();
      });

      const connectClient = () => {
        if (!connectorReady) return;

        setTimeout(() => {
          client.on('message', (data) => {
            try {
              receivedMessage = JSON.parse(data.toString());
              expect(receivedMessage).toHaveProperty('type', 'NODE_STATUS');
              expect(receivedMessage).toHaveProperty('nodeId', 'connector-test');
              expect(receivedMessage).toHaveProperty('timestamp');
              expect(receivedMessage).toHaveProperty('data');
              connector.close();
              client.close();
              done();
            } catch (error) {
              done(error);
            }
          });

          // Identify as client to trigger replay
          client.send(
            JSON.stringify({
              type: 'CLIENT_CONNECT',
              nodeId: 'client',
              timestamp: new Date().toISOString(),
              data: {},
            })
          );
        }, 150);
      };
    }, 10000);

    test('should ignore non-telemetry messages and not cache them', (done) => {
      server.start();

      const connector = new WebSocket(TEST_WS_URL);

      connector.on('open', () => {
        // Send invalid message type
        connector.send(
          JSON.stringify({
            type: 'INVALID_TYPE',
            nodeId: 'connector-test',
            timestamp: new Date().toISOString(),
            data: {},
          })
        );

        // Server should not crash
        setTimeout(() => {
          expect(connector.readyState).toBe(WebSocket.OPEN);
          connector.close();
          done();
        }, 100);
      });
    });

    test('should persist cache across multiple client connections', (done) => {
      server.start();

      const connector = new WebSocket(TEST_WS_URL);
      let client1Received = false;

      connector.on('open', () => {
        // Send NODE_STATUS to cache
        connector.send(
          JSON.stringify({
            type: 'NODE_STATUS',
            nodeId: 'connector-cache-test',
            timestamp: new Date().toISOString(),
            data: {
              routes: [],
              peers: [],
              health: 'healthy',
              uptime: 300,
              peersConnected: 0,
              totalPeers: 0,
            },
          })
        );

        // Wait for message to be cached, then connect first client
        setTimeout(() => {
          const client1 = new WebSocket(TEST_WS_URL);

          client1.on('open', () => {
            client1.send(
              JSON.stringify({
                type: 'CLIENT_CONNECT',
                nodeId: 'client1',
                timestamp: new Date().toISOString(),
                data: {},
              })
            );
          });

          client1.on('message', (data) => {
            const message = JSON.parse(data.toString());
            if (message.type === 'NODE_STATUS' && message.nodeId === 'connector-cache-test') {
              client1Received = true;
              client1.close();

              // Connect second client after first disconnects
              setTimeout(() => {
                const client2 = new WebSocket(TEST_WS_URL);

                client2.on('open', () => {
                  client2.send(
                    JSON.stringify({
                      type: 'CLIENT_CONNECT',
                      nodeId: 'client2',
                      timestamp: new Date().toISOString(),
                      data: {},
                    })
                  );
                });

                client2.on('message', (data) => {
                  const message = JSON.parse(data.toString());
                  if (message.type === 'NODE_STATUS' && message.nodeId === 'connector-cache-test') {
                    // Second client also received cached message
                    expect(client1Received).toBe(true);
                    client2.close();
                    connector.close();
                    done();
                  }
                });
              }, 100);
            }
          });
        }, 150);
      });
    }, 10000);

    test('CLIENT_CONNECT message triggers replay of all cached NODE_STATUS (AC 7)', (done) => {
      server.start();

      const connector1 = new WebSocket(TEST_WS_URL);
      const connector2 = new WebSocket(TEST_WS_URL);
      const connector3 = new WebSocket(TEST_WS_URL);

      let connectorsReady = 0;
      const receivedNodeIds = new Set<string>();

      const sendNodeStatus = (ws: WebSocket, nodeId: string) => {
        ws.send(
          JSON.stringify({
            type: 'NODE_STATUS',
            nodeId,
            timestamp: new Date().toISOString(),
            data: {
              routes: [],
              peers: [],
              health: 'healthy',
              uptime: 100,
              peersConnected: 0,
              totalPeers: 0,
            },
          })
        );
      };

      connector1.on('open', () => {
        sendNodeStatus(connector1, 'connector-1');
        connectorsReady++;
        tryConnectClient();
      });

      connector2.on('open', () => {
        sendNodeStatus(connector2, 'connector-2');
        connectorsReady++;
        tryConnectClient();
      });

      connector3.on('open', () => {
        sendNodeStatus(connector3, 'connector-3');
        connectorsReady++;
        tryConnectClient();
      });

      const tryConnectClient = () => {
        if (connectorsReady !== 3) return;

        // Wait for all NODE_STATUS to be cached, then create client
        setTimeout(() => {
          const client = new WebSocket(TEST_WS_URL);

          client.on('open', () => {
            // Send CLIENT_CONNECT to trigger replay
            client.send(
              JSON.stringify({
                type: 'CLIENT_CONNECT',
                nodeId: 'client',
                timestamp: new Date().toISOString(),
                data: {},
              })
            );
          });

          client.on('message', (data) => {
            const message = JSON.parse(data.toString());
            if (message.type === 'NODE_STATUS') {
              receivedNodeIds.add(message.nodeId);

              // Check if all 3 NODE_STATUS messages received
              if (receivedNodeIds.size === 3) {
                expect(receivedNodeIds.has('connector-1')).toBe(true);
                expect(receivedNodeIds.has('connector-2')).toBe(true);
                expect(receivedNodeIds.has('connector-3')).toBe(true);
                connector1.close();
                connector2.close();
                connector3.close();
                client.close();
                done();
              }
            }
          });
        }, 200);
      };
    }, 10000);

    test('new client receives N cached messages where N = number of cached nodes', (done) => {
      server.start();

      const connector1 = new WebSocket(TEST_WS_URL);
      const connector2 = new WebSocket(TEST_WS_URL);

      let connectorsReady = 0;
      let receivedNodeStatusCount = 0;

      const sendNodeStatus = (ws: WebSocket, nodeId: string) => {
        ws.send(
          JSON.stringify({
            type: 'NODE_STATUS',
            nodeId,
            timestamp: new Date().toISOString(),
            data: {
              routes: [],
              peers: [],
              health: 'healthy',
              uptime: 100,
              peersConnected: 0,
              totalPeers: 0,
            },
          })
        );
      };

      connector1.on('open', () => {
        sendNodeStatus(connector1, 'connector-A');
        connectorsReady++;
        tryConnectClient();
      });

      connector2.on('open', () => {
        sendNodeStatus(connector2, 'connector-B');
        connectorsReady++;
        tryConnectClient();
      });

      const tryConnectClient = () => {
        if (connectorsReady !== 2) return;

        // Wait for all NODE_STATUS to be cached, then create client
        setTimeout(() => {
          const client = new WebSocket(TEST_WS_URL);

          client.on('open', () => {
            client.send(
              JSON.stringify({
                type: 'CLIENT_CONNECT',
                nodeId: 'client',
                timestamp: new Date().toISOString(),
                data: {},
              })
            );
          });

          client.on('message', (data) => {
            const message = JSON.parse(data.toString());
            if (message.type === 'NODE_STATUS') {
              receivedNodeStatusCount++;

              // Should receive exactly 2 NODE_STATUS messages (N = 2)
              if (receivedNodeStatusCount === 2) {
                expect(receivedNodeStatusCount).toBe(2);
                connector1.close();
                connector2.close();
                client.close();
                done();
              } else if (receivedNodeStatusCount > 2) {
                done(new Error(`Expected 2 NODE_STATUS messages, got ${receivedNodeStatusCount}`));
              }
            }
          });
        }, 200);
      };
    }, 10000);

    test('multiple clients receive independent replays without interference', (done) => {
      server.start();

      const connector = new WebSocket(TEST_WS_URL);
      let client1Count = 0;
      let client2Count = 0;

      connector.on('open', () => {
        connector.send(
          JSON.stringify({
            type: 'NODE_STATUS',
            nodeId: 'connector-independent',
            timestamp: new Date().toISOString(),
            data: {
              routes: [],
              peers: [],
              health: 'healthy',
              uptime: 100,
              peersConnected: 0,
              totalPeers: 0,
            },
          })
        );

        // Wait for message to be cached, then create clients
        setTimeout(() => {
          const client1 = new WebSocket(TEST_WS_URL);
          const client2 = new WebSocket(TEST_WS_URL);

          client1.on('open', () => {
            client1.send(
              JSON.stringify({
                type: 'CLIENT_CONNECT',
                nodeId: 'client1',
                timestamp: new Date().toISOString(),
                data: {},
              })
            );
          });

          client1.on('message', (data) => {
            const message = JSON.parse(data.toString());
            if (message.type === 'NODE_STATUS') {
              client1Count++;
            }
          });

          client2.on('open', () => {
            client2.send(
              JSON.stringify({
                type: 'CLIENT_CONNECT',
                nodeId: 'client2',
                timestamp: new Date().toISOString(),
                data: {},
              })
            );

            // Verify both clients received replay independently
            setTimeout(() => {
              expect(client1Count).toBe(1);
              expect(client2Count).toBe(1);
              connector.close();
              client1.close();
              client2.close();
              done();
            }, 200);
          });

          client2.on('message', (data) => {
            const message = JSON.parse(data.toString());
            if (message.type === 'NODE_STATUS') {
              client2Count++;
            }
          });
        }, 150);
      });
    }, 10000);
  });

  describe('Payment Channel Telemetry (Story 8.10)', () => {
    test('should store PAYMENT_CHANNEL_OPENED event in channel state', (done) => {
      server.start();

      const connector = new WebSocket(TEST_WS_URL);

      connector.on('open', () => {
        connector.send(
          JSON.stringify({
            type: 'PAYMENT_CHANNEL_OPENED',
            timestamp: '2026-01-09T12:00:00.000Z',
            nodeId: 'connector-a',
            channelId: '0x1234567890abcdef',
            participants: ['0xAddress1', '0xAddress2'],
            peerId: 'connector-b',
            tokenAddress: '0xToken',
            tokenSymbol: 'USDC',
            settlementTimeout: 86400,
            initialDeposits: {
              '0xAddress1': '1000000000000000000',
              '0xAddress2': '0',
            },
          })
        );

        // Check channel state stored
        setTimeout(() => {
          const channels = server.getAllActiveChannels();
          expect(channels).toHaveLength(1);
          const channel = channels[0];
          expect(channel).toBeDefined();
          expect(channel!.channelId).toBe('0x1234567890abcdef');
          expect(channel!.nodeId).toBe('connector-a');
          expect(channel!.peerId).toBe('connector-b');
          expect(channel!.tokenSymbol).toBe('USDC');
          expect(channel!.status).toBe('active');
          expect(channel!.myNonce).toBe(0);
          expect(channel!.theirNonce).toBe(0);
          expect(channel!.myTransferred).toBe('0');
          expect(channel!.theirTransferred).toBe('0');
          connector.close();
          done();
        }, 100);
      });
    }, 5000);

    test('should update channel state on PAYMENT_CHANNEL_BALANCE_UPDATE event', (done) => {
      server.start();

      const connector = new WebSocket(TEST_WS_URL);

      connector.on('open', () => {
        // First, open channel
        connector.send(
          JSON.stringify({
            type: 'PAYMENT_CHANNEL_OPENED',
            timestamp: '2026-01-09T12:00:00.000Z',
            nodeId: 'connector-a',
            channelId: '0xabc123',
            participants: ['0xAddress1', '0xAddress2'],
            peerId: 'connector-b',
            tokenAddress: '0xToken',
            tokenSymbol: 'USDC',
            settlementTimeout: 86400,
            initialDeposits: {
              '0xAddress1': '1000000000000000000',
              '0xAddress2': '0',
            },
          })
        );

        // Wait for channel to be created, then update
        setTimeout(() => {
          connector.send(
            JSON.stringify({
              type: 'PAYMENT_CHANNEL_BALANCE_UPDATE',
              timestamp: '2026-01-09T12:01:00.000Z',
              nodeId: 'connector-a',
              channelId: '0xabc123',
              myNonce: 5,
              theirNonce: 3,
              myTransferred: '5000000000000000000',
              theirTransferred: '2000000000000000000',
            })
          );

          // Verify update
          setTimeout(() => {
            const channels = server.getAllActiveChannels();
            expect(channels).toHaveLength(1);
            const channel = channels[0];
            expect(channel).toBeDefined();
            expect(channel!.channelId).toBe('0xabc123');
            expect(channel!.myNonce).toBe(5);
            expect(channel!.theirNonce).toBe(3);
            expect(channel!.myTransferred).toBe('5000000000000000000');
            expect(channel!.theirTransferred).toBe('2000000000000000000');
            expect(channel!.lastActivityAt).toBe('2026-01-09T12:01:00.000Z');
            connector.close();
            done();
          }, 100);
        }, 100);
      });
    }, 5000);

    test('should update channel status on PAYMENT_CHANNEL_SETTLED event', (done) => {
      server.start();

      const connector = new WebSocket(TEST_WS_URL);

      connector.on('open', () => {
        // First, open channel
        connector.send(
          JSON.stringify({
            type: 'PAYMENT_CHANNEL_OPENED',
            timestamp: '2026-01-09T12:00:00.000Z',
            nodeId: 'connector-a',
            channelId: '0xdef456',
            participants: ['0xAddress1', '0xAddress2'],
            peerId: 'connector-b',
            tokenAddress: '0xToken',
            tokenSymbol: 'DAI',
            settlementTimeout: 86400,
            initialDeposits: {
              '0xAddress1': '1000000000000000000',
              '0xAddress2': '0',
            },
          })
        );

        // Wait for channel to be created, then settle
        setTimeout(() => {
          connector.send(
            JSON.stringify({
              type: 'PAYMENT_CHANNEL_SETTLED',
              timestamp: '2026-01-09T14:00:00.000Z',
              nodeId: 'connector-a',
              channelId: '0xdef456',
              finalBalances: {
                '0xAddress1': '3000000000000000000',
                '0xAddress2': '2000000000000000000',
              },
              settlementType: 'cooperative',
            })
          );

          // Verify settlement
          setTimeout(() => {
            const channels = server.getAllActiveChannels();
            expect(channels).toHaveLength(1);
            const channel = channels[0];
            expect(channel).toBeDefined();
            expect(channel!.channelId).toBe('0xdef456');
            expect(channel!.status).toBe('settled');
            expect(channel!.settledAt).toBe('2026-01-09T14:00:00.000Z');
            connector.close();
            done();
          }, 100);
        }, 100);
      });
    }, 5000);

    test('should broadcast payment channel events to clients', (done) => {
      server.start();

      const connector = new WebSocket(TEST_WS_URL);
      const client = new WebSocket(TEST_WS_URL);

      let receivedEvent = false;

      client.on('open', () => {
        client.send(
          JSON.stringify({
            type: 'CLIENT_CONNECT',
            nodeId: 'dashboard-client',
            timestamp: new Date().toISOString(),
            data: {},
          })
        );
      });

      client.on('message', (data) => {
        const message = JSON.parse(data.toString());
        if (message.type === 'PAYMENT_CHANNEL_OPENED') {
          receivedEvent = true;
          expect(message.channelId).toBe('0xbroadcast123');
          expect(message.peerId).toBe('connector-b');
        }
      });

      connector.on('open', () => {
        // Wait for client to register
        setTimeout(() => {
          connector.send(
            JSON.stringify({
              type: 'PAYMENT_CHANNEL_OPENED',
              timestamp: '2026-01-09T12:00:00.000Z',
              nodeId: 'connector-a',
              channelId: '0xbroadcast123',
              participants: ['0xAddress1', '0xAddress2'],
              peerId: 'connector-b',
              tokenAddress: '0xToken',
              tokenSymbol: 'USDC',
              settlementTimeout: 86400,
              initialDeposits: {
                '0xAddress1': '1000000000000000000',
                '0xAddress2': '0',
              },
            })
          );

          // Verify client received broadcast
          setTimeout(() => {
            expect(receivedEvent).toBe(true);
            connector.close();
            client.close();
            done();
          }, 200);
        }, 100);
      });
    }, 5000);

    test('should handle unknown channel in balance update gracefully', (done) => {
      server.start();

      const connector = new WebSocket(TEST_WS_URL);

      connector.on('open', () => {
        // Send balance update for non-existent channel
        connector.send(
          JSON.stringify({
            type: 'PAYMENT_CHANNEL_BALANCE_UPDATE',
            timestamp: '2026-01-09T12:01:00.000Z',
            nodeId: 'connector-a',
            channelId: '0xnonexistent',
            myNonce: 5,
            theirNonce: 3,
            myTransferred: '5000000000000000000',
            theirTransferred: '2000000000000000000',
          })
        );

        // Verify no crash and no channel created
        setTimeout(() => {
          const channels = server.getAllActiveChannels();
          expect(channels).toHaveLength(0);
          connector.close();
          done();
        }, 100);
      });
    }, 5000);

    test('should handle multiple channels simultaneously', (done) => {
      server.start();

      const connector = new WebSocket(TEST_WS_URL);

      connector.on('open', () => {
        // Open 3 different channels
        connector.send(
          JSON.stringify({
            type: 'PAYMENT_CHANNEL_OPENED',
            timestamp: '2026-01-09T12:00:00.000Z',
            nodeId: 'connector-a',
            channelId: '0xchannel1',
            participants: ['0xAddress1', '0xAddress2'],
            peerId: 'connector-b',
            tokenAddress: '0xToken1',
            tokenSymbol: 'USDC',
            settlementTimeout: 86400,
            initialDeposits: {},
          })
        );

        connector.send(
          JSON.stringify({
            type: 'PAYMENT_CHANNEL_OPENED',
            timestamp: '2026-01-09T12:00:00.000Z',
            nodeId: 'connector-a',
            channelId: '0xchannel2',
            participants: ['0xAddress1', '0xAddress3'],
            peerId: 'connector-c',
            tokenAddress: '0xToken2',
            tokenSymbol: 'DAI',
            settlementTimeout: 86400,
            initialDeposits: {},
          })
        );

        connector.send(
          JSON.stringify({
            type: 'PAYMENT_CHANNEL_OPENED',
            timestamp: '2026-01-09T12:00:00.000Z',
            nodeId: 'connector-a',
            channelId: '0xchannel3',
            participants: ['0xAddress1', '0xAddress4'],
            peerId: 'connector-d',
            tokenAddress: '0xToken3',
            tokenSymbol: 'USDT',
            settlementTimeout: 86400,
            initialDeposits: {},
          })
        );

        // Verify all channels stored
        setTimeout(() => {
          const channels = server.getAllActiveChannels();
          expect(channels).toHaveLength(3);
          const channelIds = channels.map((c) => c.channelId).sort();
          expect(channelIds).toEqual(['0xchannel1', '0xchannel2', '0xchannel3']);
          connector.close();
          done();
        }, 100);
      });
    }, 5000);
  });
});

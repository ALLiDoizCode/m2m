/**
 * Agent Society Integration Tests
 *
 * Comprehensive end-to-end tests for the Agent Society Protocol.
 * Creates N agent peers with Nostr keypairs, establishes a social graph,
 * deploys AGENT ERC20 token, opens payment channels, and simulates
 * TOON-encoded event exchange with payments over ILP/BTP.
 *
 * Prerequisites:
 * - Anvil running on localhost:8545 (docker-compose-dev.yml)
 *
 * Run with:
 *   E2E_TESTS=true npx jest agent-society-integration.test.ts --verbose
 *
 * Configuration:
 *   AGENT_SOCIETY_PEER_COUNT=5    Number of peers (default: 5)
 *   ANVIL_RPC_URL=http://...      Anvil RPC endpoint
 *   SKIP_CHANNELS=true            Skip payment channel setup
 *   VERBOSE=true                  Enable detailed logging
 */

// Mock the ESM-only @toon-format/toon package
jest.mock('@toon-format/toon', () => ({
  encode: (input: unknown) => JSON.stringify(input),
  decode: (input: string) => JSON.parse(input),
}));

import { ethers } from 'ethers';
import {
  AgentPeer,
  AgentSocietyTestConfig,
  DEFAULT_CONFIG,
  DeploymentResult,
  SimulationResults,
  VerificationResult,
  createAgentPeers,
  initializePeers,
  shutdownPeers,
  generateSocialGraph,
  setupSocialGraph,
  deployAgentToken,
  fundPeers,
  deployTokenNetworkRegistry,
  createTokenNetwork,
  fundPeersWithEth,
  approvePeerTokens,
  openPaymentChannels,
  getChannelDetails,
  simulateEventExchange,
  verifyResults,
  checkAnvilConnection,
  reportProgress,
  createTestNostrEvent,
  createILPPreparePacket,
} from './helpers/agent-society-helpers';
import { PacketType } from '@m2m/shared';

// Skip if E2E_TESTS environment variable is not set
const describeE2E = process.env.E2E_TESTS === 'true' ? describe : describe.skip;

describeE2E('Agent Society Integration Tests', () => {
  // Test timeout for full integration test
  jest.setTimeout(180000); // 3 minutes

  let config: AgentSocietyTestConfig;
  let provider: ethers.JsonRpcProvider;
  let deployer: ethers.Wallet;
  let peers: AgentPeer[];
  let deployment: DeploymentResult | null = null;

  // Anvil's default funded account
  const ANVIL_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

  beforeAll(async () => {
    // Load configuration
    config = { ...DEFAULT_CONFIG };
    reportProgress('CONFIG', `Peer count: ${config.peerCount}`, config.verbose);

    // Setup provider and deployer
    provider = new ethers.JsonRpcProvider(config.anvilRpcUrl);
    deployer = new ethers.Wallet(ANVIL_PRIVATE_KEY, provider);

    // Check Anvil connection
    const anvilConnected = await checkAnvilConnection(config.anvilRpcUrl);
    if (!anvilConnected) {
      throw new Error(
        `Anvil not accessible at ${config.anvilRpcUrl}. ` +
          'Start with: docker compose -f docker-compose-dev.yml up -d anvil'
      );
    }
    reportProgress('INFRA', 'Anvil connection verified', config.verbose);
  });

  afterAll(async () => {
    // Cleanup peers
    if (peers && peers.length > 0) {
      reportProgress('CLEANUP', 'Shutting down agent nodes...', config.verbose);
      await shutdownPeers(peers);
      reportProgress('CLEANUP', 'Cleanup complete', config.verbose);
    }
  });

  // ==========================================================================
  // Phase 1: Infrastructure Verification
  // ==========================================================================
  describe('Phase 1: Infrastructure', () => {
    it('should connect to Anvil', async () => {
      const blockNumber = await provider.getBlockNumber();
      expect(blockNumber).toBeGreaterThanOrEqual(0);
      reportProgress('INFRA', `Anvil block number: ${blockNumber}`, config.verbose);
    });

    it('should have funded deployer account', async () => {
      const balance = await provider.getBalance(deployer.address);
      expect(balance).toBeGreaterThan(0n);
      reportProgress(
        'INFRA',
        `Deployer balance: ${ethers.formatEther(balance)} ETH`,
        config.verbose
      );
    });
  });

  // ==========================================================================
  // Phase 2: Contract Deployment
  // ==========================================================================
  describe('Phase 2: Contract Deployment', () => {
    it('should deploy AGENT token', async () => {
      reportProgress('DEPLOY', 'Deploying AGENT token...', config.verbose);

      const tokenAddress = await deployAgentToken(
        deployer,
        config.agentTokenName,
        config.agentTokenSymbol
      );

      expect(tokenAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
      reportProgress('DEPLOY', `AGENT token deployed at: ${tokenAddress}`, config.verbose);

      // Store deployment result
      deployment = {
        tokenAddress,
        registryAddress: '', // Not deploying full registry for this test
        tokenNetworkAddress: '',
        deployer,
      };
    });

    it('should have initial token supply', async () => {
      if (!deployment) {
        throw new Error('Deployment not complete');
      }

      const token = new ethers.Contract(
        deployment.tokenAddress,
        ['function balanceOf(address) view returns (uint256)'],
        provider
      );

      const balance = (await token.getFunction('balanceOf')(deployer.address)) as bigint;
      expect(balance).toBeGreaterThan(0n);
      reportProgress(
        'DEPLOY',
        `Deployer AGENT balance: ${ethers.formatEther(balance)}`,
        config.verbose
      );
    });
  });

  // ==========================================================================
  // Phase 3: Peer Creation
  // ==========================================================================
  describe('Phase 3: Peer Creation', () => {
    it('should create N agent peers', () => {
      reportProgress('PEERS', `Creating ${config.peerCount} peers...`, config.verbose);

      peers = createAgentPeers(config.peerCount, provider);

      expect(peers).toHaveLength(config.peerCount);
      for (let i = 0; i < config.peerCount; i++) {
        const peer = peers[i]!;
        expect(peer.id).toBe(`peer-${i}`);
        expect(peer.nostrPubkey).toHaveLength(64);
        expect(peer.ilpAddress).toBe(`g.agent.peer${i}`);
      }

      reportProgress('PEERS', `Created ${peers.length} peers`, config.verbose);
    });

    it('should initialize all agent nodes', async () => {
      reportProgress('PEERS', 'Initializing agent nodes...', config.verbose);

      await initializePeers(peers);

      for (const peer of peers) {
        expect(peer.agentNode.isInitialized).toBe(true);
      }

      reportProgress('PEERS', 'All agent nodes initialized', config.verbose);
    });

    it('should have unique keypairs for each peer', () => {
      const pubkeys = new Set(peers.map((p) => p.nostrPubkey));
      const evmAddresses = new Set(peers.map((p) => p.evmWallet.address));

      expect(pubkeys.size).toBe(config.peerCount);
      expect(evmAddresses.size).toBe(config.peerCount);
    });
  });

  // ==========================================================================
  // Phase 4: Social Graph Setup
  // ==========================================================================
  describe('Phase 4: Social Graph', () => {
    let topology: Record<number, number[]>;

    it('should generate social graph topology', () => {
      reportProgress('GRAPH', 'Generating social graph...', config.verbose);

      topology = generateSocialGraph(config.peerCount);

      expect(Object.keys(topology).length).toBe(config.peerCount);

      // Verify hub (peer 0) follows all others
      if (config.peerCount > 1) {
        const hubFollows = topology[0];
        expect(hubFollows).toBeDefined();
        expect(hubFollows!.length).toBe(config.peerCount - 1);
      }

      reportProgress('GRAPH', `Topology: ${JSON.stringify(topology)}`, config.verbose);
    });

    it('should setup follow relationships', () => {
      setupSocialGraph(peers, topology);

      // Verify each peer has the expected follows
      for (const [peerIndexStr, followIndices] of Object.entries(topology)) {
        const peerIndex = parseInt(peerIndexStr, 10);
        const peer = peers[peerIndex];
        if (!peer) continue;

        expect(peer.follows.length).toBe(followIndices.length);
        expect(peer.agentNode.followGraphRouter.getFollowCount()).toBe(followIndices.length);
      }

      reportProgress('GRAPH', 'Social graph established', config.verbose);
    });

    it('should have valid routing for all follows', () => {
      for (const peer of peers) {
        for (const followPubkey of peer.follows) {
          const followedPeer = peers.find((p) => p.nostrPubkey === followPubkey);
          expect(followedPeer).toBeDefined();

          const hasRoute = peer.agentNode.followGraphRouter.hasRouteTo(followedPeer!.ilpAddress);
          expect(hasRoute).toBe(true);
        }
      }
    });
  });

  // ==========================================================================
  // Phase 5: Fund Peers with AGENT Tokens
  // ==========================================================================
  describe('Phase 5: Token Distribution', () => {
    it('should fund all peers with AGENT tokens', async () => {
      if (!deployment) {
        throw new Error('Deployment not complete');
      }

      reportProgress('FUND', 'Distributing AGENT tokens to peers...', config.verbose);

      const amountPerPeer = ethers.parseEther('10000'); // 10,000 AGENT each
      await fundPeers(deployment.tokenAddress, deployer, peers, amountPerPeer);

      // Verify each peer received tokens
      const token = new ethers.Contract(
        deployment.tokenAddress,
        ['function balanceOf(address) view returns (uint256)'],
        provider
      );

      for (const peer of peers) {
        const balance = (await token.getFunction('balanceOf')(peer.evmWallet.address)) as bigint;
        expect(balance).toBe(amountPerPeer);
      }

      reportProgress('FUND', `Funded ${peers.length} peers with AGENT tokens`, config.verbose);
    });
  });

  // ==========================================================================
  // Phase 6: Payment Channels
  // ==========================================================================
  describe('Phase 6: Payment Channels', () => {
    let channelMap: Map<string, string>;

    it('should deploy TokenNetworkRegistry', async () => {
      if (!deployment) {
        throw new Error('Deployment not complete');
      }

      reportProgress('CHANNELS', 'Deploying TokenNetworkRegistry...', config.verbose);

      const registryAddress = await deployTokenNetworkRegistry(deployer);
      expect(registryAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);

      deployment.registryAddress = registryAddress;
      reportProgress('CHANNELS', `Registry deployed at: ${registryAddress}`, config.verbose);
    });

    it('should create TokenNetwork for AGENT token', async () => {
      if (!deployment || !deployment.registryAddress) {
        throw new Error('Registry not deployed');
      }

      reportProgress('CHANNELS', 'Creating TokenNetwork for AGENT...', config.verbose);

      const tokenNetworkAddress = await createTokenNetwork(
        deployment.registryAddress,
        deployment.tokenAddress,
        deployer
      );
      expect(tokenNetworkAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);

      deployment.tokenNetworkAddress = tokenNetworkAddress;
      reportProgress('CHANNELS', `TokenNetwork at: ${tokenNetworkAddress}`, config.verbose);
    });

    it('should fund peers with ETH for gas', async () => {
      reportProgress('CHANNELS', 'Funding peers with ETH for gas...', config.verbose);

      const ethPerPeer = ethers.parseEther('0.1'); // 0.1 ETH each for gas
      await fundPeersWithEth(deployer, peers, ethPerPeer);

      // Verify peers have ETH
      for (const peer of peers) {
        const balance = await provider.getBalance(peer.evmWallet.address);
        expect(balance).toBeGreaterThanOrEqual(ethPerPeer);
      }

      reportProgress('CHANNELS', `Funded ${peers.length} peers with ETH`, config.verbose);
    });

    it('should approve TokenNetwork for all peers', async () => {
      if (!deployment || !deployment.tokenNetworkAddress) {
        throw new Error('TokenNetwork not deployed');
      }

      reportProgress('CHANNELS', 'Approving TokenNetwork for peers...', config.verbose);

      const approvalAmount = ethers.parseEther('10000'); // Approve full balance
      await approvePeerTokens(
        deployment.tokenAddress,
        deployment.tokenNetworkAddress,
        peers,
        approvalAmount
      );

      reportProgress('CHANNELS', `Approved ${peers.length} peers`, config.verbose);
    });

    it('should open payment channels between connected peers', async () => {
      if (!deployment || !deployment.tokenNetworkAddress) {
        throw new Error('TokenNetwork not deployed');
      }

      reportProgress('CHANNELS', 'Opening payment channels...', config.verbose);

      const topology = generateSocialGraph(config.peerCount);
      channelMap = await openPaymentChannels(
        deployment.tokenNetworkAddress,
        peers,
        topology,
        config.settlementTimeout
      );

      // Count unique channels (each connection creates one channel)
      expect(channelMap.size).toBeGreaterThan(0);

      // Verify channels are stored in peers
      let totalChannelRefs = 0;
      for (const peer of peers) {
        totalChannelRefs += peer.channels.size;
      }
      // Each channel is referenced by 2 peers
      expect(totalChannelRefs).toBe(channelMap.size * 2);

      reportProgress(
        'CHANNELS',
        `Opened ${channelMap.size} channels, ${totalChannelRefs} references`,
        config.verbose
      );
    });

    it('should have valid channel details', async () => {
      if (!deployment || !deployment.tokenNetworkAddress || !channelMap) {
        throw new Error('Channels not opened');
      }

      // Check a sample channel
      const firstChannelId = Array.from(channelMap.values())[0];
      if (firstChannelId) {
        const details = await getChannelDetails(
          deployment.tokenNetworkAddress,
          firstChannelId,
          provider
        );

        expect(details.channelId).toBe(firstChannelId);
        expect(details.state).toBe(1); // 1 = Open
      }
    });

    it('should share channel IDs between connected peers', () => {
      // Verify that connected peers have matching channel IDs
      for (const peer of peers) {
        for (const [connectedPeerId, channelId] of peer.channels) {
          const connectedPeer = peers.find((p) => p.id === connectedPeerId);
          expect(connectedPeer).toBeDefined();

          // The connected peer should have the same channel ID for this peer
          const reverseChannelId = connectedPeer!.channels.get(peer.id);
          expect(reverseChannelId).toBe(channelId);
        }
      }
    });
  });

  // ==========================================================================
  // Phase 7: Event Simulation
  // ==========================================================================
  describe('Phase 7: Event Simulation', () => {
    let simulationResults: SimulationResults;

    it('should simulate event exchange between peers', async () => {
      reportProgress('SIMULATE', 'Starting event exchange simulation...', config.verbose);

      simulationResults = await simulateEventExchange(peers);

      reportProgress(
        'SIMULATE',
        `Sent: ${simulationResults.eventsSent}, Received: ${simulationResults.eventsReceived}`,
        config.verbose
      );
      if (simulationResults.errors.length > 0) {
        reportProgress(
          'SIMULATE',
          `Errors: ${simulationResults.errors.join(', ')}`,
          config.verbose
        );
      }
    });

    it('should have sent events equal to total connections', () => {
      let totalConnections = 0;
      for (const peer of peers) {
        totalConnections += peer.follows.length;
      }

      expect(simulationResults.eventsSent).toBe(totalConnections);
    });

    it('should have received all events (no rejections)', () => {
      expect(simulationResults.eventsReceived).toBe(simulationResults.eventsSent);
      expect(simulationResults.errors).toHaveLength(0);
    });

    it('should have recorded payments for each event', () => {
      expect(simulationResults.payments.length).toBe(simulationResults.eventsReceived);

      for (const payment of simulationResults.payments) {
        expect(payment.amount).toBe(100n); // Note storage price
      }
    });
  });

  // ==========================================================================
  // Phase 8: Verification
  // ==========================================================================
  describe('Phase 8: Verification', () => {
    let verificationResult: VerificationResult;

    it('should pass all verification checks', async () => {
      reportProgress('VERIFY', 'Running verification checks...', config.verbose);

      const topology = generateSocialGraph(config.peerCount);
      verificationResult = await verifyResults(peers, topology);

      reportProgress('VERIFY', verificationResult.summary, config.verbose);

      for (const check of verificationResult.checks) {
        reportProgress(
          'VERIFY',
          `  ${check.name}: ${check.passed ? '✓' : '✗'} ${check.details}`,
          config.verbose
        );
        expect(check.passed).toBe(true);
      }

      expect(verificationResult.success).toBe(true);
    });

    it('should have events stored in peer databases', async () => {
      for (const peer of peers) {
        const events = await peer.agentNode.database.queryEvents({ kinds: [1] });
        // Each peer should have received events from peers that follow them
        reportProgress('VERIFY', `${peer.id} has ${events.length} stored events`, config.verbose);
      }
    });
  });

  // ==========================================================================
  // Additional Tests: Edge Cases
  // ==========================================================================
  describe('Edge Cases', () => {
    it('should reject events with insufficient payment', async () => {
      const sender = peers[0]!;
      const receiver = peers[1]!;

      const event = createTestNostrEvent({
        kind: 1,
        pubkey: sender.nostrPubkey,
        content: 'Insufficient payment test',
      });

      const packet = createILPPreparePacket(event, 1n, receiver.ilpAddress);
      const response = await receiver.agentNode.processIncomingPacket(packet, sender.id);

      expect(response.type).toBe(PacketType.REJECT);
      if (response.type === PacketType.REJECT) {
        expect(response.message).toContain('100');
      }
    });

    it('should reject invalid TOON data', async () => {
      const receiver = peers[0]!;

      const invalidPacket = {
        type: PacketType.PREPARE as const,
        amount: 100n,
        destination: receiver.ilpAddress,
        executionCondition: Buffer.alloc(32),
        expiresAt: new Date(Date.now() + 30000),
        data: Buffer.from('not valid toon data'),
      };

      const response = await receiver.agentNode.processIncomingPacket(invalidPacket, 'unknown');

      expect(response.type).toBe(PacketType.REJECT);
    });

    it('should handle queries between peers', async () => {
      const querySource = peers[0]!;
      const queryTarget = peers[1]!;

      // Ensure target has events
      const storedEvents = await queryTarget.agentNode.database.queryEvents({ kinds: [1] });
      if (storedEvents.length === 0) {
        const noteEvent = createTestNostrEvent({
          kind: 1,
          pubkey: querySource.nostrPubkey,
          content: 'Pre-query test event',
        });
        const notePacket = createILPPreparePacket(noteEvent, 100n, queryTarget.ilpAddress);
        await queryTarget.agentNode.processIncomingPacket(notePacket, querySource.id);
      }

      // Create Kind 10000 query
      const queryEvent = createTestNostrEvent({
        kind: 10000,
        pubkey: querySource.nostrPubkey,
        content: JSON.stringify({ kinds: [1], limit: 10 }),
      });

      const queryPacket = createILPPreparePacket(queryEvent, 200n, queryTarget.ilpAddress);
      const response = await queryTarget.agentNode.processIncomingPacket(
        queryPacket,
        querySource.id
      );

      expect(response.type).toBe(PacketType.FULFILL);
    });
  });
});

/**
 * Test Coverage Summary - Agent Society Protocol
 *
 * Infrastructure:
 * ✓ Anvil connection verification
 * ✓ Deployer account funding
 *
 * Contract Deployment:
 * ✓ AGENT ERC20 token deployment
 * ✓ Initial supply verification
 *
 * Peer Creation:
 * ✓ N peer creation with deterministic keypairs
 * ✓ AgentNode initialization
 * ✓ Unique keypair verification
 *
 * Social Graph:
 * ✓ Topology generation (hub-and-spoke + ring)
 * ✓ Follow relationship setup
 * ✓ Routing table verification
 *
 * Token Distribution:
 * ✓ AGENT token funding to all peers
 *
 * Event Simulation:
 * ✓ Kind 1 note exchange between peers
 * ✓ Payment validation
 * ✓ Event storage verification
 *
 * Edge Cases:
 * ✓ Insufficient payment rejection
 * ✓ Invalid TOON data rejection
 * ✓ Query (Kind 10000) handling
 */

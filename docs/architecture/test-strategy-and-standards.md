# Test Strategy and Standards

## Testing Philosophy

- **Approach:** Test-Driven Development (TDD) encouraged but not required
- **Coverage Goals:**
  - `packages/shared`: >90% (critical protocol logic)
  - `packages/connector`: >80% (core routing and BTP)
  - `packages/dashboard`: >70% (UI components - lower bar acceptable)
- **Test Pyramid:**
  - 70% Unit Tests (fast, isolated, comprehensive)
  - 20% Integration Tests (multi-component, Docker-based)
  - 10% E2E Tests (full system validation)

## Test Types and Organization

### Unit Tests

- **Framework:** Jest 29.7.x with TypeScript support (`ts-jest`)
- **File Convention:** `<filename>.test.ts` co-located with source
- **Location:** Same directory as source file (e.g., `src/core/packet-handler.test.ts`)
- **Mocking Library:** Jest built-in mocking (`jest.fn()`, `jest.mock()`)
- **Coverage Requirement:** >80% line coverage for connector, >90% for shared

**AI Agent Requirements:**
- Generate tests for all public methods and exported functions
- Cover edge cases: empty inputs, null values, maximum values, expired timestamps
- Follow AAA pattern (Arrange, Act, Assert) with clear test descriptions
- Mock all external dependencies (WebSocket, Logger, BTPClient)
- Use descriptive test names: `should reject packet when expiry time has passed`

**Example Unit Test Structure:**
```typescript
describe('PacketHandler', () => {
  let handler: PacketHandler;
  let mockRoutingTable: jest.Mocked<RoutingTable>;
  let mockLogger: jest.Mocked<Logger>;

  beforeEach(() => {
    mockRoutingTable = createMockRoutingTable();
    mockLogger = createMockLogger();
    handler = new PacketHandler(mockRoutingTable, mockLogger);
  });

  it('should reject packet when expiry time has passed', async () => {
    // Arrange
    const expiredPacket = createExpiredPreparePacket();

    // Act
    const result = await handler.processPrepare(expiredPacket);

    // Assert
    expect(result.type).toBe(PacketType.REJECT);
    expect(result.code).toBe('T00'); // Transfer Timed Out
  });
});
```

### Integration Tests

- **Scope:** Multi-component interaction within connector package
- **Location:** `packages/connector/test/integration/`
- **Test Infrastructure:**
  - **WebSocket:** Use real ws library with localhost connections (not mocked)
  - **Routing Table:** Real RoutingTable instance with test data
  - **BTP:** Real BTPServer + BTPClient connecting locally

**Example Integration Test:**
- Deploy 3 connector instances in-process
- Send ILP Prepare through Connector A
- Verify packet routed through B to C
- Validate telemetry events emitted at each hop

### End-to-End Tests

- **Framework:** Jest with Docker Compose integration
- **Scope:** Full system deployment with dashboard
- **Environment:** Automated Docker Compose startup in test
- **Test Data:** Pre-configured 3-node linear topology

**Example E2E Test Flow:**
```typescript
describe('Full System E2E', () => {
  beforeAll(async () => {
    await execAsync('docker-compose up -d');
    await waitForHealthy(['connector-a', 'connector-b', 'connector-c', 'dashboard']);
  });

  it('should forward packet through network and visualize in dashboard', async () => {
    // Send packet using CLI tool
    await sendTestPacket('connector-a', 'g.connectorC.dest', 1000);

    // Wait for telemetry
    const telemetryEvents = await collectTelemetryEvents(timeout: 5000);

    // Verify packet flow
    expect(telemetryEvents).toContainEqual(
      expect.objectContaining({ type: 'PACKET_SENT', nodeId: 'connector-a' })
    );
    expect(telemetryEvents).toContainEqual(
      expect.objectContaining({ type: 'PACKET_RECEIVED', nodeId: 'connector-c' })
    );
  });

  afterAll(async () => {
    await execAsync('docker-compose down');
  });
});
```

## Test Data Management

- **Strategy:** Factory functions for test data generation
- **Fixtures:** JSON fixtures in `test/fixtures/` for complex scenarios
- **Factories:** `createTestPreparePacket(overrides)` functions in `test/helpers/`
- **Cleanup:** Jest `afterEach` hooks reset in-memory state, Docker tests clean up containers

## Continuous Testing

- **CI Integration:**
  - `npm test` runs all unit tests
  - `npm run test:integration` runs integration tests
  - E2E tests run on main branch only (slow)
- **Performance Tests:** Separate `npm run test:perf` script (Story 4.9)
- **Security Tests:** `npm audit` in CI pipeline, dependency scanning with Dependabot

# Load Testing Guide

## Prerequisites

- Node.js >= 22.11.0
- A running connector instance (local or remote)
- The `tools/send-packet` CLI tool built and available

## Configuration

### Test Parameters

Load tests are configured via the Jest performance config:

```bash
npm run test:performance --workspace=packages/connector
```

Key configuration options:

- **Concurrent connections**: Number of simultaneous BTP connections
- **Packet rate**: Packets per second per connection
- **Duration**: Total test duration in seconds
- **Payload size**: Size of test packet data

### Environment Setup

1. Start the connector with the desired configuration
2. Ensure sufficient system resources (file descriptors, memory)
3. Configure logging to a lower level (warn) to reduce I/O overhead

## Running Load Tests

```bash
# Run the standard load test suite
cd packages/connector
npx jest --config jest.load.config.js --testPathPattern=load-test

# Run benchmarks
npm run benchmark --workspace=packages/connector
```

## Interpreting Results

- **Throughput**: Packets processed per second
- **Latency (p50/p95/p99)**: Response time percentiles
- **Error rate**: Percentage of failed packet forwards
- **Memory usage**: Heap growth over test duration

## Troubleshooting

### High Latency

- Check if TigerBeetle is enabled for accounting (reduces SQLite contention)
- Verify network latency between connector and settlement chain RPC
- Review Pino log level (debug/trace logging adds overhead)

### Connection Failures

- Increase system file descriptor limits (`ulimit -n`)
- Check WebSocket connection pool settings
- Verify BTP keepalive interval configuration

### Memory Growth

- Monitor heap snapshots during extended tests
- Check for event listener leaks in BTP client manager
- Verify proper cleanup in `afterEach` test hooks

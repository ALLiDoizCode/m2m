#!/bin/bash
# Stability test runner for settlement-executor.test.ts
# Runs tests 10 times to verify no flaky behavior
# Epic 10 Story 10.1 - Settlement Executor Test Stability

PASS_COUNT=0
FAIL_COUNT=0
TOTAL_RUNS=10

echo "===========================================" echo "Settlement Executor Stability Test Runner"
echo "Running tests $TOTAL_RUNS times sequentially"
echo "==========================================="
echo

for i in $(seq 1 $TOTAL_RUNS); do
  echo "Run $i/$TOTAL_RUNS: Running tests..."

  # Run tests and capture exit code (use --workspace to target connector package)
  npm test --workspace=packages/connector -- settlement-executor.test.ts --runInBand --silent > /dev/null 2>&1
  EXIT_CODE=$?

  if [ $EXIT_CODE -eq 0 ]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    echo "Run $i/$TOTAL_RUNS: PASS ✓"
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    echo "Run $i/$TOTAL_RUNS: FAIL ✗"

    # Re-run with verbose output to capture error
    echo "  Re-running with verbose output to capture error..."
    npm test --workspace=packages/connector -- settlement-executor.test.ts --runInBand 2>&1 | tail -20
  fi
done

echo
echo "==========================================="
echo "Stability Test Results"
echo "==========================================="
echo "Total Runs:  $TOTAL_RUNS"
echo "Passed:      $PASS_COUNT"
echo "Failed:      $FAIL_COUNT"
echo "Success Rate: $PASS_COUNT/$TOTAL_RUNS ($((PASS_COUNT * 100 / TOTAL_RUNS))%)"
echo "==========================================="

if [ $FAIL_COUNT -eq 0 ]; then
  echo "✓ All tests passed - no flaky behavior detected"
  exit 0
else
  echo "✗ Test failures detected - investigate flaky tests"
  exit 1
fi

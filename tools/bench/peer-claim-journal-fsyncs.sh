#!/usr/bin/env bash
# Issue #879: how many fdatasync calls does one forwarded peer packet cost,
# and what does that cost at the buzz-huddles rate (49 packets/second)?
#
# Drives crates/connector-runtime/examples/peer_claim_journal_bench.rs, which
# runs a real Connector over its real peer-forward path against a real
# FileJournal. This script does the two things the example deliberately does
# not do for itself:
#
#   1. COUNT. `strace -c -f -e trace=fsync,fdatasync` counts the syscalls from
#      outside the process, so the number is the kernel's and not the
#      program's own claim about itself.
#   2. INTERLEAVE. The latency runs are round-robined across modes, N rounds,
#      so every mode meets the same average machine contention. Run
#      mode-after-mode on a shared box and whatever else was running gets
#      attributed to whichever mode happened to be up at the time.
#
# Usage:
#   tools/bench/peer-claim-journal-fsyncs.sh [rounds] [seconds-per-run] [rate]
#
# Defaults: 6 rounds, 20 seconds per run, 49 packets/second. Results land in a
# timestamped directory under target/ and the per-mode summary is printed at
# the end.
#
# strace need not be on PATH: set STRACE=/path/to/strace. With no strace at
# all the script still produces the latency table and says the counts were not
# measured, rather than substituting a guess for them.
#
# WHAT IT MEASURED (2026-08-08, `tools/bench/peer-claim-journal-fsyncs.sh 8 20 49`,
# AMD Ryzen 7 5800X, ext4 on a WSL2 virtual disk, load average 0.26; full
# write-up on issue #879):
#
#   mode                  fdatasync/pkt      p50       p99   achieved
#   baseline                          1   1.80ms    2.97ms     49.0/s
#   window (ships today)              2   3.18ms    7.53ms     49.0/s
#   covering                          3   4.81ms    9.36ms     49.0/s
#   covering-no-exposure              2   3.40ms    7.74ms     49.0/s
#
# Requiring a covering claim costs +1 fdatasync and +1.8ms at p99 over the
# window path if `record_inbound_delivery` stays, and nothing measurable if it
# is retired alongside the window. Latency is linear in the fdatasync count
# (~1.5ms per sync at p50 on this disk) -- the syscall itself is 20-45us, so
# the millisecond is the ext4 journal commit. The counts are hardware
# independent; the milliseconds are this filesystem's, so rerun on the target
# box before trusting the constant. Under load average 23 the same ordering
# held with ~5.1ms per sync, and `covering` then missed 49/s.
#
# The fix the data supports: `ClaimBook` appends a packet's entries through
# three separate `append_and_project` calls (`claim.rs:845`, `:947`, `:1134`),
# each its own fdatasync, while `FileJournal::append_batch` already syncs a
# whole batch once. Batching one packet's entries makes `covering` cost 1
# fdatasync -- cheaper than the window path it replaces.

set -euo pipefail

ROUNDS="${1:-6}"
SECONDS_PER_RUN="${2:-20}"
RATE="${3:-49}"
MODES=(baseline window covering covering-no-exposure)

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

bench=./target/release/examples/peer_claim_journal_bench
echo "==> building the harness"
cargo build --release --example peer_claim_journal_bench -p connector-runtime

out="target/879-fsyncs-$(date -u +%Y%m%dT%H%M%SZ)"
journal_dir="$out/journals"
mkdir -p "$journal_dir"

packets_per_run=$((SECONDS_PER_RUN * RATE))

echo
echo "==> the filesystem the journal is fsync'd to"
df -T "$journal_dir" | tee "$out/filesystem.txt"
echo "==> machine"
{
  uname -srm
  grep -m1 'model name' /proc/cpuinfo || true
  uptime
} | tee "$out/machine.txt"

STRACE="${STRACE:-$(command -v strace || true)}"
echo
if [[ -n "$STRACE" ]]; then
  echo "==> counting fsync/fdatasync per forwarded packet ($STRACE)"
  for mode in "${MODES[@]}"; do
    echo "--- $mode"
    "$STRACE" -c -f -e trace=fsync,fdatasync \
      "$bench" --mode "$mode" --packets 500 --rate 0 --journal-dir "$journal_dir" \
      >"$out/count-$mode.out" 2>"$out/count-$mode.strace"
    grep -E 'journal_entries/pkt' "$out/count-$mode.out" || true
    grep -E 'fdatasync|fsync|calls' "$out/count-$mode.strace" || true
  done
else
  echo "==> NO strace ON PATH: syscall counts NOT measured this run."
  echo "    Set STRACE=/path/to/strace and rerun. Nothing is inferred here."
fi

echo
echo "==> latency: ${ROUNDS} interleaved rounds of ${packets_per_run} packets at ${RATE}/s"
for round in $(seq 1 "$ROUNDS"); do
  for mode in "${MODES[@]}"; do
    printf 'round %s %-22s' "$round" "$mode"
    "$bench" --mode "$mode" --packets "$packets_per_run" --rate "$RATE" \
      --journal-dir "$journal_dir" >"$out/lat-$mode-$round.out"
    awk '/achieved_rate|latency_p50_us|latency_p99_us/ {printf "%s=%s ", $1, $2}' \
      "$out/lat-$mode-$round.out"
    echo
  done
done

echo
echo "==> per-mode median across rounds, microseconds"
# `lat-covering-*.out` would also match `lat-covering-no-exposure-*.out`, so
# the round number is matched explicitly rather than by a bare `*`.
median() {
  awk -v key="$2" '$1 == key {print $2}' "$out"/lat-"$1"-[0-9]*.out |
    sort -n | awk '{v[NR]=$1} END {print (NR % 2) ? v[(NR+1)/2] : (v[NR/2]+v[NR/2+1])/2}'
}
for mode in "${MODES[@]}"; do
  printf '%-22s p50=%s  p99=%s  max=%s\n' \
    "$mode" "$(median "$mode" latency_p50_us)" \
    "$(median "$mode" latency_p99_us)" "$(median "$mode" latency_max_us)"
done

echo
echo "results in $out"

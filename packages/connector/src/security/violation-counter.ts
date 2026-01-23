/**
 * Violation Counter for Circuit Breaker Logic
 *
 * Tracks rate limit violations per peer using a sliding window
 * to enable circuit breaker functionality.
 *
 * @see Epic 12 Story 12.3 AC 6 circuit breaker requirement
 */

interface ViolationRecord {
  count: number;
  windowStart: number;
}

/**
 * Tracks violations in a sliding time window for circuit breaker logic
 */
export class ViolationCounter {
  private violations = new Map<string, ViolationRecord>();
  private windowSizeMs: number;

  /**
   * @param windowSizeSeconds - Size of the sliding window in seconds (default: 60)
   */
  constructor(windowSizeSeconds: number = 60) {
    if (windowSizeSeconds <= 0) {
      throw new Error('Violation counter window size must be positive');
    }
    this.windowSizeMs = windowSizeSeconds * 1000;
  }

  /**
   * Increment violation count for a peer
   * @param peerId - Peer identifier
   * @returns Total violations in current window
   */
  increment(peerId: string): number {
    const now = Date.now();
    const existing = this.violations.get(peerId);

    if (!existing || now - existing.windowStart >= this.windowSizeMs) {
      // Start new window
      this.violations.set(peerId, {
        count: 1,
        windowStart: now,
      });
      return 1;
    }

    // Increment existing window
    existing.count += 1;
    return existing.count;
  }

  /**
   * Get current violation count for a peer
   * @param peerId - Peer identifier
   * @returns Current violation count in window
   */
  getCount(peerId: string): number {
    const now = Date.now();
    const existing = this.violations.get(peerId);

    if (!existing) {
      return 0;
    }

    // Check if window has expired
    if (now - existing.windowStart >= this.windowSizeMs) {
      this.violations.delete(peerId);
      return 0;
    }

    return existing.count;
  }

  /**
   * Reset violation count for a peer
   * @param peerId - Peer identifier
   */
  reset(peerId: string): void {
    this.violations.delete(peerId);
  }

  /**
   * Clean up expired violation records (for maintenance)
   */
  cleanup(): void {
    const now = Date.now();
    for (const [peerId, record] of this.violations.entries()) {
      if (now - record.windowStart >= this.windowSizeMs) {
        this.violations.delete(peerId);
      }
    }
  }

  /**
   * Get all peers with active violations
   */
  getActivePeers(): string[] {
    const now = Date.now();
    const activePeers: string[] = [];

    for (const [peerId, record] of this.violations.entries()) {
      if (now - record.windowStart < this.windowSizeMs) {
        activePeers.push(peerId);
      }
    }

    return activePeers;
  }
}

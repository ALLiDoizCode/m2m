/**
 * Shortest-path computation over the link-state database (toon-meta#153).
 *
 * Dijkstra rooted at THIS node, seeded with its directly-connected peers
 * (pubkey → local peer id). Explicit v0 simplifications, decided for this
 * story:
 *
 * - **Cost-only metric**: every hop costs 1, plus the announced per-prefix
 *   `cost` at the delivering node. No liquidity/latency weighting.
 * - **Adjacency union**: an edge `A—B` exists when EITHER side announces the
 *   other (union, not intersection). Announcements propagate asynchronously,
 *   so requiring bidirectional confirmation would black-hole routes for a full
 *   refresh cycle after every topology change; the union converges faster and
 *   a wrong edge merely yields an F02 further down the path.
 * - **Deterministic tie-breaks**: equal-cost candidates resolve to the
 *   lexicographically smaller first-hop peer id, then the smaller announcer
 *   pubkey, so recomputation is stable (no route flapping between recomputes).
 *
 * Pure module — no I/O, no timers — so it unit-tests with plain data.
 *
 * @module routing/path-computation
 */

import type { LinkStateEntry } from './link-state-db';

/** A directly-connected neighbor seed for the Dijkstra root. */
export interface DirectNeighbor {
  /** The neighbor's Nostr pubkey (64-hex). */
  pubkey: string;
  /** The LOCAL peer id (BTP peer set) packets to this neighbor egress on. */
  peerId: string;
}

/** One computed multi-hop route candidate. */
export interface ComputedRoute {
  /** ILP address prefix reachable via this route. */
  prefix: string;
  /** First-hop peer id (always one of the {@link DirectNeighbor} peer ids). */
  nextHop: string;
  /** Total path cost: hop count + the delivering node's announced prefix cost. */
  cost: number;
  /** Announcer pubkey whose announcement sourced this prefix. */
  sourcePubkey: string;
}

interface NodeState {
  dist: number;
  firstHop: string;
}

/**
 * Compute the best route per reachable prefix.
 *
 * @param entries - Current link-state database snapshot.
 * @param neighbors - This node's directly-connected peers with known pubkeys.
 * @param ownPubkey - This node's own pubkey; its own announcement is excluded
 *   (never learn a route to yourself), pass `undefined` when unknown.
 * @returns Best route per prefix, sorted by prefix for deterministic install order.
 */
export function computeRoutes(
  entries: LinkStateEntry[],
  neighbors: DirectNeighbor[],
  ownPubkey?: string
): ComputedRoute[] {
  const byPubkey = new Map<string, LinkStateEntry>();
  for (const entry of entries) {
    if (entry.pubkey !== ownPubkey) {
      byPubkey.set(entry.pubkey, entry);
    }
  }

  // Undirected adjacency union: add both directions of every declared edge.
  const edges = new Map<string, Set<string>>();
  const addEdge = (a: string, b: string): void => {
    if (a === b) return;
    let setA = edges.get(a);
    if (!setA) {
      setA = new Set();
      edges.set(a, setA);
    }
    setA.add(b);
    let setB = edges.get(b);
    if (!setB) {
      setB = new Set();
      edges.set(b, setB);
    }
    setB.add(a);
  };
  for (const entry of byPubkey.values()) {
    for (const neighborPubkey of entry.routing.adjacency) {
      if (neighborPubkey !== ownPubkey) {
        addEdge(entry.pubkey, neighborPubkey);
      }
    }
  }

  // Dijkstra seeded at the direct neighbors (distance 1 from this node), with
  // deterministic tie-breaks on (dist, firstHop). Uniform edge weight of 1
  // means a simple sorted frontier suffices at these graph sizes.
  const state = new Map<string, NodeState>();
  const better = (candidate: NodeState, incumbent: NodeState | undefined): boolean => {
    if (!incumbent) return true;
    if (candidate.dist !== incumbent.dist) return candidate.dist < incumbent.dist;
    return candidate.firstHop < incumbent.firstHop;
  };

  const sortedNeighbors = [...neighbors].sort((a, b) => (a.peerId < b.peerId ? -1 : 1));
  const frontier: Array<{ pubkey: string } & NodeState> = [];
  for (const neighbor of sortedNeighbors) {
    const seed: NodeState = { dist: 1, firstHop: neighbor.peerId };
    if (better(seed, state.get(neighbor.pubkey))) {
      state.set(neighbor.pubkey, seed);
      frontier.push({ pubkey: neighbor.pubkey, ...seed });
    }
  }

  const settled = new Set<string>();
  while (frontier.length > 0) {
    frontier.sort((a, b) =>
      a.dist !== b.dist ? a.dist - b.dist : a.firstHop < b.firstHop ? -1 : 1
    );
    const current = frontier.shift()!;
    if (settled.has(current.pubkey)) continue;
    const currentState = state.get(current.pubkey);
    if (!currentState || currentState.dist !== current.dist) continue;
    settled.add(current.pubkey);

    for (const nextPubkey of edges.get(current.pubkey) ?? []) {
      if (settled.has(nextPubkey)) continue;
      const candidate: NodeState = { dist: current.dist + 1, firstHop: currentState.firstHop };
      if (better(candidate, state.get(nextPubkey))) {
        state.set(nextPubkey, candidate);
        frontier.push({ pubkey: nextPubkey, ...candidate });
      }
    }
  }

  // Best route per prefix across all reachable announcers.
  const best = new Map<string, ComputedRoute>();
  for (const entry of byPubkey.values()) {
    const nodeState = state.get(entry.pubkey);
    if (!nodeState) continue; // unreachable announcer — no route
    for (const { prefix, cost } of entry.routing.prefixes) {
      const candidate: ComputedRoute = {
        prefix,
        nextHop: nodeState.firstHop,
        cost: nodeState.dist + (cost ?? 0),
        sourcePubkey: entry.pubkey,
      };
      const incumbent = best.get(prefix);
      if (
        !incumbent ||
        candidate.cost < incumbent.cost ||
        (candidate.cost === incumbent.cost &&
          (candidate.nextHop < incumbent.nextHop ||
            (candidate.nextHop === incumbent.nextHop &&
              candidate.sourcePubkey < incumbent.sourcePubkey)))
      ) {
        best.set(prefix, candidate);
      }
    }
  }

  return Array.from(best.values()).sort((a, b) => (a.prefix < b.prefix ? -1 : 1));
}

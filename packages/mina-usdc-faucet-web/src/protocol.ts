/**
 * Message protocol between the UI (main thread) and the o1js prover worker.
 * All heavy o1js work (compile + prove) runs in the worker; the main thread
 * only sends requests and renders progress.
 */

export type WorkerRequest =
  | { id: number; kind: 'compile' }
  | {
      id: number;
      kind: 'buildAndProve';
      feePayer: string;
      recipient: string;
      wholeUsdc: string; // bigint serialized
    };

export type WorkerResponse =
  | { id: number; kind: 'progress'; stage: ProveStage; message: string }
  | { id: number; kind: 'compiled' }
  | {
      id: number;
      kind: 'proven';
      /** o1js `tx.toJSON()` — a proven zkApp command; Auro adds the fee-payer sig. */
      txJson: string;
      /** How many new accounts the tx funds (0 or 2) — for UI copy. */
      fundNewAccounts: number;
    }
  | { id: number; kind: 'error'; message: string };

export type ProveStage = 'compiling' | 'fetching' | 'building' | 'proving' | 'done';

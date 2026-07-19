/**
 * Auro wallet (`window.mina`) integration.
 *
 * Only three calls are needed:
 *   - `requestAccounts()` — connect + get the active address.
 *   - `requestNetwork()`  — read the wallet's current chain (to warn if the user
 *     is not on devnet; the proof is built for devnet and a mainnet send fails).
 *   - `sendTransaction({ transaction })` — hand Auro the PROVEN zkApp command
 *     JSON; Auro adds the fee-payer signature and broadcasts. `feePayer` sets the
 *     fee; the recipient is inside the proof and never signs.
 */

import { EXPECTED_NETWORK_HINTS } from './config';

interface MinaProvider {
  requestAccounts(): Promise<string[]>;
  getAccounts?(): Promise<string[]>;
  requestNetwork?(): Promise<{ networkID?: string; chainId?: string; name?: string }>;
  sendTransaction(args: {
    transaction: string;
    feePayer?: { fee?: number; memo?: string };
  }): Promise<{ hash: string }>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    mina?: MinaProvider;
  }
}

export function isAuroInstalled(): boolean {
  return typeof window !== 'undefined' && !!window.mina;
}

export function getProvider(): MinaProvider {
  if (!window.mina) throw new Error('Auro wallet not found');
  return window.mina;
}

export async function connect(): Promise<string> {
  const accounts = await getProvider().requestAccounts();
  if (!accounts.length) throw new Error('No account returned by Auro');
  return accounts[0];
}

export interface NetworkInfo {
  raw: string;
  isDevnet: boolean;
}

export async function getNetwork(): Promise<NetworkInfo | null> {
  const p = getProvider();
  if (!p.requestNetwork) return null;
  try {
    const net = await p.requestNetwork();
    const raw = (net.networkID || net.chainId || net.name || '').toLowerCase();
    const isDevnet = EXPECTED_NETWORK_HINTS.some((h) => raw.includes(h));
    return { raw, isDevnet };
  } catch {
    return null;
  }
}

/** Send a proven zkApp command JSON; Auro signs the fee payer + broadcasts. */
export async function sendProvenTx(txJson: string, feeMina = 0.1): Promise<string> {
  const result = await getProvider().sendTransaction({
    transaction: txJson,
    feePayer: { fee: feeMina, memo: 'devnet USDC faucet mint' },
  });
  return result.hash;
}

/** Subscribe to account/chain changes so the UI can re-render. */
export function onWalletChange(handler: () => void): void {
  const p = window.mina;
  if (!p?.on) return;
  p.on('accountsChanged', handler);
  p.on('chainChanged', handler);
}

/**
 * Mina Devnet USDC Faucet — UI orchestration (main thread).
 *
 * Flow: connect Auro → editable recipient field (defaults to connected acct) →
 * "Get 1000 test USDC" → worker compiles (once) + builds + proves the mint tx →
 * Auro signs the fee payer + broadcasts → show the tx hash on minascan.
 *
 * All o1js work happens in prover.worker.ts; this file never imports o1js, so
 * the page stays responsive and the bundle split keeps the wasm off the main
 * thread.
 */

import './style.css';
import {
  ADMIN_CONTRACT_ADDRESS,
  AURO_URL,
  FAUCET_MINT_WHOLE_USDC,
  MINASCAN_ACCOUNT,
  MINASCAN_TX,
  MINA_FAUCET_URL,
  TOKEN_ADDRESS,
} from './config';
import { fetchAllowance, formatUsdc, type AllowanceInfo } from './allowance';
import {
  connect,
  getNetwork,
  isAuroInstalled,
  onWalletChange,
  sendProvenTx,
} from './wallet';
import type { ProveStage, WorkerRequest, WorkerResponse } from './protocol';

// ─── Prover worker (compile happens once, in the background, per session) ─────
const worker = new Worker(new URL('./prover.worker.ts', import.meta.url), {
  type: 'module',
});
let reqSeq = 1;
let compileStarted = false;
let compiled = false;

type ProveResult = { txJson: string; fundNewAccounts: number };
const pending = new Map<
  number,
  { resolve: (r: ProveResult) => void; reject: (e: Error) => void }
>();

// The worker emits `progress` decoupled from any single request id (id 0), so we
// route progress to whichever operation is currently in flight.
let currentProgress: ((stage: ProveStage, message: string) => void) | null = null;

worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
  const msg = ev.data;
  if (msg.kind === 'progress') {
    currentProgress?.(msg.stage, msg.message);
    return;
  }
  const p = pending.get(msg.id);
  if (msg.kind === 'compiled') {
    compiled = true;
    p?.resolve({ txJson: '', fundNewAccounts: 0 });
    pending.delete(msg.id);
    render();
  } else if (msg.kind === 'proven') {
    p?.resolve({ txJson: msg.txJson, fundNewAccounts: msg.fundNewAccounts });
    pending.delete(msg.id);
  } else if (msg.kind === 'error') {
    p?.reject(new Error(msg.message));
    pending.delete(msg.id);
  }
};

// Distributive Omit so each union member is stripped of `id` individually
// (a plain Omit<Union, 'id'> collapses the members and rejects member-specific
// fields like `feePayer`).
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function ask(
  req: DistributiveOmit<WorkerRequest, 'id'>,
  onProgress?: (stage: ProveStage, message: string) => void
): Promise<ProveResult> {
  const id = reqSeq++;
  if (onProgress) currentProgress = onProgress;
  return new Promise<ProveResult>((resolve, reject) => {
    pending.set(id, {
      resolve: (r) => {
        if (onProgress && currentProgress === onProgress) currentProgress = null;
        resolve(r);
      },
      reject: (e) => {
        if (onProgress && currentProgress === onProgress) currentProgress = null;
        reject(e);
      },
    });
    worker.postMessage({ ...req, id } as WorkerRequest);
  });
}

function startCompile() {
  if (compileStarted || compiled) return;
  compileStarted = true;
  state.compileError = false;
  render();
  ask({ kind: 'compile' }).catch((e) => {
    // Reset so the user can retry a fresh compile (the worker also resets its
    // memoized compile promise on failure, so a retry recompiles cleanly).
    compileStarted = false;
    state.compileError = true;
    console.error('compile failed', e);
    setBanner('err', 'Could not prepare the proving circuits. Please retry.');
  });
}

// ─── App state ────────────────────────────────────────────────────────────────
interface State {
  account: string | null;
  networkOk: boolean | null; // null = unknown
  networkRaw: string;
  recipient: string;
  allowance: AllowanceInfo | null;
  allowanceLoading: boolean;
  banner: { kind: 'ok' | 'err' | 'warn' | 'info'; html: string } | null;
  proving: boolean;
  proveStage: ProveStage | null;
  proveMessage: string;
  txHash: string | null;
  compileError: boolean;
}

const state: State = {
  account: null,
  networkOk: null,
  networkRaw: '',
  recipient: '',
  allowance: null,
  allowanceLoading: false,
  banner: null,
  proving: false,
  proveStage: null,
  proveMessage: '',
  txHash: null,
  compileError: false,
};

function setBanner(kind: State['banner'] extends null ? never : 'ok' | 'err' | 'warn' | 'info', html: string) {
  state.banner = { kind, html };
  render();
}

const shorten = (a: string) => (a.length > 16 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);
const isValidAddr = (a: string) => /^B62q[1-9A-HJ-NP-Za-km-z]{40,60}$/.test(a.trim());

// ─── Actions ──────────────────────────────────────────────────────────────────
async function doConnect() {
  if (!isAuroInstalled()) {
    setBanner('err', `Auro wallet is not installed. <a href="${AURO_URL}" target="_blank" rel="noopener">Install Auro</a> and reload.`);
    return;
  }
  try {
    const account = await connect();
    state.account = account;
    if (!state.recipient) state.recipient = account;
    state.banner = null;
    const net = await getNetwork();
    state.networkOk = net ? net.isDevnet : null;
    state.networkRaw = net?.raw ?? '';
    startCompile();
    render();
    void refreshAllowance();
  } catch (e) {
    setBanner('err', `Could not connect: ${(e as Error).message}`);
  }
}

async function refreshAllowance() {
  const r = state.recipient.trim();
  if (!isValidAddr(r)) {
    state.allowance = null;
    render();
    return;
  }
  state.allowanceLoading = true;
  render();
  try {
    state.allowance = await fetchAllowance(r);
  } catch (e) {
    console.error('allowance fetch failed', e);
    state.allowance = null;
  } finally {
    state.allowanceLoading = false;
    render();
  }
}

async function doMint() {
  const recipient = state.recipient.trim();
  if (!isValidAddr(recipient)) {
    setBanner('err', 'Enter a valid Mina address (starts with B62q).');
    return;
  }
  if (!state.account) return;
  state.proving = true;
  state.txHash = null;
  state.banner = null;
  state.proveStage = compiled ? 'building' : 'compiling';
  state.proveMessage = compiled ? 'Preparing…' : 'Compiling circuits (first time, ~10–30s)…';
  render();

  try {
    const { txJson } = await ask(
      {
        kind: 'buildAndProve',
        feePayer: state.account,
        recipient,
        wholeUsdc: FAUCET_MINT_WHOLE_USDC.toString(),
      },
      (stage, message) => {
        state.proveStage = stage;
        state.proveMessage = message;
        render();
      }
    );

    state.proveStage = 'done';
    state.proveMessage = 'Proof ready — approve the fee in Auro to broadcast…';
    render();

    const hash = await sendProvenTx(txJson, 0.1);
    state.txHash = hash;
    state.proving = false;
    setBanner(
      'ok',
      `Mint submitted! <a href="${MINASCAN_TX(hash)}" target="_blank" rel="noopener">View on minascan ↗</a> — 1000 USDC will land after inclusion (a few minutes).`
    );
    void refreshAllowance();
  } catch (e) {
    state.proving = false;
    state.proveStage = null;
    const msg = (e as Error).message || String(e);
    if (/reject|denied|cancel/i.test(msg)) {
      setBanner('warn', 'Transaction was rejected in Auro. You can try again.');
    } else if (/global context|inconsistent state|parallel|concurrently/i.test(msg)) {
      // Should not happen (o1js work is serialized in the worker), but surface a
      // clean retry instead of a raw o1js stack if it ever does.
      setBanner('err', 'The prover hit a transient error. Please click the button to try again.');
    } else {
      setBanner('err', `Mint failed: ${msg}`);
    }
  }
}

// ─── Render ───────────────────────────────────────────────────────────────────
const root = document.getElementById('app')!;

function render() {
  root.innerHTML = view();
  wire();
}

function proveSteps(): string {
  if (!state.proving && !state.txHash) return '';
  const order: { key: ProveStage; label: string }[] = [
    { key: 'compiling', label: 'Compile circuits' },
    { key: 'fetching', label: 'Read on-chain state' },
    { key: 'building', label: 'Build mint transaction' },
    { key: 'proving', label: 'Generate zero-knowledge proof' },
    { key: 'done', label: 'Sign in Auro + broadcast' },
  ];
  const rank = (s: ProveStage | null) => order.findIndex((o) => o.key === s);
  const cur = rank(state.proveStage);
  return `<ul class="progress-list">${order
    .map((o, i) => {
      const done = i < cur || (state.txHash && o.key === 'done');
      const active = i === cur && state.proving;
      const cls = done ? 'done' : active ? 'active' : '';
      const ic = done ? '✓' : active ? '<span class="spin"></span>' : '○';
      return `<li class="${cls}"><span class="ic">${ic}</span>${o.label}</li>`;
    })
    .join('')}</ul>`;
}

function allowanceView(): string {
  if (!state.account) return '';
  if (state.allowanceLoading && !state.allowance)
    return `<div class="card"><div class="hint">Reading today's allowance…</div></div>`;
  const a = state.allowance;
  if (!a) return '';
  const remaining = formatUsdc(a.remainingBaseUnits);
  const pct = Number((a.remainingBaseUnits * 100n) / (a.capWholeUsdc * 1_000_000n));
  return `
    <div class="card">
      <div class="allowance">
        <div><span class="big">${remaining}</span> / ${a.capWholeUsdc} USDC</div>
        <div class="hint">remaining in today's window</div>
      </div>
      <div class="meter"><span style="width:${Math.max(0, Math.min(100, pct))}%"></span></div>
      ${
        a.exhausted
          ? `<div class="hint" style="margin-top:8px">This address hit its 1000 USDC daily cap. The window resets ~24h after the first mint${a.windowReset ? '' : ''}. Try a different address, or come back later.</div>`
          : `<div class="hint" style="margin-top:8px">Each address may receive up to 1000 test-USDC per ~24h, enforced on-chain by the mint proof.</div>`
      }
    </div>`;
}

function bannerView(): string {
  if (!state.banner) return '';
  const kindClass = state.banner.kind === 'info' ? 'warn' : state.banner.kind;
  return `<div class="status ${kindClass}" style="margin-bottom:16px">${state.banner.html}</div>`;
}

function view(): string {
  const connected = !!state.account;
  const netWarn =
    connected && state.networkOk === false
      ? `<div class="status warn" style="margin-bottom:16px">Auro is on <b>${state.networkRaw || 'an unknown network'}</b>. Switch Auro to <b>Devnet</b> or the mint will fail.</div>`
      : '';

  // Gate the button until circuits are compiled: this both prevents a click
  // that would race an in-flight compile AND sets honest expectations. (The
  // worker also serializes all o1js work, so this is defense-in-depth.)
  const mintDisabled =
    state.proving ||
    !connected ||
    !compiled ||
    !isValidAddr(state.recipient) ||
    state.allowance?.exhausted === true;

  const mintLabel = state.proving
    ? state.proveMessage || 'Working…'
    : connected && !compiled
      ? 'Compiling circuits… (~30s, one time)'
      : `Get ${FAUCET_MINT_WHOLE_USDC} test USDC`;

  return `
    <div class="brand">
      <div class="logo">$</div>
      <div>
        <h1>Mina Devnet USDC Faucet</h1>
        <div class="sub">Free mock-USDC for testing — no real value.</div>
      </div>
    </div>

    <div class="card explain">
      This faucet mints <b>mock USDC</b> on the <b>Mina devnet</b> to any address you choose.
      It's <b>permissionless</b>: the recipient never signs — you (the connected wallet) only
      pay the network fee.
      <ul>
        <li>Up to <b>1000 test-USDC per address per ~24h</b>, enforced on-chain by a zero-knowledge proof.</li>
        <li>You need <a href="${AURO_URL}" target="_blank" rel="noopener">Auro wallet</a> on <b>Devnet</b> and a little devnet MINA for the ~0.1 MINA fee — get some at the <a href="${MINA_FAUCET_URL}" target="_blank" rel="noopener">MINA faucet ↗</a>.</li>
        <li>Proving runs in your browser and takes ~10–40s the first time (circuits compile once).</li>
      </ul>
    </div>

    ${bannerView()}
    ${netWarn}

    ${
      connected
        ? `<div class="card">
             <div class="row wrap" style="justify-content:space-between">
               <span class="chip"><span class="dot ${state.networkOk === false ? 'warn' : ''}"></span>${shorten(state.account!)}</span>
               <span class="hint">${
                 compiled
                   ? 'circuits ready'
                   : state.compileError
                     ? '<button class="ghost" id="retry-compile" style="width:auto;padding:4px 10px;font-size:0.8rem">Retry compile</button>'
                     : 'compiling circuits…'
               }</span>
             </div>
           </div>`
        : `<div class="card">
             <button class="primary" id="connect">${isAuroInstalled() ? 'Connect Auro wallet' : 'Install Auro wallet'}</button>
             ${!isAuroInstalled() ? `<div class="hint" style="margin-top:8px">Then reload this page.</div>` : ''}
           </div>`
    }

    ${
      connected
        ? `<div class="card">
             <label for="recipient">Mint to address</label>
             <input type="text" id="recipient" value="${state.recipient}" spellcheck="false" autocapitalize="off" placeholder="B62q…" />
             <div class="hint">Defaults to your wallet. Edit it to send test-USDC to <b>any</b> Mina address.</div>
             <div class="spacer"></div>
             ${allowanceView()}
             <button class="primary" id="mint" ${mintDisabled ? 'disabled' : ''}>${mintLabel}</button>
             ${proveSteps()}
           </div>`
        : ''
    }

    <div class="card tokenline">
      Token: <span class="mono break">${TOKEN_ADDRESS}</span>
      <div style="margin-top:6px"><a href="${MINASCAN_ACCOUNT(TOKEN_ADDRESS)}" target="_blank" rel="noopener">Token on minascan ↗</a> · <a href="${MINASCAN_ACCOUNT(ADMIN_CONTRACT_ADDRESS)}" target="_blank" rel="noopener">Admin contract ↗</a></div>
    </div>

    <div class="footer">Devnet test tokens only · built with o1js + Auro</div>
  `;
}

function wire() {
  const connectBtn = document.getElementById('connect');
  if (connectBtn) connectBtn.addEventListener('click', () => void doConnect());

  const mintBtn = document.getElementById('mint');
  if (mintBtn) mintBtn.addEventListener('click', () => void doMint());

  const retryBtn = document.getElementById('retry-compile');
  if (retryBtn) retryBtn.addEventListener('click', () => startCompile());

  const input = document.getElementById('recipient') as HTMLInputElement | null;
  if (input) {
    input.addEventListener('input', () => {
      state.recipient = input.value;
    });
    let t: ReturnType<typeof setTimeout>;
    input.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => void refreshAllowance(), 500);
    });
  }
}

onWalletChange(() => {
  // Re-read the active account/network on wallet changes.
  void (async () => {
    try {
      const net = await getNetwork();
      state.networkOk = net ? net.isDevnet : null;
      state.networkRaw = net?.raw ?? '';
    } catch {
      /* ignore */
    }
    render();
  })();
});

// Initial paint. If Auro is already authorized, offer connect (Auro requires a
// user gesture for requestAccounts, so we don't auto-connect).
render();

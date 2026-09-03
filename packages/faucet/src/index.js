import express from 'express';
import cors from 'cors';
import { ethers, NonceManager } from 'ethers';
import { createSolanaFaucet } from './solana.js';
import { createBaseSepoliaFaucet, baseSepoliaInfo } from './base-sepolia.js';

const app = express();
const PORT = process.env.PORT || 3500;

// Configuration
const RPC_URL = process.env.RPC_URL || 'http://anvil:8545';
const ETH_PRIVATE_KEY =
  process.env.ETH_PRIVATE_KEY ||
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // Anvil Account 1
const TOKEN_PRIVATE_KEY =
  process.env.TOKEN_PRIVATE_KEY ||
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'; // Anvil Account 0 (deployer)
const TOKEN_ADDRESS = process.env.TOKEN_ADDRESS;
const ETH_AMOUNT = process.env.ETH_AMOUNT || '100'; // 100 ETH
const TOKEN_AMOUNT = process.env.TOKEN_AMOUNT || '10000'; // 10,000 USDC tokens

// ERC20 ABI (minimal)
const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Setup provider and wallets
const provider = new ethers.JsonRpcProvider(RPC_URL);
const ethWallet = new NonceManager(new ethers.Wallet(ETH_PRIVATE_KEY, provider));
const tokenWallet = new NonceManager(new ethers.Wallet(TOKEN_PRIVATE_KEY, provider));

// Token contract instance (will be set after deployment)
let tokenContract = null;
let tokenSymbol = 'USDC';
let tokenDecimals = 18;

// Solana faucet (null when not configured — EVM-only deploys still work).
const solanaFaucet = createSolanaFaucet();

// Read the mint's authority once, in the BACKGROUND, at boot. The leg mints on
// demand, so it can only serve a mint this faucet is the authority of; that is
// an on-chain fact `createSolanaFaucet` cannot check without dialling (it is
// synchronous by design). Doing it here means a box wired to the wrong mint
// says so in its logs at startup instead of at the first drip request hours
// later. Non-fatal: the drip path awaits the same memoised check and answers
// 503, and a failure caused by an unreachable RPC is not cached.
if (solanaFaucet) {
  solanaFaucet
    .assertMintAuthority()
    .then(() =>
      console.log('   Mint authority confirmed: this faucet can mint its configured USDC.')
    )
    .catch((err) => console.error('⚠️  Solana USDC leg will refuse drips:', err.message));
}

// Base Sepolia faucet (null when BASE_SEPOLIA_FAUCET_KEY unset — route 503s).
// Mints the ungated public mock USDC on the PUBLIC Base Sepolia testnet
// (chainId 84532) + best-effort ETH gas. Mirrors createSolanaFaucet's shape.
const baseSepoliaFaucet = createBaseSepoliaFaucet();

// Serialize Solana drips the same way EVM ones are, so concurrent requests
// don't race the treasury's transaction signing / blockhash reuse.
let solanaQueue = Promise.resolve();

// Serialize Base Sepolia drips the same way the anvil EVM leg is — the faucet
// key's nonce is read-then-spent, so concurrent mint txs must not race it.
let baseSepoliaQueue = Promise.resolve();

// Initialize token contract.
//
// Crucially, this verifies the token actually has on-chain code before
// reporting ready. The previous implementation set `tokenContract` from the
// address alone, so `/health` `tokenReady` was a FALSE signal: it returned
// true even when nothing was deployed at TOKEN_ADDRESS (e.g. the anvil
// `forge script` deploy silently failed). The standalone-settlement-e2e
// readiness wait then passed, and the suite crashed on `BigInt('0x')` because
// `balanceOf` had no contract to call. See issue #104.
async function initTokenContract() {
  if (!TOKEN_ADDRESS) {
    console.log('⚠️  TOKEN_ADDRESS not set. Waiting for contract deployment...');
    tokenContract = null;
    return false;
  }

  try {
    // Verify on-chain code exists at TOKEN_ADDRESS — an undeployed token
    // returns '0x' here. This is the honest readiness check.
    const code = await provider.getCode(TOKEN_ADDRESS);
    if (!code || code === '0x') {
      console.log(`⚠️  No contract code at ${TOKEN_ADDRESS} yet — token not deployed.`);
      tokenContract = null;
      return false;
    }

    const contract = new ethers.Contract(TOKEN_ADDRESS, ERC20_ABI, tokenWallet);
    tokenSymbol = await contract.symbol();
    tokenDecimals = await contract.decimals();
    // Only publish the contract (flip tokenReady true) once all reads succeed.
    tokenContract = contract;
    console.log(`✅ Token contract initialized: ${tokenSymbol} at ${TOKEN_ADDRESS}`);
    return true;
  } catch (error) {
    console.error('❌ Failed to initialize token contract:', error.message);
    tokenContract = null;
    return false;
  }
}

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    tokenAddress: TOKEN_ADDRESS,
    tokenReady: !!tokenContract,
  });
});

// Get faucet info
app.get('/api/info', async (req, res) => {
  try {
    // EVM balances are best-effort: under a Solana-only deploy the EVM RPC is
    // unreachable, but /api/info must still advertise the Solana route.
    // Never let an EVM RPC error 500 the whole capability map.
    let ethBalance = null;
    let tokenBalance = '0';
    try {
      ethBalance = await provider.getBalance(ethWallet.address);
      if (tokenContract) {
        const balance = await tokenContract.balanceOf(tokenWallet.address);
        tokenBalance = ethers.formatUnits(balance, tokenDecimals);
      }
    } catch {
      // EVM unreachable — leave balances null/0 and report ready:false below.
    }

    res.json({
      // ── EVM (legacy top-level fields kept for backwards compatibility) ──
      ethAmount: ETH_AMOUNT,
      tokenAmount: TOKEN_AMOUNT,
      tokenSymbol,
      tokenAddress: TOKEN_ADDRESS,
      faucetBalances: {
        eth: ethBalance === null ? null : ethers.formatEther(ethBalance),
        token: tokenBalance,
      },
      ready: !!tokenContract,

      // ── Per-chain capability map ──
      //
      // USDC only (toon-meta#310 §4.6, connector#898): this faucet dispenses no
      // native gas/token of any chain — the local-anvil EVM leg (`/api/request`)
      // and the native-SOL leg are gone, not just unconfigured. The Mina leg
      // went with Mina itself (ADR 0065). Each surviving leg advertises only
      // its USDC-drip route.
      chains: {
        solana: solanaFaucet
          ? {
              enabled: true,
              route: '/api/solana/usdc-request',
              ready: true,
              drips: { usdc: String(solanaFaucet.usdcAmount) },
              cooldownHours: String(solanaFaucet.cooldownMs / 3_600_000),
              usdcMint: solanaFaucet.mint,
              rpcUrl: solanaFaucet.rpcUrl,
              mintMode: solanaFaucet.mintMode,
            }
          : { enabled: false, route: '/api/solana/usdc-request', ready: false },
        baseSepolia: baseSepoliaInfo(baseSepoliaFaucet),
      },
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get faucet info',
      message: error.message,
    });
  }
});

// ---------------------------------------------------------------------------
// Solana route — POST /api/solana/usdc-request { address }
//
// USDC only (no SOL leg at all — the SOL-dispensing route it used to sit beside
// is retired, toon-meta#310 §4.6): transfers mock USDC from the devnet treasury.
// The treasury pays the fee + ATA rent, so this succeeds even when the public
// devnet airdrop is dry/rate-limited and even if the recipient holds 0 SOL.
// Recipients get their SOL for gas from the chain's own faucet.
// ---------------------------------------------------------------------------
app.post('/api/solana/usdc-request', (req, res) => {
  if (!solanaFaucet) {
    res.status(503).json({
      error: 'Solana faucet not configured',
      message: 'Set SOLANA_USDC_MINT and mount SOLANA_FAUCET_KEYPAIR to enable the Solana route.',
    });
    return;
  }

  const { address } = req.body || {};
  if (!address || !solanaFaucet.isValidAddress(address)) {
    res.status(400).json({ error: 'Invalid Solana address (expected base58 pubkey)' });
    return;
  }

  // Per-address cooldown: minting is unbounded on-chain (this faucet holds the
  // authority), so this window is the only limit. The drip also spends the
  // faucet's own SOL on the tx fee and a possible ATA rent, but never sends
  // SOL to the recipient.
  const claim = solanaFaucet.claim(address);
  if (!claim.allowed) {
    res
      .status(429)
      .set('Retry-After', String(Math.ceil(claim.retryAfterMs / 1000)))
      .json({
        error: 'Solana drip rate limit',
        message: 'This address already received a Solana drip inside the cooldown window.',
        retryAfterMs: claim.retryAfterMs,
      });
    return;
  }

  console.log(`💧 Solana USDC-only faucet request for ${address}`);
  solanaQueue = solanaQueue
    .then(async () => {
      const result = await solanaFaucet.drip(address);
      console.log(`  ✅ Solana USDC-only request completed for ${address}`);
      res.json({
        success: true,
        chain: 'solana',
        mode: 'usdc-only',
        address,
        transactions: result,
      });
    })
    .catch((error) => {
      solanaFaucet.release(address);
      console.error('❌ Solana USDC-only request failed:', error);
      if (!res.headersSent) {
        if (error.code === 'VALIDATOR_STALLED') {
          res.status(503).json({
            error: 'Solana validator not producing blocks',
            message: error.message,
          });
          return;
        }
        // Misconfiguration, not a failed request: this box cannot mint the
        // token it is pointed at, and no retry will change that. 503 (not 500)
        // for the same reason an unconfigured leg 503s — the fault is the
        // deploy's, and the message names both keys.
        if (error.code === 'MINT_AUTHORITY_MISMATCH') {
          res.status(503).json({
            error: "Solana faucet is not this mint's authority",
            message: error.message,
          });
          return;
        }
        res.status(500).json({
          error: 'Solana USDC-only request failed',
          message: error.message,
        });
      }
    });
});

// ---------------------------------------------------------------------------
// Base Sepolia route — POST /api/base-sepolia/request { address }
//
// Mints the ungated mock USDC on the PUBLIC Base Sepolia testnet (chainId 84532)
// to `address`, and best-effort drips a little Base Sepolia ETH for gas when the
// faucet key holds a surplus. Because mint() is ungated the faucet key holds no
// USDC — it coins fresh tokens on demand; it only needs Base Sepolia ETH for
// gas. Returns a clear 503 when the leg isn't configured (so the Solana leg
// still works), and honours the same per-address cooldown as that leg.
// ---------------------------------------------------------------------------
app.post('/api/base-sepolia/request', (req, res) => {
  if (!baseSepoliaFaucet) {
    res.status(503).json({
      error: 'Base Sepolia faucet not configured',
      message:
        'Set BASE_SEPOLIA_FAUCET_KEY (an EVM key funded with Base Sepolia ETH for gas) to enable the Base Sepolia route.',
    });
    return;
  }

  const { address } = req.body || {};
  if (!address || !baseSepoliaFaucet.isValidAddress(address)) {
    res.status(400).json({ error: 'Invalid Ethereum address' });
    return;
  }

  // Per-address cooldown: claim BEFORE enqueueing (reserves the slot so
  // concurrent requests for the same address cannot double-drip); released
  // below if the drip fails.
  const claim = baseSepoliaFaucet.claim(address);
  if (!claim.allowed) {
    res
      .status(429)
      .set('Retry-After', String(Math.ceil(claim.retryAfterMs / 1000)))
      .json({
        error: 'Base Sepolia drip rate limit',
        message: 'This address already received a Base Sepolia drip inside the cooldown window.',
        retryAfterMs: claim.retryAfterMs,
      });
    return;
  }

  console.log(`💧 Base Sepolia faucet request for ${address}`);
  baseSepoliaQueue = baseSepoliaQueue
    .then(async () => {
      const result = await baseSepoliaFaucet.drip(address);
      console.log(`  ✅ Base Sepolia faucet request completed for ${address}`);
      res.json({ success: true, chain: 'base-sepolia', address, transactions: result });
    })
    .catch((error) => {
      // A failed drip must not burn the address's cooldown.
      baseSepoliaFaucet.release(address);
      console.error('❌ Base Sepolia faucet request failed:', error);
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Base Sepolia faucet request failed',
          message: error.message,
        });
      }
    });
});

// Start server
app.listen(PORT, async () => {
  console.log('');
  console.log('═══════════════════════════════════════════════');
  console.log('   🚰 Token Faucet');
  console.log('═══════════════════════════════════════════════');
  console.log(`   Port:          ${PORT}`);
  console.log(`   RPC URL:       ${RPC_URL}`);
  console.log(`   ETH per drip:  ${ETH_AMOUNT} ETH`);
  console.log(`   Token per drip: ${TOKEN_AMOUNT} ${tokenSymbol}`);
  console.log(`   Solana:        ${solanaFaucet ? 'enabled' : 'disabled'}`);
  console.log(
    `   Base Sepolia:  ${baseSepoliaFaucet ? `mint ${baseSepoliaFaucet.usdcAmount} USDC (chainId ${baseSepoliaFaucet.chainId}, ungated mint)` : 'disabled (503)'}`
  );
  console.log('═══════════════════════════════════════════════');
  console.log('');

  // Try to initialize token contract. The anvil container deploys the token
  // asynchronously after Anvil's RPC comes up, so the token may not exist yet
  // when the faucet boots. Poll in the background until it appears so
  // `/health` `tokenReady` flips true on its own once the deploy lands — no
  // restart required. See issue #104.
  //
  // Only poll when TOKEN_ADDRESS names a token at all: it is read once, at
  // module load, so an unset address can never become set later and the poll
  // would just log the same "not set" line every 2s forever. The faucet box
  // (infra/linode-faucet/) is exactly that case — it has no anvil chain and
  // sets no TOKEN_ADDRESS.
  const ready = await initTokenContract();
  if (!ready && TOKEN_ADDRESS) {
    const poll = setInterval(async () => {
      if (await initTokenContract()) {
        clearInterval(poll);
      }
    }, 2000);
    // Don't keep the event loop alive solely for this poll.
    if (typeof poll.unref === 'function') poll.unref();
  }

  console.log('✅ Faucet is running!');
  console.log(`   UI: http://localhost:${PORT}`);
  console.log('');
});

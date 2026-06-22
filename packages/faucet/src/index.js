import express from 'express';
import cors from 'cors';
import { ethers, NonceManager } from 'ethers';
import { createSolanaFaucet } from './solana.js';
import { isValidMinaAddress, minaInfo, handleMinaRequest } from './mina.js';

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

// Serialize Solana drips the same way EVM ones are, so concurrent requests
// don't race the treasury's transaction signing / blockhash reuse.
let solanaQueue = Promise.resolve();

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

// Validate Ethereum address
function isValidAddress(address) {
  try {
    return ethers.isAddress(address);
  } catch {
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
    // unreachable, but /api/info must still advertise the Solana/Mina routes.
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
      chains: {
        evm: {
          enabled: true,
          route: '/api/request',
          ready: !!tokenContract,
          drips: { eth: ETH_AMOUNT, token: TOKEN_AMOUNT, tokenSymbol },
          tokenAddress: TOKEN_ADDRESS,
        },
        solana: solanaFaucet
          ? {
              enabled: true,
              route: '/api/solana/request',
              ready: true,
              drips: {
                sol: String(solanaFaucet.solAmount),
                usdc: String(solanaFaucet.usdcAmount),
              },
              usdcMint: solanaFaucet.mint,
              rpcUrl: solanaFaucet.rpcUrl,
            }
          : { enabled: false, route: '/api/solana/request', ready: false },
        mina: {
          enabled: true,
          route: '/api/mina/request',
          ready: true,
          ...minaInfo(),
        },
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
// Request serialization queue
//
// All /api/request calls are processed one at a time.  Each handler appends
// itself to the tail of the promise chain and only begins execution after the
// previous handler has fully resolved (including on-chain tx confirmation).
// This guarantees sequential nonce assignment even when many test workers
// fire concurrent HTTP requests at the faucet.
// ---------------------------------------------------------------------------
let requestQueue = Promise.resolve();

// Core logic extracted so it can be enqueued without capturing `req`/`res`
// inside the chain (avoids accidental closure-over-mutable-variable bugs).
async function handleFaucetRequest(address, res) {
  // Check if token contract is ready
  if (!tokenContract) {
    const initialized = await initTokenContract();
    if (!initialized) {
      res.status(503).json({
        error: 'Token contract not yet deployed',
        message: 'Please wait for contract deployment to complete',
      });
      return;
    }
  }

  console.log(`💧 Faucet request for ${address}`);

  // Send ETH
  const ethTx = await ethWallet.sendTransaction({
    to: address,
    value: ethers.parseEther(ETH_AMOUNT),
  });
  console.log(`  📤 Sending ${ETH_AMOUNT} ETH: ${ethTx.hash}`);

  // Send tokens
  const tokenAmount = ethers.parseUnits(TOKEN_AMOUNT, tokenDecimals);
  const tokenTx = await tokenContract.transfer(address, tokenAmount);
  console.log(`  📤 Sending ${TOKEN_AMOUNT} ${tokenSymbol}: ${tokenTx.hash}`);

  // Wait for confirmations before the next queued request starts
  await ethTx.wait();
  await tokenTx.wait();

  console.log(`  ✅ Faucet request completed for ${address}`);

  res.json({
    success: true,
    transactions: {
      eth: { hash: ethTx.hash, amount: ETH_AMOUNT },
      token: { hash: tokenTx.hash, amount: TOKEN_AMOUNT, symbol: tokenSymbol },
    },
  });
}

// Request tokens
app.post('/api/request', (req, res) => {
  const { address } = req.body;

  // Validate address before enqueuing
  if (!address || !isValidAddress(address)) {
    res.status(400).json({ error: 'Invalid Ethereum address' });
    return;
  }

  // Append to the serialization queue; errors are caught per-entry so a
  // single failure never stalls the queue for subsequent requests.
  requestQueue = requestQueue
    .then(() => handleFaucetRequest(address, res))
    .catch((error) => {
      console.error('❌ Faucet request failed:', error);
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Faucet request failed',
          message: error.message,
        });
      }
    });
});

// ---------------------------------------------------------------------------
// Solana route — POST /api/solana/request { address }
//
// Airdrops SOL + transfers mock USDC from the devnet treasury. Returns a clear
// 503 when Solana isn't configured for this deploy (so EVM-only still works).
// ---------------------------------------------------------------------------
app.post('/api/solana/request', (req, res) => {
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

  console.log(`💧 Solana faucet request for ${address}`);
  solanaQueue = solanaQueue
    .then(async () => {
      const result = await solanaFaucet.drip(address);
      console.log(`  ✅ Solana faucet request completed for ${address}`);
      res.json({ success: true, chain: 'solana', address, transactions: result });
    })
    .catch((error) => {
      console.error('❌ Solana faucet request failed:', error);
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Solana faucet request failed',
          message: error.message,
        });
      }
    });
});

// ---------------------------------------------------------------------------
// Mina route — POST /api/mina/request { address }
//
// The public Mina faucet is ZK-challenge-gated (see src/mina.js), so this
// returns a ready-to-click link to the public faucet rather than auto-dripping.
// ---------------------------------------------------------------------------
app.post('/api/mina/request', (req, res) => {
  const { address } = req.body || {};
  if (!address || !isValidMinaAddress(address)) {
    res.status(400).json({ error: 'Invalid Mina address (expected B62… public key)' });
    return;
  }
  console.log(`💧 Mina faucet request for ${address} (link path)`);
  res.json(handleMinaRequest(address));
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
  console.log(`   Mina:          link (public devnet faucet)`);
  console.log('═══════════════════════════════════════════════');
  console.log('');

  // Try to initialize token contract. The anvil container deploys the token
  // asynchronously after Anvil's RPC comes up, so the token may not exist yet
  // when the faucet boots. Poll in the background until it appears so
  // `/health` `tokenReady` flips true on its own once the deploy lands — no
  // restart required. See issue #104.
  const ready = await initTokenContract();
  if (!ready) {
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

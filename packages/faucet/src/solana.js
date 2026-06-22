// ---------------------------------------------------------------------------
// Solana faucet drip
// ---------------------------------------------------------------------------
// Mirrors infra/solana/fund-solana.sh, but in-process:
//   1. requestAirdrop SOL to the recipient via the validator's faucet RPC.
//   2. Transfer mock USDC from the committed devnet treasury authority
//      (usdc-authority.json) — auto-creating the recipient's associated token
//      account (ATA) if it does not exist yet.
//
// The treasury keypair + USDC mint are the SAME deterministic devnet identities
// seeded by infra/solana/create-usdc-mint.sh, so peers can hardcode them.
//
// Everything here is OPTIONAL: if SOLANA_FAUCET_KEYPAIR / the RPC are not
// configured (e.g. an EVM-only deploy), `createSolanaFaucet` returns null and
// the route answers a clear 503 instead of crashing the whole service.
import fs from 'fs';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, transfer } from '@solana/spl-token';

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'http://solana-validator:8899';
const SOLANA_USDC_MINT = process.env.SOLANA_USDC_MINT || '';
const SOLANA_FAUCET_KEYPAIR = process.env.SOLANA_FAUCET_KEYPAIR || '/keys/usdc-authority.json';
// 6 decimals — real-USDC standard, matches infra/solana/create-usdc-mint.sh.
const SOLANA_USDC_DECIMALS = Number(process.env.SOLANA_USDC_DECIMALS || '6');
const SOLANA_SOL_AMOUNT = Number(process.env.SOLANA_SOL_AMOUNT || '2'); // SOL per drip
const SOLANA_USDC_AMOUNT = Number(process.env.SOLANA_USDC_AMOUNT || '1000'); // USDC per drip

function loadKeypair(path) {
  const raw = fs.readFileSync(path, 'utf8');
  const secret = Uint8Array.from(JSON.parse(raw));
  return Keypair.fromSecretKey(secret);
}

// Returns a faucet object, or null if Solana is not configured for this deploy.
export function createSolanaFaucet() {
  if (!SOLANA_USDC_MINT) {
    console.log('ℹ️  Solana faucet disabled: SOLANA_USDC_MINT not set.');
    return null;
  }
  if (!fs.existsSync(SOLANA_FAUCET_KEYPAIR)) {
    console.log(`ℹ️  Solana faucet disabled: keypair not found at ${SOLANA_FAUCET_KEYPAIR}.`);
    return null;
  }

  let mint;
  let authority;
  try {
    mint = new PublicKey(SOLANA_USDC_MINT);
    authority = loadKeypair(SOLANA_FAUCET_KEYPAIR);
  } catch (error) {
    console.error('❌ Solana faucet config invalid:', error.message);
    return null;
  }

  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

  console.log(`✅ Solana faucet enabled: RPC ${SOLANA_RPC_URL}`);
  console.log(`   USDC mint:   ${mint.toBase58()}`);
  console.log(`   Treasury:    ${authority.publicKey.toBase58()}`);
  console.log(`   Per drip:    ${SOLANA_SOL_AMOUNT} SOL + ${SOLANA_USDC_AMOUNT} USDC`);

  return {
    rpcUrl: SOLANA_RPC_URL,
    mint: mint.toBase58(),
    treasury: authority.publicKey.toBase58(),
    solAmount: SOLANA_SOL_AMOUNT,
    usdcAmount: SOLANA_USDC_AMOUNT,

    isValidAddress(address) {
      try {
        // PublicKey throws on a malformed base58 / wrong-length key.
        // eslint-disable-next-line no-new
        new PublicKey(address);
        return true;
      } catch {
        return false;
      }
    },

    async drip(address) {
      const recipient = new PublicKey(address);

      // 1. Airdrop SOL from the validator faucet.
      const lamports = Math.round(SOLANA_SOL_AMOUNT * LAMPORTS_PER_SOL);
      const airdropSig = await connection.requestAirdrop(recipient, lamports);
      await connection.confirmTransaction(airdropSig, 'confirmed');
      console.log(`  📤 Airdropped ${SOLANA_SOL_AMOUNT} SOL: ${airdropSig}`);

      // 2. Transfer USDC from the treasury, auto-creating the recipient ATA.
      const sourceAta = await getOrCreateAssociatedTokenAccount(
        connection,
        authority, // fee payer
        mint,
        authority.publicKey
      );
      const destAta = await getOrCreateAssociatedTokenAccount(
        connection,
        authority, // fee payer creates the recipient ATA if missing
        mint,
        recipient
      );

      const rawAmount = BigInt(Math.round(SOLANA_USDC_AMOUNT * 10 ** SOLANA_USDC_DECIMALS));
      const usdcSig = await transfer(
        connection,
        authority, // fee payer
        sourceAta.address,
        destAta.address,
        authority, // source token-account owner
        rawAmount
      );
      console.log(`  📤 Transferred ${SOLANA_USDC_AMOUNT} USDC: ${usdcSig}`);

      return {
        sol: { signature: airdropSig, amount: String(SOLANA_SOL_AMOUNT) },
        usdc: {
          signature: usdcSig,
          amount: String(SOLANA_USDC_AMOUNT),
          mint: mint.toBase58(),
          ata: destAta.address.toBase58(),
        },
      };
    },
  };
}

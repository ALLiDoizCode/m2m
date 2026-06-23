/**
 * Produce a Mina balance-proof claim (the signBalanceProof JSON) signed by
 * participantA over [Poseidon(balanceA,balanceB,salt), nonce, channelHash].
 * Matches MinaPaymentChannelSDK.signBalanceProof exactly. Prints JSON to stdout.
 */
import { PrivateKey, Field, Poseidon, Signature } from 'o1js';
const signerPriv = process.env.SIGN_PRIV!;
const balanceA = BigInt(process.env.SIGN_BALANCE_A!);
const balanceB = BigInt(process.env.SIGN_BALANCE_B!);
const salt = BigInt(process.env.SIGN_SALT!);
const nonce = BigInt(process.env.SIGN_NONCE!);
const channelHash = process.env.SIGN_CHANNEL_HASH!;
const commitment = Poseidon.hash([Field(balanceA), Field(balanceB), Field(salt)]);
const pk = PrivateKey.fromBase58(signerPriv);
const sig = Signature.create(pk, [commitment, Field(nonce), Field(channelHash)]);
const j = sig.toJSON();
const out = {
  commitment: commitment.toString(),
  signature: { r: j.r, s: j.s },
  nonce: nonce.toString(),
  signerPublicKey: pk.toPublicKey().toBase58(),
};
process.stdout.write(JSON.stringify(out));

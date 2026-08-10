/**
 * OER (Octet Encoding Rules) PREPARE encoder, just enough of RFC-0027 /
 * RFC-0030 to construct a well-formed ILPv4 PREPARE the Rust edge's
 * `Prepare::decode` (crates/connector-domain/src/packet.rs) accepts.
 *
 * The announcer sidecar never actually sends value anywhere — it only needs
 * an unpaid `POST /ilp` to a priced route to trigger the client edge's x402
 * greeting (client-edge-spec.md §1.4, ADR 0022's "answers when asked"),
 * which carries the settlement/contract facts this sidecar re-announces.
 * `handle_ilp` decides the greeting branch purely from
 * `!has_claim_header && price > 0` — the PREPARE's own `amount` is
 * irrelevant to that branch — so any structurally valid PREPARE addressing
 * the route works.
 *
 * Byte-for-byte port of the three primitives connector-domain's `oer.rs`
 * documents (itself ported from the now-retired TypeScript
 * `packages/shared/src/encoding/oer.ts`), scoped to ENCODE only — this
 * sidecar never decodes an OER packet.
 *
 * @module oer
 */

/** Encode a VarUInt: 0-127 as a single byte, 128+ as a length-prefixed big-endian value. */
export function encodeVarUint(value: number): Buffer {
  if (value < 0 || !Number.isInteger(value)) {
    throw new RangeError(`encodeVarUint: value must be a non-negative integer, got ${value}`);
  }
  if (value <= 127) {
    return Buffer.from([value]);
  }
  const bytes: number[] = [];
  let remaining = value;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** Encode a VarOctetString: a VarUInt length prefix followed by the bytes. */
export function encodeVarOctetString(data: Buffer | Uint8Array): Buffer {
  return Buffer.concat([encodeVarUint(data.length), Buffer.from(data)]);
}

/**
 * Encode a `Date` as ASN.1 GeneralizedTime: `YYYYMMDDHHMMSS.fffZ` (19 bytes),
 * matching `encode_generalized_time` in connector-domain's `oer.rs`.
 */
export function encodeGeneralizedTime(when: Date): Buffer {
  const pad = (n: number, width: number): string => String(n).padStart(width, '0');
  const text =
    `${pad(when.getUTCFullYear(), 4)}${pad(when.getUTCMonth() + 1, 2)}${pad(when.getUTCDate(), 2)}` +
    `${pad(when.getUTCHours(), 2)}${pad(when.getUTCMinutes(), 2)}${pad(when.getUTCSeconds(), 2)}` +
    `.${pad(when.getUTCMilliseconds(), 3)}Z`;
  return Buffer.from(text, 'utf8');
}

/** ILPv4 PREPARE packet type byte (RFC-0027 §3.1). */
export const TYPE_PREPARE = 12;

/** The fields of an ILPv4 PREPARE packet this sidecar needs to build. */
export interface PrepareFields {
  amount: number;
  expiresAt: Date;
  /** Exactly 32 bytes. All-zero is a valid (if never-fulfillable) condition on the wire. */
  executionCondition: Buffer;
  destination: string;
  data?: Buffer;
}

/**
 * Encode a minimal ILPv4 PREPARE packet: just enough to `POST /ilp` and have
 * the Rust edge's `Prepare::decode` accept it and route to the greeting
 * branch. Never sent with a genuine intent to transfer value — see the
 * module doc.
 */
export function encodePrepare(fields: PrepareFields): Buffer {
  if (fields.executionCondition.length !== 32) {
    throw new RangeError(
      `encodePrepare: executionCondition must be exactly 32 bytes, got ${fields.executionCondition.length}`
    );
  }
  return Buffer.concat([
    Buffer.from([TYPE_PREPARE]),
    encodeVarUint(fields.amount),
    encodeGeneralizedTime(fields.expiresAt),
    fields.executionCondition,
    encodeVarOctetString(Buffer.from(fields.destination, 'utf8')),
    encodeVarOctetString(fields.data ?? Buffer.alloc(0)),
  ]);
}

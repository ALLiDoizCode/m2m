#!/usr/bin/env bash
# Sign one operator write (ADR 0008, RFC 9421 + RFC 9530) with nothing but
# bash and openssl, and print the three headers a node's verifier checks.
#
# `connector send` is the only signer this repository ships, and it signs
# exactly one write: `POST /packets`. Every other write -- `POST /peers`
# above all, the flagship of "peer with a stranger's node" -- has no shipped
# tool. This script closes that gap for the scriptable case; PR #1222's
# dashboard closes it for the interactive one.
#
# Usage:
#   sign-write.sh -k KEY_FILE -X METHOD -p PATH [-b BODY] [-e EXPIRES_IN] [-u BASE_URL]
#
#   -k KEY_FILE   The operator write key: 32 raw bytes, or 64 hex characters
#                 (the same file `connector send --operator-key` reads, and
#                 the same bytes `connector send --print-keyid` derives its
#                 answer from). NEVER a value inline -- this repository's
#                 own rule (ADR 0009, ADR 0012) applies just as much to your
#                 own tooling as to the node's.
#   -X METHOD     HTTP method, e.g. POST or DELETE.
#   -p PATH       Request path, e.g. /peers. No query string: the covered
#                 component is `@path`, not `@target-uri`.
#   -b BODY       The request body, as a literal string. Omit for a body-less
#                 write (e.g. DELETE /peers/:id). Defaults to "".
#   -e EXPIRES_IN Seconds from now the signature stays valid. Default 60 --
#                 long enough to paste the curl command by hand, short
#                 enough that a leaked one-shot script output is useless
#                 quickly.
#   -u BASE_URL   If set, send the signed request -- METHOD, BASE_URL+PATH --
#                 with curl and print the response. If unset, only the three
#                 headers are printed, so a caller builds the request itself.
#
# Prints, one per line, always:
#   Signature-Input: sig1=...
#   Signature: sig1=:...:
#   Content-Digest: sha-256=:...:
#
# Worked example -- establish a peering, the README's flagship operator
# write:
#
#   openssl rand -hex 32 > operator-write.key      # keep this OFF the node
#   connector send --operator-key operator-write.key --print-keyid
#   # -> paste that hex string into the TARGET node's [operator] write_keys
#
#   BODY='{"id":"their-node","url":"https://their-node.example","fee":100,"max_packet_amount":1000000}'
#   docs/operators/sign-write.sh -k operator-write.key -X POST -p /peers \
#       -b "$BODY" -u https://your-node.example
#
# Everything below implements exactly what
# `crates/connector-operator/src/rfc9421.rs`'s `verify_write_signature`
# checks -- COVERED_COMPONENTS, SIGNATURE_ALG and the signature-base
# construction are held to that file, not restated from memory.

set -euo pipefail

KEY_FILE=""
METHOD=""
REQ_PATH=""
BODY=""
EXPIRES_IN=60
BASE_URL=""

while getopts "k:X:p:b:e:u:h" opt; do
  case "$opt" in
    k) KEY_FILE="$OPTARG" ;;
    X) METHOD="$OPTARG" ;;
    p) REQ_PATH="$OPTARG" ;;
    b) BODY="$OPTARG" ;;
    e) EXPIRES_IN="$OPTARG" ;;
    u) BASE_URL="$OPTARG" ;;
    h)
      # The whole header comment above, to the blank line that ends it, so
      # -h cannot drift out of step with the file it is read from.
      sed -n '2,/^$/p' "$0"
      exit 0
      ;;
    *)
      echo "usage: $0 -k KEY_FILE -X METHOD -p PATH [-b BODY] [-e EXPIRES_IN] [-u BASE_URL]" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$KEY_FILE" || -z "$METHOD" || -z "$REQ_PATH" ]]; then
  echo "usage: $0 -k KEY_FILE -X METHOD -p PATH [-b BODY] [-e EXPIRES_IN] [-u BASE_URL]" >&2
  exit 2
fi

# ── hex <-> binary, without depending on xxd (not everywhere) ──────────────
hex_to_bin() {
  local hex="$1" fmt="" n=${#1} i
  for ((i = 0; i < n; i += 2)); do
    fmt+="\\x${hex:i:2}"
  done
  printf '%b' "$fmt"
}

bin_to_hex() {
  od -An -tx1 | tr -d ' \n'
}

# ── Read the key file: 32 raw bytes, or 64 hex characters ─────────────────
# Mirrors `connector-cli`'s own `decode_key_bytes` exactly: exactly 32 bytes
# is read as the raw seed; anything else is read as text, trimmed, and must
# be 64 hex characters -- so a key written by `openssl rand -hex 32`, whose
# trailing newline makes the file 65 bytes, still reads.
key_size=$(wc -c <"$KEY_FILE" | tr -d ' ')
if [[ "$key_size" -eq 32 ]]; then
  seed_hex=$(bin_to_hex <"$KEY_FILE")
else
  seed_hex=$(tr -d '[:space:]' <"$KEY_FILE")
  if ! [[ "$seed_hex" =~ ^[0-9a-fA-F]{64}$ ]]; then
    echo "$KEY_FILE must be 32 raw bytes or 64 hex characters, found $key_size bytes" >&2
    exit 1
  fi
  seed_hex=$(echo -n "$seed_hex" | tr 'A-F' 'a-f')
fi

# ── The seed as an openssl-importable PKCS8 ed25519 private key ───────────
# RFC 8032's 32-byte seed IS this format's PrivateKey OCTET STRING; the rest
# is the fixed ASN.1 DER shell every Ed25519 PKCS8 key wears
# (SEQUENCE{version=0, AlgorithmIdentifier{OID 1.3.101.112},
# OCTET STRING{OCTET STRING{seed}}}), so no key-generation tool is needed to
# turn this repository's raw-seed key files into something openssl can sign
# with.
pkcs8_prefix_hex="302e020100300506032b657004220420"
key_dir=$(mktemp -d)
trap 'rm -rf "$key_dir"' EXIT
hex_to_bin "${pkcs8_prefix_hex}${seed_hex}" >"$key_dir/key.der"
openssl pkey -inform DER -in "$key_dir/key.der" -out "$key_dir/key.pem"

# ── keyid: the public key, hex, the same value --print-keyid prints ───────
keyid=$(openssl pkey -in "$key_dir/key.pem" -pubout -outform DER \
  | tail -c 32 | bin_to_hex)

# ── Content-Digest (RFC 9530): sha-256 of the body, base64 ────────────────
digest_b64=$(printf '%s' "$BODY" | openssl dgst -sha256 -binary | openssl base64 -A)
content_digest="sha-256=:${digest_b64}:"

created=$(date +%s)
expires=$((created + EXPIRES_IN))
method_upper=$(echo -n "$METHOD" | tr 'a-z' 'A-Z')

# ── The exact signature-base string build_signature_base constructs ───────
sig_params_value="(\"@method\" \"@path\" \"content-digest\");created=${created};expires=${expires};keyid=\"${keyid}\";alg=\"ed25519\""
signature_base=$(printf '"@method": %s\n"@path": %s\n"content-digest": %s\n"@signature-params": %s' \
  "$method_upper" "$REQ_PATH" "$content_digest" "$sig_params_value")

# `pkeyutl -rawin` needs a seekable input to size the oneshot operation, so
# the base string is written out rather than piped in.
printf '%s' "$signature_base" >"$key_dir/base"
signature_b64=$(openssl pkeyutl -sign -inkey "$key_dir/key.pem" -rawin \
  -in "$key_dir/base" | openssl base64 -A)

signature_input="sig1=${sig_params_value}"
signature_header="sig1=:${signature_b64}:"

echo "Signature-Input: ${signature_input}"
echo "Signature: ${signature_header}"
echo "Content-Digest: ${content_digest}"

if [[ -n "$BASE_URL" ]]; then
  curl -sS -X "$method_upper" "${BASE_URL}${REQ_PATH}" \
    -H "Signature-Input: ${signature_input}" \
    -H "Signature: ${signature_header}" \
    -H "Content-Digest: ${content_digest}" \
    -H "Content-Type: application/json" \
    ${BODY:+-d "$BODY"}
fi

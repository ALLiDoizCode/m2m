#!/usr/bin/env python3
# =============================================================================
# Open a local topology's Solana payment channel -- and prove it is real.
#
#   local/open-solana-channel.py \
#       --rpc-url          http://127.0.0.1:8899 \
#       --operator-url     http://127.0.0.1:3004 \
#       --operator-key     local/.keys/mixed-chain/connector-b/operator-send.key \
#       --program-id       HY4A... \
#       --token-mint       H8HS... \
#       --channel-account  G5mX... \
#       --payer            BCXt... \
#       --payee            93mx... \
#       --settlement-timeout-seconds 3600
#
# Called by `local/keys.sh <topology> solana-channels`, which is where every
# topology fact above comes from. This file holds none of them: it opens the
# one channel it is told about and refuses to report success unless the chain
# agrees.
#
# ── Why this goes through the operator surface ───────────────────────────────
#
# The EVM half of a local peering is opened with `cast send`, because a
# TokenNetwork's `openChannel` is an ordinary contract call and Foundry can
# build one from a signature string. Solana has no equivalent: `InitializeChannel`
# is a positional account list plus an 8-byte discriminator
# (`packages/solana-program/src/instruction.rs`), and the Solana CLI cannot
# build an arbitrary program instruction at all. `spl-token` knows only the SPL
# Token program.
#
# So the only thing in this repository that can submit it is the connector
# itself, through `POST /channels` -- ADR 0008's third write, issue #459 --
# which reaches `SolanaSettlementBackend::open` and signs with the node's own
# `[settlement.solana]` key. That is also the right answer rather than merely
# the available one: the channel's on-chain participant IS that settlement
# identity, so the node that will sign claims on the channel is the node that
# opens it, and no second copy of the key has to exist anywhere.
#
# Opening a channel is therefore the OPERATOR's job here, done after the node
# is serving -- not the connector's at boot. `[[peer_channels]]` is a statement
# about which claims this node will accept, not an instruction to go and create
# something on a chain; ADR 0009's config is read once and creates nothing.
#
# ── What this asserts, and why the assertion is the point ────────────────────
#
# A peer claim's verdict never reads the chain (`ClaimBook` checks the
# signature against the configured `counterparty_key` and nothing else,
# CF-23), so a topology whose Solana channel was never opened rehearses
# exactly as green as one whose channel is real. That is the failure this
# script exists to make impossible: after the write, it reads the channel
# account back off the validator and requires the deployed program's own
# layout to agree with the committed config -- the discriminator, both
# participants, the mint, and `Opened` status. Anything else exits non-zero.
#
# Idempotent: a channel already open at the expected address is left alone and
# still asserted, which is what makes re-running `make local-up` safe.
# =============================================================================

import argparse
import base64
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

# `packages/solana-program/src/state.rs`, mirrored in
# `crates/connector-settlement-solana/src/wire.rs`. Three copies of one layout
# is one too many already, so this file reads only the fields it asserts on and
# names the source of each offset.
DISCRIMINATOR = b"pchannel"  # state.rs:11
ACCOUNT_SIZE = 178  # state.rs:34
PARTICIPANT_A_OFFSET = 8
PARTICIPANT_B_OFFSET = 40
TOKEN_MINT_OFFSET = 72
STATE_OFFSET = 160
STATUS_NAMES = {0: "Opened", 1: "Closed", 2: "Settled"}  # state.rs:57-59

# The RFC 9421 subset the operator surface accepts, and only this subset:
# exactly these covered components, `alg="ed25519"`, a hex ed25519 public key
# as `keyid`, and a REQUIRED `expires`
# (`crates/connector-operator/src/rfc9421.rs`).
COVERED_COMPONENTS = '("@method" "@path" "content-digest")'
SIGNATURE_TTL_SECONDS = 300

BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def base58_encode(raw: bytes) -> str:
    value = int.from_bytes(raw, "big")
    encoded = ""
    while value:
        value, remainder = divmod(value, 58)
        encoded = BASE58_ALPHABET[remainder] + encoded
    leading_zeros = len(raw) - len(raw.lstrip(b"\0"))
    return BASE58_ALPHABET[0] * leading_zeros + encoded


def base58_decode_32(encoded: str) -> bytes:
    value = 0
    for character in encoded:
        if character not in BASE58_ALPHABET:
            die(f"'{encoded}' is not base58 -- a Solana pubkey is 32 base58-encoded bytes")
        value = value * 58 + BASE58_ALPHABET.index(character)
    return value.to_bytes(32, "big")


def die(message: str) -> None:
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(1)


# ── The chain ────────────────────────────────────────────────────────────────


def rpc(url: str, method: str, params: list):
    body = json.dumps(
        {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    ).encode()
    request = urllib.request.Request(
        url, data=body, headers={"content-type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.loads(response.read())
    except (urllib.error.URLError, OSError) as error:
        die(f"{method} against {url} failed: {error}")
    if "error" in payload:
        die(f"{method} against {url} returned {payload['error']}")
    return payload["result"]


def read_channel_account(rpc_url: str, pubkey: str):
    """The account at `pubkey`, or `None` if the validator has never heard of
    it. `(owner, data)` -- nothing is interpreted here."""
    value = rpc(
        rpc_url,
        "getAccountInfo",
        [pubkey, {"encoding": "base64", "commitment": "confirmed"}],
    )["value"]
    if value is None:
        return None
    return value["owner"], base64.b64decode(value["data"][0])


# ── The operator write ───────────────────────────────────────────────────────


def ed25519_key(seed_hex: str, directory: str):
    """A PEM private key and the hex public half, both derived from the same
    32-byte seed by the same tool -- so the `keyid` this write presents cannot
    disagree with the signature it presents.

    openssl rather than a Python crypto library because openssl is already a
    hard dependency of `local/keys.sh` and no Python ed25519 library is: an
    ed25519 private key in PKCS#8 is a fixed 16-byte prefix followed by the raw
    seed, which is the whole of the conversion below."""
    seed = bytes.fromhex(seed_hex)
    if len(seed) != 32:
        die(f"an operator key must be 32 bytes (64 hex characters), got {len(seed)}")
    pkcs8 = bytes.fromhex("302e020100300506032b657004220420") + seed
    pem = os.path.join(directory, "operator.pem")
    subprocess.run(
        ["openssl", "pkey", "-inform", "DER", "-outform", "PEM", "-out", pem],
        input=pkcs8,
        check=True,
        capture_output=True,
    )
    spki = subprocess.run(
        ["openssl", "pkey", "-in", pem, "-pubout", "-outform", "DER"],
        check=True,
        capture_output=True,
    ).stdout
    # The last 32 bytes of an ed25519 SubjectPublicKeyInfo are the key itself.
    return pem, spki[-32:].hex()


def signed_write_headers(pem: str, keyid: str, method: str, path: str, body: bytes):
    digest = "sha-256=:" + base64.b64encode(hashlib.sha256(body).digest()).decode() + ":"
    created = int(time.time())
    expires = created + SIGNATURE_TTL_SECONDS
    params = (
        f"{COVERED_COMPONENTS};created={created};expires={expires}"
        f';keyid="{keyid}";alg="ed25519"'
    )
    signature_base = "\n".join(
        [
            f'"@method": {method.upper()}',
            f'"@path": {path}',
            f'"content-digest": {digest}',
            f'"@signature-params": {params}',
        ]
    )
    with tempfile.NamedTemporaryFile() as message:
        message.write(signature_base.encode())
        message.flush()
        signature = subprocess.run(
            ["openssl", "pkeyutl", "-sign", "-inkey", pem, "-rawin", "-in", message.name],
            check=True,
            capture_output=True,
        ).stdout
    return {
        "content-type": "application/json",
        "content-digest": digest,
        "signature-input": f"sig1={params}",
        "signature": "sig1=:" + base64.b64encode(signature).decode() + ":",
    }


def post_open_channel(operator_url: str, key_file: str, request_body: dict) -> dict:
    path = "/channels"
    body = json.dumps(request_body).encode()
    with open(key_file) as handle:
        seed_hex = handle.read().strip()
    with tempfile.TemporaryDirectory() as directory:
        pem, keyid = ed25519_key(seed_hex, directory)
        headers = signed_write_headers(pem, keyid, "POST", path, body)
    url = operator_url.rstrip("/") + path
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace").strip()
        die(
            f"POST {url} was refused: {error.code} -- {detail}\n"
            f"       A 401 means keyid {keyid} is not on that node's [operator] write_keys "
            f"(local/keys.sh writes the public half into operator-write-keys); a 400 naming "
            f"the settlement backend means the node holds no Solana backend, or the program "
            f"refused the InitializeChannel."
        )
    except (urllib.error.URLError, OSError) as error:
        die(
            f"POST {url} could not be reached: {error}\n"
            f"       That node's [operator] section is what mounts this surface -- an absent "
            f"one means the route is not served at all."
        )


# ── The assertion ────────────────────────────────────────────────────────────


def assert_channel_is_real(rpc_url, channel_account, program_id, token_mint, payer, payee):
    """The committed `channel_account` holds a live payment-channel account for
    exactly these two participants and this mint. Anything short of that is a
    non-zero exit, never a warning: a topology that silently degrades to `no
    channel` still rehearses green, because nothing on the peer path reads a
    chain."""
    account = read_channel_account(rpc_url, channel_account)
    if account is None:
        die(
            f"{channel_account} does not exist on {rpc_url}.\n"
            f"       The Solana peering's channel was not opened."
        )
    owner, data = account
    if owner != program_id:
        die(
            f"{channel_account} exists but is owned by {owner}, not the payment-channel "
            f"program {program_id}."
        )
    if len(data) < ACCOUNT_SIZE:
        die(
            f"{channel_account} holds {len(data)} bytes, not the {ACCOUNT_SIZE} a "
            f"payment-channel account is (packages/solana-program/src/state.rs)."
        )
    if data[0:8] != DISCRIMINATOR:
        die(
            f"{channel_account} does not begin with the {DISCRIMINATOR!r} discriminator -- "
            f"it is some other account of this program's."
        )

    participants = {
        base58_encode(data[PARTICIPANT_A_OFFSET : PARTICIPANT_A_OFFSET + 32]),
        base58_encode(data[PARTICIPANT_B_OFFSET : PARTICIPANT_B_OFFSET + 32]),
    }
    if participants != {payer, payee}:
        die(
            f"{channel_account}'s participants are {sorted(participants)}, but the committed "
            f"configs name {sorted([payer, payee])}."
        )

    mint = base58_encode(data[TOKEN_MINT_OFFSET : TOKEN_MINT_OFFSET + 32])
    if mint != token_mint:
        die(
            f"{channel_account} settles in mint {mint}, but the committed "
            f"[settlement.solana] token_address is {token_mint}."
        )

    status = data[STATE_OFFSET]
    if status != 0:
        die(
            f"{channel_account} is {STATUS_NAMES.get(status, status)}, not Opened. A claim "
            f"written against it is not redeemable."
        )
    return participants, mint


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rpc-url", required=True)
    parser.add_argument("--operator-url", required=True)
    parser.add_argument("--operator-key", required=True)
    parser.add_argument("--program-id", required=True)
    parser.add_argument("--token-mint", required=True)
    parser.add_argument("--channel-account", required=True)
    parser.add_argument("--payer", required=True, help="the opening node's Solana settlement key")
    parser.add_argument("--payee", required=True, help="the counterparty's Solana settlement key")
    parser.add_argument("--settlement-timeout-seconds", type=int, default=3600)
    arguments = parser.parse_args()

    existing = read_channel_account(arguments.rpc_url, arguments.channel_account)
    if existing is None:
        view = post_open_channel(
            arguments.operator_url,
            arguments.operator_key,
            {
                # The port takes opaque bytes; a Solana counterparty is its
                # 32-byte pubkey, hex-encoded
                # (`crates/connector-operator/src/lib.rs`'s OpenChannelRequest).
                "counterparty_hex": base58_decode_32(arguments.payee).hex(),
                "settlement_timeout_seconds": arguments.settlement_timeout_seconds,
                "chain": "solana",
            },
        )
        # The node reports the id its own backend derived. It must be the
        # address both committed configs name: a mismatch means the PDA is a
        # function of something this topology got wrong (the mint, the program,
        # or which two keys the participants are), and every claim written
        # against the committed address would name an account nobody opened.
        if view.get("id") != arguments.channel_account:
            die(
                f"the node opened a channel at {view.get('id')}, not at the "
                f"{arguments.channel_account} both committed configs name."
            )
        print(f"opened {arguments.channel_account} via {arguments.operator_url}/channels")
    else:
        print(f"{arguments.channel_account} is already open on {arguments.rpc_url}")

    assert_channel_is_real(
        arguments.rpc_url,
        arguments.channel_account,
        arguments.program_id,
        arguments.token_mint,
        arguments.payer,
        arguments.payee,
    )
    print(
        f"  live on chain: owner {arguments.program_id}, participants "
        f"{arguments.payer} / {arguments.payee}, mint {arguments.token_mint}, status Opened"
    )


if __name__ == "__main__":
    main()

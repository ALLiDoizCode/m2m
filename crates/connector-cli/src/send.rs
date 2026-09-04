//! `connector send` -- originate a packet through a node's operator surface.
//!
//! The connector could already originate a packet: `POST /packets` on the
//! operator router "originates a packet outward, exactly as the client edge
//! does for an external caller" (ADR 0008). What it could not do was *form*
//! one. The body of that request is an OER-encoded `Prepare` whose payload is
//! gift-wrapped to the terminating connector's identity (ADR 0018), and the
//! request itself carries an RFC 9421 signature from a key on the node's
//! `[operator] write_keys` allowlist. Assembling all of that by hand is why
//! nobody drove a node this way.
//!
//! The `Prepare` carries no execution condition (issue #1269 / ADR 0069):
//! this is where the sender's own end-to-end check lives instead. [`send`]
//! compares the returned FULFILL's fulfilment against
//! `derive_fulfillment(&shared_secret)` -- the same derivation the
//! terminating connector uses (ADR 0019) -- and reports
//! [`Outcome::FulfilledWithWrongFulfillment`] rather than trusting a hop's
//! word that the packet was genuinely delivered.
//!
//! This is the missing half, and it is deliberately the *same* half a test
//! would have written privately: one implementation, in the shipped binary,
//! so what the local topologies exercise is what an operator can run.
//!
//! # What this is not
//!
//! Not a client SDK. ADR 0012 puts end-user key handling, recovery and wallet
//! concerns in `toon-client`, and none of that is here: this holds no channel,
//! signs no claim, and has no identity of its own beyond the operator key it
//! is handed. It is an operator tool that drives an operator endpoint with an
//! operator key -- the same category as `connector announce`.
//!
//! # Why `--seal-to` is separate from `--operator`
//!
//! A payload is sealed to the connector that will *terminate* it, which in a
//! multi-hop topology is not the node the packet is handed to. ADR 0050
//! publishes that node's identity on its own URL, but a client still has no
//! way to *discover* which URL that is from the destination address alone
//! (that half is ADR 0054's, not built) -- so the caller names it directly.
//!
//! `--seal-to` takes that URL as ADR 0050 defines it: the one whose `GET`
//! answers the self-description, e.g. `http://host:3000/ilp` -- the same
//! spelling `POST /peers` takes for a peer's URL, never an origin.

use std::path::Path;

use chrono::{Duration, Utc};
use connector_domain::{EnvelopeRequest, EnvelopeResponse, Fulfill, Prepare, Reject};
use connector_operator::signing::{keyid_hex, sign_request};
use connector_signer::giftwrap::{derive_fulfillment, open_response, seal_request};
use connector_signer::PublicKeyBytes;

/// The path the operator router mounts packet origination at.
const PACKETS_PATH: &str = "/packets";

/// How long a signed operator write stays valid. Short on purpose: the
/// signature is replay-rejected by the node anyway, and a long window is a
/// larger thing to leak.
const SIGNATURE_TTL_SECONDS: u64 = 60;

/// Everything `connector send` needs, after argument parsing and before
/// anything has been read from disk or the network.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendOptions {
    /// Base URL of the node whose operator surface originates the packet.
    pub operator_url: String,
    /// File holding the ed25519 secret key whose public half is on that
    /// node's `[operator] write_keys`. 32 raw bytes or 64 hex characters,
    /// matching every other key file this binary reads (ADR 0012 -- a
    /// location, never an inline value).
    pub operator_key_file: String,
    /// The ILP address the packet is bound for.
    pub destination: String,
    /// The packet's amount. Each hop it crosses takes that peering's flat
    /// fee out of it (ADR 0010), so this must cover the terminating side's
    /// price plus every fee on the way; the packet declares no floor of its
    /// own (ADR 0057).
    pub amount: u64,
    /// The connector that will TERMINATE this packet, as its self-description
    /// URL (ADR 0050) -- the one whose `GET` answers with the identity the
    /// payload is sealed to, e.g. `http://host:3000/ilp`. See the module
    /// header.
    pub seal_to: String,
    /// The envelope's request target, as the terminating app will see it.
    pub target: String,
    /// The envelope's request method.
    pub method: String,
    /// The envelope's request body.
    pub body: Vec<u8>,
    /// How long the PREPARE is valid for.
    pub expires_in_seconds: i64,
    /// Form and sign everything, print it, and send nothing.
    pub dry_run: bool,
    /// Treat anything other than a correctly-fulfilled packet as a failure,
    /// exiting non-zero.
    ///
    /// Without this a REJECT is reported and the process exits 0, which is
    /// right for an operator probing what a route does. It is wrong for a
    /// gate: `local/`'s topologies assert that a paid packet is *delivered*,
    /// and a run that prints "REJECT F02" and exits 0 is the same
    /// green-tick-over-nothing failure ADR 0007 bans a chain-less test for.
    pub expect_fulfill: bool,
}

/// What came back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// A FULFILL whose fulfilment matched the one this sender's own wrap
    /// derives -- so the packet genuinely reached a connector holding the
    /// shared secret, not merely *a* connector willing to answer.
    Fulfilled {
        /// The sealed answer, opened.
        status: u16,
        body: Vec<u8>,
    },
    /// A FULFILL whose fulfilment did NOT match. Reported rather than
    /// panicked on: it is a real wire condition and the operator needs to
    /// see it named, not as a decode failure further down.
    FulfilledWithWrongFulfillment,
    /// A REJECT.
    Rejected { code: String, message: String },
    /// `--dry-run`: nothing was sent.
    NotSent,
}

/// The result of a [`send`], in the shape the one summary line is built from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendOutcome {
    pub destination: String,
    pub amount: u64,
    /// The `keyid` the request was signed under -- the exact value that has
    /// to appear in the target node's `[operator] write_keys`. Printed
    /// because "403 from the operator surface" and "this key is not
    /// allowlisted" are the same event, and only one of them is actionable.
    pub keyid: String,
    pub outcome: Outcome,
}

#[derive(Debug)]
pub enum SendError {
    /// The operator key file is missing, unreadable, or not a 32-byte key.
    KeyFile { path: String, reason: String },
    /// The terminating connector's identity could not be read.
    Identity { url: String, reason: String },
    /// The payload could not be sealed to that identity.
    Seal(String),
    /// The operator surface could not be reached, or answered non-2xx.
    Transport { url: String, reason: String },
    /// The answer decoded as neither FULFILL nor REJECT.
    Undecodable(String),
    /// `--expect-fulfill` was set and the packet was not fulfilled.
    NotFulfilled(String),
}

impl std::fmt::Display for SendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SendError::KeyFile { path, reason } => write!(
                f,
                "operator key file '{path}': {reason}. It must hold 32 raw bytes or 64 hex \
                 characters -- the same shape as every other key file this binary reads. Its \
                 PUBLIC half must be listed in the target node's [operator] write_keys."
            ),
            SendError::Identity { url, reason } => write!(
                f,
                "could not read the terminating connector's identity from {url}: {reason}. A \
                 payload is sealed to the connector that terminates it (ADR 0018), so --seal-to \
                 must name that node's self-description URL -- the one whose GET answers with \
                 its identity, e.g. http://host:3000/ilp (ADR 0050) -- not necessarily the node \
                 given to --operator."
            ),
            SendError::Seal(reason) => write!(f, "could not seal the payload: {reason}"),
            SendError::Transport { url, reason } => {
                write!(f, "POST {url}: {reason}")
            }
            SendError::Undecodable(reason) => write!(
                f,
                "the operator surface answered with neither a FULFILL nor a REJECT: {reason}"
            ),
            SendError::NotFulfilled(detail) => write!(
                f,
                "--expect-fulfill was set and the packet was not fulfilled: {detail}"
            ),
        }
    }
}

impl std::error::Error for SendError {}

/// Read a 32-byte secret key from `path`, accepting either 32 raw bytes or
/// 64 hex characters. Mirrors `connector_config`'s own key-file reading so an
/// operator does not have to remember two conventions.
fn read_key_file(path: &str) -> Result<ed25519_dalek::Keypair, SendError> {
    let raw = std::fs::read(Path::new(path)).map_err(|error| SendError::KeyFile {
        path: path.to_string(),
        reason: error.to_string(),
    })?;
    let bytes = decode_key_bytes(&raw).ok_or_else(|| SendError::KeyFile {
        path: path.to_string(),
        reason: format!(
            "expected 32 raw bytes or 64 hex characters, found {}",
            raw.len()
        ),
    })?;
    let secret =
        ed25519_dalek::SecretKey::from_bytes(&bytes).map_err(|error| SendError::KeyFile {
            path: path.to_string(),
            reason: error.to_string(),
        })?;
    let public = ed25519_dalek::PublicKey::from(&secret);
    Ok(ed25519_dalek::Keypair { secret, public })
}

/// 32 raw bytes, or 64 hex characters possibly followed by whitespace a
/// `>` redirect or an editor left behind.
fn decode_key_bytes(raw: &[u8]) -> Option<[u8; 32]> {
    if raw.len() == 32 {
        return raw.try_into().ok();
    }
    let text = std::str::from_utf8(raw).ok()?.trim();
    if text.len() != 64 || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0u8; 32];
    for (index, slot) in out.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&text[index * 2..index * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// The terminating connector's own identity, read from the running node the
/// way a real sender learns it -- never reconstructed from a key file, so
/// what gets sealed is genuinely what that process holds.
///
/// `connector_url` is that node's self-description URL (ADR 0050), e.g.
/// `http://host:3000/ilp` -- never an origin. The identity-only endpoint is
/// `/identity` beneath it, so the request made is
/// `http://host:3000/ilp/identity`.
async fn fetch_identity(connector_url: &str) -> Result<PublicKeyBytes, SendError> {
    let url = format!("{}/identity", connector_url.trim_end_matches('/'));
    let fail = |reason: String| SendError::Identity {
        url: url.clone(),
        reason,
    };
    let body: serde_json::Value = reqwest::get(&url)
        .await
        .map_err(|error| fail(error.to_string()))?
        .json()
        .await
        .map_err(|error| fail(error.to_string()))?;
    let hex = body["publicKey"]
        .as_str()
        .ok_or_else(|| fail("no `publicKey` in the answer".to_string()))?;
    let bytes = decode_hex(hex).ok_or_else(|| fail(format!("`publicKey` is not hex: {hex}")))?;
    bytes.as_slice().try_into().map_err(|_| {
        fail(format!(
            "expected a 65-byte public key, found {}",
            bytes.len()
        ))
    })
}

fn decode_hex(text: &str) -> Option<Vec<u8>> {
    let text = text.strip_prefix("0x").unwrap_or(text);
    if !text.len().is_multiple_of(2) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&text[index..index + 2], 16).ok())
        .collect()
}

/// The `keyid` a key file signs under -- the exact 64-hex value that has to
/// be on a node's `[operator] write_keys` for a write signed by it to be
/// accepted.
///
/// Deriving an ed25519 public key from a secret is not something a shell can
/// reasonably do, and "what do I put in write_keys for this key file?" is the
/// first question anyone provisioning an operator surface has. Answering it
/// from the binary that will do the signing means the answer cannot disagree
/// with the signature.
pub fn print_keyid(key_file: &str) -> Result<String, SendError> {
    Ok(keyid_hex(&read_key_file(key_file)?))
}

/// Form the packet, sign the write, and hand it to the operator surface.
pub async fn send(options: &SendOptions) -> Result<SendOutcome, SendError> {
    let keypair = read_key_file(&options.operator_key_file)?;
    let keyid = keyid_hex(&keypair);
    let identity = fetch_identity(&options.seal_to).await?;

    let plaintext = EnvelopeRequest {
        method: options.method.clone(),
        target: options.target.clone(),
        headers: vec![("content-type".to_string(), "application/json".to_string())],
        body: options.body.clone(),
    }
    .encode();
    let (data, shared_secret) =
        seal_request(&plaintext, &identity).map_err(|error| SendError::Seal(error.to_string()))?;

    let prepare = Prepare {
        amount: options.amount,
        expires_at: Utc::now() + Duration::seconds(options.expires_in_seconds),
        greeting: false,
        destination: options.destination.clone(),
        data,
    };
    let body = prepare.encode();

    if options.dry_run {
        return Ok(SendOutcome {
            destination: options.destination.clone(),
            amount: options.amount,
            keyid,
            outcome: Outcome::NotSent,
        });
    }

    let base = options.operator_url.trim_end_matches('/');
    let url = format!("{base}{PACKETS_PATH}");
    let created = Utc::now().timestamp().max(0) as u64;
    let (signature_input, signature, content_digest) = sign_request(
        &keypair,
        "POST",
        PACKETS_PATH,
        &body,
        created,
        Some(created + SIGNATURE_TTL_SECONDS),
    );

    let response = reqwest::Client::new()
        .post(&url)
        .header("content-type", "application/octet-stream")
        .header("content-digest", content_digest)
        .header("signature-input", signature_input)
        .header("signature", signature)
        .body(body)
        .send()
        .await
        .map_err(|error| SendError::Transport {
            url: url.clone(),
            reason: error.to_string(),
        })?;

    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| SendError::Transport {
            url: url.clone(),
            reason: error.to_string(),
        })?;

    // A non-2xx here is the operator surface refusing the WRITE -- an
    // unallowlisted key, a stale signature, a replayed one -- and never a
    // packet-level answer. Naming the keyid is the whole point: 401/403 from
    // this endpoint is almost always "that key is not in write_keys".
    if !status.is_success() {
        return Err(SendError::Transport {
            url,
            reason: format!(
                "{status} -- {}. The write was refused before any packet was formed; check that \
                 keyid {keyid} is on the target node's [operator] write_keys.",
                String::from_utf8_lossy(&bytes).trim()
            ),
        });
    }

    let outcome = match Fulfill::decode(&bytes) {
        Ok(fulfill) => {
            if fulfill.fulfillment != derive_fulfillment(&shared_secret) {
                Outcome::FulfilledWithWrongFulfillment
            } else {
                let opened = open_response(&shared_secret, &fulfill.data)
                    .map_err(|error| SendError::Undecodable(error.to_string()))?;
                let envelope = EnvelopeResponse::decode(&opened)
                    .map_err(|error| SendError::Undecodable(error.to_string()))?;
                Outcome::Fulfilled {
                    status: envelope.status,
                    body: envelope.body,
                }
            }
        }
        Err(fulfill_error) => match Reject::decode(&bytes) {
            Ok(reject) => Outcome::Rejected {
                code: reject.code.as_str().to_string(),
                message: reject.message,
            },
            Err(reject_error) => {
                return Err(SendError::Undecodable(format!(
                    "not a FULFILL ({fulfill_error}) and not a REJECT ({reject_error})"
                )))
            }
        },
    };

    if options.expect_fulfill && !matches!(outcome, Outcome::Fulfilled { .. }) {
        return Err(SendError::NotFulfilled(match &outcome {
            Outcome::Rejected { code, message } => format!("REJECT {code} -- {message}"),
            Outcome::FulfilledWithWrongFulfillment => {
                "the fulfilment did not match the one this sender's own gift wrap derives, so \
                 whatever answered was not the node --seal-to names"
                    .to_string()
            }
            Outcome::NotSent => "--dry-run sends nothing, so nothing can be fulfilled".to_string(),
            Outcome::Fulfilled { .. } => unreachable!("guarded by the matches! above"),
        }));
    }

    Ok(SendOutcome {
        destination: options.destination.clone(),
        amount: options.amount,
        keyid,
        outcome,
    })
}

#[cfg(test)]
mod tests {
    use axum::routing::get;
    use axum::{Json, Router};

    use super::*;

    /// A real socket answering `GET /ilp/identity` the way a node's client
    /// edge does -- `fetch_identity` should ask this exact path when handed
    /// this node's self-description URL, `http://{addr}/ilp`.
    fn serve_identity(public_key_hex: String) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let addr = listener.local_addr().expect("local addr");
        let app = Router::new().route(
            "/ilp/identity",
            get(move || {
                let public_key_hex = public_key_hex.clone();
                async move {
                    Json(serde_json::json!({
                        "keyId": "test-key",
                        "publicKey": public_key_hex,
                    }))
                }
            }),
        );
        tokio::spawn(async move {
            let _ = axum::Server::from_tcp(listener)
                .expect("serve the bound listener")
                .serve(app.into_make_service())
                .await;
        });
        format!("http://{addr}/ilp")
    }

    /// `--seal-to` names a connector's self-description URL (ADR 0050),
    /// e.g. `http://host:3000/ilp` -- never an origin. `fetch_identity`
    /// must compose `/identity` beneath exactly that URL, landing on the
    /// same `/ilp/identity` route the client edge has always served.
    #[tokio::test]
    async fn fetch_identity_composes_identity_beneath_the_self_description_url() {
        let public_key_hex = "0x04".to_owned() + &"cd".repeat(64);
        let connector_url = serve_identity(public_key_hex.clone());

        let identity = fetch_identity(&connector_url)
            .await
            .expect("the served /ilp/identity must be readable from the /ilp URL");

        let expected = decode_hex(&public_key_hex).expect("test fixture is valid hex");
        assert_eq!(identity.as_slice(), expected.as_slice());
    }

    /// A trailing slash on the self-description URL must not produce
    /// `//identity` -- `fetch_identity` trims it before composing.
    #[tokio::test]
    async fn fetch_identity_tolerates_a_trailing_slash() {
        let public_key_hex = "0x04".to_owned() + &"ab".repeat(64);
        let connector_url = serve_identity(public_key_hex.clone());
        let with_slash = format!("{connector_url}/");

        let identity = fetch_identity(&with_slash)
            .await
            .expect("a trailing slash on --seal-to must still resolve");

        let expected = decode_hex(&public_key_hex).expect("test fixture is valid hex");
        assert_eq!(identity.as_slice(), expected.as_slice());
    }

    /// The error names the URL actually requested -- the composed
    /// `.../identity`, not merely the `--seal-to` value handed in -- so an
    /// operator can tell what was asked rather than guess at it.
    #[tokio::test]
    async fn identity_fetch_error_names_the_url_actually_requested() {
        // Nothing is listening on this loopback port, so the request fails
        // at connect and the error carries the URL fetch_identity composed.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let addr = listener.local_addr().expect("local addr");
        drop(listener);
        let connector_url = format!("http://{addr}/ilp");

        let error = fetch_identity(&connector_url)
            .await
            .expect_err("nothing is listening on this port");

        let SendError::Identity { ref url, .. } = error else {
            panic!("expected SendError::Identity, got {error:?}");
        };
        assert_eq!(
            url,
            &format!("{connector_url}/identity"),
            "the error must name the exact URL fetch_identity requested"
        );
        assert!(
            error.to_string().contains(url.as_str()),
            "the rendered message must include the URL actually requested: {error}"
        );
    }
}

//! Builds the live [`Connector`] and its signer from a validated [`Config`],
//! and merges the client-edge and operator routers into the one
//! [`axum::Router`] the binary serves. Per ADR 0001 this is where every
//! construction decision lives -- `connector-bin` calls exactly
//! [`build`] and [`router`] and branches on neither.

use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;

use axum::Router;

use connector_config::{Config, SecretLocation};
use connector_runtime::{Connector, HttpAppClient, NetworkPeerTransport, PeerRoute, SystemClock};
use connector_signer::{LocalSigner, Signer, SignerError};

/// Everything that can stop a validated [`Config`] from producing a live
/// [`Connector`]. Distinct from [`connector_config::ConfigError`]: the
/// config file itself was already valid TOML with well-formed fields --
/// these errors are about the world the config points at (a key file that
/// cannot be read, or a location this binary cannot yet resolve).
#[derive(Debug)]
pub enum RuntimeError {
    /// The signer's key file exists (config load already checked that) but
    /// could not be read.
    SignerKeyFileUnreadable {
        path: PathBuf,
        source: std::io::Error,
    },
    /// The signer's key file's contents are neither 32 raw bytes nor 64
    /// hex characters encoding 32 bytes.
    InvalidSignerKeyMaterial { path: PathBuf },
    /// `signer.kms_key_id` was configured, but no key management service
    /// backend is wired into this binary -- `connector-signer::KmsSigner`
    /// is a port over one, and `InMemoryKmsBackend` upholds its contract
    /// for tests, but no production backend exists in this workspace yet.
    /// Use `signer.key_file` instead.
    UnsupportedSignerLocation,
    /// The signer implementation itself rejected the key material (e.g.
    /// an all-zero secret key).
    Signer(SignerError),
}

impl fmt::Display for RuntimeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            RuntimeError::SignerKeyFileUnreadable { path, source } => write!(
                f,
                "failed to read signer key_file at {}: {source}",
                path.display()
            ),
            RuntimeError::InvalidSignerKeyMaterial { path } => write!(
                f,
                "signer key_file at {} must contain either 32 raw bytes or \
                 64 hex characters encoding a 32-byte secret key",
                path.display()
            ),
            RuntimeError::UnsupportedSignerLocation => write!(
                f,
                "signer.kms_key_id is configured, but no key management \
                 service backend is wired into this binary yet -- use \
                 signer.key_file"
            ),
            RuntimeError::Signer(source) => write!(f, "{source}"),
        }
    }
}

impl std::error::Error for RuntimeError {}

impl From<SignerError> for RuntimeError {
    fn from(source: SignerError) -> Self {
        RuntimeError::Signer(source)
    }
}

/// Decode a signer key file's raw bytes into a 32-byte secret key: either
/// exactly 32 raw bytes, or 64 hex characters (surrounding whitespace
/// ignored) encoding 32 bytes. Both are legitimate ways to hand-author or
/// generate a key file, so both are accepted.
fn decode_secret_key(bytes: &[u8]) -> Option<[u8; 32]> {
    if let Ok(text) = std::str::from_utf8(bytes) {
        let trimmed = text.trim();
        if trimmed.len() == 64 && trimmed.bytes().all(|b| b.is_ascii_hexdigit()) {
            let mut out = [0u8; 32];
            for (i, byte) in out.iter_mut().enumerate() {
                *byte = u8::from_str_radix(&trimmed[i * 2..i * 2 + 2], 16).ok()?;
            }
            return Some(out);
        }
    }
    if bytes.len() == 32 {
        let mut out = [0u8; 32];
        out.copy_from_slice(bytes);
        return Some(out);
    }
    None
}

fn build_signer(location: &SecretLocation) -> Result<Arc<dyn Signer>, RuntimeError> {
    match location {
        SecretLocation::File(path) => {
            let bytes =
                std::fs::read(path).map_err(|source| RuntimeError::SignerKeyFileUnreadable {
                    path: path.clone(),
                    source,
                })?;
            let secret = decode_secret_key(&bytes)
                .ok_or_else(|| RuntimeError::InvalidSignerKeyMaterial { path: path.clone() })?;
            let signer = LocalSigner::from_secret_bytes("connector-signer", secret)?;
            Ok(Arc::new(signer))
        }
        SecretLocation::Kms { .. } => Err(RuntimeError::UnsupportedSignerLocation),
    }
}

/// Construct the live [`Connector`] and [`Signer`] a validated [`Config`]
/// describes. Every configured `[[peers]]` entry is dialed lazily through a
/// [`NetworkPeerTransport`] (issue #488 -- peer addressing finally has a
/// config-file representation, closing the gap #416 deferred), and every
/// `peer_id`-targeted `[[routes]]` entry becomes a [`PeerRoute`] alongside
/// the terminated [`connector_config::StaticRoute`]s.
pub fn build(config: &Config) -> Result<(Arc<Connector>, Arc<dyn Signer>), RuntimeError> {
    let signer = build_signer(config.signer_key())?;
    let mut peer_transport = NetworkPeerTransport::new();
    for peer in config.peers() {
        peer_transport.add_peer(peer.id().to_string(), peer.addr());
    }
    let peer_routes = config
        .peer_routes()
        .iter()
        .map(|route| PeerRoute::new(route.prefix(), route.peer_id(), route.fee()))
        .collect();
    let connector = Arc::new(Connector::new(
        config.routes().to_vec(),
        peer_routes,
        Arc::new(HttpAppClient::new()),
        Arc::new(peer_transport),
        Arc::new(SystemClock),
    ));
    Ok((connector, signer))
}

/// Merge the client edge and (if `[operator]` is configured) the operator
/// surface into the one router the binary serves. The operator router is
/// mounted only when [`Config::operator`] is `Some` -- absence means the
/// surface is not started at all, exactly as it means for
/// [`connector_operator::router`] itself.
pub fn router(connector: Arc<Connector>, signer: Arc<dyn Signer>, config: &Config) -> Router {
    let app = connector_client_edge::router(connector.clone());
    match config.operator() {
        Some(operator) => app.merge(connector_operator::router(
            connector,
            signer,
            operator.bearer_token().to_string(),
            operator.write_keys().to_vec(),
        )),
        None => app,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use std::io::Write;
    use tower::ServiceExt;

    fn load_config(text: &str) -> Config {
        let mut config_file = tempfile::NamedTempFile::new().expect("temp config file");
        write!(config_file, "{text}").expect("write config file");
        Config::load(config_file.path()).expect("load config")
    }

    /// Returns the loaded [`Config`] together with the [`tempfile::TempPath`]
    /// its `signer.key_file` points at -- the caller must keep the returned
    /// path alive (a binding, not `_`) for as long as anything still needs
    /// to read the key file, since [`build`] re-reads it rather than
    /// caching its bytes at config-load time.
    fn config_with_raw_key_file(
        body: impl FnOnce(&std::path::Path) -> String,
    ) -> (Config, tempfile::TempPath) {
        let mut key_file = tempfile::NamedTempFile::new().expect("temp key file");
        key_file
            .write_all(&[7u8; 32])
            .expect("write raw 32-byte key");
        let key_path = key_file.into_temp_path();
        let config = load_config(&body(&key_path));
        (config, key_path)
    }

    #[test]
    fn builds_a_connector_from_a_raw_32_byte_key_file() {
        let (config, _key_path) = config_with_raw_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{}"
"#,
                key_path.display()
            )
        });

        let (connector, _signer) = build(&config).expect("build");
        assert!(connector.routes().is_empty());
    }

    #[test]
    fn builds_a_signer_from_a_hex_encoded_key_file() {
        let mut key_file = tempfile::NamedTempFile::new().expect("temp key file");
        key_file
            .write_all(b"0707070707070707070707070707070707070707070707070707070707070707")
            .expect("write hex key");
        let config = load_config(&format!(
            r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{}"
"#,
            key_file.path().display()
        ));

        let result = build(&config);
        assert!(result.is_ok());
    }

    #[test]
    fn rejects_key_material_that_is_neither_32_bytes_nor_64_hex_chars() {
        let mut key_file = tempfile::NamedTempFile::new().expect("temp key file");
        key_file
            .write_all(b"not real key material")
            .expect("write bad key");
        let config = load_config(&format!(
            r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{}"
"#,
            key_file.path().display()
        ));

        let result = build(&config);
        assert!(matches!(
            result,
            Err(RuntimeError::InvalidSignerKeyMaterial { .. })
        ));
    }

    #[test]
    fn a_kms_location_is_an_explicit_unsupported_error_not_a_panic() {
        let config = load_config(
            r#"
client_edge_addr = "127.0.0.1:0"

[signer]
kms_key_id = "arn:aws:kms:us-east-1:123:key/abc"
"#,
        );

        let result = build(&config);
        assert!(matches!(
            result,
            Err(RuntimeError::UnsupportedSignerLocation)
        ));
    }

    #[tokio::test]
    async fn router_mounts_only_the_client_edge_when_no_operator_section_is_configured() {
        let (config, _key_path) = config_with_raw_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{}"
"#,
                key_path.display()
            )
        });
        let (connector, signer) = build(&config).expect("build");
        let app = router(connector, signer, &config);

        // No `[operator]` section: `/routes` (an operator-surface path)
        // 404s -- it was never merged in, rather than merged in and
        // rejecting for lack of a bearer token.
        let request = Request::builder()
            .uri("/routes")
            .body(Body::empty())
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn router_mounts_the_operator_surface_when_configured() {
        let key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let (config, _key_path) = config_with_raw_key_file(|key_path| {
            format!(
                r#"
client_edge_addr = "127.0.0.1:0"

[signer]
key_file = "{}"

[operator]
bearer_token = "operator-secret"
write_keys = ["{key}"]
"#,
                key_path.display()
            )
        });
        let (connector, signer) = build(&config).expect("build");
        let app = router(connector, signer, &config);

        // The operator surface is mounted: `/routes` is a real path now,
        // rejecting for lack of a bearer token rather than 404ing.
        let request = Request::builder()
            .uri("/routes")
            .body(Body::empty())
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
}

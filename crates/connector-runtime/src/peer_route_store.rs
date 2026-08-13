//! Durable storage for issue #884's runtime-mutable peer/route table:
//! peer rows and peer-forwarding route rows added, updated or removed at
//! runtime over the operator surface (`Connector::upsert_runtime_peer`,
//! `Connector::upsert_runtime_peer_route` and their `remove_*` twins),
//! surviving a restart -- unlike a leased route (issue #427, ADR 0006),
//! which is deliberately memory-only and lapses on a TTL instead of being
//! written down.
//!
//! A whole-table JSON snapshot, not an append-only log like
//! [`crate::Journal`] or `OutboundClientLedger`: this table supports
//! removal, which an append-only log cannot express without a compaction
//! pass it has no use for anywhere else. Every write here is on the rare,
//! operator-initiated path (ADR 0015's cold-path exception, not the
//! per-packet one), so the O(n) whole-table rewrite this costs is paid by
//! nothing that runs per packet.
//!
//! Every write goes to a temp file beside `path` and is renamed over it --
//! `rename` is atomic on the same filesystem on every platform this node
//! ships on -- so a crash mid-write leaves the previous, still-valid
//! snapshot in place rather than a half-written file. An operator inspects
//! the current table at any time with `cat`/`jq` directly on `path`.

use std::collections::HashMap;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::route::PeerRoute;

#[derive(Debug, Error)]
pub enum PeerRouteStoreError {
    #[error("runtime peer/route table I/O error at {path}: {source}")]
    Io { path: PathBuf, source: io::Error },
    #[error("corrupt runtime peer/route table at {path}: {source}")]
    Corrupt {
        path: PathBuf,
        source: serde_json::Error,
    },
}

#[derive(Debug, Serialize, Deserialize)]
struct StoredPeer {
    id: String,
    /// `None` for a peer added over the plain operator surface
    /// (`POST /peers`) -- durable and permanent, exactly as every runtime
    /// peer was before issue #886. `Some` for one a peer-sale purchase
    /// inserted: the instant past which it lapses and is demoted back to
    /// client role unless renewed (`Connector::upsert_runtime_peer_purchase`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, Deserialize)]
struct StoredRoute {
    prefix: String,
    peer_id: String,
    fee: u64,
    price: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Snapshot {
    #[serde(default)]
    peers: Vec<StoredPeer>,
    #[serde(default)]
    routes: Vec<StoredRoute>,
}

/// A runtime peer id, alongside its lease expiry -- `None` for a peer
/// added over the plain operator surface, never subject to a lease
/// (issue #886).
pub type RuntimePeers = HashMap<String, Option<DateTime<Utc>>>;

/// What opening a [`PeerRouteStore`] replays: the store itself, plus
/// whatever peer ids (with their lease, if any) and peer-forwarding
/// routes its file already held (empty for a fresh file).
pub type PeerRouteTable = (PeerRouteStore, RuntimePeers, HashMap<String, PeerRoute>);

/// The `state_dir`-scoped file backing issue #884's runtime peer/route
/// table. Opening one replays whatever it already held (empty for a fresh
/// file, matching every other `state_dir`-scoped store's "no state yet"
/// degrade); `persist` overwrites it wholesale with the table's current
/// contents.
#[derive(Debug)]
pub struct PeerRouteStore {
    path: PathBuf,
}

impl PeerRouteStore {
    /// Open (or, if absent, note the future location of) the table file at
    /// `path`, returning the store alongside whatever peer ids and routes
    /// it already held.
    pub fn open(path: &Path) -> Result<PeerRouteTable, PeerRouteStoreError> {
        let store = PeerRouteStore {
            path: path.to_path_buf(),
        };
        if !path.exists() {
            return Ok((store, HashMap::new(), HashMap::new()));
        }
        let text = fs::read_to_string(path).map_err(|source| PeerRouteStoreError::Io {
            path: path.to_path_buf(),
            source,
        })?;
        if text.trim().is_empty() {
            return Ok((store, HashMap::new(), HashMap::new()));
        }
        let snapshot: Snapshot =
            serde_json::from_str(&text).map_err(|source| PeerRouteStoreError::Corrupt {
                path: path.to_path_buf(),
                source,
            })?;
        let peers = snapshot
            .peers
            .into_iter()
            .map(|peer| (peer.id, peer.expires_at))
            .collect();
        let routes = snapshot
            .routes
            .into_iter()
            .map(|route| {
                (
                    route.prefix.clone(),
                    PeerRoute::new_priced(route.prefix, route.peer_id, route.fee, route.price),
                )
            })
            .collect();
        Ok((store, peers, routes))
    }

    /// Overwrite this store's file with `peers` and `routes` in full.
    /// Sorted before serializing so two writes of the same logical table
    /// produce byte-identical output -- an operator diffing the file
    /// across two mutations sees only the actual change, not a HashMap's
    /// unspecified iteration order.
    pub fn persist(
        &self,
        peers: &RuntimePeers,
        routes: &HashMap<String, PeerRoute>,
    ) -> Result<(), PeerRouteStoreError> {
        let mut stored_peers: Vec<StoredPeer> = peers
            .iter()
            .map(|(id, expires_at)| StoredPeer {
                id: id.clone(),
                expires_at: *expires_at,
            })
            .collect();
        stored_peers.sort_by(|a, b| a.id.cmp(&b.id));
        let mut stored_routes: Vec<StoredRoute> = routes
            .values()
            .map(|route| StoredRoute {
                prefix: route.prefix().to_string(),
                peer_id: route.peer_id().to_string(),
                fee: route.fee(),
                price: route.price(),
            })
            .collect();
        stored_routes.sort_by(|a, b| a.prefix.cmp(&b.prefix));
        let snapshot = Snapshot {
            peers: stored_peers,
            routes: stored_routes,
        };
        let text = serde_json::to_string_pretty(&snapshot)
            .expect("a runtime peer/route snapshot always serializes to JSON");

        let tmp_path = self.path.with_extension("json.tmp");
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|source| PeerRouteStoreError::Io {
                path: parent.to_path_buf(),
                source,
            })?;
        }
        let mut file = fs::File::create(&tmp_path).map_err(|source| PeerRouteStoreError::Io {
            path: tmp_path.clone(),
            source,
        })?;
        file.write_all(text.as_bytes())
            .map_err(|source| PeerRouteStoreError::Io {
                path: tmp_path.clone(),
                source,
            })?;
        file.sync_all().map_err(|source| PeerRouteStoreError::Io {
            path: tmp_path.clone(),
            source,
        })?;
        fs::rename(&tmp_path, &self.path).map_err(|source| PeerRouteStoreError::Io {
            path: self.path.clone(),
            source,
        })?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn opening_a_path_that_does_not_exist_yet_yields_an_empty_table() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("runtime_peers.json");

        let (_store, peers, routes) = PeerRouteStore::open(&path).expect("open");
        assert!(peers.is_empty());
        assert!(routes.is_empty());
    }

    #[test]
    fn a_persisted_table_is_read_back_identically() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("runtime_peers.json");
        let (store, _, _) = PeerRouteStore::open(&path).expect("open");

        let mut peers = HashMap::new();
        peers.insert("apex-relay-2".to_string(), None);
        let mut routes = HashMap::new();
        routes.insert(
            "g.example.relay2".to_string(),
            PeerRoute::new_priced("g.example.relay2", "apex-relay-2", 3, 25),
        );
        store.persist(&peers, &routes).expect("persist");

        let (_store, read_peers, read_routes) = PeerRouteStore::open(&path).expect("re-open");
        assert_eq!(read_peers, peers);
        assert_eq!(read_routes, routes);
    }

    /// A peer-sale purchase's lease (issue #886) round-trips through the
    /// durable snapshot exactly like every other field -- an operator
    /// restarting a box must not silently lose track of when a purchased
    /// peering lapses.
    #[test]
    fn a_peers_lease_expiry_round_trips() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("runtime_peers.json");
        let (store, _, _) = PeerRouteStore::open(&path).expect("open");

        let expires_at = Utc.with_ymd_and_hms(2030, 1, 1, 0, 0, 0).unwrap();
        let mut peers = HashMap::new();
        peers.insert("evm:1".to_string(), Some(expires_at));
        peers.insert("apex-relay-2".to_string(), None);
        store.persist(&peers, &HashMap::new()).expect("persist");

        let (_store, read_peers, _) = PeerRouteStore::open(&path).expect("re-open");
        assert_eq!(read_peers.get("evm:1"), Some(&Some(expires_at)));
        assert_eq!(read_peers.get("apex-relay-2"), Some(&None));
    }

    #[test]
    fn persisting_again_overwrites_rather_than_appends() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("runtime_peers.json");
        let (store, _, _) = PeerRouteStore::open(&path).expect("open");

        let mut peers = HashMap::new();
        peers.insert("peer-a".to_string(), None);
        store
            .persist(&peers, &HashMap::new())
            .expect("first persist");

        peers.remove("peer-a");
        peers.insert("peer-b".to_string(), None);
        store
            .persist(&peers, &HashMap::new())
            .expect("second persist");

        let (_store, read_peers, _) = PeerRouteStore::open(&path).expect("re-open");
        assert_eq!(read_peers, peers);
        assert!(!read_peers.contains_key("peer-a"));
    }

    #[test]
    fn an_empty_file_reads_back_as_an_empty_table() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("runtime_peers.json");
        fs::write(&path, "").expect("write empty file");

        let (_store, peers, routes) = PeerRouteStore::open(&path).expect("open");
        assert!(peers.is_empty());
        assert!(routes.is_empty());
    }

    #[test]
    fn corrupt_json_is_a_named_error_not_a_silent_empty_table() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("runtime_peers.json");
        fs::write(&path, "{not json").expect("write garbage");

        let error = PeerRouteStore::open(&path).expect_err("garbage must not open");
        assert!(matches!(error, PeerRouteStoreError::Corrupt { .. }));
    }
}

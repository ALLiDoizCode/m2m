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

/// The on-disk shapes a stored peer has ever had, all folded into what a
/// peer row is now: an id and the peering's flat per-packet fee.
///
/// Issue #884 wrote `peers` as a bare `Vec<String>`; #886 grew each entry
/// into a struct so it could carry a peer-sale lease's `expires_at`; ADR
/// 0043 removed purchasable peering and with it the lease, so that field is
/// read and dropped rather than refused; ADR 0061 gave the row a `fee`,
/// which is the peering's and never the route's. `state_dir` is a
/// persistent volume that outlives image upgrades
/// (deploy/connector-rust/README.md) and a snapshot format has no version
/// field to migrate on, so a box holding any older shape must still boot:
/// refusing to parse one is a crash loop with no migration path. A row from
/// either older shape replays at `fee` zero -- free carriage, which is what
/// a peering whose fee lived on its routes charged the moment those routes
/// stopped carrying one.
#[derive(Deserialize)]
#[serde(untagged)]
enum StoredPeerCompat {
    Bare(String),
    Full {
        id: String,
        /// A removed peer-sale lease (ADR 0038, removed by ADR 0043).
        /// Parsed so an older snapshot still opens, then discarded: a
        /// runtime peer row has no expiry of any kind again.
        #[serde(default)]
        #[allow(dead_code)]
        expires_at: Option<DateTime<Utc>>,
        /// ADR 0061's fee, absent from every snapshot written before it.
        #[serde(default)]
        fee: Option<u64>,
    },
}

impl From<StoredPeerCompat> for StoredPeer {
    fn from(compat: StoredPeerCompat) -> StoredPeer {
        match compat {
            StoredPeerCompat::Bare(id) => StoredPeer { id, fee: 0 },
            StoredPeerCompat::Full { id, fee, .. } => StoredPeer {
                id,
                fee: fee.unwrap_or(0),
            },
        }
    }
}

/// A peer row as written: the id, and the peering's flat per-packet fee
/// (ADR 0061).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(from = "StoredPeerCompat")]
struct StoredPeer {
    id: String,
    fee: u64,
}

#[derive(Debug, Serialize, Deserialize)]
struct StoredRoute {
    prefix: String,
    peer_id: String,
    /// A route's fee, moved to the peer row by ADR 0061. Parsed so a
    /// snapshot written before that still opens, then discarded -- the
    /// same read-and-drop the removed peer-sale lease above gets, and for
    /// the same reason: a `state_dir` outliving an image upgrade must not
    /// crash-loop on its own durable table. Never written back: a rewritten
    /// snapshot drops the key for good, the way the removed lease is
    /// dropped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[allow(dead_code)]
    fee: Option<u64>,
    price: u64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Snapshot {
    #[serde(default)]
    peers: Vec<StoredPeer>,
    #[serde(default)]
    routes: Vec<StoredRoute>,
}

/// The runtime peerings this node holds (issue #884), each id mapped to its
/// flat per-packet fee (ADR 0061) -- what this connector retains for
/// carrying one packet to that counterparty. A map rather than the bare set
/// #884 wrote, because a fee attaches to the peering: it was the one thing
/// a peer row needed to carry once ADR 0061 took it off the route.
pub type RuntimePeers = HashMap<String, u64>;

/// What opening a [`PeerRouteStore`] replays: the store itself, plus
/// whatever peer ids and peer-forwarding routes its file already held
/// (empty for a fresh file).
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
            return Ok((store, RuntimePeers::new(), HashMap::new()));
        }
        let text = fs::read_to_string(path).map_err(|source| PeerRouteStoreError::Io {
            path: path.to_path_buf(),
            source,
        })?;
        if text.trim().is_empty() {
            return Ok((store, RuntimePeers::new(), HashMap::new()));
        }
        let snapshot: Snapshot =
            serde_json::from_str(&text).map_err(|source| PeerRouteStoreError::Corrupt {
                path: path.to_path_buf(),
                source,
            })?;
        let peers = snapshot
            .peers
            .into_iter()
            .map(|peer| (peer.id, peer.fee))
            .collect();
        let routes = snapshot
            .routes
            .into_iter()
            .map(|route| {
                (
                    route.prefix.clone(),
                    PeerRoute::new_priced(route.prefix, route.peer_id, route.price),
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
            .map(|(id, fee)| StoredPeer {
                id: id.clone(),
                fee: *fee,
            })
            .collect();
        stored_peers.sort_by(|a, b| a.id.cmp(&b.id));
        let mut stored_routes: Vec<StoredRoute> = routes
            .values()
            .map(|route| StoredRoute {
                prefix: route.prefix().to_string(),
                peer_id: route.peer_id().to_string(),
                fee: None,
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

        let mut peers = RuntimePeers::new();
        peers.insert("apex-relay-2".to_string(), 3);
        let mut routes = HashMap::new();
        routes.insert(
            "g.example.relay2".to_string(),
            PeerRoute::new_priced("g.example.relay2", "apex-relay-2", 25),
        );
        store.persist(&peers, &routes).expect("persist");

        let (_store, read_peers, read_routes) = PeerRouteStore::open(&path).expect("re-open");
        assert_eq!(read_peers, peers);
        assert_eq!(read_routes, routes);
    }

    /// The exact bytes issue #884's format wrote -- `peers` as bare
    /// strings, and a `fee` on each route -- still replay: `state_dir`
    /// outlives image upgrades, so a node that added a runtime peer before
    /// #886 grew each entry into a struct boots with this very file on
    /// disk, and refusing to parse it is a crash loop with no migration
    /// path. The route's `fee` is read and dropped (ADR 0061); the peering
    /// it belonged to replays at zero.
    #[test]
    fn a_bare_string_peer_snapshot_still_replays() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("runtime_peers.json");
        fs::write(
            &path,
            r#"{"peers":["apex-relay-2"],"routes":[{"prefix":"g.example.relay2","peer_id":"apex-relay-2","fee":3,"price":25}]}"#,
        )
        .expect("write the #884-format file");

        let (store, peers, routes) = PeerRouteStore::open(&path).expect("the old format parses");
        assert_eq!(peers.get("apex-relay-2"), Some(&0));
        assert_eq!(routes.len(), 1);
        assert_eq!(routes["g.example.relay2"].price(), 25);

        // And persisting rewrites it in the current form, which the next
        // open reads back identically.
        store.persist(&peers, &routes).expect("persist");
        let (_store, read_peers, read_routes) = PeerRouteStore::open(&path).expect("re-open");
        assert_eq!(read_peers, peers);
        assert_eq!(read_routes, routes);
    }

    /// A snapshot written while purchasable peering still existed (ADR
    /// 0038's `expires_at` on a peer row, removed by ADR 0043) still opens:
    /// the field is read and dropped, never refused. The alternative is a
    /// box whose `state_dir` outlived the image upgrade crash-looping on
    /// its own durable table.
    #[test]
    fn a_snapshot_carrying_a_removed_lease_field_still_replays() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("runtime_peers.json");
        fs::write(
            &path,
            r#"{"peers":[{"id":"evm:1","expires_at":"2030-01-01T00:00:00Z"},{"id":"apex-relay-2"}],"routes":[]}"#,
        )
        .expect("write the #886-format file");

        let (store, peers, _) = PeerRouteStore::open(&path).expect("the lease format parses");
        assert!(peers.contains_key("evm:1"));
        assert!(peers.contains_key("apex-relay-2"));

        // And rewriting drops the field for good, rather than carrying a
        // lease nothing reads any more.
        store.persist(&peers, &HashMap::new()).expect("persist");
        let rewritten = fs::read_to_string(&path).expect("read back");
        assert!(
            !rewritten.contains("expires_at"),
            "a rewritten snapshot must not carry the removed lease: {rewritten}"
        );
    }

    #[test]
    fn persisting_again_overwrites_rather_than_appends() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("runtime_peers.json");
        let (store, _, _) = PeerRouteStore::open(&path).expect("open");

        let mut peers = RuntimePeers::new();
        peers.insert("peer-a".to_string(), 0);
        store
            .persist(&peers, &HashMap::new())
            .expect("first persist");

        peers.remove("peer-a");
        peers.insert("peer-b".to_string(), 0);
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

    /// ADR 0061: a peering's fee survives the restart it is written for.
    /// The row is the durable one -- a runtime peer added over
    /// `POST /peers` -- so a fee that did not round-trip would mean a node
    /// carrying that peering's packets for free after every restart.
    #[test]
    fn a_peerings_fee_round_trips_through_the_snapshot() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("runtime_peers.json");
        let (store, _, _) = PeerRouteStore::open(&path).expect("open");

        let mut peers = RuntimePeers::new();
        peers.insert("apex-relay-2".to_string(), 100);
        store.persist(&peers, &HashMap::new()).expect("persist");

        let (_store, read_peers, _) = PeerRouteStore::open(&path).expect("re-open");
        assert_eq!(read_peers.get("apex-relay-2"), Some(&100));
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

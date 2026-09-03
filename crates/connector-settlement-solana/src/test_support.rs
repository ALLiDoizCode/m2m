//! A real, disposable `solana-test-validator` harness shared by this
//! crate's own integration tests (via a dev-dependency on itself with
//! `test-util` on) and other crates' (issue #630): `connector-cli`'s
//! settlement-construction tests need exactly what this crate's
//! integration tests already stand up, and one copy of the harness is one
//! place to fix it.
//! Gated behind the `test-util` feature for the same reason
//! `connector-settlement-evm`'s own `test_support` module is: a downstream
//! crate's tests cannot see anything behind `#[cfg(test)]`, since that cfg
//! is only active while this crate compiles its own test binary.

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU16, Ordering};
use std::time::Duration;

use solana_rpc_client::nonblocking::rpc_client::RpcClient;
use solana_sdk::pubkey::Pubkey;

/// Airdrop `pubkey` enough lamports to submit a handful of transactions
/// (issue #630) -- the shared "fund a freshly connected identity" step
/// every caller of this harness that goes on to sign real transactions
/// needs (`connector-cli`'s settlement-construction tests,
/// `connect_identity.rs`'s own), rather than each reimplementing the same
/// request-airdrop-then-poll-confirm loop.
pub async fn fund(rpc: &RpcClient, pubkey: &Pubkey) {
    let signature = rpc
        .request_airdrop(pubkey, 10_000_000_000)
        .await
        .expect("airdrop");
    for _ in 0..200 {
        if rpc.confirm_transaction(&signature).await.unwrap_or(false) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("airdrop did not confirm in time");
}

/// The fixed program id this crate's tests load `payment_channel.so`
/// under -- passed to `solana-test-validator --bpf-program` as a bare id
/// (see [`SolanaValidator::spawn`]), not resolved from any keypair file, so
/// no keypair for it is tracked in this repo (issue #922). Distinct from the
/// real, deployed `2aEVJ8koKD8LTZrLRSGtAtU7LBt4e7QjjCgf1kzQ7Rip` on public
/// devnet (`packages/solana-program/deployments/devnet-public.md`): this id
/// exists only inside a disposable local validator's genesis.
pub const LOCAL_TEST_PROGRAM_ID: &str = "HY4AYFNe5Vg5BkEwAURNsGY3uFAvGMNpAQPRtgoasJiR";

fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("crates/connector-settlement-solana is two levels below the workspace root")
        .to_path_buf()
}

fn program_so_path() -> PathBuf {
    workspace_root().join("target/deploy/payment_channel.so")
}

/// Where [`program_build_record`] of the `payment_channel.so` this harness
/// last built is kept, next to the `.so` itself so the two travel together
/// through any `target/` cache.
fn program_record_path() -> PathBuf {
    workspace_root().join("target/deploy/payment_channel.so.buildrecord")
}

/// What this harness vouches for when it skips a build: the sources the
/// `.so` was built from, AND the bytes it wrote.
///
/// The second half is not redundant. `target/deploy` is a drop box no one
/// owns -- `tools/solana/build-sbf.sh`, `cargo test-sbf` via `make
/// solana-test` and a hand-run `cargo build-sbf` all write
/// `payment_channel.so` there, and the last of those can write a binary
/// from a different platform-tools line (measurably different bytes:
/// 112,680 against the pinned line's 109,416). Recording only the sources
/// meant any of them could replace the artifact under a record that still
/// matched, and this harness would load it and say nothing. Recording what
/// was written makes a foreign write a rebuild instead.
fn program_build_record(source_fingerprint: &str, so_bytes: &[u8]) -> String {
    format!("{source_fingerprint} {}", solana_sdk::hash::hash(so_bytes))
}

/// True when the `.so` at `so_path` is exactly the artifact this harness
/// last built, from exactly `source_fingerprint`. False -- meaning
/// "rebuild" -- if any of the three is missing or disagrees.
fn program_artifact_is_current(
    so_path: &Path,
    record_path: &Path,
    source_fingerprint: Option<&str>,
) -> bool {
    let Some(source_fingerprint) = source_fingerprint else {
        return false;
    };
    let Ok(so_bytes) = std::fs::read(so_path) else {
        return false;
    };
    std::fs::read_to_string(record_path).ok()
        == Some(program_build_record(source_fingerprint, &so_bytes))
}

/// A hash over every source `cargo build-sbf` compiles into
/// `payment_channel.so` -- `packages/solana-program`'s manifest and its
/// whole `src/` tree, each file's path hashed alongside its bytes so a
/// rename counts as a change.
///
/// This exists because "the `.so` is present" is not "the `.so` is the
/// program in this working tree". `target/` is a restored cache in the
/// Rust Workspace Gate, so a `.so` built from an *older* commit arrives
/// already present; reusing it silently tested the wrong program. That is
/// exactly how #1082's balance-proof change (ADR 0053) failed CI: the
/// client signed the new 96-byte message while the cached program still
/// expected the old 48-byte one and rejected every claim with
/// `InvalidSignature`. Comparing sources, not mere existence, is what
/// makes the rebuild happen.
///
/// `None` if the sources cannot be read at all, which callers treat as
/// "cannot vouch for the `.so`" and rebuild.
fn program_source_fingerprint() -> Option<String> {
    let program_dir = workspace_root().join("packages/solana-program");
    let mut inputs = vec![program_dir.join("Cargo.toml")];
    collect_program_sources(&program_dir.join("src"), &mut inputs)?;
    inputs.sort();

    let mut hashed = Vec::new();
    for path in &inputs {
        hashed.extend_from_slice(path.to_string_lossy().as_bytes());
        hashed.extend_from_slice(&std::fs::read(path).ok()?);
    }
    Some(solana_sdk::hash::hash(&hashed).to_string())
}

/// Every file under `dir`, recursively, appended to `out`. `None` if the
/// directory cannot be walked.
fn collect_program_sources(dir: &Path, out: &mut Vec<PathBuf>) -> Option<()> {
    for entry in std::fs::read_dir(dir).ok()? {
        let path = entry.ok()?.path();
        if path.is_dir() {
            collect_program_sources(&path, out)?;
        } else {
            out.push(path);
        }
    }
    Some(())
}

/// Build `packages/solana-program` for the SBF target with `cargo
/// build-sbf` unless the `.so` already on disk was built from exactly the
/// sources in this working tree, so a fresh checkout, a CI cache miss, or
/// an *edit to the program* all still produce something current to load --
/// mirrors `make solana-build`. Returns `false` (rather than panicking) if
/// the build tool is missing or the build itself fails, so callers can
/// fold that into the same "skip locally, fail loudly in CI" policy every
/// other gate in this harness already uses.
///
/// The freshness check is [`program_build_record`], recorded beside the
/// `.so` on each successful build; see its docs, and
/// [`program_source_fingerprint`]'s, for why neither the `.so`'s presence
/// nor the sources alone was enough.
///
/// `--tools-version v1.52` pins the platform-tools release rather than
/// taking whichever line the installed CLI defaults to: it is the same pin
/// CI's own `solana-program` job builds with
/// (`.github/workflows/ci.yml`), and the toolchain line the deployed
/// devnet program itself was built from -- a v1.52 build of this source
/// matches the live bytecode's exact size and is 99.7% byte-identical,
/// where the v2.1 CLI's default tools line produces a differently-sized
/// binary entirely (`packages/solana-program/deployments/devnet-public.md`,
/// "Reproducible-build comparison").
///
/// The pin is applied by shelling through `tools/solana/build-sbf.sh` rather
/// than spawning `cargo build-sbf` here, so this harness gets the same
/// cold-machine bootstrap every other caller does: on a checkout that has
/// never built the program, a bare pinned `cargo build-sbf` panics on a
/// missing `$HOME/.cache/solana` long before it reaches the network. That
/// script's header explains why, and it is also what refuses a build that
/// silently fell back to the CLI's built-in toolchain line.
fn ensure_program_built() -> bool {
    let fingerprint = program_source_fingerprint();
    if program_artifact_is_current(
        &program_so_path(),
        &program_record_path(),
        fingerprint.as_deref(),
    ) {
        return true;
    }
    let status = Command::new(workspace_root().join("tools/solana/build-sbf.sh"))
        .current_dir(workspace_root().join("packages/solana-program"))
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .status();
    let built = matches!(status, Ok(status) if status.success()) && program_so_path().exists();
    if built {
        if let (Some(fingerprint), Ok(so_bytes)) = (fingerprint, std::fs::read(program_so_path())) {
            // Written via a temporary and renamed: two tests in the same
            // binary reach this concurrently (cargo's own build lock
            // serializes their builds, not their bookkeeping), and a
            // half-written record would cost a needless rebuild.
            let temporary = program_record_path().with_extension("buildrecord.tmp");
            let record = program_build_record(&fingerprint, &so_bytes);
            if std::fs::write(&temporary, &record).is_ok() {
                let _ = std::fs::rename(&temporary, program_record_path());
            }
        }
    }
    built
}

/// True if `solana-test-validator --version` runs successfully.
pub fn solana_test_validator_available() -> bool {
    Command::new("solana-test-validator")
        .arg("--version")
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

/// The Solana twin of `connector_settlement_evm::test_support::require_anvil`:
/// a real chain is genuinely under test here (ADR 0007), so a CI run
/// lacking either `solana-test-validator` or a buildable
/// `payment_channel.so` must fail loudly rather than silently skip and
/// report `passed`. A local run missing either still skips, since
/// requiring every contributor to install the Solana CLI and SBF toolchain
/// just to run `cargo test` is a real cost this crate doesn't need to
/// impose.
///
/// Returns `true` when the caller should proceed with its real assertions,
/// `false` when the caller should return early (having already skipped
/// gracefully via a printed message).
pub fn require_solana_test_validator() -> bool {
    let validator_ok = solana_test_validator_available();
    let program_ok = ensure_program_built();

    if validator_ok && program_ok {
        return true;
    }

    if std::env::var_os("CI").is_some() {
        panic!(
            "solana-test-validator on PATH: {validator_ok}, packages/solana-program built (or \
             buildable via `cargo build-sbf`): {program_ok} -- the Rust Workspace Gate must \
             provide both before this crate's tests run. Refusing to silently skip and report \
             success here; see issue #567."
        );
    }

    eprintln!(
        "skipping: solana-test-validator on PATH: {validator_ok}, packages/solana-program built \
         (or buildable via `cargo build-sbf`, requires the Solana SBF toolchain: \
         https://docs.anza.xyz/cli/install): {program_ok} -- this test needs a real chain \
         running the real deployed program and only skips because this is not a CI run"
    );
    false
}

static NEXT_PORT_OFFSET: AtomicU16 = AtomicU16::new(0);

/// A freshly spawned `solana-test-validator` instance, with
/// `packages/solana-program`'s own built `.so` loaded into its genesis at
/// [`LOCAL_TEST_PROGRAM_ID`], killed (and its disposable ledger directory
/// removed) when dropped. Each instance gets its own ledger directory and
/// ports so tests spawning one concurrently don't collide.
pub struct SolanaValidator {
    child: Child,
    // Never read after construction -- kept only so its directory outlives
    // the validator process using it and is removed on drop.
    _ledger: tempfile::TempDir,
    pub rpc_url: String,
}

impl SolanaValidator {
    pub async fn spawn() -> Self {
        let offset = NEXT_PORT_OFFSET.fetch_add(1, Ordering::SeqCst);
        let rpc_port = 19_900u16
            .wrapping_add((std::process::id() as u16) % 500)
            .wrapping_add(offset.wrapping_mul(50));
        let rpc_url = format!("http://127.0.0.1:{rpc_port}");
        let ledger = tempfile::tempdir().expect("create disposable ledger dir");

        let so_path = program_so_path();
        assert!(
            so_path.exists(),
            "packages/solana-program's built artifact missing: {} -- \
             require_solana_test_validator() must be checked first",
            so_path.display()
        );

        let child = Command::new("solana-test-validator")
            .args(["--ledger"])
            .arg(ledger.path())
            .args(["--rpc-port", &rpc_port.to_string()])
            .args(["--faucet-port", &(rpc_port + 1).to_string()])
            .args([
                "--dynamic-port-range",
                &format!("{}-{}", rpc_port + 2, rpc_port + 40),
            ])
            .args(["--bpf-program", LOCAL_TEST_PROGRAM_ID])
            .arg(&so_path)
            .args(["--reset", "--quiet"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect(
                "spawn solana-test-validator (is it on PATH? see \
                 https://docs.anza.xyz/cli/install)",
            );

        let rpc = RpcClient::new(rpc_url.clone());
        let mut ready = false;
        for _ in 0..600 {
            if rpc.get_version().await.is_ok() {
                ready = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(
            ready,
            "solana-test-validator did not become ready at {rpc_url}"
        );

        Self {
            child,
            _ledger: ledger,
            rpc_url,
        }
    }
}

impl Drop for SolanaValidator {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::{program_artifact_is_current, program_build_record};

    /// A `target/deploy` directory holding a `.so` and the record this
    /// harness would have written for it. Real files in a temporary
    /// directory, not a fake filesystem: what is under test is the
    /// conclusion [`program_artifact_is_current`] draws from bytes on disk.
    struct DropBox {
        _dir: tempfile::TempDir,
        so: std::path::PathBuf,
        record: std::path::PathBuf,
    }

    impl DropBox {
        fn built_from(sources: &str, so_bytes: &[u8]) -> Self {
            let dir = tempfile::tempdir().expect("temp dir");
            let so = dir.path().join("payment_channel.so");
            let record = dir.path().join("payment_channel.so.buildrecord");
            std::fs::write(&so, so_bytes).expect("write .so");
            std::fs::write(&record, program_build_record(sources, so_bytes)).expect("write record");
            Self {
                _dir: dir,
                so,
                record,
            }
        }

        fn is_current_for(&self, sources: &str) -> bool {
            program_artifact_is_current(&self.so, &self.record, Some(sources))
        }
    }

    #[test]
    fn the_artifact_this_harness_built_is_current() {
        let drop_box = DropBox::built_from("sources-a", b"pinned bytes");
        assert!(
            drop_box.is_current_for("sources-a"),
            "the .so and the record this harness itself wrote must not cost a rebuild"
        );
    }

    #[test]
    fn an_artifact_someone_else_wrote_is_not_current() {
        let drop_box = DropBox::built_from("sources-a", b"pinned bytes");
        // What a hand-run `cargo build-sbf` does: replaces the .so in
        // target/deploy with a build of the same sources from a different
        // platform-tools line, leaving this harness's record untouched.
        std::fs::write(&drop_box.so, b"some other toolchain line's bytes").expect("foreign write");

        assert!(
            !drop_box.is_current_for("sources-a"),
            "target/deploy/payment_channel.so is a drop box this harness does not own -- a .so it \
             did not write must be rebuilt, not loaded into a validator on the strength of a \
             record describing different bytes"
        );
    }

    #[test]
    fn an_artifact_built_from_other_sources_is_not_current() {
        let drop_box = DropBox::built_from("sources-a", b"pinned bytes");
        assert!(
            !drop_box.is_current_for("sources-b"),
            "an edit to packages/solana-program must rebuild -- issue #1082's failure was loading \
             a cached .so that predated the change under test"
        );
    }

    #[test]
    fn an_unreadable_artifact_or_record_is_not_current() {
        let drop_box = DropBox::built_from("sources-a", b"pinned bytes");

        std::fs::remove_file(&drop_box.record).expect("remove record");
        assert!(
            !drop_box.is_current_for("sources-a"),
            "no record means this harness cannot vouch for the .so"
        );

        std::fs::write(
            &drop_box.record,
            program_build_record("sources-a", b"pinned bytes"),
        )
        .expect("restore record");
        std::fs::remove_file(&drop_box.so).expect("remove .so");
        assert!(
            !drop_box.is_current_for("sources-a"),
            "no .so means there is nothing to vouch for"
        );

        assert!(
            !program_artifact_is_current(&drop_box.so, &drop_box.record, None),
            "sources that cannot be read at all must rebuild rather than trust the record"
        );
    }
}

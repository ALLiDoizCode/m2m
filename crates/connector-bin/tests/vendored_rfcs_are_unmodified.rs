//! The vendored Interledger RFC bodies must stay byte-identical to what was
//! copied in. [ADR 0062](../../../docs/adr/0062-an-rfc-is-vendored-verbatim-and-profiled-never-forked.md).
//!
//! `docs/rfcs/` holds ten upstream RFCs, each an unmodified body beneath a
//! TOON-profile preface. The whole value of that arrangement is that the two
//! halves are distinguishable: the preface is this project's claim about
//! itself and may be edited freely, the body is the Interledger Foundation's
//! text and may not be edited at all.
//!
//! Nothing about a markdown file makes that visible, and the failure is
//! quiet. Somebody strikes a paragraph about exchange rates because this
//! connector has none, or rewrites `data` to describe the gift wrap, and the
//! file still renders — it just now attributes to a standards body a sentence
//! the standards body never wrote. That is both the licence claim in
//! `docs/rfcs/README.md` (CC BY-SA 4.0: state what you changed) and ADR 0062's
//! D3 precedence rule (an RFC body is what the local rules are stated
//! *against*) failing at the same time.
//!
//! So each preface records the SHA-256 of its own body and this harness
//! recomputes it.
//!
//! **Deliberately offline.** This checks "unmodified since vendored", not
//! "still matches upstream". The first is the claim the licence makes us
//! responsible for and is ours to keep; the second is a fact about another
//! repository's default branch, and a build that goes red because upstream
//! published an erratum is a build that teaches people to delete the check.
//! `docs/rfcs/README.md` spells out the one-line `curl | sha256sum` that
//! answers the second question, as the human step ADR 0062 D1 says it is.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// Upstream's file begins after this line and the single blank line that
/// follows it. A comment rather than a horizontal rule because an RFC body may
/// itself contain `---`, and a delimiter that can occur in the thing it
/// delimits is not a delimiter.
///
/// The blank line is not decoration. Every vendored body opens with `---` YAML
/// front matter, and in markdown a text line sitting directly above `---` is a
/// **setext heading** — so without a separator the marker parses as an `<h2>`,
/// and any formatter that normalises headings rewrites it. Prettier did exactly
/// that here on the first commit, via the repository's pre-commit hook, which is
/// why `docs/rfcs` is now in `.prettierignore` and why the separator exists as
/// well: one of those two is a rule someone can drop, and the other is the
/// document being unambiguous on its own.
///
/// The separator sits ABOVE the hashed region, so a recorded digest is still
/// upstream's own file digest and the `curl | sha256sum` in `docs/rfcs/README.md`
/// compares equal.
const BODY_MARKER: &str = "<!-- BEGIN VERBATIM UPSTREAM BODY -->";

/// The line the preface records the digest on, e.g.
/// `> - **Body SHA-256:** ` + a backticked 64-hex digest.
const DIGEST_LABEL: &str = "**Body SHA-256:**";

fn rfcs_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../docs/rfcs")
}

/// Every vendored copy, as (slug, full path). Read off the directory rather
/// than from a hand-maintained list here: a list would drift, and the drift
/// direction that matters — a new RFC vendored with no digest, or with a
/// digest nobody checked — is exactly the one a list would hide.
fn vendored_copies() -> Vec<(String, PathBuf)> {
    let mut found: Vec<(String, PathBuf)> = std::fs::read_dir(rfcs_dir())
        .expect("docs/rfcs/ exists")
        .map(|entry| entry.expect("a readable docs/rfcs/ entry").path())
        .filter(|path| path.is_dir())
        .map(|dir| {
            let slug = dir
                .file_name()
                .expect("a named directory")
                .to_string_lossy()
                .into_owned();
            let file = dir.join(format!("{slug}.md"));
            (slug, file)
        })
        .collect();
    found.sort();
    found
}

/// The preface's recorded digest, and the raw body bytes it describes.
fn split(path: &Path) -> (String, Vec<u8>) {
    let raw = std::fs::read(path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()));
    let text = String::from_utf8(raw.clone())
        .unwrap_or_else(|e| panic!("{} is not UTF-8: {e}", path.display()));

    let marker_at = text.find(BODY_MARKER).unwrap_or_else(|| {
        panic!(
            "{} has no `{BODY_MARKER}` line -- a vendored RFC is a preface, that marker, then \
             upstream's bytes (ADR 0062 D1)",
            path.display()
        )
    });
    let after_marker = marker_at + BODY_MARKER.len();
    let marker_line_ends = text[after_marker..]
        .find('\n')
        .map(|nl| after_marker + nl + 1)
        .unwrap_or_else(|| panic!("{}'s body marker ends the file", path.display()));

    // Skip the mandatory blank separator line. It is not part of the body --
    // see BODY_MARKER's note on why it has to be there at all.
    let body_starts = if text[marker_line_ends..].starts_with('\n') {
        marker_line_ends + 1
    } else {
        panic!(
            "{} has no blank line between its body marker and the body. That blank line is \
             required: an RFC body opens with `---` front matter, and a text line directly \
             above `---` is a setext heading, so without it the marker is an <h2> that any \
             markdown formatter will rewrite. Re-run `tools/vendor-rfc.sh {}`.",
            path.display(),
            path.parent()
                .and_then(|d| d.file_name())
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default()
        )
    };

    let preface = &text[..marker_at];
    let digest_line = preface
        .lines()
        .find(|line| line.contains(DIGEST_LABEL))
        .unwrap_or_else(|| {
            panic!(
                "{}'s preface records no `{DIGEST_LABEL}` -- ADR 0062 D1 requires the upstream \
                 path, the pinned commit and the body digest",
                path.display()
            )
        });
    let recorded = digest_line
        .split('`')
        .nth(1)
        .unwrap_or_else(|| {
            panic!(
                "{}'s `{DIGEST_LABEL}` line does not carry a backticked digest: {digest_line}",
                path.display()
            )
        })
        .to_ascii_lowercase();

    (recorded, raw[body_starts..].to_vec())
}

/// The load-bearing assertion. A body whose bytes no longer hash to what its
/// own preface says was vendored has been edited, and ADR 0062 says it must
/// not have been.
#[test]
fn every_vendored_rfc_body_matches_its_recorded_digest() {
    let copies = vendored_copies();
    assert!(
        copies.len() >= 10,
        "expected the ten RFCs ADR 0062 D4 vendors, found {}: {:?}",
        copies.len(),
        copies.iter().map(|(slug, _)| slug).collect::<Vec<_>>()
    );

    for (slug, path) in copies {
        let (recorded, body) = split(&path);
        let actual = format!("{:x}", Sha256::digest(&body));
        assert_eq!(
            actual, recorded,
            "docs/rfcs/{slug}/{slug}.md's body has been modified.\n\
             \n\
             Its preface says the upstream body hashes to {recorded}; it now hashes to {actual}.\n\
             \n\
             If you were editing the TOON profile, the edit belongs ABOVE the \
             `{BODY_MARKER}` line -- everything below it is the Interledger Foundation's \
             text, reproduced under CC BY-SA 4.0 on the stated condition that it is \
             unmodified (ADR 0062 D1, D5).\n\
             \n\
             If you are deliberately re-vendoring from a newer upstream commit, update the \
             preface's pinned commit AND its digest in the same change, and say in the commit \
             message what moved."
        );
    }
}

/// A digest is only evidence if it was computed over something. An empty or
/// near-empty body would satisfy the hash check trivially, which is the shape
/// a half-finished re-vendoring leaves behind.
#[test]
fn every_vendored_rfc_body_is_a_whole_document() {
    for (slug, path) in vendored_copies() {
        let (_, body) = split(&path);
        assert!(
            body.len() > 2_000,
            "docs/rfcs/{slug}/{slug}.md's body is {} bytes -- too short to be an RFC. A \
             truncated body still hashes to whatever the preface was updated to say.",
            body.len()
        );
    }
}

/// The preface must cite what it is a copy of. Without the pinned commit,
/// "still matches upstream" is unanswerable and D1's human step has nothing
/// to run against.
#[test]
fn every_vendored_rfc_preface_pins_its_upstream() {
    for (slug, path) in vendored_copies() {
        let text = std::fs::read_to_string(&path).expect("a readable vendored RFC");
        let preface = text
            .split(BODY_MARKER)
            .next()
            .expect("split always yields a first element");

        for required in ["**Upstream:**", "**Pinned commit:**", "**Licence:**"] {
            assert!(
                preface.contains(required),
                "docs/rfcs/{slug}/{slug}.md's preface is missing `{required}` (ADR 0062 D1, D5)"
            );
        }

        let commit_line = preface
            .lines()
            .find(|line| line.contains("**Pinned commit:**"))
            .expect("checked above");
        let commit = commit_line
            .split('`')
            .nth(1)
            .unwrap_or_else(|| panic!("docs/rfcs/{slug}: pinned commit is not backticked"));
        assert!(
            commit.len() == 40 && commit.chars().all(|c| c.is_ascii_hexdigit()),
            "docs/rfcs/{slug}/{slug}.md pins `{commit}`, which is not a full 40-character commit \
             sha -- a short sha or a branch name is not a pin"
        );
    }
}

/// A profile that names no departure and no ADR is a heading, not a profile.
/// ADR 0062 D2 makes the preface the only place alignment is written, so an
/// empty one means the alignment is written nowhere.
#[test]
fn every_vendored_rfc_carries_a_toon_profile_citing_records() {
    for (slug, path) in vendored_copies() {
        let text = std::fs::read_to_string(&path).expect("a readable vendored RFC");
        let preface = text
            .split(BODY_MARKER)
            .next()
            .expect("split always yields a first element");

        assert!(
            preface.contains("## TOON profile"),
            "docs/rfcs/{slug}/{slug}.md has no `## TOON profile` section (ADR 0062 D2)"
        );
        assert!(
            preface.contains("../../adr/"),
            "docs/rfcs/{slug}/{slug}.md's profile cites no ADR. A departure with no record \
             behind it is not a documented departure -- it is an ADR that has not been \
             written (ADR 0062 D2)."
        );
    }
}

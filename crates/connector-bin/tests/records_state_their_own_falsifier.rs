//! A record that claims something is **absent** from this repository must say
//! what would prove it wrong, and that statement is run.
//!
//! [`docs/adr/README.md`](../../../docs/adr/README.md)'s Conventions already
//! name the failure mode this exists for: *"A record written in the present
//! tense about behaviour the binary does not have is the failure mode above,
//! committed on purpose."* The convention was there; nothing checked it. Over
//! one working session six records were found describing a binary that had
//! moved beneath them:
//!
//! 1. **ADR 0042** item 3 warned that enforcing the covering-claim rule would
//!    stop forwarding *"across the fleet"* — written when both devnet boxes
//!    held BTP peerings to the apex. Issue #872 removed them, and no fleet
//!    config has carried a `[[peers]]` row since.
//! 2. **ADR 0042**'s `## Update (issue #1062)` read as though
//!    `ClaimEnforcement::Observe` had already been deleted. It had not; the
//!    type was still in the tree and issue #1077 deleted it.
//! 3. **ADR 0042**'s Status line recorded item 2 as flatly *"Built."* It was
//!    EVM-only; the Solana half landed in issue #1146.
//! 4. **ADR 0053**'s Status line and index row both said *"not yet built — and
//!    a breaking wire change"*. It had been built: `solana_balance_proof_message`
//!    is 96 bytes with the program id signed over.
//! 5. **`docs/protocol/payment-spec.md` PM-12** said the forwarded covering
//!    rule was *"not yet built"* after it had shipped.
//! 6. **ADR 0057**'s sweep claimed `R01` had no remaining sender action. It had
//!    one — RFC 0027's *"amount too little to forward"* — and `R01` had to be
//!    restored.
//!
//! # What this harness catches, and what it cannot
//!
//! Instances 2, 4 and 5 are **symbol-presence** claims: a record says a thing
//! is unbuilt or deleted, and a symbol proving otherwise sits in `crates/`.
//! Instance 1 is a **config-shape** claim: greppable over the committed TOML.
//! Those four are what this gate is for.
//!
//! **Instances 3 and 6 are semantic, and no gate will catch them.** "Built."
//! was *true* — of one settlement chain out of two, and nothing about the shape
//! of that sentence distinguishes it from a true one. `R01`'s remaining sender
//! action is a claim about what a reject code *means* to a sender, which has no
//! representation in the tree at all. Saying so here is deliberate: a harness
//! that implied coverage it does not have would be the same failure mode one
//! level up.
//!
//! Two further limits, stated rather than discovered later:
//!
//! * **A falsifier is only as good as the pattern its author chose.** Where the
//!   pattern is unavoidable — a config field that must exist by that name, a
//!   route that must be registered — the check is strong. Where the record can
//!   only *prescribe* a name the implementation is expected to use (ADR 0048's
//!   `terminated_subtree` is the one such falsifier here), an implementer who
//!   picks a different name slips past. That is accepted: a gate that
//!   under-fires is survivable, and a gate that cries wolf gets deleted.
//! * **This checks records, not the index.** `docs/adr/README.md`'s "State in
//!   the tree" rows repeat these claims in prose that no marker can be attached
//!   to without duplicating the falsifier and inviting the two copies to drift.
//!   The rows stay a human's job.
//!
//! # The marker
//!
//! A record makes its absence claim machine-checkable by writing, on its own
//! line, directly beneath its `**Scope:**` line:
//!
//! ```text
//! **Falsifier:** `<path glob>` matching `<regex>` — <what a match would mean>
//! ```
//!
//! It asserts: **no file matching the glob contains a line matching the
//! regex.** A match means the record is describing a tree that no longer
//! exists, and this harness fails naming the record, the pattern, and the file
//! and line that disproved it. A record may carry as many falsifier lines as it
//! has claims. The escape hatch is the same marker with the literal `none` and
//! a reason, for a status phrase that is not a mechanically-checkable claim
//! about this tree:
//!
//! ```text
//! **Falsifier:** none — <why this claim cannot be checked mechanically>
//! ```
//!
//! Deliberately *not* inferred from the record's prose. Guessing which symbol
//! an ADR means from the sentence around it is how a doc gate acquires false
//! positives, and a false positive here is fatal — the gate would be suppressed
//! rather than obeyed. So the record states its own falsifier and this harness
//! only runs it.
//!
//! A marker inside a fenced code block is an example, not a declaration —
//! which is what lets `docs/adr/README.md` document the grammar.
//!
//! Comment lines are skipped when matching: `//` for `.rs`, `#` for `.toml`,
//! `.sh` and `.yml`. Every retired identifier in this repository is *named* in
//! prose somewhere — that is what an ADR is for — so a check that could not
//! tell `//! \`Treasury\` was deleted` from a live `Treasury` would fire on
//! every record it exists to protect. Attribute lines (`#[serde(...)]`) are not
//! comments and are matched.
//!
//! # Why the requirement is keyed on the Status line
//!
//! [`docs/adr/README.md`](../../../docs/adr/README.md) puts a `**Status:**`
//! line directly under every record's title, and `docs/protocol/`'s specs
//! follow it. That fixed position is what makes "does this record claim an
//! absence?" a structural question rather than a prose-reading one: this
//! harness scans the **Status block only** — from that line to the first blank
//! line — for `not yet built`, `not built` or `unbuilt`, and requires a
//! falsifier where it finds one.
//!
//! Scanning spec bodies for the same phrases was considered and rejected, and
//! instance 5 above is the cost of that decision. `payment-spec.md` today
//! contains the line *"(This paragraph said "not yet built for a forwarded
//! arrival" until issue #1146 corrected it.)"* — a record of a correction
//! already made. A body scan fires on it. One false positive on a document
//! whose whole point is that it was fixed is exactly the wolf-cry that gets a
//! gate deleted, so spec **bodies** are covered only where their author chooses
//! to write a falsifier line (`self-description-spec.md` does), and their
//! Status lines are covered like an ADR's.
//!
//! A separate harness from `production_skeleton_is_inert.rs` and
//! `documented_config_keys.rs` for the reason those two give about themselves: each
//! asserts a property of a different committed document, and different work
//! edits them.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use regex::Regex;

/// Records are cited by repo-relative path in every failure message below, so
/// the message can be pasted into an editor.
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("the workspace root must be reachable from crates/connector-bin")
}

/// The phrases that make a Status line an absence claim about this tree.
///
/// Matched against the Status block with markdown emphasis stripped and
/// whitespace collapsed, so `**not yet built**`, `not yet **built**` and a
/// phrase wrapped across two source lines all count. Kept short on purpose:
/// every addition is a new way for this gate to demand a falsifier from a
/// record that does not owe one.
const ABSENCE_PHRASES: [&str; 3] = ["not yet built", "not built", "unbuilt"];

const MARKER: &str = "**Falsifier:**";

/// Prose is mandatory after the em dash, and long enough to be a sentence. A
/// falsifier without one is a regex with no statement of what a match would
/// mean, which is the half a reader needs when it fires years from now.
const MIN_PROSE: usize = 40;

// ---------------------------------------------------------------------------
// Reading the corpus
// ---------------------------------------------------------------------------

/// Every markdown file whose falsifier lines are run: all of `docs/`, plus the
/// repository's top-level documents. Broader than the set that is *required* to
/// carry falsifiers (see [`documents_that_must_declare`]) because a falsifier is
/// worth running wherever somebody thought to write one.
fn documents_scanned_for_falsifiers(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    collect_files(&root.join("docs"), &mut found);
    for name in ["README.md", "CONTEXT.md", "CLAUDE.md"] {
        let path = root.join(name);
        if path.is_file() {
            found.push(path);
        }
    }
    found.retain(|p| p.extension().is_some_and(|e| e == "md"));
    found.sort();
    found
}

/// The documents whose Status line is read, and which therefore owe a falsifier
/// when that line claims an absence: the numbered ADRs and `docs/protocol/`'s
/// specifications. `docs/adr/README.md` is the index, not a record, and has no
/// Status line of its own.
fn documents_that_must_declare(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    collect_files(&root.join("docs/adr"), &mut found);
    collect_files(&root.join("docs/protocol"), &mut found);
    found.retain(|p| {
        p.extension().is_some_and(|e| e == "md") && p.file_name().is_some_and(|n| n != "README.md")
    });
    found.sort();
    found
}

fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        if path.is_dir() {
            if name == "target" || name == ".git" || name == "node_modules" {
                continue;
            }
            collect_files(&path, out);
        } else if path.is_file() {
            out.push(path);
        }
    }
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

// ---------------------------------------------------------------------------
// The marker
// ---------------------------------------------------------------------------

/// One parsed `**Falsifier:**` line.
struct Falsifier {
    /// Repo-relative path of the record that wrote it.
    document: String,
    line_no: usize,
    /// `None` for the `none — <reason>` form.
    claim: Option<Claim>,
}

#[derive(Debug)]
struct Claim {
    glob: String,
    pattern: Regex,
}

/// A `**Falsifier:**` line that does not parse. Collected rather than panicked
/// on at the point of failure, so one run reports every malformed marker.
struct MalformedFalsifier {
    document: String,
    line_no: usize,
    line: String,
    why: String,
}

/// Parse every `**Falsifier:**` line in `text`.
///
/// A typo must never silently disable a check, so anything that starts with the
/// marker and does not parse is an error rather than a line skipped.
fn parse_falsifiers(
    document: &str,
    text: &str,
    ok: &mut Vec<Falsifier>,
    bad: &mut Vec<MalformedFalsifier>,
) {
    let mut in_fence = false;
    for (index, line) in text.lines().enumerate() {
        let trimmed = line.trim();
        // A marker inside a fenced code block is documentation of the marker,
        // not a declaration of one. `docs/adr/README.md`'s Conventions show the
        // grammar in a fence, and without this the index would declare a
        // falsifier over the glob `<path glob>`.
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence || !trimmed.starts_with(MARKER) {
            continue;
        }
        let line_no = index + 1;
        let rest = trimmed[MARKER.len()..].trim();
        match parse_one(rest) {
            Ok(claim) => ok.push(Falsifier {
                document: document.to_string(),
                line_no,
                claim,
            }),
            Err(why) => bad.push(MalformedFalsifier {
                document: document.to_string(),
                line_no,
                line: trimmed.to_string(),
                why,
            }),
        }
    }
}

fn parse_one(rest: &str) -> Result<Option<Claim>, String> {
    let (before_prose, prose) = rest
        .split_once('—')
        .ok_or_else(|| "no em dash (—) separating the pattern from its prose".to_string())?;
    let prose = prose.trim();
    if prose.chars().count() < MIN_PROSE {
        return Err(format!(
            "the prose after the em dash is {} characters; at least {MIN_PROSE} are required, \
             because a reader hitting this years from now needs to know what a match would mean",
            prose.chars().count()
        ));
    }

    let before_prose = before_prose.trim();
    if before_prose == "none" {
        return Ok(None);
    }

    let spans = backtick_spans(before_prose);
    if spans.len() != 2 {
        return Err(format!(
            "expected exactly two backtick-quoted spans before the em dash — a path glob and a \
             regex, joined by the word `matching` — but found {}",
            spans.len()
        ));
    }
    let joiner = between_spans(before_prose, &spans);
    if joiner.trim() != "matching" {
        return Err(format!(
            "the two backtick spans must be joined by the literal word `matching`, not {joiner:?}"
        ));
    }

    let glob = spans[0].clone();
    if glob.is_empty() || glob.starts_with('/') {
        return Err("the path glob must be a non-empty repo-relative path".to_string());
    }
    let pattern = Regex::new(&spans[1]).map_err(|e| format!("the regex does not compile: {e}"))?;
    Ok(Some(Claim { glob, pattern }))
}

/// The contents of each `` `…` `` span, in order.
fn backtick_spans(text: &str) -> Vec<String> {
    let mut spans = Vec::new();
    let mut rest = text;
    while let Some(open) = rest.find('`') {
        let after = &rest[open + 1..];
        let Some(close) = after.find('`') else {
            break;
        };
        spans.push(after[..close].to_string());
        rest = &after[close + 1..];
    }
    spans
}

/// What sits between the first and second backtick spans, so the `matching`
/// keyword can be required rather than assumed.
fn between_spans(text: &str, spans: &[String]) -> String {
    let first_end = text
        .find(&format!("`{}`", spans[0]))
        .map(|i| i + spans[0].len() + 2);
    let second_start = first_end.and_then(|from| text[from..].find('`').map(|i| from + i));
    match (first_end, second_start) {
        (Some(a), Some(b)) if b >= a => text[a..b].to_string(),
        _ => String::new(),
    }
}

// ---------------------------------------------------------------------------
// Running a falsifier
// ---------------------------------------------------------------------------

/// Files a glob selects, relative to the repository root.
///
/// Supports `**` (any run of path components, including none) and `*` (any run
/// of characters within one component). The walk starts at the glob's literal
/// prefix rather than at the repository root, which keeps it cheap and makes
/// "this glob names nothing" a detectable state rather than an empty search.
fn files_matching(root: &Path, glob: &str) -> Vec<PathBuf> {
    let components: Vec<&str> = glob.split('/').collect();
    let literal_depth = components
        .iter()
        .position(|c| c.contains('*'))
        .unwrap_or(components.len());
    let start = components[..literal_depth]
        .iter()
        .fold(root.to_path_buf(), |acc, c| acc.join(c));

    let mut candidates = Vec::new();
    if start.is_file() {
        candidates.push(start);
    } else if start.is_dir() {
        collect_files(&start, &mut candidates);
    }

    let mut selected: Vec<PathBuf> = candidates
        .into_iter()
        .filter(|path| {
            let rel = relative(root, path);
            let parts: Vec<&str> = rel.split('/').collect();
            glob_matches(&components, &parts)
        })
        .collect();
    selected.sort();
    selected
}

fn glob_matches(pattern: &[&str], path: &[&str]) -> bool {
    match pattern.first() {
        None => path.is_empty(),
        Some(&"**") => (0..=path.len()).any(|skip| glob_matches(&pattern[1..], &path[skip..])),
        Some(component) => match path.first() {
            Some(part) if component_matches(component, part) => {
                glob_matches(&pattern[1..], &path[1..])
            }
            _ => false,
        },
    }
}

fn component_matches(pattern: &str, name: &str) -> bool {
    match pattern.split_once('*') {
        None => pattern == name,
        Some((head, tail)) => {
            if !name.starts_with(head) {
                return false;
            }
            let remainder = &name[head.len()..];
            (0..=remainder.len()).any(|split| {
                remainder.is_char_boundary(split) && component_matches(tail, &remainder[split..])
            })
        }
    }
}

/// Whether a line is a comment in the language the file is written in.
///
/// Every symbol a retirement record names appears in that record, and usually
/// in a doc comment beside the code that replaced it — `connector-signer`'s
/// header still explains what `Treasury` was. Matching those would make a
/// falsifier fire on the prose written to prevent the very confusion it guards.
fn is_comment(path: &Path, line: &str) -> bool {
    let trimmed = line.trim_start();
    match path.extension().and_then(|e| e.to_str()) {
        Some("rs" | "sol" | "ts" | "js") => trimmed.starts_with("//"),
        Some("toml" | "sh" | "yml" | "yaml") => trimmed.starts_with('#'),
        _ => false,
    }
}

/// Where a falsifier fired: the file, line and text that disprove the record.
struct Disproof {
    file: String,
    line_no: usize,
    line: String,
}

fn run(root: &Path, claim: &Claim) -> (Vec<PathBuf>, Vec<Disproof>) {
    let files = files_matching(root, &claim.glob);
    let mut hits = Vec::new();
    for file in &files {
        let Ok(text) = std::fs::read_to_string(file) else {
            continue;
        };
        for (index, line) in text.lines().enumerate() {
            if is_comment(file, line) {
                continue;
            }
            if claim.pattern.is_match(line) {
                hits.push(Disproof {
                    file: relative(root, file),
                    line_no: index + 1,
                    line: line.trim().to_string(),
                });
            }
        }
    }
    (files, hits)
}

// ---------------------------------------------------------------------------
// The corpus itself
// ---------------------------------------------------------------------------

/// The records must be found, and there must be falsifiers among them.
///
/// This is the guard against the failure this whole file is written against
/// arriving one level up: a harness that cannot see the documents it checks and
/// reports `passed` in `0.00s`. There is no skip-when-unavailable branch here
/// and there must never be one (ADR 0007) — if `docs/adr/` moves, this fails
/// and somebody repoints it.
#[test]
fn the_record_corpus_is_reachable_and_annotated() {
    let root = repo_root();
    let records = documents_that_must_declare(&root);
    assert!(
        records.len() >= 50,
        "found only {} record(s) under docs/adr and docs/protocol. There are 57 ADRs and ten \
         protocol documents; a count this low means this harness is looking in the wrong place \
         and every assertion below is passing vacuously. Repoint `documents_that_must_declare`.",
        records.len()
    );

    let mut ok = Vec::new();
    let mut bad = Vec::new();
    for path in documents_scanned_for_falsifiers(&root) {
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        parse_falsifiers(&relative(&root, &path), &text, &mut ok, &mut bad);
    }
    assert!(
        !ok.is_empty(),
        "no `{MARKER}` line exists anywhere under docs/. Either every absence claim was resolved \
         in the same change (in which case delete this harness deliberately, with a record saying \
         so), or the marker was renamed and this gate is now checking nothing."
    );
    println!("{} falsifier(s) declared across the records", ok.len());
}

/// A malformed marker is a disabled check wearing the costume of a live one.
#[test]
fn every_falsifier_line_parses() {
    let root = repo_root();
    let mut ok = Vec::new();
    let mut bad = Vec::new();
    for path in documents_scanned_for_falsifiers(&root) {
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        parse_falsifiers(&relative(&root, &path), &text, &mut ok, &mut bad);
    }

    if !bad.is_empty() {
        let detail = bad
            .iter()
            .map(|b| {
                format!(
                    "\n  {}:{} — {}\n    line: {}",
                    b.document, b.line_no, b.why, b.line
                )
            })
            .collect::<String>();
        panic!(
            "{} `{MARKER}` line(s) do not parse, so the claims they were written to check are not \
             being checked:{detail}\n\nThe two accepted forms, each on one line, are:\n  \
             {MARKER} `<path glob>` matching `<regex>` — <what a match would mean>\n  \
             {MARKER} none — <why this claim cannot be checked mechanically>",
            bad.len()
        );
    }
}

/// Every declared falsifier still fails to fire.
///
/// This is the gate. A record says "no file matching this glob contains a line
/// matching this regex"; if one does, the record is describing a tree that has
/// moved beneath it, and the fix is to correct the record — never to weaken the
/// pattern until it stops matching.
#[test]
fn every_falsifier_still_holds() {
    let root = repo_root();
    let mut ok = Vec::new();
    let mut bad = Vec::new();
    for path in documents_scanned_for_falsifiers(&root) {
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        parse_falsifiers(&relative(&root, &path), &text, &mut ok, &mut bad);
    }

    let mut failures = String::new();
    for falsifier in &ok {
        let Some(claim) = &falsifier.claim else {
            continue;
        };
        let (_, hits) = run(&root, claim);
        if hits.is_empty() {
            continue;
        }
        failures.push_str(&format!(
            "\n\n  {}:{}\n    claims nothing under `{}` matches `{}`.\n    It does:",
            falsifier.document, falsifier.line_no, claim.glob, claim.pattern
        ));
        for hit in hits.iter().take(5) {
            failures.push_str(&format!(
                "\n      {}:{}  {}",
                hit.file, hit.line_no, hit.line
            ));
        }
        if hits.len() > 5 {
            failures.push_str(&format!("\n      … and {} more", hits.len() - 5));
        }
    }

    assert!(
        failures.is_empty(),
        "A record's own falsifier fired. The record describes a tree that no longer \
         exists:{failures}\n\nWhat to do: read the record named above and correct it. Its Status \
         line may be edited directly and so may its row in docs/adr/README.md; a change to what a \
         record *decided* is appended under an `## Update (issue #NNN)` heading, never rewritten \
         into the decision (docs/adr/README.md, Conventions). Then delete or narrow the falsifier \
         line to match what is still absent. Do NOT loosen the regex until it stops matching — \
         that suppresses the finding and leaves the record wrong."
    );
}

/// A falsifier whose glob names nothing is a check that can never fire.
///
/// The likeliest way to get one is a path typo, and it is silent: the file list
/// is empty, no line matches, the assertion above passes forever. So an empty
/// selection is a failure in its own right.
#[test]
fn every_falsifier_glob_names_at_least_one_file() {
    let root = repo_root();
    let mut ok = Vec::new();
    let mut bad = Vec::new();
    for path in documents_scanned_for_falsifiers(&root) {
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        parse_falsifiers(&relative(&root, &path), &text, &mut ok, &mut bad);
    }

    let mut empty = String::new();
    for falsifier in &ok {
        let Some(claim) = &falsifier.claim else {
            continue;
        };
        let (files, _) = run(&root, claim);
        if files.is_empty() {
            empty.push_str(&format!(
                "\n  {}:{} — glob `{}` selects no file",
                falsifier.document, falsifier.line_no, claim.glob
            ));
        }
    }

    assert!(
        empty.is_empty(),
        "A falsifier's path glob names nothing, so it can never fire and the claim it was written \
         to check is unchecked:{empty}\n\nEither the path is a typo, or the file it named was \
         moved or deleted — in which case the record above almost certainly needs re-reading too, \
         since it is reasoning about a file that is gone. Globs are repo-relative and support \
         `**` for any run of directories and `*` within one component."
    );
}

/// A Status line that claims an absence must say what would prove it wrong.
///
/// This is the half that makes the gate durable rather than a one-off sweep: a
/// *new* record cannot land claiming "not yet built" without writing down its
/// own falsifier, so the next stale record announces itself instead of waiting
/// to be found by hand.
#[test]
fn an_absence_claim_in_a_status_line_carries_a_falsifier() {
    let root = repo_root();
    let mut missing: BTreeSet<String> = BTreeSet::new();

    for path in documents_that_must_declare(&root) {
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Some(status) = status_block(&text) else {
            continue;
        };
        let normalized = normalize(&status);
        let Some(phrase) = ABSENCE_PHRASES
            .iter()
            .find(|p| normalized.contains(**p))
            .copied()
        else {
            continue;
        };
        let mut declared = Vec::new();
        let mut malformed = Vec::new();
        parse_falsifiers(
            &relative(&root, &path),
            &text,
            &mut declared,
            &mut malformed,
        );
        // A malformed marker counts as declared here on purpose: it is
        // `every_falsifier_line_parses`'s failure to report, and two harnesses
        // shouting about one typo says less than one that names it.
        if !declared.is_empty() || !malformed.is_empty() {
            continue;
        }
        missing.insert(format!(
            "\n  {} — its Status line says \"{phrase}\"",
            relative(&root, &path)
        ));
    }

    assert!(
        missing.is_empty(),
        "A record's Status line claims something is absent from this tree, and the record does \
         not say what would prove that wrong:{}\n\nAdd a line directly beneath the record's \
         `**Scope:**` line:\n\n  {MARKER} `<path glob>` matching `<regex>` — <what a match would \
         mean>\n\nIt asserts that no file matching the glob contains a line matching the regex, \
         and `crates/connector-bin/tests/records_state_their_own_falsifier.rs` runs it on every \
         `cargo test`. Pick a pattern the implementation cannot avoid — the config field it must \
         add, the route it must register — rather than one that merely sounds like it. If the \
         claim genuinely cannot be checked against the tree (it is about a protocol's meaning, or \
         about another repository), say so in the same place:\n\n  {MARKER} none — <why>",
        missing.into_iter().collect::<String>()
    );
}

/// A record's Status block: the `**Status:**` line and any continuation lines,
/// up to the first blank line. Fixed by convention at the top of every record
/// (`docs/adr/README.md`), which is what makes reading it structural rather
/// than a guess at prose.
fn status_block(text: &str) -> Option<String> {
    let mut lines = text
        .lines()
        .skip_while(|l| !l.trim_start().starts_with("**Status:**"));
    let first = lines.next()?;
    let mut block = String::from(first);
    for line in lines {
        if line.trim().is_empty() {
            break;
        }
        block.push(' ');
        block.push_str(line);
    }
    Some(block)
}

/// Markdown emphasis removed, case folded, whitespace collapsed — so
/// `**not yet built**`, `not yet **built**` and a phrase wrapped across two
/// source lines all read the same to the phrase match.
fn normalize(text: &str) -> String {
    let stripped: String = text
        .chars()
        .filter(|c| *c != '*' && *c != '_')
        .flat_map(|c| c.to_lowercase())
        .collect();
    stripped.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod marker_grammar {
    //! The parser's own contract. A marker that silently fails to parse is the
    //! one way this harness could report `ok` while checking nothing, so the
    //! shapes it accepts and rejects are pinned here rather than assumed.
    //!
    //! The example identifier is the nonsense word `Phlogiston` rather than a
    //! real retired symbol, because this file is itself inside
    //! `crates/**/*.rs`: writing `Treasury` here as a sample pattern fired ADR
    //! 0012's own falsifier against the harness that runs it. Whatever is used
    //! as an example below must be a name no record will ever claim is absent.

    use super::*;

    const PROSE: &str = "— this prose is deliberately long enough to satisfy the minimum";

    #[test]
    fn the_two_span_form_parses() {
        let claim = parse_one(&format!(
            "`crates/**/*.rs` matching `\\bPhlogiston\\b` {PROSE}"
        ))
        .expect("well-formed")
        .expect("not the none form");
        assert_eq!(claim.glob, "crates/**/*.rs");
        assert!(claim.pattern.is_match("let t: Phlogiston = ..."));
    }

    #[test]
    fn the_none_form_parses() {
        assert!(parse_one(&format!("none {PROSE}"))
            .expect("well-formed")
            .is_none());
    }

    #[test]
    fn a_missing_joiner_is_rejected() {
        // `in` rather than `matching`: close enough to write by accident, and
        // it must not parse into something that quietly checks nothing.
        let err = parse_one(&format!("`crates/**/*.rs` in `\\bPhlogiston\\b` {PROSE}"))
            .expect_err("must not parse");
        assert!(err.contains("matching"), "{err}");
    }

    #[test]
    fn an_uncompilable_regex_is_rejected() {
        let err = parse_one(&format!("`crates/**/*.rs` matching `[unclosed` {PROSE}"))
            .expect_err("must not parse");
        assert!(err.contains("does not compile"), "{err}");
    }

    #[test]
    fn prose_is_required() {
        let err = parse_one("`crates/**/*.rs` matching `x` — short").expect_err("must not parse");
        assert!(err.contains("characters"), "{err}");
        let err = parse_one("`crates/**/*.rs` matching `x`").expect_err("must not parse");
        assert!(err.contains("em dash"), "{err}");
    }

    #[test]
    fn a_fenced_example_is_not_a_declaration() {
        let doc = format!(
            "# T\n\n```\n{MARKER} `<path glob>` matching `<regex>` {PROSE}\n```\n\n             {MARKER} `crates/**/*.rs` matching `\\bPhlogiston\\b` {PROSE}\n"
        );
        let mut ok = Vec::new();
        let mut bad = Vec::new();
        parse_falsifiers("docs/adr/README.md", &doc, &mut ok, &mut bad);
        assert!(
            bad.is_empty(),
            "the fenced example must not be parsed at all"
        );
        assert_eq!(ok.len(), 1, "only the unfenced line declares a falsifier");
        assert_eq!(
            ok[0].claim.as_ref().expect("not the none form").glob,
            "crates/**/*.rs"
        );
    }

    #[test]
    fn a_glob_walks_directories_and_a_star_matches_within_one() {
        assert!(glob_matches(
            &["crates", "**", "*.rs"],
            &["crates", "connector-config", "src", "route.rs"]
        ));
        assert!(glob_matches(&["crates", "**", "*.rs"], &["crates", "a.rs"]));
        assert!(!glob_matches(
            &["crates", "**", "*.rs"],
            &["docs", "adr", "a.rs"]
        ));
        assert!(!glob_matches(
            &["crates", "**", "*.rs"],
            &["crates", "a.toml"]
        ));
    }

    #[test]
    fn an_attribute_line_is_not_a_comment_but_a_doc_line_is() {
        let rs = Path::new("a.rs");
        assert!(is_comment(rs, "//! `Phlogiston` was deleted"));
        assert!(is_comment(rs, "    // Phlogiston"));
        assert!(!is_comment(rs, "#[serde(rename = \"description\")]"));
        let toml = Path::new("a.toml");
        assert!(is_comment(toml, "# [[peers]]"));
        assert!(!is_comment(toml, "[[peers]]"));
    }

    #[test]
    fn a_status_phrase_is_found_through_emphasis_and_line_wrapping() {
        let block =
            status_block("# T\n\n**Status:** Accepted, **partly not yet\nbuilt** — x.\n\nbody")
                .expect("a status line");
        let normalized = normalize(&block);
        assert!(
            ABSENCE_PHRASES.iter().any(|p| normalized.contains(p)),
            "{normalized}"
        );
    }
}

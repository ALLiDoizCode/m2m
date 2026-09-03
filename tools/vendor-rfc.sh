#!/usr/bin/env bash
#
# Re-vendor one Interledger RFC into docs/rfcs/, preserving its TOON profile.
#
# ADR 0062 keeps a vendored RFC in two halves: a preface this project writes,
# and upstream's body, unmodified, below a marker line. Swapping the body by
# hand is how a preface gets clobbered and how a digest gets updated to match
# whatever happens to be in the file. This script does the mechanical half:
# fetch, splice below the marker, rewrite the pinned commit and the digest,
# leave everything above the marker exactly as it was.
#
#   tools/vendor-rfc.sh 0027-interledger-protocol-4 <40-char-commit>
#
# With no commit it uses the pin already recorded in the file, which makes it
# a repair tool as well: it restores a body somebody edited.
#
# Adding an RFC that is not vendored yet is NOT this script's job -- that needs
# a TOON profile written first, and ADR 0062 D4 makes it a decision rather than
# a fetch. Write the preface (see any existing copy for the shape), end it with
# the marker line, put a placeholder digest on the `**Body SHA-256:**` line,
# then run this.
#
# Afterwards, `cargo test -p connector --test vendored_rfcs_are_unmodified`.

set -euo pipefail

readonly MARKER='<!-- BEGIN VERBATIM UPSTREAM BODY -->'
readonly UPSTREAM_REPO='interledger/rfcs'

slug="${1:-}"
if [[ -z $slug ]]; then
    echo "usage: $0 <rfc-slug> [commit-sha]" >&2
    echo "  e.g. $0 0027-interledger-protocol-4" >&2
    exit 2
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="$repo_root/docs/rfcs/$slug/$slug.md"

if [[ ! -f $target ]]; then
    echo "no vendored copy at docs/rfcs/$slug/$slug.md" >&2
    echo "ADR 0062 D4: vendoring a new RFC starts with writing its TOON profile, not with a fetch." >&2
    exit 1
fi

marker_line="$(grep -n -F -x "$MARKER" "$target" | cut -d: -f1)"
if [[ -z $marker_line ]]; then
    echo "docs/rfcs/$slug/$slug.md has no verbatim-body marker line" >&2
    exit 1
fi

commit="${2:-}"
if [[ -z $commit ]]; then
    commit="$(sed -n 's/.*\*\*Pinned commit:\*\* *`\([0-9a-f]\{40\}\)`.*/\1/p' "$target" | head -1)"
    if [[ -z $commit ]]; then
        echo "docs/rfcs/$slug/$slug.md records no 40-character pinned commit, and none was given" >&2
        exit 1
    fi
    echo "re-fetching at the recorded pin $commit"
fi

if [[ ! $commit =~ ^[0-9a-f]{40}$ ]]; then
    echo "'$commit' is not a 40-character commit sha. A branch name is not a pin (ADR 0062 D1)." >&2
    exit 1
fi

body="$(mktemp)"
preface="$(mktemp)"
trap 'rm -f "$body" "$preface"' EXIT

url="https://raw.githubusercontent.com/$UPSTREAM_REPO/$commit/$slug/$slug.md"
curl -sSfL "$url" -o "$body"

# The preface is everything up to and including the marker line, plus a blank
# line. The blank line is load-bearing: the RFC bodies open with `---` YAML
# front matter, and a text line directly above `---` is a SETEXT HEADING in
# markdown. Without the separator, every markdown tool reads the marker as an
# `<h2>` -- prettier rewrote it to `## <!-- ... -->` in this repository once,
# which broke both this script and the digest. The blank line sits ABOVE the
# hashed region, so the recorded digest is still upstream's own file digest.
{ head -n "$marker_line" "$target"; echo; } >"$preface"

digest="$(sha256sum "$body" | cut -d' ' -f1)"

sed -i \
    -e "s|\(\*\*Pinned commit:\*\* *\)\`[^\`]*\`|\1\`$commit\`|" \
    -e "s|\(\*\*Body SHA-256:\*\* *\)\`[^\`]*\`|\1\`$digest\`|" \
    "$preface"

cat "$preface" "$body" >"$target"

echo "docs/rfcs/$slug/$slug.md"
echo "  upstream $url"
echo "  commit   $commit"
echo "  sha256   $digest"
echo "  bytes    $(wc -c <"$body")"
echo
echo "The preface above the marker was preserved. If the pinned commit moved, read the"
echo "diff before committing -- ADR 0062 D1 makes a changed upstream a thing a person reads."

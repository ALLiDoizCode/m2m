//! Pure route selection: given a destination and a set of route prefixes,
//! decide which one (if any) governs it. No I/O, no knowledge of what a
//! route's payload is -- callers pair the returned index back up with
//! whatever they store alongside each prefix.

/// A route with prefix `p` governs `destination` when `destination` is
/// exactly `p`, or starts with `p` followed by a dot (RFC-0015 addresses
/// are dot-separated labels, so `g.example` must not match `g.exampleX`).
fn matches(prefix: &str, destination: &str) -> bool {
    destination == prefix || destination.starts_with(&format!("{prefix}."))
}

/// Select the most specific (longest-prefix) route governing `destination`,
/// or `None` if no `prefixes` entry governs it.
pub fn select_route(destination: &str, prefixes: &[&str]) -> Option<usize> {
    prefixes
        .iter()
        .enumerate()
        .filter(|(_, prefix)| matches(prefix, destination))
        .max_by_key(|(_, prefix)| prefix.len())
        .map(|(index, _)| index)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selects_the_only_matching_route() {
        let prefixes = ["g.example.app"];
        assert_eq!(select_route("g.example.app", &prefixes), Some(0));
    }

    #[test]
    fn selects_a_route_for_a_deeper_destination() {
        let prefixes = ["g.example.app"];
        assert_eq!(select_route("g.example.app.sub", &prefixes), Some(0));
    }

    #[test]
    fn does_not_match_a_sibling_label_sharing_a_prefix() {
        let prefixes = ["g.example.app"];
        assert_eq!(select_route("g.example.appendix", &prefixes), None);
    }

    #[test]
    fn returns_none_when_nothing_matches() {
        let prefixes = ["g.example.app"];
        assert_eq!(select_route("g.other", &prefixes), None);
    }

    #[test]
    fn prefers_the_longest_matching_prefix() {
        let prefixes = ["g.example", "g.example.app"];
        assert_eq!(select_route("g.example.app.sub", &prefixes), Some(1));
    }

    #[test]
    fn returns_none_for_an_empty_route_table() {
        let prefixes: [&str; 0] = [];
        assert_eq!(select_route("g.example.app", &prefixes), None);
    }
}

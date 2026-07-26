//! ILP address validation per RFC-0015.

/// Maximum length of an ILP address, per RFC-0015.
const MAX_ILP_ADDRESS_LEN: usize = 1023;

fn is_valid_label(label: &str) -> bool {
    !label.is_empty()
        && label
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// An ILP address is one or more valid labels joined by dots -- no leading,
/// trailing, or consecutive dots, and no characters outside the label set.
/// The empty string is a special case, valid only as a REJECT's
/// `triggered_by` (RFC-0027 permits an empty `triggeredBy`).
pub fn is_valid_ilp_address(address: &str) -> bool {
    !address.is_empty()
        && address.len() <= MAX_ILP_ADDRESS_LEN
        && address.split('.').all(is_valid_label)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_single_label() {
        assert!(is_valid_ilp_address("g"));
    }

    #[test]
    fn accepts_a_multi_label_address() {
        assert!(is_valid_ilp_address("g.example.app-1"));
    }

    #[test]
    fn rejects_empty() {
        assert!(!is_valid_ilp_address(""));
    }

    #[test]
    fn rejects_consecutive_dots() {
        assert!(!is_valid_ilp_address("g..app"));
    }

    #[test]
    fn rejects_leading_and_trailing_dots() {
        assert!(!is_valid_ilp_address(".g.app"));
        assert!(!is_valid_ilp_address("g.app."));
    }

    #[test]
    fn rejects_disallowed_characters() {
        assert!(!is_valid_ilp_address("g.app!"));
    }

    #[test]
    fn rejects_addresses_over_the_max_length() {
        let long = format!("g.{}", "a".repeat(MAX_ILP_ADDRESS_LEN));
        assert!(!is_valid_ilp_address(&long));
    }
}

use sha3::{Digest, Keccak256};

use crate::signer::PublicKeyBytes;

/// A 20-byte EVM account address.
pub type Address = [u8; 20];

/// Derive the EVM address for an uncompressed secp256k1 public key: the
/// low 20 bytes of the Keccak-256 hash of the 64-byte X||Y coordinates
/// (the `0x04` prefix is not part of the hash input).
pub fn derive_evm_address(public_key: &PublicKeyBytes) -> Address {
    let mut hasher = Keccak256::new();
    hasher.update(&public_key[1..]);
    let hash = hasher.finalize();

    let mut address = [0u8; 20];
    address.copy_from_slice(&hash[12..]);
    address
}

/// Render an address in `0x`-prefixed lowercase hex, matching how EVM
/// tooling prints one (no EIP-55 checksum casing).
pub fn to_hex(address: &Address) -> String {
    let mut out = String::with_capacity(42);
    out.push_str("0x");
    for byte in address {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::LocalSigner;
    use crate::Signer;

    #[test]
    fn address_is_twenty_bytes_and_hex_prefixed() {
        let signer = LocalSigner::generate("evm-claim-key");
        let public_key = signer.public_key().expect("public key");
        let address = derive_evm_address(&public_key);
        let hex = to_hex(&address);
        assert_eq!(hex.len(), 42);
        assert!(hex.starts_with("0x"));
    }

    #[test]
    fn rotating_the_signer_changes_the_derived_address() {
        let signer = LocalSigner::generate("evm-claim-key");
        let before = derive_evm_address(&signer.public_key().expect("public key"));
        signer.rotate().expect("rotate");
        let after = derive_evm_address(&signer.public_key().expect("public key"));
        assert_ne!(before, after);
    }
}

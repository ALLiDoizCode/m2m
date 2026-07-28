//! OER (Octet Encoding Rules) primitives per RFC-0030, ported byte-for-byte
//! from the existing TypeScript implementation
//! (`packages/shared/src/encoding/oer.ts`) so the Rust and TypeScript fleets
//! agree on the wire.

use chrono::{DateTime, Datelike, TimeZone, Timelike, Utc};

use crate::error::PacketError;

/// Encode a VarUInt: 0-127 as a single byte, 128+ as a length-prefixed
/// big-endian value (RFC-0030).
pub(crate) fn encode_var_uint(value: u64) -> Vec<u8> {
    if value <= 127 {
        return vec![value as u8];
    }
    let mut bytes = Vec::new();
    let mut remaining = value;
    while remaining > 0 {
        bytes.insert(0, (remaining & 0xff) as u8);
        remaining >>= 8;
    }
    let mut out = Vec::with_capacity(1 + bytes.len());
    out.push(0x80 | bytes.len() as u8);
    out.extend(bytes);
    out
}

/// Decode a VarUInt, returning the value and the number of bytes consumed.
///
/// Canonical only: a length determinant is rejected unless the bytes it
/// introduces are exactly what [`encode_var_uint`] would produce for the
/// value decoded from them (issue #546) -- so a non-minimal long form
/// (`0x81 0x03` for the value `3`), a zero-length long form aliasing `0x00`
/// (`0x80`), and a determinant wider than 8 bytes (which cannot fit a
/// `u64` without silently discarding high-order bytes) are all refused
/// rather than accepted as a synonym for some other, shorter encoding.
pub(crate) fn decode_var_uint(buf: &[u8], offset: usize) -> Result<(u64, usize), PacketError> {
    let first = *buf.get(offset).ok_or(PacketError::BufferUnderflow)?;
    if first <= 127 {
        return Ok((first as u64, 1));
    }
    let length = (first & 0x7f) as usize;
    if length > 8 {
        return Err(PacketError::LengthDeterminantOverflow);
    }
    let start = offset + 1;
    let end = start + length;
    if end > buf.len() {
        return Err(PacketError::BufferUnderflow);
    }
    let mut value: u64 = 0;
    for &byte in &buf[start..end] {
        value = (value << 8) | byte as u64;
    }
    let consumed = 1 + length;
    if encode_var_uint(value) != buf[offset..offset + consumed] {
        return Err(PacketError::NonCanonicalLength);
    }
    Ok((value, consumed))
}

/// Encode a VarOctetString: a VarUInt length prefix followed by the bytes.
pub(crate) fn encode_var_octet_string(data: &[u8]) -> Vec<u8> {
    let mut out = encode_var_uint(data.len() as u64);
    out.extend_from_slice(data);
    out
}

/// Decode a VarOctetString, returning the bytes and the number consumed.
pub(crate) fn decode_var_octet_string(
    buf: &[u8],
    offset: usize,
) -> Result<(Vec<u8>, usize), PacketError> {
    let (length, length_bytes) = decode_var_uint(buf, offset)?;
    let start = offset + length_bytes;
    let end = start
        .checked_add(length as usize)
        .ok_or(PacketError::BufferUnderflow)?;
    if end > buf.len() {
        return Err(PacketError::BufferUnderflow);
    }
    Ok((buf[start..end].to_vec(), length_bytes + length as usize))
}

/// Decode a fixed-length octet string (no length prefix).
pub(crate) fn decode_fixed_octet_string(
    buf: &[u8],
    offset: usize,
    length: usize,
) -> Result<([u8; 32], usize), PacketError> {
    debug_assert_eq!(length, 32);
    let end = offset + length;
    if end > buf.len() {
        return Err(PacketError::BufferUnderflow);
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&buf[offset..end]);
    Ok((out, length))
}

/// Encode a `DateTime<Utc>` as ASN.1 GeneralizedTime: `YYYYMMDDHHMMSS.fffZ`
/// (19 bytes, matching `encodeGeneralizedTime` in the TypeScript encoder).
pub(crate) fn encode_generalized_time(when: DateTime<Utc>) -> Vec<u8> {
    format!(
        "{:04}{:02}{:02}{:02}{:02}{:02}.{:03}Z",
        when.year(),
        when.month(),
        when.day(),
        when.hour(),
        when.minute(),
        when.second(),
        when.timestamp_subsec_millis()
    )
    .into_bytes()
}

/// Decode a 19-byte ASN.1 GeneralizedTime string into a `DateTime<Utc>`.
pub(crate) fn decode_generalized_time(
    buf: &[u8],
    offset: usize,
) -> Result<(DateTime<Utc>, usize), PacketError> {
    const LEN: usize = 19;
    let end = offset + LEN;
    if end > buf.len() {
        return Err(PacketError::BufferUnderflow);
    }
    let text = std::str::from_utf8(&buf[offset..end]).map_err(|_| PacketError::InvalidTime)?;
    let (date, rest) = text.split_at(14);
    if !rest.starts_with('.') || !rest.ends_with('Z') || date.len() != 14 {
        return Err(PacketError::InvalidTime);
    }
    let millis: &str = &rest[1..rest.len() - 1];
    let year: i32 = date[0..4].parse().map_err(|_| PacketError::InvalidTime)?;
    let month: u32 = date[4..6].parse().map_err(|_| PacketError::InvalidTime)?;
    let day: u32 = date[6..8].parse().map_err(|_| PacketError::InvalidTime)?;
    let hour: u32 = date[8..10].parse().map_err(|_| PacketError::InvalidTime)?;
    let minute: u32 = date[10..12].parse().map_err(|_| PacketError::InvalidTime)?;
    let second: u32 = date[12..14].parse().map_err(|_| PacketError::InvalidTime)?;
    let milli: u32 = millis.parse().map_err(|_| PacketError::InvalidTime)?;

    let when = Utc
        .with_ymd_and_hms(year, month, day, hour, minute, second)
        .single()
        .ok_or(PacketError::InvalidTime)?
        + chrono::Duration::milliseconds(milli as i64);

    Ok((when, LEN))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn var_uint_round_trips_boundary_values() {
        for value in [0u64, 1, 127, 128, 255, 256, 65535, 65536, u64::MAX] {
            let encoded = encode_var_uint(value);
            let (decoded, consumed) = decode_var_uint(&encoded, 0).expect("decode");
            assert_eq!(decoded, value);
            assert_eq!(consumed, encoded.len());
        }
    }

    #[test]
    fn var_uint_matches_documented_encoding() {
        assert_eq!(encode_var_uint(0), vec![0x00]);
        assert_eq!(encode_var_uint(127), vec![0x7f]);
        assert_eq!(encode_var_uint(128), vec![0x81, 0x80]);
        assert_eq!(encode_var_uint(255), vec![0x81, 0xff]);
    }

    #[test]
    fn var_octet_string_round_trips() {
        for data in [&b""[..], &b"hello"[..], &vec![0x42; 500][..]] {
            let encoded = encode_var_octet_string(data);
            let (decoded, consumed) = decode_var_octet_string(&encoded, 0).expect("decode");
            assert_eq!(decoded, data);
            assert_eq!(consumed, encoded.len());
        }
    }

    #[test]
    fn generalized_time_round_trips() {
        let when = Utc.with_ymd_and_hms(2025, 1, 31, 23, 59, 59).unwrap()
            + chrono::Duration::milliseconds(999);
        let encoded = encode_generalized_time(when);
        assert_eq!(encoded.len(), 19);
        assert_eq!(
            std::str::from_utf8(&encoded).unwrap(),
            "20250131235959.999Z"
        );
        let (decoded, consumed) = decode_generalized_time(&encoded, 0).expect("decode");
        assert_eq!(decoded, when);
        assert_eq!(consumed, 19);
    }

    #[test]
    fn var_uint_decode_rejects_buffer_underflow() {
        assert!(matches!(
            decode_var_uint(&[0x81], 0),
            Err(PacketError::BufferUnderflow)
        ));
    }

    #[test]
    fn var_uint_decode_rejects_non_minimal_long_form() {
        // 0x81 0x03 is a long-form encoding of 3, which canonically fits in
        // the single short-form byte 0x03.
        assert!(matches!(
            decode_var_uint(&[0x81, 0x03], 0),
            Err(PacketError::NonCanonicalLength)
        ));
    }

    #[test]
    fn var_uint_decode_rejects_zero_length_long_form_as_an_alias_for_zero() {
        // 0x80 declares a zero-byte determinant, decoding to 0 -- the same
        // value the canonical short form 0x00 already encodes.
        assert!(matches!(
            decode_var_uint(&[0x80], 0),
            Err(PacketError::NonCanonicalLength)
        ));
    }

    #[test]
    fn var_uint_decode_rejects_a_determinant_wider_than_8_bytes() {
        // 0x89 declares a 9-byte determinant -- one byte more than a u64
        // can hold, and the previous behavior silently truncated it.
        let encoded = [0x89, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03];
        assert!(matches!(
            decode_var_uint(&encoded, 0),
            Err(PacketError::LengthDeterminantOverflow)
        ));
    }

    #[test]
    fn var_uint_decode_accepts_the_widest_canonical_determinant() {
        let encoded = encode_var_uint(u64::MAX);
        assert_eq!(encoded.len(), 9); // 1 type byte + 8 content bytes
        let (value, consumed) = decode_var_uint(&encoded, 0).expect("decode");
        assert_eq!(value, u64::MAX);
        assert_eq!(consumed, encoded.len());
    }

    proptest::proptest! {
        /// The missing property issue #546 names: every byte sequence
        /// `decode_var_uint` accepts must re-encode to exactly itself --
        /// not merely to a value that decodes back to the same number.
        #[test]
        fn var_uint_decode_accepts_only_canonical_bytes(value in proptest::prelude::any::<u64>()) {
            let encoded = encode_var_uint(value);
            let (decoded, consumed) = decode_var_uint(&encoded, 0).expect("decode");
            proptest::prop_assert_eq!(decoded, value);
            proptest::prop_assert_eq!(consumed, encoded.len());
            proptest::prop_assert_eq!(encode_var_uint(decoded), encoded);
        }

        /// Decoding must never panic on arbitrary bytes.
        #[test]
        fn var_uint_decode_never_panics_on_arbitrary_bytes(
            bytes in proptest::collection::vec(proptest::prelude::any::<u8>(), 0..16)
        ) {
            let _ = decode_var_uint(&bytes, 0);
        }
    }
}

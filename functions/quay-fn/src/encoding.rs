//! Hex, base58, base64 and sha256 helpers.
use base64::Engine as _;
use sha2::{Digest, Sha256};

pub fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&sha256(bytes))
}

pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[(b >> 4) as usize] as char);
        out.push(DIGITS[(b & 15) as usize] as char);
    }
    out
}

pub fn hex_decode(text: &str) -> Result<Vec<u8>, String> {
    if text.len() % 2 != 0 {
        return Err("odd hex length".into());
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).map_err(|_| "bad hex".to_string()))
        .collect()
}

pub fn b58(bytes: &[u8]) -> String {
    bs58::encode(bytes).into_string()
}

pub fn b58_decode(text: &str) -> Result<Vec<u8>, String> {
    bs58::decode(text).into_vec().map_err(|_| "bad base58".to_string())
}

pub fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Standard or URL-safe base64, with or without padding.
pub fn b64_decode(text: &str) -> Result<Vec<u8>, String> {
    let clean: String = text
        .trim()
        .chars()
        .map(|c| match c {
            '-' => '+',
            '_' => '/',
            c => c,
        })
        .filter(|c| *c != '=')
        .collect();
    base64::engine::general_purpose::STANDARD_NO_PAD
        .decode(clean.as_bytes())
        .map_err(|_| "bad base64".to_string())
}

/// `ed25519:<base58>` → 32 bytes.
pub fn parse_public_key(text: &str) -> Result<[u8; 32], String> {
    let body = text
        .strip_prefix("ed25519:")
        .ok_or("only ed25519 keys are supported")?;
    let bytes = b58_decode(body)?;
    bytes
        .try_into()
        .map_err(|_| "public key must be 32 bytes".to_string())
}

pub fn format_public_key(bytes: &[u8; 32]) -> String {
    format!("ed25519:{}", b58(bytes))
}

/// `ed25519:<base58 of 64 bytes>` (NEAR's secret key form) or a 32-byte seed → seed.
pub fn parse_secret_key(text: &str) -> Result<[u8; 32], String> {
    let body = text
        .trim()
        .strip_prefix("ed25519:")
        .ok_or("only ed25519 keys are supported")?;
    let bytes = b58_decode(body).map_err(|_| "secret key is not base58".to_string())?;
    match bytes.len() {
        64 | 32 => Ok(bytes[..32].try_into().expect("32 bytes")),
        _ => Err("secret key must be 32 or 64 bytes".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_of_abc() {
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn base64_variants_decode() {
        assert_eq!(b64_decode("aGk=").unwrap(), b"hi");
        assert_eq!(b64_decode("aGk").unwrap(), b"hi");
        assert_eq!(b64_decode("-_8").unwrap(), vec![0xfb, 0xff]);
        assert_eq!(b64(b"hi"), "aGk=");
    }

    #[test]
    fn hex_roundtrip() {
        assert_eq!(hex_decode(&hex(&[0, 1, 254, 255])).unwrap(), vec![0, 1, 254, 255]);
        assert!(hex_decode("abc").is_err());
    }

    #[test]
    fn public_key_roundtrip() {
        let pk = [7u8; 32];
        assert_eq!(parse_public_key(&format_public_key(&pk)).unwrap(), pk);
        assert!(parse_public_key("secp256k1:abc").is_err());
    }
}

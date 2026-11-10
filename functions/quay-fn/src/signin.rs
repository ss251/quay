//! ed25519 keys and NEP-413 sign-in verification. Mirrors `client/src/verify.mjs`:
//! same checks, same order, same failure reasons.
use crate::borsh::Writer;
use crate::encoding::{b64_decode, parse_public_key, sha256};
use crate::rpc::{is_full_access, Rpc};
use crate::Value;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};

/// 2^31 + 413, the NEP-413 prefix tag.
pub const NEP413_TAG: u32 = 2_147_484_061;
const SKEW_MS: u64 = 60_000;

pub fn public_key_of(seed: &[u8; 32]) -> [u8; 32] {
    SigningKey::from_bytes(seed).verifying_key().to_bytes()
}

pub fn sign(seed: &[u8; 32], message: &[u8]) -> [u8; 64] {
    SigningKey::from_bytes(seed).sign(message).to_bytes()
}

pub fn verify(public_key: &[u8; 32], message: &[u8], signature: &[u8; 64]) -> bool {
    match VerifyingKey::from_bytes(public_key) {
        Ok(key) => key.verify(message, &Signature::from_bytes(signature)).is_ok(),
        Err(_) => false,
    }
}

/// `borsh_u32(NEP413_TAG) || borsh{message, nonce[32], recipient, callbackUrl: Option<String>}`.
pub fn nep413_payload(message: &str, nonce: &[u8; 32], recipient: &str, callback_url: Option<&str>) -> Vec<u8> {
    Writer::new()
        .u32(NEP413_TAG)
        .str(message)
        .raw(nonce)
        .str(recipient)
        .opt_str(callback_url)
        .finish()
}

pub fn nep413_hash(message: &str, nonce: &[u8; 32], recipient: &str, callback_url: Option<&str>) -> [u8; 32] {
    sha256(&nep413_payload(message, nonce, recipient, callback_url))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignIn {
    pub account_id: String,
    pub public_key: String,
    pub issued_at: u64,
}

pub struct Options<'a> {
    /// Expected `recipient`: the site account.
    pub site: &'a str,
    pub max_age_ms: u64,
    pub now_ms: u64,
}

impl<'a> Options<'a> {
    pub fn new(site: &'a str) -> Self {
        Self { site, max_age_ms: 5 * 60_000, now_ms: crate::now_ms() }
    }
}

/// Every check that needs no network: fields, recipient, encodings, signature, timestamp.
/// `proof` = `{ accountId, publicKey, signature, message, nonce, recipient }` (base64 signature and nonce).
pub fn check_proof(proof: &Value, opts: &Options) -> Result<SignIn, String> {
    if !proof.is_object() {
        return Err("missing proof".into());
    }
    let field = |k: &str| -> Result<&str, String> {
        match proof.get(k).and_then(Value::as_str) {
            Some(v) if !v.is_empty() => Ok(v),
            _ => Err(format!("missing {k}")),
        }
    };
    let account_id = field("accountId")?;
    let public_key = field("publicKey")?;
    let signature = field("signature")?;
    let message = field("message")?;
    let nonce = field("nonce")?;
    let recipient = field("recipient")?;

    if recipient != opts.site {
        return Err("wrong recipient".into());
    }
    let (sig, nonce) = match (b64_decode(signature), b64_decode(nonce)) {
        (Ok(s), Ok(n)) => (s, n),
        _ => return Err("malformed encoding".into()),
    };
    let sig: [u8; 64] = sig.try_into().map_err(|_| "malformed signature".to_string())?;
    let nonce: [u8; 32] = nonce.try_into().map_err(|_| "malformed nonce".to_string())?;
    // Like verify.mjs, the signed payload carries no callbackUrl.
    let hash = nep413_hash(message, &nonce, recipient, None);
    let ok = parse_public_key(public_key)
        .map(|pk| verify(&pk, &hash, &sig))
        .unwrap_or(false);
    if !ok {
        return Err("bad signature".into());
    }

    let issued_at = message
        .lines()
        .find_map(|l| l.strip_prefix("Issued: "))
        .filter(|v| !v.is_empty() && !v.contains(char::is_whitespace))
        .and_then(parse_iso8601_ms)
        .ok_or("message has no timestamp")?;
    if issued_at > opts.now_ms + SKEW_MS {
        return Err("timestamp is in the future".into());
    }
    if opts.now_ms.saturating_sub(issued_at) > opts.max_age_ms {
        return Err("stale".into());
    }
    Ok(SignIn { account_id: account_id.into(), public_key: public_key.into(), issued_at })
}

/// [`check_proof`] plus an RPC check that the key is a full-access key on the account.
pub fn verify_sign_in(proof: &Value, opts: &Options, rpc: &Rpc) -> Result<SignIn, String> {
    let signin = check_proof(proof, opts)?;
    let key = rpc
        .access_key(&signin.account_id, &signin.public_key)
        .map_err(|e| format!("rpc error: {e}"))?
        .ok_or("key is not on the account")?;
    if !is_full_access(&key) {
        return Err("key is not full access".into());
    }
    Ok(signin)
}

/// `YYYY-MM-DDTHH:MM:SS[.fff][Z|±HH:MM]` → milliseconds since the epoch.
pub fn parse_iso8601_ms(text: &str) -> Option<u64> {
    // Every slice below is by byte offset; a timestamp is ASCII.
    if !text.is_ascii() {
        return None;
    }
    let b = text.as_bytes();
    let num = |s: usize, n: usize| -> Option<i64> {
        let part = text.get(s..s + n)?;
        part.bytes().all(|c| c.is_ascii_digit()).then(|| part.parse().ok())?
    };
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || !(b[10] == b'T' || b[10] == b't') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let (y, mo, d, h, mi, s) = (num(0, 4)?, num(5, 2)?, num(8, 2)?, num(11, 2)?, num(14, 2)?, num(17, 2)?);
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || s > 60 {
        return None;
    }
    let mut i = 19;
    let mut ms = 0i64;
    if b.get(i) == Some(&b'.') {
        i += 1;
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        let frac = &text[start..i];
        if frac.is_empty() {
            return None;
        }
        ms = format!("{:0<3}", &frac[..frac.len().min(3)]).parse().ok()?;
    }
    let offset_min = match &text[i..] {
        "Z" | "z" => 0,
        tz if tz.len() == 6 && (tz.starts_with('+') || tz.starts_with('-')) && &tz[3..4] == ":" => {
            let v = num(i + 1, 2)? * 60 + num(i + 4, 2)?;
            if tz.starts_with('-') {
                -v
            } else {
                v
            }
        }
        _ => return None,
    };
    // Days from civil (Howard Hinnant's algorithm).
    let (yy, mm) = if mo <= 2 { (y - 1, mo + 9) } else { (y, mo - 3) };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let doy = (153 * mm + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let total = ((days * 24 + h) * 60 + mi - offset_min) * 60 + s;
    u64::try_from(total * 1000 + ms).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::encoding::{b64, format_public_key};
    use serde_json::json;

    #[test]
    fn parses_iso_timestamps() {
        assert_eq!(parse_iso8601_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso8601_ms("2026-11-11T10:20:30.456Z"), Some(1_794_392_430_456));
        assert_eq!(parse_iso8601_ms("2026-11-11T12:20:30.456+02:00"), Some(1_794_392_430_456));
        assert_eq!(parse_iso8601_ms("2000-02-29T00:00:00Z"), Some(951_782_400_000));
        assert_eq!(parse_iso8601_ms("2026-13-01T00:00:00Z"), None);
        assert_eq!(parse_iso8601_ms("yesterday"), None);
    }

    #[test]
    fn odd_offsets_are_refused_not_a_panic() {
        // The signer picks the message text, so a byte slice inside a multi-byte
        // character must fail like any other bad timestamp.
        assert_eq!(parse_iso8601_ms("2026-11-11T10:20:30+0\u{e9}00"), None);
        assert_eq!(parse_iso8601_ms("2026-11-11T10:20:30+\u{e9}:00"), None);
        assert_eq!(parse_iso8601_ms("2026-11-11T10:20:3\u{e9}Z"), None);
        assert_eq!(parse_iso8601_ms("2026\u{e9}11-11T10:20:30Z"), None);
    }

    fn proof_for(seed: [u8; 32], site: &str, issued: &str) -> Value {
        let nonce = [9u8; 32];
        let message = format!("Sign in to {site}\nSite: {site}\nIssued: {issued}");
        let sig = sign(&seed, &nep413_hash(&message, &nonce, site, None));
        json!({
            "accountId": "alice.site.testnet",
            "publicKey": format_public_key(&public_key_of(&seed)),
            "signature": b64(&sig),
            "message": message,
            "nonce": b64(&nonce),
            "recipient": site,
        })
    }

    #[test]
    fn checks_a_proof_like_verify_mjs() {
        let now = parse_iso8601_ms("2026-11-11T10:00:00.000Z").unwrap();
        let opts = Options { site: "site.testnet", max_age_ms: 300_000, now_ms: now };
        let good = proof_for([1; 32], "site.testnet", "2026-11-11T09:58:00.000Z");
        assert_eq!(check_proof(&good, &opts).unwrap().issued_at, now - 120_000);

        let mut tampered = good.clone();
        tampered["message"] = json!("Sign in to x\nIssued: 2026-11-11T09:58:00.000Z");
        assert_eq!(check_proof(&tampered, &opts).unwrap_err(), "bad signature");

        let other = Options { site: "other.testnet", ..opts };
        assert_eq!(check_proof(&good, &other).unwrap_err(), "wrong recipient");

        let stale = proof_for([1; 32], "site.testnet", "2026-11-11T09:50:00.000Z");
        assert_eq!(check_proof(&stale, &opts).unwrap_err(), "stale");

        let future = proof_for([1; 32], "site.testnet", "2026-11-11T10:05:00.000Z");
        assert_eq!(check_proof(&future, &opts).unwrap_err(), "timestamp is in the future");

        let mut missing = good.clone();
        missing["nonce"] = json!("");
        assert_eq!(check_proof(&missing, &opts).unwrap_err(), "missing nonce");
        assert_eq!(check_proof(&json!(null), &opts).unwrap_err(), "missing proof");
    }

    #[test]
    fn verify_sign_in_requires_a_full_access_key() {
        let now = parse_iso8601_ms("2026-11-11T10:00:00.000Z").unwrap();
        let opts = Options { site: "site.testnet", max_age_ms: 300_000, now_ms: now };
        let good = proof_for([2; 32], "site.testnet", "2026-11-11T09:59:00.000Z");
        let full = Rpc::with_transport(|_| Ok(json!({ "result": { "nonce": 1, "permission": "FullAccess" } })));
        assert!(verify_sign_in(&good, &opts, &full).is_ok());
        let limited = Rpc::with_transport(|_| {
            Ok(json!({ "result": { "nonce": 1, "permission": { "FunctionCall": { "allowance": null } } } }))
        });
        assert_eq!(verify_sign_in(&good, &opts, &limited).unwrap_err(), "key is not full access");
        let gone = Rpc::with_transport(|_| Ok(json!({ "error": { "cause": { "name": "UNKNOWN_ACCESS_KEY" } } })));
        assert_eq!(verify_sign_in(&good, &opts, &gone).unwrap_err(), "key is not on the account");
    }
}

//! Outbound HTTP(S) over WASI P2 `wasi:http`.
//!
//! Built on the `wasi` crate directly (the layer under `wasi-http-client`) so a
//! request can set first-byte and between-bytes timeouts, write bodies larger
//! than one 4 KB stream write, and stop reading at a size cap. It also keeps
//! the `url`/`idna` tables out of the wasm.

use serde_json::Value;

#[derive(Clone, Debug)]
pub struct Options {
    /// Connect, first-byte and between-bytes timeout, and the wall-clock budget
    /// for reading the body.
    pub timeout_ms: u64,
    /// Stop reading after this many body bytes and mark the response truncated.
    pub max_bytes: usize,
}

impl Default for Options {
    fn default() -> Self {
        Self { timeout_ms: 10_000, max_bytes: 1 << 20 }
    }
}

#[derive(Clone, Debug)]
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub truncated: bool,
}

impl Response {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
    pub fn json(&self) -> Result<Value, String> {
        serde_json::from_slice(&self.body).map_err(|_| format!("HTTP {}: body is not JSON", self.status))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Url {
    pub https: bool,
    pub host: String,
    pub port: Option<u16>,
    /// Path plus query, always starting with `/`.
    pub path: String,
}

impl Url {
    pub fn parse(text: &str) -> Result<Url, String> {
        let text = text.trim();
        let (https, rest) = if let Some(r) = strip_prefix_ci(text, "https://") {
            (true, r)
        } else if let Some(r) = strip_prefix_ci(text, "http://") {
            (false, r)
        } else {
            return Err("only http and https URLs are supported".into());
        };
        let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
        let authority = &rest[..end];
        let mut path = rest[end..].split('#').next().unwrap_or("").to_string();
        if authority.is_empty() || authority.contains('@') || authority.contains(char::is_whitespace) {
            return Err("bad host in URL".into());
        }
        let parse_port = |p: &str| p.parse::<u16>().map_err(|_| "bad port in URL".to_string());
        let (host, port) = if authority.starts_with('[') {
            let close = authority.find(']').ok_or("bad host in URL")?;
            let port = match &authority[close + 1..] {
                "" => None,
                p => Some(parse_port(p.strip_prefix(':').ok_or("bad port in URL")?)?),
            };
            (authority[..=close].to_ascii_lowercase(), port)
        } else {
            match authority.rsplit_once(':') {
                Some((h, _)) if h.is_empty() => return Err("bad host in URL".into()),
                Some((h, p)) => (h.to_ascii_lowercase(), Some(parse_port(p)?)),
                None => (authority.to_ascii_lowercase(), None),
            }
        };
        if path.is_empty() || path.starts_with('?') {
            path.insert(0, '/');
        }
        if path.contains(char::is_whitespace) {
            path = path.replace(' ', "%20");
        }
        Ok(Url { https, host, port, path })
    }

    pub fn authority(&self) -> String {
        match self.port {
            Some(p) => format!("{}:{p}", self.host),
            None => self.host.clone(),
        }
    }

    pub fn origin(&self) -> String {
        format!("{}://{}", if self.https { "https" } else { "http" }, self.authority())
    }

    pub fn to_string(&self) -> String {
        format!("{}{}", self.origin(), self.path)
    }

    /// Resolve `href` against this URL (absolute, protocol-relative, root or relative path).
    pub fn join(&self, href: &str) -> Result<Url, String> {
        let href = href.trim();
        if href.starts_with("//") {
            return Url::parse(&format!("{}:{href}", if self.https { "https" } else { "http" }));
        }
        if href.contains("://") {
            return Url::parse(href);
        }
        if href.starts_with('/') {
            return Url::parse(&format!("{}{href}", self.origin()));
        }
        let base = self.path.split(['?', '#']).next().unwrap_or("/");
        let dir = &base[..base.rfind('/').map(|i| i + 1).unwrap_or(1)];
        Url::parse(&format!("{}{dir}{href}", self.origin()))
    }

    /// True for hosts that name this machine or a private network. Functions
    /// refuse these for user-supplied URLs.
    pub fn is_private_host(&self) -> bool {
        let h = self.host.trim_start_matches('[').trim_end_matches(']');
        if h == "localhost" || h.ends_with(".localhost") || h.ends_with(".local") || h.ends_with(".internal") {
            return true;
        }
        if h.contains(':') {
            return true; // IPv6 literals: refuse rather than classify
        }
        let parts: Vec<u8> = h.split('.').filter_map(|p| p.parse().ok()).collect();
        if parts.len() == 4 && h.split('.').count() == 4 {
            return matches!(parts[..], [10, ..] | [127, ..] | [0, ..] | [169, 254, ..] | [192, 168, ..])
                || (parts[0] == 172 && (16..32).contains(&parts[1]))
                || (parts[0] == 100 && (64..128).contains(&parts[1]));
        }
        false
    }
}

fn strip_prefix_ci<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    if text.len() >= prefix.len() && text[..prefix.len()].eq_ignore_ascii_case(prefix) {
        Some(&text[prefix.len()..])
    } else {
        None
    }
}

/// GET with default options.
pub fn get(url: &str, headers: &[(&str, &str)]) -> Result<Response, String> {
    send("GET", url, headers, None, &Options::default())
}

/// POST a body with default options.
pub fn post(url: &str, headers: &[(&str, &str)], body: &[u8]) -> Result<Response, String> {
    send("POST", url, headers, Some(body), &Options::default())
}

/// POST JSON and parse a JSON answer.
pub fn post_json(url: &str, headers: &[(&str, &str)], body: &Value) -> Result<Value, String> {
    let mut all = vec![("content-type", "application/json")];
    all.extend_from_slice(headers);
    let res = post(url, &all, body.to_string().as_bytes())?;
    res.json()
}

#[cfg(target_os = "wasi")]
pub fn send(
    method: &str,
    url: &str,
    headers: &[(&str, &str)],
    body: Option<&[u8]>,
    opts: &Options,
) -> Result<Response, String> {
    wasi_impl::send(method, &Url::parse(url)?, headers, body, opts)
}

/// Outside a WASI P2 guest there is no `wasi:http`; host builds (unit tests) get an error.
#[cfg(not(target_os = "wasi"))]
pub fn send(
    _method: &str,
    url: &str,
    _headers: &[(&str, &str)],
    _body: Option<&[u8]>,
    _opts: &Options,
) -> Result<Response, String> {
    Url::parse(url)?;
    Err("http is only available inside a wasm32-wasip2 function".into())
}

#[cfg(target_os = "wasi")]
mod wasi_impl {
    use super::{Options, Response, Url};
    use std::time::{Duration, Instant};
    use wasi::http::outgoing_handler;
    use wasi::http::types::{Fields, Method, OutgoingBody, OutgoingRequest, RequestOptions, Scheme};
    use wasi::io::streams::StreamError;

    pub fn send(
        method: &str,
        url: &Url,
        headers: &[(&str, &str)],
        body: Option<&[u8]>,
        opts: &Options,
    ) -> Result<Response, String> {
        let fields = Fields::new();
        for (k, v) in headers {
            fields
                .append(&k.to_string(), &v.as_bytes().to_vec())
                .map_err(|_| format!("bad header {k}"))?;
        }
        let req = OutgoingRequest::new(fields);
        let m = match method {
            "GET" => Method::Get,
            "POST" => Method::Post,
            "PUT" => Method::Put,
            "DELETE" => Method::Delete,
            "HEAD" => Method::Head,
            other => Method::Other(other.to_string()),
        };
        req.set_method(&m).map_err(|_| "bad method")?;
        req.set_scheme(Some(if url.https { &Scheme::Https } else { &Scheme::Http }))
            .map_err(|_| "bad scheme")?;
        req.set_authority(Some(&url.authority())).map_err(|_| "bad host")?;
        req.set_path_with_query(Some(&url.path)).map_err(|_| "bad path")?;

        let out_body = req.body().map_err(|_| "request body unavailable")?;
        if let Some(bytes) = body {
            let stream = out_body.write().map_err(|_| "request body unavailable")?;
            let mut rest = bytes;
            while !rest.is_empty() {
                let room = stream.check_write().map_err(|e| format!("write failed: {e:?}"))? as usize;
                if room == 0 {
                    stream.subscribe().block();
                    continue;
                }
                let n = room.min(rest.len()).min(4096);
                stream.write(&rest[..n]).map_err(|e| format!("write failed: {e:?}"))?;
                rest = &rest[n..];
            }
            stream.blocking_flush().map_err(|e| format!("flush failed: {e:?}"))?;
            drop(stream);
        }
        OutgoingBody::finish(out_body, None).map_err(|e| format!("request failed: {e:?}"))?;

        let ns = opts.timeout_ms.saturating_mul(1_000_000);
        let options = RequestOptions::new();
        let _ = options.set_connect_timeout(Some(ns));
        let _ = options.set_first_byte_timeout(Some(ns));
        let _ = options.set_between_bytes_timeout(Some(ns));

        let future = outgoing_handler::handle(req, Some(options)).map_err(|e| format!("request failed: {e:?}"))?;
        future.subscribe().block();
        let incoming = future
            .get()
            .ok_or("no response")?
            .map_err(|_| "response already taken")?
            .map_err(|e| format!("request failed: {e:?}"))?;
        drop(future);

        let status = incoming.status();
        let headers = incoming
            .headers()
            .entries()
            .into_iter()
            .map(|(k, v)| (k, String::from_utf8_lossy(&v).into_owned()))
            .collect();
        let in_body = incoming.consume().map_err(|_| "response body unavailable")?;
        let stream = in_body.stream().map_err(|_| "response body unavailable")?;
        let started = Instant::now();
        let budget = Duration::from_millis(opts.timeout_ms);
        let mut buf = Vec::new();
        let mut truncated = false;
        loop {
            if buf.len() >= opts.max_bytes || started.elapsed() > budget {
                truncated = true;
                break;
            }
            let want = (opts.max_bytes - buf.len()).min(64 * 1024) as u64;
            match stream.blocking_read(want) {
                Ok(chunk) => buf.extend_from_slice(&chunk),
                Err(StreamError::Closed) => break,
                Err(e) => return Err(format!("read failed: {e:?}")),
            }
        }
        if buf.len() > opts.max_bytes {
            buf.truncate(opts.max_bytes);
            truncated = true;
        }
        drop(stream);
        drop(in_body);
        Ok(Response { status, headers, body: buf, truncated })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_urls() {
        let u = Url::parse("https://Example.com:8443/a/b?x=1#frag").unwrap();
        assert!(u.https);
        assert_eq!(u.host, "example.com");
        assert_eq!(u.port, Some(8443));
        assert_eq!(u.path, "/a/b?x=1");
        assert_eq!(Url::parse("https://example.com").unwrap().path, "/");
        assert_eq!(Url::parse("https://example.com?q").unwrap().path, "/?q");
        assert!(Url::parse("ftp://x").is_err());
        assert!(Url::parse("https://user@evil.com/").is_err());
        assert!(Url::parse("https://").is_err());
    }

    #[test]
    fn joins_relative_urls() {
        let base = Url::parse("https://a.com/blog/post.html?x").unwrap();
        assert_eq!(base.join("/img.png").unwrap().to_string(), "https://a.com/img.png");
        assert_eq!(base.join("img.png").unwrap().to_string(), "https://a.com/blog/img.png");
        assert_eq!(base.join("//cdn.com/i.png").unwrap().to_string(), "https://cdn.com/i.png");
        assert_eq!(base.join("http://b.com/").unwrap().to_string(), "http://b.com/");
    }

    #[test]
    fn flags_private_hosts() {
        for h in ["localhost", "127.0.0.1", "10.1.2.3", "192.168.0.1", "172.20.0.1", "169.254.169.254", "[::1]", "x.internal"] {
            assert!(Url::parse(&format!("https://{h}/")).unwrap().is_private_host(), "{h}");
        }
        for h in ["example.com", "8.8.8.8", "172.32.0.1"] {
            assert!(!Url::parse(&format!("https://{h}/")).unwrap().is_private_host(), "{h}");
        }
    }

    #[test]
    fn host_build_has_no_network() {
        assert!(get("https://example.com/", &[]).unwrap_err().contains("wasm32-wasip2"));
    }
}

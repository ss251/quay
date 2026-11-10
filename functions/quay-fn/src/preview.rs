//! Link previews shared by the `preview` and `moderate` functions.
use crate::html;
use crate::http::{self, Options, Url};
use crate::{clip, json, Value};

/// Hard cap on a preview's JSON size.
pub const MAX_PREVIEW_BYTES: usize = 2048;
const MAX_HTML_BYTES: usize = 256 * 1024;
const TIMEOUT_MS: u64 = 8_000;
const MAX_REDIRECTS: usize = 3;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Preview {
    pub url: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub image: Option<String>,
}

impl Preview {
    pub fn to_json(&self) -> Value {
        json!({
            "url": self.url,
            "title": self.title,
            "description": self.description,
            "image": self.image,
        })
    }
}

/// Check a user-supplied URL: https only, no private or local hosts.
pub fn check_url(text: &str) -> Result<Url, String> {
    let url = Url::parse(text).map_err(|_| "pass an https URL".to_string())?;
    if !url.https {
        return Err("only https URLs are previewed".into());
    }
    if url.is_private_host() {
        return Err("that host is not allowed".into());
    }
    Ok(url)
}

/// Build a preview from a page already fetched from `url`, within [`MAX_PREVIEW_BYTES`].
pub fn from_html(url: &Url, page: &str) -> Preview {
    let meta = html::extract(page);
    let image = meta
        .image
        .and_then(|src| url.join(&src).ok())
        .filter(|u| u.https && !u.is_private_host())
        .map(|u| u.to_string())
        .filter(|s| s.len() <= 600);
    fit(Preview {
        url: clip(&url.to_string(), 600),
        title: meta.title.or(meta.site_name).map(|t| clip(&t, 160)),
        description: meta.description.map(|d| clip(&d, 400)),
        image,
    })
}

/// Shrink a preview until its JSON fits in [`MAX_PREVIEW_BYTES`].
pub fn fit(p: Preview) -> Preview {
    fit_within(p, MAX_PREVIEW_BYTES)
}

/// Shrink a preview until its JSON is at most `max` bytes.
pub fn fit_within(mut p: Preview, max: usize) -> Preview {
    let size = |p: &Preview| p.to_json().to_string().len();
    while size(&p) > max {
        if let Some(d) = p.description.as_ref().filter(|d| d.chars().count() > 40) {
            p.description = Some(clip(d, d.chars().count() * 2 / 3));
        } else if p.image.is_some() {
            p.image = None;
        } else if let Some(t) = p.title.as_ref().filter(|t| t.chars().count() > 40) {
            p.title = Some(clip(t, 40));
        } else {
            p.description = None;
            p.url = clip(&p.url, 200);
            break;
        }
    }
    p
}

/// Fetch `url` (https only, at most 256 KB and 8 s, up to 3 redirects) and
/// return its title, description and image.
pub fn link_preview(url: &str) -> Result<Preview, String> {
    let mut current = check_url(url)?;
    let opts = Options { timeout_ms: TIMEOUT_MS, max_bytes: MAX_HTML_BYTES };
    for _ in 0..=MAX_REDIRECTS {
        let res = http::send(
            "GET",
            &current.to_string(),
            &[
                ("accept", "text/html,application/xhtml+xml"),
                ("user-agent", "quay-preview/0.1 (+https://outlayer.ai)"),
            ],
            None,
            &opts,
        )?;
        if (300..400).contains(&res.status) {
            let next = res.header("location").ok_or("redirect without a location")?;
            current = check_url(&current.join(next)?.to_string())?;
            continue;
        }
        if !res.ok() {
            return Err(format!("the page answered HTTP {}", res.status));
        }
        let kind = res.header("content-type").unwrap_or("text/html").to_ascii_lowercase();
        if !kind.contains("html") {
            return Ok(fit(Preview { url: current.to_string(), title: None, description: None, image: None }));
        }
        return Ok(from_html(&current, &res.text()));
    }
    Err("too many redirects".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_a_preview_from_html() {
        let url = Url::parse("https://news.example/a/story").unwrap();
        let p = from_html(
            &url,
            r#"<head><title>Story</title><meta property="og:image" content="/img/cover.jpg">
               <meta name="description" content="What happened"></head>"#,
        );
        assert_eq!(p.title.as_deref(), Some("Story"));
        assert_eq!(p.description.as_deref(), Some("What happened"));
        assert_eq!(p.image.as_deref(), Some("https://news.example/img/cover.jpg"));
    }

    #[test]
    fn drops_insecure_images() {
        let url = Url::parse("https://a.example/").unwrap();
        let p = from_html(&url, r#"<meta property="og:image" content="http://a.example/x.png">"#);
        assert_eq!(p.image, None);
    }

    #[test]
    fn stays_under_two_kilobytes() {
        let url = Url::parse("https://a.example/").unwrap();
        let long = "word ".repeat(2000);
        let html = format!(
            r#"<meta property="og:title" content="{long}"><meta property="og:description" content="{long}"><meta property="og:image" content="https://a.example/{}.png">"#,
            "i".repeat(500)
        );
        let p = from_html(&url, &html);
        assert!(p.to_json().to_string().len() <= MAX_PREVIEW_BYTES);
        assert!(p.title.is_some());
    }

    #[test]
    fn refuses_bad_urls() {
        assert!(check_url("http://a.example/").is_err());
        assert!(check_url("https://127.0.0.1/").is_err());
        assert!(check_url("javascript:alert(1)").is_err());
        assert!(check_url("https://a.example/").is_ok());
    }
}

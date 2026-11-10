//! A small HTML scanner for link previews: `<title>`, `<meta name|property=… content=…>`.
//! Not a parser: it reads tags in order and ignores everything else.

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Meta {
    pub title: Option<String>,
    pub description: Option<String>,
    pub image: Option<String>,
    pub site_name: Option<String>,
}

/// Pull preview fields out of an HTML document. Open Graph wins over Twitter
/// cards, which win over `<title>` and `<meta name="description">`.
pub fn extract(html: &str) -> Meta {
    let lower = html.to_ascii_lowercase();
    let mut og_title = None;
    let mut tw_title = None;
    let mut og_desc = None;
    let mut desc = None;
    let mut tw_desc = None;
    let mut og_image = None;
    let mut tw_image = None;
    let mut site_name = None;
    let mut title = None;

    let mut pos = 0;
    while let Some(off) = lower[pos..].find('<') {
        let start = pos + off;
        let rest = &lower[start + 1..];
        if rest.starts_with("!--") {
            pos = lower[start..].find("-->").map(|e| start + e + 3).unwrap_or(lower.len());
            continue;
        }
        let end = match lower[start..].find('>') {
            Some(e) => start + e,
            None => break,
        };
        if rest.starts_with("title") && title.is_none() {
            if let Some(close) = lower[end..].find("</title") {
                title = clean(&html[end + 1..end + close]);
            }
        } else if rest.starts_with("meta") {
            let tag = &html[start + 5..end];
            let attrs = attributes(tag);
            let get = |k: &str| attrs.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
            let key = get("property").or_else(|| get("name")).map(|k| k.to_ascii_lowercase());
            let content = get("content").and_then(clean);
            if let (Some(key), Some(content)) = (key, content) {
                let slot = match key.as_str() {
                    "og:title" => &mut og_title,
                    "twitter:title" => &mut tw_title,
                    "og:description" => &mut og_desc,
                    "description" => &mut desc,
                    "twitter:description" => &mut tw_desc,
                    "og:image" | "og:image:url" | "og:image:secure_url" => &mut og_image,
                    "twitter:image" | "twitter:image:src" => &mut tw_image,
                    "og:site_name" => &mut site_name,
                    _ => {
                        pos = end + 1;
                        continue;
                    }
                };
                if slot.is_none() {
                    *slot = Some(content);
                }
            }
        } else if rest.starts_with("/head") || rest.starts_with("body") {
            // Everything a preview needs lives in <head>; stop at <body> once we have a title.
            if title.is_some() || og_title.is_some() {
                break;
            }
        }
        pos = end + 1;
    }

    Meta {
        title: og_title.or(tw_title).or(title),
        description: og_desc.or(desc).or(tw_desc),
        image: og_image.or(tw_image),
        site_name,
    }
}

/// Attributes of a tag body (`name="x" content='y' flag`), names lower-cased, values decoded.
fn attributes(tag: &str) -> Vec<(String, String)> {
    let b = tag.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        while i < b.len() && (b[i].is_ascii_whitespace() || b[i] == b'/') {
            i += 1;
        }
        let ns = i;
        while i < b.len() && !b[i].is_ascii_whitespace() && b[i] != b'=' && b[i] != b'/' {
            i += 1;
        }
        if ns == i {
            i += 1;
            continue;
        }
        let name = tag[ns..i].to_ascii_lowercase();
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        let mut value = String::new();
        if i < b.len() && b[i] == b'=' {
            i += 1;
            while i < b.len() && b[i].is_ascii_whitespace() {
                i += 1;
            }
            if i < b.len() && (b[i] == b'"' || b[i] == b'\'') {
                let q = b[i];
                let vs = i + 1;
                i = vs;
                while i < b.len() && b[i] != q {
                    i += 1;
                }
                value = tag[vs..i.min(b.len())].to_string();
                i += 1;
            } else {
                let vs = i;
                while i < b.len() && !b[i].is_ascii_whitespace() {
                    i += 1;
                }
                value = tag[vs..i].to_string();
            }
        }
        out.push((name, decode_entities(&value)));
    }
    out
}

/// Decode the common named entities and numeric references.
pub fn decode_entities(text: &str) -> String {
    if !text.contains('&') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let semi = rest[..rest.len().min(12)].find(';');
        let decoded = semi.and_then(|s| {
            let ent = &rest[1..s];
            let ch = match ent {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" | "#39" => Some('\''),
                "nbsp" => Some(' '),
                "mdash" => Some('—'),
                "ndash" => Some('–'),
                "hellip" => Some('…'),
                "rsquo" => Some('\u{2019}'),
                "lsquo" => Some('\u{2018}'),
                "rdquo" => Some('\u{201d}'),
                "ldquo" => Some('\u{201c}'),
                _ => {
                    let num = ent.strip_prefix('#')?;
                    let code = match num.strip_prefix(['x', 'X']) {
                        Some(h) => u32::from_str_radix(h, 16).ok()?,
                        None => num.parse().ok()?,
                    };
                    char::from_u32(code)
                }
            }?;
            Some((ch, s + 1))
        });
        match decoded {
            Some((ch, len)) => {
                out.push(ch);
                rest = &rest[len..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Decode, collapse whitespace, trim. Empty becomes `None`.
fn clean(text: &str) -> Option<String> {
    let decoded = decode_entities(text);
    let collapsed = decoded.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        None
    } else {
        Some(collapsed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_open_graph() {
        let html = r#"<!doctype html><html><head>
            <title> Plain   title </title>
            <!-- <meta property="og:title" content="commented out"> -->
            <meta name="description" content="Plain description">
            <meta property="og:title" content="OG &amp; title">
            <meta content='https://cdn.example/x.png' property='og:image' />
            <meta property="og:description" content="OG description &#8212; ok">
            </head><body><meta property="og:title" content="late"></body></html>"#;
        let m = extract(html);
        assert_eq!(m.title.as_deref(), Some("OG & title"));
        assert_eq!(m.description.as_deref(), Some("OG description — ok"));
        assert_eq!(m.image.as_deref(), Some("https://cdn.example/x.png"));
    }

    #[test]
    fn falls_back_to_title_and_description() {
        let m = extract("<HTML><HEAD><TITLE>Hi &lt;there&gt;</TITLE><META NAME=description CONTENT=Short></HEAD>");
        assert_eq!(m.title.as_deref(), Some("Hi <there>"));
        assert_eq!(m.description.as_deref(), Some("Short"));
        assert_eq!(m.image, None);
    }

    #[test]
    fn survives_garbage() {
        assert_eq!(extract("<<<meta content=\"x"), Meta::default());
        assert_eq!(extract(""), Meta::default());
        assert_eq!(decode_entities("a &bogus; &#xZZ; & b"), "a &bogus; &#xZZ; & b");
        assert_eq!(decode_entities("&#x1F600;"), "😀");
    }
}

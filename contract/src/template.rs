//! The template renderer for routed pages (section 4 of `docs/fullstack-interface.md`).
//!
//! Every value is HTML-escaped on output. There is no raw form: `{{{x}}}` is an
//! error. The parser keeps slices of the template text, and output is written
//! straight into one `String`, so a page costs one pass and few allocations.

use near_sdk::serde_json::{self, Value};

/// A chain of includes may be this deep. The page itself is depth 0.
pub const MAX_INCLUDE_DEPTH: usize = 4;
const MAX_NESTING: usize = 32;
const MAX_PATH_BYTES: usize = 128;

/// Reads another file of the same release for `{{> path}}`.
pub trait Loader {
    fn load(&self, path: &str) -> Option<String>;
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum BlockKind {
    Each,
    If,
    Unless,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Filter {
    Date,
    Json,
    Url,
    Lines,
    Near,
    Count,
}

#[derive(Debug)]
enum Node<'a> {
    Text(&'a str),
    Var {
        path: &'a str,
        filter: Option<Filter>,
    },
    Block {
        kind: BlockKind,
        path: &'a str,
        body: Vec<Node<'a>>,
        alt: Vec<Node<'a>>,
    },
    Include(&'a str),
}

struct Frame<'a> {
    kind: BlockKind,
    path: &'a str,
    body: Vec<Node<'a>>,
    alt: Option<Vec<Node<'a>>>,
}

/// Render `src` against `ctx`. Errors name the first problem found.
pub fn render(src: &str, ctx: &Value, loader: &dyn Loader) -> Result<String, String> {
    let nodes = parse(src)?;
    let mut out = String::with_capacity(src.len() + 2048);
    let mut scopes: Vec<(&Value, Option<usize>)> = Vec::with_capacity(8);
    scopes.push((ctx, None));
    render_nodes(&nodes, &mut scopes, &mut out, loader, 0)?;
    Ok(out)
}

/// Parse `src` and every file it includes, as `seal` does before it stores a route.
pub fn check(src: &str, loader: &dyn Loader) -> Result<(), String> {
    check_at(src, loader, 0)
}

fn check_at(src: &str, loader: &dyn Loader, depth: usize) -> Result<(), String> {
    let nodes = parse(src)?;
    let mut includes = Vec::new();
    collect_includes(&nodes, &mut includes);
    for path in includes {
        if depth >= MAX_INCLUDE_DEPTH {
            return Err("includes nest deeper than 4".to_string());
        }
        let inner = loader
            .load(path)
            .ok_or_else(|| format!("include {path} is not a stored text file"))?;
        check_at(&inner, loader, depth + 1)?;
    }
    Ok(())
}

fn collect_includes<'a>(nodes: &[Node<'a>], out: &mut Vec<&'a str>) {
    for node in nodes {
        match node {
            Node::Include(path) => out.push(path),
            Node::Block { body, alt, .. } => {
                collect_includes(body, out);
                collect_includes(alt, out);
            }
            _ => {}
        }
    }
}

fn push_node<'a>(root: &mut Vec<Node<'a>>, stack: &mut [Frame<'a>], node: Node<'a>) {
    match stack.last_mut() {
        Some(frame) => match &mut frame.alt {
            Some(alt) => alt.push(node),
            None => frame.body.push(node),
        },
        None => root.push(node),
    }
}

fn block_kind(word: &str) -> Result<BlockKind, String> {
    match word {
        "each" => Ok(BlockKind::Each),
        "if" => Ok(BlockKind::If),
        "unless" => Ok(BlockKind::Unless),
        other => Err(format!("unknown block {other}")),
    }
}

fn parse(src: &str) -> Result<Vec<Node<'_>>, String> {
    let mut root = Vec::new();
    let mut stack: Vec<Frame> = Vec::new();
    let mut rest = src;
    loop {
        let Some(open) = rest.find("{{") else {
            if !rest.is_empty() {
                push_node(&mut root, &mut stack, Node::Text(rest));
            }
            break;
        };
        if open > 0 {
            push_node(&mut root, &mut stack, Node::Text(&rest[..open]));
        }
        let after = &rest[open + 2..];
        if after.starts_with('{') {
            return Err("raw output {{{ }}} is not supported".to_string());
        }
        let Some(close) = after.find("}}") else {
            return Err("unclosed tag".to_string());
        };
        let tag = after[..close].trim();
        rest = &after[close + 2..];
        if tag.starts_with('!') {
            continue;
        }
        if let Some(body) = tag.strip_prefix('#') {
            let (word, arg) = body.split_once(char::is_whitespace).unwrap_or((body, ""));
            let kind = block_kind(word)?;
            let path = arg.trim();
            check_value_path(path)?;
            if stack.len() >= MAX_NESTING {
                return Err("blocks nest too deep".to_string());
            }
            stack.push(Frame {
                kind,
                path,
                body: Vec::new(),
                alt: None,
            });
        } else if let Some(word) = tag.strip_prefix('/') {
            let kind = block_kind(word.trim())?;
            let frame = stack.pop().ok_or_else(|| format!("unexpected {{{{/{}}}}}", word.trim()))?;
            if frame.kind != kind {
                return Err(format!("{{{{/{}}}}} closes a different block", word.trim()));
            }
            let node = Node::Block {
                kind,
                path: frame.path,
                body: frame.body,
                alt: frame.alt.unwrap_or_default(),
            };
            push_node(&mut root, &mut stack, node);
        } else if tag == "else" {
            let frame = stack
                .last_mut()
                .ok_or_else(|| "{{else}} outside a block".to_string())?;
            if frame.alt.is_some() {
                return Err("second {{else}} in one block".to_string());
            }
            frame.alt = Some(Vec::new());
        } else if let Some(path) = tag.strip_prefix('>') {
            let path = path.trim();
            if !include_path_ok(path) {
                return Err(format!("bad include path {path}"));
            }
            push_node(&mut root, &mut stack, Node::Include(path));
        } else {
            let (path, filter) = match tag.split_once('|') {
                Some((path, filter)) => (path.trim(), Some(parse_filter(filter.trim())?)),
                None => (tag, None),
            };
            check_value_path(path)?;
            push_node(&mut root, &mut stack, Node::Var { path, filter });
        }
    }
    if let Some(frame) = stack.last() {
        let word = match frame.kind {
            BlockKind::Each => "each",
            BlockKind::If => "if",
            BlockKind::Unless => "unless",
        };
        return Err(format!("unclosed {word} block"));
    }
    Ok(root)
}

fn parse_filter(name: &str) -> Result<Filter, String> {
    match name {
        "date" => Ok(Filter::Date),
        "json" => Ok(Filter::Json),
        "url" => Ok(Filter::Url),
        "lines" => Ok(Filter::Lines),
        "near" => Ok(Filter::Near),
        "count" => Ok(Filter::Count),
        other => Err(format!("unknown filter {other}")),
    }
}

fn check_value_path(path: &str) -> Result<(), String> {
    if path == "." || path == "this" || path == "@index" {
        return Ok(());
    }
    let ok = !path.is_empty()
        && path.len() <= MAX_PATH_BYTES
        && path.split('.').all(|seg| {
            !seg.is_empty()
                && seg
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        });
    if ok {
        Ok(())
    } else {
        Err(format!("bad value path \"{path}\""))
    }
}

/// Same rules as a sealed file path.
pub fn include_path_ok(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 180
        && path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'/'))
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

enum Res<'v> {
    Val(&'v Value),
    Index(usize),
    Missing,
}

fn resolve<'v>(scopes: &[(&'v Value, Option<usize>)], path: &str) -> Res<'v> {
    if path == "@index" {
        return scopes
            .iter()
            .rev()
            .find_map(|(_, index)| *index)
            .map_or(Res::Missing, Res::Index);
    }
    let Some(&(top, _)) = scopes.last() else {
        return Res::Missing;
    };
    if path == "." || path == "this" {
        return Res::Val(top);
    }
    if let Some(rest) = path.strip_prefix("this.") {
        return walk(top, rest);
    }
    let first = path.split('.').next().unwrap_or(path);
    for &(value, _) in scopes.iter().rev() {
        if let Value::Object(map) = value {
            if map.contains_key(first) {
                return walk(value, path);
            }
        }
    }
    Res::Missing
}

fn walk<'v>(mut value: &'v Value, path: &str) -> Res<'v> {
    for seg in path.split('.') {
        let next = match value {
            Value::Object(map) => map.get(seg),
            Value::Array(items) => seg.parse::<usize>().ok().and_then(|i| items.get(i)),
            _ => None,
        };
        match next {
            Some(inner) => value = inner,
            None => return Res::Missing,
        }
    }
    Res::Val(value)
}

fn truthy(res: &Res) -> bool {
    match res {
        Res::Missing => false,
        Res::Index(i) => *i != 0,
        Res::Val(value) => match value {
            Value::Null => false,
            Value::Bool(b) => *b,
            Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
            Value::String(s) => !s.is_empty(),
            Value::Array(items) => !items.is_empty(),
            Value::Object(map) => !map.is_empty(),
        },
    }
}

fn render_nodes<'v>(
    nodes: &[Node<'_>],
    scopes: &mut Vec<(&'v Value, Option<usize>)>,
    out: &mut String,
    loader: &dyn Loader,
    depth: usize,
) -> Result<(), String> {
    for node in nodes {
        match node {
            Node::Text(text) => out.push_str(text),
            Node::Var { path, filter } => {
                let res = resolve(scopes, path);
                write_value(&res, *filter, out);
            }
            Node::Block {
                kind: BlockKind::Each,
                path,
                body,
                alt,
            } => match resolve(scopes, path) {
                Res::Val(Value::Array(items)) if !items.is_empty() => {
                    for (index, item) in items.iter().enumerate() {
                        scopes.push((item, Some(index)));
                        let done = render_nodes(body, scopes, out, loader, depth);
                        scopes.pop();
                        done?;
                    }
                }
                _ => render_nodes(alt, scopes, out, loader, depth)?,
            },
            Node::Block {
                kind,
                path,
                body,
                alt,
            } => {
                let yes = truthy(&resolve(scopes, path)) != (*kind == BlockKind::Unless);
                render_nodes(if yes { body } else { alt }, scopes, out, loader, depth)?;
            }
            Node::Include(path) => {
                if depth >= MAX_INCLUDE_DEPTH {
                    return Err("includes nest deeper than 4".to_string());
                }
                let src = loader
                    .load(path)
                    .ok_or_else(|| format!("include {path} missing"))?;
                let inner = parse(&src)?;
                render_nodes(&inner, scopes, out, loader, depth + 1)?;
            }
        }
    }
    Ok(())
}

fn write_value(res: &Res, filter: Option<Filter>, out: &mut String) {
    match filter {
        None => match res {
            Res::Val(value) => write_plain(value, out),
            Res::Index(i) => out.push_str(&i.to_string()),
            Res::Missing => {}
        },
        Some(Filter::Date) => {
            if let Some(ns) = as_u128(res).and_then(|n| u64::try_from(n).ok()) {
                out.push_str(&format_date(ns));
            }
        }
        Some(Filter::Near) => {
            if let Some(yocto) = as_u128(res) {
                out.push_str(&format_near(yocto));
            }
        }
        Some(Filter::Count) => {
            let n = match res {
                Res::Val(Value::Array(items)) => items.len(),
                Res::Val(Value::Object(map)) => map.len(),
                Res::Val(Value::String(s)) => s.chars().count(),
                _ => 0,
            };
            out.push_str(&n.to_string());
        }
        Some(Filter::Json) => match res {
            Res::Val(value) => {
                let text = serde_json::to_string(value).unwrap_or_default();
                escape_into(&text, out);
            }
            Res::Index(i) => out.push_str(&i.to_string()),
            Res::Missing => {}
        },
        Some(Filter::Url) => with_text(res, |text| percent_encode_into(text, out)),
        Some(Filter::Lines) => with_text(res, |text| {
            let mut first = true;
            for line in text.split('\n') {
                if !first {
                    out.push_str("<br>");
                }
                first = false;
                escape_into(line.strip_suffix('\r').unwrap_or(line), out);
            }
        }),
    }
}

fn with_text(res: &Res, mut f: impl FnMut(&str)) {
    match res {
        Res::Val(Value::String(s)) => f(s),
        Res::Val(Value::Null) | Res::Missing => {}
        Res::Val(Value::Bool(b)) => f(if *b { "true" } else { "false" }),
        Res::Val(Value::Number(n)) => f(&n.to_string()),
        Res::Val(other) => f(&serde_json::to_string(other).unwrap_or_default()),
        Res::Index(i) => f(&i.to_string()),
    }
}

fn write_plain(value: &Value, out: &mut String) {
    match value {
        Value::String(s) => escape_into(s, out),
        Value::Null => {}
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&n.to_string()),
        other => escape_into(&serde_json::to_string(other).unwrap_or_default(), out),
    }
}

fn as_u128(res: &Res) -> Option<u128> {
    match res {
        Res::Val(Value::String(s)) => s.trim().parse().ok(),
        Res::Val(Value::Number(n)) => n.as_u64().map(u128::from),
        Res::Index(i) => Some(*i as u128),
        _ => None,
    }
}

/// HTML-escape `& < > " ' \` =`.
pub fn escape_into(text: &str, out: &mut String) {
    let mut start = 0;
    for (i, byte) in text.bytes().enumerate() {
        let entity = match byte {
            b'&' => "&amp;",
            b'<' => "&lt;",
            b'>' => "&gt;",
            b'"' => "&quot;",
            b'\'' => "&#39;",
            b'`' => "&#96;",
            b'=' => "&#61;",
            _ => continue,
        };
        out.push_str(&text[start..i]);
        out.push_str(entity);
        start = i + 1;
    }
    out.push_str(&text[start..]);
}

fn percent_encode_into(text: &str, out: &mut String) {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push('%');
            out.push(HEX[(byte >> 4) as usize] as char);
            out.push(HEX[(byte & 0x0f) as usize] as char);
        }
    }
}

/// Nanoseconds since the epoch as `YYYY-MM-DD HH:MM UTC`.
pub fn format_date(ns: u64) -> String {
    let secs = ns / 1_000_000_000;
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02} UTC",
        rem / 3600,
        (rem % 3600) / 60
    )
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// yoctoNEAR as NEAR with four decimal places, truncated.
pub fn format_near(yocto: u128) -> String {
    const ONE: u128 = 1_000_000_000_000_000_000_000_000;
    let whole = yocto / ONE;
    let frac = (yocto % ONE) / 100_000_000_000_000_000_000;
    format!("{whole}.{frac:04}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::serde_json::json;
    use std::collections::BTreeMap;

    struct Files(BTreeMap<&'static str, &'static str>);

    impl Loader for Files {
        fn load(&self, path: &str) -> Option<String> {
            self.0.get(path).map(|s| s.to_string())
        }
    }

    fn none() -> Files {
        Files(BTreeMap::new())
    }

    fn r(src: &str, ctx: Value) -> String {
        render(src, &ctx, &none()).expect("render")
    }

    #[test]
    fn escapes_by_default_and_has_no_raw_form() {
        let ctx = json!({ "a": { "b": "<script>alert('x')</script> & \"q\" `=`" } });
        assert_eq!(
            r("<p>{{ a.b }}</p>", ctx.clone()),
            "<p>&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; &amp; &quot;q&quot; &#96;&#61;&#96;</p>"
        );
        assert!(render("{{{a.b}}}", &ctx, &none()).unwrap_err().contains("raw"));
        assert_eq!(r("[{{missing.path}}]", ctx), "[]");
    }

    #[test]
    fn filters() {
        let ctx = json!({
            "t": "1731283200000000000",
            "n": 1731283260000000000u64,
            "y": "1230000000000000000000",
            "big": "25000000000000000000000000",
            "s": "a b/c?d=é",
            "text": "one <b>\r\ntwo",
            "list": [1, 2, 3],
            "obj": { "k": "<v>" }
        });
        assert_eq!(r("{{t | date}}", ctx.clone()), "2024-11-11 00:00 UTC");
        assert_eq!(r("{{n|date}}", ctx.clone()), "2024-11-11 00:01 UTC");
        assert_eq!(r("{{y | near}}", ctx.clone()), "0.0012");
        assert_eq!(r("{{big | near}}", ctx.clone()), "25.0000");
        assert_eq!(r("{{s | url}}", ctx.clone()), "a%20b%2Fc%3Fd%3D%C3%A9");
        assert_eq!(r("{{text | lines}}", ctx.clone()), "one &lt;b&gt;<br>two");
        assert_eq!(r("{{list | count}} {{obj|count}} {{nope|count}}", ctx.clone()), "3 1 0");
        assert_eq!(
            r("{{obj | json}}", ctx.clone()),
            "{&quot;k&quot;:&quot;&lt;v&gt;&quot;}"
        );
        assert!(render("{{s | shout}}", &ctx, &none()).unwrap_err().contains("unknown filter"));
    }

    #[test]
    fn each_if_unless_else_and_scopes() {
        let ctx = json!({
            "title": "Board",
            "docs": [
                { "id": "1", "data": { "title": "first" }, "hidden": false },
                { "id": "2", "data": { "title": "<second>" }, "hidden": true }
            ],
            "empty": [],
            "zero": 0,
            "tags": ["a", "b"]
        });
        let out = r(
            "{{#each docs}}{{@index}}:{{id}}={{data.title}}/{{title}}{{#if hidden}}!{{else}}.{{/if}};{{/each}}",
            ctx.clone(),
        );
        assert_eq!(out, "0:1=first/Board.;1:2=&lt;second&gt;/Board!;");
        assert_eq!(r("{{#each empty}}x{{else}}none{{/each}}", ctx.clone()), "none");
        assert_eq!(r("{{#unless zero}}z{{/unless}}{{#if zero}}nz{{/if}}", ctx.clone()), "z");
        assert_eq!(r("{{#each tags}}[{{this}}]{{/each}}", ctx.clone()), "[a][b]");
        assert_eq!(r("{{docs.1.id}}{{! a comment }}", ctx.clone()), "2");
        assert!(render("{{#if a}}x", &ctx, &none()).is_err());
        assert!(render("{{#if a}}x{{/each}}", &ctx, &none()).is_err());
        assert!(render("{{/if}}", &ctx, &none()).is_err());
        assert!(render("{{#if a}}{{else}}{{else}}{{/if}}", &ctx, &none()).is_err());
        assert!(render("{{#loop a}}{{/loop}}", &ctx, &none()).is_err());
    }

    #[test]
    fn includes_up_to_depth_four() {
        let mut files = BTreeMap::new();
        files.insert("a.html", "A{{> b.html}}");
        files.insert("b.html", "B{{> c.html}}");
        files.insert("c.html", "C{{> d.html}}");
        files.insert("d.html", "D{{name}}");
        files.insert("e.html", "E{{> e.html}}");
        let files = Files(files);
        let ctx = json!({ "name": "<n>" });
        assert_eq!(render("{{> a.html}}", &ctx, &files).unwrap(), "ABCD&lt;n&gt;");
        assert!(check("{{> a.html}}", &files).is_ok());
        let err = render("{{> e.html}}", &ctx, &files).unwrap_err();
        assert!(err.contains("deeper than 4"), "{err}");
        assert!(check("{{> e.html}}", &files).is_err());
        assert!(check("{{> missing.html}}", &files).is_err());
        assert!(check("{{> ../x.html}}", &files).is_err());
    }
}

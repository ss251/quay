//! Routes (section 4): a release may declare up to 16 routes that `web4_get`
//! checks before static files, for production and for `/r/<id>/` previews.
//! Routes are sealed with the release; the data they read is live.

use near_sdk::serde_json::{self, Map, Value};
use crate::coll::Map as Stored;
use near_sdk::{env, near, AccountId};

use crate::db::{doc_id_ok, name_ok, ListQuery, Order, MAX_LIMIT, MAX_NAME_BYTES};
use crate::template::{self, Loader};
use crate::types::{Release, StoredFile, Web4Request, Web4Response, NOT_FOUND_PATH};
use crate::{bad_part, check_content_type, check_id_ok, text_response, Contract, CACHE_FRESH};

pub const MAX_ROUTES: usize = 16;
const MAX_PATTERN_BYTES: usize = 128;
const MAX_PARAM_BYTES: usize = 32;
const MAX_QUERY_KEYS: usize = 32;
const HTML: &str = "text/html; charset=utf-8";
const JSON: &str = "application/json; charset=utf-8";

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum RouteKind {
    Doc,
    List,
    Json,
}

/// A route as `seal` takes it and `get_release` returns it.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct RouteIn {
    pub pattern: String,
    pub kind: RouteKind,
    pub collection: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<Order>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned_first: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_type: Option<String>,
    /// List routes: only docs whose id starts with this (`"digest-"` on `_fn`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefix: Option<String>,
    /// Doc and list routes: up to 3 extra lists, rendered as `lists.<name>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub also: Option<Vec<AlsoList>>,
}

/// An extra list a page route loads next to its own data.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct AlsoList {
    pub name: String,
    pub collection: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefix: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<Order>,
}

pub const MAX_ALSO: usize = 3;
pub const MAX_ALSO_LIMIT: u32 = 10;
const DEFAULT_ALSO_LIMIT: u32 = 5;
/// An extra list reads at most this many sequence numbers, so a page with
/// three of them stays well inside a view call.
const ALSO_PROBES: u32 = 50;

fn prefix_ok(prefix: &str) -> bool {
    prefix.len() <= crate::db::MAX_DOC_ID_BYTES
        && prefix.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

enum Seg<'a> {
    Lit(&'a str),
    Param(&'a str),
    Rest(&'a str),
}

/// Reads stored (on-chain) text files of one release for templates.
pub(crate) struct FileLoader<'a> {
    pub chunks: &'a Stored<String, Vec<u8>>,
    pub files: &'a [StoredFile],
}

impl Loader for FileLoader<'_> {
    fn load(&self, path: &str) -> Option<String> {
        let file = self.files.iter().find(|file| file.path == path)?;
        if file.chunks.is_empty() {
            return None;
        }
        let mut bytes = Vec::new();
        for hash in &file.chunks {
            bytes.extend_from_slice(&self.chunks.get(hash)?);
        }
        String::from_utf8(bytes).ok()
    }
}

fn param_name_ok(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_PARAM_BYTES
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

fn parse_pattern(pattern: &str) -> Result<Vec<Seg<'_>>, &'static str> {
    if pattern.len() > MAX_PATTERN_BYTES {
        return Err("at most 128 bytes");
    }
    let Some(body) = pattern.strip_prefix('/') else {
        return Err("must start with /");
    };
    let body = body.strip_suffix('/').unwrap_or(body);
    if body.is_empty() {
        return Ok(Vec::new());
    }
    let parts: Vec<&str> = body.split('/').collect();
    let last = parts.len() - 1;
    let mut segs = Vec::with_capacity(parts.len());
    let mut names: Vec<&str> = Vec::new();
    for (i, part) in parts.into_iter().enumerate() {
        let seg = if let Some(name) = part.strip_prefix(':') {
            if !param_name_ok(name) {
                return Err("bad :param name");
            }
            Seg::Param(name)
        } else if let Some(name) = part.strip_prefix('*') {
            if i != last {
                return Err("*rest must be the last segment");
            }
            if !param_name_ok(name) {
                return Err("bad *rest name");
            }
            Seg::Rest(name)
        } else {
            let ok = !bad_part(part)
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
            if !ok {
                return Err("bad literal segment");
            }
            if i == 0 && part == "r" {
                return Err("/r/ is reserved for previews");
            }
            Seg::Lit(part)
        };
        if let Seg::Param(name) | Seg::Rest(name) = seg {
            if names.contains(&name) {
                return Err("duplicate param name");
            }
            names.push(name);
        }
        segs.push(seg);
    }
    Ok(segs)
}

fn match_pattern(pattern: &str, rel: &str) -> Option<Vec<(String, String)>> {
    let segs = parse_pattern(pattern).ok()?;
    let parts: Vec<&str> = if rel.is_empty() {
        Vec::new()
    } else {
        rel.split('/').collect()
    };
    let mut params = Vec::new();
    let mut i = 0;
    for seg in segs {
        match seg {
            Seg::Lit(lit) => {
                if parts.get(i) != Some(&lit) {
                    return None;
                }
                i += 1;
            }
            Seg::Param(name) => {
                params.push((name.to_string(), parts.get(i)?.to_string()));
                i += 1;
            }
            Seg::Rest(name) => {
                params.push((name.to_string(), parts[i.min(parts.len())..].join("/")));
                i = parts.len();
            }
        }
    }
    (i == parts.len()).then_some(params)
}

/// Validate and normalize the routes of a release being sealed. Panics name
/// the route pattern.
pub(crate) fn check_routes(routes: Vec<RouteIn>, loader: &FileLoader) -> Vec<RouteIn> {
    if routes.len() > MAX_ROUTES {
        env::panic_str("at most 16 routes");
    }
    routes.into_iter().map(|route| check_route(route, loader)).collect()
}

fn check_route(mut route: RouteIn, loader: &FileLoader) -> RouteIn {
    let pattern = route.pattern.clone();
    let names: Vec<String> = match parse_pattern(&route.pattern) {
        Ok(segs) => segs
            .iter()
            .filter_map(|seg| match seg {
                Seg::Param(name) | Seg::Rest(name) => Some(name.to_string()),
                Seg::Lit(_) => None,
            })
            .collect(),
        Err(reason) => route_fail(&pattern, reason),
    };
    let has = |name: &str| names.iter().any(|n| n == name);
    if route.collection != "*" && !name_ok(&route.collection, 1, MAX_NAME_BYTES) {
        route_fail(&pattern, "bad collection name");
    }
    if let Some(limit) = route.limit {
        if limit == 0 || limit > MAX_LIMIT {
            route_fail(&pattern, "limit must be 1 to 50");
        }
    }
    let content_type = route.content_type.take().map(|ct| check_content_type(&ct));
    if let Some(prefix) = &route.prefix {
        if !prefix_ok(prefix) {
            route_fail(&pattern, "bad prefix");
        }
        if route.kind != RouteKind::List {
            route_fail(&pattern, "only list routes take a prefix");
        }
    }
    if let Some(also) = route.also.as_mut() {
        if route.kind == RouteKind::Json {
            route_fail(&pattern, "json routes take no also lists");
        }
        if also.len() > MAX_ALSO {
            route_fail(&pattern, "at most 3 also lists");
        }
        let mut names: Vec<String> = Vec::new();
        for list in also.iter_mut() {
            if !param_name_ok(&list.name) || names.contains(&list.name) {
                route_fail(&pattern, "also lists need distinct names of a-z 0-9 _");
            }
            names.push(list.name.clone());
            if !name_ok(&list.collection, 1, MAX_NAME_BYTES) {
                route_fail(&pattern, "bad also collection name");
            }
            if list.prefix.as_deref().is_some_and(|p| !prefix_ok(p)) {
                route_fail(&pattern, "bad also prefix");
            }
            let limit = list.limit.unwrap_or(DEFAULT_ALSO_LIMIT);
            if limit == 0 || limit > MAX_ALSO_LIMIT {
                route_fail(&pattern, "also limit must be 1 to 10");
            }
            list.limit = Some(limit);
            list.order = Some(list.order.unwrap_or_default());
        }
    }
    match route.kind {
        RouteKind::Doc | RouteKind::List => {
            if route.collection == "*" {
                route_fail(&pattern, "only json routes take collection *");
            }
            let path = route
                .template
                .clone()
                .unwrap_or_else(|| route_fail(&pattern, "doc and list routes need a template"));
            let src = loader
                .load(&path)
                .unwrap_or_else(|| route_fail(&pattern, "template is not a stored text file in this release"));
            if let Err(reason) = template::check(&src, loader) {
                route_fail(&pattern, &format!("template {path}: {reason}"));
            }
            if route.kind == RouteKind::Doc {
                if !has("id") {
                    route_fail(&pattern, "doc routes need an :id segment");
                }
                route.limit = None;
                route.order = None;
                route.pinned_first = None;
            } else {
                route.limit = Some(route.limit.unwrap_or(crate::db::DEFAULT_LIMIT));
                route.order = Some(route.order.unwrap_or_default());
                route.pinned_first = Some(route.pinned_first.unwrap_or(false));
            }
        }
        RouteKind::Json => {
            if route.collection == "*" && !has("collection") {
                route_fail(&pattern, "json routes on collection * need a :collection segment");
            }
            route.template = None;
        }
    }
    route.content_type = content_type;
    route
}

fn route_fail(pattern: &str, reason: &str) -> ! {
    env::panic_str(&format!("bad route {pattern}: {reason}"))
}

/// Split a gateway path into (preview release id, path inside the release).
/// `None` for paths the static router refuses too.
fn split_target(raw: &str) -> Option<(Option<String>, String)> {
    let path = raw.split('?').next().unwrap_or("");
    if path.contains('\\') || path.contains("//") {
        return None;
    }
    let trimmed = path.trim_matches('/');
    if let Some(rest) = trimmed.strip_prefix("r/") {
        let (id, rest) = rest.split_once('/').unwrap_or((rest, ""));
        let id = check_id_ok(id)?;
        let rest = rest.trim_end_matches('/');
        if !rest.is_empty() && rest.split('/').any(bad_part) {
            return None;
        }
        return Some((Some(id), rest.to_string()));
    }
    if !trimmed.is_empty() && trimmed.split('/').any(bad_part) {
        return None;
    }
    Some((None, trimmed.to_string()))
}

fn query_values(query: &Map<String, Value>) -> Map<String, Value> {
    let mut out = Map::new();
    for (key, value) in query.iter().take(MAX_QUERY_KEYS) {
        let first = match value {
            Value::Array(items) => items.first().and_then(Value::as_str),
            Value::String(s) => Some(s.as_str()),
            _ => None,
        };
        if let Some(first) = first {
            out.insert(key.clone(), Value::String(first.to_string()));
        }
    }
    out
}

fn query_str<'a>(query: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    query.get(key).and_then(Value::as_str)
}

fn respond(status: u32, content_type: &str, body: Vec<u8>) -> Web4Response {
    Web4Response {
        content_type: Some(content_type.to_string()),
        status: Some(status),
        body: Some(body.into()),
        body_url: None,
        preload_urls: None,
        cache_control: Some(CACHE_FRESH.to_string()),
    }
}

impl Contract {
    /// The routed response for `request`, or `None` to fall through to files.
    pub(crate) fn serve_routes(&self, request: &Web4Request) -> Option<Web4Response> {
        let (preview, rel) = split_target(&request.path)?;
        let id = match preview {
            Some(id) => id,
            None => self.production.clone()?,
        };
        let routes = self.routes.get(&id)?;
        let release = self.releases.get(&id)?;
        for route in &routes {
            let Some(params) = match_pattern(&route.pattern, &rel) else {
                continue;
            };
            let param = |name: &str| {
                params
                    .iter()
                    .find(|(key, _)| key == name)
                    .map(|(_, value)| value.as_str())
            };
            let collection = match (route.kind, param("collection")) {
                (RouteKind::Json, Some(named)) => {
                    if route.collection != "*" && route.collection != named {
                        continue;
                    }
                    named.to_string()
                }
                _ => route.collection.clone(),
            };
            let query = query_values(&request.query);
            return Some(match route.kind {
                RouteKind::Json => self.json_route(route, &collection, param("id"), &query),
                _ => self.page_route(&id, &release, route, &collection, &params, &query, request),
            });
        }
        None
    }

    fn json_route(
        &self,
        route: &RouteIn,
        collection: &str,
        id: Option<&str>,
        query: &Map<String, Value>,
    ) -> Web4Response {
        let content_type = route.content_type.as_deref().unwrap_or(JSON);
        let missing = || respond(404, content_type, br#"{"error":"not found"}"#.to_vec());
        if !name_ok(collection, 1, MAX_NAME_BYTES) || !self.db.collections.contains_key(collection) {
            return missing();
        }
        let body = match id {
            Some(id) => {
                let doc = doc_id_ok(id)
                    .then(|| self.db_get(collection.to_string(), id.to_string()))
                    .flatten()
                    .filter(|doc| !doc.hidden);
                match doc {
                    Some(doc) => serde_json::to_vec(&doc),
                    None => return missing(),
                }
            }
            None => {
                let list = ListQuery {
                    from: query_str(query, "from").and_then(|s| s.parse().ok()).map(near_sdk::json_types::U64),
                    limit: query_str(query, "limit")
                        .and_then(|s| s.parse().ok())
                        .or(route.limit),
                    order: match query_str(query, "order") {
                        Some("asc") => Some(Order::Asc),
                        Some("desc") => Some(Order::Desc),
                        _ => route.order,
                    },
                    owner: query_str(query, "owner").and_then(|s| s.parse::<AccountId>().ok()),
                    prefix: query_str(query, "prefix").map(str::to_string),
                    include_hidden: None,
                    pinned_first: route.pinned_first,
                };
                serde_json::to_vec(&self.list_page(collection, &list))
            }
        };
        match body {
            Ok(body) => respond(200, content_type, body),
            Err(_) => respond(500, content_type, br#"{"error":"encode failed"}"#.to_vec()),
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn page_route(
        &self,
        release_id: &str,
        release: &Release,
        route: &RouteIn,
        collection: &str,
        params: &[(String, String)],
        query: &Map<String, Value>,
        request: &Web4Request,
    ) -> Web4Response {
        let site = env::current_account_id();
        let mut ctx = Map::new();
        ctx.insert(
            "site".to_string(),
            serde_json::json!({
                "account": site,
                "release": release_id,
                "host": format!("https://{site}.page"),
            }),
        );
        let params_obj: Map<String, Value> = params
            .iter()
            .map(|(key, value)| (key.clone(), Value::String(value.clone())))
            .collect();
        ctx.insert("params".to_string(), Value::Object(params_obj));
        ctx.insert("query".to_string(), Value::Object(query.clone()));
        let viewer = request
            .account_id
            .as_deref()
            .and_then(|s| s.parse::<AccountId>().ok())
            .map_or(Value::Null, |id| Value::String(id.to_string()));
        ctx.insert("viewer".to_string(), viewer);
        ctx.insert(
            "now".to_string(),
            Value::String(env::block_timestamp().to_string()),
        );
        if let Some(also) = &route.also {
            let mut lists = Map::new();
            for list in also {
                let query = ListQuery {
                    limit: list.limit,
                    order: list.order,
                    prefix: list.prefix.clone(),
                    ..Default::default()
                };
                let page = self.list_page_probes(&list.collection, &query, ALSO_PROBES);
                lists.insert(
                    list.name.clone(),
                    serde_json::to_value(&page.docs).unwrap_or(Value::Null),
                );
            }
            ctx.insert("lists".to_string(), Value::Object(lists));
        }
        match route.kind {
            RouteKind::Doc => {
                let id = params
                    .iter()
                    .find(|(key, _)| key == "id")
                    .map(|(_, value)| value.as_str())
                    .unwrap_or("");
                let doc = doc_id_ok(id)
                    .then(|| self.db_get(collection.to_string(), id.to_string()))
                    .flatten()
                    .filter(|doc| !doc.hidden);
                let Some(doc) = doc else {
                    return self.routed_not_found(release_id, release);
                };
                ctx.insert("doc".to_string(), serde_json::to_value(doc).unwrap_or(Value::Null));
            }
            _ => {
                let list = ListQuery {
                    from: query_str(query, "from").and_then(|s| s.parse().ok()).map(near_sdk::json_types::U64),
                    limit: route.limit,
                    order: route.order,
                    owner: query_str(query, "owner").and_then(|s| s.parse::<AccountId>().ok()),
                    prefix: route.prefix.clone(),
                    include_hidden: None,
                    pinned_first: route.pinned_first,
                };
                let page = self.list_page(collection, &list);
                ctx.insert(
                    "docs".to_string(),
                    serde_json::to_value(&page.docs).unwrap_or(Value::Null),
                );
                ctx.insert(
                    "next".to_string(),
                    page.next.map_or(Value::Null, |next| Value::String(next.0.to_string())),
                );
            }
        }
        let loader = FileLoader {
            chunks: &self.chunks,
            files: &release.files,
        };
        let path = route.template.as_deref().unwrap_or("");
        let rendered = loader
            .load(path)
            .ok_or_else(|| "template missing".to_string())
            .and_then(|src| template::render(&src, &Value::Object(ctx), &loader));
        match rendered {
            Ok(html) => respond(
                200,
                route.content_type.as_deref().unwrap_or(HTML),
                html.into_bytes(),
            ),
            Err(reason) => {
                let mut safe = String::new();
                template::escape_into(&reason, &mut safe);
                text_response(500, &format!("template error: {safe}"))
            }
        }
    }

    fn routed_not_found(&self, release_id: &str, release: &Release) -> Web4Response {
        match release.files.iter().find(|file| file.path == NOT_FOUND_PATH) {
            Some(file) => self.file_response(release_id, file, 404, CACHE_FRESH),
            None => text_response(404, "not found"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patterns_match_literals_params_and_rest() {
        let m = |p: &str, rel: &str| match_pattern(p, rel);
        assert_eq!(m("/", ""), Some(vec![]));
        assert_eq!(m("/", "posts"), None);
        assert_eq!(
            m("/posts/:id", "posts/12"),
            Some(vec![("id".to_string(), "12".to_string())])
        );
        assert_eq!(m("/posts/:id", "posts"), None);
        assert_eq!(m("/posts/:id", "posts/12/x"), None);
        assert_eq!(m("/posts/", "posts"), Some(vec![]));
        assert_eq!(
            m("/files/*rest", "files/a/b.txt"),
            Some(vec![("rest".to_string(), "a/b.txt".to_string())])
        );
        assert_eq!(
            m("/files/*rest", "files"),
            Some(vec![("rest".to_string(), String::new())])
        );
        assert!(parse_pattern("posts").is_err());
        assert!(parse_pattern("/r/:id").is_err());
        assert!(parse_pattern("/*a/b").is_err());
        assert!(parse_pattern("/:id/:id").is_err());
        assert!(parse_pattern("/a//b").is_err());
        assert!(parse_pattern("/../x").is_err());
        assert!(parse_pattern("/:Bad").is_err());
    }

    #[test]
    fn split_target_matches_the_static_router() {
        assert_eq!(split_target("/"), Some((None, String::new())));
        assert_eq!(split_target("/posts/12/"), Some((None, "posts/12".to_string())));
        assert_eq!(split_target("/r/7"), Some((Some("7".to_string()), String::new())));
        assert_eq!(
            split_target("/r/7/posts/1"),
            Some((Some("7".to_string()), "posts/1".to_string()))
        );
        assert_eq!(split_target("/r/7/../x"), None);
        assert_eq!(split_target("/a//b"), None);
        assert_eq!(split_target("/a\\b"), None);
    }
}

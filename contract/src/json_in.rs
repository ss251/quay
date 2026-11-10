//! Reading call arguments out of a parsed JSON `Value`, by hand.
//!
//! The wasm never calls a derived serde `Deserialize`. Each derived impl
//! costs a few KB, and serde's error messages pull in float formatting. The
//! derives stay on the types for tests and for `Serialize`, but generic code
//! that is never called is never compiled into the wasm.
//!
//! The rules follow what the derives accepted: a struct is a JSON object,
//! unknown keys are ignored, a required key must be present with the right
//! type, an `Option` reads a missing key or `null` as `None`, a `#[serde(default)]`
//! field reads a missing key as its default, `U64`/`U128` are decimal strings,
//! and enums are their lowercase names.

use near_sdk::base64::Engine;
use near_sdk::json_types::{Base64VecU8, U128, U64};
use near_sdk::serde_json::{Map, Value};
use near_sdk::{AccountId, PublicKey};

use crate::cron::JobIn;
use crate::db::{CollectionRules, ListQuery, Order, Payer, WriteRule};
use crate::functions::{FnPayer, FunctionSpec, TriggerRef};
use crate::pay::{Grant, Product};
use crate::routes::{AlsoList, RouteIn, RouteKind};
use crate::types::{ExternalIn, FileIn, Web4Request};

pub(crate) trait FromJson: Sized {
    fn from_json(value: Value) -> Option<Self>;
}

/// The fields of one JSON object.
pub(crate) struct Obj(Map<String, Value>);

impl Obj {
    pub fn new(value: Value) -> Option<Self> {
        match value {
            Value::Object(map) => Some(Obj(map)),
            _ => None,
        }
    }

    /// A required field.
    pub fn req<T: FromJson>(&mut self, key: &str) -> Option<T> {
        T::from_json(self.0.remove(key)?)
    }

    /// An `Option` field: missing or `null` is `None`.
    pub fn opt<T: FromJson>(&mut self, key: &str) -> Option<Option<T>> {
        match self.0.remove(key) {
            None | Some(Value::Null) => Some(None),
            Some(value) => T::from_json(value).map(Some),
        }
    }

    /// A `#[serde(default)]` field: missing is `default`.
    pub fn or<T: FromJson>(&mut self, key: &str, default: impl FnOnce() -> T) -> Option<T> {
        match self.0.remove(key) {
            None => Some(default()),
            Some(value) => T::from_json(value),
        }
    }
}

impl FromJson for Value {
    fn from_json(value: Value) -> Option<Self> {
        Some(value)
    }
}

impl FromJson for String {
    fn from_json(value: Value) -> Option<Self> {
        match value {
            Value::String(s) => Some(s),
            _ => None,
        }
    }
}

impl FromJson for bool {
    fn from_json(value: Value) -> Option<Self> {
        value.as_bool()
    }
}

impl FromJson for u64 {
    fn from_json(value: Value) -> Option<Self> {
        match value {
            Value::Number(n) => n.as_u64(),
            _ => None,
        }
    }
}

impl FromJson for u32 {
    fn from_json(value: Value) -> Option<Self> {
        u64::from_json(value).and_then(|n| u32::try_from(n).ok())
    }
}

impl FromJson for U64 {
    fn from_json(value: Value) -> Option<Self> {
        String::from_json(value)?.parse().ok().map(U64)
    }
}

impl FromJson for U128 {
    fn from_json(value: Value) -> Option<Self> {
        String::from_json(value)?.parse().ok().map(U128)
    }
}

impl FromJson for AccountId {
    fn from_json(value: Value) -> Option<Self> {
        String::from_json(value)?.parse().ok()
    }
}

impl FromJson for PublicKey {
    fn from_json(value: Value) -> Option<Self> {
        String::from_json(value)?.parse().ok()
    }
}

impl FromJson for Base64VecU8 {
    fn from_json(value: Value) -> Option<Self> {
        let text = String::from_json(value)?;
        near_sdk::base64::engine::general_purpose::STANDARD
            .decode(text.as_bytes())
            .ok()
            .map(Base64VecU8)
    }
}

impl<T: FromJson> FromJson for Option<T> {
    fn from_json(value: Value) -> Option<Self> {
        match value {
            Value::Null => Some(None),
            other => T::from_json(other).map(Some),
        }
    }
}

impl<T: FromJson> FromJson for Vec<T> {
    fn from_json(value: Value) -> Option<Self> {
        match value {
            Value::Array(items) => items.into_iter().map(T::from_json).collect(),
            _ => None,
        }
    }
}

impl FromJson for Map<String, Value> {
    fn from_json(value: Value) -> Option<Self> {
        match value {
            Value::Object(map) => Some(map),
            _ => None,
        }
    }
}

/// A unit enum read from its lowercase name.
macro_rules! name_enum {
    ($ty:ty { $($name:literal => $variant:expr),+ $(,)? }) => {
        impl FromJson for $ty {
            fn from_json(value: Value) -> Option<Self> {
                match value.as_str()? {
                    $($name => Some($variant),)+
                    _ => None,
                }
            }
        }
    };
}

name_enum!(WriteRule { "owner" => WriteRule::Owner, "anyone" => WriteRule::Anyone, "members" => WriteRule::Members });
name_enum!(Payer { "writer" => Payer::Writer, "site" => Payer::Site });
name_enum!(Order { "asc" => Order::Asc, "desc" => Order::Desc });
name_enum!(RouteKind { "doc" => RouteKind::Doc, "list" => RouteKind::List, "json" => RouteKind::Json });
name_enum!(FnPayer { "caller" => FnPayer::Caller, "site" => FnPayer::Site });
name_enum!(Grant { "pin" => Grant::Pin, "receipt" => Grant::Receipt });

impl FromJson for CollectionRules {
    fn from_json(value: Value) -> Option<Self> {
        let mut o = Obj::new(value)?;
        Some(CollectionRules {
            write: o.req("write")?,
            max_doc_bytes: o.req("max_doc_bytes")?,
            moderated: o.req("moderated")?,
            payer: o.req("payer")?,
            max_docs_per_account: o.opt("max_docs_per_account")?,
            on_add: o.opt("on_add")?,
        })
    }
}

impl FromJson for ListQuery {
    fn from_json(value: Value) -> Option<Self> {
        let mut o = Obj::new(value)?;
        Some(ListQuery {
            from: o.opt("from")?,
            limit: o.opt("limit")?,
            order: o.opt("order")?,
            owner: o.opt("owner")?,
            prefix: o.opt("prefix")?,
            include_hidden: o.opt("include_hidden")?,
            pinned_first: o.opt("pinned_first")?,
        })
    }
}

impl FromJson for ExternalIn {
    fn from_json(value: Value) -> Option<Self> {
        let mut o = Obj::new(value)?;
        Some(ExternalIn {
            cid: o.req("cid")?,
            size: o.req("size")?,
            sha256: o.req("sha256")?,
        })
    }
}

impl FromJson for FileIn {
    fn from_json(value: Value) -> Option<Self> {
        let mut o = Obj::new(value)?;
        Some(FileIn {
            path: o.req("path")?,
            chunks: o.or("chunks", Vec::new)?,
            content_type: o.req("content_type")?,
            external: o.opt("external")?,
        })
    }
}

impl FromJson for AlsoList {
    fn from_json(value: Value) -> Option<Self> {
        let mut o = Obj::new(value)?;
        Some(AlsoList {
            name: o.req("name")?,
            collection: o.req("collection")?,
            prefix: o.opt("prefix")?,
            limit: o.opt("limit")?,
            order: o.opt("order")?,
        })
    }
}

impl FromJson for RouteIn {
    fn from_json(value: Value) -> Option<Self> {
        let mut o = Obj::new(value)?;
        Some(RouteIn {
            pattern: o.req("pattern")?,
            kind: o.req("kind")?,
            collection: o.req("collection")?,
            template: o.opt("template")?,
            limit: o.opt("limit")?,
            order: o.opt("order")?,
            pinned_first: o.opt("pinned_first")?,
            content_type: o.opt("content_type")?,
            prefix: o.opt("prefix")?,
            also: o.opt("also")?,
        })
    }
}

impl FromJson for Web4Request {
    fn from_json(value: Value) -> Option<Self> {
        let mut o = Obj::new(value)?;
        Some(Web4Request {
            account_id: o.opt("accountId")?,
            path: o.or("path", String::new)?,
            query: o.or("query", Map::new)?,
            preloads: o.opt("preloads")?,
        })
    }
}

impl FromJson for Product {
    fn from_json(value: Value) -> Option<Self> {
        let mut o = Obj::new(value)?;
        Some(Product {
            name: o.req("name")?,
            price_yocto: o.opt("price_yocto")?,
            price_token: o.opt("price_token")?,
            grant: o.req("grant")?,
            pin_seconds: o.opt("pin_seconds")?,
        })
    }
}

impl FromJson for FunctionSpec {
    fn from_json(value: Value) -> Option<Self> {
        let mut o = Obj::new(value)?;
        Some(FunctionSpec {
            project: o.req("project")?,
            call: o.req("call")?,
            payer: o.req("payer")?,
            deposit: o.or("deposit", crate::functions::default_deposit)?,
            max_instructions: o.or("max_instructions", crate::functions::default_instructions)?,
            max_seconds: o.or("max_seconds", crate::functions::default_seconds)?,
            secrets: o.or("secrets", || false)?,
        })
    }
}

impl FromJson for JobIn {
    fn from_json(value: Value) -> Option<Self> {
        let mut o = Obj::new(value)?;
        Some(JobIn {
            every_minutes: o.req("every_minutes")?,
            func: o.req("fn")?,
            input: o.or("input", crate::cron::empty_object)?,
        })
    }
}

impl FromJson for TriggerRef {
    fn from_json(value: Value) -> Option<Self> {
        let mut o = Obj::new(value)?;
        Some(TriggerRef {
            collection: o.req("collection")?,
            id: o.req("id")?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::serde_json::{self, json};

    fn same<T: FromJson + near_sdk::serde::de::DeserializeOwned + std::fmt::Debug>(value: Value) {
        let mine = T::from_json(value.clone()).map(|v| format!("{v:?}"));
        let serde = serde_json::from_value::<T>(value.clone()).ok().map(|v| format!("{v:?}"));
        assert_eq!(mine, serde, "{value}");
    }

    #[test]
    fn agrees_with_the_serde_derives() {
        for v in [
            json!({ "write": "anyone", "max_doc_bytes": 10, "moderated": true, "payer": "site" }),
            json!({ "write": "anyone", "max_doc_bytes": 10, "moderated": true, "payer": "site", "max_docs_per_account": null, "on_add": "f", "x": 1 }),
            json!({ "write": "Anyone", "max_doc_bytes": 10, "moderated": true, "payer": "site" }),
            json!({ "write": "anyone", "max_doc_bytes": -1, "moderated": true, "payer": "site" }),
            json!({ "write": "anyone", "max_doc_bytes": 1.5, "moderated": true, "payer": "site" }),
            json!({ "write": "anyone", "max_doc_bytes": 4294967296u64, "moderated": true, "payer": "site" }),
            json!({ "write": "anyone", "moderated": true, "payer": "site" }),
            json!([1]),
        ] {
            same::<CollectionRules>(v);
        }
        for v in [json!({}), json!({ "from": "40", "limit": 5, "order": "asc", "owner": "a.testnet", "prefix": "p", "include_hidden": true, "pinned_first": false }), json!({ "from": 40 }), json!({ "owner": "Bad!" })] {
            same::<ListQuery>(v);
        }
        for v in [
            json!({ "path": "a", "content_type": "t" }),
            json!({ "path": "a", "content_type": "t", "chunks": ["x"], "external": { "cid": "c", "size": "5", "sha256": "s" } }),
            json!({ "path": "a", "content_type": "t", "chunks": null }),
            json!({ "path": "a", "content_type": "t", "external": { "cid": "c", "size": 5, "sha256": "s" } }),
        ] {
            same::<FileIn>(v);
        }
        for v in [
            json!({ "pattern": "/", "kind": "list", "collection": "posts", "template": "t.html", "limit": 2, "also": [{ "name": "a", "collection": "_fn", "prefix": "d-", "limit": 1, "order": "desc" }] }),
            json!({ "pattern": "/", "kind": "html", "collection": "posts" }),
        ] {
            same::<RouteIn>(v);
        }
        for v in [json!({}), json!({ "accountId": null, "path": "/x", "query": { "a": ["1"] }, "preloads": {}, "other": 1 }), json!({ "path": 5 })] {
            same::<Web4Request>(v);
        }
        for v in [json!({ "name": "n", "grant": "pin", "price_yocto": "10", "pin_seconds": 60 }), json!({ "name": "n", "grant": "gift" })] {
            same::<Product>(v);
        }
        for v in [json!({ "project": "a/b", "call": "owner", "payer": "site" }), json!({ "project": "a/b", "call": "owner", "payer": "site", "deposit": "7", "max_instructions": "9", "max_seconds": 3, "secrets": true })] {
            same::<FunctionSpec>(v);
        }
        for v in [json!({ "every_minutes": 5, "fn": "d" }), json!({ "every_minutes": 5, "fn": "d", "input": "{\"a\":1}" }), json!({ "every_minutes": "5", "fn": "d" })] {
            same::<JobIn>(v);
        }
        same::<TriggerRef>(json!({ "collection": "c", "id": "1" }));
        same::<Option<U128>>(json!("12"));
        same::<Option<U128>>(json!(12));
        same::<Base64VecU8>(json!("PHA+eDwvcD4="));
        same::<Base64VecU8>(json!("***"));
        same::<Vec<String>>(json!(["a", 1]));
        same::<PublicKey>(json!("ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp"));
        same::<AccountId>(json!("UPPER.testnet"));
    }
}

//! Building JSON values without `serde_json::to_value`.
//!
//! `json!` converts every field with `to_value`, which links serde_json's
//! `Value` serializer and one `Serialize` instance per field type. `obj!`
//! takes the same flat `{ "key": expr, ... }` form and converts each field
//! with `J`, which builds the `Value` directly. Nest objects with `obj!`.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::Value;
use near_sdk::AccountId;

pub(crate) trait J {
    fn j(self) -> Value;
}

impl J for Value {
    fn j(self) -> Value {
        self
    }
}

impl J for String {
    fn j(self) -> Value {
        Value::String(self)
    }
}

impl J for &str {
    fn j(self) -> Value {
        Value::String(self.to_string())
    }
}

impl J for AccountId {
    fn j(self) -> Value {
        Value::String(self.into())
    }
}

impl J for U128 {
    fn j(self) -> Value {
        Value::String(self.0.to_string())
    }
}

impl J for U64 {
    fn j(self) -> Value {
        Value::String(self.0.to_string())
    }
}

impl J for bool {
    fn j(self) -> Value {
        Value::Bool(self)
    }
}

impl J for u64 {
    fn j(self) -> Value {
        Value::from(self)
    }
}

impl J for u32 {
    fn j(self) -> Value {
        Value::from(self)
    }
}

impl J for usize {
    fn j(self) -> Value {
        Value::from(self as u64)
    }
}

impl<T: J> J for Option<T> {
    fn j(self) -> Value {
        self.map_or(Value::Null, J::j)
    }
}

/// An object from `"key": expr` pairs. Each expr is cloned, then converted.
macro_rules! obj {
    ({ $($key:literal : $value:expr),* $(,)? }) => {{
        #[allow(unused_mut)]
        let mut map = near_sdk::serde_json::Map::new();
        $( map.insert(String::from($key), $crate::jv::J::j(($value).clone())); )*
        near_sdk::serde_json::Value::Object(map)
    }};
}
pub(crate) use obj;

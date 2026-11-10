//! Write-through storage collections with the same on-chain layout as
//! `near_sdk::store`'s `LookupMap`, `Vector` and `IterableMap`.
//!
//! The `store` types keep a per-instantiation cache (`BTreeMap` of
//! `OnceCell`s) that is most of their code size. These read and write storage
//! directly. The layouts match `store` exactly, so state written by v1, v2 or
//! an earlier v3 build reads the same:
//!
//! - `Map`: `prefix ++ borsh(key)` holds `borsh(value)`. Borsh form: the prefix.
//! - `Seq`: `prefix ++ u32 index (LE)` holds `borsh(item)`. Borsh form: `u32`
//!   length, then the prefix.
//! - `IterMap`: keys in a `Seq` at `prefix ++ "v"`; values at
//!   `sha256(prefix ++ "m" ++ borsh(key))` as `borsh((value, key_index: u32))`.
//!
//! Every write goes to storage at once, so `env::storage_usage()` is exact
//! without a flush.

use std::borrow::Borrow;
use std::marker::PhantomData;

use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::{env, near};

fn decode<T: BorshDeserialize>(bytes: &[u8]) -> T {
    borsh::from_slice(bytes).unwrap_or_else(|_| env::panic_str("Cannot deserialize value with Borsh"))
}

fn encode<T: BorshSerialize + ?Sized>(value: &T) -> Vec<u8> {
    borsh::to_vec(value).unwrap_or_else(|_| env::panic_str("Cannot serialize value with Borsh"))
}

fn key_of<Q: BorshSerialize + ?Sized>(prefix: &[u8], key: &Q) -> Vec<u8> {
    let mut out = prefix.to_vec();
    key.serialize(&mut out).unwrap_or_else(|_| env::abort());
    out
}

/// Layout of `store::LookupMap<K, V>` (identity hasher).
#[near(serializers = [borsh])]
pub struct Map<K, V> {
    prefix: Vec<u8>,
    #[borsh(skip)]
    _types: PhantomData<(K, V)>,
}

impl<K: BorshSerialize, V: BorshSerialize + BorshDeserialize> Map<K, V> {
    pub fn new(prefix: &[u8]) -> Self {
        Self {
            prefix: prefix.to_vec(),
            _types: PhantomData,
        }
    }

    pub fn get<Q: BorshSerialize + ?Sized>(&self, key: &Q) -> Option<V>
    where
        K: Borrow<Q>,
    {
        env::storage_read(&key_of(&self.prefix, key)).map(|bytes| decode(&bytes))
    }

    pub fn contains_key<Q: BorshSerialize + ?Sized>(&self, key: &Q) -> bool
    where
        K: Borrow<Q>,
    {
        env::storage_has_key(&key_of(&self.prefix, key))
    }

    pub fn insert(&mut self, key: K, value: V) {
        env::storage_write(&key_of(&self.prefix, &key), &encode(&value));
    }

    /// Removes the entry and returns its value.
    pub fn remove<Q: BorshSerialize + ?Sized>(&mut self, key: &Q) -> Option<V>
    where
        K: Borrow<Q>,
    {
        let lookup = key_of(&self.prefix, key);
        let old = env::storage_read(&lookup).map(|bytes| decode(&bytes));
        if old.is_some() {
            env::storage_remove(&lookup);
        }
        old
    }

    /// Read, change and write back one entry. `false` when it is missing.
    pub fn update<Q: BorshSerialize + ?Sized>(&mut self, key: &Q, change: impl FnOnce(&mut V)) -> bool
    where
        K: Borrow<Q>,
    {
        let lookup = key_of(&self.prefix, key);
        let Some(bytes) = env::storage_read(&lookup) else {
            return false;
        };
        let mut value: V = decode(&bytes);
        change(&mut value);
        env::storage_write(&lookup, &encode(&value));
        true
    }
}

/// Layout of `store::Vector<T>`.
#[near(serializers = [borsh])]
pub struct Seq<T> {
    len: u32,
    prefix: Vec<u8>,
    #[borsh(skip)]
    _types: PhantomData<T>,
}

impl<T: BorshSerialize + BorshDeserialize> Seq<T> {
    pub fn new(prefix: &[u8]) -> Self {
        Self {
            len: 0,
            prefix: prefix.to_vec(),
            _types: PhantomData,
        }
    }

    pub fn len(&self) -> u32 {
        self.len
    }

    fn slot(&self, index: u32) -> Vec<u8> {
        let mut out = self.prefix.clone();
        out.extend_from_slice(&index.to_le_bytes());
        out
    }

    pub fn get(&self, index: u32) -> Option<T> {
        if index >= self.len {
            return None;
        }
        env::storage_read(&self.slot(index)).map(|bytes| decode(&bytes))
    }

    pub fn push(&mut self, item: T) {
        let next = self
            .len
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("Index out of bounds"));
        env::storage_write(&self.slot(self.len), &encode(&item));
        self.len = next;
    }

    /// Remove `index`, shifting later items down (keeps order).
    pub fn remove_shift(&mut self, index: u32) {
        if index >= self.len {
            env::panic_str("Index out of bounds");
        }
        for i in index + 1..self.len {
            if let Some(bytes) = env::storage_read(&self.slot(i)) {
                env::storage_write(&self.slot(i - 1), &bytes);
            }
        }
        self.len -= 1;
        env::storage_remove(&self.slot(self.len));
    }

    /// Remove `index`, moving the last item into its place.
    fn swap_remove(&mut self, index: u32) {
        let last = self.len - 1;
        if index != last {
            if let Some(bytes) = env::storage_read(&self.slot(last)) {
                env::storage_write(&self.slot(index), &bytes);
            }
        }
        env::storage_remove(&self.slot(last));
        self.len = last;
    }

    pub fn iter(&self) -> impl Iterator<Item = T> + '_ {
        (0..self.len).filter_map(move |index| self.get(index))
    }
}

#[near(serializers = [borsh])]
struct ValueAndIndex<V> {
    value: V,
    key_index: u32,
}

/// Layout of `store::IterableMap<K, V>` (sha256 hasher for values).
#[near(serializers = [borsh])]
pub struct IterMap<K, V> {
    keys: Seq<K>,
    values_prefix: Vec<u8>,
    #[borsh(skip)]
    _types: PhantomData<V>,
}

impl<K, V> IterMap<K, V>
where
    K: BorshSerialize + BorshDeserialize,
    V: BorshSerialize + BorshDeserialize,
{
    pub fn new(prefix: &[u8]) -> Self {
        let mut keys = prefix.to_vec();
        keys.push(b'v');
        let mut values = prefix.to_vec();
        values.push(b'm');
        Self {
            keys: Seq::new(&keys),
            values_prefix: values,
            _types: PhantomData,
        }
    }

    fn slot<Q: BorshSerialize + ?Sized>(&self, key: &Q) -> Vec<u8>
    where
        K: Borrow<Q>,
    {
        env::sha256(&key_of(&self.values_prefix, key))
    }

    fn entry<Q: BorshSerialize + ?Sized>(&self, key: &Q) -> Option<ValueAndIndex<V>>
    where
        K: Borrow<Q>,
    {
        env::storage_read(&self.slot(key)).map(|bytes| decode(&bytes))
    }

    pub fn len(&self) -> u32 {
        self.keys.len()
    }

    pub fn get<Q: BorshSerialize + ?Sized>(&self, key: &Q) -> Option<V>
    where
        K: Borrow<Q>,
    {
        self.entry(key).map(|entry| entry.value)
    }

    pub fn contains_key<Q: BorshSerialize + ?Sized>(&self, key: &Q) -> bool
    where
        K: Borrow<Q>,
    {
        env::storage_has_key(&self.slot(key))
    }

    pub fn insert(&mut self, key: K, value: V) {
        let slot = self.slot(&key);
        let key_index = match env::storage_read(&slot) {
            Some(bytes) => decode::<ValueAndIndex<V>>(&bytes).key_index,
            None => {
                let index = self.keys.len();
                self.keys.push(key);
                index
            }
        };
        env::storage_write(&slot, &encode(&ValueAndIndex { value, key_index }));
    }

    /// Read, change and write back one entry. `false` when it is missing.
    pub fn update<Q: BorshSerialize + ?Sized>(&mut self, key: &Q, change: impl FnOnce(&mut V)) -> bool
    where
        K: Borrow<Q>,
    {
        let slot = self.slot(key);
        let Some(bytes) = env::storage_read(&slot) else {
            return false;
        };
        let mut entry: ValueAndIndex<V> = decode(&bytes);
        change(&mut entry.value);
        env::storage_write(&slot, &encode(&entry));
        true
    }

    /// Removes the entry and returns its value.
    pub fn remove<Q: BorshSerialize + ?Sized>(&mut self, key: &Q) -> Option<V>
    where
        K: Borrow<Q>,
    {
        let slot = self.slot(key);
        let entry: ValueAndIndex<V> = decode(&env::storage_read(&slot)?);
        env::storage_remove(&slot);
        let last = self.keys.len() - 1;
        if entry.key_index != last {
            // The last key moves into the freed index; record its new index.
            if let Some(moved) = self.keys.get(last) {
                let moved_slot = self.slot::<K>(&moved);
                if let Some(bytes) = env::storage_read(&moved_slot) {
                    let mut moved_entry: ValueAndIndex<V> = decode(&bytes);
                    moved_entry.key_index = entry.key_index;
                    env::storage_write(&moved_slot, &encode(&moved_entry));
                }
            }
        }
        self.keys.swap_remove(entry.key_index);
        Some(entry.value)
    }

    pub fn keys(&self) -> impl Iterator<Item = K> + '_ {
        self.keys.iter()
    }

    pub fn iter(&self) -> impl Iterator<Item = (K, V)> + '_ {
        self.keys
            .iter()
            .filter_map(move |key| self.get(&key).map(|value| (key, value)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::store;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    /// Data written by `near_sdk::store` reads back through these types, and
    /// the other way round.
    #[test]
    fn layouts_match_near_sdk_store() {
        testing_env!(VMContextBuilder::new().build());
        {
            let mut map: store::LookupMap<String, u32> = store::LookupMap::new(b"a");
            map.insert("x".to_string(), 7);
            let mut vec: store::Vector<String> = store::Vector::new(b"b");
            vec.push("one".to_string());
            vec.push("two".to_string());
            let mut it: store::IterableMap<String, u64> = store::IterableMap::new(b"c");
            it.insert("k1".to_string(), 1);
            it.insert("k2".to_string(), 2);
            it.insert("k3".to_string(), 3);
            it.remove("k1");
            let bytes = borsh::to_vec(&(&map, &vec, &it)).unwrap();
            env::storage_write(b"held", &bytes);
        }
        let bytes = env::storage_read(b"held").unwrap();
        let (mut map, vec, mut it): (Map<String, u32>, Seq<String>, IterMap<String, u64>) =
            borsh::from_slice(&bytes).unwrap();
        assert_eq!(map.get("x"), Some(7));
        assert!(map.update("x", |v| *v += 1));
        assert_eq!(map.get("x"), Some(8));
        assert_eq!(vec.len(), 2);
        assert_eq!(vec.iter().collect::<Vec<_>>(), vec!["one", "two"]);
        let mut pairs: Vec<(String, u64)> = it.iter().collect();
        pairs.sort();
        assert_eq!(pairs, vec![("k2".to_string(), 2), ("k3".to_string(), 3)]);
        it.insert("k4".to_string(), 4);
        assert_eq!(it.remove("k3"), Some(3));
        let bytes = borsh::to_vec(&(&map, &vec, &it)).unwrap();
        let (map2, _vec2, it2): (store::LookupMap<String, u32>, store::Vector<String>, store::IterableMap<String, u64>) =
            borsh::from_slice(&bytes).unwrap();
        assert_eq!(map2.get("x"), Some(&8));
        let mut keys: Vec<String> = it2.keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, vec!["k2", "k4"]);
        assert_eq!(it2.get("k4"), Some(&4));
    }

    #[test]
    fn seq_remove_shift_keeps_order() {
        testing_env!(VMContextBuilder::new().build());
        let mut seq: Seq<u8> = Seq::new(b"s");
        for n in 0..5u8 {
            seq.push(n);
        }
        seq.remove_shift(1);
        assert_eq!(seq.iter().collect::<Vec<_>>(), vec![0, 2, 3, 4]);
        assert_eq!(seq.get(4), None);
    }
}

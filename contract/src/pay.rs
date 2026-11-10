//! Payments (section 9): products, `pay` in NEAR, `ft_on_transfer` from one
//! configured NEP-141 token, and receipts in the system collection `_receipts`.
//!
//! A NEAR receipt's storage comes out of the price. A token receipt's storage
//! comes from the site pool, since tokens cannot pay for storage.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::{self, Value};
use crate::coll::IterMap;
use near_sdk::store::LookupSet;
use near_sdk::{env, near, AccountId};

use crate::db::{
    doc_id_ok, name_ok, refund, ListQuery, PaidBy, MAX_NAME_BYTES, RECEIPTS,
};
use crate::{assert_self, emit, Contract};

pub const MAX_PRODUCTS: usize = 32;
pub const MAX_REF_BYTES: usize = 128;
pub const MAX_PRODUCT_NAME_CHARS: usize = 80;
pub const MAX_PIN_SECONDS: u64 = 31_536_000;
/// A receipt and its pin stay well under this. Token payments need this much
/// in the pool before they are accepted.
pub const RECEIPT_BYTES_BOUND: u128 = 1_000;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Grant {
    Pin,
    Receipt,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct Product {
    pub name: String,
    #[serde(default)]
    pub price_yocto: Option<U128>,
    #[serde(default)]
    pub price_token: Option<U128>,
    pub grant: Grant,
    #[serde(default)]
    pub pin_seconds: Option<u64>,
}

#[near(serializers = [json])]
pub struct ProductView {
    pub id: String,
    #[serde(flatten)]
    pub product: Product,
}

#[near(serializers = [json])]
pub struct ReceiptPage {
    pub receipts: Vec<Value>,
    pub next: Option<U64>,
}

#[near(serializers = [borsh])]
pub struct PayState {
    pub products: IterMap<String, Product>,
    /// `(buyer, product, ref or "")`.
    pub paid: LookupSet<(AccountId, String, String)>,
    pub token: Option<AccountId>,
}

impl PayState {
    pub fn new() -> Self {
        Self {
            products: IterMap::new(b"P"),
            paid: LookupSet::new(b"q"),
            token: None,
        }
    }
}

/// `msg` of a token payment.
#[near(serializers = [json])]
struct TokenMsg {
    product: String,
    #[serde(default, rename = "ref")]
    reference: Option<String>,
}

/// Where a pin lands: collection number and seq of an existing doc.
struct PinTarget {
    cid: u32,
    seq: u64,
}

impl Contract {
    pub fn set_product(&mut self, id: String, product: Product) {
        assert_self();
        near_sdk::assert_one_yocto();
        let id = check_product_id(&id);
        let product = check_product(product);
        if !self.pay.products.contains_key(&id) && self.pay.products.len() as usize >= MAX_PRODUCTS {
            env::panic_str("product list is full");
        }
        self.pay.products.insert(id.clone(), product);
        emit("product_set", &serde_json::json!({ "id": id }));
    }
    pub fn remove_product(&mut self, id: String) {
        assert_self();
        near_sdk::assert_one_yocto();
        if self.pay.products.remove(&id).is_none() {
            env::panic_str("product missing");
        }
        emit("product_removed", &serde_json::json!({ "id": id }));
    }

    pub fn get_product(&self, id: String) -> Option<Product> {
        self.pay.products.get(&id)
    }

    pub fn list_products(&self) -> Vec<ProductView> {
        self.pay
            .products
            .iter()
            .map(|(id, product)| ProductView {
                id: id.clone(),
                product: product.clone(),
            })
            .collect()
    }
    pub fn set_token(&mut self, account: Option<AccountId>) {
        assert_self();
        near_sdk::assert_one_yocto();
        self.pay.token = account.clone();
        emit("token_set", &serde_json::json!({ "account": account }));
    }

    pub fn get_token(&self) -> Option<AccountId> {
        self.pay.token.clone()
    }

    /// Pay for `product` in NEAR. The excess over the price is refunded.
    pub fn pay(&mut self, product: String, r#ref: Option<String>) {
        let item = self
            .pay
            .products
            .get(&product)
            .unwrap_or_else(|| env::panic_str("product missing"));
        let price = item
            .price_yocto
            .unwrap_or_else(|| env::panic_str("product has no NEAR price"))
            .0;
        let deposit = env::attached_deposit().as_yoctonear();
        if deposit < price {
            env::panic_str(&format!("attach at least {price} yoctoNEAR"));
        }
        let buyer = env::predecessor_account_id();
        let reference = check_ref(r#ref).unwrap_or_else(|reason| env::panic_str(reason));
        let target = self
            .grant_target(&item, reference.as_deref())
            .unwrap_or_else(|reason| env::panic_str(reason));
        let cost = self.record_payment(&buyer, &product, reference.clone(), price, "near", &item, target, PaidBy::Payment);
        if cost > price {
            env::panic_str("price does not cover receipt storage");
        }
        refund(&buyer, deposit - price);
    }

    /// NEP-141 receiver. Returns the unused amount: the excess over the price
    /// when accepted, the full amount when refused.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        match self.accept_token(&sender_id, amount.0, &msg) {
            Ok(unused) => U128(unused),
            Err(reason) => {
                env::log_str(&format!("payment refused: {reason}"));
                amount
            }
        }
    }

    pub fn has_paid(&self, account: AccountId, product: String, r#ref: Option<String>) -> bool {
        self.pay
            .paid
            .contains(&(account, product, r#ref.unwrap_or_default()))
    }

    pub fn list_receipts(&self, query: Option<ListQuery>) -> ReceiptPage {
        let page = self.list_page(RECEIPTS, &query.unwrap_or_default());
        ReceiptPage {
            receipts: page.docs.into_iter().map(|doc| doc.data).collect(),
            next: page.next,
        }
    }
}

impl Contract {
    fn accept_token(&mut self, sender: &AccountId, amount: u128, msg: &str) -> Result<u128, &'static str> {
        let token = env::predecessor_account_id();
        if self.pay.token.as_ref() != Some(&token) {
            return Err("token not accepted");
        }
        let msg: TokenMsg = serde_json::from_str(msg).map_err(|_| "bad msg")?;
        let item = self
            .pay
            .products
            .get(&msg.product)
            .ok_or("product missing")?;
        let price = item.price_token.ok_or("product has no token price")?.0;
        if amount < price {
            return Err("amount is below the price");
        }
        let reference = check_ref(msg.reference)?;
        let target = self.grant_target(&item, reference.as_deref())?;
        let bound = RECEIPT_BYTES_BOUND * env::storage_byte_cost().as_yoctonear();
        if self.db.pool_balance < bound {
            return Err("storage pool is empty");
        }
        let token_name = token.to_string();
        self.record_payment(sender, &msg.product, reference, price, &token_name, &item, target, PaidBy::Pool);
        Ok(amount - price)
    }

    /// For grant `pin`, the doc that `ref` names. Grant `receipt` needs nothing.
    fn grant_target(&self, item: &Product, reference: Option<&str>) -> Result<Option<PinTarget>, &'static str> {
        if item.grant != Grant::Pin {
            return Ok(None);
        }
        let reference = reference.ok_or("pin needs ref = <collection>/<id>")?;
        let (name, id) = reference
            .split_once('/')
            .ok_or("pin needs ref = <collection>/<id>")?;
        if name.starts_with('_') || !name_ok(name, 1, MAX_NAME_BYTES) || !doc_id_ok(id) {
            return Err("pin needs ref = <collection>/<id>");
        }
        let coll = self.db.collections.get(name).ok_or("pinned doc missing")?;
        let seq = self
            .db
            .ids
            .get(&(coll.cid, id.to_string()))
            .ok_or("pinned doc missing")?;
        if !self.pin_has_room(coll.cid, seq) {
            return Err("pin list is full");
        }
        Ok(Some(PinTarget { cid: coll.cid, seq }))
    }

    /// Write the receipt, mark `has_paid`, apply the grant, and charge the
    /// storage it took to `paid_by`. Returns that storage cost.
    #[allow(clippy::too_many_arguments)]
    fn record_payment(
        &mut self,
        buyer: &AccountId,
        product: &str,
        reference: Option<String>,
        amount: u128,
        token: &str,
        item: &Product,
        target: Option<PinTarget>,
        paid_by: PaidBy,
    ) -> u128 {
        let now = env::block_timestamp();
        let before = self.storage_mark();
        self.ensure_system(RECEIPTS);
        let data = serde_json::json!({
            "buyer": buyer,
            "product": product,
            "ref": reference,
            "amount": U128(amount),
            "token": token,
            "at": U64(now),
        })
        .to_string();
        let seq = self
            .db
            .collections
            .get(RECEIPTS)
            .map(|coll| coll.next_seq)
            .unwrap_or_else(|| env::panic_str("receipts missing"));
        let (seq, _) = self.insert_doc(RECEIPTS, seq.to_string(), buyer.clone(), data, paid_by);
        self.pay.paid.insert((
            buyer.clone(),
            product.to_string(),
            reference.clone().unwrap_or_default(),
        ));
        let mut pinned_until = None;
        if let Some(target) = target {
            let until = self
                .pin(target.cid, target.seq, item.pin_seconds.unwrap_or(0))
                .unwrap_or_else(|reason| env::panic_str(reason));
            pinned_until = Some(U64(until));
        }
        let after = self.storage_mark();
        let cost = u128::from(after.saturating_sub(before)) * env::storage_byte_cost().as_yoctonear();
        if paid_by == PaidBy::Pool {
            self.draw_pool(cost);
        }
        let receipts_cid = self
            .db
            .collections
            .get(RECEIPTS)
            .map(|coll| coll.cid)
            .unwrap_or_default();
        self.set_deposit(receipts_cid, seq, cost);
        emit(
            "paid",
            &serde_json::json!({
                "buyer": buyer,
                "product": product,
                "ref": reference,
                "amount": U128(amount),
                "token": token,
                "pinned_until": pinned_until,
            }),
        );
        cost
    }
}

fn check_product_id(id: &str) -> String {
    if !name_ok(id, 1, MAX_NAME_BYTES) {
        env::panic_str("bad product id");
    }
    id.to_string()
}

fn check_product(mut product: Product) -> Product {
    let name = product.name.trim().to_string();
    if name.is_empty()
        || name.chars().count() > MAX_PRODUCT_NAME_CHARS
        || name.chars().any(char::is_control)
    {
        env::panic_str("bad product name");
    }
    product.name = name;
    if product.price_yocto.is_none() && product.price_token.is_none() {
        env::panic_str("product needs price_yocto or price_token");
    }
    if product.price_yocto.is_some_and(|p| p.0 == 0) || product.price_token.is_some_and(|p| p.0 == 0) {
        env::panic_str("price must be above 0");
    }
    match product.grant {
        Grant::Pin => match product.pin_seconds {
            Some(secs) if (1..=MAX_PIN_SECONDS).contains(&secs) => {}
            _ => env::panic_str("pin_seconds must be 1 to 31536000"),
        },
        Grant::Receipt => product.pin_seconds = None,
    }
    product
}

/// `ref` is 1 to 128 bytes of `[A-Za-z0-9._/:-]`. Empty means none.
fn check_ref(reference: Option<String>) -> Result<Option<String>, &'static str> {
    match reference {
        None => Ok(None),
        Some(r) if r.is_empty() => Ok(None),
        Some(r) => {
            let ok = r.len() <= MAX_REF_BYTES
                && r
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'/' | b':' | b'-'));
            if ok {
                Ok(Some(r))
            } else {
                Err("bad ref")
            }
        }
    }
}

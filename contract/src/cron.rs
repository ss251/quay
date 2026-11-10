//! Scheduled jobs (section 8) on a yield chain.
//!
//! `cron_arm` yields `cron_tick` with all of the caller's remaining gas. A
//! yield times out after about 200 blocks (~2 minutes), its callback runs the
//! due jobs and yields again with what is left. A contract cannot add gas, so
//! the chain stops when fewer than 20 Tgas would remain. `cron_kick` resumes
//! the pending yield early.

use near_sdk::json_types::U64;
use near_sdk::serde_json;
use near_sdk::store::IterableMap;
use near_sdk::{env, near, Gas, GasWeight, YieldId};

use crate::db::{name_ok, PaidBy, MAX_NAME_BYTES};
use crate::functions::{check_input, Run, RESULT_GAS};
use crate::{assert_self, emit, Contract, ContractExt};

pub const MAX_JOBS: usize = 8;
pub const MIN_EVERY_MINUTES: u32 = 5;
const MAX_EVERY_MINUTES: u32 = 40_320;
/// Gas a job's `request_execution` gets; its result callback adds `RESULT_GAS`.
pub const JOB_REQUEST_GAS: Gas = Gas::from_tgas(45);
/// Yield again only when at least this much would remain.
pub const CONTINUE_GAS: Gas = Gas::from_tgas(20);
/// Gas kept for the tick's own work after jobs are launched.
const TICK_RESERVE: Gas = Gas::from_tgas(5);
/// `cron_arm` needs this much prepaid gas to be worth starting.
pub const MIN_ARM_GAS: Gas = Gas::from_tgas(50);
/// A chain with no tick for this long is dead and may be armed again.
const STALE_NS: u64 = 10 * 60 * 1_000_000_000;
/// `cron_kick` waits this long after the last tick.
const KICK_COOLDOWN_NS: u64 = 60 * 1_000_000_000;
const MINUTE_NS: u64 = 60 * 1_000_000_000;

#[near(serializers = [json])]
pub struct JobIn {
    pub every_minutes: u32,
    #[serde(rename = "fn")]
    pub func: String,
    #[serde(default = "empty_object")]
    pub input: String,
}

fn empty_object() -> String {
    "{}".to_string()
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Job {
    pub every_minutes: u32,
    pub func: String,
    pub input: String,
    pub last_run: u64,
}

#[near(serializers = [json])]
pub struct JobView {
    pub name: String,
    pub every_minutes: u32,
    #[serde(rename = "fn")]
    pub func: String,
    pub input: String,
    pub last_run: Option<U64>,
    pub next_due: U64,
}

#[near(serializers = [json])]
pub struct CronStatus {
    pub armed: bool,
    pub hops: U64,
    pub last_tick: Option<U64>,
    pub started: Option<U64>,
    pub pending: bool,
}

#[near(serializers = [borsh])]
pub struct CronState {
    pub jobs: IterableMap<String, Job>,
    pub armed: bool,
    /// Bumped on every arm, so a tick from an older chain stops itself.
    pub chain: u64,
    pub pending: Option<YieldId>,
    pub hops: u64,
    pub last_tick: u64,
    pub started: u64,
}

impl CronState {
    pub fn new() -> Self {
        Self {
            jobs: IterableMap::new(b"j"),
            armed: false,
            chain: 0,
            pending: None,
            hops: 0,
            last_tick: 0,
            started: 0,
        }
    }

    fn last_activity(&self) -> u64 {
        self.last_tick.max(self.started)
    }
}

#[near]
impl Contract {
    #[payable]
    pub fn cron_set(&mut self, name: String, job: JobIn) {
        assert_self();
        near_sdk::assert_one_yocto();
        if !name_ok(&name, 1, MAX_NAME_BYTES) {
            env::panic_str("bad job name");
        }
        if job.every_minutes < MIN_EVERY_MINUTES || job.every_minutes > MAX_EVERY_MINUTES {
            env::panic_str("every_minutes must be 5 to 40320");
        }
        if !self.fns.specs.contains_key(&job.func) {
            env::panic_str("function missing");
        }
        check_input(&job.input);
        let last_run = self.cron.jobs.get(&name).map_or(0, |old| old.last_run);
        if !self.cron.jobs.contains_key(&name) && self.cron.jobs.len() as usize >= MAX_JOBS {
            env::panic_str("job list is full");
        }
        self.cron.jobs.insert(
            name.clone(),
            Job {
                every_minutes: job.every_minutes,
                func: job.func,
                input: job.input,
                last_run,
            },
        );
        emit("cron_set", &serde_json::json!({ "name": name }));
    }

    #[payable]
    pub fn cron_remove(&mut self, name: String) {
        assert_self();
        near_sdk::assert_one_yocto();
        if self.cron.jobs.remove(&name).is_none() {
            env::panic_str("job missing");
        }
        emit("cron_removed", &serde_json::json!({ "name": name }));
    }

    pub fn cron_list(&self) -> Vec<JobView> {
        self.cron
            .jobs
            .iter()
            .map(|(name, job)| JobView {
                name: name.clone(),
                every_minutes: job.every_minutes,
                func: job.func.clone(),
                input: job.input.clone(),
                last_run: (job.last_run > 0).then_some(U64(job.last_run)),
                next_due: U64(next_due(job)),
            })
            .collect()
    }

    pub fn cron_status(&self) -> CronStatus {
        CronStatus {
            armed: self.cron.armed,
            hops: U64(self.cron.hops),
            last_tick: (self.cron.last_tick > 0).then_some(U64(self.cron.last_tick)),
            started: (self.cron.started > 0).then_some(U64(self.cron.started)),
            pending: self.cron.pending.is_some(),
        }
    }

    /// Start the chain. Anyone may; the caller's prepaid gas is its budget.
    pub fn cron_arm(&mut self) {
        let now = env::block_timestamp();
        if self.cron.armed && now < self.cron.last_activity().saturating_add(STALE_NS) {
            env::panic_str("cron is already armed");
        }
        if env::prepaid_gas() < MIN_ARM_GAS {
            env::panic_str("cron_arm needs gas for the chain: attach up to 1 PGas");
        }
        self.cron.chain += 1;
        self.cron.armed = true;
        self.cron.started = now;
        self.cron.last_tick = 0;
        self.cron.hops = 0;
        self.yield_next();
        emit(
            "cron_armed",
            &serde_json::json!({ "chain": self.cron.chain, "by": env::predecessor_account_id() }),
        );
    }

    /// Resume the pending yield now. At most once a minute.
    pub fn cron_kick(&mut self) {
        let Some(pending) = self.cron.pending else {
            env::panic_str("nothing to kick");
        };
        if env::block_timestamp() < self.cron.last_activity().saturating_add(KICK_COOLDOWN_NS) {
            env::panic_str("kicked too soon: wait a minute after the last tick");
        }
        self.cron.pending = None;
        if pending.resume(b"\"kick\"").is_err() {
            env::panic_str("the pending tick has already run");
        }
    }

    /// One hop: run the due jobs, then yield again or stop.
    #[private]
    pub fn cron_tick(&mut self, chain: u64) {
        if chain != self.cron.chain || !self.cron.armed {
            env::log_str("cron tick from an old chain: stopped");
            return;
        }
        let now = env::block_timestamp();
        self.cron.pending = None;
        self.cron.hops += 1;
        self.cron.last_tick = now;
        let job_gas = JOB_REQUEST_GAS.saturating_add(RESULT_GAS);
        let names: Vec<String> = self.cron.jobs.keys().cloned().collect();
        for name in names {
            let Some(job) = self.cron.jobs.get(&name).cloned() else {
                continue;
            };
            if now < next_due(&job) {
                continue;
            }
            let left = env::prepaid_gas().saturating_sub(env::used_gas());
            if left < job_gas.saturating_add(CONTINUE_GAS).saturating_add(TICK_RESERVE) {
                env::log_str(&format!("cron {name} deferred: not enough gas left"));
                break;
            }
            let Some(spec) = self.fns.specs.get(&job.func).cloned() else {
                env::log_str(&format!("cron {name} skipped: function {} missing", job.func));
                continue;
            };
            if let Err(reason) = self.spend_pool(spec.deposit.0) {
                env::log_str(&format!("cron {name} skipped: {reason}"));
                continue;
            }
            if let Some(stored) = self.cron.jobs.get_mut(&name) {
                stored.last_run = now;
            }
            let site = env::current_account_id();
            let _ = self.launch(Run {
                name: job.func.clone(),
                input: job.input.clone(),
                caller: site.clone(),
                payer: site,
                deposit: spec.deposit.0,
                paid_by: PaidBy::Pool,
                trigger: None,
                gas: Some(JOB_REQUEST_GAS),
            });
            emit("cron_ran", &serde_json::json!({ "name": name, "fn": job.func }));
        }
        let left = env::prepaid_gas().saturating_sub(env::used_gas());
        if left >= CONTINUE_GAS.saturating_add(TICK_RESERVE) {
            self.yield_next();
        } else {
            self.cron.armed = false;
            emit("cron_stopped", &serde_json::json!({ "hops": self.cron.hops }));
        }
    }
}

impl Contract {
    fn yield_next(&mut self) {
        let args = serde_json::json!({ "chain": self.cron.chain }).to_string();
        let (_, id) = env::promise_yield_create_id("cron_tick", args.as_bytes(), Gas::from_tgas(0), GasWeight(1));
        self.cron.pending = Some(id);
    }
}

fn next_due(job: &Job) -> u64 {
    if job.last_run == 0 {
        0
    } else {
        job.last_run
            .saturating_add(u64::from(job.every_minutes).saturating_mul(MINUTE_NS))
    }
}

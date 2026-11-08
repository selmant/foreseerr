//! Order provider work against connection removal, including fallback POSTs.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, Weak};

use tokio::sync::{watch, OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};

use super::{store::Owner, AiError};

/// Per-owner gates, scoped to one server instance. Idle gates are reclaimed.
#[derive(Debug, Default)]
pub struct Dispatches(Mutex<HashMap<Owner, Weak<Gate>>>);

#[derive(Debug)]
struct Gate {
    lock: Arc<RwLock<()>>,
    cancel: watch::Sender<()>,
}

impl Dispatches {
    fn gate(&self, owner: Owner) -> Arc<Gate> {
        let mut gates = self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        gates.retain(|_, gate| gate.strong_count() > 0);
        if let Some(gate) = gates.get(&owner).and_then(Weak::upgrade) {
            return gate;
        }
        let gate = Arc::new(Gate {
            lock: Arc::new(RwLock::new(())),
            cancel: watch::channel(()).0,
        });
        gates.insert(owner, Arc::downgrade(&gate));
        gate
    }

    /// Hold across validation and every provider attempt. Subscribe first so
    /// removal during lock acquisition cannot be missed.
    pub async fn request(&self, owner: Owner) -> Request {
        let gate = self.gate(owner);
        let cancel = gate.cancel.subscribe();
        let held = Arc::clone(&gate.lock).read_owned().await;
        Request {
            _gate: gate,
            _held: held,
            cancel,
        }
    }

    /// Cancel current work, then exclude dispatch until the local connection
    /// has been removed or replaced. Take this before the store write lock.
    pub async fn stop(&self, owner: Owner) -> Removal {
        let gate = self.gate(owner);
        gate.cancel.send_replace(());
        let held = Arc::clone(&gate.lock).write_owned().await;
        Removal {
            _gate: gate,
            _held: held,
        }
    }
}

/// A provider operation that removal can cancel without waiting for its timeout.
#[derive(Debug)]
pub struct Request {
    _gate: Arc<Gate>,
    _held: OwnedRwLockReadGuard<()>,
    cancel: watch::Receiver<()>,
}

impl Request {
    /// Drop the entire operation on removal, so a rejected request cannot
    /// proceed to a fallback POST with the old credentials or prompt.
    ///
    /// # Errors
    /// Returns the provider failure or an input error when removal cancels it.
    pub async fn run<T, F>(&mut self, work: F) -> Result<T, AiError>
    where
        F: std::future::Future<Output = Result<T, AiError>>,
    {
        tokio::select! {
            biased;
            _ = self.cancel.changed() => Err(AiError::input("Your AI connection changed while this request was working. Try again.")),
            result = work => result,
        }
    }
}

/// Proof that no provider operation for this owner can dispatch during removal.
#[derive(Debug)]
pub struct Removal {
    _gate: Arc<Gate>,
    _held: OwnedRwLockWriteGuard<()>,
}

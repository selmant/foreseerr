//! Lock helpers that carry on after a panic in another task. Everything
//! guarded here is replaced whole, so a poisoned lock still holds valid data.

use std::sync::{Mutex, MutexGuard, PoisonError, RwLock, RwLockReadGuard, RwLockWriteGuard};

/// Lock a mutex.
pub fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Take a read lock.
pub fn read<T>(l: &RwLock<T>) -> RwLockReadGuard<'_, T> {
    l.read().unwrap_or_else(PoisonError::into_inner)
}

/// Take a write lock.
pub fn write<T>(l: &RwLock<T>) -> RwLockWriteGuard<'_, T> {
    l.write().unwrap_or_else(PoisonError::into_inner)
}

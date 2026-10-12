//! A lock file inside a Claude account's config dir, so the account has one writer of its
//! credentials at a time across processes: the token renewal, the per-account login and the
//! spawn preflight all take it. The in-process `refresh_lock` of `claude_usage` only serializes
//! callers inside this app; this one also holds against a second app instance.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// File name of the lock inside the account dir.
pub const LOCK_FILE: &str = ".alethe-lock";
/// A lock older than this is left over from a crash and may be taken over. Longer than the
/// longest holder (a login waits on the user for up to `claude_login::LOGIN_TIMEOUT`).
pub const STALE_AFTER: Duration = Duration::from_secs(11 * 60);
const POLL: Duration = Duration::from_millis(100);

/// Held while alive; dropping it removes the lock file if it is still this holder's.
#[derive(Debug)]
pub struct AccountLock {
    path: PathBuf,
    stamp: String,
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn is_stale(path: &Path, stale_after: Duration) -> bool {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .is_some_and(|age| age > stale_after)
}

impl AccountLock {
    /// One attempt: takes the lock, or None when someone else holds a fresh one.
    pub fn try_acquire(dir: &Path) -> Option<AccountLock> {
        Self::try_acquire_with(dir, STALE_AFTER)
    }

    fn try_acquire_with(dir: &Path, stale_after: Duration) -> Option<AccountLock> {
        if !dir.is_dir() {
            return None;
        }
        let path = dir.join(LOCK_FILE);
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let stamp = format!("{} {} {seq}", std::process::id(), now_ms());
        for _ in 0..2 {
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut file) => {
                    let _ = file.write_all(stamp.as_bytes());
                    return Some(AccountLock { path, stamp });
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                    if !is_stale(&path, stale_after) {
                        return None;
                    }
                    // Left by a crashed holder: take it over once.
                    let _ = fs::remove_file(&path);
                }
                Err(_) => return None,
            }
        }
        None
    }

    /// Waits up to `timeout` for the lock (blocking); None when it stays held.
    pub fn acquire(dir: &Path, timeout: Duration) -> Option<AccountLock> {
        let started = std::time::Instant::now();
        loop {
            if let Some(lock) = Self::try_acquire(dir) {
                return Some(lock);
            }
            if started.elapsed() >= timeout || !dir.is_dir() {
                return None;
            }
            std::thread::sleep(POLL);
        }
    }

    /// `acquire` for async callers: waits without blocking a runtime thread.
    pub async fn acquire_async(dir: &Path, timeout: Duration) -> Option<AccountLock> {
        let started = std::time::Instant::now();
        loop {
            if let Some(lock) = Self::try_acquire(dir) {
                return Some(lock);
            }
            if started.elapsed() >= timeout || !dir.is_dir() {
                return None;
            }
            tokio::time::sleep(POLL).await;
        }
    }
}

impl Drop for AccountLock {
    fn drop(&mut self) {
        // Only our own lock: a holder that outlived STALE_AFTER may have been taken over.
        if fs::read_to_string(&self.path).is_ok_and(|s| s == self.stamp) {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("account-lock-{name}-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn one_holder_at_a_time_and_released_on_drop() {
        let dir = scratch("one");
        let first = AccountLock::try_acquire(&dir).expect("first");
        assert!(AccountLock::try_acquire(&dir).is_none());
        assert!(AccountLock::acquire(&dir, Duration::from_millis(250)).is_none());
        drop(first);
        assert!(!dir.join(LOCK_FILE).exists());
        assert!(AccountLock::try_acquire(&dir).is_some());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_stale_lock_is_taken_over_and_not_removed_by_its_old_holder() {
        let dir = scratch("stale");
        let old = AccountLock::try_acquire(&dir).unwrap();
        std::thread::sleep(Duration::from_millis(30));
        let new =
            AccountLock::try_acquire_with(&dir, Duration::from_millis(10)).expect("taken over");
        drop(old);
        assert!(
            dir.join(LOCK_FILE).exists(),
            "the old holder must not drop the new lock"
        );
        drop(new);
        assert!(!dir.join(LOCK_FILE).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_dir_never_locks() {
        let dir = std::env::temp_dir().join(format!("account-lock-missing-{}", now_ms()));
        assert!(AccountLock::try_acquire(&dir).is_none());
    }
}

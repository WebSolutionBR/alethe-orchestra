use serde::{Deserialize, Serialize};

fn http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct UsageWindow {
    pub utilization: f64,
    pub resets_at: String,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct ClaudeUsage {
    pub five_hour: UsageWindow,
    pub seven_day: UsageWindow,
    pub seven_day_opus: UsageWindow,
}

/// One Claude account to poll usage for: a stable id plus the Claude Code
/// config dir (the `CLAUDE_CONFIG_DIR` that holds its `.credentials.json`).
#[derive(Debug, Deserialize)]
pub struct AccountRef {
    pub id: String,
    pub config_dir: String,
}

/// Usage result for a single account. Either `usage` or `error` is set, so one
/// bad account never fails the whole batch.
#[derive(Debug, Serialize, Clone)]
pub struct AccountUsage {
    pub id: String,
    pub usage: Option<ClaudeUsage>,
    pub error: Option<String>,
    /// When the account's sign-in (its refresh token) lapses, in epoch millis.
    /// Past that point only a new login brings the account back.
    pub login_expires_at: Option<i64>,
    /// When `usage` was read from the API (epoch ms). Shared by every window:
    /// see `UsageCache`.
    pub fetched_at: Option<i64>,
    /// Set while `usage` is an older value served because the endpoint refused
    /// a newer read (429 / 5xx): since when the refresh has been failing.
    pub stale_since: Option<i64>,
    /// While backing off from a refusal: the earliest moment of the next read.
    pub retry_at: Option<i64>,
}

/// The parts of an account's `.credentials.json` that decide whether its
/// access token can still be used. Timestamps are epoch millis.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct AccountCredentials {
    pub(crate) access_token: String,
    pub(crate) expires_at: Option<i64>,
    pub(crate) refresh_expires_at: Option<i64>,
}

fn parse_credentials(contents: &str) -> Option<AccountCredentials> {
    let json = serde_json::from_str::<serde_json::Value>(contents).ok()?;
    let oauth = json.get("claudeAiOauth")?;
    let access_token = oauth.get("accessToken")?.as_str()?;
    if access_token.is_empty() {
        return None;
    }
    Some(AccountCredentials {
        access_token: access_token.to_string(),
        expires_at: oauth.get("expiresAt").and_then(|v| v.as_i64()),
        refresh_expires_at: oauth.get("refreshTokenExpiresAt").and_then(|v| v.as_i64()),
    })
}

/// Refresh a little before the access token lapses so a poll never races the expiry.
const EXPIRY_MARGIN_MS: i64 = 2 * 60 * 1000;
const REFRESH_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(90);

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub(crate) fn access_token_expired(creds: &AccountCredentials, now: i64) -> bool {
    creds
        .expires_at
        .is_some_and(|exp| exp <= now + EXPIRY_MARGIN_MS)
}

pub(crate) fn login_expired(creds: &AccountCredentials, now: i64) -> bool {
    creds.refresh_expires_at.is_some_and(|exp| exp <= now)
}

fn read_credentials_file_with_retry(path: &std::path::Path) -> Option<String> {
    for attempt in 0..3 {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(80));
        }
        let Ok(contents) = std::fs::read_to_string(path) else {
            continue;
        };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(&contents) else {
            continue;
        };
        if let Some(tok) = json
            .get("claudeAiOauth")
            .and_then(|o| o.get("accessToken"))
            .and_then(|v| v.as_str())
        {
            if !tok.is_empty() {
                return Some(tok.to_string());
            }
        }
    }
    None
}

/// Find the Claude OAuth token for a specific config dir (per-account).
///
/// Reads `<config_dir>/.credentials.json` — the same file the Claude Code CLI
/// writes when launched with `CLAUDE_CONFIG_DIR=<config_dir>`. This is the
/// plaintext ("bare") backend, which is what Windows uses here. If a future
/// setup moves an account to the OS credential store, the CLI namespaces the
/// entry as `Claude Code-credentials-<sha256(dir)[:8]>`; that fallback can be
/// added later (needs a hashing dep) — file-based covers the current setup.
pub(crate) fn read_account_credentials(config_dir: &std::path::Path) -> Option<AccountCredentials> {
    let cred_path = config_dir.join(".credentials.json");
    for attempt in 0..3 {
        if attempt > 0 {
            std::thread::sleep(std::time::Duration::from_millis(80));
        }
        if let Some(creds) = std::fs::read_to_string(&cred_path)
            .ok()
            .and_then(|contents| parse_credentials(&contents))
        {
            return Some(creds);
        }
    }
    None
}

/// Serializes refreshes: the accounts panel, the monitor and the sidebar can
/// poll at the same moment, and each must not launch its own CLI run.
fn refresh_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Get a fresh access token for one account by letting the Claude Code CLI do
/// it. Access tokens last a few hours and only the CLI refreshes them, so an
/// account nobody opened a terminal with goes stale. A tiny headless prompt
/// under the account's `CLAUDE_CONFIG_DIR` makes the CLI swap the refresh
/// token for a new access token and rewrite `.credentials.json` itself, which
/// keeps the file format and token rotation entirely the CLI's business.
///
/// `force` skips the "already fresh" short-circuit, for a token the API
/// rejected even though its timestamp says it is still valid.
pub(crate) async fn refresh_access_token(config_dir: &std::path::Path, force: bool) -> bool {
    let _guard = refresh_lock().lock().await;
    // Another process writing this account (a login, another app instance): give up.
    let Some(_file_lock) = crate::account_lock::AccountLock::acquire_async(
        config_dir,
        std::time::Duration::from_secs(120),
    )
    .await
    else {
        return false;
    };
    if !force {
        // Another poll may have refreshed it while we waited for the lock.
        if read_account_credentials(config_dir)
            .is_some_and(|creds| !access_token_expired(&creds, now_ms()))
        {
            return true;
        }
    }
    let Some(bin) = crate::cli_resolver::find_windows_cli_launcher("claude") else {
        return false;
    };
    let mut command = tokio::process::Command::new(bin);
    command
        .args(["-p", "ok", "--model", "haiku", "--output-format", "text"])
        .env("CLAUDE_CONFIG_DIR", config_dir)
        // An inherited API key or token would bypass the account's OAuth login.
        .env_remove("ANTHROPIC_API_KEY")
        .env_remove("CLAUDE_CODE_OAUTH_TOKEN")
        // Running inside the account dir keeps the CLI off any project settings.
        .current_dir(config_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let Ok(mut child) = command.spawn() else {
        return false;
    };
    if !matches!(
        tokio::time::timeout(REFRESH_TIMEOUT, child.wait()).await,
        Ok(Ok(_))
    ) {
        let _ = child.kill().await;
        return false;
    }
    read_account_credentials(config_dir)
        .is_some_and(|creds| !access_token_expired(&creds, now_ms()))
}

/// Usage for one account, renewing its access token first when it has lapsed.
/// Errors: `no_token` (never signed in), `login_expired` (the sign-in itself
/// ran out — only a new login helps), `token_expired` (the renewal failed).
async fn account_usage(
    config_dir: &std::path::Path,
) -> (Result<ClaudeUsage, FetchError>, Option<i64>) {
    let other = |code: &str| Err(FetchError::Other(code.to_string()));
    let Some(mut creds) = read_account_credentials(config_dir) else {
        return (other("no_token"), None);
    };
    let login_expires_at = creds.refresh_expires_at;
    if login_expired(&creds, now_ms()) {
        return (other("login_expired"), login_expires_at);
    }
    let mut refreshed = false;
    if access_token_expired(&creds, now_ms()) {
        if !refresh_access_token(config_dir, false).await {
            return (other("token_expired"), login_expires_at);
        }
        refreshed = true;
        if let Some(fresh) = read_account_credentials(config_dir) {
            creds = fresh;
        }
    }
    let result = match fetch_usage(&creds.access_token).await {
        Err(FetchError::Unauthorized) if !refreshed => {
            // The timestamp said valid but the API disagrees (revoked, clock skew):
            // one forced renewal, then a single retry.
            if !refresh_access_token(config_dir, true).await {
                other("token_expired")
            } else {
                match read_account_credentials(config_dir) {
                    Some(fresh) => fetch_usage(&fresh.access_token).await,
                    None => other("no_token"),
                }
            }
        }
        result => result,
    };
    let login_expires_at = read_account_credentials(config_dir)
        .and_then(|c| c.refresh_expires_at)
        .or(login_expires_at);
    (result, login_expires_at)
}

/// Try to find the Claude OAuth token.
fn discover_token() -> Option<String> {
    // 1. Env var
    if let Ok(tok) = std::env::var("CLAUDE_OAUTH_TOKEN") {
        if !tok.is_empty() {
            return Some(tok);
        }
    }

    // 2. ~/.claude/.credentials.json (where Claude Code actually stores it)
    if let Some(home) = dirs_next::home_dir() {
        let cred_path = home.join(".claude").join(".credentials.json");
        if let Some(tok) = read_credentials_file_with_retry(&cred_path) {
            return Some(tok);
        }
    }

    // 3. Keyring (Windows Credential Manager / macOS Keychain).
    //    No macOS o Claude Code grava a entrada com account = username local,

    let service = "Claude Code-credentials";
    let mut usernames: Vec<String> = Vec::new();
    if let Ok(user) = std::env::var("USER").or_else(|_| std::env::var("USERNAME")) {
        if !user.is_empty() {
            usernames.push(user);
        }
    }
    for u in ["default", "user", "claude", ""] {
        usernames.push(u.to_string());
    }
    for username in &usernames {
        if let Ok(entry) = keyring::Entry::new(service, username) {
            if let Ok(secret) = entry.get_password() {
                if secret.is_empty() {
                    continue;
                }
                return Some(extract_token_from_secret(&secret));
            }
        }
    }

    None
}

/// ({"claudeAiOauth":{"accessToken":...}}), como no macOS Keychain.
fn extract_token_from_secret(secret: &str) -> String {
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(secret) {
        if let Some(tok) = json
            .get("claudeAiOauth")
            .and_then(|o| o.get("accessToken"))
            .and_then(|v| v.as_str())
        {
            if !tok.is_empty() {
                return tok.to_string();
            }
        }
    }
    secret.to_string()
}

/// Why a read of the usage endpoint failed.
#[derive(Debug, Clone, PartialEq)]
enum FetchError {
    /// 401: the token was rejected.
    Unauthorized,
    /// 429 or 5xx: the endpoint asked to be left alone for a while. Carries the
    /// `Retry-After` delay (ms) when the response gave one.
    Throttled {
        status: u16,
        retry_after_ms: Option<i64>,
    },
    /// Anything else, as the code the frontend shows (`no_token`, `request failed: ...`).
    Other(String),
}

impl FetchError {
    /// The error string the commands return. `rate_limited` is what the UI keys on.
    fn code(&self) -> String {
        match self {
            FetchError::Unauthorized => "unauthorized".to_string(),
            FetchError::Throttled { status: 429, .. } => "rate_limited".to_string(),
            FetchError::Throttled { status, .. } => format!("API returned {status}"),
            FetchError::Other(code) => code.clone(),
        }
    }
}

/// `Retry-After` in milliseconds from `now`: either delta-seconds or an HTTP date.
fn parse_retry_after(value: &str, now: i64) -> Option<i64> {
    let value = value.trim();
    if let Ok(seconds) = value.parse::<i64>() {
        return Some(seconds.max(0) * 1000);
    }
    let at = chrono::DateTime::parse_from_rfc2822(value).ok()?;
    Some((at.timestamp_millis() - now).max(0))
}

/// Call the OAuth usage endpoint with a given bearer token and parse the
/// windows we care about. Per-token: the token identifies the account.
async fn fetch_usage(token: &str) -> Result<ClaudeUsage, FetchError> {
    let client = http_client();
    let resp = client
        .get("https://api.anthropic.com/api/oauth/usage")
        .header("Authorization", format!("Bearer {}", token))
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .await
        .map_err(|e| FetchError::Other(format!("request failed: {e}")))?;

    let status = resp.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(FetchError::Unauthorized);
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
        let retry_after_ms = resp
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| parse_retry_after(v, now_ms()));
        return Err(FetchError::Throttled {
            status: status.as_u16(),
            retry_after_ms,
        });
    }
    if !status.is_success() {
        return Err(FetchError::Other(format!("API returned {status}")));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| FetchError::Other(format!("json parse: {e}")))?;

    let parse_window = |key: &str| -> UsageWindow {
        let default = UsageWindow {
            utilization: 0.0,
            resets_at: String::new(),
        };
        let Some(obj) = body.get(key) else {
            return default;
        };
        if obj.is_null() {
            return default;
        }
        let utilization = obj
            .get("utilization")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let resets_at = obj
            .get("resets_at")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        UsageWindow {
            utilization,
            resets_at,
        }
    };

    Ok(ClaudeUsage {
        five_hour: parse_window("five_hour"),
        seven_day: parse_window("seven_day"),
        seven_day_opus: parse_window("seven_day_opus"),
    })
}

/// A cached read is reused for this long. Usage moves slowly and the endpoint
/// answers 429 when polled too often.
const USAGE_TTL_MS: i64 = 60_000;
/// First wait after a refusal without `Retry-After`; doubles on each refusal in a row.
const BACKOFF_BASE_MS: i64 = 60_000;
/// Longest wait between reads of a refusing account, `Retry-After` included.
const BACKOFF_MAX_MS: i64 = 15 * 60_000;
/// Shortest wait after a refusal, so a `Retry-After: 0` never turns into a burst.
const BACKOFF_MIN_MS: i64 = 5_000;
/// Cache key of the default account (`~/.claude`, env token or keyring).
const DEFAULT_ACCOUNT_KEY: &str = "<default>";

/// What the cache knows about one account.
#[derive(Debug, Clone, Default, PartialEq)]
struct CacheEntry {
    usage: Option<ClaudeUsage>,
    fetched_at: Option<i64>,
    stale_since: Option<i64>,
    retry_at: Option<i64>,
    login_expires_at: Option<i64>,
    /// Refusals in a row, for the exponential backoff.
    refusals: u32,
}

/// One usage read as the commands report it.
#[derive(Debug, Clone, PartialEq)]
struct Polled {
    result: Result<ClaudeUsage, String>,
    fetched_at: Option<i64>,
    stale_since: Option<i64>,
    retry_at: Option<i64>,
    login_expires_at: Option<i64>,
}

/// Usage reads shared by every window of the app (Monitor, home strip, accounts
/// panel, Orchestra): each used to poll on its own, which is what earned the
/// 429s. Keyed by account config dir. Pure: the clock is passed in.
#[derive(Debug, Default)]
struct UsageCache {
    entries: std::collections::HashMap<String, CacheEntry>,
}

impl UsageCache {
    /// Whether a poll must hit the API. A backoff is honoured even when the
    /// owner forces a refresh: forcing through a 429 only extends it.
    fn should_fetch(&self, key: &str, now: i64, force: bool) -> bool {
        let Some(entry) = self.entries.get(key) else {
            return true;
        };
        if entry.retry_at.is_some_and(|at| now < at) {
            return false;
        }
        force
            || entry.usage.is_none()
            || entry.stale_since.is_some()
            || entry.fetched_at.map_or(true, |at| now - at >= USAGE_TTL_MS)
    }

    /// Stores the outcome of a read and returns what the caller reports.
    fn record(
        &mut self,
        key: &str,
        now: i64,
        result: Result<ClaudeUsage, FetchError>,
        login_expires_at: Option<i64>,
    ) -> Polled {
        let entry = self.entries.entry(key.to_string()).or_default();
        entry.login_expires_at = login_expires_at.or(entry.login_expires_at);
        match result {
            Ok(usage) => {
                *entry = CacheEntry {
                    usage: Some(usage),
                    fetched_at: Some(now),
                    login_expires_at: entry.login_expires_at,
                    ..CacheEntry::default()
                };
                Self::serve(entry)
            }
            Err(error @ FetchError::Throttled { .. }) => {
                let FetchError::Throttled { retry_after_ms, .. } = error else {
                    unreachable!()
                };
                entry.refusals = entry.refusals.saturating_add(1);
                let doublings = entry.refusals.clamp(1, 10) - 1;
                let wait = retry_after_ms
                    .unwrap_or(BACKOFF_BASE_MS.saturating_mul(1 << doublings))
                    .clamp(BACKOFF_MIN_MS, BACKOFF_MAX_MS);
                entry.retry_at = Some(now + wait);
                if entry.usage.is_some() {
                    entry.stale_since = entry.stale_since.or(Some(now));
                    Self::serve(entry)
                } else {
                    Self::polled(entry, Err(error.code()))
                }
            }
            // Sign-in problems and transport errors are not cached: the next
            // poll tries again, as before the cache existed.
            Err(error) => Self::polled(entry, Err(error.code())),
        }
    }

    /// The cached value without reading the API; `None` when nothing was read yet.
    fn cached(&self, key: &str) -> Option<Polled> {
        let entry = self.entries.get(key)?;
        if entry.usage.is_some() {
            return Some(Self::serve(entry));
        }
        // Nothing to show but a backoff in progress: say so instead of reading.
        entry
            .retry_at
            .map(|_| Self::polled(entry, Err("rate_limited".to_string())))
    }

    fn serve(entry: &CacheEntry) -> Polled {
        let usage = entry
            .usage
            .clone()
            .ok_or_else(|| "rate_limited".to_string());
        Self::polled(entry, usage)
    }

    fn polled(entry: &CacheEntry, result: Result<ClaudeUsage, String>) -> Polled {
        Polled {
            result,
            fetched_at: entry.fetched_at,
            stale_since: entry.stale_since,
            retry_at: entry.retry_at,
            login_expires_at: entry.login_expires_at,
        }
    }
}

fn usage_cache() -> &'static std::sync::Mutex<UsageCache> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<UsageCache>> = std::sync::OnceLock::new();
    CACHE.get_or_init(Default::default)
}

type KeyLocks = std::collections::HashMap<String, std::sync::Arc<tokio::sync::Mutex<()>>>;

/// One async lock per account, so two windows polling the same account at the
/// same moment make a single request (the second one finds it cached) while
/// different accounts never wait on each other's token renewal.
fn key_lock(key: &str) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    static LOCKS: std::sync::OnceLock<std::sync::Mutex<KeyLocks>> = std::sync::OnceLock::new();
    let mut locks = LOCKS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    locks.entry(key.to_string()).or_default().clone()
}

/// Same account, same key, however the path was spelled.
fn cache_key(config_dir: &str) -> String {
    let trimmed = config_dir.trim().trim_end_matches(['\\', '/']);
    if cfg!(windows) {
        trimmed.replace('/', "\\").to_lowercase()
    } else {
        trimmed.to_string()
    }
}

/// Cached read of one account: hits the API only when the cache is old (or
/// `force`) and no backoff is running.
async fn poll_cached<F, Fut>(
    cache: &std::sync::Mutex<UsageCache>,
    key: &str,
    force: bool,
    now: impl Fn() -> i64,
    fetch: F,
) -> Polled
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = (Result<ClaudeUsage, FetchError>, Option<i64>)>,
{
    let lock = key_lock(key);
    let _guard = lock.lock().await;
    let lock_cache = || {
        cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    };
    let cached = {
        let cache = lock_cache();
        if cache.should_fetch(key, now(), force) {
            None
        } else {
            cache.cached(key)
        }
    };
    if let Some(polled) = cached {
        return polled;
    }
    let (result, login_expires_at) = fetch().await;
    lock_cache().record(key, now(), result, login_expires_at)
}

async fn poll_account(config_dir: &str, force: bool) -> Polled {
    let dir = std::path::PathBuf::from(config_dir);
    poll_cached(
        usage_cache(),
        &cache_key(config_dir),
        force,
        now_ms,
        || async move { account_usage(&dir).await },
    )
    .await
}

/// Usage for the default/active account (env `CLAUDE_OAUTH_TOKEN`, then
/// `~/.claude/.credentials.json`, then keyring), through the shared cache.
#[tauri::command]
pub async fn get_claude_usage(force: Option<bool>) -> Result<ClaudeUsage, String> {
    poll_cached(
        usage_cache(),
        DEFAULT_ACCOUNT_KEY,
        force.unwrap_or(false),
        now_ms,
        || async {
            match discover_token() {
                Some(token) => (fetch_usage(&token).await, None),
                None => (Err(FetchError::Other("no_token".to_string())), None),
            }
        },
    )
    .await
    .result
}

/// Usage for one account identified by its Claude Code config dir, through the
/// shared cache. A lapsed access token is renewed first (see `refresh_access_token`).
#[tauri::command]
pub async fn get_claude_usage_for(
    config_dir: String,
    force: Option<bool>,
) -> Result<ClaudeUsage, String> {
    poll_account(&config_dir, force.unwrap_or(false))
        .await
        .result
}

/// Usage for many accounts at once, through the shared cache; `force` is the
/// owner's "refresh" button (still bound by a running backoff). One failing
/// account is reported in-line and never fails the batch. Sequential is fine
/// for the handful of accounts a user keeps.
#[tauri::command]
pub async fn get_all_accounts_usage(
    accounts: Vec<AccountRef>,
    force: Option<bool>,
) -> Vec<AccountUsage> {
    let force = force.unwrap_or(false);
    let mut out = Vec::with_capacity(accounts.len());
    for account in accounts {
        let polled = poll_account(&account.config_dir, force).await;
        let (usage, error) = match polled.result {
            Ok(usage) => (Some(usage), None),
            Err(err) => (None, Some(err)),
        };
        out.push(AccountUsage {
            id: account.id,
            usage,
            error,
            login_expires_at: polled.login_expires_at,
            fetched_at: polled.fetched_at,
            stale_since: polled.stale_since,
            retry_at: polled.retry_at,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn read_account_credentials_reads_from_dir() {
        let dir = std::env::temp_dir().join(format!("alethe-acct-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut f = std::fs::File::create(dir.join(".credentials.json")).unwrap();
        write!(f, r#"{{"claudeAiOauth":{{"accessToken":"tok-abc"}}}}"#).unwrap();
        assert_eq!(
            read_account_credentials(&dir).map(|c| c.access_token),
            Some("tok-abc".to_string())
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_account_credentials_missing_dir_is_none() {
        let dir = std::env::temp_dir().join("alethe-acct-does-not-exist-xyz");
        assert_eq!(read_account_credentials(&dir), None);
    }

    #[test]
    fn parse_credentials_keeps_expiry_timestamps() {
        let creds = parse_credentials(
            r#"{"claudeAiOauth":{"accessToken":"tok","expiresAt":1000,"refreshTokenExpiresAt":5000}}"#,
        )
        .unwrap();
        assert_eq!(creds.access_token, "tok");
        assert_eq!(creds.expires_at, Some(1000));
        assert_eq!(creds.refresh_expires_at, Some(5000));
    }

    #[test]
    fn parse_credentials_rejects_empty_or_missing_token() {
        assert_eq!(
            parse_credentials(r#"{"claudeAiOauth":{"accessToken":""}}"#),
            None
        );
        assert_eq!(parse_credentials(r#"{"other":{}}"#), None);
        assert_eq!(parse_credentials("not json"), None);
    }

    #[test]
    fn access_token_expiry_honours_margin() {
        let creds = |exp: Option<i64>| AccountCredentials {
            access_token: "tok".into(),
            expires_at: exp,
            refresh_expires_at: None,
        };
        let now = 10_000_000;
        assert!(access_token_expired(&creds(Some(now - 1)), now));
        // Inside the margin counts as expired so a poll never races the lapse.
        assert!(access_token_expired(
            &creds(Some(now + EXPIRY_MARGIN_MS - 1)),
            now
        ));
        assert!(!access_token_expired(
            &creds(Some(now + EXPIRY_MARGIN_MS + 60_000)),
            now
        ));
        // No timestamp: trust the token and let the API answer.
        assert!(!access_token_expired(&creds(None), now));
    }

    #[test]
    fn login_expiry_uses_refresh_token_timestamp() {
        let creds = |exp: Option<i64>| AccountCredentials {
            access_token: "tok".into(),
            expires_at: None,
            refresh_expires_at: exp,
        };
        assert!(login_expired(&creds(Some(99)), 100));
        assert!(!login_expired(&creds(Some(101)), 100));
        assert!(!login_expired(&creds(None), 100));
    }

    fn usage(pct: f64) -> ClaudeUsage {
        let window = UsageWindow {
            utilization: pct,
            resets_at: String::new(),
        };
        ClaudeUsage {
            five_hour: window.clone(),
            seven_day: window.clone(),
            seven_day_opus: window,
        }
    }

    fn throttled(retry_after_ms: Option<i64>) -> Result<ClaudeUsage, FetchError> {
        Err(FetchError::Throttled {
            status: 429,
            retry_after_ms,
        })
    }

    #[test]
    fn cache_reuses_a_fresh_read_and_refetches_after_the_ttl() {
        let mut cache = UsageCache::default();
        assert!(cache.should_fetch("a", 0, false));
        let polled = cache.record("a", 1_000, Ok(usage(10.0)), Some(9));
        assert_eq!(polled.result, Ok(usage(10.0)));
        assert_eq!(polled.fetched_at, Some(1_000));
        assert_eq!(polled.login_expires_at, Some(9));
        assert!(!cache.should_fetch("a", 1_000 + USAGE_TTL_MS - 1, false));
        assert!(cache.should_fetch("a", 1_000 + USAGE_TTL_MS, false));
        // The refresh button skips the TTL.
        assert!(cache.should_fetch("a", 1_001, true));
        // Accounts never share an entry.
        assert!(cache.should_fetch("b", 1_001, false));
    }

    #[test]
    fn rate_limit_serves_the_last_good_value_marked_stale() {
        let mut cache = UsageCache::default();
        cache.record("a", 0, Ok(usage(40.0)), None);
        let polled = cache.record("a", 70_000, throttled(Some(120_000)), None);
        assert_eq!(polled.result, Ok(usage(40.0)));
        assert_eq!(polled.fetched_at, Some(0));
        assert_eq!(polled.stale_since, Some(70_000));
        assert_eq!(polled.retry_at, Some(190_000));
        // Retry-After is honoured even by the refresh button.
        assert!(!cache.should_fetch("a", 189_999, true));
        assert!(cache.should_fetch("a", 190_000, false));
        // A second refusal keeps the first stale moment.
        let again = cache.record("a", 190_000, throttled(None), None);
        assert_eq!(again.stale_since, Some(70_000));
        // A good read clears the stale state and the backoff.
        let fresh = cache.record("a", 400_000, Ok(usage(50.0)), None);
        assert_eq!(fresh.stale_since, None);
        assert_eq!(fresh.retry_at, None);
        assert_eq!(fresh.fetched_at, Some(400_000));
    }

    #[test]
    fn backoff_without_retry_after_doubles_and_is_capped() {
        let mut cache = UsageCache::default();
        let waits: Vec<i64> = (0..8)
            .map(|_| {
                cache
                    .record("a", 0, throttled(None), None)
                    .retry_at
                    .unwrap()
            })
            .collect();
        assert_eq!(waits[0], BACKOFF_BASE_MS);
        assert_eq!(waits[1], BACKOFF_BASE_MS * 2);
        assert_eq!(waits[2], BACKOFF_BASE_MS * 4);
        assert_eq!(*waits.last().unwrap(), BACKOFF_MAX_MS);
        // A `Retry-After: 0` still waits a little.
        let mut other = UsageCache::default();
        assert_eq!(
            other.record("b", 0, throttled(Some(0)), None).retry_at,
            Some(BACKOFF_MIN_MS)
        );
    }

    #[test]
    fn rate_limit_without_any_value_reports_rate_limited() {
        let mut cache = UsageCache::default();
        let polled = cache.record("a", 0, throttled(None), None);
        assert_eq!(polled.result, Err("rate_limited".to_string()));
        assert_eq!(polled.stale_since, None);
        assert_eq!(
            cache.cached("a").map(|p| p.result),
            Some(Err("rate_limited".to_string()))
        );
        // A 5xx backs off the same way but keeps its own message.
        let server = cache.record(
            "b",
            0,
            Err(FetchError::Throttled {
                status: 503,
                retry_after_ms: None,
            }),
            None,
        );
        assert_eq!(server.result, Err("API returned 503".to_string()));
        assert!(server.retry_at.is_some());
    }

    #[test]
    fn sign_in_errors_are_not_cached() {
        let mut cache = UsageCache::default();
        cache.record("a", 0, Ok(usage(5.0)), None);
        let polled = cache.record("a", 1, Err(FetchError::Other("login_expired".into())), None);
        assert_eq!(polled.result, Err("login_expired".to_string()));
        assert_eq!(polled.retry_at, None);
        assert_eq!(cache.cached("a").map(|p| p.result), Some(Ok(usage(5.0))));
    }

    #[test]
    fn retry_after_accepts_seconds_and_http_dates() {
        assert_eq!(parse_retry_after(" 30 ", 0), Some(30_000));
        assert_eq!(parse_retry_after("-5", 0), Some(0));
        let now = chrono::DateTime::parse_from_rfc2822("Mon, 12 Oct 2026 15:00:00 GMT")
            .unwrap()
            .timestamp_millis();
        assert_eq!(
            parse_retry_after("Mon, 12 Oct 2026 15:02:00 GMT", now),
            Some(120_000)
        );
        assert_eq!(parse_retry_after("soon", now), None);
    }

    #[test]
    fn cache_key_ignores_case_slashes_and_trailing_separators() {
        if cfg!(windows) {
            assert_eq!(
                cache_key("C:/Users/X/acct/"),
                cache_key("c:\\users\\x\\ACCT")
            );
        }
        assert_eq!(cache_key("/tmp/acct/"), cache_key("/tmp/acct"));
    }

    #[test]
    fn poll_cached_makes_one_request_per_ttl_and_serves_stale_on_429() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap();
        let cache = std::sync::Mutex::new(UsageCache::default());
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let clock = std::sync::atomic::AtomicI64::new(0);
        let now = || clock.load(std::sync::atomic::Ordering::SeqCst);
        let key = "poll-cached-test-key";
        rt.block_on(async {
            let ok = || async {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                (Ok(usage(20.0)), None)
            };
            assert_eq!(
                poll_cached(&cache, key, false, now, ok).await.result,
                Ok(usage(20.0))
            );
            clock.store(30_000, std::sync::atomic::Ordering::SeqCst);
            assert_eq!(
                poll_cached(&cache, key, false, now, ok).await.result,
                Ok(usage(20.0))
            );
            assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);

            clock.store(USAGE_TTL_MS, std::sync::atomic::Ordering::SeqCst);
            let refused = || async {
                calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                (throttled(Some(300_000)), None)
            };
            let polled = poll_cached(&cache, key, false, now, refused).await;
            assert_eq!(polled.result, Ok(usage(20.0)));
            assert_eq!(polled.stale_since, Some(USAGE_TTL_MS));
            // Forced inside the backoff: no request, the stale value again.
            let polled = poll_cached(&cache, key, true, now, refused).await;
            assert_eq!(polled.stale_since, Some(USAGE_TTL_MS));
            assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2);
        });
    }
}

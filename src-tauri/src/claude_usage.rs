use serde::{Deserialize, Serialize};

fn http_client() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

#[derive(Debug, Serialize, Clone)]
pub struct UsageWindow {
    pub utilization: f64,
    pub resets_at: String,
}

#[derive(Debug, Serialize, Clone)]
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
}

/// The parts of an account's `.credentials.json` that decide whether its
/// access token can still be used. Timestamps are epoch millis.
#[derive(Debug, Clone, PartialEq)]
struct AccountCredentials {
    access_token: String,
    expires_at: Option<i64>,
    refresh_expires_at: Option<i64>,
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

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn access_token_expired(creds: &AccountCredentials, now: i64) -> bool {
    creds.expires_at.is_some_and(|exp| exp <= now + EXPIRY_MARGIN_MS)
}

fn login_expired(creds: &AccountCredentials, now: i64) -> bool {
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
fn read_account_credentials(config_dir: &std::path::Path) -> Option<AccountCredentials> {
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
async fn refresh_access_token(config_dir: &std::path::Path, force: bool) -> bool {
    let _guard = refresh_lock().lock().await;
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
    read_account_credentials(config_dir).is_some_and(|creds| !access_token_expired(&creds, now_ms()))
}

/// Usage for one account, renewing its access token first when it has lapsed.
/// Errors: `no_token` (never signed in), `login_expired` (the sign-in itself
/// ran out — only a new login helps), `token_expired` (the renewal failed).
async fn account_usage(config_dir: &std::path::Path) -> (Result<ClaudeUsage, String>, Option<i64>) {
    let Some(mut creds) = read_account_credentials(config_dir) else {
        return (Err("no_token".to_string()), None);
    };
    let login_expires_at = creds.refresh_expires_at;
    if login_expired(&creds, now_ms()) {
        return (Err("login_expired".to_string()), login_expires_at);
    }
    let mut refreshed = false;
    if access_token_expired(&creds, now_ms()) {
        if !refresh_access_token(config_dir, false).await {
            return (Err("token_expired".to_string()), login_expires_at);
        }
        refreshed = true;
        if let Some(fresh) = read_account_credentials(config_dir) {
            creds = fresh;
        }
    }
    let result = match fetch_usage(&creds.access_token).await {
        Err(err) if err == UNAUTHORIZED && !refreshed => {
            // The timestamp said valid but the API disagrees (revoked, clock skew):
            // one forced renewal, then a single retry.
            if !refresh_access_token(config_dir, true).await {
                Err("token_expired".to_string())
            } else {
                match read_account_credentials(config_dir) {
                    Some(fresh) => fetch_usage(&fresh.access_token).await,
                    None => Err("no_token".to_string()),
                }
            }
        }
        other => other,
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

/// Error `fetch_usage` returns when the API rejects the token.
const UNAUTHORIZED: &str = "unauthorized";

/// Call the OAuth usage endpoint with a given bearer token and parse the
/// windows we care about. Per-token: the token identifies the account.
async fn fetch_usage(token: &str) -> Result<ClaudeUsage, String> {
    let client = http_client();
    let resp = client
        .get("https://api.anthropic.com/api/oauth/usage")
        .header("Authorization", format!("Bearer {}", token))
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;

    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Err(UNAUTHORIZED.to_string());
    }
    if !resp.status().is_success() {
        return Err(format!("API returned {}", resp.status()));
    }

    let body: serde_json::Value = resp.json().await.map_err(|e| format!("json parse: {e}"))?;

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

/// Usage for the default/active account (env `CLAUDE_OAUTH_TOKEN`, then
/// `~/.claude/.credentials.json`, then keyring). Unchanged behaviour.
#[tauri::command]
pub async fn get_claude_usage() -> Result<ClaudeUsage, String> {
    let token = discover_token().ok_or_else(|| "no_token".to_string())?;
    fetch_usage(&token).await
}

/// Usage for one account identified by its Claude Code config dir. A lapsed
/// access token is renewed first (see `refresh_access_token`).
#[tauri::command]
pub async fn get_claude_usage_for(config_dir: String) -> Result<ClaudeUsage, String> {
    account_usage(std::path::Path::new(&config_dir)).await.0
}

/// Usage for many accounts at once. On-demand (called when the panel opens);
/// one failing account is reported in-line and never fails the batch.
/// Sequential is fine for the handful of accounts a user keeps.
#[tauri::command]
pub async fn get_all_accounts_usage(accounts: Vec<AccountRef>) -> Vec<AccountUsage> {
    let mut out = Vec::with_capacity(accounts.len());
    for account in accounts {
        let (result, login_expires_at) =
            account_usage(std::path::Path::new(&account.config_dir)).await;
        let (usage, error) = match result {
            Ok(usage) => (Some(usage), None),
            Err(err) => (None, Some(err)),
        };
        out.push(AccountUsage {
            id: account.id,
            usage,
            error,
            login_expires_at,
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
        assert_eq!(parse_credentials(r#"{"claudeAiOauth":{"accessToken":""}}"#), None);
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
        assert!(access_token_expired(&creds(Some(now + EXPIRY_MARGIN_MS - 1)), now));
        assert!(!access_token_expired(&creds(Some(now + EXPIRY_MARGIN_MS + 60_000)), now));
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
}

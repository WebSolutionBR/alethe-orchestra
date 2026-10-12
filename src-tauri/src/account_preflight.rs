//! `ensure_account_ready`: what has to hold before an agent's PTY opens in a Claude account.
//!
//! 1. The session folder is trusted in the account's `.claude.json` (see `trust_seed`), so the
//!    agent never stops on the trust dialog.
//! 2. The account is signed in, its sign-in has not lapsed, and an expired access token is
//!    renewed through the same CLI run the usage panel uses (`claude_usage::refresh_access_token`).
//! 3. The account is still the one it should be: the e-mail in `oauthAccount` matches the
//!    expected one (the account's configured e-mail, else the identity pinned in the account dir
//!    after its first good check). A `/login` in the wrong browser once moved four accounts onto
//!    the same Anthropic account without anyone noticing.
//!
//! When 2 or 3 fail, the PTY is not opened: the agent shows "blocked: login expired / account
//! changed" with a sign-in button instead of sitting on "Login expired · Please run /login".

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::future::Future;
use std::path::{Path, PathBuf};

use crate::claude_usage::{
    access_token_expired, login_expired, now_ms, read_account_credentials, AccountCredentials,
};
use crate::trust_seed;

/// File in the account dir holding the identity it was confirmed to be.
pub const IDENTITY_FILE: &str = ".alethe-account.json";

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PreflightStatus {
    /// The PTY may open.
    Ready,
    /// No credentials at all: never signed in here (import copies no credentials).
    NoLogin,
    /// The sign-in lapsed, or the token could not be renewed (its refresh token is dead).
    LoginExpired,
    /// Signed in, but as another Anthropic account than expected.
    AccountMismatch,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Preflight {
    pub status: PreflightStatus,
    /// The e-mail Claude Code says the account is signed in as.
    pub email: Option<String>,
    pub account_uuid: Option<String>,
    /// What it should be signed in as, when known.
    pub expected_email: Option<String>,
    /// The access token was renewed during this check.
    pub refreshed: bool,
    /// Accounts whose trust could not be seeded; the launch goes on (the trust dialog is
    /// detected on screen anyway).
    pub seed_errors: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub email: Option<String>,
    pub account_uuid: Option<String>,
}

fn normalize_email(email: Option<&str>) -> Option<String> {
    email
        .map(|e| e.trim().to_lowercase())
        .filter(|e| !e.is_empty())
}

/// Who `.claude.json` says the account is signed in as.
pub fn oauth_identity(config_dir: &Path) -> Identity {
    let config = trust_seed::read_config(&config_dir.join(".claude.json"));
    let oauth = config.as_ref().and_then(|c| c.get("oauthAccount"));
    let field = |key: &str| {
        oauth
            .and_then(|o| o.get(key))
            .and_then(Value::as_str)
            .map(str::to_string)
            .filter(|s| !s.is_empty())
    };
    Identity {
        email: field("emailAddress"),
        account_uuid: field("accountUuid"),
    }
}

pub fn pinned_identity(config_dir: &Path) -> Option<Identity> {
    let text = std::fs::read_to_string(config_dir.join(IDENTITY_FILE)).ok()?;
    serde_json::from_str::<Identity>(&text)
        .ok()
        .filter(|id| id.email.is_some() || id.account_uuid.is_some())
}

/// Records the identity the account was confirmed to be (atomic; best effort).
pub fn pin_identity(config_dir: &Path, identity: &Identity) -> Result<(), String> {
    let mut body: Map<String, Value> = Map::new();
    body.insert("email".into(), json!(identity.email));
    body.insert("accountUuid".into(), json!(identity.account_uuid));
    body.insert("pinnedAt".into(), json!(now_ms()));
    let path = config_dir.join(IDENTITY_FILE);
    let tmp = config_dir.join(format!("{IDENTITY_FILE}.tmp"));
    let text = serde_json::to_string_pretty(&Value::Object(body)).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Whether the signed-in identity is the expected one. With an expected e-mail that decides;
/// else a pinned account uuid (or e-mail) does; with neither there is nothing to contradict.
fn identity_matches(
    actual: &Identity,
    expected_email: Option<&str>,
    pinned: Option<&Identity>,
) -> bool {
    let actual_email = normalize_email(actual.email.as_deref());
    if let Some(expected) = normalize_email(expected_email) {
        return actual_email.as_deref() == Some(expected.as_str());
    }
    match pinned {
        Some(pin) => match (&pin.account_uuid, &actual.account_uuid) {
            (Some(want), Some(have)) => want == have,
            _ => match normalize_email(pin.email.as_deref()) {
                Some(want) => actual_email.as_deref() == Some(want.as_str()),
                None => true,
            },
        },
        None => true,
    }
}

/// The check itself, with the renewal injected so tests never run the CLI.
pub async fn check_account<R, Fut>(
    config_dir: &Path,
    expected_email: Option<&str>,
    now: i64,
    refresh: R,
) -> Preflight
where
    R: FnOnce(PathBuf) -> Fut,
    Fut: Future<Output = bool>,
{
    let pinned = pinned_identity(config_dir);
    let expected = normalize_email(expected_email).or_else(|| {
        pinned
            .as_ref()
            .and_then(|p| normalize_email(p.email.as_deref()))
    });
    let mut result = Preflight {
        status: PreflightStatus::Ready,
        email: None,
        account_uuid: None,
        expected_email: expected.clone(),
        refreshed: false,
        seed_errors: Vec::new(),
    };
    let identity = oauth_identity(config_dir);
    result.email = identity.email.clone();
    result.account_uuid = identity.account_uuid.clone();

    let Some(creds): Option<AccountCredentials> = read_account_credentials(config_dir) else {
        result.status = PreflightStatus::NoLogin;
        return result;
    };
    if login_expired(&creds, now) {
        result.status = PreflightStatus::LoginExpired;
        return result;
    }
    // Checked before any renewal: renewing a token of the wrong account helps nobody.
    if identity.email.is_some() && !identity_matches(&identity, expected_email, pinned.as_ref()) {
        result.status = PreflightStatus::AccountMismatch;
        return result;
    }
    if access_token_expired(&creds, now) {
        if !refresh(config_dir.to_path_buf()).await {
            result.status = PreflightStatus::LoginExpired;
            return result;
        }
        result.refreshed = true;
        // The renewal may have refreshed the profile too.
        let fresh = oauth_identity(config_dir);
        result.email = fresh.email.clone().or(result.email);
        result.account_uuid = fresh.account_uuid.clone().or(result.account_uuid);
        if fresh.email.is_some() && !identity_matches(&fresh, expected_email, pinned.as_ref()) {
            result.status = PreflightStatus::AccountMismatch;
            return result;
        }
    }
    // First good check of this account: remember who it is, so a later silent switch shows.
    if pinned.is_none() && (result.email.is_some() || result.account_uuid.is_some()) {
        let _ = pin_identity(
            config_dir,
            &Identity {
                email: result.email.clone(),
                account_uuid: result.account_uuid.clone(),
            },
        );
    }
    result
}

/// `ensure_account_ready` for one launch: seeds the trust of `folders` into the agent's account
/// (`config_dir`; None is the default account) and into the other accounts given (the
/// orchestrator's), then checks the agent's account. The default account is only seeded: it
/// is Claude Code's own login, which this app does not manage.
pub async fn ensure_account_ready(
    config_dir: Option<PathBuf>,
    expected_email: Option<String>,
    folders: Vec<String>,
    also_seed: Vec<Option<PathBuf>>,
) -> Preflight {
    let mut targets = vec![config_dir.clone()];
    for dir in also_seed {
        if !targets.contains(&dir) {
            targets.push(dir);
        }
    }
    let seed_folders = folders.clone();
    let seed_errors = tauri::async_runtime::spawn_blocking(move || {
        trust_seed::seed_dirs(&targets, &seed_folders, false)
            .into_iter()
            .filter_map(Result::err)
            .collect::<Vec<_>>()
    })
    .await
    .unwrap_or_else(|e| vec![e.to_string()]);

    let mut result =
        match config_dir {
            None => Preflight {
                status: PreflightStatus::Ready,
                email: None,
                account_uuid: None,
                expected_email: None,
                refreshed: false,
                seed_errors: Vec::new(),
            },
            Some(dir) => check_account(
                &dir,
                expected_email.as_deref(),
                now_ms(),
                |dir| async move { crate::claude_usage::refresh_access_token(&dir, false).await },
            )
            .await,
        };
    result.seed_errors = seed_errors;
    result
}

/// Runs `ensure_account_ready` before an agent's PTY opens (spawn and resume). `config_dir`
/// empty means the default account; `also_seed` lists other config dirs to trust the folder in
/// (the orchestrator's account), empty strings again meaning the default one.
#[tauri::command]
pub async fn account_preflight(
    config_dir: Option<String>,
    expected_email: Option<String>,
    folders: Vec<String>,
    also_seed: Option<Vec<String>>,
) -> Result<Preflight, String> {
    let dir = |d: String| (!d.trim().is_empty()).then(|| PathBuf::from(d));
    let config_dir = config_dir.and_then(dir);
    if let Some(d) = &config_dir {
        if !d.is_dir() {
            return Err(format!("account folder not found: {}", d.display()));
        }
    }
    let also: Vec<Option<PathBuf>> = also_seed.unwrap_or_default().into_iter().map(dir).collect();
    Ok(ensure_account_ready(config_dir, expected_email, folders, also).await)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    const HOUR: i64 = 3_600_000;

    fn scratch(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("preflight-{name}-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn account(dir: &Path, email: &str, uuid: &str, expires_at: i64, refresh_expires_at: i64) {
        std::fs::write(
            dir.join(".claude.json"),
            json!({ "oauthAccount": { "emailAddress": email, "accountUuid": uuid }, "projects": {} })
                .to_string(),
        )
        .unwrap();
        std::fs::write(
            dir.join(".credentials.json"),
            json!({ "claudeAiOauth": {
                "accessToken": "test-access", "refreshToken": "test-refresh",
                "expiresAt": expires_at, "refreshTokenExpiresAt": refresh_expires_at
            } })
            .to_string(),
        )
        .unwrap();
    }

    fn block_on<F: Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(f)
    }

    fn no_refresh(
        calls: Arc<AtomicUsize>,
        ok: bool,
    ) -> impl FnOnce(PathBuf) -> std::future::Ready<bool> {
        move |_| {
            calls.fetch_add(1, Ordering::SeqCst);
            std::future::ready(ok)
        }
    }

    #[test]
    fn a_valid_account_is_ready_and_gets_pinned() {
        let dir = scratch("ok");
        let now = 1_000 * HOUR;
        account(
            &dir,
            "Compras@Example.com",
            "u-1",
            now + HOUR,
            now + 100 * HOUR,
        );
        let calls = Arc::new(AtomicUsize::new(0));
        let r = block_on(check_account(
            &dir,
            Some("compras@example.com "),
            now,
            no_refresh(calls.clone(), true),
        ));
        assert_eq!(r.status, PreflightStatus::Ready);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert_eq!(
            pinned_identity(&dir).unwrap().account_uuid.as_deref(),
            Some("u-1")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_expired_token_is_renewed_and_a_failed_renewal_blocks() {
        let dir = scratch("expired");
        let now = 1_000 * HOUR;
        account(&dir, "a@x.com", "u-1", now - HOUR, now + 100 * HOUR);
        let calls = Arc::new(AtomicUsize::new(0));
        let r = block_on(check_account(
            &dir,
            None,
            now,
            no_refresh(calls.clone(), true),
        ));
        assert_eq!(r.status, PreflightStatus::Ready);
        assert!(r.refreshed);
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        let r = block_on(check_account(
            &dir,
            None,
            now,
            no_refresh(calls.clone(), false),
        ));
        assert_eq!(r.status, PreflightStatus::LoginExpired);
        assert!(!r.refreshed);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_lapsed_sign_in_never_tries_to_renew() {
        let dir = scratch("lapsed");
        let now = 1_000 * HOUR;
        account(&dir, "a@x.com", "u-1", now - HOUR, now - 1);
        let calls = Arc::new(AtomicUsize::new(0));
        let r = block_on(check_account(
            &dir,
            None,
            now,
            no_refresh(calls.clone(), true),
        ));
        assert_eq!(r.status, PreflightStatus::LoginExpired);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn another_email_than_expected_is_a_switched_account() {
        let dir = scratch("switched");
        let now = 1_000 * HOUR;
        account(&dir, "contabil@x.com", "u-9", now - HOUR, now + 100 * HOUR);
        let calls = Arc::new(AtomicUsize::new(0));
        let r = block_on(check_account(
            &dir,
            Some("compras@x.com"),
            now,
            no_refresh(calls.clone(), true),
        ));
        assert_eq!(r.status, PreflightStatus::AccountMismatch);
        assert_eq!(r.email.as_deref(), Some("contabil@x.com"));
        assert_eq!(r.expected_email.as_deref(), Some("compras@x.com"));
        // No renewal for the wrong account, and nothing pinned.
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(pinned_identity(&dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn without_an_expected_email_the_pinned_identity_decides() {
        let dir = scratch("pinned");
        let now = 1_000 * HOUR;
        account(&dir, "compras@x.com", "u-1", now + HOUR, now + 100 * HOUR);
        let calls = Arc::new(AtomicUsize::new(0));
        assert_eq!(
            block_on(check_account(
                &dir,
                None,
                now,
                no_refresh(calls.clone(), true)
            ))
            .status,
            PreflightStatus::Ready
        );
        // A /login in the wrong browser moved it to another account.
        account(&dir, "contabil@x.com", "u-9", now + HOUR, now + 100 * HOUR);
        let r = block_on(check_account(
            &dir,
            None,
            now,
            no_refresh(calls.clone(), true),
        ));
        assert_eq!(r.status, PreflightStatus::AccountMismatch);
        assert_eq!(r.expected_email.as_deref(), Some("compras@x.com"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn no_credentials_means_never_signed_in() {
        let dir = scratch("none");
        std::fs::write(dir.join(".claude.json"), "{}").unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let r = block_on(check_account(&dir, None, 0, no_refresh(calls, true)));
        assert_eq!(r.status, PreflightStatus::NoLogin);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_launch_seeds_the_agent_and_the_orchestrator_accounts() {
        let worker = scratch("seed-w");
        let orchestrator = scratch("seed-o");
        let now = now_ms();
        account(&worker, "a@x.com", "u-1", now + HOUR, now + 100 * HOUR);
        std::fs::write(orchestrator.join(".claude.json"), r#"{"keep":1}"#).unwrap();
        let r = block_on(ensure_account_ready(
            Some(worker.clone()),
            None,
            vec![r"C:\Proj\App".into()],
            vec![Some(orchestrator.clone())],
        ));
        assert_eq!(r.status, PreflightStatus::Ready);
        assert!(r.seed_errors.is_empty());
        for dir in [&worker, &orchestrator] {
            let v: Value =
                serde_json::from_str(&std::fs::read_to_string(dir.join(".claude.json")).unwrap())
                    .unwrap();
            assert_eq!(v["projects"]["C:/Proj/App"]["hasTrustDialogAccepted"], true);
        }
        let _ = std::fs::remove_dir_all(&worker);
        let _ = std::fs::remove_dir_all(&orchestrator);
    }
}

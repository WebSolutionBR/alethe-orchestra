//! Signs one Claude account in again, in the right browser profile.
//!
//! `claude auth login` opens its authorization page with whatever `BROWSER` names, called as a
//! program with the URL as its only argument. Left alone that is the default browser, whose
//! claude.ai session belongs to whichever account was used there last, and the login silently
//! authorizes that account (06/10/2026: three accounts ended up on the same one). So `BROWSER`
//! points at this app's own executable, which, started with `ALETHE_LOGIN_BROWSER=1`, only opens
//! the URL in Chrome with the account's `--profile-directory` and exits (`login_browser_shim`,
//! called first thing in `main`). A `.cmd` cannot do this: the URL has `&` in it.
//!
//! The result is read back from the account's `.claude.json`, never from `claude auth status`,
//! which prints nothing useful when its output is redirected.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager};

use crate::account_lock::AccountLock;
use crate::account_preflight::{oauth_identity, pin_identity, Identity};

/// How long the user gets to authorize in the browser.
pub const LOGIN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
const SHIM_FLAG: &str = "ALETHE_LOGIN_BROWSER";
const SHIM_PROFILE: &str = "ALETHE_LOGIN_CHROME_PROFILE";
const OUTPUT_MAX: usize = 400;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoginResult {
    pub email: Option<String>,
    pub account_uuid: Option<String>,
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// A Chrome profile directory name ("Default", "Profile 7"): no path, no quotes.
fn valid_profile(profile: &str) -> bool {
    !profile.is_empty()
        && profile.len() <= 64
        && profile
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '-' || c == '_' || c == '.')
        && !profile.contains("..")
}

fn valid_email(email: &str) -> bool {
    let email = email.trim();
    email.len() <= 254
        && email.contains('@')
        && !email
            .chars()
            .any(|c| c.is_whitespace() || c == '"' || c == '\'')
}

/// Where Chrome is installed, machine-wide or per user.
fn chrome_path() -> Option<PathBuf> {
    let suffix = Path::new("Google")
        .join("Chrome")
        .join("Application")
        .join("chrome.exe");
    ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]
        .iter()
        .filter_map(|var| std::env::var_os(var))
        .map(|base| PathBuf::from(base).join(&suffix))
        .find(|path| path.is_file())
}

/// Chrome's user data folder, where each profile ("Default", "Profile 7") is a subfolder.
fn chrome_user_data() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(|base| {
        PathBuf::from(base)
            .join("Google")
            .join("Chrome")
            .join("User Data")
    })
}

/// Why a login cannot open its page in `profile`, checked before anything is spawned:
/// `chrome_not_found` or `bad_profile` (a malformed name, or no such profile folder).
fn check_browser(
    profile: &str,
    chrome: Option<&Path>,
    user_data: Option<&Path>,
) -> Result<(), &'static str> {
    if !valid_profile(profile) {
        return Err("bad_profile");
    }
    if chrome.is_none() {
        return Err("chrome_not_found");
    }
    match user_data {
        Some(dir) if dir.join(profile).is_dir() => Ok(()),
        _ => Err("bad_profile"),
    }
}

/// The arguments Chrome gets for one URL in one profile.
fn chrome_args(profile: &str, url: &str) -> Vec<String> {
    vec![format!("--profile-directory={profile}"), url.to_string()]
}

/// Run as `BROWSER` during a login: opens the URL in the account's Chrome profile and exits.
/// Returns false (run the app as usual) only when the login flag is absent: a start with the
/// flag always exits here, whatever its arguments, so a login never brings up a second app.
pub fn login_browser_shim() -> bool {
    if std::env::var_os(SHIM_FLAG).is_none_or(|v| v != "1") {
        return false;
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    let url = match args.as_slice() {
        [url] if url.starts_with("https://") || url.starts_with("http://") => url,
        // A non-zero exit makes Claude Code show its URL to paste by hand instead.
        _ => std::process::exit(1),
    };
    let profile = std::env::var(SHIM_PROFILE).unwrap_or_default();
    let opened = chrome_path()
        .filter(|_| valid_profile(&profile))
        .and_then(|chrome| {
            std::process::Command::new(chrome)
                .args(chrome_args(&profile, url))
                .spawn()
                .ok()
        })
        .is_some();
    // A non-zero exit makes Claude Code show its URL to paste by hand instead.
    std::process::exit(if opened { 0 } else { 1 });
}

fn clip(text: &str) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() > OUTPUT_MAX {
        format!("{}…", line.chars().take(OUTPUT_MAX).collect::<String>())
    } else {
        line
    }
}

/// What the login left in the account, checked against the e-mail asked for.
fn login_outcome(config_dir: &Path, email: Option<&str>) -> Result<LoginResult, String> {
    let identity: Identity = oauth_identity(config_dir);
    let Some(actual) = identity.email.clone() else {
        return Err("login_incomplete".into());
    };
    if let Some(want) = email {
        if !actual.trim().eq_ignore_ascii_case(want.trim()) {
            return Err(format!("account_mismatch: {actual}"));
        }
    }
    let _ = pin_identity(config_dir, &identity);
    // A fresh account would stop on the onboarding screens on its first spawn.
    let _ = crate::trust_seed::seed_file_locked(&config_dir.join(".claude.json"), &[], true);
    Ok(LoginResult {
        email: identity.email,
        account_uuid: identity.account_uuid,
    })
}

/// Signs account `account_id` in with `claude auth login --claudeai [--email <email>]` under
/// its own `CLAUDE_CONFIG_DIR`, opening the authorization page in Chrome profile
/// `chrome_profile` (none: Claude Code's default browser). Resolves with who the account is now
/// signed in as; fails with `account_mismatch: <e-mail>` when it is not `email`.
#[tauri::command]
pub async fn claude_account_login(
    app: AppHandle,
    account_id: String,
    email: Option<String>,
    chrome_profile: Option<String>,
) -> Result<LoginResult, String> {
    if !valid_id(&account_id) {
        return Err("invalid account id".into());
    }
    let email = email
        .map(|e| e.trim().to_string())
        .filter(|e| !e.is_empty());
    if email.as_deref().is_some_and(|e| !valid_email(e)) {
        return Err("invalid e-mail".into());
    }
    let profile = chrome_profile
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty());
    // Fails now, not after ten minutes of waiting on a page that never opened.
    if let Some(profile) = &profile {
        check_browser(
            profile,
            chrome_path().as_deref(),
            chrome_user_data().as_deref(),
        )?;
    }
    let config_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("claude-accounts")
        .join(&account_id);
    std::fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;
    let Some(bin) = crate::cli_resolver::find_windows_cli_launcher("claude") else {
        return Err("claude_not_found".into());
    };
    // The account's single writer while the user signs in: no renewal runs meanwhile.
    let Some(_lock) = AccountLock::acquire_async(&config_dir, Duration::from_secs(30)).await else {
        return Err("account_busy".into());
    };

    let mut command = tokio::process::Command::new(bin);
    command.args(["auth", "login", "--claudeai"]);
    if let Some(email) = &email {
        command.args(["--email", email]);
    }
    command
        .env("CLAUDE_CONFIG_DIR", &config_dir)
        .env_remove("ANTHROPIC_API_KEY")
        .env_remove("CLAUDE_CODE_OAUTH_TOKEN")
        .current_dir(&config_dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    if let Some(profile) = &profile {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        command
            .env("BROWSER", exe)
            .env(SHIM_FLAG, "1")
            .env(SHIM_PROFILE, profile);
    }
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let child = command.spawn().map_err(|e| e.to_string())?;
    let output = match tokio::time::timeout(LOGIN_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => return Err(e.to_string()),
        Err(_) => return Err("login_timeout".into()),
    };
    if !output.status.success() {
        let said = clip(&format!(
            "{} {}",
            String::from_utf8_lossy(&output.stderr),
            String::from_utf8_lossy(&output.stdout)
        ));
        return Err(if said.is_empty() {
            format!("login_failed: exit {}", output.status.code().unwrap_or(-1))
        } else {
            format!("login_failed: {said}")
        });
    }
    login_outcome(&config_dir, email.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn scratch(name: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("claude-login-{name}-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn profiles_and_emails_are_checked_before_reaching_a_command_line() {
        assert!(valid_profile("Profile 7"));
        assert!(valid_profile("Default"));
        assert!(!valid_profile("..\\x"));
        assert!(!valid_profile("a\" --b"));
        assert!(!valid_profile(""));
        assert!(valid_email("compras@example.com"));
        assert!(!valid_email("a b@c"));
        assert!(!valid_email("nope"));
        assert_eq!(
            chrome_args("Profile 9", "https://claude.ai/oauth?a=1&b=2"),
            vec![
                "--profile-directory=Profile 9".to_string(),
                "https://claude.ai/oauth?a=1&b=2".to_string()
            ]
        );
    }

    #[test]
    fn a_missing_chrome_or_profile_fails_before_any_spawn() {
        let data = scratch("chrome");
        std::fs::create_dir_all(data.join("Profile 7")).unwrap();
        let chrome = data.join("chrome.exe");
        assert_eq!(
            check_browser("Profile 7", Some(&chrome), Some(&data)),
            Ok(())
        );
        assert_eq!(
            check_browser("Profile 9", Some(&chrome), Some(&data)),
            Err("bad_profile")
        );
        assert_eq!(
            check_browser("a\" --b", Some(&chrome), Some(&data)),
            Err("bad_profile")
        );
        assert_eq!(
            check_browser("Profile 7", None, Some(&data)),
            Err("chrome_not_found")
        );
        assert_eq!(
            check_browser("Profile 7", Some(&chrome), None),
            Err("bad_profile")
        );
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn the_outcome_is_read_from_the_config_and_pins_the_identity() {
        let dir = scratch("ok");
        std::fs::write(
            dir.join(".claude.json"),
            json!({ "oauthAccount": { "emailAddress": "Compras@x.com", "accountUuid": "u-1" }, "x": 1 })
                .to_string(),
        )
        .unwrap();
        let result = login_outcome(&dir, Some("compras@x.com")).unwrap();
        assert_eq!(result.account_uuid.as_deref(), Some("u-1"));
        assert_eq!(
            crate::account_preflight::pinned_identity(&dir)
                .unwrap()
                .account_uuid
                .as_deref(),
            Some("u-1")
        );
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(".claude.json")).unwrap())
                .unwrap();
        assert_eq!(v["hasCompletedOnboarding"], true);
        assert_eq!(v["x"], 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_login_into_another_account_is_refused() {
        let dir = scratch("other");
        std::fs::write(
            dir.join(".claude.json"),
            json!({ "oauthAccount": { "emailAddress": "contabil@x.com", "accountUuid": "u-9" } })
                .to_string(),
        )
        .unwrap();
        assert_eq!(
            login_outcome(&dir, Some("compras@x.com")).unwrap_err(),
            "account_mismatch: contabil@x.com"
        );
        assert!(crate::account_preflight::pinned_identity(&dir).is_none());
        std::fs::write(dir.join(".claude.json"), "{}").unwrap();
        assert_eq!(login_outcome(&dir, None).unwrap_err(), "login_incomplete");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

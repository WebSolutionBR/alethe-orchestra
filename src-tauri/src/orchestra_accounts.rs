//! Claude accounts in Alethe Orchestra: the per-session account policy that `orch spawn`
//! honours, and the real Claude identity each account folder is signed in as.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Sessions that run every agent on one account, with the label of that account (what the
/// orchestrator is told when its `--account` is dropped).
struct Policies(Mutex<BTreeMap<String, String>>);

impl Policies {
    const fn new() -> Self {
        Self(Mutex::new(BTreeMap::new()))
    }

    fn lock(&self) -> MutexGuard<'_, BTreeMap<String, String>> {
        // Recover from poisoning: the map stays consistent and release builds abort on panic.
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn set(&self, session: &str, single: bool, label: &str) {
        let mut map = self.lock();
        if single {
            map.insert(session.to_string(), label.to_string());
        } else {
            map.remove(session);
        }
    }

    fn single(&self, session: &str) -> Option<String> {
        self.lock().get(session).cloned()
    }

    fn forget(&self, session: &str) {
        self.lock().remove(session);
    }
}

static POLICIES: Policies = Policies::new();

/// Longest account label kept for the spawn reply.
const MAX_LABEL: usize = 80;

fn valid_session(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 32
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Sets how a session uses accounts: `single` drops every `orch spawn --account` (the frontend
/// launches its workers on the session's account); otherwise the flag passes through.
/// `label` names the session's account in the reply the orchestrator reads.
#[tauri::command]
pub fn orchestra_account_policy(session_id: String, single: bool, label: Option<String>) {
    if !valid_session(&session_id) {
        return;
    }
    let label: String = label
        .unwrap_or_default()
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_LABEL)
        .collect();
    POLICIES.set(&session_id, single, &label);
}

/// A finished session forgets its policy.
pub fn forget(session: &str) {
    POLICIES.forget(session);
}

/// What a spawn of `session` keeps of its `--account` (`account`, null when not given).
/// Returns the account for the event and, when a one-account session dropped it, the line
/// the orchestrator reads in the reply.
pub fn spawn_account(session: &str, account: Value) -> (Value, Option<String>) {
    apply_policy(POLICIES.single(session).as_deref(), account)
}

fn apply_policy(single: Option<&str>, account: Value) -> (Value, Option<String>) {
    match (single, account) {
        (Some(label), Value::String(asked)) => {
            let name = if label.is_empty() { "default" } else { label };
            let notice = format!(
                "this session runs every agent on one account ({name}); --account {asked} was ignored"
            );
            (Value::Null, Some(notice))
        }
        (_, account) => (account, None),
    }
}

/* ------------------------------------------------------------------ real identity */

/// An account folder to read: its id and its `CLAUDE_CONFIG_DIR` (empty: `~/.claude.json`).
#[derive(Debug, Deserialize)]
pub struct IdentityRef {
    pub id: String,
    pub config_dir: String,
}

/// Who an account folder is really signed in as, from `oauthAccount` in its `.claude.json`.
/// Every field is null when the folder never signed in or the file cannot be read.
#[derive(Debug, Default, Serialize, PartialEq)]
pub struct AccountIdentity {
    pub id: String,
    pub email: Option<String>,
    pub account_uuid: Option<String>,
    pub organization_name: Option<String>,
}

fn claude_json_path(config_dir: &str) -> Option<PathBuf> {
    if config_dir.trim().is_empty() {
        dirs_next::home_dir().map(|home| home.join(".claude.json"))
    } else {
        Some(Path::new(config_dir).join(".claude.json"))
    }
}

fn text_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// The identity in a `.claude.json` document (only the fields the panel shows).
fn identity_of(id: &str, document: &Value) -> AccountIdentity {
    let oauth = document.get("oauthAccount").unwrap_or(&Value::Null);
    AccountIdentity {
        id: id.to_string(),
        email: text_field(oauth, "emailAddress"),
        account_uuid: text_field(oauth, "accountUuid"),
        organization_name: text_field(oauth, "organizationName"),
    }
}

fn read_identity(account: &IdentityRef) -> AccountIdentity {
    let document = claude_json_path(&account.config_dir)
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or(Value::Null);
    identity_of(&account.id, &document)
}

/// The real Claude identity of each account folder. Reads files only; never a token.
#[tauri::command]
pub async fn orchestra_account_identities(accounts: Vec<IdentityRef>) -> Vec<AccountIdentity> {
    tauri::async_runtime::spawn_blocking(move || accounts.iter().map(read_identity).collect())
        .await
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn single_session_drops_the_account_flag() {
        let (account, notice) = apply_policy(Some("Compras"), json!("acc-b"));
        assert_eq!(account, Value::Null);
        let notice = notice.expect("a notice for the orchestrator");
        assert!(notice.contains("one account (Compras)"));
        assert!(notice.contains("--account acc-b was ignored"));
    }

    #[test]
    fn single_session_without_flag_says_nothing() {
        assert_eq!(
            apply_policy(Some("Compras"), Value::Null),
            (Value::Null, None)
        );
    }

    #[test]
    fn spread_session_keeps_the_account_flag() {
        assert_eq!(apply_policy(None, json!("acc-b")), (json!("acc-b"), None));
    }

    #[test]
    fn policy_is_per_session_and_forgotten() {
        orchestra_account_policy("oacctest1".into(), true, Some(" Contábil\n".into()));
        orchestra_account_policy("oacctest2".into(), false, None);
        let (account, notice) = spawn_account("oacctest1", json!("x"));
        assert_eq!(account, Value::Null);
        assert!(notice.unwrap().contains("(Contábil)"));
        assert_eq!(spawn_account("oacctest2", json!("x")).0, json!("x"));
        // Switching back to spread lets the flag through again.
        orchestra_account_policy("oacctest1".into(), false, None);
        assert_eq!(spawn_account("oacctest1", json!("x")).0, json!("x"));
        orchestra_account_policy("oacctest1".into(), true, None);
        forget("oacctest1");
        assert_eq!(spawn_account("oacctest1", json!("x")).0, json!("x"));
    }

    #[test]
    fn invalid_session_ids_are_ignored() {
        orchestra_account_policy("Bad Id".into(), true, None);
        assert_eq!(spawn_account("Bad Id", json!("x")).0, json!("x"));
    }

    #[test]
    fn identity_reads_oauth_account() {
        let doc = json!({
            "oauthAccount": {
                "emailAddress": "compras@example.com",
                "accountUuid": "uuid-1",
                "organizationName": "Org",
                "accessToken": "never-read"
            }
        });
        assert_eq!(
            identity_of("a1", &doc),
            AccountIdentity {
                id: "a1".into(),
                email: Some("compras@example.com".into()),
                account_uuid: Some("uuid-1".into()),
                organization_name: Some("Org".into()),
            }
        );
        assert_eq!(
            identity_of("a2", &json!({})),
            AccountIdentity {
                id: "a2".into(),
                ..Default::default()
            }
        );
    }

    #[test]
    fn identity_of_a_folder_on_disk() {
        let dir = std::env::temp_dir().join(format!("alethe-identity-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(".claude.json"),
            r#"{"oauthAccount":{"emailAddress":"a@b.c","accountUuid":"u-9"}}"#,
        )
        .unwrap();
        let found = read_identity(&IdentityRef {
            id: "x".into(),
            config_dir: dir.to_string_lossy().into_owned(),
        });
        assert_eq!(found.email.as_deref(), Some("a@b.c"));
        assert_eq!(found.account_uuid.as_deref(), Some("u-9"));
        let missing = read_identity(&IdentityRef {
            id: "y".into(),
            config_dir: dir.join("nope").to_string_lossy().into_owned(),
        });
        assert_eq!(missing.email, None);
        let _ = fs::remove_dir_all(&dir);
    }
}

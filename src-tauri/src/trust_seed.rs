//! Seeds Claude Code's folder trust into an account's `.claude.json`, so an agent spawned in a
//! folder the user already picked never stops on "Is this a project you trust?".
//!
//! The file belongs to a CLI that may be running and rewriting it at any moment, so a seed reads,
//! merges into what is there (every other field kept), writes through a temp file and a rename,
//! then reads again to check the key survived, retrying when a concurrent write won. Right before
//! the rename it checks the file still has the size and modification time it was read with, and
//! merges again over the newer one when not. In an account dir of this app it also holds the
//! account's lock (briefly; see `account_lock`). It never writes a file it cannot parse, and a
//! seed that is already in place writes nothing.
//!
//! The key is the folder as Claude Code itself keys `projects` on Windows: its path with `/`
//! separators (Claude Code 2.x turns `\` into `/` before every lookup). A file that still has
//! keys with `\` (written by an older CLI) also gets the `\` spelling of the key.

use serde::Serialize;
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use crate::account_lock::AccountLock;

const ATTEMPTS: usize = 6;
const RETRY_DELAY: Duration = Duration::from_millis(120);
/// How long a seed waits for the account's lock; past it the seed goes on unlocked, since the
/// stamp check before the rename still keeps it from overwriting a newer file.
const LOCK_WAIT: Duration = Duration::from_millis(1500);

/// What one seed did to one `.claude.json`.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SeedOutcome {
    pub path: String,
    /// False when everything asked for was already there (nothing written).
    pub written: bool,
    /// The `projects` keys that are now trusted.
    pub keys: Vec<String>,
}

/// The `.claude.json` Claude Code reads for an account: `<config dir>/.claude.json`, or
/// `~/.claude.json` when the agent runs without `CLAUDE_CONFIG_DIR`.
pub fn config_file(config_dir: Option<&Path>) -> Option<PathBuf> {
    match config_dir {
        Some(dir) => Some(dir.join(".claude.json")),
        None => dirs_next::home_dir().map(|home| home.join(".claude.json")),
    }
}

/// A folder as a `projects` key: `/` separators, no trailing separator (a drive root keeps it).
pub fn project_key(folder: &str) -> String {
    let mut key = folder.trim().replace('\\', "/");
    while key.len() > 1 && key.ends_with('/') && !(key.len() == 3 && key.as_bytes()[1] == b':') {
        key.pop();
    }
    key
}

/// The same key with Windows' own `\` separators, as older Claude Code versions wrote it.
fn backslash_key(key: &str) -> String {
    key.replace('/', "\\")
}

/// Whether the file keys its projects the old way (with `\`).
fn uses_backslash_keys(config: &Map<String, Value>) -> bool {
    config
        .get("projects")
        .and_then(Value::as_object)
        .is_some_and(|projects| projects.keys().any(|k| k.contains('\\')))
}

fn keys_for(config: &Map<String, Value>, folders: &[String]) -> Vec<String> {
    let old_style = uses_backslash_keys(config);
    let mut keys = Vec::new();
    for folder in folders {
        let key = project_key(folder);
        if key.is_empty() {
            continue;
        }
        if old_style {
            let native = backslash_key(&key);
            if !keys.contains(&native) {
                keys.push(native);
            }
        }
        if !keys.contains(&key) {
            keys.push(key);
        }
    }
    keys
}

fn trusted(config: &Map<String, Value>, key: &str) -> bool {
    config
        .get("projects")
        .and_then(|p| p.get(key))
        .and_then(|p| p.get("hasTrustDialogAccepted"))
        .and_then(Value::as_bool)
        == Some(true)
}

fn satisfied(config: &Map<String, Value>, keys: &[String], onboarding: bool) -> bool {
    keys.iter().all(|k| trusted(config, k))
        && (!onboarding
            || config
                .get("hasCompletedOnboarding")
                .and_then(Value::as_bool)
                == Some(true))
}

/// Sets the trust (and, with `onboarding`, the finished onboarding) on a parsed config, keeping
/// every other field. Returns whether anything changed.
pub fn merge(config: &mut Map<String, Value>, keys: &[String], onboarding: bool) -> bool {
    let mut changed = false;
    if onboarding
        && config
            .get("hasCompletedOnboarding")
            .and_then(Value::as_bool)
            != Some(true)
    {
        config.insert("hasCompletedOnboarding".into(), Value::Bool(true));
        changed = true;
    }
    if keys.is_empty() {
        return changed;
    }
    let projects = config
        .entry("projects")
        .or_insert_with(|| Value::Object(Map::new()));
    if !projects.is_object() {
        *projects = Value::Object(Map::new());
    }
    let projects = projects.as_object_mut().expect("object");
    for key in keys {
        let entry = projects
            .entry(key.clone())
            .or_insert_with(|| Value::Object(Map::new()));
        if !entry.is_object() {
            *entry = Value::Object(Map::new());
        }
        let entry = entry.as_object_mut().expect("object");
        if entry.get("hasTrustDialogAccepted").and_then(Value::as_bool) != Some(true) {
            entry.insert("hasTrustDialogAccepted".into(), Value::Bool(true));
            changed = true;
        }
    }
    changed
}

enum Read {
    Missing,
    Parsed(Map<String, Value>),
    /// Unreadable or not a JSON object (maybe half written by the CLI right now).
    Bad(String),
}

fn read(path: &Path) -> Read {
    match std::fs::read_to_string(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Read::Missing,
        Err(e) => Read::Bad(e.to_string()),
        Ok(text) if text.trim().is_empty() => Read::Bad("empty file".into()),
        Ok(text) => match serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) {
            Ok(Value::Object(map)) => Read::Parsed(map),
            Ok(_) => Read::Bad("not a JSON object".into()),
            Err(e) => Read::Bad(e.to_string()),
        },
    }
}

/// The parsed `.claude.json`, retried a few times over a half-written file; None when it is
/// missing or stays unreadable.
pub fn read_config(path: &Path) -> Option<Map<String, Value>> {
    for attempt in 0..ATTEMPTS {
        if attempt > 0 {
            std::thread::sleep(RETRY_DELAY);
        }
        match read(path) {
            Read::Parsed(map) => return Some(map),
            Read::Missing => return None,
            Read::Bad(_) => continue,
        }
    }
    None
}

fn tmp_path(path: &Path) -> PathBuf {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(format!(".alethe-{}.tmp", std::process::id()));
    PathBuf::from(tmp)
}

/// Size and modification time: what tells that someone rewrote the file since it was read.
type Stamp = Option<(u64, SystemTime)>;

fn stamp(path: &Path) -> Stamp {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.len(), meta.modified().ok()?))
}

enum Written {
    Done,
    /// The file changed after it was read: nothing was replaced.
    Raced,
}

/// Temp file and rename, so a reader (the CLI) never sees half a file; the rename happens only
/// if `path` still has the stamp it was read with.
fn write_if_unchanged(
    path: &Path,
    contents: &str,
    read_stamp: &Stamp,
    before_rename: &mut dyn FnMut(),
) -> Result<Written, String> {
    let tmp = tmp_path(path);
    std::fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    before_rename();
    if stamp(path) != *read_stamp {
        let _ = std::fs::remove_file(&tmp);
        return Ok(Written::Raced);
    }
    std::fs::rename(&tmp, path)
        .map(|()| Written::Done)
        .map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            e.to_string()
        })
}

/// Temp file and rename without the stamp check: the "CLI" of the race test.
#[cfg(test)]
fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    let tmp = tmp_path(path);
    std::fs::write(&tmp, contents).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

/// Seeds trust for `folders` (and the finished onboarding) into one `.claude.json`. Retries on a
/// concurrent rewrite; a file missing altogether is created only when its folder exists. In an
/// app account dir, holds the account's lock while it works (see `LOCK_WAIT`).
pub fn seed_file(path: &Path, folders: &[String], onboarding: bool) -> Result<SeedOutcome, String> {
    let _lock = path
        .parent()
        .filter(|dir| is_account_dir(dir))
        .and_then(|dir| AccountLock::acquire(dir, LOCK_WAIT));
    seed_file_with(path, folders, onboarding, &mut || {})
}

/// `seed_file` for a caller that already holds the account's lock (the login).
pub fn seed_file_locked(
    path: &Path,
    folders: &[String],
    onboarding: bool,
) -> Result<SeedOutcome, String> {
    seed_file_with(path, folders, onboarding, &mut || {})
}

/// The seed itself; `before_rename` lets tests rewrite the file at the worst moment.
fn seed_file_with(
    path: &Path,
    folders: &[String],
    onboarding: bool,
    before_rename: &mut dyn FnMut(),
) -> Result<SeedOutcome, String> {
    let mut last_error = String::from("not attempted");
    let mut written = false;
    for attempt in 0..ATTEMPTS {
        if attempt > 0 {
            std::thread::sleep(RETRY_DELAY);
        }
        // Taken before the read: a write in between shows as a changed stamp, never as lost.
        let read_stamp = stamp(path);
        let mut config = match read(path) {
            Read::Parsed(map) => map,
            Read::Missing => {
                if !path.parent().is_some_and(Path::is_dir) {
                    return Err(format!("config folder not found: {}", path.display()));
                }
                Map::new()
            }
            Read::Bad(why) => {
                // Never overwrite what we cannot parse: wait for the writer to finish.
                last_error = format!("unreadable {}: {why}", path.display());
                continue;
            }
        };
        let keys = keys_for(&config, folders);
        if satisfied(&config, &keys, onboarding) {
            return Ok(SeedOutcome {
                path: path.to_string_lossy().into_owned(),
                written,
                keys,
            });
        }
        merge(&mut config, &keys, onboarding);
        let body = match serde_json::to_string_pretty(&Value::Object(config)) {
            Ok(body) => body,
            Err(e) => return Err(e.to_string()),
        };
        match write_if_unchanged(path, &body, &read_stamp, before_rename) {
            Ok(Written::Done) => written = true,
            Ok(Written::Raced) => last_error = format!("{} kept changing", path.display()),
            Err(e) => last_error = format!("write {}: {e}", path.display()),
        }
        // The next pass reads the file again: done when the seed is there, else merge anew.
    }
    Err(last_error)
}

/// Seeds every config dir given (None: the default `~/.claude.json`); one failure does not stop
/// the others.
pub fn seed_dirs(
    config_dirs: &[Option<PathBuf>],
    folders: &[String],
    onboarding: bool,
) -> Vec<Result<SeedOutcome, String>> {
    config_dirs
        .iter()
        .map(|dir| match config_file(dir.as_deref()) {
            Some(path) => seed_file(&path, folders, onboarding),
            None => Err("no home folder".into()),
        })
        .collect()
}

/// `<...>/claude-accounts/<id>`: the per-account config dir layout of this app.
fn is_account_dir(dir: &Path) -> bool {
    let id_ok = dir.file_name().and_then(|n| n.to_str()).is_some_and(|id| {
        !id.is_empty()
            && id.len() <= 64
            && id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    });
    id_ok
        && dir
            .parent()
            .and_then(|p| p.file_name())
            .is_some_and(|n| n == "claude-accounts")
}

/// Trusts `folders` in the accounts at `config_dirs` (an empty string means the default
/// account) and, with `onboarding`, marks their onboarding finished; for account creation and
/// import. Returns one error per account that could not be seeded.
#[tauri::command]
pub async fn account_trust_seed(
    config_dirs: Vec<String>,
    folders: Vec<String>,
    onboarding: bool,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dirs: Vec<Option<PathBuf>> = config_dirs
            .iter()
            .map(|d| (!d.trim().is_empty()).then(|| PathBuf::from(d)))
            .collect();
        // A just-created account has no dir yet; only an app account dir is created here.
        for dir in dirs.iter().flatten() {
            if !dir.exists() && is_account_dir(dir) {
                let _ = std::fs::create_dir_all(dir);
            }
        }
        seed_dirs(&dirs, &folders, onboarding)
            .into_iter()
            .filter_map(Result::err)
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
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
        let dir = std::env::temp_dir().join(format!("trust-seed-{name}-{nanos}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn read_json(path: &Path) -> Value {
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn keys_are_the_cli_spelling_with_forward_slashes() {
        assert_eq!(
            project_key(r"C:\Users\ti001\Documents\Proj\"),
            "C:/Users/ti001/Documents/Proj"
        );
        assert_eq!(project_key("C:/Users/x/"), "C:/Users/x");
        assert_eq!(project_key(r"C:\"), "C:/");
        assert_eq!(project_key(r"\\server\share\dir"), "//server/share/dir");
    }

    #[test]
    fn merge_keeps_every_other_field_and_project() {
        let dir = scratch("merge");
        let file = dir.join(".claude.json");
        let original = json!({
            "numStartups": 12,
            "oauthAccount": { "emailAddress": "a@b.c", "accountUuid": "u-1" },
            "projects": {
                "C:/Users/Profile": { "hasTrustDialogAccepted": true, "allowedTools": ["Bash"] },
                "C:/Work/App": { "hasTrustDialogAccepted": false, "lastCost": 1.5, "mcpServers": { "x": {} } }
            },
            "mcpServers": { "obsidian": { "command": "npx" } }
        });
        std::fs::write(&file, serde_json::to_string_pretty(&original).unwrap()).unwrap();

        let out = seed_file(&file, &[r"C:\Work\App".into(), r"C:\New\One".into()], true).unwrap();
        assert!(out.written);
        let after = read_json(&file);
        assert_eq!(after["numStartups"], 12);
        assert_eq!(after["oauthAccount"]["accountUuid"], "u-1");
        assert_eq!(after["mcpServers"]["obsidian"]["command"], "npx");
        assert_eq!(
            after["projects"]["C:/Users/Profile"]["allowedTools"][0],
            "Bash"
        );
        assert_eq!(
            after["projects"]["C:/Work/App"]["hasTrustDialogAccepted"],
            true
        );
        assert_eq!(after["projects"]["C:/Work/App"]["lastCost"], 1.5);
        assert!(after["projects"]["C:/Work/App"]["mcpServers"]["x"].is_object());
        assert_eq!(
            after["projects"]["C:/New/One"]["hasTrustDialogAccepted"],
            true
        );
        assert_eq!(after["hasCompletedOnboarding"], true);
        // No `\` spelling in a file the current CLI wrote.
        assert!(after["projects"].get(r"C:\New\One").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_second_seed_writes_nothing() {
        let dir = scratch("idem");
        let file = dir.join(".claude.json");
        std::fs::write(&file, r#"{"projects":{}}"#).unwrap();
        assert!(seed_file(&file, &[r"D:\p".into()], false).unwrap().written);
        let first = std::fs::read_to_string(&file).unwrap();
        let modified = std::fs::metadata(&file).unwrap().modified().unwrap();
        std::thread::sleep(Duration::from_millis(20));
        let again = seed_file(&file, &[r"D:\p\".into(), "D:/p".into()], false).unwrap();
        assert!(!again.written);
        assert_eq!(again.keys, vec!["D:/p".to_string()]);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), first);
        assert_eq!(
            std::fs::metadata(&file).unwrap().modified().unwrap(),
            modified
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_old_style_file_also_gets_the_native_backslash_key() {
        let dir = scratch("native");
        let file = dir.join(".claude.json");
        std::fs::write(
            &file,
            r#"{"projects":{"C:\\Users\\ti001":{"hasTrustDialogAccepted":true}}}"#,
        )
        .unwrap();
        let out = seed_file(&file, &[r"C:\Users\ti001\Projetos".into()], false).unwrap();
        assert_eq!(
            out.keys,
            vec![
                r"C:\Users\ti001\Projetos".to_string(),
                "C:/Users/ti001/Projetos".to_string()
            ]
        );
        let after = read_json(&file);
        assert_eq!(
            after["projects"][r"C:\Users\ti001\Projetos"]["hasTrustDialogAccepted"],
            true
        );
        assert_eq!(
            after["projects"]["C:/Users/ti001/Projetos"]["hasTrustDialogAccepted"],
            true
        );
        assert_eq!(
            after["projects"][r"C:\Users\ti001"]["hasTrustDialogAccepted"],
            true
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_file_is_created_in_an_existing_folder_only() {
        let dir = scratch("missing");
        let file = dir.join(".claude.json");
        let out = seed_file(&file, &["E:/x".into()], true).unwrap();
        assert!(out.written);
        assert_eq!(
            read_json(&file)["projects"]["E:/x"]["hasTrustDialogAccepted"],
            true
        );
        assert!(seed_file(
            &dir.join("nope").join(".claude.json"),
            &["E:/x".into()],
            true
        )
        .is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_an_app_account_dir_may_be_created() {
        assert!(is_account_dir(Path::new(
            "C:/data/claude-accounts/Ci8cd-pn"
        )));
        assert!(!is_account_dir(Path::new("C:/data/claude-accounts")));
        assert!(!is_account_dir(Path::new("C:/Users/x/.claude")));
        assert!(!is_account_dir(Path::new("C:/data/other/abc")));
    }

    #[test]
    fn an_unparsable_file_is_never_overwritten() {
        let dir = scratch("bad");
        let file = dir.join(".claude.json");
        std::fs::write(&file, "{ \"projects\": { half").unwrap();
        assert!(seed_file(&file, &["E:/x".into()], false).is_err());
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "{ \"projects\": { half"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_rewrite_between_the_read_and_the_rename_is_merged_again() {
        let dir = scratch("stamp");
        let file = dir.join(".claude.json");
        std::fs::write(&file, r#"{"projects":{},"n":1}"#).unwrap();
        let racer = file.clone();
        let mut renames = 0;
        // The CLI rewrites the file (new field, other size) just before our first rename.
        let mut hook = || {
            if renames == 0 {
                std::thread::sleep(Duration::from_millis(20));
                std::fs::write(&racer, r#"{"projects":{},"n":2,"fromCli":"fresh"}"#).unwrap();
            }
            renames += 1;
        };
        let out = seed_file_with(&file, &["G:/stamp".into()], false, &mut hook).unwrap();
        assert!(out.written);
        assert_eq!(
            renames, 2,
            "the first rename must be dropped and the merge redone"
        );
        let after = read_json(&file);
        assert_eq!(after["fromCli"], "fresh");
        assert_eq!(after["n"], 2);
        assert_eq!(
            after["projects"]["G:/stamp"]["hasTrustDialogAccepted"],
            true
        );
        assert!(!tmp_path(&file).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_account_dir_is_seeded_under_its_lock() {
        let root = scratch("lock");
        let dir = root.join("claude-accounts").join("acc-1");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(".claude.json");
        std::fs::write(&file, "{}").unwrap();
        // Someone else holds the account: the seed waits LOCK_WAIT, then still seeds.
        let held = AccountLock::try_acquire(&dir).unwrap();
        let started = std::time::Instant::now();
        assert!(seed_file(&file, &["H:/a".into()], false).unwrap().written);
        assert!(started.elapsed() >= LOCK_WAIT);
        drop(held);
        // Free: it takes the lock and leaves no lock file behind.
        assert!(seed_file(&file, &["H:/b".into()], false).unwrap().written);
        assert!(!dir.join(crate::account_lock::LOCK_FILE).exists());
        assert_eq!(
            read_json(&file)["projects"]["H:/b"]["hasTrustDialogAccepted"],
            true
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_concurrent_rewrite_is_retried_until_the_seed_holds() {
        let dir = scratch("race");
        let file = dir.join(".claude.json");
        std::fs::write(&file, r#"{"projects":{},"n":1}"#).unwrap();
        // A "CLI" that rewrites the file from its own stale copy a few times while we seed.
        let racer_file = file.clone();
        let racer = std::thread::spawn(move || {
            for i in 0..3 {
                std::thread::sleep(Duration::from_millis(40));
                let _ = write_atomic(
                    &racer_file,
                    &format!(r#"{{"projects":{{}},"n":{}}}"#, i + 2),
                );
            }
        });
        let started = std::time::Instant::now();
        let mut ok = false;
        while started.elapsed() < Duration::from_secs(3) {
            seed_file(&file, &["F:/race".into()], false).unwrap();
            std::thread::sleep(Duration::from_millis(30));
            if racer.is_finished() {
                ok = true;
                break;
            }
        }
        racer.join().unwrap();
        assert!(ok);
        // After the racer stopped, one more seed is enough and the other fields survived.
        seed_file(&file, &["F:/race".into()], false).unwrap();
        let after = read_json(&file);
        assert_eq!(after["projects"]["F:/race"]["hasTrustDialogAccepted"], true);
        assert!(after["n"].as_i64().unwrap() >= 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

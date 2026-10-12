//! One-way import from the original Alethe install (`com.kc1t.alethe`).
//!
//! Alethe Orchestra ships under its own identifier, so it starts with an empty
//! app data dir. These commands only ever READ the original install: the
//! frontend merges the legacy `projects.json` into its own store, and the
//! per-account Claude config dirs are copied (never moved) into ours.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

const LEGACY_IDENTIFIER: &str = "com.kc1t.alethe";
const MARKER_FILE: &str = "legacy-import.json";
const ACCOUNTS_DIR: &str = "claude-accounts";
/// Regenerable or bulky Claude Code state that is not worth duplicating.
const SKIPPED_ACCOUNT_DIRS: &[&str] = &["cache", "backups", "paste-cache", "shell-snapshots"];
/// Files that belong to the original account dir alone. The credentials above all: two dirs
/// with the same refresh token fight over it, since each renewal rotates it and kills the other
/// copy (05/10/2026: imported workers started on "Login expired"). An imported account signs in
/// again with its own login instead. The lock and the pinned identity are per dir too.
const SKIPPED_ACCOUNT_FILES: &[&str] = &[
    ".credentials.json",
    crate::account_lock::LOCK_FILE,
    crate::account_preflight::IDENTITY_FILE,
];

#[derive(Serialize, Default, Clone)]
pub struct LegacyMarker {
    pub imported_at: Option<u64>,
    pub last_sync_at: Option<u64>,
    pub source_dir: Option<String>,
}

#[derive(Serialize)]
pub struct LegacyStatus {
    pub available: bool,
    pub source_dir: Option<String>,
    pub profile_id: Option<String>,
    pub marker: LegacyMarker,
}

#[derive(Serialize)]
pub struct AccountCopyResult {
    pub id: String,
    pub found: bool,
    pub files_copied: u32,
    pub error: Option<String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn legacy_root() -> Option<PathBuf> {
    let dir = dirs_next::data_local_dir()?.join(LEGACY_IDENTIFIER);
    dir.is_dir().then_some(dir)
}

fn our_root(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Active profile of the original install (falls back to `default`).
fn legacy_profile_id(root: &Path) -> String {
    fs::read_to_string(root.join("profiles.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.get("active_profile_id")?.as_str().map(str::to_string))
        .filter(|id| valid_id(id))
        .unwrap_or_else(|| "default".to_string())
}

fn legacy_projects_path(root: &Path) -> PathBuf {
    root.join("profiles")
        .join(legacy_profile_id(root))
        .join("projects.json")
}

fn read_marker(app: &AppHandle) -> LegacyMarker {
    let Ok(root) = our_root(app) else {
        return LegacyMarker::default();
    };
    let Ok(raw) = fs::read_to_string(root.join(MARKER_FILE)) else {
        return LegacyMarker::default();
    };
    let value: serde_json::Value = serde_json::from_str(&raw).unwrap_or_default();
    LegacyMarker {
        imported_at: value.get("imported_at").and_then(|v| v.as_u64()),
        last_sync_at: value.get("last_sync_at").and_then(|v| v.as_u64()),
        source_dir: value
            .get("source_dir")
            .and_then(|v| v.as_str())
            .map(str::to_string),
    }
}

#[tauri::command]
pub fn legacy_alethe_status(app: AppHandle) -> LegacyStatus {
    let root = legacy_root();
    let available = root
        .as_deref()
        .map(|r| legacy_projects_path(r).is_file() || r.join(ACCOUNTS_DIR).is_dir())
        .unwrap_or(false);
    LegacyStatus {
        available,
        profile_id: root.as_deref().map(legacy_profile_id),
        source_dir: root.map(|r| r.to_string_lossy().into_owned()),
        marker: read_marker(&app),
    }
}

/// Raw legacy `projects.json`, or None when the original install has none.
#[tauri::command]
pub fn legacy_alethe_read_projects() -> Result<Option<String>, String> {
    let Some(root) = legacy_root() else {
        return Ok(None);
    };
    let path = legacy_projects_path(&root);
    if !path.is_file() {
        return Ok(None);
    }
    fs::read_to_string(&path)
        .map(Some)
        .map_err(|e| format!("{}: {e}", path.display()))
}

/// Copies files that are missing in `dst` or older than in `src`. Never deletes.
fn copy_newer(src: &Path, dst: &Path, top_level: bool, count: &mut u32) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name();
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        let target = dst.join(&name);
        if file_type.is_dir() {
            if top_level && SKIPPED_ACCOUNT_DIRS.iter().any(|d| name == *d) {
                continue;
            }
            copy_newer(&entry.path(), &target, false, count)?;
        } else if file_type.is_file() {
            if top_level && SKIPPED_ACCOUNT_FILES.iter().any(|f| name == *f) {
                continue;
            }
            let src_modified = entry.metadata()?.modified().ok();
            let dst_modified = fs::metadata(&target).and_then(|m| m.modified()).ok();
            let stale = match (src_modified, dst_modified) {
                (_, None) => true,
                (Some(s), Some(d)) => s > d,
                (None, Some(_)) => false,
            };
            if stale {
                fs::copy(entry.path(), &target)?;
                *count += 1;
            }
        }
    }
    Ok(())
}

/// Copies each account's Claude config dir from the original install.
///
/// `refresh = false` (first import) leaves an existing destination dir untouched;
/// `refresh = true` (re-sync) brings over files that are newer in the original.
#[tauri::command]
pub async fn legacy_alethe_copy_accounts(
    app: AppHandle,
    ids: Vec<String>,
    refresh: bool,
) -> Result<Vec<AccountCopyResult>, String> {
    let Some(root) = legacy_root() else {
        return Ok(Vec::new());
    };
    let dest_root = our_root(&app)?.join(ACCOUNTS_DIR);
    tauri::async_runtime::spawn_blocking(move || {
        ids.into_iter()
            .map(|id| {
                let mut result = AccountCopyResult {
                    id: id.clone(),
                    found: false,
                    files_copied: 0,
                    error: None,
                };
                if !valid_id(&id) {
                    result.error = Some("invalid account id".into());
                    return result;
                }
                let src = root.join(ACCOUNTS_DIR).join(&id);
                if !src.is_dir() {
                    return result;
                }
                result.found = true;
                let dst = dest_root.join(&id);
                if dst.exists() && !refresh {
                    return result;
                }
                if let Err(e) = copy_newer(&src, &dst, true, &mut result.files_copied) {
                    result.error = Some(e.to_string());
                } else {
                    // An imported account must not stop its first agent on the onboarding.
                    let _ = crate::trust_seed::seed_file(&dst.join(".claude.json"), &[], true);
                }
                result
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

/// Records a completed import (`first`) or re-sync in our own app data dir.
#[tauri::command]
pub fn legacy_alethe_mark(app: AppHandle, first: bool) -> Result<LegacyMarker, String> {
    let mut marker = read_marker(&app);
    let now = now_ms();
    if first || marker.imported_at.is_none() {
        marker.imported_at = Some(now);
    }
    marker.last_sync_at = Some(now);
    marker.source_dir = legacy_root().map(|r| r.to_string_lossy().into_owned());
    let root = our_root(&app)?;
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let body = serde_json::to_string_pretty(&serde_json::json!({
        "imported_at": marker.imported_at,
        "last_sync_at": marker.last_sync_at,
        "source_dir": marker.source_dir,
    }))
    .map_err(|e| e.to_string())?;
    fs::write(root.join(MARKER_FILE), body).map_err(|e| e.to_string())?;
    Ok(marker)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_path_like_ids() {
        assert!(valid_id("Ci8cd-pn"));
        assert!(valid_id("IL_OHd6l"));
        assert!(!valid_id(""));
        assert!(!valid_id("../x"));
        assert!(!valid_id("a\\b"));
    }

    #[test]
    fn copy_newer_skips_bulky_dirs_and_keeps_newer_dest() {
        let base = std::env::temp_dir().join(format!("legacy-import-test-{}", now_ms()));
        let src = base.join("src");
        let dst = base.join("dst");
        fs::create_dir_all(src.join("cache")).unwrap();
        fs::create_dir_all(src.join("projects")).unwrap();
        fs::write(src.join(".credentials.json"), "old").unwrap();
        fs::write(src.join(".claude.json"), "{}").unwrap();
        fs::write(src.join("cache").join("big.md"), "x").unwrap();
        fs::write(src.join("projects").join("a.jsonl"), "a").unwrap();

        let mut n = 0;
        copy_newer(&src, &dst, true, &mut n).unwrap();
        assert_eq!(n, 2);
        assert!(!dst.join("cache").exists());
        assert!(dst.join("projects").join("a.jsonl").is_file());
        // Credentials are never copied: the import and the original would share a refresh token.
        assert!(!dst.join(".credentials.json").exists());

        // A destination file written after the source is not overwritten.
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(dst.join(".claude.json"), "{\"new\":1}").unwrap();
        let mut n2 = 0;
        copy_newer(&src, &dst, true, &mut n2).unwrap();
        assert_eq!(n2, 0);
        assert_eq!(
            fs::read_to_string(dst.join(".claude.json")).unwrap(),
            "{\"new\":1}"
        );
        // A re-sync over a signed-in destination leaves its own credentials alone.
        fs::write(dst.join(".credentials.json"), "mine").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(src.join(".credentials.json"), "newer-but-not-ours").unwrap();
        copy_newer(&src, &dst, true, &mut n2).unwrap();
        assert_eq!(
            fs::read_to_string(dst.join(".credentials.json")).unwrap(),
            "mine"
        );
        // Source untouched.
        assert_eq!(
            fs::read_to_string(src.join(".credentials.json")).unwrap(),
            "newer-but-not-ours"
        );
        let _ = fs::remove_dir_all(&base);
    }
}

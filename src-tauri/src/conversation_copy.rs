//! Moves an agent's conversation to another Claude account so `claude --resume`
//! finds it there. Claude Code keeps each conversation under the config dir of
//! the account that ran it (`<config>/projects/<folder slug>/<session>.jsonl`),
//! so restarting an agent on a new account used to start its task over.
//!
//! Only the conversation is copied: the `.jsonl` and, when present, the
//! `<session>/` folder beside it (subagent and tool-result files). Nothing
//! outside `projects/` is read, so credentials never move.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct CopyConversationResult {
    /// The conversation is now in the destination account.
    pub copied: bool,
    /// Why nothing was copied: `same_dir`, `not_found` or `invalid_session`.
    pub reason: Option<String>,
}

impl CopyConversationResult {
    fn skipped(reason: &str) -> Self {
        Self {
            copied: false,
            reason: Some(reason.to_string()),
        }
    }
}

/// `''` is the default account (`~/.claude`), which has no folder of its own.
fn account_dir(dir: &str, home: Option<&Path>) -> Option<PathBuf> {
    let dir = dir.trim();
    if dir.is_empty() {
        return home.map(|h| h.join(".claude"));
    }
    Some(PathBuf::from(dir))
}

/// Claude Code's folder name for a working directory: every character that is
/// not an ASCII letter or digit becomes `-` (`C:\Users\x` → `C--Users-x`).
fn project_slug(cwd: &str) -> String {
    cwd.trim()
        .trim_end_matches(['\\', '/'])
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

/// Session ids are UUIDs; anything else could escape the projects folder.
fn valid_session_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// The project folder holding `<session>.jsonl`: the slug of `cwd` first, then
/// any folder (the slug rules change between CLI versions; the id is unique).
fn find_project_dir(projects: &Path, cwd: &str, session_id: &str) -> Option<PathBuf> {
    let file = format!("{session_id}.jsonl");
    let by_slug = projects.join(project_slug(cwd));
    if by_slug.join(&file).is_file() {
        return Some(by_slug);
    }
    std::fs::read_dir(projects)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .find(|dir| dir.is_dir() && dir.join(&file).is_file())
}

fn same_path(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// Copies a file through a temporary name so a reader never sees half of it.
/// An existing destination is kept as `<name>.bak-<millis>`.
fn copy_file_atomic(from: &Path, to: &Path, stamp: i64) -> std::io::Result<()> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let name = to
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = to.with_file_name(format!("{name}.tmp-{stamp}"));
    std::fs::copy(from, &tmp)?;
    if to.exists() {
        std::fs::rename(to, to.with_file_name(format!("{name}.bak-{stamp}")))?;
    }
    std::fs::rename(&tmp, to)
}

fn copy_dir(from: &Path, to: &Path, stamp: i64) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)?.flatten() {
        let path = entry.path();
        let target = to.join(entry.file_name());
        // Never follow links out of the projects folder.
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            copy_dir(&path, &target, stamp)?;
        } else {
            copy_file_atomic(&path, &target, stamp)?;
        }
    }
    Ok(())
}

fn copy_conversation_in(
    from_dir: &Path,
    to_dir: &Path,
    cwd: &str,
    session_id: &str,
    stamp: i64,
) -> std::io::Result<CopyConversationResult> {
    if !valid_session_id(session_id) {
        return Ok(CopyConversationResult::skipped("invalid_session"));
    }
    if same_path(from_dir, to_dir) {
        return Ok(CopyConversationResult::skipped("same_dir"));
    }
    let Some(source) = find_project_dir(&from_dir.join("projects"), cwd, session_id) else {
        return Ok(CopyConversationResult::skipped("not_found"));
    };
    // Same folder name in the new account: both run the same CLI on the same cwd.
    let folder = source
        .file_name()
        .map(PathBuf::from)
        .unwrap_or_else(|| project_slug(cwd).into());
    let target = to_dir.join("projects").join(folder);
    let file = format!("{session_id}.jsonl");
    copy_file_atomic(&source.join(&file), &target.join(&file), stamp)?;
    let extras = source.join(session_id);
    if extras.is_dir() {
        copy_dir(&extras, &target.join(session_id), stamp)?;
    }
    Ok(CopyConversationResult {
        copied: true,
        reason: None,
    })
}

/// Copies conversation `session_id` (run in `cwd`) from one account's config
/// dir to another's; `''` is the default account. Errors only on I/O failures.
#[tauri::command]
pub async fn copy_conversation(
    from_dir: String,
    to_dir: String,
    cwd: String,
    session_id: String,
) -> Result<CopyConversationResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let home = dirs_next::home_dir();
        let (Some(from), Some(to)) = (
            account_dir(&from_dir, home.as_deref()),
            account_dir(&to_dir, home.as_deref()),
        ) else {
            return Err("no home folder for the default account".to_string());
        };
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        copy_conversation_in(&from, &to, &cwd, &session_id, stamp).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: &str = "0cbb7769-776e-4600-9577-e9a8dc5b2724";

    struct Temp(PathBuf);
    impl Temp {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "alethe-conv-{name}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn write(path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    #[test]
    fn slug_matches_claude_code_folder_names() {
        assert_eq!(
            project_slug(r"C:\Users\Profile\Documents\Alethe\Sistemas_e_autromacoes"),
            "C--Users-Profile-Documents-Alethe-Sistemas-e-autromacoes"
        );
        assert_eq!(project_slug("C:/Users/Profile/"), "C--Users-Profile");
    }

    #[test]
    fn copies_only_the_conversation_and_its_folder() {
        let root = Temp::new("copy");
        let (from, to) = (root.0.join("a"), root.0.join("b"));
        let cwd = r"C:\Work\repo";
        let project = from.join("projects").join(project_slug(cwd));
        write(&project.join(format!("{SESSION}.jsonl")), "{\"m\":1}\n");
        write(
            &project.join(SESSION).join("subagents").join("x.jsonl"),
            "sub",
        );
        write(&project.join("other-session.jsonl"), "not mine");
        write(&from.join(".credentials.json"), "secret");
        write(&from.join(".claude.json"), "{}");

        let result = copy_conversation_in(&from, &to, cwd, SESSION, 1).unwrap();
        assert_eq!(
            result,
            CopyConversationResult {
                copied: true,
                reason: None
            }
        );
        let target = to.join("projects").join(project_slug(cwd));
        assert_eq!(
            std::fs::read_to_string(target.join(format!("{SESSION}.jsonl"))).unwrap(),
            "{\"m\":1}\n"
        );
        assert_eq!(
            std::fs::read_to_string(target.join(SESSION).join("subagents").join("x.jsonl"))
                .unwrap(),
            "sub"
        );
        assert!(!target.join("other-session.jsonl").exists());
        assert!(!to.join(".credentials.json").exists());
        assert!(!to.join(".claude.json").exists());
        // The source is left untouched.
        assert!(project.join(format!("{SESSION}.jsonl")).is_file());
    }

    #[test]
    fn finds_the_conversation_when_the_slug_differs() {
        let root = Temp::new("slug");
        let (from, to) = (root.0.join("a"), root.0.join("b"));
        write(
            &from
                .join("projects")
                .join("some-older-slug")
                .join(format!("{SESSION}.jsonl")),
            "x",
        );
        let result = copy_conversation_in(&from, &to, r"C:\Elsewhere", SESSION, 1).unwrap();
        assert!(result.copied);
        assert!(to
            .join("projects")
            .join("some-older-slug")
            .join(format!("{SESSION}.jsonl"))
            .is_file());
    }

    #[test]
    fn keeps_an_existing_destination_as_backup() {
        let root = Temp::new("bak");
        let (from, to) = (root.0.join("a"), root.0.join("b"));
        let cwd = r"C:\Work";
        let name = format!("{SESSION}.jsonl");
        write(
            &from.join("projects").join(project_slug(cwd)).join(&name),
            "new",
        );
        let dest = to.join("projects").join(project_slug(cwd)).join(&name);
        write(&dest, "old");
        assert!(
            copy_conversation_in(&from, &to, cwd, SESSION, 42)
                .unwrap()
                .copied
        );
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "new");
        assert_eq!(
            std::fs::read_to_string(dest.with_file_name(format!("{name}.bak-42"))).unwrap(),
            "old"
        );
    }

    #[test]
    fn reports_why_nothing_was_copied() {
        let root = Temp::new("skip");
        let (from, to) = (root.0.join("a"), root.0.join("b"));
        std::fs::create_dir_all(&from).unwrap();
        let skipped = |reason: &str| CopyConversationResult::skipped(reason);
        assert_eq!(
            copy_conversation_in(&from, &to, "C:\\w", SESSION, 1).unwrap(),
            skipped("not_found")
        );
        assert_eq!(
            copy_conversation_in(&from, &from, "C:\\w", SESSION, 1).unwrap(),
            skipped("same_dir")
        );
        assert_eq!(
            copy_conversation_in(&from, &to, "C:\\w", "..\\..\\.credentials", 1).unwrap(),
            skipped("invalid_session")
        );
        assert_eq!(
            copy_conversation_in(&from, &to, "C:\\w", "", 1).unwrap(),
            skipped("invalid_session")
        );
    }

    #[test]
    fn empty_dir_means_the_default_account() {
        let home = Path::new("/home/x");
        assert_eq!(account_dir("", Some(home)), Some(home.join(".claude")));
        assert_eq!(account_dir("  ", None), None);
        assert_eq!(
            account_dir("/acct", Some(home)),
            Some(PathBuf::from("/acct"))
        );
    }
}

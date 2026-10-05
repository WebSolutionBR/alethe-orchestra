//! Saves text the user exports (an orchestration report, an agent transcript) to the file they
//! picked in the native save dialog. The webview has full IPC access, so the command writes
//! only what an export needs: an absolute local path with a known text extension, a bounded size,
//! written atomically next to the target, and never a folder it would have to create.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

/// Largest export accepted, in bytes.
const MAX_BYTES: usize = 20 * 1024 * 1024;
/// Text formats an export can be saved as.
const EXTENSIONS: &[&str] = &["md", "json", "txt"];
/// Windows device names: `NUL.txt` and friends would never become a file.
const RESERVED_NAMES: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Checks an export target and returns it, or why it is refused.
fn validate(path: &str, content: &str) -> Result<PathBuf, String> {
    let raw = path.trim();
    if raw.is_empty() {
        return Err("empty path".into());
    }
    if content.len() > MAX_BYTES {
        return Err("content too large to export".into());
    }
    // UNC shares (\\server\share) and device paths (\\?\, \\.\) are never written to.
    if raw.starts_with(r"\\") || raw.starts_with("//") {
        return Err("network and device paths are not allowed".into());
    }
    // A colon past the drive letter names an alternate data stream.
    let after_drive = raw.get(2..).unwrap_or("");
    if after_drive.contains(':') {
        return Err("invalid character in path".into());
    }
    let file = PathBuf::from(raw);
    if !file.is_absolute() {
        return Err("path must be absolute".into());
    }
    if file
        .components()
        .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("path must not go up a folder".into());
    }
    let extension = file
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase());
    match extension.as_deref() {
        Some(ext) if EXTENSIONS.contains(&ext) => {}
        _ => return Err("only .md, .json and .txt files can be saved".into()),
    }
    let stem = file
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(|stem| stem.trim_end_matches(['.', ' ']).to_ascii_lowercase())
        .unwrap_or_default();
    if stem.is_empty() || RESERVED_NAMES.contains(&stem.as_str()) {
        return Err("invalid file name".into());
    }
    let parent = file.parent().ok_or("path has no folder")?;
    if !parent.is_dir() {
        return Err("folder not found".into());
    }
    if file.is_dir() {
        return Err("path is a folder".into());
    }
    Ok(file)
}

/// Writes through a temporary sibling and renames it over the target, so a failed write never
/// leaves a half-written export (or a damaged older one) behind.
fn write_atomic(file: &Path, bytes: &[u8]) -> Result<(), String> {
    let name = file
        .file_name()
        .ok_or("path has no file name")?
        .to_string_lossy()
        .into_owned();
    let tmp = file.with_file_name(format!(".{name}.{}.tmp", std::process::id()));
    let written = (|| -> std::io::Result<()> {
        let mut out = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        out.write_all(bytes)?;
        out.sync_all()?;
        drop(out);
        fs::rename(&tmp, file)
    })();
    if let Err(error) = written {
        let _ = fs::remove_file(&tmp);
        return Err(error.to_string());
    }
    Ok(())
}

/// Saves `content` to `path`, creating the file or replacing it. `path` comes from the native
/// save dialog in the front end.
#[tauri::command]
pub fn save_text_file(path: String, content: String) -> Result<(), String> {
    let file = validate(&path, &content)?;
    write_atomic(&file, content.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh folder under the system temp dir, removed when dropped.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "alethe-export-test-{tag}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or_default()
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn file(&self, name: &str) -> String {
            self.0.join(name).to_string_lossy().into_owned()
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn saves_and_replaces_known_text_files_without_leftovers() {
        let dir = TempDir::new("save");
        for name in ["report.md", "report.JSON", "transcript.txt"] {
            let path = dir.file(name);
            save_text_file(path.clone(), "first".into()).unwrap();
            save_text_file(path.clone(), "second".into()).unwrap();
            assert_eq!(fs::read_to_string(&path).unwrap(), "second");
        }
        let names: Vec<String> = fs::read_dir(&dir.0)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names.len(), 3, "no temporary file left: {names:?}");
    }

    #[test]
    fn refuses_other_extensions_and_reserved_names() {
        let dir = TempDir::new("ext");
        for name in [
            "run.exe",
            "script.bat",
            "noext",
            "report.md.lnk",
            "CON.txt",
            "nul.md",
        ] {
            assert!(
                validate(&dir.file(name), "x").is_err(),
                "{name} should be refused"
            );
        }
    }

    #[test]
    fn refuses_relative_network_device_and_stream_paths() {
        let dir = TempDir::new("paths");
        let inside = dir.file("a.md");
        let up = format!(
            "{}{}..{}b.md",
            dir.0.display(),
            std::path::MAIN_SEPARATOR,
            std::path::MAIN_SEPARATOR
        );
        for path in [
            "report.md".to_string(),
            r"relative\report.md".to_string(),
            r"\\server\share\report.md".to_string(),
            r"\\?\C:\report.md".to_string(),
            r"\\.\pipe\report.txt".to_string(),
            "//server/share/report.md".to_string(),
            format!("{inside}:stream.txt"),
            up,
            String::new(),
        ] {
            assert!(validate(&path, "x").is_err(), "{path:?} should be refused");
        }
    }

    #[test]
    fn never_creates_folders_or_writes_over_one() {
        let dir = TempDir::new("folders");
        let missing = dir.0.join("missing").join("report.md");
        assert!(save_text_file(missing.to_string_lossy().into_owned(), "x".into()).is_err());
        assert!(!dir.0.join("missing").exists());
        let folder = dir.0.join("folder.md");
        fs::create_dir(&folder).unwrap();
        assert!(save_text_file(folder.to_string_lossy().into_owned(), "x".into()).is_err());
    }

    #[test]
    fn refuses_content_over_the_limit() {
        let dir = TempDir::new("size");
        let big = "x".repeat(MAX_BYTES + 1);
        assert!(save_text_file(dir.file("big.txt"), big).is_err());
        assert!(!Path::new(&dir.file("big.txt")).exists());
    }
}

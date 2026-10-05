//! The Obsidian scribe's author and the local material it writes from.
//!
//! The scribe no longer appends raw event logs to the vault. Each session's events are kept as
//! *material* in the app data folder (one JSON line per entry, never in the vault), and an
//! *author* turns that material into knowledge notes in the owner's own pattern: a windowless
//! `claude -p` run on the session's account and model, which the owner turns on.
//!
//! The run is read-only by construction, and its locks never depend on reading `--help`:
//! - the prompt goes through stdin, never the command line; every argument is a fixed flag, a
//!   validated model, effort or limit, or a path the app chose;
//! - the only tools are Grep, Glob and Read limited by path to the vault and to the author's own
//!   folder, where the session's transcripts are linked and its task files copied; every
//!   Claude account folder, the SSH and cloud key folders and the vault's plugin folder (the
//!   REST API key) are denied outright; the session's MCP servers are replaced by the
//!   Obsidian one with its read tools only; hooks are off;
//! - a CLI whose help shows it lacks one of these locks is refused instead of run with fewer;
//! - turns and spending have a ceiling.
//!
//! The author hands back a write plan that the app checks, redacts and applies itself, so
//! nothing it reads can make it delete or overwrite a note.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const MAX_PROMPT: usize = 600 * 1024;
const MAX_STDOUT: usize = 4 * 1024 * 1024;
const STDERR_TAIL: usize = 2 * 1024;
const DEFAULT_TIMEOUT_SECS: u64 = 12 * 60;
const MIN_TIMEOUT_SECS: u64 = 60;
const MAX_TIMEOUT_SECS: u64 = 45 * 60;
const HELP_TIMEOUT: Duration = Duration::from_secs(20);
/// Run folders left behind by a crash are removed after this long.
const STALE_RUN: Duration = Duration::from_secs(24 * 60 * 60);

pub(crate) const DEFAULT_MAX_TURNS: u32 = 40;
const MIN_MAX_TURNS: u32 = 5;
const MAX_MAX_TURNS: u32 = 200;
/// Highest spending ceiling a run may ask for, in US dollars.
const MAX_BUDGET_USD: f64 = 50.0;

const MAX_TRANSCRIPTS: usize = 40;
/// A transcript that cannot be hard-linked is copied, up to this size.
const MAX_TRANSCRIPT_COPY: u64 = 64 * 1024 * 1024;
const MAX_SOURCES: usize = 24;
const MAX_TASK_FILE: u64 = 512 * 1024;
const MAX_SOURCE_READ: usize = 64 * 1024;

const MAX_MATERIAL_FILE: u64 = 4 * 1024 * 1024;
const MAX_MATERIAL_READ: usize = 2 * 1024 * 1024;
const MAX_MATERIAL_LINE: usize = 32 * 1024;
const MAX_MATERIAL_BATCH: usize = 2_000;
/// Material of sessions nobody synthesized is dropped after two weeks.
const STALE_MATERIAL: Duration = Duration::from_secs(14 * 24 * 60 * 60);

const MAX_INDEX: usize = 50_000;
const MAX_INDEX_DEPTH: usize = 24;

/// Built-in tools the author gets: reading only (Read is further limited by path).
const AUTHOR_TOOLS: [&str; 3] = ["Read", "Grep", "Glob"];

/// Read-only tools of the Obsidian MCP server, as the generated config names it (`obsidian`).
const OBSIDIAN_READ_TOOLS: [&str; 9] = [
    "mcp__obsidian__obsidian_get_file_contents",
    "mcp__obsidian__obsidian_batch_get_file_contents",
    "mcp__obsidian__obsidian_simple_search",
    "mcp__obsidian__obsidian_complex_search",
    "mcp__obsidian__obsidian_list_files_in_dir",
    "mcp__obsidian__obsidian_list_files_in_vault",
    "mcp__obsidian__obsidian_get_recent_changes",
    "mcp__obsidian__obsidian_get_periodic_note",
    "mcp__obsidian__obsidian_get_recent_periodic_notes",
];

/// Denied outright as well, on top of `--tools`.
const DENIED_TOOLS: [&str; 14] = [
    "Bash",
    "PowerShell",
    "Edit",
    "Write",
    "MultiEdit",
    "NotebookEdit",
    "WebFetch",
    "WebSearch",
    "Task",
    "Agent",
    "mcp__obsidian__obsidian_append_content",
    "mcp__obsidian__obsidian_patch_content",
    "mcp__obsidian__obsidian_put_content",
    "mcp__obsidian__obsidian_delete_file",
];

/// The flags the locks rely on, as `--help` shows them, and how the refusal names them.
const LOCK_FLAGS: [(&str, &str); 4] = [
    ("--tools <", "--tools"),
    ("\"dontAsk\"", "--permission-mode dontAsk"),
    ("--strict-mcp-config", "--strict-mcp-config"),
    ("--restricted", "--restricted"),
];

/// Folders under the user's home the author may never read.
const PRIVATE_HOME_DIRS: [&str; 6] = [".ssh", ".aws", ".azure", ".gnupg", ".claude", ".config"];
/// Files under the user's home the author may never read.
const PRIVATE_HOME_FILES: [&str; 2] = [".claude.json", ".netrc"];

const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// A transcript of one of the session's agents.
#[derive(Deserialize, Clone)]
pub struct AuthorFile {
    /// The agent id; it names the link: `transcripts/<name>.jsonl`.
    pub name: String,
    pub path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorRequest {
    /// Names the run folder and lets the app cancel it; 1-40 of `a-z0-9-`.
    pub run_id: String,
    /// The orchestration the run writes about; its own task files are accepted.
    pub session_id: String,
    /// Sent through stdin.
    pub prompt: String,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    /// `CLAUDE_CONFIG_DIR` of the account; none runs the CLI's default account.
    #[serde(default)]
    pub config_dir: Option<String>,
    /// The vault the author reads (its `.obsidian` folder stays off limits).
    pub vault_path: String,
    /// The session's project folder: task files are accepted from it.
    #[serde(default)]
    pub session_folder: Option<String>,
    /// The agents' transcripts, linked into the author's folder.
    #[serde(default)]
    pub transcripts: Vec<AuthorFile>,
    /// The session's task files, copied into the author's folder under `tarefas/`.
    #[serde(default)]
    pub sources: Vec<String>,
    #[serde(default)]
    pub timeout_secs: Option<u64>,
    #[serde(default)]
    pub max_turns: Option<u32>,
    /// Spending ceiling of the run in US dollars; none or zero leaves it to the CLI.
    #[serde(default)]
    pub max_budget_usd: Option<f64>,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AuthorOutcome {
    pub ok: bool,
    /// The author's final message: the write plan.
    pub result: String,
    /// Why the run failed: `cli-missing`, `cli-locks`, `invalid`, `spawn`, `timeout`,
    /// `cancelled`, `exit`, `output`, `max-turns`, `max-budget`, `cli-error`.
    pub error: Option<String>,
    /// Detail for the user (the CLI's own error, the end of stderr, the missing locks).
    pub detail: Option<String>,
    pub duration_ms: u64,
    /// What the run cost, as the CLI estimates it; also known when it failed.
    pub cost_usd: Option<f64>,
    pub turns: Option<u64>,
    /// Tool calls the permission rules refused; a high count means the prompt asked for more.
    pub denials: usize,
    /// The Obsidian MCP server was available to the author.
    pub mcp: bool,
}

/// The locks a CLI's help shows it lacks; empty when it has them all.
fn missing_locks(help: &str) -> Vec<&'static str> {
    LOCK_FLAGS
        .iter()
        .filter(|(needle, _)| !help.contains(needle))
        .map(|(_, name)| *name)
        .collect()
}

/// A model alias or full name; anything else (spaces, quotes, a leading dash) is refused.
fn valid_model(model: &str) -> bool {
    let mut chars = model.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric())
        && model.len() <= 64
        && model
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | ':' | '[' | ']'))
}

fn valid_effort(effort: &str) -> bool {
    EFFORTS.contains(&effort)
}

/// Same shape as the orchestra ids, a little longer: it names a folder.
fn valid_run_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 40
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// A permission-rule path: Claude Code matches Windows paths in POSIX form (`C:\a` is `/c/a`),
/// and `//` anchors a rule at the filesystem root. None for paths that have no such form.
fn rule_path(path: &Path) -> Option<String> {
    let raw = path.to_string_lossy();
    let raw = raw.strip_prefix(r"\\?\").unwrap_or(&raw);
    let text = raw.replace('\\', "/");
    let text = text.trim_end_matches('/');
    let bytes = text.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        let drive = (bytes[0] as char).to_ascii_lowercase();
        return Some(format!("//{drive}{}", &text[2..]));
    }
    if text.starts_with('/') && !text.starts_with("//") {
        return Some(format!("/{text}"));
    }
    None
}

/// What the author may never read, whatever else its rules allow.
struct Private<'a> {
    vault: &'a Path,
    /// The run's own config folder (its settings and MCP config, which may carry a key).
    run_config: &'a Path,
    home: Option<&'a Path>,
    /// Where every Claude account of the app keeps its config.
    accounts_root: Option<&'a Path>,
    /// The account the run uses, when it lives elsewhere.
    account: Option<&'a Path>,
}

fn deny_rules(private: &Private) -> Vec<String> {
    let mut dirs: Vec<PathBuf> = vec![
        private.vault.join(".obsidian"),
        private.run_config.to_path_buf(),
    ];
    let mut files: Vec<PathBuf> = Vec::new();
    if let Some(home) = private.home {
        dirs.extend(PRIVATE_HOME_DIRS.iter().map(|d| home.join(d)));
        files.extend(PRIVATE_HOME_FILES.iter().map(|f| home.join(f)));
    }
    dirs.extend(private.accounts_root.map(Path::to_path_buf));
    dirs.extend(private.account.map(Path::to_path_buf));
    let mut rules: Vec<String> = DENIED_TOOLS.iter().map(|t| t.to_string()).collect();
    rules.extend(
        dirs.iter()
            .filter_map(|d| rule_path(d))
            .map(|r| format!("Read({r}/**)")),
    );
    rules.extend(
        files
            .iter()
            .filter_map(|f| rule_path(f))
            .map(|r| format!("Read({r})")),
    );
    rules
}

/// Permission settings of a run: Read only inside the vault and the author's folder, Grep and
/// Glob, the Obsidian read tools; every writer and every private folder denied; anything not
/// allowed refused without asking; no hooks.
fn author_settings(work: &Path, private: &Private, mcp: bool) -> Value {
    let mut allow: Vec<String> = [private.vault, work]
        .iter()
        .filter_map(|dir| rule_path(dir))
        .map(|r| format!("Read({r}/**)"))
        .collect();
    allow.extend(["Grep".to_string(), "Glob".to_string()]);
    if mcp {
        allow.extend(OBSIDIAN_READ_TOOLS.iter().map(|t| t.to_string()));
    }
    json!({
        "permissions": {
            "allow": allow,
            "deny": deny_rules(private),
            "defaultMode": "dontAsk",
        },
        "disableAllHooks": true,
    })
}

struct ArgsInput<'a> {
    model: Option<&'a str>,
    effort: Option<&'a str>,
    settings: &'a Path,
    mcp_config: Option<&'a Path>,
    vault: &'a Path,
    max_turns: Option<u32>,
    max_budget_usd: Option<f64>,
    /// Not a lock: only passed when the CLI's help lists it.
    no_persistence: bool,
}

/// The ceiling of turns of a run, in range.
fn turns_limit(requested: Option<u32>) -> u32 {
    requested
        .unwrap_or(DEFAULT_MAX_TURNS)
        .clamp(MIN_MAX_TURNS, MAX_MAX_TURNS)
}

/// The spending ceiling as the CLI wants it (`2.50`); none when unset, zero or not a number.
fn budget_arg(requested: Option<f64>) -> Option<String> {
    let budget = requested.filter(|b| b.is_finite() && *b > 0.0)?;
    Some(format!("{:.2}", budget.min(MAX_BUDGET_USD)))
}

/// The CLI arguments of a run. The locks are always there, whatever the CLI's help said; the
/// prompt is never an argument (it goes through stdin), and the only free-form values are a
/// model and an effort that passed validation, numbers, and paths the app chose.
fn author_args(input: &ArgsInput) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "-p".into(),
        "--output-format".into(),
        "json".into(),
        "--settings".into(),
        input.settings.to_string_lossy().into_owned(),
        "--tools".into(),
        AUTHOR_TOOLS.join(","),
        "--permission-mode".into(),
        "dontAsk".into(),
        "--restricted".into(),
        "--strict-mcp-config".into(),
    ];
    if let Some(config) = input.mcp_config {
        args.push("--mcp-config".into());
        args.push(config.to_string_lossy().into_owned());
    }
    // Read is not allowed by name here: its rules, by path, are in the settings file.
    let mut allowed: Vec<&str> = vec!["Grep", "Glob"];
    if input.mcp_config.is_some() {
        allowed.extend(OBSIDIAN_READ_TOOLS);
    }
    args.push("--allowedTools".into());
    args.push(allowed.join(","));
    args.push("--disallowedTools".into());
    args.push(DENIED_TOOLS.join(","));
    args.push("--add-dir".into());
    args.push(input.vault.to_string_lossy().into_owned());
    args.push("--max-turns".into());
    args.push(turns_limit(input.max_turns).to_string());
    if let Some(budget) = budget_arg(input.max_budget_usd) {
        args.push("--max-budget-usd".into());
        args.push(budget);
    }
    if input.no_persistence {
        args.push("--no-session-persistence".into());
    }
    if let Some(model) = input.model.filter(|m| valid_model(m)) {
        args.push("--model".into());
        args.push(model.to_string());
    }
    if let Some(effort) = input.effort.filter(|e| valid_effort(e)) {
        args.push("--effort".into());
        args.push(effort.to_string());
    }
    args
}

/// The `obsidian` MCP server of a Claude config file (`.claude.json`), wrapped as a config of
/// its own. Its env may hold the plugin key: it is copied as is, never logged.
fn obsidian_mcp_config(raw: &str) -> Option<Value> {
    let parsed: Value = serde_json::from_str(raw).ok()?;
    let server = parsed.get("mcpServers")?.get("obsidian")?;
    if !server.is_object() {
        return None;
    }
    Some(json!({ "mcpServers": { "obsidian": server.clone() } }))
}

fn find_obsidian_mcp(config_dir: Option<&Path>) -> Option<Value> {
    let file = match config_dir {
        Some(dir) => dir.join(".claude.json"),
        None => dirs_next::home_dir()?.join(".claude.json"),
    };
    obsidian_mcp_config(&std::fs::read_to_string(file).ok()?)
}

/// Agent ids name the transcript links: `a-z0-9-`, at most 40.
fn valid_link_name(name: &str) -> bool {
    valid_run_id(name)
}

/// Puts the session's transcripts in the author's folder as `<name>.jsonl`: hard links (nothing
/// is copied, the original stays where it is), or a copy when the link cannot be made. Returns
/// the names it placed.
fn link_transcripts(dir: &Path, files: &[AuthorFile]) -> Vec<String> {
    let mut placed = Vec::new();
    if files.is_empty() || std::fs::create_dir_all(dir).is_err() {
        return placed;
    }
    for file in files.iter().take(MAX_TRANSCRIPTS) {
        let source = PathBuf::from(file.path.trim());
        let is_jsonl = source
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("jsonl"));
        if !valid_link_name(&file.name) || !source.is_absolute() || !is_jsonl || !source.is_file() {
            continue;
        }
        let target = dir.join(format!("{}.jsonl", file.name));
        if target.exists() {
            continue;
        }
        let linked = std::fs::hard_link(&source, &target).is_ok()
            || (std::fs::metadata(&source).is_ok_and(|m| m.len() <= MAX_TRANSCRIPT_COPY)
                && std::fs::copy(&source, &target).is_ok());
        if linked {
            placed.push(file.name.clone());
        }
    }
    placed
}

/// `C:\` or the user's home folder: too broad to count as a session's folder.
fn too_broad(folder: &Path, home: Option<&Path>) -> bool {
    let normal = folder
        .components()
        .filter(|c| matches!(c, Component::Normal(_)))
        .count();
    normal == 0 || home.is_some_and(|h| canonical(h).is_some_and(|h| h == folder))
}

fn canonical(path: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(path).ok()
}

/// Whether a task file belongs to the session: a `.md`/`.txt` inside its project folder (not
/// in a hidden folder), or the orchestra's own task file of that session. Anything else (any
/// other path a task or a message mentions) is refused.
fn accepted_source(
    path: &Path,
    session_id: &str,
    session_folder: Option<&Path>,
    orchestra_dir: &Path,
    home: Option<&Path>,
) -> bool {
    let ext_ok = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .is_some_and(|e| e == "md" || e == "txt");
    if !path.is_absolute()
        || !ext_ok
        || !std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.len() <= MAX_TASK_FILE)
    {
        return false;
    }
    let Some(file) = canonical(path) else {
        return false;
    };
    if let Some(folder) = session_folder.and_then(canonical) {
        if !too_broad(&folder, home) {
            if let Ok(rest) = file.strip_prefix(&folder) {
                let hidden = rest
                    .components()
                    .any(|c| c.as_os_str().to_string_lossy().starts_with('.'));
                if !hidden {
                    return true;
                }
            }
        }
    }
    let own_task = file
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .is_some_and(|n| {
            crate::obsidian::is_valid_session_id(session_id)
                && n.starts_with(&format!("task-{session_id}-"))
        });
    own_task && canonical(orchestra_dir).is_some_and(|dir| file.parent() == Some(dir.as_path()))
}

/// A file name the author's folder can hold: letters, digits and a few separators.
fn safe_file_name(name: &str) -> String {
    let clean: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, ' ' | '.' | '-' | '_' | '(' | ')') {
                c
            } else {
                '_'
            }
        })
        .collect();
    clean.trim_matches(['.', ' ']).chars().take(100).collect()
}

/// Copies the accepted task files into the author's folder (`NN-<name>`); returns how many.
fn copy_sources(dir: &Path, sources: &[PathBuf]) -> usize {
    if sources.is_empty() || std::fs::create_dir_all(dir).is_err() {
        return 0;
    }
    sources
        .iter()
        .enumerate()
        .filter(|(i, source)| {
            let name = source
                .file_name()
                .map(|n| safe_file_name(&n.to_string_lossy()))
                .unwrap_or_default();
            !name.is_empty()
                && std::fs::copy(source, dir.join(format!("{:02}-{name}", i + 1))).is_ok()
        })
        .count()
}

fn orchestra_dir() -> PathBuf {
    std::env::temp_dir().join("alethe-orchestra")
}

#[derive(Debug, PartialEq)]
struct CliResult {
    is_error: bool,
    subtype: String,
    result: String,
    cost_usd: Option<f64>,
    turns: Option<u64>,
    denials: usize,
}

/// The `--output-format json` answer: the last line that is a `result` object.
fn parse_cli_output(stdout: &str) -> Option<CliResult> {
    let pick = |value: Value| -> Option<CliResult> {
        if value.get("type").and_then(Value::as_str) != Some("result") {
            return None;
        }
        Some(CliResult {
            is_error: value
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            subtype: value
                .get("subtype")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            result: value
                .get("result")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            cost_usd: value.get("total_cost_usd").and_then(Value::as_f64),
            turns: value.get("num_turns").and_then(Value::as_u64),
            denials: value
                .get("permission_denials")
                .and_then(Value::as_array)
                .map(Vec::len)
                .unwrap_or(0),
        })
    };
    stdout
        .lines()
        .rev()
        .filter(|line| line.trim_start().starts_with('{'))
        .find_map(|line| {
            serde_json::from_str::<Value>(line.trim())
                .ok()
                .and_then(pick)
        })
        .or_else(|| {
            serde_json::from_str::<Value>(stdout.trim())
                .ok()
                .and_then(pick)
        })
}

/// The reason of a run the CLI ended with an error: its ceilings get names of their own.
fn cli_failure(subtype: &str) -> &'static str {
    if subtype.contains("max_turns") {
        "max-turns"
    } else if subtype.contains("budget") {
        "max-budget"
    } else {
        "cli-error"
    }
}

fn tail(text: &str, max: usize) -> String {
    let trimmed = text.trim();
    if trimmed.len() <= max {
        return trimmed.to_string();
    }
    let mut start = trimmed.len() - max;
    while !trimmed.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &trimmed[start..])
}

fn scribe_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(crate::paths::profile_data_dir(app)?.join("scribe"))
}

/// Removes subfolders (runs) or files (material) of `dir` older than `max_age`.
fn sweep(dir: &Path, max_age: Duration, keep: Option<&Path>) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let now = SystemTime::now();
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if keep.is_some_and(|k| k == path) {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .map(|modified| now.duration_since(modified).unwrap_or(Duration::ZERO))
            .is_some_and(|age| age >= max_age);
        if !old {
            continue;
        }
        let gone = if path.is_dir() {
            std::fs::remove_dir_all(&path).is_ok()
        } else {
            std::fs::remove_file(&path).is_ok()
        };
        if gone {
            removed += 1;
        }
    }
    removed
}

fn running() -> &'static Mutex<HashMap<String, u32>> {
    static RUNS: OnceLock<Mutex<HashMap<String, u32>>> = OnceLock::new();
    RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cancelled() -> &'static Mutex<Vec<String>> {
    static CANCELLED: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
    CANCELLED.get_or_init(|| Mutex::new(Vec::new()))
}

/// Ends a process and everything it started (the CLI starts the MCP server and, through a
/// `.cmd` shim, node): killing the parent alone would leave them running.
fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let mut command = std::process::Command::new("taskkill");
        command
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        crate::git_control::hide_console(&mut command);
        let _ = command.status();
    }
    #[cfg(not(windows))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .status();
    }
}

/// The CLI's `--help`, read once per launcher; None when it could not be read.
fn cli_help(launcher: &Path) -> Option<String> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, String>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(help) = cache.lock().ok().and_then(|map| map.get(launcher).cloned()) {
        return Some(help);
    }
    let mut command = launcher_command(launcher);
    command
        .arg("--help")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    crate::git_control::hide_console(&mut command);
    let mut child = command.spawn().ok()?;
    let started = Instant::now();
    let help = loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                let mut out = String::new();
                if let Some(mut stdout) = child.stdout.take() {
                    use std::io::Read;
                    let _ = stdout.read_to_string(&mut out);
                }
                break out;
            }
            Ok(None) if started.elapsed() < HELP_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(50));
            }
            _ => {
                let _ = child.kill();
                break String::new();
            }
        }
    };
    if help.trim().is_empty() {
        // A failed probe is not cached: the next run asks again.
        return None;
    }
    if let Ok(mut map) = cache.lock() {
        map.insert(launcher.to_path_buf(), help.clone());
    }
    Some(help)
}

/// A `.ps1` launcher runs through PowerShell with `-File`, which passes every argument as is.
fn launcher_command(launcher: &Path) -> std::process::Command {
    let is_ps1 = launcher
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("ps1"));
    if is_ps1 {
        let mut command = std::process::Command::new("powershell.exe");
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ]);
        command.arg(launcher);
        command
    } else {
        std::process::Command::new(launcher)
    }
}

fn failure(error: &str, detail: impl Into<String>, started: Instant) -> AuthorOutcome {
    AuthorOutcome {
        ok: false,
        error: Some(error.to_string()),
        detail: Some(detail.into()),
        duration_ms: started.elapsed().as_millis() as u64,
        ..Default::default()
    }
}

/// Runs the author once and waits for it (bounded). Never panics; every failure comes back as
/// an outcome with a reason, so the scribe can show it.
#[tauri::command]
pub async fn scribe_author_run(app: AppHandle, request: AuthorRequest) -> AuthorOutcome {
    let started = Instant::now();
    if !valid_run_id(&request.run_id) || !crate::obsidian::is_valid_session_id(&request.session_id)
    {
        return failure("invalid", "invalid run or session id", started);
    }
    if request.prompt.trim().is_empty() || request.prompt.len() > MAX_PROMPT {
        return failure("invalid", "prompt empty or too large", started);
    }
    let vault = PathBuf::from(request.vault_path.trim());
    if !vault.is_absolute() || !vault.is_dir() {
        return failure("invalid", "vault folder not found", started);
    }
    let config_dir = request
        .config_dir
        .as_deref()
        .map(str::trim)
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from);
    if config_dir.as_ref().is_some_and(|dir| !dir.is_dir()) {
        return failure("invalid", "account folder not found", started);
    }
    let Some(launcher) = crate::cli_resolver::find_windows_cli_launcher("claude") else {
        return failure("cli-missing", "Claude Code CLI not found", started);
    };
    let base = match scribe_dir(&app) {
        Ok(dir) => dir.join("runs"),
        Err(e) => return failure("spawn", e, started),
    };
    let accounts_root = app
        .path()
        .app_local_data_dir()
        .ok()
        .map(|dir| dir.join("claude-accounts"));
    let run_dir = base.join(&request.run_id);
    let result = run_in(RunPlace {
        request: &request,
        launcher: &launcher,
        vault: &vault,
        config_dir: config_dir.as_deref(),
        accounts_root: accounts_root.as_deref(),
        base: &base,
        run_dir: &run_dir,
        started,
    })
    .await;
    let _ = std::fs::remove_dir_all(&run_dir);
    result
}

struct RunPlace<'a> {
    request: &'a AuthorRequest,
    launcher: &'a Path,
    vault: &'a Path,
    config_dir: Option<&'a Path>,
    accounts_root: Option<&'a Path>,
    base: &'a Path,
    run_dir: &'a Path,
    started: Instant,
}

async fn run_in(place: RunPlace<'_>) -> AuthorOutcome {
    let RunPlace {
        request,
        launcher,
        vault,
        config_dir,
        accounts_root,
        base,
        run_dir,
        started,
    } = place;
    sweep(base, STALE_RUN, Some(run_dir));
    let launcher_path = launcher.to_path_buf();
    let help = tokio::task::spawn_blocking(move || cli_help(&launcher_path))
        .await
        .unwrap_or(None);
    // The locks never depend on the help: they are always passed. A help that shows a lock
    // missing only means this CLI cannot honor them, so the run is refused.
    if let Some(help) = &help {
        let missing = missing_locks(help);
        if !missing.is_empty() {
            return failure("cli-locks", missing.join(", "), started);
        }
    }
    // The author works in its own folder, with the session's transcripts and task files in it;
    // its settings and MCP config sit next to it, where the rules keep it from reading them.
    let work = run_dir.join("work");
    let private_dir = run_dir.join("config");
    if let Err(e) =
        std::fs::create_dir_all(&work).and_then(|_| std::fs::create_dir_all(&private_dir))
    {
        return failure("spawn", e.to_string(), started);
    }
    let home = dirs_next::home_dir();
    let session_folder = request
        .session_folder
        .as_deref()
        .map(str::trim)
        .filter(|f| !f.is_empty())
        .map(PathBuf::from);
    let transcripts = request.transcripts.clone();
    let sources: Vec<PathBuf> = request
        .sources
        .iter()
        .take(MAX_SOURCES)
        .map(|s| PathBuf::from(s.trim()))
        .filter(|s| {
            accepted_source(
                s,
                &request.session_id,
                session_folder.as_deref(),
                &orchestra_dir(),
                home.as_deref(),
            )
        })
        .collect();
    let work_files = work.clone();
    let _ = tokio::task::spawn_blocking(move || {
        link_transcripts(&work_files.join("transcripts"), &transcripts);
        copy_sources(&work_files.join("tarefas"), &sources);
    })
    .await;

    let mcp = find_obsidian_mcp(config_dir);
    let mcp_path = private_dir.join("mcp.json");
    let mcp_ready = match &mcp {
        Some(config) => std::fs::write(&mcp_path, config.to_string()).is_ok(),
        None => false,
    };
    let private = Private {
        vault,
        run_config: &private_dir,
        home: home.as_deref(),
        accounts_root,
        account: config_dir,
    };
    let settings_path = private_dir.join("settings.json");
    let settings = author_settings(&work, &private, mcp_ready);
    if let Err(e) = std::fs::write(&settings_path, settings.to_string()) {
        return failure("spawn", e.to_string(), started);
    }
    let args = author_args(&ArgsInput {
        model: request.model.as_deref().map(str::trim),
        effort: request.effort.as_deref().map(str::trim),
        settings: &settings_path,
        mcp_config: mcp_ready.then_some(mcp_path.as_path()),
        vault,
        max_turns: request.max_turns,
        max_budget_usd: request.max_budget_usd,
        no_persistence: help
            .as_deref()
            .is_some_and(|h| h.contains("--no-session-persistence")),
    });

    let mut command = tokio::process::Command::from(launcher_command(launcher));
    command
        .args(&args)
        .current_dir(&work)
        .env_remove("CLAUDECODE")
        .env_remove("CLAUDE_CODE_ENTRYPOINT")
        .env_remove("CLAUDECODE_PARENT_PID")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    if let Some(dir) = config_dir {
        command.env("CLAUDE_CONFIG_DIR", dir);
    }
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => return failure("spawn", e.to_string(), started),
    };
    let pid = child.id();
    if let (Some(pid), Ok(mut map)) = (pid, running().lock()) {
        map.insert(request.run_id.clone(), pid);
    }

    let prompt = request.prompt.clone();
    let stdin = child.stdin.take();
    let writer = tokio::spawn(async move {
        if let Some(mut stdin) = stdin {
            let _ = stdin.write_all(prompt.as_bytes()).await;
            let _ = stdin.shutdown().await;
        }
    });
    let stdout = child.stdout.take();
    let reader = tokio::spawn(async move {
        let mut out = Vec::new();
        if let Some(stdout) = stdout {
            let _ = stdout.take(MAX_STDOUT as u64).read_to_end(&mut out).await;
        }
        out
    });
    let stderr = child.stderr.take();
    let err_reader = tokio::spawn(async move {
        let mut out = Vec::new();
        if let Some(stderr) = stderr {
            let _ = stderr.take(MAX_STDOUT as u64).read_to_end(&mut out).await;
        }
        out
    });

    let timeout = Duration::from_secs(
        request
            .timeout_secs
            .unwrap_or(DEFAULT_TIMEOUT_SECS)
            .clamp(MIN_TIMEOUT_SECS, MAX_TIMEOUT_SECS),
    );
    let waited = tokio::time::timeout(timeout, child.wait()).await;
    let was_cancelled = {
        let mut list = cancelled().lock().unwrap_or_else(|e| e.into_inner());
        let hit = list.iter().any(|id| id == &request.run_id);
        list.retain(|id| id != &request.run_id);
        hit
    };
    if let Ok(mut map) = running().lock() {
        map.remove(&request.run_id);
    }
    let status = match waited {
        Ok(Ok(status)) => status,
        Ok(Err(e)) => return failure("exit", e.to_string(), started),
        Err(_) => {
            if let Some(pid) = pid {
                kill_tree(pid);
            }
            let _ = child.kill().await;
            writer.abort();
            return failure("timeout", format!("{} s", timeout.as_secs()), started);
        }
    };
    let _ = writer.await;
    let stdout = String::from_utf8_lossy(&reader.await.unwrap_or_default()).into_owned();
    let stderr = String::from_utf8_lossy(&err_reader.await.unwrap_or_default()).into_owned();
    if was_cancelled {
        return failure("cancelled", "", started);
    }
    let duration_ms = started.elapsed().as_millis() as u64;
    match parse_cli_output(&stdout) {
        Some(parsed) => {
            let ok =
                !parsed.is_error && parsed.subtype == "success" && !parsed.result.trim().is_empty();
            AuthorOutcome {
                ok,
                error: (!ok).then(|| cli_failure(&parsed.subtype).to_string()),
                detail: (!ok).then(|| {
                    if parsed.result.trim().is_empty() {
                        format!("{} {}", parsed.subtype, tail(&stderr, STDERR_TAIL))
                            .trim()
                            .to_string()
                    } else {
                        tail(&parsed.result, STDERR_TAIL)
                    }
                }),
                result: parsed.result,
                duration_ms,
                cost_usd: parsed.cost_usd,
                turns: parsed.turns,
                denials: parsed.denials,
                mcp: mcp_ready,
            }
        }
        None => {
            let error = if status.success() { "output" } else { "exit" };
            let detail = if stderr.trim().is_empty() {
                tail(&stdout, STDERR_TAIL)
            } else {
                tail(&stderr, STDERR_TAIL)
            };
            AuthorOutcome {
                mcp: mcp_ready,
                ..failure(error, detail, started)
            }
        }
    }
}

/// Stops a running author (the app is closing, or the user asked). True when one was running.
#[tauri::command]
pub fn scribe_author_cancel(run_id: String) -> bool {
    let pid = running()
        .lock()
        .ok()
        .and_then(|map| map.get(&run_id).copied());
    let Some(pid) = pid else {
        return false;
    };
    if let Ok(mut list) = cancelled().lock() {
        list.push(run_id);
    }
    kill_tree(pid);
    true
}

fn material_file(dir: &Path, session_id: &str) -> PathBuf {
    dir.join(format!("{session_id}.jsonl"))
}

/// Appends entries (one JSON object per line) to a session's material, keeping the newest half
/// when the file outgrows its cap.
fn append_material_in(dir: &Path, session_id: &str, lines: &[String]) -> Result<(), String> {
    if !crate::obsidian::is_valid_session_id(session_id) {
        return Err(format!("invalid session id: {session_id}"));
    }
    if lines.len() > MAX_MATERIAL_BATCH {
        return Err("too many material entries".into());
    }
    let mut text = String::new();
    for line in lines {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if line.len() > MAX_MATERIAL_LINE || line.contains(['\n', '\r']) || !line.starts_with('{') {
            return Err("invalid material entry".into());
        }
        text.push_str(line);
        text.push('\n');
    }
    if text.is_empty() {
        return Ok(());
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = material_file(dir, session_id);
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    file.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    drop(file);
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if size > MAX_MATERIAL_FILE {
        let kept = read_material_in(dir, session_id, (MAX_MATERIAL_FILE / 2) as usize)?;
        let tmp = dir.join(format!("{session_id}.jsonl.tmp"));
        std::fs::write(&tmp, kept).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The newest `max` bytes of a session's material, starting on a whole line. Empty when none.
fn read_material_in(dir: &Path, session_id: &str, max: usize) -> Result<String, String> {
    if !crate::obsidian::is_valid_session_id(session_id) {
        return Err(format!("invalid session id: {session_id}"));
    }
    let bytes = match std::fs::read(material_file(dir, session_id)) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(e) => return Err(e.to_string()),
    };
    let text = String::from_utf8_lossy(&bytes);
    if text.len() <= max {
        return Ok(text.into_owned());
    }
    let mut start = text.len() - max;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    let rest = &text[start..];
    Ok(match rest.find('\n') {
        Some(i) => rest[i + 1..].to_string(),
        None => String::new(),
    })
}

#[tauri::command]
pub async fn scribe_material_append(
    app: AppHandle,
    session_id: String,
    lines: Vec<String>,
) -> Result<(), String> {
    let dir = scribe_dir(&app)?.join("material");
    tokio::task::spawn_blocking(move || {
        static SWEPT: OnceLock<()> = OnceLock::new();
        SWEPT.get_or_init(|| {
            sweep(&dir, STALE_MATERIAL, None);
        });
        append_material_in(&dir, &session_id, &lines)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn scribe_material_read(app: AppHandle, session_id: String) -> Result<String, String> {
    let dir = scribe_dir(&app)?.join("material");
    tokio::task::spawn_blocking(move || read_material_in(&dir, &session_id, MAX_MATERIAL_READ))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn scribe_material_remove(app: AppHandle, session_id: String) -> Result<(), String> {
    if !crate::obsidian::is_valid_session_id(&session_id) {
        return Err(format!("invalid session id: {session_id}"));
    }
    let path = material_file(&scribe_dir(&app)?.join("material"), &session_id);
    match std::fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

/// Vault-relative paths (`/`-separated) of the vault's files, hidden folders skipped.
fn index_vault(vault: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack: Vec<(PathBuf, usize)> = vec![(vault.to_path_buf(), 0)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                if depth < MAX_INDEX_DEPTH {
                    stack.push((path, depth + 1));
                }
            } else if kind.is_file() {
                if let Ok(rel) = path.strip_prefix(vault) {
                    out.push(rel.to_string_lossy().replace('\\', "/"));
                    if out.len() >= MAX_INDEX {
                        return out;
                    }
                }
            }
        }
    }
    out
}

/// Every file of the vault, so the scribe only keeps links to notes that exist.
#[tauri::command]
pub async fn scribe_vault_index(vault_path: String) -> Result<Vec<String>, String> {
    let vault = PathBuf::from(vault_path.trim());
    if !vault.is_absolute() || !vault.is_dir() {
        return Err("vault folder not found".into());
    }
    tokio::task::spawn_blocking(move || index_vault(&vault))
        .await
        .map_err(|e| e.to_string())
}

#[derive(Serialize, Debug)]
pub struct ScribeSource {
    pub path: String,
    pub content: String,
    pub truncated: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcesRequest {
    pub session_id: String,
    #[serde(default)]
    pub session_folder: Option<String>,
    pub paths: Vec<String>,
}

/// The head of a task file (already accepted for the session).
fn read_source(file: &Path) -> Option<ScribeSource> {
    let bytes = std::fs::read(file).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let (content, truncated) = if text.len() > MAX_SOURCE_READ {
        let mut end = MAX_SOURCE_READ;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        (text[..end].to_string(), true)
    } else {
        (text.into_owned(), false)
    };
    Some(ScribeSource {
        path: file.to_string_lossy().into_owned(),
        content,
        truncated,
    })
}

/// Heads of the session's task files, for the author's prompt. Only files the session owns
/// are read (see `accepted_source`); any other path is skipped.
#[tauri::command]
pub async fn scribe_read_sources(request: SourcesRequest) -> Vec<ScribeSource> {
    tokio::task::spawn_blocking(move || {
        let home = dirs_next::home_dir();
        let folder = request
            .session_folder
            .as_deref()
            .map(str::trim)
            .filter(|f| !f.is_empty())
            .map(PathBuf::from);
        request
            .paths
            .iter()
            .take(MAX_SOURCES)
            .map(|p| PathBuf::from(p.trim()))
            .filter(|p| {
                accepted_source(
                    p,
                    &request.session_id,
                    folder.as_deref(),
                    &orchestra_dir(),
                    home.as_deref(),
                )
            })
            .filter_map(|p| read_source(&p))
            .collect()
    })
    .await
    .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    const FULL_HELP: &str = r#"
  --restricted                          Restricted mode
  --tools <tools...>                    Specify the list of available tools
  --permission-mode <mode>              (choices: "acceptEdits", "auto", "dontAsk", "plan")
  --no-session-persistence              Disable session persistence
  --strict-mcp-config                   Only use MCP servers from --mcp-config
"#;

    fn test_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("alethe-scribe-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn args_with(model: Option<&str>, effort: Option<&str>) -> Vec<String> {
        author_args(&ArgsInput {
            model,
            effort,
            settings: Path::new("C:/data/run/config/settings.json"),
            mcp_config: Some(Path::new("C:/data/run/config/mcp.json")),
            vault: Path::new("G:/Meu Drive/Anotações/TODO"),
            max_turns: None,
            max_budget_usd: Some(2.5),
            no_persistence: false,
        })
    }

    fn value_of<'a>(args: &'a [String], flag: &str) -> Option<&'a String> {
        args.iter().position(|a| a == flag).map(|i| &args[i + 1])
    }

    #[test]
    fn a_cli_without_a_lock_is_refused() {
        assert!(missing_locks(FULL_HELP).is_empty());
        assert_eq!(
            missing_locks("--tools <tools...>\n--strict-mcp-config"),
            vec!["--permission-mode dontAsk", "--restricted"]
        );
        assert_eq!(missing_locks("").len(), 4);
    }

    #[test]
    fn the_locks_are_always_passed() {
        // No help was read at all: the locks are still there.
        let args = args_with(None, None);
        assert_eq!(&args[..3], ["-p", "--output-format", "json"]);
        assert_eq!(value_of(&args, "--tools").unwrap(), "Read,Grep,Glob");
        assert_eq!(value_of(&args, "--permission-mode").unwrap(), "dontAsk");
        assert!(args.contains(&"--restricted".to_string()));
        assert!(args.contains(&"--strict-mcp-config".to_string()));
        assert_eq!(value_of(&args, "--max-turns").unwrap(), "40");
        assert_eq!(value_of(&args, "--max-budget-usd").unwrap(), "2.50");
        assert!(!args.contains(&"--no-session-persistence".to_string()));
        // Read is never allowed by name: only by path, in the settings file.
        let allowed = value_of(&args, "--allowedTools").unwrap();
        assert!(allowed.starts_with("Grep,Glob"));
        for tool in [
            "Read",
            "Bash",
            "Edit",
            "Write",
            "PowerShell",
            "append",
            "patch",
            "delete",
        ] {
            assert!(!allowed.contains(tool), "{tool} allowed");
        }
        let denied = value_of(&args, "--disallowedTools").unwrap();
        for tool in [
            "Bash",
            "Edit",
            "Write",
            "mcp__obsidian__obsidian_delete_file",
        ] {
            assert!(denied.contains(tool), "{tool} not denied");
        }
        // The vault is the only folder added; a path with spaces stays one argument.
        let added: Vec<&String> = args
            .iter()
            .enumerate()
            .filter(|(i, a)| *i > 0 && args[i - 1] == "--add-dir" && !a.is_empty())
            .map(|(_, a)| a)
            .collect();
        assert_eq!(added, vec!["G:/Meu Drive/Anotações/TODO"]);
        assert!(!args.iter().any(|a| a.contains("skip-permissions")));
    }

    #[test]
    fn models_efforts_and_limits_are_validated() {
        for ok in [
            "opus",
            "sonnet",
            "claude-fable-5-1",
            "claude-opus-5-5",
            "sonnet[1m]",
            "us.anthropic.x:0",
        ] {
            assert!(valid_model(ok), "{ok}");
        }
        for bad in [
            "",
            "-p",
            "--dangerously-skip-permissions",
            "opus --x",
            "a\"b",
            "a;b",
            "a&b",
            "a|b",
            "x y",
            "é",
        ] {
            assert!(!valid_model(bad), "{bad}");
        }
        assert!(valid_effort("max"));
        assert!(!valid_effort("ultra"));
        let args = args_with(
            Some("opus --dangerously-skip-permissions"),
            Some("max\"; calc"),
        );
        assert!(!args.iter().any(|a| a == "--model" || a == "--effort"));
        assert!(!args.iter().any(|a| a.contains("dangerously")));
        let good = args_with(Some("opus"), Some("high"));
        assert_eq!(value_of(&good, "--model").unwrap(), "opus");
        assert_eq!(value_of(&good, "--effort").unwrap(), "high");
        assert_eq!(turns_limit(Some(1)), MIN_MAX_TURNS);
        assert_eq!(turns_limit(Some(10_000)), MAX_MAX_TURNS);
        assert_eq!(turns_limit(Some(25)), 25);
        assert_eq!(budget_arg(Some(0.0)), None);
        assert_eq!(budget_arg(Some(f64::NAN)), None);
        assert_eq!(budget_arg(Some(-3.0)), None);
        assert_eq!(budget_arg(Some(1_000.0)).as_deref(), Some("50.00"));
        assert_eq!(budget_arg(None), None);
    }

    #[test]
    fn rule_paths_use_the_posix_form() {
        assert_eq!(
            rule_path(Path::new(r"G:\Meu Drive\Anotações\TODO\.obsidian")).as_deref(),
            Some("//g/Meu Drive/Anotações/TODO/.obsidian")
        );
        assert_eq!(
            rule_path(Path::new(r"\\?\C:\x\y")).as_deref(),
            Some("//c/x/y")
        );
        assert_eq!(
            rule_path(Path::new("/home/me/vault")).as_deref(),
            Some("//home/me/vault")
        );
        assert_eq!(rule_path(Path::new(r"\\server\share")), None);
    }

    #[test]
    fn reads_are_limited_by_path_and_private_folders_denied() {
        let private = Private {
            vault: Path::new(r"G:\Vault"),
            run_config: Path::new(r"C:\data\run\config"),
            home: Some(Path::new(r"C:\Users\Raul")),
            accounts_root: Some(Path::new(r"C:\data\claude-accounts")),
            account: Some(Path::new(r"D:\Contas\Claude")),
        };
        let settings = author_settings(Path::new(r"C:\data\run\work"), &private, true);
        let allow: Vec<String> =
            serde_json::from_value(settings["permissions"]["allow"].clone()).unwrap();
        assert_eq!(
            &allow[..2],
            ["Read(//g/Vault/**)", "Read(//c/data/run/work/**)"]
        );
        assert!(!allow.contains(&"Read".to_string()));
        assert!(allow.contains(&"mcp__obsidian__obsidian_simple_search".to_string()));
        assert!(!allow
            .iter()
            .any(|t| t.contains("append") || t.contains("delete") || t.contains("patch")));
        let deny: Vec<String> =
            serde_json::from_value(settings["permissions"]["deny"].clone()).unwrap();
        for rule in [
            "Bash",
            "Read(//g/Vault/.obsidian/**)",
            "Read(//c/data/run/config/**)",
            "Read(//c/Users/Raul/.ssh/**)",
            "Read(//c/Users/Raul/.claude/**)",
            "Read(//c/Users/Raul/.claude.json)",
            "Read(//c/data/claude-accounts/**)",
            "Read(//d/Contas/Claude/**)",
        ] {
            assert!(deny.contains(&rule.to_string()), "{rule} not denied");
        }
        assert_eq!(settings["permissions"]["defaultMode"], json!("dontAsk"));
        assert_eq!(settings["disableAllHooks"], json!(true));
        // Without MCP, only the file tools.
        let plain = author_settings(Path::new(r"C:\w"), &private, false);
        let allow: Vec<String> =
            serde_json::from_value(plain["permissions"]["allow"].clone()).unwrap();
        assert!(!allow.iter().any(|t| t.starts_with("mcp__")));
    }

    #[test]
    fn transcripts_are_linked_into_the_author_folder() {
        let dir = test_dir("transcripts");
        let source = dir.join("projects").join("p");
        std::fs::create_dir_all(&source).unwrap();
        let jsonl = source.join("abc.jsonl");
        std::fs::write(&jsonl, "{\"type\":\"user\"}\n").unwrap();
        std::fs::write(source.join("notes.md"), "x").unwrap();
        let file = |name: &str, path: &Path| AuthorFile {
            name: name.into(),
            path: path.to_string_lossy().into_owned(),
        };
        let target = dir.join("work").join("transcripts");
        let placed = link_transcripts(
            &target,
            &[
                file("claude-7", &jsonl),
                file("../x", &jsonl),
                file("Bad Name", &jsonl),
                file("claude-8", &source.join("notes.md")),
                file("claude-9", &source.join("missing.jsonl")),
                file("claude-1", Path::new("relative.jsonl")),
            ],
        );
        assert_eq!(placed, vec!["claude-7"]);
        assert_eq!(
            std::fs::read_to_string(target.join("claude-7.jsonl")).unwrap(),
            "{\"type\":\"user\"}\n"
        );
        // Removing the author's folder leaves the original transcript alone.
        std::fs::remove_dir_all(dir.join("work")).unwrap();
        assert!(jsonl.is_file());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn only_the_session_own_task_files_are_sources() {
        let dir = test_dir("sources");
        let project = dir.join("projeto");
        let orchestra = dir.join("alethe-orchestra");
        std::fs::create_dir_all(project.join("tarefas")).unwrap();
        std::fs::create_dir_all(project.join(".segredo")).unwrap();
        std::fs::create_dir_all(&orchestra).unwrap();
        let task = project.join("tarefas").join("claude-7.md");
        std::fs::write(&task, "# Tarefa\nfazer").unwrap();
        std::fs::write(project.join(".segredo").join("x.md"), "x").unwrap();
        std::fs::write(project.join("config.json"), "{}").unwrap();
        std::fs::write(dir.join("fora.md"), "x").unwrap();
        let own = orchestra.join("task-oabc1234-claude-7.md");
        let other = orchestra.join("task-ozzz9999-claude-1.md");
        std::fs::write(&own, "x").unwrap();
        std::fs::write(&other, "x").unwrap();
        let accepted = |path: &Path, folder: Option<&Path>| {
            accepted_source(path, "oabc1234", folder, &orchestra, None)
        };
        assert!(accepted(&task, Some(&project)));
        assert!(!accepted(
            &project.join(".segredo").join("x.md"),
            Some(&project)
        ));
        assert!(!accepted(&project.join("config.json"), Some(&project)));
        assert!(!accepted(&dir.join("fora.md"), Some(&project)));
        assert!(!accepted(&task, None));
        assert!(accepted(&own, None));
        assert!(!accepted(&other, None));
        assert!(!accepted(Path::new("relative.md"), Some(&project)));
        // The user's home folder is too broad to be a session folder.
        assert!(!accepted_source(
            &task,
            "oabc1234",
            Some(&dir),
            &orchestra,
            Some(&dir)
        ));
        // Accepted files are copied under safe names.
        let copied = copy_sources(&dir.join("tarefas"), &[task.clone(), own.clone()]);
        assert_eq!(copied, 2);
        assert!(dir.join("tarefas").join("01-claude-7.md").is_file());
        assert!(dir
            .join("tarefas")
            .join("02-task-oabc1234-claude-7.md")
            .is_file());
        assert_eq!(safe_file_name("a:b*c?.md"), "a_b_c_.md");
        assert_eq!(read_source(&task).unwrap().content, "# Tarefa\nfazer");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_obsidian_server_is_copied_alone() {
        let raw = r#"{"mcpServers":{"obsidian":{"type":"stdio","command":"mcp-obsidian.exe","env":{"OBSIDIAN_API_KEY":"k"}},"other":{"command":"x"}},"projects":{}}"#;
        let config = obsidian_mcp_config(raw).unwrap();
        assert_eq!(
            config["mcpServers"]["obsidian"]["command"],
            json!("mcp-obsidian.exe")
        );
        assert!(config["mcpServers"].get("other").is_none());
        assert!(obsidian_mcp_config(r#"{"mcpServers":{}}"#).is_none());
        assert!(obsidian_mcp_config("not json").is_none());
    }

    #[test]
    fn cli_output_is_parsed_from_the_result_line() {
        let out = "warming up\n{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"=== SUMMARY ===\\nok\",\"total_cost_usd\":0.12,\"num_turns\":7,\"permission_denials\":[{\"tool_name\":\"Bash\"}]}\n";
        let parsed = parse_cli_output(out).unwrap();
        assert_eq!(parsed.subtype, "success");
        assert!(!parsed.is_error);
        assert!(parsed.result.starts_with("=== SUMMARY ==="));
        assert_eq!(parsed.turns, Some(7));
        assert_eq!(parsed.denials, 1);
        assert_eq!(parsed.cost_usd, Some(0.12));
        let failed = parse_cli_output(
            r#"{"type":"result","subtype":"error_max_turns","is_error":true,"total_cost_usd":0.4}"#,
        )
        .unwrap();
        assert!(failed.is_error);
        assert_eq!(failed.cost_usd, Some(0.4));
        assert_eq!(cli_failure(&failed.subtype), "max-turns");
        assert_eq!(cli_failure("error_max_budget_usd"), "max-budget");
        assert_eq!(cli_failure("error_during_execution"), "cli-error");
        assert!(parse_cli_output("plain text").is_none());
        assert!(parse_cli_output(r#"{"type":"assistant"}"#).is_none());
    }

    #[test]
    fn run_ids_name_folders_safely() {
        assert!(valid_run_id("oabc1234-1791160000000"));
        for bad in ["", "../x", "a/b", "A", "a b", &"x".repeat(41)] {
            assert!(!valid_run_id(bad), "{bad}");
        }
    }

    #[test]
    fn material_appends_reads_and_keeps_its_newest_half() {
        let dir = test_dir("material");
        let session = "oabc1234";
        append_material_in(&dir, session, &[r#"{"at":1,"kind":"start"}"#.into()]).unwrap();
        append_material_in(
            &dir,
            session,
            &[r#"{"at":2,"kind":"report"}"#.into(), String::new()],
        )
        .unwrap();
        let text = read_material_in(&dir, session, MAX_MATERIAL_READ).unwrap();
        assert_eq!(text.lines().count(), 2);
        // Bad entries and bad ids are refused; nothing outside the folder can be named.
        assert!(append_material_in(&dir, session, &["{\"a\":1}\n{\"b\":2}".into()]).is_err());
        assert!(append_material_in(&dir, session, &["not json".into()]).is_err());
        assert!(append_material_in(&dir, "../x", &[r#"{"a":1}"#.into()]).is_err());
        assert_eq!(read_material_in(&dir, "onone", 100).unwrap(), "");
        // A tail read starts on a whole line.
        let tail = read_material_in(&dir, session, 30).unwrap();
        assert_eq!(tail, "{\"at\":2,\"kind\":\"report\"}\n");
        // Past the cap the file keeps its newest half.
        let line = format!("{{\"text\":\"{}\"}}", "x".repeat(MAX_MATERIAL_LINE - 20));
        let batch: Vec<String> = (0..((MAX_MATERIAL_FILE as usize / line.len()) + 4))
            .map(|_| line.clone())
            .collect();
        for chunk in batch.chunks(64) {
            append_material_in(&dir, session, chunk).unwrap();
        }
        let size = std::fs::metadata(material_file(&dir, session))
            .unwrap()
            .len();
        assert!(size <= MAX_MATERIAL_FILE, "{size}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_vault_index_skips_hidden_folders() {
        let dir = test_dir("index");
        std::fs::create_dir_all(dir.join("Diário/2026")).unwrap();
        std::fs::create_dir_all(dir.join(".obsidian/plugins")).unwrap();
        std::fs::write(dir.join("Diário/2026/Sessão.md"), "x").unwrap();
        std::fs::write(dir.join("Alethe.md"), "x").unwrap();
        std::fs::write(dir.join(".obsidian/plugins/data.json"), "{}").unwrap();
        let mut index = index_vault(&dir);
        index.sort();
        assert_eq!(index, vec!["Alethe.md", "Diário/2026/Sessão.md"]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn stale_runs_are_swept_but_not_the_current_one() {
        let dir = test_dir("sweep");
        let current = dir.join("current");
        std::fs::create_dir_all(&current).unwrap();
        std::fs::create_dir_all(dir.join("old")).unwrap();
        assert_eq!(sweep(&dir, Duration::ZERO, Some(&current)), 1);
        assert!(current.is_dir());
        assert!(!dir.join("old").exists());
        let _ = std::fs::remove_dir_all(dir);
    }
}

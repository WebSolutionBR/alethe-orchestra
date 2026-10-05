//! Obsidian bridge for the Orchestra scribe.
//!
//! Talks to the "Local REST API" community plugin on the loopback interface. The
//! API key is read from the plugin's own `data.json` inside the vault and never
//! leaves the backend; the frontend only learns whether one was found.
//!
//! Besides appending to the session notes, it searches, lists and reads notes so a
//! new orchestration can be told what the vault already knows, and saves that
//! summary to a temp file the agents read. The scribe's author writes through it too:
//! whole notes the scribe owns (`PUT`) and sections appended under a heading of any
//! other note (`PATCH`), which the plugin refuses to add twice. Nothing here deletes.

use reqwest::{StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime};

const DEFAULT_PORT: u16 = 27124;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_APPEND: usize = 64 * 1024;
/// Cap of a whole note written by the scribe (its diary and topic notes).
const MAX_PUT: usize = 512 * 1024;
const MAX_HEADING: usize = 200;
const MAX_HEADING_DEPTH: usize = 6;
/// Joins the heading path in the `Target` header; a heading containing it is refused.
const HEADING_DELIMITER: &str = "::";
const PLUGIN_CONFIG: &str = ".obsidian/plugins/obsidian-local-rest-api/data.json";
/// Reads feed the start of a session, so they give up sooner than appends.
const SEARCH_TIMEOUT: Duration = Duration::from_secs(4);
const READ_TIMEOUT: Duration = Duration::from_secs(3);
/// Cap of any body downloaded from the plugin: a search for a common word reaches megabytes.
const MAX_BODY: usize = 8 * 1024 * 1024;
/// Cap of a note handed to the frontend; a longer note keeps its head, or its tail.
const MAX_READ: usize = 200 * 1024;
/// A cut note starts or ends on a line break when one is this close to the cut.
const LINE_SNAP: usize = 4 * 1024;
const MAX_QUERY: usize = 200;
const DEFAULT_CONTEXT_LENGTH: u32 = 80;
const MAX_CONTEXT_LENGTH: u32 = 300;
const MAX_HITS: usize = 40;
const MAX_HIT_CONTEXTS: usize = 4;
const MAX_LIST: usize = 500;
const MAX_CONTEXT_FILE: usize = 64 * 1024;
/// Context files a session left behind (crash, forced exit) are removed after this long.
const STALE_CONTEXT: Duration = Duration::from_secs(3 * 24 * 60 * 60);

#[derive(Serialize)]
pub struct ObsidianVault {
    pub path: String,
    pub open: bool,
}

#[derive(Serialize)]
pub struct ObsidianStatus {
    pub vault_exists: bool,
    pub plugin_found: bool,
    pub has_key: bool,
    pub port: u16,
    /// The plugin answered and accepted the key.
    pub authenticated: bool,
    pub error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObsidianTarget {
    pub vault_path: String,
    /// Overrides the key from the plugin config when set.
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
}

struct PluginConfig {
    api_key: Option<String>,
    port: u16,
}

#[derive(Serialize, Debug)]
pub struct ObsidianSearchHit {
    /// Vault-relative path of the note.
    pub filename: String,
    /// The plugin's score; hits keep its order, best first.
    pub score: f64,
    /// Matches in the note; only the first few contexts are kept.
    pub match_count: usize,
    pub contexts: Vec<String>,
}

#[derive(Serialize, Debug)]
pub struct ObsidianSearchResult {
    /// Notes that matched, before the cap on `hits`.
    pub total: usize,
    pub hits: Vec<ObsidianSearchHit>,
}

#[derive(Serialize, Debug)]
pub struct ObsidianNote {
    pub path: String,
    pub content: String,
    /// Bytes of the whole note.
    pub size: usize,
    /// The note was longer than the cap: `content` is its head, or its tail when asked.
    pub truncated: bool,
}

#[derive(Deserialize)]
struct RawSearchHit {
    filename: String,
    #[serde(default)]
    score: f64,
    #[serde(default)]
    matches: Vec<RawSearchMatch>,
}

#[derive(Deserialize)]
struct RawSearchMatch {
    #[serde(default)]
    context: String,
}

fn http_client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    // The plugin serves a self-signed certificate; every request goes to the
    // fixed loopback address below and is authenticated by the API key.
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .timeout(REQUEST_TIMEOUT)
        .connect_timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(CLIENT.get_or_init(|| client))
}

fn obsidian_config_file() -> Option<PathBuf> {
    dirs_next::config_dir().map(|dir| dir.join("obsidian").join("obsidian.json"))
}

fn parse_vaults(raw: &str) -> Vec<ObsidianVault> {
    let parsed: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
    let mut vaults: Vec<ObsidianVault> = parsed
        .get("vaults")
        .and_then(|v| v.as_object())
        .map(|map| {
            map.values()
                .filter_map(|vault| {
                    let path = vault.get("path")?.as_str()?.to_string();
                    let open = vault.get("open").and_then(|o| o.as_bool()).unwrap_or(false);
                    Some(ObsidianVault { path, open })
                })
                .collect()
        })
        .unwrap_or_default();
    vaults.sort_by(|a, b| b.open.cmp(&a.open).then_with(|| a.path.cmp(&b.path)));
    vaults
}

fn parse_plugin_config(raw: &str) -> PluginConfig {
    let parsed: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
    let api_key = parsed
        .get("apiKey")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(str::to_string);
    let port = parsed
        .get("port")
        .and_then(|v| v.as_u64())
        .and_then(|p| u16::try_from(p).ok())
        .unwrap_or(DEFAULT_PORT);
    PluginConfig { api_key, port }
}

fn read_plugin_config(vault: &Path) -> Option<PluginConfig> {
    let raw = std::fs::read_to_string(vault.join(PLUGIN_CONFIG)).ok()?;
    Some(parse_plugin_config(&raw))
}

/// Accepts vault-relative markdown paths only: no absolute paths, no `..`.
fn note_segments(note_path: &str) -> Result<Vec<&str>, String> {
    let trimmed = note_path.trim().trim_matches('/');
    if trimmed.is_empty() || !trimmed.to_lowercase().ends_with(".md") {
        return Err("note path must be a vault-relative .md file".into());
    }
    let segments: Vec<&str> = trimmed.split(['/', '\\']).collect();
    if segments
        .iter()
        .any(|s| s.is_empty() || *s == "." || *s == ".." || s.contains(':'))
    {
        return Err(format!("invalid note path: {note_path}"));
    }
    Ok(segments)
}

fn resolve(target: &ObsidianTarget) -> Result<(String, u16), String> {
    let vault = PathBuf::from(target.vault_path.trim());
    let config = read_plugin_config(&vault);
    let key = target
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(str::to_string)
        .or_else(|| config.as_ref().and_then(|c| c.api_key.clone()))
        .ok_or("Local REST API key not found in the vault plugin config")?;
    let port = target
        .port
        .or_else(|| config.as_ref().map(|c| c.port))
        .unwrap_or(DEFAULT_PORT);
    Ok((key, port))
}

fn note_url(port: u16, note_path: &str) -> Result<Url, String> {
    let mut url =
        Url::parse(&format!("https://127.0.0.1:{port}/vault/")).map_err(|e| e.to_string())?;
    {
        let mut path = url
            .path_segments_mut()
            .map_err(|_| "cannot build note url".to_string())?;
        path.pop_if_empty();
        for segment in note_segments(note_path)? {
            path.push(segment);
        }
    }
    Ok(url)
}

/// A vault-relative folder (empty = vault root): no absolute paths, no `..`.
fn dir_segments(dir: &str) -> Result<Vec<&str>, String> {
    let trimmed = dir.trim().trim_matches(['/', '\\']);
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let segments: Vec<&str> = trimmed.split(['/', '\\']).collect();
    if segments
        .iter()
        .any(|s| s.trim().is_empty() || *s == "." || *s == ".." || s.contains(':'))
    {
        return Err(format!("invalid folder: {dir}"));
    }
    Ok(segments)
}

/// `/vault/<folder>/`: the plugin lists a folder when the path ends with a slash.
fn dir_url(port: u16, dir: &str) -> Result<Url, String> {
    let mut url =
        Url::parse(&format!("https://127.0.0.1:{port}/vault/")).map_err(|e| e.to_string())?;
    let segments = dir_segments(dir)?;
    if !segments.is_empty() {
        let mut path = url
            .path_segments_mut()
            .map_err(|_| "cannot build folder url".to_string())?;
        path.pop_if_empty();
        for segment in segments {
            path.push(segment);
        }
        path.push("");
    }
    Ok(url)
}

/// One line of search terms; the plugin wants every word in the note.
fn clean_query(query: &str) -> Result<String, String> {
    let flat = query
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if flat.is_empty() {
        return Err("empty search query".into());
    }
    if flat.chars().count() > MAX_QUERY {
        return Err("search query too long".into());
    }
    Ok(flat)
}

fn search_url(port: u16, query: &str, context_length: u32) -> Result<Url, String> {
    let mut url = Url::parse(&format!("https://127.0.0.1:{port}/search/simple/"))
        .map_err(|e| e.to_string())?;
    url.query_pairs_mut()
        .append_pair("query", query)
        .append_pair("contextLength", &context_length.to_string());
    Ok(url)
}

/// Whitespace collapsed to single spaces, at most `max` chars (an ellipsis marks a cut).
fn flatten(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        return flat;
    }
    let mut out: String = flat.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// The plugin's answer, best hits first, capped in hits and in contexts per hit.
fn parse_search(body: &[u8], context_length: u32) -> Result<ObsidianSearchResult, String> {
    let raw: Vec<RawSearchHit> =
        serde_json::from_slice(body).map_err(|e| format!("unexpected search answer: {e}"))?;
    let total = raw.len();
    let max_context = context_length as usize * 2 + 120;
    let hits = raw
        .into_iter()
        .take(MAX_HITS)
        .map(|hit| ObsidianSearchHit {
            match_count: hit.matches.len(),
            contexts: hit
                .matches
                .into_iter()
                .take(MAX_HIT_CONTEXTS)
                .map(|m| flatten(&m.context, max_context))
                .filter(|c| !c.is_empty())
                .collect(),
            filename: hit.filename,
            score: if hit.score.is_finite() {
                hit.score
            } else {
                0.0
            },
        })
        .collect();
    Ok(ObsidianSearchResult { total, hits })
}

fn parse_list(body: &[u8]) -> Result<Vec<String>, String> {
    let parsed: Value =
        serde_json::from_slice(body).map_err(|e| format!("unexpected folder answer: {e}"))?;
    Ok(parsed
        .get("files")
        .and_then(|files| files.as_array())
        .map(|files| {
            files
                .iter()
                .filter_map(|f| f.as_str())
                .take(MAX_LIST)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default())
}

/// At most `max` bytes of `text`, cut on a char boundary and on a line break when one is
/// near: the head, or the tail when `tail` is set. Returns whether anything was cut.
fn cap_text(text: &str, max: usize, tail: bool) -> (String, bool) {
    if text.len() <= max {
        return (text.to_string(), false);
    }
    if tail {
        let mut start = text.len() - max;
        while !text.is_char_boundary(start) {
            start += 1;
        }
        let rest = &text[start..];
        let rest = match rest.find('\n') {
            Some(i) if i < LINE_SNAP => &rest[i + 1..],
            _ => rest,
        };
        (rest.to_string(), true)
    } else {
        let mut end = max;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        let head = &text[..end];
        let head = match head.rfind('\n') {
            Some(i) if end - i < LINE_SNAP => &head[..i],
            _ => head,
        };
        (head.to_string(), true)
    }
}

/// The body of a successful answer, at most `cap` bytes; anything else becomes an error.
async fn success_body(mut response: reqwest::Response, cap: usize) -> Result<Vec<u8>, String> {
    let status = response.status();
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        return Err("Local REST API rejected the key".into());
    }
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "Obsidian answered {status}: {}",
            body.chars().take(200).collect::<String>()
        ));
    }
    if response
        .content_length()
        .is_some_and(|len| len > cap as u64)
    {
        return Err("Obsidian answer too large".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| describe(&e))? {
        if body.len() + chunk.len() > cap {
            return Err("Obsidian answer too large".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Same rule as the orchestra session ids (1-32 of `a-z0-9-`); they name files.
pub(crate) fn is_valid_session_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 32
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// Next to the orchestra hook settings, under the system temp dir.
fn context_dir() -> PathBuf {
    std::env::temp_dir().join("alethe-orchestra")
}

fn context_file(dir: &Path, session_id: &str) -> PathBuf {
    dir.join(format!("context-{session_id}.md"))
}

/// Writes the context file atomically (temp file, then rename) and returns its path.
fn write_context_in(dir: &Path, session_id: &str, markdown: &str) -> Result<PathBuf, String> {
    if !is_valid_session_id(session_id) {
        return Err(format!("invalid session id: {session_id}"));
    }
    if markdown.len() > MAX_CONTEXT_FILE {
        return Err("context too large".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = context_file(dir, session_id);
    let tmp = dir.join(format!("context-{session_id}.md.tmp"));
    std::fs::write(&tmp, markdown).map_err(|e| e.to_string())?;
    if let Err(e) = std::fs::rename(&tmp, &path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    Ok(path)
}

/// Removes context files older than `max_age`, except `keep`. Returns how many went.
fn remove_stale_contexts(dir: &Path, keep: &Path, max_age: Duration) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let now = SystemTime::now();
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let ours =
            name.starts_with("context-") && (name.ends_with(".md") || name.ends_with(".md.tmp"));
        if !ours || path == keep {
            continue;
        }
        // A clock step can put the mtime a little ahead of `now`: that file is new.
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .map(|modified| now.duration_since(modified).unwrap_or(Duration::ZERO))
            .is_some_and(|age| age >= max_age);
        if old && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Vaults registered in the Obsidian app, open ones first.
#[tauri::command]
pub fn obsidian_detect_vaults() -> Vec<ObsidianVault> {
    obsidian_config_file()
        .and_then(|file| std::fs::read_to_string(file).ok())
        .map(|raw| parse_vaults(&raw))
        .unwrap_or_default()
}

/// Checks the vault, the plugin config and whether the REST API accepts the key.
#[tauri::command]
pub async fn obsidian_status(target: ObsidianTarget) -> ObsidianStatus {
    let vault = PathBuf::from(target.vault_path.trim());
    let config = read_plugin_config(&vault);
    let mut status = ObsidianStatus {
        vault_exists: !target.vault_path.trim().is_empty() && vault.is_dir(),
        plugin_found: config.is_some(),
        has_key: false,
        port: target
            .port
            .or_else(|| config.as_ref().map(|c| c.port))
            .unwrap_or(DEFAULT_PORT),
        authenticated: false,
        error: None,
    };
    let (key, port) = match resolve(&target) {
        Ok(found) => found,
        Err(e) => {
            status.error = Some(e);
            return status;
        }
    };
    status.has_key = true;
    let client = match http_client() {
        Ok(c) => c,
        Err(e) => {
            status.error = Some(e);
            return status;
        }
    };
    match client
        .get(format!("https://127.0.0.1:{port}/"))
        .bearer_auth(&key)
        .send()
        .await
    {
        Ok(response) => {
            let body: Value = response.json().await.unwrap_or(Value::Null);
            status.authenticated = body
                .get("authenticated")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if !status.authenticated {
                status.error = Some("Local REST API rejected the key".into());
            }
        }
        Err(e) => status.error = Some(describe(&e)),
    }
    status
}

/// Appends markdown to a note, creating it (and its folders) when missing.
#[tauri::command]
pub async fn obsidian_append(
    target: ObsidianTarget,
    note_path: String,
    content: String,
) -> Result<(), String> {
    if content.trim().is_empty() {
        return Ok(());
    }
    if content.len() > MAX_APPEND {
        return Err("append too large".into());
    }
    let (key, port) = resolve(&target)?;
    let url = note_url(port, &note_path)?;
    let response = http_client()?
        .post(url)
        .bearer_auth(&key)
        .header("Content-Type", "text/markdown; charset=utf-8")
        .body(content)
        .send()
        .await
        .map_err(|e| describe(&e))?;
    let status = response.status();
    if status.is_success() {
        Ok(())
    } else {
        let body = response.text().await.unwrap_or_default();
        Err(format!(
            "Obsidian answered {status}: {}",
            body.chars().take(200).collect::<String>()
        ))
    }
}

/// Simple search of the Local REST API (every word must appear in the note), best hits first.
#[tauri::command]
pub async fn obsidian_search(
    target: ObsidianTarget,
    query: String,
    context_length: Option<u32>,
) -> Result<ObsidianSearchResult, String> {
    let query = clean_query(&query)?;
    let context_length = context_length
        .unwrap_or(DEFAULT_CONTEXT_LENGTH)
        .min(MAX_CONTEXT_LENGTH);
    let (key, port) = resolve(&target)?;
    let response = http_client()?
        .post(search_url(port, &query, context_length)?)
        .bearer_auth(&key)
        .timeout(SEARCH_TIMEOUT)
        .send()
        .await
        .map_err(|e| describe(&e))?;
    let body = success_body(response, MAX_BODY).await?;
    parse_search(&body, context_length)
}

/// Markdown of one note, at most 200 KB: its head, or its tail when `tail` is set.
#[tauri::command]
pub async fn obsidian_read(
    target: ObsidianTarget,
    note_path: String,
    tail: Option<bool>,
) -> Result<ObsidianNote, String> {
    let (key, port) = resolve(&target)?;
    let url = note_url(port, &note_path)?;
    let response = http_client()?
        .get(url)
        .bearer_auth(&key)
        .header("Accept", "text/markdown")
        .timeout(READ_TIMEOUT)
        .send()
        .await
        .map_err(|e| describe(&e))?;
    if response.status() == StatusCode::NOT_FOUND {
        return Err(format!("note not found: {note_path}"));
    }
    let body = success_body(response, MAX_BODY).await?;
    let text = String::from_utf8_lossy(&body);
    let (content, truncated) = cap_text(&text, MAX_READ, tail.unwrap_or(false));
    Ok(ObsidianNote {
        path: note_segments(&note_path)?.join("/"),
        content,
        size: text.len(),
        truncated,
    })
}

/// Entries of a vault folder (the root when empty); subfolders end with `/`. A missing
/// folder lists nothing.
#[tauri::command]
pub async fn obsidian_list(target: ObsidianTarget, dir: String) -> Result<Vec<String>, String> {
    let (key, port) = resolve(&target)?;
    let url = dir_url(port, &dir)?;
    let response = http_client()?
        .get(url)
        .bearer_auth(&key)
        .timeout(READ_TIMEOUT)
        .send()
        .await
        .map_err(|e| describe(&e))?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(Vec::new());
    }
    let body = success_body(response, MAX_BODY).await?;
    parse_list(&body)
}

/// Saves a session's Obsidian context as `%TEMP%/alethe-orchestra/context-<session>.md`,
/// where its agents read it, and returns that path.
#[tauri::command]
pub async fn obsidian_write_context(
    session_id: String,
    markdown: String,
) -> Result<String, String> {
    let dir = context_dir();
    let path = write_context_in(&dir, &session_id, &markdown)?;
    remove_stale_contexts(&dir, &path, STALE_CONTEXT);
    Ok(path.to_string_lossy().into_owned())
}

/// Removes a session's context file; a missing file is fine.
#[tauri::command]
pub async fn obsidian_remove_context(session_id: String) -> Result<(), String> {
    if !is_valid_session_id(&session_id) {
        return Err(format!("invalid session id: {session_id}"));
    }
    match std::fs::remove_file(context_file(&context_dir(), &session_id)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

/// The `Target` header of a heading patch: the path from the top heading, percent-encoded
/// (the plugin decodes it, and headers carry ASCII only).
fn heading_target(heading: &[String]) -> Result<String, String> {
    if heading.is_empty() || heading.len() > MAX_HEADING_DEPTH {
        return Err("invalid heading path".into());
    }
    let mut parts = Vec::with_capacity(heading.len());
    for part in heading {
        let part = part.trim();
        if part.is_empty()
            || part.chars().count() > MAX_HEADING
            || part.contains(HEADING_DELIMITER)
            || part.chars().any(char::is_control)
        {
            return Err(format!("invalid heading: {part}"));
        }
        parts.push(part);
    }
    let mut encoded = String::new();
    for byte in parts.join(HEADING_DELIMITER).bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    Ok(encoded)
}

/// The plugin's answer when the appended text is already in that section.
fn preexisting(body: &str) -> bool {
    body.contains("content-already-preexists-in-target")
}

/// Creates or replaces a whole note. The scribe only does this to notes it created itself
/// (it checks their marker first); every other note only ever gets sections appended.
#[tauri::command]
pub async fn obsidian_put(
    target: ObsidianTarget,
    note_path: String,
    content: String,
) -> Result<(), String> {
    if content.trim().is_empty() {
        return Err("empty note".into());
    }
    if content.len() > MAX_PUT {
        return Err("note too large".into());
    }
    let (key, port) = resolve(&target)?;
    let url = note_url(port, &note_path)?;
    let response = http_client()?
        .put(url)
        .bearer_auth(&key)
        .header("Content-Type", "text/markdown; charset=utf-8")
        .body(content)
        .send()
        .await
        .map_err(|e| describe(&e))?;
    success_body(response, MAX_BODY).await.map(|_| ())
}

#[derive(Serialize, Debug, PartialEq)]
pub struct ObsidianPatchOutcome {
    /// The section got the content now.
    pub applied: bool,
    /// The content was already there (a retried write): nothing was added.
    pub preexisting: bool,
}

/// Appends markdown under a heading (`heading` is the path from the note's top heading),
/// creating the heading when the note lacks it. Text already in the section is not added
/// again, so a write retried after a timeout cannot duplicate it.
#[tauri::command]
pub async fn obsidian_patch_heading(
    target: ObsidianTarget,
    note_path: String,
    heading: Vec<String>,
    content: String,
) -> Result<ObsidianPatchOutcome, String> {
    if content.trim().is_empty() {
        return Err("empty section".into());
    }
    if content.len() > MAX_APPEND {
        return Err("section too large".into());
    }
    let header = heading_target(&heading)?;
    let (key, port) = resolve(&target)?;
    let url = note_url(port, &note_path)?;
    let response = http_client()?
        .patch(url)
        .bearer_auth(&key)
        .header("Content-Type", "text/markdown; charset=utf-8")
        .header("Operation", "append")
        .header("Target-Type", "heading")
        .header("Target", header)
        .header("Target-Delimiter", HEADING_DELIMITER)
        .header("Create-Target-If-Missing", "true")
        .body(content)
        .send()
        .await
        .map_err(|e| describe(&e))?;
    let status = response.status();
    if status.is_success() {
        return Ok(ObsidianPatchOutcome {
            applied: true,
            preexisting: false,
        });
    }
    if status == StatusCode::NOT_FOUND {
        return Err(format!("note not found: {note_path}"));
    }
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        return Err("Local REST API rejected the key".into());
    }
    let body = response.text().await.unwrap_or_default();
    if preexisting(&body) {
        return Ok(ObsidianPatchOutcome {
            applied: false,
            preexisting: true,
        });
    }
    Err(format!(
        "Obsidian answered {status}: {}",
        body.chars().take(200).collect::<String>()
    ))
}

fn describe(error: &reqwest::Error) -> String {
    if error.is_timeout() {
        "timeout talking to Obsidian".into()
    } else if error.is_connect() {
        "Obsidian is not reachable (is the app open with Local REST API enabled?)".into()
    } else {
        error.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn note_paths_stay_inside_the_vault() {
        assert_eq!(
            note_segments("Alethe Orchestra/2026-10-04 Frota v2.md").unwrap(),
            vec!["Alethe Orchestra", "2026-10-04 Frota v2.md"]
        );
        assert!(note_segments("../secret.md").is_err());
        assert!(note_segments("C:/x.md").is_err());
        assert!(note_segments("notes/a.txt").is_err());
        assert!(note_segments("a//b.md").is_err());
    }

    #[test]
    fn note_url_percent_encodes_segments() {
        let url = note_url(27124, "Alethe Orchestra/2026-10-04 Sessão.md").unwrap();
        assert_eq!(
            url.as_str(),
            "https://127.0.0.1:27124/vault/Alethe%20Orchestra/2026-10-04%20Sess%C3%A3o.md"
        );
    }

    #[test]
    fn plugin_config_reads_key_and_port() {
        let config = parse_plugin_config(r#"{"apiKey":" abc ","port":27200}"#);
        assert_eq!(config.api_key.as_deref(), Some("abc"));
        assert_eq!(config.port, 27200);
        let empty = parse_plugin_config("{}");
        assert!(empty.api_key.is_none());
        assert_eq!(empty.port, DEFAULT_PORT);
    }

    #[test]
    fn vaults_list_open_first() {
        let vaults = parse_vaults(
            r#"{"vaults":{"a":{"path":"Z:/b","open":false},"b":{"path":"Z:/a","open":true}}}"#,
        );
        assert_eq!(vaults[0].path, "Z:/a");
        assert!(vaults[0].open);
        assert_eq!(vaults.len(), 2);
    }

    #[test]
    fn search_url_encodes_the_query() {
        let url = search_url(27124, "automações rest&api", 80).unwrap();
        assert_eq!(
            url.as_str(),
            "https://127.0.0.1:27124/search/simple/?query=automa%C3%A7%C3%B5es+rest%26api&contextLength=80"
        );
    }

    #[test]
    fn search_queries_are_one_bounded_line() {
        assert_eq!(
            clean_query("  alethe\n\tterminal \u{0} ").unwrap(),
            "alethe terminal"
        );
        assert!(clean_query(" \n ").is_err());
        assert!(clean_query(&"a".repeat(MAX_QUERY + 1)).is_err());
        assert!(clean_query(&"ã".repeat(MAX_QUERY)).is_ok());
    }

    #[test]
    fn search_answer_keeps_the_best_hits_and_a_few_contexts() {
        let hits: Vec<Value> = (0..50)
            .map(|i| {
                serde_json::json!({
                    "filename": format!("n{i}.md"),
                    "score": -(100.0 - i as f64),
                    "matches": (0..6).map(|m| serde_json::json!({
                        "context": format!("  line {m}\n of   n{i} "),
                        "match_position": { "start": m, "end": m + 3 }
                    })).collect::<Vec<_>>()
                })
            })
            .collect();
        let body = serde_json::to_vec(&hits).unwrap();
        let result = parse_search(&body, 10).unwrap();
        assert_eq!(result.total, 50);
        assert_eq!(result.hits.len(), MAX_HITS);
        assert_eq!(result.hits[0].filename, "n0.md");
        assert_eq!(result.hits[0].score, -100.0);
        assert_eq!(result.hits[0].match_count, 6);
        assert_eq!(
            result.hits[0].contexts,
            vec![
                "line 0 of n0",
                "line 1 of n0",
                "line 2 of n0",
                "line 3 of n0"
            ]
        );
        assert!(parse_search(b"not json", 10).is_err());
        assert_eq!(parse_search(b"[]", 10).unwrap().total, 0);
    }

    #[test]
    fn long_contexts_are_clipped() {
        let long = "x".repeat(500);
        let body =
            format!(r#"[{{"filename":"a.md","score":-1,"matches":[{{"context":"{long}"}}]}}]"#);
        let result = parse_search(body.as_bytes(), 10).unwrap();
        let context = &result.hits[0].contexts[0];
        assert_eq!(context.chars().count(), 10 * 2 + 120);
        assert!(context.ends_with('…'));
    }

    #[test]
    fn notes_are_capped_on_char_and_line_boundaries() {
        assert_eq!(cap_text("short", 10, false), ("short".to_string(), false));
        let text = format!("{}\n{}", "á".repeat(10), "é".repeat(10));
        let (head, cut) = cap_text(&text, 25, false);
        assert!(cut);
        assert_eq!(head, "á".repeat(10));
        let (tail, cut) = cap_text(&text, 25, true);
        assert!(cut);
        assert_eq!(tail, "é".repeat(10));
        // No line break near the cut: a char boundary still holds.
        let flat = "ç".repeat(100);
        let (head, _) = cap_text(&flat, 51, false);
        assert_eq!(head, "ç".repeat(25));
        let (tail, _) = cap_text(&flat, 51, true);
        assert_eq!(tail, "ç".repeat(25));
    }

    #[test]
    fn folder_paths_stay_inside_the_vault() {
        assert_eq!(
            dir_url(27124, "").unwrap().as_str(),
            "https://127.0.0.1:27124/vault/"
        );
        assert_eq!(
            dir_url(27124, "/Alethe Orchestra/").unwrap().as_str(),
            "https://127.0.0.1:27124/vault/Alethe%20Orchestra/"
        );
        assert_eq!(
            dir_url(27124, "Ferramentas\\Inteligência Artificial")
                .unwrap()
                .as_str(),
            "https://127.0.0.1:27124/vault/Ferramentas/Intelig%C3%AAncia%20Artificial/"
        );
        assert!(dir_url(27124, "../x").is_err());
        assert!(dir_url(27124, "C:/x").is_err());
        assert!(dir_url(27124, "a//b").is_err());
    }

    #[test]
    fn folder_answer_lists_files() {
        assert_eq!(
            parse_list(br#"{"files":["2026-10-04 Orchestra.md","Sub/"]}"#).unwrap(),
            vec!["2026-10-04 Orchestra.md", "Sub/"]
        );
        assert!(parse_list(b"{}").unwrap().is_empty());
        assert!(parse_list(b"<html>").is_err());
    }

    /// Fresh dir under the system temp dir, never the app's live `alethe-orchestra` folder.
    fn test_dir() -> PathBuf {
        std::env::temp_dir().join(format!("obsidian-test-{}", nanoid::nanoid!(10)))
    }

    #[test]
    fn context_files_need_a_valid_session_and_a_bounded_size() {
        let dir = test_dir();
        let path = write_context_in(&dir, "oabc1234", "# Contexto\n").unwrap();
        assert_eq!(path, dir.join("context-oabc1234.md"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "# Contexto\n");
        // Rewriting replaces the file and leaves no temp file behind.
        write_context_in(&dir, "oabc1234", "novo").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "novo");
        assert!(!dir.join("context-oabc1234.md.tmp").exists());
        let long = "a".repeat(33);
        for bad in ["", "../x", "OABC", "a b", "a.b", long.as_str()] {
            assert!(
                write_context_in(&dir, bad, "x").is_err(),
                "{bad:?} must be refused"
            );
        }
        assert!(write_context_in(&dir, "obig", &"x".repeat(MAX_CONTEXT_FILE + 1)).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stale_context_files_are_removed_but_not_the_current_one() {
        let dir = test_dir();
        let keep = write_context_in(&dir, "okeep", "a").unwrap();
        write_context_in(&dir, "oold", "b").unwrap();
        std::fs::write(dir.join("hooks-claude-1.json"), "{}").unwrap();
        assert_eq!(
            remove_stale_contexts(&dir, &keep, Duration::from_secs(3600)),
            0
        );
        assert_eq!(remove_stale_contexts(&dir, &keep, Duration::ZERO), 1);
        assert!(keep.exists());
        assert!(!dir.join("context-oold.md").exists());
        assert!(dir.join("hooks-claude-1.json").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn heading_targets_are_percent_encoded_paths() {
        let path = |parts: &[&str]| parts.iter().map(|p| p.to_string()).collect::<Vec<_>>();
        assert_eq!(
            heading_target(&path(&["Alethe", "Relacionados"])).unwrap(),
            "Alethe%3A%3ARelacionados"
        );
        assert_eq!(
            heading_target(&path(&["Sessão 2026-10-04 — X", "Casos / atividades"])).unwrap(),
            "Sess%C3%A3o%202026-10-04%20%E2%80%94%20X%3A%3ACasos%20%2F%20atividades"
        );
        assert!(heading_target(&[]).is_err());
        assert!(heading_target(&path(&["a::b"])).is_err());
        assert!(heading_target(&path(&["  "])).is_err());
        assert!(heading_target(&path(&["a\nb"])).is_err());
        assert!(heading_target(&path(&["a", "b", "c", "d", "e", "f", "g"])).is_err());
    }

    #[test]
    fn a_section_already_in_the_note_counts_as_written() {
        assert!(preexisting(
            r#"{"errorCode":40080,"message":"content-already-preexists-in-target"}"#
        ));
        assert!(!preexisting(
            r#"{"errorCode":40080,"message":"invalid-target"}"#
        ));
    }
}

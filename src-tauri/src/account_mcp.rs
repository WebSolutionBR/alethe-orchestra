//! Propagates user-scope MCP servers from the default Claude Code config
//! (`~/.claude.json`) into each Alethe Claude account's own config dir.
//!
//! Accounts run with `CLAUDE_CONFIG_DIR=<app data>/claude-accounts/<id>`, so
//! they read `<dir>/.claude.json` instead of the default one and start with no
//! MCP servers at all. Syncing only *adds* servers the account lacks: anything
//! the account already defines (same name) is left untouched.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

/// One account to sync: stable id plus its Claude Code config dir.
#[derive(Debug, Deserialize)]
pub struct McpSyncTarget {
    pub id: String,
    pub config_dir: String,
}

/// Outcome for one account. `error` is set when the account was skipped.
#[derive(Debug, Serialize)]
pub struct McpSyncResult {
    pub id: String,
    pub added: Vec<String>,
    pub error: Option<String>,
}

fn default_config_path() -> Option<PathBuf> {
    dirs_next::home_dir().map(|home| home.join(".claude.json"))
}

fn read_json(path: &Path) -> Result<Value, String> {
    let text = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&text).map_err(|error| error.to_string())
}

/// Copies every server in `source` missing from `target["mcpServers"]`.
/// Returns the names that were added, in source order.
fn merge_mcp_servers(source: &Map<String, Value>, target: &mut Value) -> Result<Vec<String>, String> {
    let root = target
        .as_object_mut()
        .ok_or_else(|| "account .claude.json is not an object".to_string())?;
    let servers = root
        .entry("mcpServers")
        .or_insert_with(|| Value::Object(Map::new()));
    let servers = servers
        .as_object_mut()
        .ok_or_else(|| "account mcpServers is not an object".to_string())?;
    let mut added = Vec::new();
    for (name, config) in source {
        if !servers.contains_key(name) {
            servers.insert(name.clone(), config.clone());
            added.push(name.clone());
        }
    }
    Ok(added)
}

fn sync_one(source: &Map<String, Value>, config_dir: &Path) -> Result<Vec<String>, String> {
    if !config_dir.is_dir() {
        return Err("no_config_dir".to_string());
    }
    let path = config_dir.join(".claude.json");
    let mut target = if path.exists() {
        read_json(&path)?
    } else {
        Value::Object(Map::new())
    };
    let added = merge_mcp_servers(source, &mut target)?;
    if added.is_empty() {
        return Ok(added);
    }
    let text = serde_json::to_string_pretty(&target).map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.alethe-tmp");
    fs::write(&temporary, text).map_err(|error| error.to_string())?;
    fs::rename(&temporary, &path).map_err(|error| error.to_string())?;
    Ok(added)
}

/// Adds the default config's user-scope MCP servers to every given account.
/// One failing account never fails the batch.
#[tauri::command]
pub fn sync_account_mcp_servers(accounts: Vec<McpSyncTarget>) -> Result<Vec<McpSyncResult>, String> {
    let source_path = default_config_path().ok_or_else(|| "no_home_dir".to_string())?;
    let source = read_json(&source_path)?;
    let servers = source
        .get("mcpServers")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    Ok(accounts
        .into_iter()
        .map(|account| match sync_one(&servers, Path::new(&account.config_dir)) {
            Ok(added) => McpSyncResult { id: account.id, added, error: None },
            Err(error) => McpSyncResult { id: account.id, added: Vec::new(), error: Some(error) },
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn source() -> Map<String, Value> {
        json!({ "obsidian": { "command": "uvx" }, "speak-ai": { "command": "npx" } })
            .as_object()
            .unwrap()
            .clone()
    }

    #[test]
    fn adds_missing_servers_and_keeps_existing_ones() {
        let mut target = json!({ "mcpServers": { "obsidian": { "command": "custom" } }, "userID": "x" });
        let added = merge_mcp_servers(&source(), &mut target).unwrap();
        assert_eq!(added, vec!["speak-ai".to_string()]);
        assert_eq!(target["mcpServers"]["obsidian"]["command"], "custom");
        assert_eq!(target["mcpServers"]["speak-ai"]["command"], "npx");
        assert_eq!(target["userID"], "x");
    }

    #[test]
    fn creates_mcp_servers_key_when_absent() {
        let mut target = json!({ "numStartups": 3 });
        let added = merge_mcp_servers(&source(), &mut target).unwrap();
        assert_eq!(added.len(), 2);
        assert!(target["mcpServers"].is_object());
    }

    #[test]
    fn rejects_non_object_config() {
        let mut target = json!([1, 2]);
        assert!(merge_mcp_servers(&source(), &mut target).is_err());
    }

    #[test]
    fn sync_one_writes_file_and_is_idempotent() {
        let dir = std::env::temp_dir().join(format!("alethe-mcp-sync-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(".claude.json"), r#"{"numStartups":1}"#).unwrap();
        assert_eq!(sync_one(&source(), &dir).unwrap().len(), 2);
        assert!(sync_one(&source(), &dir).unwrap().is_empty());
        let written = read_json(&dir.join(".claude.json")).unwrap();
        assert_eq!(written["numStartups"], 1);
        assert!(written["mcpServers"]["obsidian"].is_object());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn sync_one_skips_missing_dir() {
        let dir = std::env::temp_dir().join("alethe-mcp-sync-missing-xyz");
        assert_eq!(sync_one(&source(), &dir).unwrap_err(), "no_config_dir");
    }
}

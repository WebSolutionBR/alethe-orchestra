use portable_pty::CommandBuilder;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::SystemTime;

#[cfg(windows)]
use winreg::{enums::*, RegKey};

static REBUILT_PATH: OnceLock<String> = OnceLock::new();

pub fn default_shell() -> String {
    #[cfg(windows)]
    {
        if which::which("pwsh.exe").is_ok() {
            return "pwsh.exe".to_string();
        }
        "powershell.exe".to_string()
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "/bin/bash".to_string())
    }
}

pub fn command_builder_for_terminal(
    initial_command: Option<&str>,
    resolved_launcher: Option<&str>,
    extra_args: &[String],
) -> CommandBuilder {
    let trimmed = initial_command
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let mut builder = match trimmed {
        Some(command) => {
            let arg = resolved_launcher
                .map(|s| s.to_string())
                .unwrap_or_else(|| command.to_string());
            let shell = default_shell();

            #[cfg(windows)]
            {
                let host = if shell.eq_ignore_ascii_case("pwsh.exe") {
                    PsHost::Core
                } else {
                    PsHost::Desktop
                };
                let mut builder = CommandBuilder::new(&shell);
                builder.arg("-NoLogo");
                builder.arg("-NoProfile");
                builder.arg("-Command");
                builder.arg(powershell_launch_script(&arg, extra_args, host));
                builder
            }
            #[cfg(not(windows))]
            {
                // POSIX shell: exec the launcher + args, with escaped single quotes.
                let esc = |s: &str| s.replace('\'', "'\\''");
                let mut line = format!("exec '{}'", esc(&arg));
                for a in extra_args {
                    line.push_str(&format!(" '{}'", esc(a)));
                }
                let mut builder = CommandBuilder::new(&shell);
                builder.arg("-lc");
                builder.arg(line);
                builder
            }
        }
        None => {
            let shell = default_shell();
            let mut builder = CommandBuilder::new(&shell);
            if shell.eq_ignore_ascii_case("pwsh.exe")
                || shell.eq_ignore_ascii_case("powershell.exe")
            {
                builder.arg("-NoLogo");
            }
            builder
        }
    };

    if cfg!(windows) {
        let existing = builder
            .get_env("Path")
            .or_else(|| builder.get_env("PATH"))
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_default();
        let mut combined = existing;
        for extra in agent_search_dirs() {
            let extra = extra.to_string_lossy().to_string();
            if !combined
                .split(';')
                .any(|part| part.eq_ignore_ascii_case(&extra))
            {
                if !combined.is_empty() && !combined.ends_with(';') {
                    combined.push(';');
                }
                combined.push_str(&extra);
            }
        }
        builder.env("Path", combined);
    }
    builder.env("TERM", "xterm-256color");
    builder.env("COLORTERM", "truecolor");

    // terminal will render. Confirmed with an isolated test running the

    // — not DECRQSS/XTGETTCAP either, although it answers OSC 10/11/DSR/DA

    // known cause of "strange artifacts containing '66'" in terminals

    if trimmed == Some("opencode") {
        builder.env("OPENTUI_FORCE_EXPLICIT_WIDTH", "false");
    }
    scrub_editor_environment(&mut builder);
    builder.env_remove("EDITOR");
    builder.env_remove("VISUAL");
    builder.env_remove("CLAUDECODE");
    builder.env_remove("CLAUDE_CODE_ENTRYPOINT");
    builder.env_remove("CLAUDECODE_PARENT_PID");
    builder
}

/// The PowerShell that runs an agent launch script. Both rebuild the native command line with the
/// legacy algorithm (wrap a value in `"` when it has whitespace outside a `"` pair, escape nothing,
/// drop empty values) but differ in two details, so the escaping has to know which one runs.
/// Observed on 5.1; for 6+ see `NativeCommandParameterBinder` in the PowerShell repo.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PsHost {
    /// Windows PowerShell 5.1: every `"` counts when pairing, even `\"`, and a trailing backslash
    /// escapes the quote it adds.
    Desktop,
    /// PowerShell 6+ (`pwsh`): `\"` does not count, and trailing backslashes are doubled when it
    /// wraps.
    Core,
}

/// `-Command` script that runs `launcher` with `args` and exits with its code, escaped so the
/// child's argv is exactly `args`. Without the first statement pwsh 7.3+ would use its newer
/// argument passing for `.exe` files.
#[cfg_attr(not(windows), allow(dead_code))]
fn powershell_launch_script(launcher: &str, args: &[String], host: PsHost) -> String {
    let via_cmd = launcher_may_use_cmd(launcher);
    let mut script = format!(
        "$PSNativeCommandArgumentPassing = 'Legacy'; & {}",
        ps_single_quoted(launcher)
    );
    for arg in args {
        for value in escape_for_ps_native_legacy(arg, host, via_cmd) {
            script.push(' ');
            script.push_str(&ps_single_quoted(&value));
        }
    }
    script.push_str("; exit $LASTEXITCODE");
    script
}

/// `.cmd`/`.bat` launchers, and bare names PowerShell may resolve to one, run through cmd.exe.
fn launcher_may_use_cmd(launcher: &str) -> bool {
    let extension = Path::new(launcher)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase);
    !matches!(extension.as_deref(), Some("exe" | "com" | "ps1"))
}

/// PowerShell values that make the child, splitting its command line with the usual
/// CommandLineToArgvW / C runtime rules, read back exactly `arg` after PowerShell's legacy
/// native-argument passing. Usually one value; see `split_for_desktop` for the exception.
///
/// cmd.exe toggles its quoting on every `"` and ignores `\"`, so `&`, `|`, `<`, `>` between inner
/// quotes reach it unprotected. Fixing that needs another launch path, so with `via_cmd` cmd keeps
/// seeing the `"` where it did before: only backslashes are added, and arguments that would need
/// more are passed unchanged.
fn escape_for_ps_native_legacy(arg: &str, host: PsHost, via_cmd: bool) -> Vec<String> {
    // PowerShell drops empty values; `""` reaches the child as an empty argument.
    if arg.is_empty() {
        return vec!["\"\"".to_string()];
    }
    let escaped = escape_inner_quotes(arg);
    let values = match host {
        // pwsh wraps whenever there is whitespace (it skips `\"`) and doubles trailing backslashes.
        PsHost::Core if via_cmd && ps_wraps(&escaped, host) != ps_wraps(arg, host) => {
            vec![arg.to_string()]
        }
        PsHost::Core => vec![escaped],
        PsHost::Desktop if ps_wraps(&escaped, host) => vec![double_trailing_backslashes(&escaped)],
        // Not wrapped, which is fine while there is nothing to split on.
        PsHost::Desktop if !arg.contains([' ', '\t']) => vec![escaped],
        // Every space/tab sits inside a `"` pair as 5.1 counts them, so it will not wrap.
        PsHost::Desktop if !via_cmd => {
            split_for_desktop(&escaped).unwrap_or_else(|| vec![arg.to_string()])
        }
        PsHost::Desktop => vec![arg.to_string()],
    };
    // A value of exactly `--%` is taken as the stop-parsing marker: dropped, and the following
    // values passed raw with %VAR% expanded. Quoted, the child still reads `--%`.
    values
        .into_iter()
        .map(|value| {
            if value == "--%" {
                "\"--%\"".to_string()
            } else {
                value
            }
        })
        .collect()
}

/// 5.1 cannot wrap an argument whose spaces all sit inside `"` pairs, so build the fully quoted
/// form (`"…"`, which any argv parser reads back exactly) and pass its space-separated pieces as
/// separate values: none needs wrapping, and PowerShell joins them back with single spaces. `None`
/// when a piece would be empty (doubled spaces) or still wrapped (a tab or line break in it).
fn split_for_desktop(escaped: &str) -> Option<Vec<String>> {
    let quoted = format!("\"{}\"", double_trailing_backslashes(escaped));
    let pieces: Vec<String> = quoted.split(' ').map(str::to_string).collect();
    pieces
        .iter()
        .all(|piece| !piece.is_empty() && !ps_wraps(piece, PsHost::Desktop))
        .then_some(pieces)
}

/// Whether PowerShell wraps a native argument in `"`: when it has whitespace outside a `"` pair.
/// 5.1 counts every `"`; pwsh skips one right after a backslash. `char::is_whitespace` is the same
/// set as .NET's `char.IsWhiteSpace`.
fn ps_wraps(value: &str, host: PsHost) -> bool {
    let mut quotes = 0;
    let mut after_backslash = false;
    for c in value.chars() {
        if c == '"' && (host == PsHost::Desktop || !after_backslash) {
            quotes += 1;
        } else if c.is_whitespace() && quotes % 2 == 0 {
            return true;
        }
        after_backslash = c == '\\';
    }
    false
}

/// CommandLineToArgvW escaping of the `"` inside a value: n backslashes followed by `"` become 2n
/// backslashes and `\"`. Other backslashes are literal and stay as they are.
fn escape_inner_quotes(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 8);
    let mut backslashes = 0;
    for c in value.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                out.push_str(&"\\".repeat(backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.push_str(&"\\".repeat(backslashes));
                out.push(c);
                backslashes = 0;
            }
        }
    }
    out.push_str(&"\\".repeat(backslashes));
    out
}

/// Doubles the trailing backslashes so a `"` placed after them still closes the quote.
fn double_trailing_backslashes(value: &str) -> String {
    let trailing = value.len() - value.trim_end_matches('\\').len();
    format!("{value}{}", "\\".repeat(trailing))
}

/// PowerShell single-quoted literal. The typographic quotes ‘ ’ ‚ ‛ also end such a string, so they
/// are doubled like `'`.
fn ps_single_quoted(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('\'');
    for c in value.chars() {
        if matches!(c, '\'' | '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}') {
            out.push(c);
        }
        out.push(c);
    }
    out.push('\'');
    out
}

///

#[tauri::command]
pub async fn find_cli_launcher(agent: String) -> Option<String> {
    tokio::task::spawn_blocking(move || {
        find_windows_cli_launcher(&agent).map(|p| p.to_string_lossy().to_string())
    })
    .await
    .unwrap_or(None)
}

static LAUNCHER_CACHE: OnceLock<std::sync::Mutex<HashMap<String, PathBuf>>> = OnceLock::new();

/// Resolving a launcher walks every PATH entry and every agent directory looking for four
/// extensions, and it runs on every terminal boot. Only hits are cached, and a hit is dropped as
/// soon as its file is gone — so installing an agent is picked up at once and uninstalling it is
/// noticed on the next lookup, without the cache ever answering for something that is not there.
pub fn find_windows_cli_launcher(command: &str) -> Option<PathBuf> {
    let cache = LAUNCHER_CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()));

    if let Ok(map) = cache.lock() {
        if let Some(path) = map.get(command) {
            if path.is_file() {
                return Some(path.clone());
            }
        }
    }

    let resolved = resolve_cli_launcher(command)?;
    if let Ok(mut map) = cache.lock() {
        map.insert(command.to_string(), resolved.clone());
    }
    Some(resolved)
}

fn resolve_cli_launcher(command: &str) -> Option<PathBuf> {
    #[cfg(not(windows))]
    {
        if let Ok(path) = which::which(command) {
            return Some(path);
        }
        let mut dirs = Vec::<PathBuf>::new();
        if let Some(home) = env::var_os("HOME").map(PathBuf::from) {
            dirs.push(home.join(".local").join("bin"));
            dirs.push(home.join(".cargo").join("bin"));
        }
        // A .app launched from Finder/DMG does not run as a login shell: it
        // inherits the minimal Launch Services PATH (no .zshrc/.zprofile), so
        // CLIs installed with `brew install` are invisible to the `which` above
        // even though they are on disk. Cover the default Homebrew prefixes
        // (Apple Silicon and Intel) as a fixed fallback.
        dirs.extend(homebrew_dirs());
        for dir in dirs {
            let candidate = dir.join(command);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        return None;
    }

    #[cfg(windows)]
    {
        let mut dirs = Vec::<PathBuf>::new();
        dirs.extend(split_windows_path_expanded(&rebuilt_path()));
        dirs.extend(agent_search_dirs());

        // only `agy`. Never fall back to the desktop app for the CLI.
        let candidates_to_try = match command {
            "antigravity" | "agy" => vec!["agy"],
            other => vec![other],
        };

        for cmd_name in candidates_to_try {
            for dir in &dirs {
                for extension in ["cmd", "exe", "bat", "ps1"] {
                    let candidate = dir.join(format!("{cmd_name}.{extension}"));
                    if candidate.is_file() {
                        return Some(candidate);
                    }
                }
            }
        }
        None
    }
}

#[derive(serde::Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct InstallToolchain {
    pub node: Option<String>,
    pub npm: bool,
    pub winget: bool,
    pub scoop: bool,
    pub choco: bool,
    pub bun: bool,
    pub pnpm: bool,
}

fn node_version() -> Option<String> {
    let node = find_windows_cli_launcher("node")?;
    let output = std::process::Command::new(node)
        .arg("--version")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!version.is_empty()).then_some(version)
}

/// Extracts the first dotted version out of `--version` output. Agents are not consistent here:
/// some print a bare `1.2.3`, others `codex-cli 1.2.3 (abc1234)` or a banner line first.
fn parse_version(raw: &str) -> Option<String> {
    raw.split(|c: char| !(c.is_ascii_digit() || c == '.'))
        .find(|token| token.contains('.') && token.starts_with(|c: char| c.is_ascii_digit()))
        .map(|token| token.trim_end_matches('.').to_string())
}

/// Flags tried in order. The agents disagree on this, and none of them documents it, so the probe
/// asks rather than assumes. Output is read from stdout and stderr because some print to stderr.
const VERSION_FLAGS: [&str; 3] = ["--version", "-v", "version"];

/// Version the agent's CLI reports, or `None` when it is missing or answers nothing usable.
#[tauri::command]
pub async fn agent_cli_version(agent: String) -> Option<String> {
    tokio::task::spawn_blocking(move || {
        let bin = find_windows_cli_launcher(&agent)?;
        for flag in VERSION_FLAGS {
            let mut command = std::process::Command::new(&bin);
            command.arg(flag);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                command.creation_flags(CREATE_NO_WINDOW);
            }
            let Ok(output) = command.output() else {
                continue;
            };
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Some(version) = parse_version(&stdout) {
                return Some(version);
            }
            let stderr = String::from_utf8_lossy(&output.stderr);
            if let Some(version) = parse_version(&stderr) {
                return Some(version);
            }
        }
        None
    })
    .await
    .unwrap_or(None)
}

/// Reports which installers are usable on this machine so the UI can offer the
/// agent install methods that will actually work here.
#[tauri::command]
pub async fn probe_install_toolchain() -> InstallToolchain {
    tokio::task::spawn_blocking(|| {
        let has = |name: &str| find_windows_cli_launcher(name).is_some();
        InstallToolchain {
            node: node_version(),
            npm: has("npm"),
            winget: has("winget"),
            scoop: has("scoop"),
            choco: has("choco"),
            bun: has("bun"),
            pnpm: has("pnpm"),
        }
    })
    .await
    .unwrap_or_default()
}

/// Default Homebrew prefixes on macOS (Apple Silicon uses `/opt/homebrew`, Intel
/// uses `/usr/local`). Fixed fallback — it does not rely on the login shell having
/// run `brew shellenv` in the session of the process that launched the app.
#[cfg(not(windows))]
fn homebrew_dirs() -> Vec<PathBuf> {
    vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/opt/homebrew/sbin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/local/sbin"),
    ]
}

/// Looks for the VS Code launcher (`code`) in common locations plus PATH.
/// Returns the first one that exists.
pub fn find_vscode_launcher() -> Option<PathBuf> {
    #[cfg(not(windows))]
    {
        which::which("code").ok()
    }

    #[cfg(windows)]
    {
        let root_candidates = ["Code.exe", "Code - Insiders.exe"];
        let path_candidates = [
            "code.exe",
            "code-insiders.exe",
            "code.cmd",
            "code-insiders.cmd",
        ];
        let mut dirs: Vec<PathBuf> = Vec::new();
        if let Some(local) = env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            dirs.push(local.join("Programs").join("Microsoft VS Code").join("bin"));
            dirs.push(
                local
                    .join("Programs")
                    .join("Microsoft VS Code Insiders")
                    .join("bin"),
            );
        }
        if let Some(pf) = env::var_os("ProgramFiles").map(PathBuf::from) {
            dirs.push(pf.join("Microsoft VS Code").join("bin"));
            dirs.push(pf.join("Microsoft VS Code Insiders").join("bin"));
        }
        if let Some(pf86) = env::var_os("ProgramFiles(x86)").map(PathBuf::from) {
            dirs.push(pf86.join("Microsoft VS Code").join("bin"));
        }

        for app_dir in dirs.iter().filter_map(|dir| dir.parent()) {
            for name in root_candidates {
                let candidate = app_dir.join(name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }

        dirs.splice(0..0, split_windows_path_expanded(&rebuilt_path()));
        for dir in dirs {
            for name in path_candidates {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
        None
    }
}

pub fn agent_search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::<PathBuf>::new();
    if let Some(profile) = env::var_os("USERPROFILE").map(PathBuf::from) {
        dirs.push(profile.join("AppData").join("Roaming").join("npm"));
        dirs.push(profile.join(".local").join("bin"));
        dirs.push(profile.join(".cargo").join("bin"));
        dirs.push(profile.join(".bun").join("bin"));
        dirs.push(profile.join("scoop").join("shims"));
        dirs.push(
            profile
                .join("AppData")
                .join("Local")
                .join("agy")
                .join("bin"),
        );
        dirs.push(
            profile
                .join("AppData")
                .join("Local")
                .join("antigravity")
                .join("bin"),
        );
    }
    if let Some(app_data) = env::var_os("APPDATA").map(PathBuf::from) {
        dirs.push(app_data.join("npm"));
    }
    dirs.extend(volta_bin_dirs());
    dirs.extend(pnpm_bin_dirs());
    dirs.extend(fnm_version_dirs());
    if let Some(global) = env::var_os("SCOOP_GLOBAL").map(PathBuf::from) {
        dirs.push(global.join("shims"));
    } else {
        dirs.push(PathBuf::from(r"C:\ProgramData\scoop\shims"));
    }
    dirs.push(PathBuf::from(r"C:\ProgramData\chocolatey\bin"));
    dirs.extend(nvm_windows_version_dirs());
    dirs.push(PathBuf::from(r"C:\nvm4w\nodejs"));
    dirs.push(PathBuf::from(r"C:\Program Files\nodejs"));
    dirs.push(PathBuf::from(r"C:\Program Files (x86)\nodejs"));
    dirs
}

pub fn volta_bin_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(volta_home) = env::var_os("VOLTA_HOME").map(PathBuf::from) {
        dirs.push(volta_home.join("bin"));
    }
    if let Some(local) = env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        dirs.push(local.join("Volta").join("bin"));
    }
    dirs
}

pub fn pnpm_bin_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(pnpm_home) = env::var_os("PNPM_HOME").map(PathBuf::from) {
        dirs.push(pnpm_home);
    }
    if let Some(local) = env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        dirs.push(local.join("pnpm"));
    }
    dirs
}

pub fn fnm_version_dirs() -> Vec<PathBuf> {
    let fnm_root = env::var_os("FNM_DIR")
        .map(PathBuf::from)
        .or_else(|| env::var_os("LOCALAPPDATA").map(|p| PathBuf::from(p).join("fnm")));
    let Some(root) = fnm_root else {
        return Vec::new();
    };
    let versions_dir = root.join("node-versions");
    let Ok(entries) = fs::read_dir(&versions_dir) else {
        return Vec::new();
    };
    let mut versions: Vec<(PathBuf, SystemTime)> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_str()?.to_string();
            if !name.starts_with('v') {
                return None;
            }
            let install = path.join("installation");
            if !install.is_dir() {
                return None;
            }
            let modified = entry.metadata().and_then(|m| m.modified()).ok()?;
            Some((install, modified))
        })
        .collect();
    versions.sort_by(|a, b| b.1.cmp(&a.1));
    versions.into_iter().map(|(path, _)| path).collect()
}

pub fn nvm_windows_version_dirs() -> Vec<PathBuf> {
    let Some(nvm_home) = env::var_os("NVM_HOME").map(PathBuf::from) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(&nvm_home) else {
        return Vec::new();
    };
    let mut versions: Vec<(PathBuf, SystemTime)> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_str()?.to_string();
            if !name.starts_with('v') {
                return None;
            }
            let modified = entry.metadata().and_then(|m| m.modified()).ok()?;
            if !path.is_dir() {
                return None;
            }
            Some((path, modified))
        })
        .collect();
    versions.sort_by(|a, b| b.1.cmp(&a.1));
    versions.into_iter().map(|(path, _)| path).collect()
}

fn scrub_editor_environment(builder: &mut CommandBuilder) {
    for key in [
        "TERM_PROGRAM",
        "TERM_PROGRAM_VERSION",
        "VSCODE_CWD",
        "VSCODE_IPC_HOOK",
        "VSCODE_IPC_HOOK_CLI",
        "VSCODE_GIT_ASKPASS_NODE",
        "VSCODE_GIT_ASKPASS_EXTRA_ARGS",
        "VSCODE_GIT_ASKPASS_MAIN",
        "VSCODE_GIT_IPC_HANDLE",
        "GIT_ASKPASS",
        "ELECTRON_RUN_AS_NODE",
    ] {
        builder.env_remove(key);
    }
}

pub fn rebuilt_path() -> String {
    REBUILT_PATH.get_or_init(build_rebuilt_path).clone()
}

pub(crate) fn build_rebuilt_path() -> String {
    if !cfg!(windows) {
        let mut paths: Vec<PathBuf> = env::var_os("PATH")
            .map(|value| env::split_paths(&value).collect())
            .unwrap_or_default();
        #[cfg(not(windows))]
        paths.extend(homebrew_dirs());
        return dedupe_paths(paths)
            .into_iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect::<Vec<_>>()
            .join(":");
    }

    let mut paths = Vec::<PathBuf>::new();

    #[cfg(windows)]
    {
        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        if let Ok(env_key) =
            hklm.open_subkey("SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment")
        {
            if let Ok(path) = env_key.get_value::<String, _>("Path") {
                paths.extend(split_windows_path_expanded(&path));
            }
        }

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if let Ok(env_key) = hkcu.open_subkey("Environment") {
            if let Ok(path) = env_key.get_value::<String, _>("Path") {
                paths.extend(split_windows_path_expanded(&path));
            }
        }
    }

    if let Some(current_path) = env::var_os("PATH") {
        paths.extend(env::split_paths(&current_path));
    }

    if let Some(user_profile) = env::var_os("USERPROFILE").map(PathBuf::from) {
        paths.push(user_profile.join("AppData").join("Roaming").join("npm"));
        paths.push(user_profile.join(".local").join("bin"));
        paths.push(user_profile.join(".cargo").join("bin"));
        paths.push(user_profile.join(".bun").join("bin"));
    }

    if let Some(app_data) = env::var_os("APPDATA").map(PathBuf::from) {
        paths.push(app_data.join("npm"));
    }

    paths.push(PathBuf::from(r"C:\nvm4w\nodejs"));
    paths.push(PathBuf::from(r"C:\Program Files\nodejs"));
    paths.push(PathBuf::from(r"C:\Program Files (x86)\nodejs"));

    dedupe_paths(paths)
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join(";")
}

#[allow(dead_code)]
fn split_windows_path_expanded(path: &str) -> Vec<PathBuf> {
    path.split(';')
        .filter_map(|item| {
            let item = expand_windows_env_vars(item.trim());
            if item.is_empty() {
                None
            } else {
                Some(PathBuf::from(item))
            }
        })
        .collect()
}

#[allow(dead_code)]
fn expand_windows_env_vars(input: &str) -> String {
    let mut output = input.to_string();
    for (key, value) in env::vars() {
        output = output.replace(&format!("%{key}%"), &value);
        output = output.replace(&format!("%{}%", key.to_ascii_uppercase()), &value);
    }
    output
}

fn dedupe_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut result = Vec::<PathBuf>::new();

    for path in paths {
        let path_string = path.to_string_lossy().to_string();
        if path_string.trim().is_empty() {
            continue;
        }
        if result.iter().any(|existing| {
            existing
                .to_string_lossy()
                .eq_ignore_ascii_case(&path_string)
        }) {
            continue;
        }
        result.push(path);
    }

    result
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct ModelOption {
    pub id: String,
    pub label: String,
}

fn is_valid_model_id(id: &str) -> bool {
    let id_lower = id.to_lowercase();
    if id.is_empty()
        || id.starts_with('-')
        || id.starts_with('#')
        || id_lower.starts_with("usage")
        || id_lower.starts_with("could")
        || id_lower.starts_with("error")
        || id_lower.starts_with("failed")
        || id_lower.starts_with("let")
        || id_lower.starts_with("flags")
        || id_lower.starts_with("available")
        || id.contains(' ')
        || id.len() < 3
    {
        return false;
    }
    true
}

fn discover_provider_models_inner(provider: String) -> Result<Vec<ModelOption>, String> {
    let mut models = Vec::new();
    let provider_lower = provider.to_lowercase();

    let cmd_name = match provider_lower.as_str() {
        "antigravity" | "agy" => "agy",
        other => other,
    };

    let bin_path = find_windows_cli_launcher(cmd_name)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| cmd_name.to_string());

    match provider_lower.as_str() {
        "antigravity" | "agy" => {
            if let Ok(output) = std::process::Command::new(&bin_path).arg("models").output() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    let trimmed = line.trim();
                    let id = trimmed
                        .split_whitespace()
                        .next()
                        .unwrap_or(trimmed)
                        .to_string();
                    if is_valid_model_id(&id) {
                        models.push(ModelOption {
                            label: format!("{id} (Antigravity agy)"),
                            id,
                        });
                    }
                }
            }
            if models.is_empty() {
                models.push(ModelOption {
                    id: "gemini-2.5-pro".into(),
                    label: "Gemini 2.5 Pro (Google DeepMind)".into(),
                });
                models.push(ModelOption {
                    id: "gemini-2.5-flash".into(),
                    label: "Gemini 2.5 Flash (Google DeepMind)".into(),
                });
                models.push(ModelOption {
                    id: "claude-3.7-sonnet".into(),
                    label: "Claude 3.7 Sonnet (Anthropic)".into(),
                });
                models.push(ModelOption {
                    id: "deepseek-r1".into(),
                    label: "DeepSeek R1 (Reasoning)".into(),
                });
            }
        }
        "opencode" => {
            if let Ok(output) = std::process::Command::new(&bin_path).arg("models").output() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    let trimmed = line.trim();
                    let id = trimmed
                        .split_whitespace()
                        .next()
                        .unwrap_or(trimmed)
                        .to_string();
                    if is_valid_model_id(&id) {
                        models.push(ModelOption {
                            label: format!("{id} (OpenCode CLI)"),
                            id,
                        });
                    }
                }
            }
        }
        "claude" => {
            if let Ok(output) = std::process::Command::new(&bin_path).arg("models").output() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    let trimmed = line.trim();
                    let id = trimmed
                        .split_whitespace()
                        .next()
                        .unwrap_or(trimmed)
                        .to_string();
                    if is_valid_model_id(&id) {
                        models.push(ModelOption {
                            label: format!("{id} (Claude CLI)"),
                            id,
                        });
                    }
                }
            }
            if models.is_empty() {
                models.push(ModelOption {
                    id: "claude-3-7-sonnet".into(),
                    label: "Claude 3.7 Sonnet (Anthropic)".into(),
                });
                models.push(ModelOption {
                    id: "claude-3-5-sonnet".into(),
                    label: "Claude 3.5 Sonnet (Anthropic)".into(),
                });
                models.push(ModelOption {
                    id: "claude-3-5-haiku".into(),
                    label: "Claude 3.5 Haiku (Anthropic)".into(),
                });
                models.push(ModelOption {
                    id: "claude-3-opus".into(),
                    label: "Claude 3 Opus (Anthropic)".into(),
                });
            }
        }
        "codex" => {
            if let Ok(output) = std::process::Command::new(&bin_path).arg("models").output() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    let trimmed = line.trim();
                    let id = trimmed
                        .split_whitespace()
                        .next()
                        .unwrap_or(trimmed)
                        .to_string();
                    if is_valid_model_id(&id) {
                        models.push(ModelOption {
                            label: format!("{id} (Codex CLI)"),
                            id,
                        });
                    }
                }
            }
            if models.is_empty() {
                models.push(ModelOption {
                    id: "gpt-4o".into(),
                    label: "GPT-4o (OpenAI)".into(),
                });
                models.push(ModelOption {
                    id: "o3-mini".into(),
                    label: "o3-mini (Raciocínio OpenAI)".into(),
                });
                models.push(ModelOption {
                    id: "o1".into(),
                    label: "o1 (OpenAI)".into(),
                });
                models.push(ModelOption {
                    id: "gpt-4o-mini".into(),
                    label: "GPT-4o mini (OpenAI)".into(),
                });
            }
        }
        "mimo" => {
            if let Ok(output) = std::process::Command::new(&bin_path).arg("models").output() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    let trimmed = line.trim();
                    let id = trimmed
                        .split_whitespace()
                        .next()
                        .unwrap_or(trimmed)
                        .to_string();
                    if is_valid_model_id(&id) {
                        models.push(ModelOption {
                            label: format!("{id} (Mimo CLI)"),
                            id,
                        });
                    }
                }
            }
            if models.is_empty() {
                models.push(ModelOption {
                    id: "mimo-v1-pro".into(),
                    label: "Mimo V1 Pro (Xiaomi AI)".into(),
                });
                models.push(ModelOption {
                    id: "mimo-v1-flash".into(),
                    label: "Mimo V1 Flash (Xiaomi AI)".into(),
                });
            }
        }
        "freebuff" => {
            if let Ok(output) = std::process::Command::new(&bin_path).arg("models").output() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    let trimmed = line.trim();
                    let id = trimmed
                        .split_whitespace()
                        .next()
                        .unwrap_or(trimmed)
                        .to_string();
                    if is_valid_model_id(&id) {
                        models.push(ModelOption {
                            label: format!("{id} (Freebuff CLI)"),
                            id,
                        });
                    }
                }
            }
            if models.is_empty() {
                models.push(ModelOption {
                    id: "freebuff-auto".into(),
                    label: "Freebuff Auto-Router".into(),
                });
                models.push(ModelOption {
                    id: "freebuff-fast".into(),
                    label: "Freebuff Fast".into(),
                });
            }
        }
        _ => {}
    }

    Ok(models)
}

/// `discover_provider_models_inner` runs `std::process::Command::output()`

/// `find_cli_launcher` above.
#[tauri::command]
pub async fn discover_provider_models(provider: String) -> Result<Vec<ModelOption>, String> {
    tokio::task::spawn_blocking(move || discover_provider_models_inner(provider))
        .await
        .map_err(|error| format!("discover_provider_models: falha na task bloqueante: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn accepts_model_ids_and_rejects_cli_prose() {
        for id in ["claude-sonnet-4-5", "gpt-5", "o3-mini", "model-error-free"] {
            assert!(is_valid_model_id(id), "expected valid model id: {id}");
        }

        for id in [
            "",
            "ab",
            "--help",
            "# comment",
            "gpt 5",
            "usage: claude [options]",
            "Usage: claude [options]",
            "could not find model",
            "ERROR: invalid model",
            "failed to list models",
            "let me explain",
            "flags: --json",
            "available models:",
        ] {
            assert!(!is_valid_model_id(id), "expected invalid model id: {id}");
        }
    }

    #[test]
    fn dedupe_paths_drops_empty_values_and_keeps_first_spelling() {
        let paths = dedupe_paths(vec![
            PathBuf::from("  "),
            PathBuf::from(r"C:\Bin"),
            PathBuf::from(r"c:\bin"),
            PathBuf::from(r"D:\Tools"),
            PathBuf::from(""),
        ]);

        assert_eq!(
            paths,
            vec![PathBuf::from(r"C:\Bin"), PathBuf::from(r"D:\Tools")]
        );
    }

    #[cfg(windows)]
    #[test]
    fn expands_windows_environment_variables_case_insensitively() {
        std::env::set_var("alethe_test_path", r"C:\Tools");

        assert_eq!(
            expand_windows_env_vars(r"%ALETHE_TEST_PATH%\bin;%alethe_test_path%"),
            r"C:\Tools\bin;C:\Tools"
        );
        assert_eq!(expand_windows_env_vars(r"%NOPE%"), r"%NOPE%");

        std::env::remove_var("alethe_test_path");
    }

    #[cfg(windows)]
    #[test]
    fn splits_expanded_windows_paths_and_drops_empty_segments() {
        assert_eq!(
            split_windows_path_expanded(r"a;; b ;"),
            vec![PathBuf::from("a"), PathBuf::from("b")]
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn resolves_cli_launcher_on_unix() {
        assert!(find_windows_cli_launcher("sh").is_some());
        assert!(find_windows_cli_launcher("non_existent_binary_xyz_123").is_none());
    }

    #[test]
    fn plain_arguments_keep_the_previous_launch_script() {
        let args: Vec<String> = [
            "--resume",
            "0f8fad5b-d9cb-469f-a165-70867728950e",
            "--model",
            "opus",
            r"C:\Program Files\agent\settings.json",
            "fix the login bug",
            "it's <done> | a & b",
            "ação 日本語",
        ]
        .map(String::from)
        .to_vec();
        for launcher in [r"C:\Users\me\.local\bin\claude.exe", r"C:\npm\codex.cmd"] {
            let previous: String = args
                .iter()
                .map(|arg| format!(" '{}'", arg.replace('\'', "''")))
                .collect();
            let previous = format!("& '{launcher}'{previous}; exit $LASTEXITCODE");
            for host in [PsHost::Desktop, PsHost::Core] {
                assert_eq!(
                    powershell_launch_script(launcher, &args, host),
                    format!("$PSNativeCommandArgumentPassing = 'Legacy'; {previous}")
                );
            }
        }
    }

    #[test]
    fn escapes_arguments_for_each_powershell() {
        use PsHost::{Core, Desktop};
        let cases: &[(&str, PsHost, &[&str])] = &[
            ("plain", Desktop, &["plain"]),
            ("two words", Core, &["two words"]),
            (r#"say "hi" now"#, Desktop, &[r#"say \"hi\" now"#]),
            (r#"say "hi" now"#, Core, &[r#"say \"hi\" now"#]),
            (r#"a\"b"#, Desktop, &[r#"a\\\"b"#]),
            (r#"a\\"b c"#, Core, &[r#"a\\\\\"b c"#]),
            (r"C:\dir\", Desktop, &[r"C:\dir\"]),
            (r"C:\my dir\", Desktop, &[r"C:\my dir\\"]),
            (r"C:\my dir\", Core, &[r"C:\my dir\"]),
            ("", Desktop, &[r#""""#]),
            ("", Core, &[r#""""#]),
            ("ação ü 日本語 🎉", Desktop, &["ação ü 日本語 🎉"]),
            ("it's ’ok’", Desktop, &["it's ’ok’"]),
            ("<a> | b & c > d", Desktop, &["<a> | b & c > d"]),
            ("--%", Desktop, &[r#""--%""#]),
            ("--%", Core, &[r#""--%""#]),
            // 5.1 counts the escaped quotes, so it would not wrap: passed as space-free pieces.
            (r#""hi there""#, Desktop, &[r#""\"hi"#, r#"there\"""#]),
            (
                r#"x="a --% b""#,
                Desktop,
                &[r#""x=\"a"#, r#""--%""#, r#"b\"""#],
            ),
            (r#""hi there""#, Core, &[r#"\"hi there\""#]),
            // Shapes 5.1 cannot carry intact are passed unchanged, as before.
            ("\"a\tb\"", Desktop, &["\"a\tb\""]),
            ("\"a  b\"", Desktop, &["\"a  b\""]),
        ];
        for &(arg, host, expected) in cases {
            assert_eq!(
                escape_for_ps_native_legacy(arg, host, false),
                expected,
                "{host:?} {arg:?}"
            );
        }
    }

    #[test]
    fn cmd_launchers_only_gain_backslashes() {
        use PsHost::{Core, Desktop};
        let quoted = r#""hi there""#;
        assert_eq!(
            escape_for_ps_native_legacy(r#"say "hi" now"#, Desktop, true),
            [r#"say \"hi\" now"#]
        );
        assert_eq!(escape_for_ps_native_legacy(quoted, Desktop, true), [quoted]);
        assert_eq!(escape_for_ps_native_legacy(quoted, Core, true), [quoted]);

        assert!(launcher_may_use_cmd(r"C:\npm\claude.cmd"));
        assert!(launcher_may_use_cmd(r"C:\tools\agent.BAT"));
        assert!(launcher_may_use_cmd("claude"));
        assert!(!launcher_may_use_cmd(r"C:\Users\me\.local\bin\claude.exe"));
        assert!(!launcher_may_use_cmd(r"C:\npm\claude.ps1"));
    }

    #[test]
    fn single_quotes_every_powershell_quote_character() {
        assert_eq!(ps_single_quoted("plain"), "'plain'");
        assert_eq!(ps_single_quoted("it's ‘a’ ‚b‛"), "'it''s ‘‘a’’ ‚‚b‛‛'");
        assert_eq!(
            ps_single_quoted(r#"say "hi" $env:PATH"#),
            r#"'say "hi" $env:PATH'"#
        );
    }

    /// Independent model of PowerShell's legacy native-argument passing: drop empty values, wrap in
    /// `"` when there is whitespace outside a `"` pair (pwsh skips `\"` and doubles the trailing
    /// backslashes), join with single spaces.
    fn ps_command_line(values: &[String], host: PsHost) -> String {
        let mut parts = Vec::new();
        for value in values.iter().filter(|value| !value.is_empty()) {
            assert_ne!(
                value, "--%",
                "PowerShell would swallow the stop-parsing marker"
            );
            let (mut quotes, mut previous, mut wrap) = (0, '\0', false);
            for c in value.chars() {
                if c == '"' && !(host == PsHost::Core && previous == '\\') {
                    quotes += 1;
                } else if c.is_whitespace() && quotes % 2 == 0 {
                    wrap = true;
                }
                previous = c;
            }
            let trailing = value.len() - value.trim_end_matches('\\').len();
            parts.push(match (wrap, host) {
                (false, _) => value.clone(),
                (true, PsHost::Desktop) => format!("\"{value}\""),
                (true, PsHost::Core) => format!("\"{value}{}\"", "\\".repeat(trailing)),
            });
        }
        parts.join(" ")
    }

    /// Splits a command line tail into argv with the C runtime rules. `pre_2008` reads `""` inside
    /// quotes as a quote that also closes them (CommandLineToArgvW, Go); later runtimes stay quoted.
    fn argv(line: &str, pre_2008: bool) -> Vec<String> {
        let chars: Vec<char> = line.chars().collect();
        let (mut args, mut i) = (Vec::new(), 0);
        while i < chars.len() {
            if chars[i] == ' ' || chars[i] == '\t' {
                i += 1;
                continue;
            }
            let (mut arg, mut quoted) = (String::new(), false);
            while i < chars.len() && (quoted || (chars[i] != ' ' && chars[i] != '\t')) {
                let slashes = chars[i..].iter().take_while(|&&c| c == '\\').count();
                if slashes > 0 {
                    i += slashes;
                    let before_quote = chars.get(i) == Some(&'"');
                    arg.push_str(&"\\".repeat(if before_quote { slashes / 2 } else { slashes }));
                    if before_quote && slashes % 2 == 1 {
                        arg.push('"');
                        i += 1;
                    }
                } else if chars[i] == '"' {
                    if quoted && chars.get(i + 1) == Some(&'"') {
                        arg.push('"');
                        quoted = !pre_2008;
                        i += 2;
                    } else {
                        quoted = !quoted;
                        i += 1;
                    }
                } else {
                    arg.push(chars[i]);
                    i += 1;
                }
            }
            args.push(arg);
        }
        args
    }

    #[test]
    fn short_arguments_survive_both_powershells() {
        let alphabet = ['a', ' ', '\t', '\n', '"', '\\'];
        let mut args = vec![String::new()];
        let mut longest = vec![String::new()];
        for _ in 0..6 {
            longest = longest
                .iter()
                .flat_map(|prefix| alphabet.iter().map(move |c| format!("{prefix}{c}")))
                .collect();
            args.extend(longest.iter().cloned());
        }
        for host in [PsHost::Desktop, PsHost::Core] {
            for arg in &args {
                let exact = vec![arg.clone()];
                let intact = |values: &[String]| {
                    let line = ps_command_line(values, host);
                    argv(&line, false) == exact && argv(&line, true) == exact
                };

                let values = escape_for_ps_native_legacy(arg, host, false);
                // The only shapes 5.1 cannot carry, kept unchanged as before.
                let known_gap = host == PsHost::Desktop
                    && values == exact
                    && (arg.contains("  ") || arg.contains(['\t', '\n']));
                assert!(
                    intact(&values) || known_gap,
                    "{host:?} {arg:?} -> {values:?}"
                );

                // Through cmd.exe: the same `"` as before, and intact whenever anything changed.
                if !arg.is_empty() {
                    let values = escape_for_ps_native_legacy(arg, host, true);
                    assert_eq!(
                        ps_command_line(&values, host).replace('\\', ""),
                        ps_command_line(&exact, host).replace('\\', ""),
                        "{host:?} {arg:?}"
                    );
                    assert!(values == exact || intact(&values), "{host:?} {arg:?}");
                }
            }
        }
    }

    /// Prints argv as ASCII-only JSON, so no console code page can alter it on the way back.
    #[cfg(windows)]
    const ECHO_ARGV_JS: &str = r#"process.stdout.write(JSON.stringify(process.argv.slice(2)).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')));"#;

    /// Temp directory removed on drop, even when the test fails.
    #[cfg(windows)]
    struct TempDir(PathBuf);

    #[cfg(windows)]
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// Runs real launch scripts through PowerShell against a node script that echoes its argv.
    #[cfg(windows)]
    #[test]
    fn powershell_delivers_launch_arguments_intact() {
        let Ok(node) = which::which("node.exe") else {
            eprintln!("skipped: node.exe not found");
            return;
        };
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = TempDir(
            std::env::temp_dir().join(format!("alethe-ps-quoting-{}-{nanos}", std::process::id())),
        );
        fs::create_dir_all(&dir.0).unwrap();
        let echo = dir.0.join("echo.js");
        fs::write(&echo, ECHO_ARGV_JS).unwrap();

        let args: Vec<String> = [
            "plain",
            "two words",
            r#"say "hi" now"#,
            r#""a fully quoted sentence""#,
            r#"--message="hello world""#,
            r#"x="a --% b""#,
            r#"back\"slash and \\"two" x"#,
            r"C:\dir\",
            r"C:\my dir\",
            "",
            "ação, ü, 日本語 and 🎉",
            "it's ‘curly’ and ’odd‚ ‛quotes",
            "--%",
            "<0-100> | a & b > c ^ %PATH% !x!",
            "cost $5 $(Get-Date) `n @(1)",
            "line one\n\tline two",
            "You are claude-6, a worker inside Alethe Orchestra focused on \"pty-quoting\". Report \
             progress often with \"orch.cmd report <0-100> <thinking|editing|testing|blocked|done> \
             <short note>\" (full path \"C:/x/orch.cmd\"): at start, at each milestone, and finish \
             with \"orch.cmd report 100 done <one-line summary>\".",
        ]
        .map(String::from)
        .to_vec();
        let mut launch_args = vec![echo.to_string_lossy().to_string()];
        launch_args.extend(args.iter().cloned());

        let mut ran = false;
        for (shell, host) in [
            ("powershell.exe", PsHost::Desktop),
            ("pwsh.exe", PsHost::Core),
        ] {
            if which::which(shell).is_err() {
                continue;
            }
            ran = true;
            let script = powershell_launch_script(&node.to_string_lossy(), &launch_args, host);
            let output = std::process::Command::new(shell)
                .args(["-NoLogo", "-NoProfile", "-Command", &script])
                .output()
                .expect("PowerShell runs");
            let received: Vec<String> =
                serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
                    panic!(
                        "{shell}: {error}\nstdout: {}\nstderr: {}",
                        String::from_utf8_lossy(&output.stdout),
                        String::from_utf8_lossy(&output.stderr)
                    )
                });
            assert_eq!(received, args, "{shell}");
        }
        assert!(ran, "no PowerShell on PATH");
    }
}

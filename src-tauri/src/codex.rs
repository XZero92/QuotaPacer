use crate::pace::PaceService;
use crate::settings::SettingsStore;
use crate::usage::{normalize_rate_limits, ConnectionState, UsageViewState};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::env;
use std::io::{BufRead, BufReader, Write};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

const RECOMMENDED_VERSION: (u64, u64, u64) = (0, 144, 6);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const POLL_INTERVAL: Duration = Duration::from_secs(60);
const EVENT_REFRESH_DELAY: Duration = Duration::from_millis(500);
const RETRY_DELAYS: [Duration; 6] = [
    Duration::from_secs(1),
    Duration::from_secs(2),
    Duration::from_secs(5),
    Duration::from_secs(10),
    Duration::from_secs(30),
    Duration::from_secs(60),
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliInfo {
    pub path: String,
    pub version: String,
    pub meets_recommended_version: bool,
    pub app_server_supported: bool,
}

#[derive(Clone)]
pub struct UsageService {
    state: Arc<Mutex<UsageViewState>>,
    commands: Sender<ServiceCommand>,
}

enum ServiceCommand {
    Refresh,
    ExecutableChanged,
    Shutdown,
}

impl UsageService {
    pub fn start(app: AppHandle, settings: SettingsStore, pace: PaceService) -> Self {
        let state = Arc::new(Mutex::new(UsageViewState::initial()));
        let (commands, receiver) = mpsc::channel();
        let thread_state = state.clone();
        thread::Builder::new()
            .name("codex-usage-service".to_string())
            .spawn(move || service_loop(app, settings, pace, thread_state, receiver))
            .expect("failed to start Codex usage service");
        Self { state, commands }
    }

    pub fn state(&self) -> UsageViewState {
        self.state
            .lock()
            .map(|state| state.clone())
            .unwrap_or_else(|_| {
                UsageViewState::failure_from(
                    &UsageViewState::initial(),
                    ConnectionState::Error,
                    "사용량 상태를 읽을 수 없습니다.",
                )
            })
    }

    pub fn refresh(&self) {
        let _ = self.commands.send(ServiceCommand::Refresh);
    }

    pub fn executable_changed(&self) {
        let _ = self.commands.send(ServiceCommand::ExecutableChanged);
    }

    pub fn shutdown(&self) {
        let _ = self.commands.send(ServiceCommand::Shutdown);
    }
}

pub fn inspect_cli(path: Option<PathBuf>) -> Result<CliInfo, String> {
    let executable = resolve_codex_executable(path)?;
    validate_cli(&executable)
}

fn service_loop(
    app: AppHandle,
    settings: SettingsStore,
    pace: PaceService,
    shared_state: Arc<Mutex<UsageViewState>>,
    commands: Receiver<ServiceCommand>,
) {
    let mut client: Option<RpcProcess> = None;
    let mut next_action = Instant::now();
    let mut retry_index = 0usize;

    loop {
        if let Some(rpc) = client.as_mut() {
            while let Ok(notification) = rpc.notifications.try_recv() {
                match notification
                    .get("method")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                {
                    "account/rateLimits/updated" => {
                        next_action = Instant::now() + EVENT_REFRESH_DELAY;
                    }
                    "account/updated" => {
                        next_action = Instant::now();
                    }
                    "_process/exited" => {
                        mark_failure(
                            &app,
                            &shared_state,
                            ConnectionState::Error,
                            "Codex app-server가 종료되었습니다.",
                        );
                        client = None;
                        next_action = Instant::now() + retry_delay(&mut retry_index);
                        break;
                    }
                    _ => {}
                }
            }
        }

        if Instant::now() >= next_action {
            if let Some(rpc) = client.as_mut() {
                match fetch_rate_limits(rpc) {
                    Ok(new_state) => {
                        publish_state(&app, &shared_state, &pace, new_state);
                        retry_index = 0;
                        next_action = Instant::now() + POLL_INTERVAL;
                    }
                    Err(failure) => {
                        mark_failure(&app, &shared_state, failure.connection, failure.message);
                        client = None;
                        next_action = Instant::now() + retry_delay(&mut retry_index);
                    }
                }
            } else {
                publish_connection(&app, &shared_state, ConnectionState::Starting, None);
                match connect(settings.codex_executable()) {
                    Ok((rpc, new_state)) => {
                        client = Some(rpc);
                        publish_state(&app, &shared_state, &pace, new_state);
                        retry_index = 0;
                        next_action = Instant::now() + POLL_INTERVAL;
                    }
                    Err(failure) => {
                        mark_failure(&app, &shared_state, failure.connection, failure.message);
                        next_action = Instant::now() + retry_delay(&mut retry_index);
                    }
                }
            }
        }

        let wait = next_action
            .saturating_duration_since(Instant::now())
            .min(Duration::from_millis(200));
        match commands.recv_timeout(wait) {
            Ok(ServiceCommand::Refresh) => next_action = Instant::now(),
            Ok(ServiceCommand::ExecutableChanged) => {
                client = None;
                retry_index = 0;
                next_action = Instant::now();
            }
            Ok(ServiceCommand::Shutdown) => break,
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

fn connect(explicit_path: Option<PathBuf>) -> Result<(RpcProcess, UsageViewState), ServiceFailure> {
    let executable = resolve_codex_executable(explicit_path).map_err(|message| ServiceFailure {
        connection: ConnectionState::CliMissing,
        message,
    })?;
    let cli = validate_cli(&executable).map_err(|message| ServiceFailure {
        connection: ConnectionState::CliUnsupported,
        message,
    })?;
    if !cli.app_server_supported {
        return Err(ServiceFailure {
            connection: ConnectionState::CliUnsupported,
            message: "설치된 Codex CLI가 app-server를 지원하지 않습니다.".to_string(),
        });
    }

    let mut rpc = RpcProcess::spawn(&executable).map_err(|message| ServiceFailure {
        connection: ConnectionState::Error,
        message,
    })?;
    if !cli.meets_recommended_version {
        rpc.compatibility_warning = Some(format!(
            "Codex CLI 0.144.6 이상을 권장합니다. 현재 버전: {}",
            cli.version
        ));
    }

    rpc.request(
        "initialize",
        Some(json!({
            "clientInfo": {
                "name": "quota_pacer",
                "title": "QuotaPacer",
                "version": env!("CARGO_PKG_VERSION")
            }
        })),
    )
    .map_err(ServiceFailure::rpc)?;
    rpc.notify("initialized", Some(json!({})))
        .map_err(ServiceFailure::rpc)?;

    let account = rpc
        .request("account/read", Some(json!({ "refreshToken": false })))
        .map_err(ServiceFailure::rpc)?;
    validate_account(&account)?;

    let state = fetch_rate_limits(&mut rpc)?;
    Ok((rpc, state))
}

fn validate_account(value: &Value) -> Result<(), ServiceFailure> {
    let account_type = value.pointer("/account/type").and_then(Value::as_str);
    match account_type {
        Some("chatgpt" | "chatgptAuthTokens" | "agentIdentity" | "personalAccessToken") => Ok(()),
        Some("apiKey" | "amazonBedrock") => Err(ServiceFailure {
            connection: ConnectionState::UnsupportedAuth,
            message: "ChatGPT 계정으로 로그인한 Codex CLI가 필요합니다.".to_string(),
        }),
        Some(_) => Err(ServiceFailure {
            connection: ConnectionState::UnsupportedAuth,
            message: "현재 Codex 인증 방식에서는 계정 사용량을 조회할 수 없습니다.".to_string(),
        }),
        None => Err(ServiceFailure {
            connection: ConnectionState::LoginRequired,
            message: "터미널에서 `codex login`을 실행해 주세요.".to_string(),
        }),
    }
}

fn fetch_rate_limits(rpc: &mut RpcProcess) -> Result<UsageViewState, ServiceFailure> {
    let response = rpc
        .request("account/rateLimits/read", None)
        .map_err(ServiceFailure::rpc)?;
    let windows = normalize_rate_limits(response).map_err(|message| ServiceFailure {
        connection: ConnectionState::Error,
        message,
    })?;
    let mut state = UsageViewState::successful(windows);
    state.error_message.clone_from(&rpc.compatibility_warning);
    Ok(state)
}

struct ServiceFailure {
    connection: ConnectionState,
    message: String,
}

impl ServiceFailure {
    fn rpc(message: String) -> Self {
        Self {
            connection: ConnectionState::Error,
            message,
        }
    }
}

fn retry_delay(index: &mut usize) -> Duration {
    let delay = RETRY_DELAYS[(*index).min(RETRY_DELAYS.len() - 1)];
    *index = (*index + 1).min(RETRY_DELAYS.len() - 1);
    delay
}

fn publish_connection(
    app: &AppHandle,
    shared_state: &Arc<Mutex<UsageViewState>>,
    connection: ConnectionState,
    message: Option<String>,
) {
    if let Ok(mut state) = shared_state.lock() {
        state.connection = connection;
        state.error_message = message;
        let snapshot = state.clone();
        drop(state);
        let _ = app.emit("usage://state-changed", snapshot);
    }
}

fn publish_state(
    app: &AppHandle,
    shared_state: &Arc<Mutex<UsageViewState>>,
    pace: &PaceService,
    new_state: UsageViewState,
) {
    pace.process(&new_state);
    if let Ok(mut state) = shared_state.lock() {
        *state = new_state;
        let snapshot = state.clone();
        drop(state);
        let _ = app.emit("usage://state-changed", snapshot);
    }
}

fn mark_failure(
    app: &AppHandle,
    shared_state: &Arc<Mutex<UsageViewState>>,
    connection: ConnectionState,
    message: impl Into<String>,
) {
    if let Ok(mut state) = shared_state.lock() {
        *state = UsageViewState::failure_from(&state, connection, message);
        let snapshot = state.clone();
        drop(state);
        let _ = app.emit("usage://state-changed", snapshot);
    }
}

fn resolve_codex_executable(explicit_path: Option<PathBuf>) -> Result<PathBuf, String> {
    if let Some(path) = explicit_path {
        return validate_candidate(path);
    }
    if let Some(path) = env::var_os("CODEX_CLI_PATH").map(PathBuf::from) {
        return validate_candidate(path);
    }

    if let Ok(paths) = which::which_all("codex") {
        let mut candidates = paths.collect::<Vec<_>>();
        candidates.sort_by_key(|path| executable_rank(path));
        if let Some(path) = candidates.into_iter().find(|path| path.is_file()) {
            return Ok(path);
        }
    }

    if let Some(path) = platform_locator() {
        return validate_candidate(path);
    }

    Err(
        "Codex CLI를 찾을 수 없습니다. CLI를 설치하거나 실행 파일 경로를 선택해 주세요."
            .to_string(),
    )
}

fn validate_candidate(path: PathBuf) -> Result<PathBuf, String> {
    if path.is_file() {
        Ok(path)
    } else {
        Err(format!(
            "Codex CLI 실행 파일이 존재하지 않습니다: {}",
            path.display()
        ))
    }
}

fn executable_rank(path: &Path) -> u8 {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        // npm의 extensionless POSIX shim이나 접근이 제한된 WindowsApps alias보다
        // Windows에서 직접 실행 가능한 cmd/bat 래퍼를 먼저 선택한다.
        Some("cmd" | "bat") => 0,
        Some("exe") => 1,
        None => 2,
        Some("ps1") => 3,
        _ => 4,
    }
}

#[cfg(windows)]
fn platform_locator() -> Option<PathBuf> {
    let mut command = Command::new("where.exe");
    hide_console_window(&mut command);
    command
        .arg("codex")
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .and_then(|output| {
            let mut paths = output
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(PathBuf::from)
                .collect::<Vec<_>>();
            paths.sort_by_key(|path| executable_rank(path));
            paths.into_iter().find(|path| path.is_file())
        })
}

#[cfg(not(windows))]
fn platform_locator() -> Option<PathBuf> {
    let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    Command::new(shell)
        .args(["-lc", "command -v codex"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| String::from_utf8(output.stdout).ok())
        .map(|output| PathBuf::from(output.trim()))
        .filter(|path| path.is_file())
}

fn validate_cli(executable: &Path) -> Result<CliInfo, String> {
    let version_output = codex_command(executable, &["--version"])
        .output()
        .map_err(|error| format!("Codex CLI를 실행할 수 없습니다: {error}"))?;
    if !version_output.status.success() {
        let detail = String::from_utf8_lossy(&version_output.stderr);
        return Err(format!(
            "Codex CLI 버전을 확인할 수 없습니다 ({}): {}",
            version_output.status,
            detail.trim()
        ));
    }
    let version_text = String::from_utf8_lossy(&version_output.stdout)
        .trim()
        .to_string();
    let parsed = parse_codex_version(&version_text);
    let help_output = codex_command(executable, &["app-server", "--help"])
        .output()
        .map_err(|error| format!("Codex app-server 지원 여부를 확인할 수 없습니다: {error}"))?;

    Ok(CliInfo {
        path: executable.to_string_lossy().into_owned(),
        version: version_text,
        meets_recommended_version: parsed
            .map(|version| version >= RECOMMENDED_VERSION)
            .unwrap_or(false),
        app_server_supported: help_output.status.success(),
    })
}

fn parse_codex_version(value: &str) -> Option<(u64, u64, u64)> {
    let version = value.split_whitespace().find(|part| {
        part.chars()
            .next()
            .map(|character| character.is_ascii_digit())
            .unwrap_or(false)
    })?;
    let mut parts = version.split('.').map(|part| part.parse::<u64>().ok());
    Some((parts.next()??, parts.next()??, parts.next()??))
}

fn codex_command(executable: &Path, arguments: &[&str]) -> Command {
    #[cfg(windows)]
    {
        let extension = executable
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if extension == "cmd" || extension == "bat" {
            let mut command = Command::new("cmd.exe");
            command.args(["/D", "/S", "/C"]);
            command.arg(executable);
            command.args(arguments);
            hide_console_window(&mut command);
            return command;
        }
        if extension == "ps1" {
            let mut command = Command::new("powershell.exe");
            command.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]);
            command.arg(executable);
            command.args(arguments);
            hide_console_window(&mut command);
            return command;
        }
    }

    let mut command = Command::new(executable);
    command.args(arguments);
    hide_console_window(&mut command);
    command
}

fn hide_console_window(command: &mut Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = command;
}

struct RpcProcess {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<u64, Sender<Value>>>>,
    notifications: Receiver<Value>,
    next_id: AtomicU64,
    compatibility_warning: Option<String>,
}

impl RpcProcess {
    fn spawn(executable: &Path) -> Result<Self, String> {
        let mut command = codex_command(executable, &["app-server", "--stdio"]);
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Codex app-server를 시작할 수 없습니다: {error}"))?;
        let stdin =
            Arc::new(Mutex::new(child.stdin.take().ok_or_else(|| {
                "app-server 표준입력을 열 수 없습니다.".to_string()
            })?));
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "app-server 표준출력을 열 수 없습니다.".to_string())?;
        let pending: Arc<Mutex<HashMap<u64, Sender<Value>>>> = Arc::new(Mutex::new(HashMap::new()));
        let reader_pending = pending.clone();
        let (notification_sender, notifications) = mpsc::channel();

        thread::Builder::new()
            .name("codex-app-server-stdout".to_string())
            .spawn(move || {
                for line in BufReader::new(stdout).lines() {
                    let Ok(line) = line else { break };
                    let Ok(message) = serde_json::from_str::<Value>(&line) else {
                        continue;
                    };
                    if let Some(id) = message.get("id").and_then(Value::as_u64) {
                        if let Some(sender) = reader_pending
                            .lock()
                            .ok()
                            .and_then(|mut pending| pending.remove(&id))
                        {
                            let _ = sender.send(message);
                            continue;
                        }
                    }
                    let _ = notification_sender.send(message);
                }
                let _ = notification_sender.send(json!({ "method": "_process/exited" }));
            })
            .map_err(|error| format!("app-server 출력 리더를 시작할 수 없습니다: {error}"))?;

        if let Some(stderr) = child.stderr.take() {
            let _ = thread::Builder::new()
                .name("codex-app-server-stderr".to_string())
                .spawn(move || for _ in BufReader::new(stderr).lines() {});
        }

        Ok(Self {
            child,
            stdin,
            pending,
            notifications,
            next_id: AtomicU64::new(1),
            compatibility_warning: None,
        })
    }

    fn request(&mut self, method: &str, params: Option<Value>) -> Result<Value, String> {
        self.request_with_timeout(method, params, REQUEST_TIMEOUT)
    }

    fn request_with_timeout(
        &mut self,
        method: &str,
        params: Option<Value>,
        timeout: Duration,
    ) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = mpsc::channel();
        self.pending
            .lock()
            .map_err(|_| "app-server 요청 상태를 잠글 수 없습니다.".to_string())?
            .insert(id, sender);

        let mut message = json!({ "method": method, "id": id });
        if let Some(params) = params {
            message["params"] = params;
        }
        if let Err(error) = self.write_message(&message) {
            if let Ok(mut pending) = self.pending.lock() {
                pending.remove(&id);
            }
            return Err(error);
        }

        let response = receiver
            .recv_timeout(timeout)
            .map_err(|_| format!("app-server 요청 시간이 초과되었습니다: {method}"))?;
        if let Some(error) = response.get("error") {
            return Err(format!("app-server 오류: {error}"));
        }
        Ok(response.get("result").cloned().unwrap_or(Value::Null))
    }

    fn notify(&self, method: &str, params: Option<Value>) -> Result<(), String> {
        let mut message = json!({ "method": method });
        if let Some(params) = params {
            message["params"] = params;
        }
        self.write_message(&message)
    }

    fn write_message(&self, message: &Value) -> Result<(), String> {
        let mut stdin = self
            .stdin
            .lock()
            .map_err(|_| "app-server 표준입력을 잠글 수 없습니다.".to_string())?;
        serde_json::to_writer(&mut *stdin, message)
            .map_err(|error| format!("app-server 요청을 직렬화할 수 없습니다: {error}"))?;
        stdin
            .write_all(b"\n")
            .and_then(|_| stdin.flush())
            .map_err(|error| format!("app-server에 요청을 보낼 수 없습니다: {error}"))
    }
}

impl Drop for RpcProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fake_cli() -> (PathBuf, PathBuf, PathBuf) {
        let directory = env::temp_dir().join(format!(
            "quota-pacer-test-{}-{}",
            std::process::id(),
            crate::usage::unix_timestamp()
        ));
        fs::create_dir_all(&directory).unwrap();
        let script = directory.join("fake-codex.mjs");
        let log = directory.join("protocol.log");
        let log_literal = serde_json::to_string(&log.to_string_lossy()).unwrap();
        let source = format!(
            r#"import fs from "node:fs";
import readline from "node:readline";
const args = process.argv.slice(2);
if (args.includes("--version")) {{ console.log("codex-cli 0.144.6"); process.exit(0); }}
if (args[0] === "app-server" && args.includes("--help")) {{ console.log("Usage: codex app-server --stdio"); process.exit(0); }}
const log = {log_literal};
const input = readline.createInterface({{ input: process.stdin }});
input.on("line", (line) => {{
  const message = JSON.parse(line);
  fs.appendFileSync(log, `${{message.method}}:${{message.id ?? "notification"}}\n`);
  if (message.method === "hang") return;
  let result = {{}};
  if (message.method === "account/read") result = {{ account: {{ type: "chatgpt", planType: "free" }} }};
  if (message.method === "account/rateLimits/read") result = {{
    rateLimitsByLimitId: {{ codex: {{ limitId: "codex", planType: "plus", primary: {{ usedPercent: 26, windowDurationMins: 10080, resetsAt: 1785076374 }}, secondary: null }} }}
  }};
  if (message.id !== undefined) process.stdout.write(JSON.stringify({{ id: message.id, result }}) + "\n");
}});
"#
        );
        fs::write(&script, source).unwrap();

        #[cfg(windows)]
        let executable = {
            let executable = directory.join("codex.cmd");
            fs::write(
                &executable,
                format!("@echo off\r\nnode \"{}\" %*\r\n", script.display()),
            )
            .unwrap();
            executable
        };

        #[cfg(not(windows))]
        let executable = {
            use std::os::unix::fs::PermissionsExt;
            let executable = directory.join("codex");
            fs::write(
                &executable,
                format!("#!/bin/sh\nexec node \"{}\" \"$@\"\n", script.display()),
            )
            .unwrap();
            let mut permissions = fs::metadata(&executable).unwrap().permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(&executable, permissions).unwrap();
            executable
        };

        (directory, executable, log)
    }

    #[test]
    fn parses_current_and_future_cli_versions() {
        assert_eq!(parse_codex_version("codex-cli 0.144.6"), Some((0, 144, 6)));
        assert_eq!(parse_codex_version("codex-cli 1.2.3"), Some((1, 2, 3)));
        assert_eq!(parse_codex_version("unknown"), None);
    }

    #[test]
    fn windows_cmd_wrapper_is_preferred_over_extensionless_shims() {
        assert!(executable_rank(Path::new("codex.cmd")) < executable_rank(Path::new("codex")));
        assert!(executable_rank(Path::new("codex.cmd")) < executable_rank(Path::new("codex.ps1")));
    }

    #[test]
    fn account_and_bucket_plan_mismatch_does_not_block_chatgpt_auth() {
        let account = json!({
            "account": { "type": "chatgpt", "planType": "free" },
            "requiresOpenaiAuth": true
        });
        assert!(validate_account(&account).is_ok());
    }

    #[test]
    fn unsupported_auth_is_distinct_from_missing_login() {
        let unsupported = validate_account(&json!({ "account": { "type": "apiKey" } }));
        assert_eq!(
            unsupported.err().unwrap().connection,
            ConnectionState::UnsupportedAuth
        );

        let missing = validate_account(&json!({ "account": null }));
        assert_eq!(
            missing.err().unwrap().connection,
            ConnectionState::LoginRequired
        );
    }

    #[test]
    fn fake_jsonl_server_verifies_handshake_weekly_snapshot_and_timeout() {
        let (directory, executable, log) = fake_cli();
        let (mut rpc, state) = connect(Some(executable)).unwrap_or_else(|failure| {
            panic!("fake app-server connection failed: {}", failure.message)
        });

        assert_eq!(state.connection, ConnectionState::Ready);
        assert_eq!(state.windows.len(), 1);
        assert_eq!(state.windows[0].window_duration_mins, Some(10_080));
        assert!(rpc
            .request_with_timeout("hang", None, Duration::from_millis(30))
            .unwrap_err()
            .contains("시간이 초과"));

        drop(rpc);
        let protocol = fs::read_to_string(log).unwrap();
        let messages = protocol.lines().collect::<Vec<_>>();
        assert_eq!(messages[0], "initialize:1");
        assert_eq!(messages[1], "initialized:notification");
        assert_eq!(messages[2], "account/read:2");
        assert_eq!(messages[3], "account/rateLimits/read:3");
        assert_eq!(messages[4], "hang:4");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    #[ignore = "개발 환경에 로그인된 Codex CLI가 있을 때 수동으로 실행"]
    fn connects_to_installed_codex_cli() {
        let (_rpc, state) = connect(None)
            .unwrap_or_else(|failure| panic!("real Codex CLI check failed: {}", failure.message));
        assert!(matches!(
            state.connection,
            ConnectionState::Ready | ConnectionState::NoLimits
        ));
        println!("real CLI usage state: {state:?}");
    }
}

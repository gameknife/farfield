use if_addrs::get_if_addrs;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs::{self, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    net::IpAddr,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{LazyLock, Mutex},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, RunEvent, State};
use url::Url;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "mode",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum ConnectionConfig {
    Host {
        version: u8,
        server_base_url: String,
        shared_secret: String,
    },
    RemoteClient {
        version: u8,
        server_base_url: String,
        shared_secret: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeServiceStatus {
    state: String,
    message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeStatus {
    active_mode: String,
    host_supported: bool,
    native_app_url: String,
    local_connect_urls: Vec<String>,
    resolved_bind_address: String,
    server4311_status: RuntimeServiceStatus,
    web4312_status: RuntimeServiceStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Bootstrap {
    connection: ConnectionConfig,
    runtime: RuntimeStatus,
}

#[derive(Debug)]
struct ManagedChildren {
    server: Option<Child>,
    web_host: Option<Child>,
}

impl ManagedChildren {
    fn new() -> Self {
        Self {
            server: None,
            web_host: None,
        }
    }
}

struct AppStateInner {
    connection: Mutex<ConnectionConfig>,
    runtime: Mutex<RuntimeStatus>,
    children: Mutex<ManagedChildren>,
}

#[derive(Clone, Copy)]
enum RuntimeServiceKind {
    Server4311,
    Web4312,
}

const HOST_SERVER_BASE_URL: &str = "http://127.0.0.1:4311";
const HOST_WINDOW_URL: &str = "http://127.0.0.1:4312";
const MODE_PICKER_DONE_HASH: &str = "#mode-chosen";
static NATIVE_HOST_LOG_WRITE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn is_desktop_platform() -> bool {
    cfg!(target_os = "windows") || cfg!(target_os = "macos") || cfg!(target_os = "linux")
}

fn generate_shared_secret() -> String {
    format!("{:06}", uuid::Uuid::new_v4().as_u128() % 1_000_000)
}

fn has_non_empty_shared_secret(shared_secret: &str) -> bool {
    !shared_secret.trim().is_empty()
}

fn is_valid_host_shared_secret(shared_secret: &str) -> bool {
    shared_secret.len() == 6 && shared_secret.bytes().all(|byte| byte.is_ascii_digit())
}

fn build_local_connect_urls(addresses: impl IntoIterator<Item = IpAddr>) -> Vec<String> {
    let mut urls = BTreeSet::from([HOST_SERVER_BASE_URL.to_string()]);

    for address in addresses {
        match address {
            IpAddr::V4(ipv4)
                if !ipv4.is_loopback() && !ipv4.is_link_local() && !ipv4.is_unspecified() =>
            {
                urls.insert(format!("http://{ipv4}:4311"));
            }
            _ => {}
        }
    }

    urls.into_iter().collect()
}

fn local_connect_urls() -> Vec<String> {
    let addresses = match get_if_addrs() {
        Ok(interfaces) => interfaces
            .into_iter()
            .map(|interface| interface.ip())
            .collect(),
        Err(_) => Vec::new(),
    };

    build_local_connect_urls(addresses)
}

fn default_connection_config() -> ConnectionConfig {
    if is_desktop_platform() {
        ConnectionConfig::Host {
            version: 1,
            server_base_url: HOST_SERVER_BASE_URL.to_string(),
            shared_secret: generate_shared_secret(),
        }
    } else {
        ConnectionConfig::RemoteClient {
            version: 1,
            server_base_url: "http://127.0.0.1:4311".to_string(),
            shared_secret: "change-me".to_string(),
        }
    }
}

fn validate_connection_config(config: &ConnectionConfig) -> Result<(), String> {
    match config {
        ConnectionConfig::Host {
            version,
            server_base_url,
            shared_secret,
        } => {
            if !is_desktop_platform() {
                return Err("Host mode is only supported on desktop".to_string());
            }
            if *version != 1 {
                return Err("Unsupported connection config version".to_string());
            }
            if server_base_url != HOST_SERVER_BASE_URL {
                return Err(format!("Host mode must use {HOST_SERVER_BASE_URL}"));
            }
            if !is_valid_host_shared_secret(shared_secret) {
                return Err("Host password must be exactly 6 digits".to_string());
            }
        }
        ConnectionConfig::RemoteClient {
            version,
            server_base_url,
            shared_secret,
        } => {
            if *version != 1 {
                return Err("Unsupported connection config version".to_string());
            }
            validate_remote_server_base_url(server_base_url)?;
            if !has_non_empty_shared_secret(shared_secret) {
                return Err("Shared secret is required".to_string());
            }
        }
    }

    Ok(())
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
}

fn release_executable_dir() -> Result<PathBuf, String> {
    let executable_path = std::env::current_exe().map_err(|error| error.to_string())?;
    let executable_dir = executable_path
        .parent()
        .ok_or_else(|| "Executable directory is missing".to_string())?;
    Ok(executable_dir.to_path_buf())
}

fn app_config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&base_dir).map_err(|error| error.to_string())?;
    Ok(base_dir)
}

fn app_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let base_dir = app_config_dir(app)?;
    Ok(base_dir.join("connection.json"))
}

fn native_host_log_path(app: &AppHandle) -> Result<PathBuf, String> {
    let base_dir = app_config_dir(app)?;
    Ok(base_dir.join("native-host.log"))
}

fn append_native_host_log(app: &AppHandle, message: &str) -> Result<PathBuf, String> {
    let log_path = native_host_log_path(app)?;
    let _guard = NATIVE_HOST_LOG_WRITE_LOCK
        .lock()
        .expect("native host log mutex poisoned");
    let mut log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| error.to_string())?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?;
    writeln!(
        log_file,
        "[{}.{:03}] {}",
        now.as_secs(),
        now.subsec_millis(),
        message
    )
    .map_err(|error| error.to_string())?;
    Ok(log_path)
}

fn record_native_host_event(app: &AppHandle, message: impl AsRef<str>) {
    let message_ref = message.as_ref();
    if let Err(error) = append_native_host_log(app, message_ref) {
        eprintln!(
            "[farfield-native:log-write-failed] {} while recording {}",
            error, message_ref
        );
    }
}

fn load_connection_config(app: &AppHandle) -> ConnectionConfig {
    let config_path = match app_config_path(app) {
        Ok(path) => path,
        Err(_) => return default_connection_config(),
    };

    let raw = match fs::read_to_string(&config_path) {
        Ok(contents) => contents,
        Err(_) => return default_connection_config(),
    };

    let parsed = match serde_json::from_str::<ConnectionConfig>(&raw) {
        Ok(parsed) => parsed,
        Err(_) => return default_connection_config(),
    };

    if validate_connection_config(&parsed).is_err() {
        return default_connection_config();
    }

    parsed
}

fn save_connection_config_file(
    app: &AppHandle,
    connection: &ConnectionConfig,
) -> Result<(), String> {
    let config_path = app_config_path(app)?;
    let encoded = serde_json::to_string_pretty(connection).map_err(|error| error.to_string())?;
    fs::write(config_path, encoded).map_err(|error| error.to_string())
}

fn validate_remote_server_base_url(server_base_url: &str) -> Result<(), String> {
    let parsed = Url::parse(server_base_url).map_err(|error| error.to_string())?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err("Remote client mode must use http:// or https://".to_string());
    }
    if parsed.query().is_some() {
        return Err("Remote client URL cannot include a query string".to_string());
    }
    if parsed.fragment().is_some() {
        return Err("Remote client URL cannot include a hash fragment".to_string());
    }
    if parsed.path() != "" && parsed.path() != "/" {
        return Err("Remote client URL cannot include a path".to_string());
    }
    Ok(())
}

fn build_runtime_status(connection: &ConnectionConfig, native_app_url: &str) -> RuntimeStatus {
    let resolved_bind_address = match connection {
        ConnectionConfig::Host { .. } => "0.0.0.0:4311".to_string(),
        ConnectionConfig::RemoteClient {
            server_base_url, ..
        } => server_base_url.clone(),
    };
    let local_connect_urls = if is_desktop_platform() {
        local_connect_urls()
    } else {
        Vec::new()
    };

    RuntimeStatus {
        active_mode: "unconfigured".to_string(),
        host_supported: is_desktop_platform(),
        native_app_url: native_app_url.to_string(),
        local_connect_urls,
        resolved_bind_address,
        server4311_status: RuntimeServiceStatus {
            state: "stopped".to_string(),
            message: None,
        },
        web4312_status: RuntimeServiceStatus {
            state: "stopped".to_string(),
            message: None,
        },
    }
}

fn build_active_runtime_status(
    connection: &ConnectionConfig,
    native_app_url: &str,
) -> RuntimeStatus {
    match connection {
        ConnectionConfig::Host { .. } => RuntimeStatus {
            active_mode: "host".to_string(),
            host_supported: is_desktop_platform(),
            native_app_url: native_app_url.to_string(),
            local_connect_urls: local_connect_urls(),
            resolved_bind_address: "0.0.0.0:4311".to_string(),
            server4311_status: RuntimeServiceStatus {
                state: "stopped".to_string(),
                message: None,
            },
            web4312_status: RuntimeServiceStatus {
                state: "stopped".to_string(),
                message: None,
            },
        },
        ConnectionConfig::RemoteClient {
            server_base_url, ..
        } => RuntimeStatus {
            active_mode: "remoteClient".to_string(),
            host_supported: is_desktop_platform(),
            native_app_url: native_app_url.to_string(),
            local_connect_urls: local_connect_urls(),
            resolved_bind_address: server_base_url.clone(),
            server4311_status: RuntimeServiceStatus {
                state: "stopped".to_string(),
                message: None,
            },
            web4312_status: RuntimeServiceStatus {
                state: "stopped".to_string(),
                message: None,
            },
        },
    }
}

fn sidecar_binary_path(app: &AppHandle, binary_name: &str) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        return Ok(repo_root().join("traces").join(binary_name));
    }

    let executable_layout_path = release_executable_dir()?.join("binaries").join(binary_name);
    if executable_layout_path.is_file() {
        return Ok(executable_layout_path);
    }

    app.path()
        .resolve(
            format!("binaries/{binary_name}"),
            tauri::path::BaseDirectory::Resource,
        )
        .map_err(|error| error.to_string())
}

fn resolve_sidecar_binary_path(
    app: &AppHandle,
    binary_name: &str,
) -> Result<PathBuf, String> {
    record_native_host_event(app, format!("resolving sidecar binary {}", binary_name));
    let resolved = sidecar_binary_path(app, binary_name);
    match &resolved {
        Ok(path) => record_native_host_event(
            app,
            format!("resolved sidecar binary {} to {}", binary_name, path.display()),
        ),
        Err(error) => record_native_host_event(
            app,
            format!("failed to resolve sidecar binary {}: {}", binary_name, error),
        ),
    }
    resolved
}

fn sidecar_binary_name(base_name: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("{base_name}.exe")
    } else {
        base_name.to_string()
    }
}

fn packaged_web_dist_path(app: &AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        return Ok(repo_root().join("apps").join("web").join("dist"));
    }

    let executable_dist_path = release_executable_dir()?.join("dist");
    if executable_dist_path.is_dir() {
        return Ok(executable_dist_path);
    }

    let executable_layout_path = release_executable_dir()?.join("resources").join("dist");
    if executable_layout_path.is_dir() {
        return Ok(executable_layout_path);
    }

    let bundled_resource_path = app
        .path()
        .resolve("dist", tauri::path::BaseDirectory::Resource)
        .map_err(|error| error.to_string())?;
    if bundled_resource_path.is_dir() {
        return Ok(bundled_resource_path);
    }

    let workspace_dist_path = repo_root().join("apps").join("web").join("dist");
    if workspace_dist_path.is_dir() {
        return Ok(workspace_dist_path);
    }

    Err("Packaged web dist directory is missing".to_string())
}

fn resolve_packaged_web_dist_path(app: &AppHandle) -> Result<PathBuf, String> {
    record_native_host_event(app, "resolving packaged web dist directory");
    let resolved = packaged_web_dist_path(app);
    match &resolved {
        Ok(path) => record_native_host_event(
            app,
            format!("resolved packaged web dist directory to {}", path.display()),
        ),
        Err(error) => record_native_host_event(
            app,
            format!("failed to resolve packaged web dist directory: {}", error),
        ),
    }
    resolved
}

fn bun_binary_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "bun.exe"
    } else {
        "bun"
    }
}

fn configure_child_process(command: &mut Command) {
    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);
}

fn configure_background_command(command: &mut Command) {
    configure_child_process(command);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
}

fn open_external_url(url: &str) -> Result<(), String> {
    let parsed = Url::parse(url).map_err(|error| error.to_string())?;
    match parsed.scheme() {
        "http" | "https" | "mailto" => {}
        _ => return Err("Unsupported URL scheme".to_string()),
    }

    #[cfg(target_os = "windows")]
    {
        let mut command = Command::new("cmd");
        command.args(["/C", "start", "", url]);
        configure_background_command(&mut command);
        command.spawn().map_err(|error| error.to_string())?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        command.arg(url);
        configure_background_command(&mut command);
        command.spawn().map_err(|error| error.to_string())?;
        return Ok(());
    }

    #[cfg(all(target_os = "linux", not(target_os = "android")))]
    {
        let mut command = Command::new("xdg-open");
        command.arg(url);
        configure_background_command(&mut command);
        command.spawn().map_err(|error| error.to_string())?;
        return Ok(());
    }

    #[cfg(target_os = "android")]
    {
        let _ = parsed;
        Err("Opening external URLs is not supported on Android".to_string())
    }
}

fn runtime_service_status_mut<'a>(
    runtime: &'a mut RuntimeStatus,
    service_kind: RuntimeServiceKind,
) -> &'a mut RuntimeServiceStatus {
    match service_kind {
        RuntimeServiceKind::Server4311 => &mut runtime.server4311_status,
        RuntimeServiceKind::Web4312 => &mut runtime.web4312_status,
    }
}

fn runtime_service_kind_label(service_kind: RuntimeServiceKind) -> &'static str {
    match service_kind {
        RuntimeServiceKind::Server4311 => "server4311",
        RuntimeServiceKind::Web4312 => "web4312",
    }
}

fn update_runtime_service_status(
    app: &AppHandle,
    service_kind: RuntimeServiceKind,
    next_state: Option<&str>,
    next_message: Option<String>,
) {
    let state = app.state::<AppStateInner>();
    let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
    let service_status = runtime_service_status_mut(&mut runtime, service_kind);
    if let Some(state_value) = next_state {
        service_status.state = state_value.to_string();
    }
    service_status.message = next_message;
}

fn spawn_runtime_service_log_reader<R: Read + Send + 'static>(
    app: &AppHandle,
    service_kind: RuntimeServiceKind,
    stream_name: &'static str,
    reader: R,
    ready_pattern: Option<&'static str>,
) {
    let app_handle = app.clone();
    thread::spawn(move || {
        let buffered_reader = BufReader::new(reader);
        for line_result in buffered_reader.lines() {
            let line = match line_result {
                Ok(value) => value.trim().to_string(),
                Err(error) => {
                    update_runtime_service_status(
                        &app_handle,
                        service_kind,
                        None,
                        Some(format!("{stream_name} read failed: {error}")),
                    );
                    break;
                }
            };

            if line.is_empty() {
                continue;
            }

            eprintln!(
                "[farfield-native:{}:{}] {}",
                runtime_service_kind_label(service_kind),
                stream_name,
                line
            );
            record_native_host_event(
                &app_handle,
                format!(
                    "{} {}: {}",
                    runtime_service_kind_label(service_kind),
                    stream_name,
                    line
                ),
            );

            let next_state = ready_pattern
                .filter(|pattern| line.contains(pattern))
                .map(|_| "running");
            update_runtime_service_status(
                &app_handle,
                service_kind,
                next_state,
                Some(format!("{stream_name}: {line}")),
            );
        }
    });
}

fn spawn_runtime_service_exit_monitor(
    app: &AppHandle,
    service_kind: RuntimeServiceKind,
    child_id: u32,
) {
    let app_handle = app.clone();
    thread::spawn(move || loop {
        let exit_message = {
            let state = app_handle.state::<AppStateInner>();
            let mut children = state.children.lock().expect("children mutex poisoned");
            let child_option = match service_kind {
                RuntimeServiceKind::Server4311 => &mut children.server,
                RuntimeServiceKind::Web4312 => &mut children.web_host,
            };

            let child = match child_option.as_mut() {
                Some(value) if value.id() == child_id => value,
                _ => return,
            };

            match child.try_wait() {
                Ok(Some(exit_status)) => {
                    let exit_detail = match exit_status.code() {
                        Some(code) => format!("exit code {code}"),
                        None => "terminated without an exit code".to_string(),
                    };
                    *child_option = None;
                    Some(format!(
                        "{} process exited with {}",
                        runtime_service_kind_label(service_kind),
                        exit_detail
                    ))
                }
                Ok(None) => None,
                Err(error) => {
                    *child_option = None;
                    Some(format!(
                        "{} process status check failed: {}",
                        runtime_service_kind_label(service_kind),
                        error
                    ))
                }
            }
        };

        if let Some(message) = exit_message {
            record_native_host_event(&app_handle, &message);
            update_runtime_service_status(&app_handle, service_kind, Some("error"), Some(message));
            return;
        }

        thread::sleep(Duration::from_millis(250));
    });
}

fn spawn_managed_service(
    app: &AppHandle,
    service_kind: RuntimeServiceKind,
    mut command: Command,
    launch_message: String,
    ready_pattern: Option<&'static str>,
) -> Result<Child, String> {
    record_native_host_event(app, &launch_message);
    update_runtime_service_status(
        app,
        service_kind,
        Some("starting"),
        Some(launch_message.clone()),
    );

    configure_child_process(&mut command);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = match command.spawn() {
        Ok(value) => value,
        Err(error) => {
            let message = format!("{launch_message}: {error}");
            record_native_host_event(app, &message);
            update_runtime_service_status(
                app,
                service_kind,
                Some("error"),
                Some(message.clone()),
            );
            return Err(message);
        }
    };

    let child_id = child.id();
    if let Some(stdout) = child.stdout.take() {
        spawn_runtime_service_log_reader(app, service_kind, "stdout", stdout, ready_pattern);
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_runtime_service_log_reader(app, service_kind, "stderr", stderr, None);
    }
    spawn_runtime_service_exit_monitor(app, service_kind, child_id);
    record_native_host_event(
        app,
        format!(
            "{} started with pid {}",
            runtime_service_kind_label(service_kind),
            child_id
        ),
    );
    let next_state = if ready_pattern.is_none() {
        "running"
    } else {
        "starting"
    };
    update_runtime_service_status(
        app,
        service_kind,
        Some(next_state),
        Some(format!("{launch_message} (pid {child_id})")),
    );

    Ok(child)
}

fn stop_children(children: &mut ManagedChildren) {
    if let Some(server_child) = children.server.as_mut() {
        let _ = server_child.kill();
        let _ = server_child.wait();
    }
    if let Some(web_host_child) = children.web_host.as_mut() {
        let _ = web_host_child.kill();
        let _ = web_host_child.wait();
    }
    children.server = None;
    children.web_host = None;
}

fn cleanup_managed_children(app: &AppHandle) {
    let state = app.state::<AppStateInner>();
    let mut children = state.children.lock().expect("children mutex poisoned");
    stop_children(&mut children);
}

fn start_desktop_host_children(
    app: &AppHandle,
    connection: &ConnectionConfig,
    children: &mut ManagedChildren,
) -> Result<(), String> {
    if let Ok(log_path) = native_host_log_path(app) {
        record_native_host_event(
            app,
            format!("native host log file: {}", log_path.display()),
        );
    }
    record_native_host_event(app, "starting desktop host children");
    stop_children(children);
    update_runtime_service_status(app, RuntimeServiceKind::Server4311, Some("stopped"), None);
    update_runtime_service_status(app, RuntimeServiceKind::Web4312, Some("stopped"), None);

    let shared_secret = match connection {
        ConnectionConfig::Host { shared_secret, .. } => shared_secret.clone(),
        ConnectionConfig::RemoteClient { .. } => return Ok(()),
    };

    if cfg!(debug_assertions) {
        let workspace_root = repo_root();
        let web_dist_path = workspace_root.join("apps").join("web").join("dist");
        record_native_host_event(
            app,
            format!(
                "debug host mode using workspace_root={} web_dist_dir={}",
                workspace_root.display(),
                web_dist_path.display()
            ),
        );
        let mut server_command = Command::new(bun_binary_name());
        server_command
            .current_dir(&workspace_root)
            .env("HOST", "0.0.0.0")
            .env("PORT", "4311")
            .env("FARFIELD_SHARED_SECRET", &shared_secret)
            .arg("apps/server/src/index.ts");
        let mut server_child = spawn_managed_service(
            app,
            RuntimeServiceKind::Server4311,
            server_command,
            format!(
                "Launching local server with bun from {}",
                workspace_root.display()
            ),
            None,
        )?;

        let mut web_host_command = Command::new(bun_binary_name());
        web_host_command
            .current_dir(&workspace_root)
            .env("HOST", "127.0.0.1")
            .env("PORT", "4312")
            .env("API_ORIGIN", "http://127.0.0.1:4311")
            .env("WEB_DIST_DIR", &web_dist_path)
            .arg("apps/web-host/src/index.ts");
        let web_host_child = match spawn_managed_service(
            app,
            RuntimeServiceKind::Web4312,
            web_host_command,
            format!(
                "Launching local web host with bun from {} using WEB_DIST_DIR={}",
                workspace_root.display(),
                web_dist_path.display()
            ),
            Some("Farfield web-host listening on http://"),
        ) {
            Ok(value) => value,
            Err(error) => {
                record_native_host_event(
                    app,
                    format!("web4312 launch failed; stopping server4311: {error}"),
                );
                let _ = server_child.kill();
                let _ = server_child.wait();
                return Err(error);
            }
        };

        children.server = Some(server_child);
        children.web_host = Some(web_host_child);
        return Ok(());
    }

    let server_path = resolve_sidecar_binary_path(app, &sidecar_binary_name("farfield-server"))?;
    let web_host_path = resolve_sidecar_binary_path(app, &sidecar_binary_name("web-host"))?;
    let web_dist_path = resolve_packaged_web_dist_path(app)?;
    record_native_host_event(
        app,
        format!(
            "release host mode using server_path={} web_host_path={} web_dist_dir={}",
            server_path.display(),
            web_host_path.display(),
            web_dist_path.display()
        ),
    );

    let mut server_command = Command::new(&server_path);
    server_command
        .env("HOST", "0.0.0.0")
        .env("PORT", "4311")
        .env("FARFIELD_SHARED_SECRET", &shared_secret);
    let mut server_child = spawn_managed_service(
        app,
        RuntimeServiceKind::Server4311,
        server_command,
        format!("Launching sidecar server from {}", server_path.display()),
        None,
    )?;

    let mut web_host_command = Command::new(&web_host_path);
    web_host_command
        .env("HOST", "127.0.0.1")
        .env("PORT", "4312")
        .env("API_ORIGIN", "http://127.0.0.1:4311")
        .env("WEB_DIST_DIR", &web_dist_path);
    let web_host_child = match spawn_managed_service(
        app,
        RuntimeServiceKind::Web4312,
        web_host_command,
        format!(
            "Launching sidecar web host from {} using WEB_DIST_DIR={}",
            web_host_path.display(),
            web_dist_path.display()
        ),
        Some("Farfield web-host listening on http://"),
    ) {
        Ok(value) => value,
        Err(error) => {
            record_native_host_event(
                app,
                format!("web4312 launch failed; stopping server4311: {error}"),
            );
            let _ = server_child.kill();
            let _ = server_child.wait();
            return Err(error);
        }
    };

    children.server = Some(server_child);
    children.web_host = Some(web_host_child);
    Ok(())
}

fn native_app_url() -> String {
    if cfg!(target_os = "windows") || cfg!(target_os = "android") {
        "http://tauri.localhost/".to_string()
    } else {
        "tauri://localhost/".to_string()
    }
}

fn refresh_runtime_for_connection(
    connection: &ConnectionConfig,
    native_app_url: &str,
    runtime: &mut RuntimeStatus,
) {
    *runtime = build_active_runtime_status(connection, native_app_url);
}

fn redirect_host_window(
    app: &AppHandle,
    connection: &ConnectionConfig,
    suppress_mode_picker: bool,
) {
    if !matches!(connection, ConnectionConfig::Host { .. }) {
        return;
    }

    if let Some(window) = app.get_webview_window("main") {
        let target_url = if suppress_mode_picker {
            format!("{HOST_WINDOW_URL}{MODE_PICKER_DONE_HASH}")
        } else {
            HOST_WINDOW_URL.to_string()
        };
        let script = format!("window.location.replace({target_url:?});");
        record_native_host_event(
            app,
            format!("redirecting host window to {}", target_url),
        );
        if let Err(error) = window.eval(&script) {
            record_native_host_event(
                app,
                format!("host window redirect failed: {}", error),
            );
        }
    }
}

fn apply_connection_config(
    app: &AppHandle,
    state: &State<AppStateInner>,
    next_connection: ConnectionConfig,
    suppress_mode_picker: bool,
) -> Result<Bootstrap, String> {
    validate_connection_config(&next_connection)?;
    save_connection_config_file(app, &next_connection)?;

    {
        let mut connection = state.connection.lock().expect("connection mutex poisoned");
        *connection = next_connection.clone();
    }

    {
        let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
        let native_app_url = runtime.native_app_url.clone();
        refresh_runtime_for_connection(&next_connection, &native_app_url, &mut runtime);
    }

    {
        let mut children = state.children.lock().expect("children mutex poisoned");
        if matches!(next_connection, ConnectionConfig::Host { .. }) {
            start_desktop_host_children(app, &next_connection, &mut children)?;
        } else {
            stop_children(&mut children);
        }
    }

    redirect_host_window(app, &next_connection, suppress_mode_picker);
    Ok(farfield_get_bootstrap(state.clone()))
}

#[tauri::command]
fn farfield_get_bootstrap(state: State<AppStateInner>) -> Bootstrap {
    let connection = state
        .connection
        .lock()
        .expect("connection mutex poisoned")
        .clone();
    let runtime = state
        .runtime
        .lock()
        .expect("runtime mutex poisoned")
        .clone();

    Bootstrap {
        connection,
        runtime,
    }
}

#[tauri::command]
fn farfield_get_runtime_status(state: State<AppStateInner>) -> RuntimeStatus {
    state
        .runtime
        .lock()
        .expect("runtime mutex poisoned")
        .clone()
}

#[tauri::command]
fn farfield_set_connection_config(
    app: AppHandle,
    state: State<AppStateInner>,
    config_json: String,
) -> Result<ConnectionConfig, String> {
    let next_connection = serde_json::from_str::<ConnectionConfig>(&config_json)
        .map_err(|error| error.to_string())?;
    let _ = apply_connection_config(&app, &state, next_connection.clone(), false)?;
    Ok(next_connection)
}

#[tauri::command]
fn farfield_activate_host_mode(
    app: AppHandle,
    state: State<AppStateInner>,
) -> Result<Bootstrap, String> {
    if !is_desktop_platform() {
        return Err("Host mode is only supported on desktop".to_string());
    }
    let existing_connection = state
        .connection
        .lock()
        .expect("connection mutex poisoned")
        .clone();
    let shared_secret = match existing_connection {
        ConnectionConfig::Host { shared_secret, .. }
            if is_valid_host_shared_secret(&shared_secret) =>
        {
            shared_secret
        }
        ConnectionConfig::Host { .. } => generate_shared_secret(),
        ConnectionConfig::RemoteClient { .. } => generate_shared_secret(),
    };
    let next_connection = ConnectionConfig::Host {
        version: 1,
        server_base_url: HOST_SERVER_BASE_URL.to_string(),
        shared_secret,
    };
    apply_connection_config(&app, &state, next_connection, true)
}

#[tauri::command]
fn farfield_open_external_url(url: String) -> Result<(), String> {
    open_external_url(&url)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            let connection = load_connection_config(&app.handle());
            let native_app_url = native_app_url();
            let runtime = build_runtime_status(&connection, &native_app_url);
            let state = AppStateInner {
                connection: Mutex::new(connection.clone()),
                runtime: Mutex::new(runtime.clone()),
                children: Mutex::new(ManagedChildren::new()),
            };

            app.manage(state);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            farfield_get_bootstrap,
            farfield_get_runtime_status,
            farfield_set_connection_config,
            farfield_activate_host_mode,
            farfield_open_external_url
        ])
        .build(tauri::generate_context!())
        .expect("error while building Farfield Tauri app");

    app.run(|app, event| match event {
        RunEvent::ExitRequested { .. } | RunEvent::Exit => {
            cleanup_managed_children(app);
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::{
        build_local_connect_urls, generate_shared_secret, is_valid_host_shared_secret,
        native_app_url, validate_remote_server_base_url,
    };
    use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
    use url::Url;

    #[test]
    fn native_app_url_is_a_valid_origin() {
        let parsed = Url::parse(&native_app_url()).expect("native app url must parse");
        assert_eq!(parsed.host_str(), Some("localhost"));
        assert!(parsed.query().is_none());
        assert!(parsed.fragment().is_none());
    }

    #[test]
    fn accepts_plain_lan_origin_for_remote_client_mode() {
        let result = validate_remote_server_base_url("http://192.168.1.25:4311");
        assert!(result.is_ok());
    }

    #[test]
    fn host_shared_secret_is_six_digits() {
        let shared_secret = generate_shared_secret();
        assert_eq!(shared_secret.len(), 6);
        assert!(shared_secret.bytes().all(|byte| byte.is_ascii_digit()));
    }

    #[test]
    fn rejects_legacy_host_shared_secret_format() {
        assert!(!is_valid_host_shared_secret(
            "ff-bbfdbac7d8c54912b4426925d648cf00"
        ));
    }

    #[test]
    fn local_connect_urls_include_loopback_and_lan_ipv4_only() {
        let urls = build_local_connect_urls([
            IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)),
            IpAddr::V4(Ipv4Addr::new(192, 168, 1, 23)),
            IpAddr::V4(Ipv4Addr::new(10, 0, 0, 5)),
            IpAddr::V4(Ipv4Addr::new(169, 254, 1, 9)),
            IpAddr::V6(Ipv6Addr::LOCALHOST),
        ]);

        assert_eq!(
            urls,
            vec![
                "http://10.0.0.5:4311".to_string(),
                "http://127.0.0.1:4311".to_string(),
                "http://192.168.1.23:4311".to_string(),
            ]
        );
    }

    #[test]
    fn rejects_remote_client_urls_with_paths() {
        let result = validate_remote_server_base_url("http://192.168.1.25:4311/api");
        assert_eq!(
            result,
            Err("Remote client URL cannot include a path".to_string())
        );
    }

    #[test]
    fn rejects_remote_client_urls_with_query_strings() {
        let result = validate_remote_server_base_url("http://192.168.1.25:4311?foo=bar");
        assert_eq!(
            result,
            Err("Remote client URL cannot include a query string".to_string())
        );
    }
}

use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
};
use tauri::{AppHandle, Manager, RunEvent, State};
use url::Url;

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

const HOST_SERVER_BASE_URL: &str = "http://127.0.0.1:4311";
const HOST_WINDOW_URL: &str = "http://127.0.0.1:4312";
const MODE_PICKER_DONE_HASH: &str = "#mode-chosen";

fn is_desktop_platform() -> bool {
    cfg!(target_os = "windows") || cfg!(target_os = "macos") || cfg!(target_os = "linux")
}

fn generate_shared_secret() -> String {
    format!("ff-{}", uuid::Uuid::new_v4().simple())
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
            if shared_secret.trim().is_empty() {
                return Err("Shared secret is required".to_string());
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
            if shared_secret.trim().is_empty() {
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

fn app_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let base_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&base_dir).map_err(|error| error.to_string())?;
    Ok(base_dir.join("connection.json"))
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

    RuntimeStatus {
        active_mode: "unconfigured".to_string(),
        host_supported: is_desktop_platform(),
        native_app_url: native_app_url.to_string(),
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

fn bun_binary_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "bun.exe"
    } else {
        "bun"
    }
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
    stop_children(children);

    let shared_secret = match connection {
        ConnectionConfig::Host { shared_secret, .. } => shared_secret.clone(),
        ConnectionConfig::RemoteClient { .. } => return Ok(()),
    };

    if cfg!(debug_assertions) {
        let workspace_root = repo_root();
        let server_child = Command::new(bun_binary_name())
            .current_dir(&workspace_root)
            .env("HOST", "0.0.0.0")
            .env("PORT", "4311")
            .env("FARFIELD_SHARED_SECRET", &shared_secret)
            .arg("apps/server/src/index.ts")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| error.to_string())?;

        let web_host_child = Command::new(bun_binary_name())
            .current_dir(&workspace_root)
            .env("HOST", "127.0.0.1")
            .env("PORT", "4312")
            .env("API_ORIGIN", "http://127.0.0.1:4311")
            .env(
                "WEB_DIST_DIR",
                workspace_root.join("apps").join("web").join("dist"),
            )
            .arg("apps/web-host/src/index.ts")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| error.to_string())?;

        children.server = Some(server_child);
        children.web_host = Some(web_host_child);
        return Ok(());
    }

    let server_path = sidecar_binary_path(app, &sidecar_binary_name("farfield-server"))?;
    let web_host_path = sidecar_binary_path(app, &sidecar_binary_name("web-host"))?;

    let server_child = Command::new(server_path)
        .env("HOST", "0.0.0.0")
        .env("PORT", "4311")
        .env("FARFIELD_SHARED_SECRET", &shared_secret)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| error.to_string())?;

    let web_host_child = Command::new(web_host_path)
        .env("HOST", "127.0.0.1")
        .env("PORT", "4312")
        .env("API_ORIGIN", "http://127.0.0.1:4311")
        .env("WEB_DIST_DIR", packaged_web_dist_path(app)?)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| error.to_string())?;

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
        let _ = window.eval(&script);
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
        ConnectionConfig::Host { shared_secret, .. } => shared_secret,
        ConnectionConfig::RemoteClient { .. } => generate_shared_secret(),
    };
    let next_connection = ConnectionConfig::Host {
        version: 1,
        server_base_url: HOST_SERVER_BASE_URL.to_string(),
        shared_secret,
    };
    apply_connection_config(&app, &state, next_connection, true)
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
            farfield_activate_host_mode
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
    use super::{native_app_url, validate_remote_server_base_url};
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

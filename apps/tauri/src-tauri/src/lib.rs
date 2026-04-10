use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
};
use tauri::{AppHandle, Manager, State};
use url::Url;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase", rename_all_fields = "camelCase", deny_unknown_fields)]
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
            server_base_url: "http://127.0.0.1:4311".to_string(),
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
            if *version != 1 {
                return Err("Unsupported connection config version".to_string());
            }
            if server_base_url != "http://127.0.0.1:4311" {
                return Err("Host mode must use http://127.0.0.1:4311".to_string());
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
            Url::parse(server_base_url).map_err(|error| error.to_string())?;
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

fn save_connection_config_file(app: &AppHandle, connection: &ConnectionConfig) -> Result<(), String> {
    let config_path = app_config_path(app)?;
    let encoded = serde_json::to_string_pretty(connection).map_err(|error| error.to_string())?;
    fs::write(config_path, encoded).map_err(|error| error.to_string())
}

fn build_runtime_status(connection: &ConnectionConfig) -> RuntimeStatus {
    match connection {
        ConnectionConfig::Host { .. } => RuntimeStatus {
            active_mode: "host".to_string(),
            host_supported: is_desktop_platform(),
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
    }
    if let Some(web_host_child) = children.web_host.as_mut() {
        let _ = web_host_child.kill();
    }
    children.server = None;
    children.web_host = None;
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

    let server_path = sidecar_binary_path(app, "farfield-server.exe")?;
    let web_host_path = sidecar_binary_path(app, "web-host.exe")?;

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

fn refresh_runtime_for_connection(connection: &ConnectionConfig, runtime: &mut RuntimeStatus) {
    *runtime = build_runtime_status(connection);
    if matches!(connection, ConnectionConfig::Host { .. }) {
        runtime.server4311_status.state = "running".to_string();
        runtime.web4312_status.state = "running".to_string();
    }
}

fn redirect_host_window(app: &AppHandle, connection: &ConnectionConfig) {
    if !matches!(connection, ConnectionConfig::Host { .. }) {
        return;
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval("window.location.replace('http://127.0.0.1:4312');");
    }
}

#[tauri::command]
fn farfield_get_bootstrap(state: State<AppStateInner>) -> Bootstrap {
    let connection = state
        .connection
        .lock()
        .expect("connection mutex poisoned")
        .clone();
    let runtime = state.runtime.lock().expect("runtime mutex poisoned").clone();

    Bootstrap { connection, runtime }
}

#[tauri::command]
fn farfield_get_runtime_status(state: State<AppStateInner>) -> RuntimeStatus {
    state.runtime.lock().expect("runtime mutex poisoned").clone()
}

#[tauri::command]
fn farfield_set_connection_config(
    app: AppHandle,
    state: State<AppStateInner>,
    config_json: String,
) -> Result<ConnectionConfig, String> {
    let next_connection =
        serde_json::from_str::<ConnectionConfig>(&config_json).map_err(|error| error.to_string())?;
    validate_connection_config(&next_connection)?;
    save_connection_config_file(&app, &next_connection)?;

    {
        let mut connection = state.connection.lock().expect("connection mutex poisoned");
        *connection = next_connection.clone();
    }

    {
        let mut runtime = state.runtime.lock().expect("runtime mutex poisoned");
        refresh_runtime_for_connection(&next_connection, &mut runtime);
    }

    {
        let mut children = state.children.lock().expect("children mutex poisoned");
        if matches!(next_connection, ConnectionConfig::Host { .. }) {
            start_desktop_host_children(&app, &next_connection, &mut children)?;
        } else {
            stop_children(&mut children);
        }
    }

    redirect_host_window(&app, &next_connection);

    Ok(next_connection)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let connection = load_connection_config(&app.handle());
            let runtime = build_runtime_status(&connection);
            let state = AppStateInner {
                connection: Mutex::new(connection.clone()),
                runtime: Mutex::new(runtime.clone()),
                children: Mutex::new(ManagedChildren::new()),
            };

            app.manage(state);

            if matches!(connection, ConnectionConfig::Host { .. }) {
                let app_state: State<'_, AppStateInner> = app.state();
                let mut children = app_state.children.lock().expect("children mutex poisoned");
                start_desktop_host_children(&app.handle(), &connection, &mut children)?;
                drop(children);
                let mut runtime_state = app_state.runtime.lock().expect("runtime mutex poisoned");
                refresh_runtime_for_connection(&connection, &mut runtime_state);
                drop(runtime_state);
                redirect_host_window(&app.handle(), &connection);
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            farfield_get_bootstrap,
            farfield_get_runtime_status,
            farfield_set_connection_config
        ])
        .run(tauri::generate_context!())
        .expect("error while running Farfield Tauri app");
}

// T-452: official TDLib JSON runtime for the desktop shell.
//
// The web bundle sees a tiny invoke/event bridge. This module dynamically loads the official tdjson
// library (a canonical packaged resource or explicit absolute native path), owns the single global receive
// loop required by TDLib,
// routes responses by @client_id, and keeps all database/file paths inside app_data/connectors/telegram.

use std::{
    collections::{HashMap, HashSet},
    ffi::{CStr, CString},
    os::raw::{c_char, c_double, c_int},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex,
    },
    thread,
    time::Duration,
};

use base64::{
    engine::general_purpose::{STANDARD as BASE64_STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use libloading::Library;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use zeroize::Zeroizing;

const EVENT_NAME: &str = "gc://telegram";
const MAX_REQUEST_BYTES: usize = 4 * 1024 * 1024;
const MAX_TELEGRAM_CLIENTS: usize = 8;

type TdCreateClientId = unsafe extern "C" fn() -> c_int;
type TdSend = unsafe extern "C" fn(c_int, *const c_char);
type TdReceive = unsafe extern "C" fn(c_double) -> *const c_char;
type TdExecute = unsafe extern "C" fn(*const c_char) -> *const c_char;

struct Runtime {
    _library: Library,
    create_client_id: TdCreateClientId,
    send: TdSend,
    receive: TdReceive,
    execute: TdExecute,
}

// Function pointers are immutable and TDLib documents send/execute as thread-safe. receive is called by
// exactly one dedicated thread created below. The Library stays owned by Runtime for the entire process.
unsafe impl Send for Runtime {}
unsafe impl Sync for Runtime {}

impl Runtime {
    unsafe fn load(path: &Path) -> Result<Self, String> {
        let library =
            Library::new(path).map_err(|_| "failed to load tdjson library".to_string())?;
        let create_client_id = *library
            .get::<TdCreateClientId>(b"td_create_client_id\0")
            .map_err(|_| "tdjson misses td_create_client_id".to_string())?;
        let send = *library
            .get::<TdSend>(b"td_send\0")
            .map_err(|_| "tdjson misses td_send".to_string())?;
        let receive = *library
            .get::<TdReceive>(b"td_receive\0")
            .map_err(|_| "tdjson misses td_receive".to_string())?;
        let execute = *library
            .get::<TdExecute>(b"td_execute\0")
            .map_err(|_| "tdjson misses td_execute".to_string())?;
        Ok(Self {
            _library: library,
            create_client_id,
            send,
            receive,
            execute,
        })
    }

    fn execute_json(&self, request: &str) -> Result<Option<String>, String> {
        let request =
            CString::new(request).map_err(|_| "TDLib request contains NUL".to_string())?;
        let ptr = unsafe { (self.execute)(request.as_ptr()) };
        if ptr.is_null() {
            return Ok(None);
        }
        let response = unsafe { CStr::from_ptr(ptr) }
            .to_str()
            .map_err(|_| "TDLib returned invalid UTF-8".to_string())?
            .to_owned();
        Ok(Some(response))
    }

    fn send_json(&self, client_id: c_int, request: &str) -> Result<(), String> {
        let request =
            CString::new(request).map_err(|_| "TDLib request contains NUL".to_string())?;
        unsafe { (self.send)(client_id, request.as_ptr()) };
        Ok(())
    }
}

#[derive(Default)]
struct ConnectorVaultLeases {
    scopes_by_lease: HashMap<String, String>,
    leases_by_scope: HashMap<String, String>,
    uses_by_lease: HashMap<String, usize>,
    destructive_leases: HashSet<String>,
}

impl ConnectorVaultLeases {
    fn claim_with(&mut self, scope: &str, lease: String) -> Result<String, String> {
        if self.leases_by_scope.contains_key(scope) {
            return Err("connector vault scope is already claimed".to_string());
        }
        if self.scopes_by_lease.contains_key(&lease) {
            return Err("connector vault capability collision".to_string());
        }
        self.leases_by_scope
            .insert(scope.to_string(), lease.clone());
        self.scopes_by_lease
            .insert(lease.clone(), scope.to_string());
        self.uses_by_lease.insert(lease.clone(), 0);
        Ok(lease)
    }

    fn scope_for(&self, lease: &str) -> Result<&str, String> {
        self.scopes_by_lease
            .get(lease)
            .map(String::as_str)
            .ok_or_else(|| "invalid connector vault capability".to_string())
    }

    fn scope_for_access(&self, lease: &str) -> Result<&str, String> {
        if self.destructive_leases.contains(lease) {
            return Err(
                "connector vault capability is reserved for destructive cleanup".to_string(),
            );
        }
        self.scope_for(lease)
    }

    fn acquire(&mut self, lease: &str) -> Result<String, String> {
        if self.destructive_leases.contains(lease) {
            return Err(
                "connector vault capability is reserved for destructive cleanup".to_string(),
            );
        }
        let scope = self.scope_for(lease)?.to_string();
        let uses = self
            .uses_by_lease
            .get_mut(lease)
            .ok_or_else(|| "invalid connector vault capability".to_string())?;
        *uses = uses
            .checked_add(1)
            .ok_or_else(|| "connector vault capability use overflow".to_string())?;
        Ok(scope)
    }

    fn release_use(&mut self, lease: &str, scope: &str) {
        if self.scopes_by_lease.get(lease).map(String::as_str) != Some(scope) {
            return;
        }
        if let Some(uses) = self.uses_by_lease.get_mut(lease) {
            *uses = uses.saturating_sub(1);
        }
    }

    fn begin_destructive(&mut self, lease: &str) -> Result<String, String> {
        let scope = self.scope_for(lease)?.to_string();
        if self.in_use(lease) || !self.destructive_leases.insert(lease.to_string()) {
            return Err(
                "connector vault capability is in use by an opening or active operation"
                    .to_string(),
            );
        }
        Ok(scope)
    }

    fn end_destructive(&mut self, lease: &str, scope: &str) {
        if self.scopes_by_lease.get(lease).map(String::as_str) == Some(scope) {
            self.destructive_leases.remove(lease);
        }
    }

    fn in_use(&self, lease: &str) -> bool {
        self.uses_by_lease.get(lease).copied().unwrap_or(0) > 0
    }

    fn release(&mut self, lease: &str) -> bool {
        if self.in_use(lease) || self.destructive_leases.contains(lease) {
            return false;
        }
        if let Some(scope) = self.scopes_by_lease.remove(lease) {
            self.leases_by_scope.remove(&scope);
        }
        self.uses_by_lease.remove(lease);
        self.destructive_leases.remove(lease);
        true
    }
}

struct TelegramClientRecord {
    td_client_id: c_int,
    owner_label: String,
    connector_scope: String,
    storage_scope: String,
    vault_capability: String,
    database_directory: String,
    files_directory: String,
    database_key: Zeroizing<String>,
    closed: Arc<(Mutex<bool>, Condvar)>,
}

#[derive(Default)]
struct TelegramClients {
    by_handle: HashMap<String, TelegramClientRecord>,
    opening_connector_scopes: HashSet<String>,
    opening_storage_scopes: HashSet<String>,
    wiping_connector_scopes: HashSet<String>,
}

impl TelegramClients {
    fn reserved_client_count(&self) -> usize {
        let mut scopes = self.opening_connector_scopes.clone();
        scopes.extend(
            self.by_handle
                .values()
                .map(|record| record.connector_scope.clone()),
        );
        scopes.len()
    }

    fn is_storage_scope_active(&self, scope: &str) -> bool {
        self.by_handle
            .values()
            .any(|record| record.storage_scope == scope)
    }

    fn is_connector_scope_active(&self, scope: &str) -> bool {
        self.by_handle
            .values()
            .any(|record| record.connector_scope == scope)
    }

    fn reserve_opening(
        &mut self,
        connector_scope: &str,
        storage_scope: &str,
    ) -> Result<(), String> {
        if self.is_connector_scope_active(connector_scope)
            || self.opening_connector_scopes.contains(connector_scope)
            || self.wiping_connector_scopes.contains(connector_scope)
        {
            return Err("connector vault scope already has an active client".to_string());
        }
        if self.is_storage_scope_active(storage_scope)
            || self.opening_storage_scopes.contains(storage_scope)
        {
            return Err("Telegram storage scope already has an active client".to_string());
        }
        if self.reserved_client_count() >= MAX_TELEGRAM_CLIENTS {
            return Err("Telegram native client limit reached".to_string());
        }
        self.opening_connector_scopes
            .insert(connector_scope.to_string());
        self.opening_storage_scopes
            .insert(storage_scope.to_string());
        Ok(())
    }

    fn release_opening(&mut self, connector_scope: &str, storage_scope: &str) {
        self.opening_connector_scopes.remove(connector_scope);
        self.opening_storage_scopes.remove(storage_scope);
    }

    fn reserve_wipe(
        &mut self,
        connector_scope: &str,
        storage_scope: Option<&str>,
    ) -> Result<(), String> {
        if self.is_connector_scope_active(connector_scope)
            || self.opening_connector_scopes.contains(connector_scope)
            || self.wiping_connector_scopes.contains(connector_scope)
            || storage_scope.is_some_and(|scope| {
                self.is_storage_scope_active(scope) || self.opening_storage_scopes.contains(scope)
            })
        {
            return Err("TDLib client must be closed before wiping storage".to_string());
        }
        self.wiping_connector_scopes
            .insert(connector_scope.to_string());
        Ok(())
    }

    fn release_wipe(&mut self, connector_scope: &str) {
        self.wiping_connector_scopes.remove(connector_scope);
    }

    fn route_for_td_client(
        &self,
        td_client_id: c_int,
    ) -> Option<(String, String, Arc<(Mutex<bool>, Condvar)>)> {
        self.by_handle.iter().find_map(|(handle, record)| {
            (record.td_client_id == td_client_id).then(|| {
                (
                    handle.clone(),
                    record.owner_label.clone(),
                    Arc::clone(&record.closed),
                )
            })
        })
    }
}

#[derive(Default)]
pub struct TelegramState {
    runtime: Mutex<Option<Arc<Runtime>>>,
    clients: Mutex<TelegramClients>,
    vault: Mutex<ConnectorVaultLeases>,
    receiver_started: AtomicBool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramInfo {
    available: bool,
    configured: bool,
    version: Option<String>,
    reason: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramCreateOptions {
    log_verbosity: i32,
    vault_capability: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramClientInfo {
    client_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TelegramEvent {
    client_id: String,
    response_json: String,
}

fn telegram_credentials() -> Option<(i32, String)> {
    // Both bindings are reassigned by the debug_assertions block below and by nothing else, so a
    // release build reports them as needlessly mutable. Silencing the lint outright would also
    // silence it for debug builds, where a genuinely unused `mut` here would be a real mistake worth
    // hearing about; scoping the allow to release keeps the lint alive exactly where it can fire.
    #[cfg_attr(not(debug_assertions), allow(unused_mut))]
    let mut raw_id = option_env!("GC_TELEGRAM_API_ID").map(ToOwned::to_owned);
    #[cfg_attr(not(debug_assertions), allow(unused_mut))]
    let mut api_hash = option_env!("GC_TELEGRAM_API_HASH").map(ToOwned::to_owned);
    // Local debug shells may inject throwaway development credentials at process start. Release artifacts
    // accept compile-time native configuration only, keeping launch environment outside the trust boundary.
    #[cfg(debug_assertions)]
    {
        if raw_id.is_none() {
            raw_id = std::env::var("GC_TELEGRAM_API_ID").ok();
        }
        if api_hash.is_none() {
            api_hash = std::env::var("GC_TELEGRAM_API_HASH").ok();
        }
    }
    let raw_id = raw_id?;
    let api_hash = api_hash?;
    let api_id = raw_id.parse::<i32>().ok().filter(|id| *id > 0)?;
    if !(16..=128).contains(&api_hash.len()) || !api_hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    Some((api_id, api_hash))
}

fn inject_credentials_with(
    value: &mut serde_json::Value,
    credentials: Option<(i32, String)>,
) -> Result<(), String> {
    let Some(object) = value.as_object_mut() else {
        return Err("TDLib request must be a JSON object".to_string());
    };
    if object.get("@type").and_then(serde_json::Value::as_str) != Some("setTdlibParameters") {
        return Ok(());
    }
    let (api_id, api_hash) = credentials
        .ok_or_else(|| "Telegram application credentials are not configured".to_string())?;
    // Shared JS is not allowed to supply/override credentials. Native code is the sole source of truth.
    object.insert("api_id".to_string(), serde_json::json!(api_id));
    object.insert("api_hash".to_string(), serde_json::json!(api_hash));
    Ok(())
}

fn inject_native_parameters_with(
    value: &mut serde_json::Value,
    credentials: Option<(i32, String)>,
    database_key: &str,
    database_directory: &str,
    files_directory: &str,
) -> Result<(), String> {
    inject_credentials_with(value, credentials)?;
    let Some(object) = value.as_object_mut() else {
        return Err("TDLib request must be a JSON object".to_string());
    };
    if object.get("@type").and_then(serde_json::Value::as_str) != Some("setTdlibParameters") {
        return Ok(());
    }
    if !valid_database_key(database_key) {
        return Err("Telegram database key is unavailable".to_string());
    }
    object.insert(
        "database_encryption_key".to_string(),
        serde_json::json!(database_key),
    );
    object.insert(
        "database_directory".to_string(),
        serde_json::json!(database_directory),
    );
    object.insert(
        "files_directory".to_string(),
        serde_json::json!(files_directory),
    );
    Ok(())
}

fn reject_untrusted_local_file_inputs(value: &serde_json::Value) -> Result<(), String> {
    const MAX_DEPTH: usize = 32;
    const MAX_NODES: usize = 2_048;

    fn visit(value: &serde_json::Value, depth: usize, nodes: &mut usize) -> Result<(), String> {
        *nodes += 1;
        if *nodes > MAX_NODES || depth > MAX_DEPTH {
            return Err("TDLib request provider extension is too complex".to_string());
        }
        match value {
            serde_json::Value::Array(items) => {
                for item in items {
                    visit(item, depth + 1, nodes)?;
                }
            }
            serde_json::Value::Object(object) => {
                if matches!(
                    object.get("@type").and_then(serde_json::Value::as_str),
                    Some("inputFileLocal" | "inputFileGenerated")
                ) {
                    return Err(
                        "TDLib request contains an untrusted local file reference".to_string()
                    );
                }
                for child in object.values() {
                    visit(child, depth + 1, nodes)?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    visit(value, 0, &mut 0)
}

fn valid_scope(scope: &str) -> bool {
    let bytes = scope.as_bytes();
    (19..=131).contains(&bytes.len())
        && scope.starts_with("tg_")
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'-')
}

fn valid_child_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 131
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

fn secure_child_dir(parent: &Path, name: &str) -> Result<PathBuf, String> {
    if !valid_child_name(name) {
        return Err("invalid connector storage path".to_string());
    }
    let parent = parent
        .canonicalize()
        .map_err(|_| "connector storage root is unavailable".to_string())?;
    let target = parent.join(name);
    match std::fs::symlink_metadata(&target) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err("invalid connector storage path".to_string());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir(&target)
                .map_err(|_| "failed to create connector storage directory".to_string())?;
        }
        Err(_) => return Err("connector storage path is unavailable".to_string()),
    }
    let canonical = target
        .canonicalize()
        .map_err(|_| "connector storage path is unavailable".to_string())?;
    if canonical.parent() != Some(parent.as_path()) {
        return Err("invalid connector storage path".to_string());
    }
    Ok(canonical)
}

fn connector_base(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|_| "app data directory is unavailable".to_string())?;
    std::fs::create_dir_all(&app_data)
        .map_err(|_| "app data directory is unavailable".to_string())?;
    let app_data = app_data
        .canonicalize()
        .map_err(|_| "app data directory is unavailable".to_string())?;
    let connectors = secure_child_dir(&app_data, "connectors")?;
    secure_child_dir(&connectors, "telegram")
}

fn create_connector_root(app: &AppHandle, scope: &str) -> Result<PathBuf, String> {
    if !valid_scope(scope) {
        return Err("invalid Telegram storage scope".to_string());
    }
    secure_child_dir(&connector_base(app)?, scope)
}

fn existing_connector_root(app: &AppHandle, scope: &str) -> Result<Option<PathBuf>, String> {
    if !valid_scope(scope) {
        return Err("invalid Telegram storage scope".to_string());
    }
    let base = connector_base(app)?;
    let target = base.join(scope);
    let metadata = match std::fs::symlink_metadata(&target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("connector storage path is unavailable".to_string()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("invalid connector storage path".to_string());
    }
    let canonical = target
        .canonicalize()
        .map_err(|_| "connector storage path is unavailable".to_string())?;
    if canonical.parent() != Some(base.as_path()) {
        return Err("invalid connector storage path".to_string());
    }
    Ok(Some(canonical))
}

fn library_filename() -> &'static str {
    #[cfg(target_os = "windows")]
    return "tdjson.dll";
    #[cfg(target_os = "macos")]
    return "libtdjson.dylib";
    #[cfg(target_os = "linux")]
    return "libtdjson.so";
}

fn canonical_library_file(path: &Path, trusted_root: Option<&Path>) -> Option<PathBuf> {
    // Never delegate a relative/bare name to the platform loader search path.
    if !path.is_absolute() {
        return None;
    }
    let canonical = path.canonicalize().ok()?;
    if !canonical.is_file() || canonical.file_name()?.to_str()? != library_filename() {
        return None;
    }
    if let Some(root) = trusted_root {
        let root = root.canonicalize().ok()?;
        if !canonical.starts_with(root) {
            return None;
        }
    }
    Some(canonical)
}

fn library_candidates(app: &AppHandle) -> Vec<PathBuf> {
    let mut out = Vec::new();
    // An unpackaged override is development-only. Release builds load only the signed packaged resource;
    // process environment must not redirect the dynamic loader to attacker-controlled native code.
    #[cfg(debug_assertions)]
    if let Ok(path) = std::env::var("GC_TDLIB_PATH") {
        if let Some(candidate) = canonical_library_file(Path::new(path.trim()), None) {
            out.push(candidate);
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        let candidate = resource_dir.join("tdlib").join(library_filename());
        if let Some(candidate) = canonical_library_file(&candidate, Some(&resource_dir)) {
            if !out.contains(&candidate) {
                out.push(candidate);
            }
        }
    }
    out
}

fn load_runtime(app: &AppHandle) -> Result<Arc<Runtime>, String> {
    let state = app.state::<TelegramState>();
    let mut guard = state
        .runtime
        .lock()
        .map_err(|_| "Telegram runtime lock poisoned".to_string())?;
    if let Some(runtime) = guard.as_ref() {
        return Ok(runtime.clone());
    }
    for candidate in library_candidates(app) {
        // Loading foreign native code is confined to the official TDLib path selected by packaging/operator.
        if let Ok(runtime) = unsafe { Runtime::load(&candidate) } {
            let runtime = Arc::new(runtime);
            *guard = Some(runtime.clone());
            return Ok(runtime);
        }
    }
    Err("official tdjson runtime is not installed".to_string())
}

fn runtime_version(runtime: &Runtime) -> Option<String> {
    let raw = runtime
        .execute_json(r#"{"@type":"getOption","name":"version"}"#)
        .ok()
        .flatten()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    value.get("value")?.as_str().map(ToOwned::to_owned)
}

fn response_is_authorization_closed(value: &serde_json::Value) -> bool {
    value.get("@type").and_then(serde_json::Value::as_str) == Some("updateAuthorizationState")
        && value
            .get("authorization_state")
            .and_then(|state| state.get("@type"))
            .and_then(serde_json::Value::as_str)
            == Some("authorizationStateClosed")
}

fn start_receiver(app: &AppHandle, runtime: Arc<Runtime>) -> Result<(), String> {
    let state = app.state::<TelegramState>();
    if state.receiver_started.swap(true, Ordering::AcqRel) {
        return Ok(());
    }
    let handle = app.clone();
    let spawn = thread::Builder::new()
        .name("gc-tdlib-receive".to_string())
        .spawn(move || loop {
            let ptr = unsafe { (runtime.receive)(1.0) };
            if ptr.is_null() {
                continue;
            }
            let response = match unsafe { CStr::from_ptr(ptr) }.to_str() {
                Ok(value) => value.to_owned(),
                Err(_) => continue,
            };
            let parsed = match serde_json::from_str::<serde_json::Value>(&response) {
                Ok(value) => value,
                Err(_) => continue,
            };
            let client_id = parsed
                .get("@client_id")
                .and_then(serde_json::Value::as_i64)
                .and_then(|id| c_int::try_from(id).ok());
            let Some(client_id) = client_id else {
                continue;
            };
            let route = handle
                .state::<TelegramState>()
                .clients
                .lock()
                .ok()
                .and_then(|clients| clients.route_for_td_client(client_id));
            let Some((client_handle, owner_label, closed)) = route else {
                continue;
            };
            if response_is_authorization_closed(&parsed) {
                let (lock, signal) = &*closed;
                if let Ok(mut value) = lock.lock() {
                    *value = true;
                    signal.notify_all();
                }
            }
            if let Some(owner) = handle.get_webview_window(&owner_label) {
                let _ = owner.emit(
                    EVENT_NAME,
                    TelegramEvent {
                        client_id: client_handle,
                        response_json: response,
                    },
                );
            }
        });
    match spawn {
        Ok(_) => Ok(()),
        Err(_) => {
            app.state::<TelegramState>()
                .receiver_started
                .store(false, Ordering::Release);
            Err("failed to start TDLib receive loop".to_string())
        }
    }
}

#[tauri::command]
pub fn telegram_info(app: AppHandle) -> TelegramInfo {
    let configured = telegram_credentials().is_some();
    match load_runtime(&app) {
        Ok(runtime) => match start_receiver(&app, runtime.clone()) {
            Ok(()) => TelegramInfo {
                available: true,
                configured,
                version: runtime_version(&runtime),
                reason: None,
            },
            Err(reason) => TelegramInfo {
                available: false,
                configured,
                version: None,
                reason: Some(reason),
            },
        },
        Err(reason) => TelegramInfo {
            available: false,
            configured,
            version: None,
            reason: Some(reason),
        },
    }
}

fn new_client_handle() -> Result<String, String> {
    let mut bytes = [0_u8; 24];
    getrandom::getrandom(&mut bytes)
        .map_err(|_| "secure Telegram client handle randomness is unavailable".to_string())?;
    let mut handle = String::with_capacity(4 + bytes.len() * 2);
    handle.push_str("tdc.");
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut handle, "{byte:02x}")
            .map_err(|_| "Telegram client handle generation failed".to_string())?;
    }
    Ok(handle)
}

fn valid_database_key(value: &str) -> bool {
    BASE64_STANDARD
        .decode(value)
        .map(|bytes| bytes.len() == 32 && BASE64_STANDARD.encode(bytes) == value)
        .unwrap_or(false)
}

fn read_database_key(scope: &str) -> Result<Option<Zeroizing<String>>, String> {
    match vault_entry(scope, TELEGRAM_TDLIB_DB_KEY_NAME)?.get_password() {
        Ok(value) if valid_database_key(&value) => Ok(Some(Zeroizing::new(value))),
        Ok(_) => Err("Telegram database key is corrupt".to_string()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("connector vault is unavailable".to_string()),
    }
}

fn write_database_key(scope: &str, value: &str) -> Result<(), String> {
    if !valid_database_key(value) {
        return Err("Telegram database key is invalid".to_string());
    }
    let mut names = vault_index(scope)?;
    vault_entry(scope, TELEGRAM_TDLIB_DB_KEY_NAME)?
        .set_password(value)
        .map_err(|_| "connector vault is unavailable".to_string())?;
    if !names.iter().any(|name| name == TELEGRAM_TDLIB_DB_KEY_NAME) {
        names.push(TELEGRAM_TDLIB_DB_KEY_NAME.to_string());
        names.sort();
        names.dedup();
        save_vault_index(scope, &names)?;
    }
    Ok(())
}

fn get_or_create_database_key(scope: &str) -> Result<Zeroizing<String>, String> {
    if let Some(key) = read_database_key(scope)? {
        return Ok(key);
    }
    let mut raw = [0_u8; 32];
    getrandom::getrandom(&mut raw)
        .map_err(|_| "secure Telegram database key randomness is unavailable".to_string())?;
    let encoded = Zeroizing::new(BASE64_STANDARD.encode(raw));
    raw.fill(0);
    write_database_key(scope, encoded.as_str())?;
    Ok(encoded)
}

fn delete_database_key(scope: &str) -> Result<(), String> {
    match vault_entry(scope, TELEGRAM_TDLIB_DB_KEY_NAME)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(_) => return Err("connector vault is unavailable".to_string()),
    }
    let mut names = vault_index(scope)?;
    names.retain(|name| name != TELEGRAM_TDLIB_DB_KEY_NAME);
    save_vault_index(scope, &names)
}

fn decode_bound_storage_scope(encoded: &str) -> Result<String, String> {
    if !valid_vault_base64(encoded) {
        return Err("connector vault storage binding is corrupt".to_string());
    }
    let bytes = BASE64_STANDARD
        .decode(encoded)
        .map_err(|_| "connector vault storage binding is corrupt".to_string())?;
    if BASE64_STANDARD.encode(&bytes) != encoded {
        return Err("connector vault storage binding is corrupt".to_string());
    }
    let scope = String::from_utf8(bytes)
        .map_err(|_| "connector vault storage binding is corrupt".to_string())?;
    if !valid_scope(&scope) {
        return Err("connector vault storage binding is invalid".to_string());
    }
    Ok(scope)
}

fn new_storage_scope() -> Result<String, String> {
    let mut raw = [0_u8; 18];
    getrandom::getrandom(&mut raw)
        .map_err(|_| "secure Telegram storage scope randomness is unavailable".to_string())?;
    let scope = format!("tg_{}", URL_SAFE_NO_PAD.encode(raw));
    raw.fill(0);
    if !valid_scope(&scope) {
        return Err("generated Telegram storage scope is invalid".to_string());
    }
    Ok(scope)
}

fn write_storage_scope_binding(connector_scope: &str, storage_scope: &str) -> Result<(), String> {
    if !valid_scope(storage_scope) {
        return Err("Telegram storage scope is invalid".to_string());
    }
    let encoded = BASE64_STANDARD.encode(storage_scope.as_bytes());
    let mut names = vault_index(connector_scope)?;
    vault_entry(connector_scope, TELEGRAM_TDLIB_STORAGE_SCOPE_NAME)?
        .set_password(&encoded)
        .map_err(|_| "connector vault is unavailable".to_string())?;
    if !names
        .iter()
        .any(|name| name == TELEGRAM_TDLIB_STORAGE_SCOPE_NAME)
    {
        names.push(TELEGRAM_TDLIB_STORAGE_SCOPE_NAME.to_string());
        names.sort();
        names.dedup();
        if let Err(error) = save_vault_index(connector_scope, &names) {
            let _ =
                vault_entry(connector_scope, TELEGRAM_TDLIB_STORAGE_SCOPE_NAME).and_then(|entry| {
                    entry
                        .delete_credential()
                        .map_err(|_| "connector vault rollback failed".to_string())
                });
            return Err(error);
        }
    }
    Ok(())
}

fn read_storage_scope_binding(connector_scope: &str) -> Result<Option<String>, String> {
    match vault_entry(connector_scope, TELEGRAM_TDLIB_STORAGE_SCOPE_NAME)?.get_password() {
        Ok(value) => decode_bound_storage_scope(&value).map(Some),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("connector vault is unavailable".to_string()),
    }
}

struct WipeStorageBinding {
    storage_scope: Option<String>,
    corrupt: bool,
}

fn read_storage_scope_binding_for_wipe(
    connector_scope: &str,
) -> Result<WipeStorageBinding, String> {
    match vault_entry(connector_scope, TELEGRAM_TDLIB_STORAGE_SCOPE_NAME)?.get_password() {
        Ok(value) => match decode_bound_storage_scope(&value) {
            Ok(scope) => Ok(WipeStorageBinding {
                storage_scope: Some(scope),
                corrupt: false,
            }),
            Err(_) => Ok(WipeStorageBinding {
                storage_scope: None,
                corrupt: true,
            }),
        },
        Err(keyring::Error::NoEntry) => Ok(WipeStorageBinding {
            storage_scope: None,
            corrupt: false,
        }),
        Err(_) => Err("connector vault is unavailable".to_string()),
    }
}

fn remove_storage_scope_binding(connector_scope: &str) -> Result<(), String> {
    match vault_entry(connector_scope, TELEGRAM_TDLIB_STORAGE_SCOPE_NAME)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(_) => return Err("connector vault is unavailable".to_string()),
    }
    let mut names = vault_index(connector_scope)?;
    names.retain(|name| name != TELEGRAM_TDLIB_STORAGE_SCOPE_NAME);
    save_vault_index(connector_scope, &names)
}

fn get_or_create_storage_scope(connector_scope: &str) -> Result<String, String> {
    if let Some(scope) = read_storage_scope_binding(connector_scope)? {
        return Ok(scope);
    }
    let scope = new_storage_scope()?;
    write_storage_scope_binding(connector_scope, &scope)?;
    Ok(scope)
}

fn acquire_connector_scope_with_storage(
    state: &TelegramState,
    capability: &str,
) -> Result<(String, String), String> {
    // Keep the process-local capability registry locked while resolving the native-only binding. This
    // serializes two concurrent first-launch requests and prevents different tg_* values racing to persist.
    let mut leases = state
        .vault
        .lock()
        .map_err(|_| "connector vault lock poisoned".to_string())?;
    let connector_scope = leases.acquire(capability)?;
    match get_or_create_storage_scope(&connector_scope) {
        Ok(storage_scope) => Ok((connector_scope, storage_scope)),
        Err(error) => {
            leases.release_use(capability, &connector_scope);
            Err(error)
        }
    }
}

fn acquire_wipe_scope_and_reserve(
    state: &TelegramState,
    capability: &str,
) -> Result<(String, WipeStorageBinding), String> {
    // Lock order is vault -> clients, identical to create. No secret or filesystem mutation occurs until
    // the reservation has proved that this connector scope has no active/opening client.
    let mut leases = state
        .vault
        .lock()
        .map_err(|_| "connector vault lock poisoned".to_string())?;
    let connector_scope = leases.acquire(capability)?;
    let binding = match read_storage_scope_binding_for_wipe(&connector_scope) {
        Ok(binding) => binding,
        Err(error) => {
            leases.release_use(capability, &connector_scope);
            return Err(error);
        }
    };
    let mut clients = match state.clients.lock() {
        Ok(clients) => clients,
        Err(_) => {
            leases.release_use(capability, &connector_scope);
            return Err("Telegram client registry lock poisoned".to_string());
        }
    };
    if let Err(error) = clients.reserve_wipe(&connector_scope, binding.storage_scope.as_deref()) {
        leases.release_use(capability, &connector_scope);
        return Err(error);
    }
    Ok((connector_scope, binding))
}

fn release_vault_use(state: &TelegramState, capability: &str, connector_scope: &str) {
    if let Ok(mut leases) = state.vault.lock() {
        leases.release_use(capability, connector_scope);
    }
}

#[tauri::command]
pub fn telegram_create(
    app: AppHandle,
    webview: WebviewWindow,
    options: TelegramCreateOptions,
) -> Result<TelegramClientInfo, String> {
    let capability = options
        .vault_capability
        .as_deref()
        .ok_or_else(|| "connector vault capability is required".to_string())?;
    let state = app.state::<TelegramState>();
    let (connector_scope, storage_scope) =
        acquire_connector_scope_with_storage(&state, capability)?;
    {
        let mut clients = match state.clients.lock() {
            Ok(clients) => clients,
            Err(_) => {
                release_vault_use(&state, capability, &connector_scope);
                return Err("Telegram client registry lock poisoned".to_string());
            }
        };
        if let Err(error) = clients.reserve_opening(&connector_scope, &storage_scope) {
            release_vault_use(&state, capability, &connector_scope);
            return Err(error);
        }
    }

    let result = (|| -> Result<TelegramClientInfo, String> {
        let runtime = load_runtime(&app)?;
        start_receiver(&app, runtime.clone())?;
        let existing = existing_connector_root(&app, &storage_scope)?;
        let existing_nonempty = existing
            .as_ref()
            .map(|root| {
                std::fs::read_dir(root)
                    .map(|mut entries| entries.next().is_some())
                    .unwrap_or(true)
            })
            .unwrap_or(false);
        let existing_key = read_database_key(&connector_scope)?;
        if existing_nonempty && existing_key.is_none() {
            if let Some(root) = existing {
                std::fs::remove_dir_all(root)
                    .map_err(|_| "failed to remove undecryptable TDLib storage".to_string())?;
            }
        }
        let root = create_connector_root(&app, &storage_scope)?;
        let database = secure_child_dir(&root, "database")?;
        let files = secure_child_dir(&root, "files")?;
        let database_key = match existing_key {
            Some(key) => key,
            None => get_or_create_database_key(&connector_scope)?,
        };

        let verbosity = options.log_verbosity.clamp(0, 5);
        let _ = runtime
            .execute_json(r#"{"@type":"setLogStream","log_stream":{"@type":"logStreamEmpty"}}"#);
        let _ = runtime.execute_json(&format!(
            r#"{{"@type":"setLogVerbosityLevel","new_verbosity_level":{verbosity}}}"#
        ));
        let mut clients = state
            .clients
            .lock()
            .map_err(|_| "Telegram client registry lock poisoned".to_string())?;
        if !clients.opening_connector_scopes.contains(&connector_scope)
            || !clients.opening_storage_scopes.contains(&storage_scope)
            || clients.is_connector_scope_active(&connector_scope)
            || clients.is_storage_scope_active(&storage_scope)
        {
            return Err("Telegram connector opening reservation was lost".to_string());
        }
        let mut client_handle = new_client_handle()?;
        for _ in 0..3 {
            if !clients.by_handle.contains_key(&client_handle) {
                break;
            }
            client_handle = new_client_handle()?;
        }
        if clients.by_handle.contains_key(&client_handle) {
            return Err("Telegram client handle collision".to_string());
        }
        let td_client_id = unsafe { (runtime.create_client_id)() };
        clients.by_handle.insert(
            client_handle.clone(),
            TelegramClientRecord {
                td_client_id,
                owner_label: webview.label().to_string(),
                connector_scope: connector_scope.clone(),
                storage_scope: storage_scope.clone(),
                vault_capability: capability.to_string(),
                database_directory: database.to_string_lossy().into_owned(),
                files_directory: files.to_string_lossy().into_owned(),
                database_key,
                closed: Arc::new((Mutex::new(false), Condvar::new())),
            },
        );
        clients.release_opening(&connector_scope, &storage_scope);
        Ok(TelegramClientInfo {
            client_id: client_handle,
        })
    })();

    if result.is_err() {
        if let Ok(mut clients) = state.clients.lock() {
            clients.release_opening(&connector_scope, &storage_scope);
        }
        release_vault_use(&state, capability, &connector_scope);
    }
    result
}

#[tauri::command]
pub fn telegram_send(
    app: AppHandle,
    webview: WebviewWindow,
    client_id: String,
    request_json: String,
) -> Result<(), String> {
    if request_json.len() > MAX_REQUEST_BYTES {
        return Err("TDLib request exceeds 4 MiB".to_string());
    }
    let mut value: serde_json::Value = serde_json::from_str(&request_json)
        .map_err(|_| "TDLib request is invalid JSON".to_string())?;
    reject_untrusted_local_file_inputs(&value)?;
    let state = app.state::<TelegramState>();
    let (td_client_id, outbound) = {
        let clients = state
            .clients
            .lock()
            .map_err(|_| "Telegram client registry lock poisoned".to_string())?;
        let record = clients
            .by_handle
            .get(&client_id)
            .ok_or_else(|| "unknown TDLib client handle".to_string())?;
        if record.owner_label != webview.label() {
            return Err("TDLib client handle belongs to another webview".to_string());
        }
        inject_native_parameters_with(
            &mut value,
            telegram_credentials(),
            record.database_key.as_str(),
            &record.database_directory,
            &record.files_directory,
        )?;
        let outbound = serde_json::to_string(&value)
            .map_err(|_| "TDLib request could not be serialized".to_string())?;
        (record.td_client_id, outbound)
    };
    load_runtime(&app)?.send_json(td_client_id, &outbound)
}

#[tauri::command]
pub fn telegram_close(
    app: AppHandle,
    webview: WebviewWindow,
    client_id: String,
) -> Result<(), String> {
    let state = app.state::<TelegramState>();
    let (td_client_id, closed, capability, connector_scope) = {
        let clients = state
            .clients
            .lock()
            .map_err(|_| "Telegram client registry lock poisoned".to_string())?;
        let Some(record) = clients.by_handle.get(&client_id) else {
            return Ok(());
        };
        if record.owner_label != webview.label() {
            return Err("TDLib client handle belongs to another webview".to_string());
        }
        (
            record.td_client_id,
            Arc::clone(&record.closed),
            record.vault_capability.clone(),
            record.connector_scope.clone(),
        )
    };
    load_runtime(&app)?.send_json(td_client_id, r#"{"@type":"close"}"#)?;
    let (lock, signal) = &*closed;
    let acknowledged = lock
        .lock()
        .map_err(|_| "Telegram close acknowledgement lock poisoned".to_string())?;
    let (acknowledged, _timeout) = signal
        .wait_timeout_while(acknowledged, Duration::from_secs(5), |closed| !*closed)
        .map_err(|_| "Telegram close acknowledgement lock poisoned".to_string())?;
    if !*acknowledged {
        return Err("TDLib did not confirm authorizationStateClosed".to_string());
    }
    let mut clients = state
        .clients
        .lock()
        .map_err(|_| "Telegram client registry lock poisoned".to_string())?;
    if clients
        .by_handle
        .get(&client_id)
        .is_some_and(|record| record.owner_label == webview.label())
    {
        clients.by_handle.remove(&client_id);
    }
    drop(clients);
    release_vault_use(&state, &capability, &connector_scope);
    Ok(())
}

#[tauri::command]
pub fn telegram_wipe(
    app: AppHandle,
    _webview: WebviewWindow,
    vault_capability: Option<String>,
) -> Result<(), String> {
    let capability = vault_capability
        .as_deref()
        .ok_or_else(|| "connector vault capability is required".to_string())?;
    let state = app.state::<TelegramState>();
    let (connector_scope, binding) = acquire_wipe_scope_and_reserve(&state, capability)?;
    let result = (|| -> Result<(), String> {
        // Cryptographic erase starts only after the exclusive native reservation. A corrupt binding is never
        // used as a path; a valid binding is kept until its directory has been removed successfully.
        delete_database_key(&connector_scope)?;
        if binding.corrupt {
            remove_storage_scope_binding(&connector_scope)?;
            return Ok(());
        }
        if let Some(storage_scope) = binding.storage_scope {
            if let Some(root) = existing_connector_root(&app, &storage_scope)? {
                std::fs::remove_dir_all(&root)
                    .map_err(|_| "failed to wipe TDLib storage".to_string())?;
            }
            remove_storage_scope_binding(&connector_scope)?;
        }
        Ok(())
    })();
    if let Ok(mut clients) = state.clients.lock() {
        clients.release_wipe(&connector_scope);
    }
    release_vault_use(&state, capability, &connector_scope);
    result
}

const CONNECTOR_VAULT_SERVICE: &str = "app.greenchat.connector-vault";
const CONNECTOR_VAULT_INDEX_NAME: &str = "__index__";
const TELEGRAM_TDLIB_DB_KEY_NAME: &str = "telegram.tdlib.database-key.v1";
const TELEGRAM_TDLIB_STORAGE_SCOPE_NAME: &str = "telegram.tdlib.storage-scope.v1";
const MAX_VAULT_VALUE_CHARS: usize = 96 * 1024;

fn valid_vault_token(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}

fn new_vault_lease() -> Result<String, String> {
    let mut bytes = [0_u8; 24];
    getrandom::getrandom(&mut bytes)
        .map_err(|_| "secure connector vault randomness is unavailable".to_string())?;
    let mut lease = String::with_capacity(6 + bytes.len() * 2);
    lease.push_str("lease.");
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut lease, "{byte:02x}")
            .map_err(|_| "connector vault capability failed".to_string())?;
    }
    Ok(lease)
}

fn valid_vault_base64(value: &str) -> bool {
    if value.len() > MAX_VAULT_VALUE_CHARS || value.len() % 4 != 0 {
        return false;
    }
    let padding = value.bytes().rev().take_while(|byte| *byte == b'=').count();
    if padding > 2 {
        return false;
    }
    let data_len = value.len().saturating_sub(padding);
    value.bytes().enumerate().all(|(index, byte)| {
        if index >= data_len {
            byte == b'='
        } else {
            byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/')
        }
    })
}

fn renderer_vault_name(name: &str) -> Result<(), String> {
    if name == TELEGRAM_TDLIB_DB_KEY_NAME
        || name == TELEGRAM_TDLIB_STORAGE_SCOPE_NAME
        || name == CONNECTOR_VAULT_INDEX_NAME
    {
        return Err("connector secret is native-only".to_string());
    }
    Ok(())
}

fn vault_user(scope: &str, name: &str) -> Result<String, String> {
    if !valid_vault_token(scope) || !valid_vault_token(name) {
        return Err("invalid connector vault token".to_string());
    }
    // Length-prefix the scope so permitted ':' characters can never alias another scope/name pair.
    Ok(format!("{}:{scope}:{name}", scope.len()))
}

fn vault_entry(scope: &str, name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(CONNECTOR_VAULT_SERVICE, &vault_user(scope, name)?)
        .map_err(|_| "connector vault is unavailable".to_string())
}

fn vault_index(scope: &str) -> Result<Vec<String>, String> {
    let entry = vault_entry(scope, CONNECTOR_VAULT_INDEX_NAME)?;
    match entry.get_password() {
        Ok(raw) => serde_json::from_str::<Vec<String>>(&raw)
            .map_err(|_| "connector vault index is corrupt".to_string()),
        Err(keyring::Error::NoEntry) => Ok(Vec::new()),
        Err(_) => Err("connector vault is unavailable".to_string()),
    }
}

fn save_vault_index(scope: &str, names: &[String]) -> Result<(), String> {
    let entry = vault_entry(scope, CONNECTOR_VAULT_INDEX_NAME)?;
    if names.is_empty() {
        return match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("connector vault is unavailable".to_string()),
        };
    }
    let value =
        serde_json::to_string(names).map_err(|_| "connector vault index failed".to_string())?;
    entry
        .set_password(&value)
        .map_err(|_| "connector vault is unavailable".to_string())
}

#[tauri::command]
pub fn connector_vault_claim(app: AppHandle, scope: String) -> Result<String, String> {
    if !valid_vault_token(&scope) {
        return Err("invalid connector vault token".to_string());
    }
    let state = app.state::<TelegramState>();
    let mut leases = state
        .vault
        .lock()
        .map_err(|_| "connector vault lock poisoned".to_string())?;
    let mut lease = new_vault_lease()?;
    for _ in 0..3 {
        if !leases.scopes_by_lease.contains_key(&lease) {
            return leases.claim_with(&scope, lease);
        }
        lease = new_vault_lease()?;
    }
    Err("connector vault capability collision".to_string())
}

#[tauri::command]
pub fn connector_vault_read(
    app: AppHandle,
    lease: String,
    name: String,
) -> Result<Option<String>, String> {
    renderer_vault_name(&name)?;
    let state = app.state::<TelegramState>();
    let leases = state
        .vault
        .lock()
        .map_err(|_| "connector vault lock poisoned".to_string())?;
    let scope = leases.scope_for_access(&lease)?;
    match vault_entry(scope, &name)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("connector vault is unavailable".to_string()),
    }
}

#[tauri::command]
pub fn connector_vault_write(
    app: AppHandle,
    lease: String,
    name: String,
    value_base64: String,
) -> Result<(), String> {
    renderer_vault_name(&name)?;
    if !valid_vault_base64(&value_base64) {
        return Err("invalid connector vault value".to_string());
    }
    let state = app.state::<TelegramState>();
    let leases = state
        .vault
        .lock()
        .map_err(|_| "connector vault lock poisoned".to_string())?;
    let scope = leases.scope_for_access(&lease)?;
    let mut names = vault_index(scope)?;
    vault_entry(scope, &name)?
        .set_password(&value_base64)
        .map_err(|_| "connector vault is unavailable".to_string())?;
    if !names.iter().any(|existing| existing == &name) {
        names.push(name.clone());
        names.sort();
        names.dedup();
        if let Err(error) = save_vault_index(scope, &names) {
            let _ = vault_entry(scope, &name).and_then(|entry| {
                entry
                    .delete_credential()
                    .map_err(|_| "connector vault rollback failed".to_string())
            });
            return Err(error);
        }
    }
    Ok(())
}

#[tauri::command]
pub fn connector_vault_remove(app: AppHandle, lease: String, name: String) -> Result<(), String> {
    renderer_vault_name(&name)?;
    let state = app.state::<TelegramState>();
    let leases = state
        .vault
        .lock()
        .map_err(|_| "connector vault lock poisoned".to_string())?;
    let scope = leases.scope_for_access(&lease)?;
    match vault_entry(scope, &name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => {}
        Err(_) => return Err("connector vault is unavailable".to_string()),
    }
    let mut names = vault_index(scope)?;
    names.retain(|existing| existing != &name);
    save_vault_index(scope, &names)
}

#[tauri::command]
pub fn connector_vault_wipe(app: AppHandle, lease: String) -> Result<(), String> {
    let state = app.state::<TelegramState>();
    let scope = {
        let mut leases = state
            .vault
            .lock()
            .map_err(|_| "connector vault lock poisoned".to_string())?;
        leases.begin_destructive(&lease)?
    };
    let result = (|| -> Result<(), String> {
        if state
            .clients
            .lock()
            .map_err(|_| "Telegram client registry lock poisoned".to_string())?
            .is_connector_scope_active(&scope)
        {
            return Err("connector vault scope has an active native client".to_string());
        }
        let storage_scope = read_storage_scope_binding_for_wipe(&scope)?.storage_scope;
        // Delete the encryption key before touching files or metadata. If directory cleanup fails, the
        // native binding remains available for an idempotent retry while the residual bytes are unreadable.
        delete_database_key(&scope)?;
        if let Some(storage_scope) = storage_scope {
            if let Some(root) = existing_connector_root(&app, &storage_scope)? {
                std::fs::remove_dir_all(&root)
                    .map_err(|_| "failed to wipe TDLib storage".to_string())?;
            }
        }
        let mut names = vault_index(&scope)?;
        names.retain(|name| name != TELEGRAM_TDLIB_DB_KEY_NAME);
        let mut failed = false;
        for name in &names {
            match vault_entry(&scope, name)?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => {}
                Err(_) => failed = true,
            }
        }
        if failed {
            return Err("connector vault wipe was incomplete".to_string());
        }
        save_vault_index(&scope, &[])
    })();
    let release_result = state
        .vault
        .lock()
        .map_err(|_| "connector vault lock poisoned".to_string())
        .map(|mut leases| leases.end_destructive(&lease, &scope));
    match (result, release_result) {
        (Err(error), _) => Err(error),
        (Ok(()), Err(error)) => Err(error),
        (Ok(()), Ok(())) => Ok(()),
    }
}

#[tauri::command]
pub fn connector_vault_release(app: AppHandle, lease: String) -> Result<(), String> {
    if !valid_vault_token(&lease) {
        return Err("invalid connector vault token".to_string());
    }
    let state = app.state::<TelegramState>();
    let scope = {
        let leases = state
            .vault
            .lock()
            .map_err(|_| "connector vault lock poisoned".to_string())?;
        match leases.scope_for(&lease) {
            Ok(scope) => scope.to_string(),
            Err(_) => return Ok(()),
        }
    };
    if state
        .clients
        .lock()
        .map_err(|_| "Telegram client registry lock poisoned".to_string())?
        .is_connector_scope_active(&scope)
    {
        return Err("connector vault capability is in use by an active native client".to_string());
    }
    let mut leases = state
        .vault
        .lock()
        .map_err(|_| "connector vault lock poisoned".to_string())?;
    if leases.scope_for(&lease).ok() == Some(scope.as_str()) && !leases.release(&lease) {
        return Err("connector vault capability is in use by an active native client".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // `cargo test` names every test thread after its full module path. Measured 2026-08-04 with a
    // standalone crate:
    //     THREAD NAME = "tests::tdjson_path_hardening_rejects_loader_search_and_wrong_filenames"
    // That name is what keeps each test's temp directory private while the harness runs tests in
    // parallel inside one process, so it has to stay in the path. But `:` is legal only on POSIX.
    // On Windows it is the drive and alternate-stream separator, so `create_dir_all` refuses the
    // path outright with ERROR_INVALID_NAME (os error 123) and the following `.unwrap()` panics.
    // That is exactly how the Windows release gate failed on 334427f0: the library compiled, 24 of
    // 26 tests passed, and these two died on their own scaffolding before asserting anything about
    // the behaviour under test. The same bytes pass on Linux, which is why the defect was invisible
    // here for as long as it existed.
    //
    // Two different tests can never collide after sanitising, because each call site also passes a
    // distinct `prefix`; the thread name only has to separate repeats of one test, and it still does.
    fn unique_test_dir(prefix: &str) -> std::path::PathBuf {
        let thread = std::thread::current();
        let name: String = thread
            .name()
            .unwrap_or("test")
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                    c
                } else {
                    '-'
                }
            })
            .collect();
        std::env::temp_dir().join(format!("{prefix}-{}-{name}", std::process::id()))
    }

    #[test]
    fn per_test_temp_directory_names_are_legal_on_windows_too() {
        // Regression guard for the os error 123 above. Windows rejects these nine characters in any
        // path component; a POSIX filesystem accepts all but `/`, which is why only the Windows lane
        // ever complained.
        let dir = unique_test_dir("gc-name-probe");
        let name = dir
            .file_name()
            .and_then(|value| value.to_str())
            .expect("the probe directory must have a printable name");
        for reserved in ['<', '>', ':', '"', '/', '\\', '|', '?', '*'] {
            assert!(
                !name.contains(reserved),
                "temp directory component {name:?} contains {reserved:?}, which Windows refuses \
                 with ERROR_INVALID_NAME"
            );
        }
        assert!(
            !name.ends_with('.') && !name.ends_with(' '),
            "Windows also strips a trailing dot or space: {name:?}"
        );
        // The name must still identify this test, or parallel runs would share one directory.
        assert!(
            name.starts_with("gc-name-probe-"),
            "prefix was lost: {name:?}"
        );
        assert!(
            name.contains("per_test_temp_directory_names_are_legal_on_windows_too")
                || name.ends_with("-test"),
            "the thread name no longer reaches the path, so uniqueness is gone: {name:?}"
        );
        // And it has to be creatable on the host actually running this test.
        std::fs::create_dir_all(&dir).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scope_validation_rejects_traversal_and_accepts_generated_scope() {
        assert!(valid_scope("tg_AQIDBAUGBwgJCgsMDQ4PEBES"));
        assert!(!valid_scope("../telegram"));
        assert!(!valid_scope("tg_a/b"));
        assert!(!valid_scope("tg_short"));
    }

    #[test]
    fn tdjson_path_hardening_rejects_loader_search_and_wrong_filenames() {
        assert!(canonical_library_file(Path::new(library_filename()), None).is_none());
        let root = unique_test_dir("gc-tdjson-path");
        let trusted = root.join("trusted");
        std::fs::create_dir_all(&trusted).unwrap();
        let correct = trusted.join(library_filename());
        std::fs::write(&correct, b"not-a-real-library").unwrap();
        assert_eq!(
            canonical_library_file(&correct, Some(&trusted)),
            Some(correct.canonicalize().unwrap())
        );
        let wrong = trusted.join("renamed-library.bin");
        std::fs::write(&wrong, b"not-a-real-library").unwrap();
        assert!(canonical_library_file(&wrong, Some(&trusted)).is_none());
        let outside = root.join(library_filename());
        std::fs::write(&outside, b"not-a-real-library").unwrap();
        assert!(canonical_library_file(&outside, Some(&trusted)).is_none());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn connector_storage_children_are_directories_with_exact_parents() {
        let root = unique_test_dir("gc-connector-path");
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let child = secure_child_dir(&root, "telegram").unwrap();
        assert_eq!(child.parent(), Some(root.as_path()));
        assert!(child.is_dir());
        assert!(secure_child_dir(&root, "../wallet").is_err());
        std::fs::write(root.join("not-a-directory"), b"x").unwrap();
        assert!(secure_child_dir(&root, "not-a-directory").is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn connector_storage_rejects_symlink_aliases() {
        use std::os::unix::fs::symlink;
        let root = unique_test_dir("gc-connector-symlink");
        std::fs::create_dir_all(root.join("real")).unwrap();
        symlink(root.join("real"), root.join("alias")).unwrap();
        assert!(secure_child_dir(&root, "alias").is_err());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn native_parameters_replace_untrusted_credentials_paths_and_database_key() {
        let mut request = serde_json::json!({
            "@type": "setTdlibParameters",
            "api_id": 1,
            "api_hash": "untrusted-value",
            "database_encryption_key": "renderer-key",
            "database_directory": "/tmp/renderer-db",
            "files_directory": "/tmp/renderer-files",
            "device_model": "GreenChat"
        });
        let key = BASE64_STANDARD.encode([7_u8; 32]);
        inject_native_parameters_with(
            &mut request,
            Some((123_456, "0123456789abcdef0123456789abcdef".to_string())),
            &key,
            "/private/native-db",
            "/private/native-files",
        )
        .unwrap();
        assert_eq!(
            request.get("api_id").and_then(serde_json::Value::as_i64),
            Some(123_456)
        );
        assert_eq!(
            request.get("api_hash").and_then(serde_json::Value::as_str),
            Some("0123456789abcdef0123456789abcdef")
        );
        assert_eq!(
            request
                .get("database_encryption_key")
                .and_then(serde_json::Value::as_str),
            Some(key.as_str())
        );
        assert_eq!(
            request
                .get("database_directory")
                .and_then(serde_json::Value::as_str),
            Some("/private/native-db")
        );
        assert_eq!(
            request
                .get("files_directory")
                .and_then(serde_json::Value::as_str),
            Some("/private/native-files")
        );
    }

    #[test]
    fn credentials_are_required_only_for_tdlib_parameters() {
        let mut ordinary = serde_json::json!({"@type": "getMe"});
        inject_native_parameters_with(&mut ordinary, None, "", "", "").unwrap();
        assert_eq!(ordinary, serde_json::json!({"@type": "getMe"}));

        let mut parameters = serde_json::json!({"@type": "setTdlibParameters"});
        let error = inject_native_parameters_with(&mut parameters, None, "", "", "").unwrap_err();
        assert_eq!(error, "Telegram application credentials are not configured");
        assert!(!error.contains("api_"));
    }

    #[test]
    fn renderer_requests_cannot_reference_local_or_generated_files() {
        let local = serde_json::json!({
            "@type": "sendMessage",
            "input_message_content": {
                "@type": "inputMessageDocument",
                "document": { "@type": "inputFileLocal", "path": "/etc/passwd" }
            }
        });
        assert!(reject_untrusted_local_file_inputs(&local).is_err());
        let generated = serde_json::json!({
            "@type": "inputFileGenerated",
            "original_path": "/private/data",
            "conversion": "copy"
        });
        assert!(reject_untrusted_local_file_inputs(&generated).is_err());
        let remote = serde_json::json!({
            "@type": "inputMessageDocument",
            "document": { "@type": "inputFileRemote", "id": "provider-owned-id" }
        });
        assert!(reject_untrusted_local_file_inputs(&remote).is_ok());
    }

    #[test]
    fn connector_vault_storage_binding_decodes_canonically_and_rejects_cross_scope_values() {
        let storage_scope = "tg_AQIDBAUGBwgJCgsMDQ4PEBES";
        let encoded = BASE64_STANDARD.encode(storage_scope.as_bytes());
        assert_eq!(decode_bound_storage_scope(&encoded).unwrap(), storage_scope);
        assert!(decode_bound_storage_scope("not-base64").is_err());
        assert!(
            decode_bound_storage_scope(&BASE64_STANDARD.encode(b"cv1.telegram.not-storage"))
                .is_err()
        );
        assert_ne!(
            "cv1.telegram.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", storage_scope,
            "account vault scope and TDLib storage scope are deliberately different namespaces"
        );
    }

    #[test]
    fn authorization_closed_detection_is_exact() {
        assert!(response_is_authorization_closed(&serde_json::json!({
            "@type": "updateAuthorizationState",
            "authorization_state": { "@type": "authorizationStateClosed" }
        })));
        assert!(!response_is_authorization_closed(&serde_json::json!({
            "@type": "authorizationStateClosed"
        })));
    }

    #[test]
    fn generated_client_handles_are_opaque_and_not_numeric_tdlib_ids() {
        let handle = new_client_handle().unwrap();
        assert!(handle.starts_with("tdc."));
        assert_eq!(handle.len(), 52);
        assert!(handle[4..].bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert!(handle.parse::<i64>().is_err());
    }

    #[test]
    fn connector_opening_reservation_blocks_concurrent_account_and_storage_scope_reuse() {
        let mut clients = TelegramClients::default();
        let connector = "cv1.telegram.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        let storage = "tg_AQIDBAUGBwgJCgsMDQ4PEBES";
        clients.reserve_opening(connector, storage).unwrap();
        assert!(clients
            .reserve_opening(connector, "tg_ZZZZZZZZZZZZZZZZ")
            .is_err());
        assert!(clients
            .reserve_opening("cv1.telegram.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", storage,)
            .is_err());
        clients.release_opening(connector, storage);
        clients.reserve_wipe(connector, Some(storage)).unwrap();
        assert!(clients.reserve_opening(connector, storage).is_err());
        clients.release_wipe(connector);
        assert!(clients.reserve_opening(connector, storage).is_ok());
    }

    #[test]
    fn native_registry_limits_distinct_live_or_opening_accounts_to_eight() {
        let mut clients = TelegramClients::default();
        for index in 0..MAX_TELEGRAM_CLIENTS {
            clients
                .reserve_opening(
                    &format!("cv1.telegram.slot{index}"),
                    &format!("tg_storage_slot_{index:02}"),
                )
                .unwrap();
        }
        assert_eq!(clients.reserved_client_count(), MAX_TELEGRAM_CLIENTS);
        assert_eq!(
            clients
                .reserve_opening("cv1.telegram.ninth", "tg_storage_ninth")
                .unwrap_err(),
            "Telegram native client limit reached"
        );
        clients.release_opening("cv1.telegram.slot0", "tg_storage_slot_00");
        assert!(clients
            .reserve_opening("cv1.telegram.replacement", "tg_storage_replacement")
            .is_ok());
    }

    #[test]
    fn connector_vault_leases_are_exclusive_and_scope_is_not_a_capability() {
        let mut leases = ConnectorVaultLeases::default();
        let first = leases
            .claim_with(
                "cv1.telegram.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                "lease.first".to_string(),
            )
            .unwrap();
        assert_eq!(
            leases.scope_for(&first).unwrap(),
            "cv1.telegram.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        );
        assert!(leases
            .scope_for("cv1.telegram.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
            .is_err());
        assert!(leases
            .claim_with(
                "cv1.telegram.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                "lease.second".to_string()
            )
            .is_err());
        let connector_scope = leases.acquire(&first).unwrap();
        assert_eq!(
            connector_scope,
            "cv1.telegram.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        );
        assert!(!leases.release(&first));
        leases.release_use(&first, &connector_scope);
        let destructive_scope = leases.begin_destructive(&first).unwrap();
        assert_eq!(destructive_scope, connector_scope);
        assert!(leases.acquire(&first).is_err());
        assert!(leases.scope_for_access(&first).is_err());
        assert!(!leases.release(&first));
        leases.end_destructive(&first, &connector_scope);
        assert!(leases.release(&first));
        assert!(leases.scope_for(&first).is_err());
        assert!(leases
            .claim_with(
                "cv1.telegram.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                "lease.second".to_string()
            )
            .is_ok());
    }

    #[test]
    fn renderer_cannot_address_native_only_database_key_binding_or_vault_index() {
        assert!(renderer_vault_name(TELEGRAM_TDLIB_DB_KEY_NAME).is_err());
        assert!(renderer_vault_name(TELEGRAM_TDLIB_STORAGE_SCOPE_NAME).is_err());
        assert!(renderer_vault_name(CONNECTOR_VAULT_INDEX_NAME).is_err());
        assert!(renderer_vault_name("telegram.connection.enabled.v1").is_ok());
    }

    #[test]
    fn connector_vault_tokens_are_strict() {
        assert!(valid_vault_token("telegram.v1.server.user.account"));
        assert!(!valid_vault_token("../wallet"));
        assert!(!valid_vault_token("bad/name"));
        assert!(!valid_vault_token("line\nfeed"));
        assert!(vault_user("telegram.v1.server.user", "database-key.v1").is_ok());
        assert!(valid_vault_base64("AQIDBA=="));
        assert!(valid_vault_base64(""));
        assert!(!valid_vault_base64("not base64"));
        assert!(!valid_vault_base64("AQID==="));
        assert!(!valid_vault_base64("=QIDBA=="));
        assert_ne!(
            vault_user("scope:a", "name").unwrap(),
            vault_user("scope", "a:name").unwrap(),
            "length-prefixed keyring users must not collide across scope/name boundaries"
        );
    }
}

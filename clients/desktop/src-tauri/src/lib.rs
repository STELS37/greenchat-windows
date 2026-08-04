// T-411: Green Chat desktop shell (Tauri 2). A thin host over the SHARED web bundle (clients/web/dist):
// tray + unread badge, close-to-tray, mute-aware native notifications (driven by the badge total, which
// the server computes excluding muted/archived chats), deep links greenchat:// + gcpay://, and the
// refresh token in the OS secret store. No frontend fork — behavior is bridged via src/bridge.js, which
// is injected as an init script with host identity, persisted session and server origin substituted at launch.
mod crashlog;
mod deeplink;
mod telegram;
mod version;

use std::{sync::Mutex, thread};

use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as AutostartExt};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::{Update, UpdaterExt};

const KEYRING_SERVICE: &str = "app.greenchat.desktop";
const KEYRING_USER: &str = "session";
const TRAY_ID: &str = "main";

const DEFAULT_SERVER_ORIGIN: &str = "https://greenchat.globalsystem.cc";

#[cfg(target_os = "linux")]
fn desktop_os() -> &'static str {
    "linux"
}

#[cfg(target_os = "windows")]
fn desktop_os() -> &'static str {
    "windows"
}

#[cfg(target_os = "macos")]
fn desktop_os() -> &'static str {
    "macos"
}

#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
fn desktop_os() -> &'static str {
    "desktop"
}

fn desktop_os_label() -> &'static str {
    match desktop_os() {
        "linux" => "Linux",
        "windows" => "Windows",
        "macos" => "macOS",
        _ => "Desktop",
    }
}

fn desktop_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x86_64",
        "aarch64" => "aarch64",
        other => other,
    }
}

fn configured_server_origin() -> String {
    std::env::var("GC_SERVER")
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            option_env!("GC_SERVER")
                .map(|value| value.trim().trim_end_matches('/').to_string())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or_else(|| DEFAULT_SERVER_ORIGIN.to_string())
}

fn desktop_client_header() -> String {
    format!("desktop/{}", env!("CARGO_PKG_VERSION"))
}

fn desktop_device_header() -> String {
    format!(
        "GreenChat Desktop {} {} {}",
        desktop_os_label(),
        desktop_arch(),
        env!("CARGO_PKG_VERSION")
    )
}

// Last unread total we rendered on the tray tooltip, so we can label the notification body.
#[derive(Default)]
struct Unread(Mutex<u32>);

// A checked-but-not-yet-installed update, parked between `check_update` and `install_update` so the
// UI can render the "обновление доступно" / force-update prompt before committing to the download.
#[derive(Default)]
struct PendingUpdate(Mutex<Option<Update>>);

fn keyring_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())
}

// --- Keyring commands (refresh token lives here, never in the webview's on-disk localStorage) --------

#[tauri::command]
fn keyring_get() -> Option<String> {
    keyring_entry().ok().and_then(|e| e.get_password().ok())
}

#[tauri::command]
fn keyring_set(value: String) -> Result<(), String> {
    keyring_entry()?
        .set_password(&value)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn keyring_delete() -> Result<(), String> {
    match keyring_entry()?.delete_credential() {
        Ok(()) => Ok(()),
        // Deleting an absent secret is a no-op, not an error (idempotent logout).
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// --- Unread badge + native notification -------------------------------------------------------------

#[tauri::command]
fn set_unread(app: AppHandle, count: u32) {
    *app.state::<Unread>().0.lock().unwrap() = count;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let tip = if count > 0 {
            format!("Green Chat — {} непрочитанных", count)
        } else {
            "Green Chat".to_string()
        };
        let _ = tray.set_tooltip(Some(&tip));
    }
    // Dock/taskbar badge where the platform supports it (macOS dock, some Linux launchers).
    #[cfg(target_os = "macos")]
    if let Some(win) = app.get_webview_window("main") {
        let label = if count > 0 {
            Some(count.to_string())
        } else {
            None
        };
        let _ = win.set_badge_label(label);
    }
}

fn unread_notification_body(count: u32) -> String {
    if count > 1 {
        format!("{} новых сообщений", count)
    } else {
        "Новое сообщение".to_string()
    }
}

fn notification_chat_hash(chat_id: Option<i64>) -> Option<String> {
    chat_id.filter(|id| *id > 0).map(|id| format!("#/chat/{id}"))
}

fn notification_opens(response: &notify_rust::NotificationResponse) -> bool {
    match response {
        notify_rust::NotificationResponse::Default => true,
        notify_rust::NotificationResponse::Action(action) => {
            action == "default" || action == "open"
        }
        _ => false,
    }
}

struct DesktopNotificationResponse {
    app: AppHandle,
    target: Option<String>,
}

impl notify_rust::ResponseHandler for DesktopNotificationResponse {
    fn call(self, response: &notify_rust::NotificationResponse) {
        if !notification_opens(response) {
            return;
        }
        show_main(&self.app);
        if let Some(hash) = self.target {
            let _ = self.app.emit("gc://navigate", hash);
        }
    }
}

// Native notification with a live response handle. Message text, sender and chat title are deliberately
// absent: privacy mode remains generic even before the shared UI has loaded. The optional chat id is only
// an in-memory navigation target and is never included in the visible notification payload.
#[tauri::command]
fn notify_unread(app: AppHandle, count: u32, chat_id: Option<i64>) -> Result<(), String> {
    let mut notification = notify_rust::Notification::new();
    notification
        .appname("Green Chat")
        .summary("Green Chat")
        .body(&unread_notification_body(count))
        .timeout(notify_rust::Timeout::Milliseconds(600_000));
    #[cfg(not(target_os = "macos"))]
    notification.action("default", "Open Green Chat");
    let handle = notification.show().map_err(|error| error.to_string())?;
    let target = notification_chat_hash(chat_id);
    thread::spawn(move || {
        let _ = handle.wait_for_response(DesktopNotificationResponse { app, target });
    });
    Ok(())
}

#[cfg(target_os = "macos")]
fn mac_notification_state() -> Result<String, String> {
    use mac_usernotifications::AuthorizationStatus;
    let settings = mac_usernotifications::blocking::get_notification_settings()
        .map_err(|error| error.to_string())?;
    Ok(match settings.authorization_status {
        AuthorizationStatus::Authorized
        | AuthorizationStatus::Provisional
        | AuthorizationStatus::Ephemeral => "granted",
        AuthorizationStatus::Denied => "denied",
        AuthorizationStatus::NotDetermined => "prompt",
        AuthorizationStatus::Unknown => "prompt",
    }
    .to_string())
}

#[tauri::command]
fn notification_permission(app: AppHandle) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        mac_notification_state()
    }
    #[cfg(not(target_os = "macos"))]
    {
        app.notification()
            .permission_state()
            .map(|state| state.to_string())
            .map_err(|error| error.to_string())
    }
}

#[tauri::command]
fn request_notification_permission(app: AppHandle) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        let granted = mac_usernotifications::blocking::request_auth()
            .map_err(|error| error.to_string())?;
        Ok(if granted { "granted" } else { "denied" }.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        app.notification()
            .request_permission()
            .map(|state| state.to_string())
            .map_err(|error| error.to_string())
    }
}

#[tauri::command]
fn autostart_get(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|error| error.to_string())
}

#[tauri::command]
fn autostart_set(app: AppHandle, enabled: bool) -> Result<(), String> {
    if enabled {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    }
    .map_err(|error| error.to_string())
}

// --- Self-update (CLIENTS §9) -----------------------------------------------------------------------
// The self-hosted manifest at GET /v1/client/updates/:platform/:arch?version= drives tauri-plugin-updater
// (endpoint + minisign pubkey are in tauri.conf.json). Two distinct concerns live here:
//   * an OPTIONAL update the user can take (check → install → restart), and
//   * a MANDATORY force-update: the manifest carries `min_supported`; if our running version is below it,
//     the frontend must show a blocking «Обновите приложение» screen (comparison via the tested version.rs).

// What the frontend needs to render both prompts in one round-trip.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateStatus {
    current_version: String,
    /// Set when a newer build is offered by the manifest.
    available_version: Option<String>,
    /// The server's floor; below it the app must block until updated (echoed for display/telemetry).
    min_supported: Option<String>,
    /// The force-update verdict — computed in Rust from the tested comparator, never trusted from JS.
    must_update: bool,
}

/// This build's version, straight from the compiled Cargo package metadata.
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopIdentity {
    platform: &'static str,
    os: &'static str,
    arch: &'static str,
    app_version: String,
    client_header: String,
    device_header: String,
    server_origin: String,
}

/// Stable host identity used for diagnostics, session creation and support output. The shared web
/// bundle remains platform-agnostic; this command proves which installed desktop program owns it.
#[tauri::command]
fn desktop_identity() -> DesktopIdentity {
    DesktopIdentity {
        platform: "desktop",
        os: desktop_os(),
        arch: desktop_arch(),
        app_version: app_version(),
        client_header: desktop_client_header(),
        device_header: desktop_device_header(),
        server_origin: configured_server_origin(),
    }
}

/// The manifest coordinates for THIS build: (platform, arch, version). `platform` uses the tauri-updater
/// target names (macos → "darwin") so the bridge can hit the same `/v1/client/updates/:platform/:arch`
/// URL the plugin's endpoint template resolves to, and read `min_supported` from that one manifest.
#[tauri::command]
fn update_target() -> (String, String, String) {
    let platform = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    };
    (
        platform.to_string(),
        std::env::consts::ARCH.to_string(),
        app_version(),
    )
}

/// Force-update gate: is `current` (defaults to this build) strictly below the manifest's `min_supported`?
/// Pure and total — the heavy lifting is the unit-tested `version::below_min`.
#[tauri::command]
fn must_force_update(current: Option<String>, min_supported: String) -> bool {
    let current = current.unwrap_or_else(app_version);
    version::below_min(&current, &min_supported)
}

/// Ask the update server once. Parks any offered update in state for a later `install_update`, and returns
/// everything the UI needs — including the force-update verdict when the manifest advertises `min_supported`.
#[tauri::command]
async fn check_update(
    app: AppHandle,
    pending: tauri::State<'_, PendingUpdate>,
    min_supported: Option<String>,
) -> Result<UpdateStatus, String> {
    let current = app_version();
    let update = match app.updater() {
        Ok(u) => u.check().await.map_err(|e| e.to_string())?,
        Err(e) => return Err(e.to_string()),
    };
    let available_version = update.as_ref().map(|u| u.version.clone());
    *pending.0.lock().unwrap() = update;
    let must_update = min_supported
        .as_deref()
        .map(|m| version::below_min(&current, m))
        .unwrap_or(false);
    Ok(UpdateStatus {
        current_version: current,
        available_version,
        min_supported,
        must_update,
    })
}

/// Download + install the update parked by `check_update`, then relaunch into the new build. On success
/// the process is replaced by `app.restart()`, so this only returns on error or when nothing was pending.
#[tauri::command]
async fn install_update(
    app: AppHandle,
    pending: tauri::State<'_, PendingUpdate>,
) -> Result<(), String> {
    let update = pending.0.lock().unwrap().take();
    let Some(update) = update else {
        return Err("нет ожидающего обновления".to_string());
    };
    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    app.restart();
}

// --- Window + deep-link plumbing --------------------------------------------------------------------

fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

// Route a batch of argv/urls: focus the window and, if one is a deep link, navigate the SPA to its hash.
fn handle_links<I, S>(app: &AppHandle, args: I)
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    show_main(app);
    if let Some(hash) = deeplink::first_hash(args) {
        let _ = app.emit("gc://navigate", hash);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The bundled bridge, with launch-time placeholders filled: the persisted session (from the keyring)
    // and the backend origin (from GC_SERVER). Substituted as JSON so quoting/escaping is always valid.
    let seed = keyring_get()
        .map(|s| serde_json::to_string(&s).unwrap_or_else(|_| "null".into()))
        .unwrap_or_else(|| "null".into());
    // A normal desktop launch has no shell environment, so the installed program must carry a usable
    // production origin. Runtime GC_SERVER still overrides it for self-hosted deployments; CI may also
    // embed GC_SERVER at compile time. The canonical fallback prevents /v1 requests from hitting tauri://.
    let origin = configured_server_origin();
    let origin_json = serde_json::to_string(&origin).unwrap_or_else(|_| "\"\"".into());
    let os_json = serde_json::to_string(desktop_os()).unwrap_or_else(|_| "\"desktop\"".into());
    let arch_json = serde_json::to_string(desktop_arch()).unwrap_or_else(|_| "\"unknown\"".into());
    let version_json = serde_json::to_string(&app_version()).unwrap_or_else(|_| "\"0.0.0\"".into());
    let init_script = include_str!("bridge.js")
        .replacen("__GC_SESSION_SEED__", &seed, 1)
        .replacen("__GC_SERVER_ORIGIN__", &origin_json, 1)
        .replacen("__GC_DESKTOP_OS__", &os_json, 1)
        .replacen("__GC_DESKTOP_ARCH__", &arch_json, 1)
        .replacen("__GC_DESKTOP_VERSION__", &version_json, 1);

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // A second launch (incl. a Linux deep-link open) forwards its argv here — focus + navigate.
            handle_links(app, argv);
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![]),
        ))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(Unread::default())
        .manage(PendingUpdate::default())
        .manage(telegram::TelegramState::default())
        .invoke_handler(tauri::generate_handler![
            keyring_get,
            keyring_set,
            keyring_delete,
            set_unread,
            notify_unread,
            notification_permission,
            request_notification_permission,
            autostart_get,
            autostart_set,
            app_version,
            desktop_identity,
            update_target,
            must_force_update,
            check_update,
            install_update,
            crashlog::take_native_crashes,
            telegram::telegram_info,
            telegram::telegram_create,
            telegram::telegram_send,
            telegram::telegram_close,
            telegram::telegram_wipe,
            telegram::connector_vault_claim,
            telegram::connector_vault_read,
            telegram::connector_vault_write,
            telegram::connector_vault_remove,
            telegram::connector_vault_wipe,
            telegram::connector_vault_release
        ])
        .setup(move |app| {
            let handle = app.handle().clone();

            // T-418: install the native panic hook FIRST so any panic from here on is captured (PII-free)
            // for the next launch to report through the opt-in diagnostics pipeline.
            crashlog::install(&handle);

            // The main window is built HERE (not from tauri.conf.json) so we can attach the bridge as an
            // initialization script — it must run in the WebView before the shared bundle's own scripts.
            let mut win_builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("Green Chat")
                .inner_size(1024.0, 720.0)
                .min_inner_size(480.0, 480.0)
                .resizable(true)
                .center()
                .zoom_hotkeys_enabled(true)
                .initialization_script(&init_script);

            // T-419: optional outbound proxy for the WHOLE webview — a SOCKS5 or HTTP(S) URL applied to
            // BOTH fetch and WebSocket traffic (acceptance: "локальный socks5-прокси видит и HTTP-, и
            // WS-трафик desktop-клиента"). Configured via GC_PROXY (e.g. socks5://127.0.0.1:1080); empty
            // or unset → direct connection. This is a desktop/Android-only control — the web/PWA build
            // ships no proxy code (it uses the browser/system proxy). On macOS the actual application also
            // needs the `macos-proxy` cargo feature; here (Linux/Windows) WebKitGTK/WebView2 apply it.
            if let Some(proxy) = std::env::var("GC_PROXY")
                .ok()
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty())
            {
                match Url::parse(&proxy) {
                    Ok(u) => win_builder = win_builder.proxy_url(u),
                    Err(e) => eprintln!("GC_PROXY ignored (invalid URL '{proxy}'): {e}"),
                }
            }

            win_builder.build()?;

            // Register the custom schemes at runtime (needed for dev + on Linux/Windows).
            #[cfg(any(target_os = "linux", all(debug_assertions, target_os = "windows")))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link().register_all();
            }

            // Runtime deep links delivered while running (macOS/Windows single-instance, registered handler).
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let h = handle.clone();
                app.deep_link().on_open_url(move |event| {
                    let urls: Vec<String> =
                        event.urls().into_iter().map(|u| u.to_string()).collect();
                    handle_links(&h, urls);
                });
            }

            // A cold start opened via a deep link (argv carries the URL) navigates once the app is up.
            if let Some(hash) = deeplink::first_hash(std::env::args()) {
                let _ = handle.emit("gc://navigate", hash);
            }

            // Tray: left-click shows/focuses the window; a "Показать" / "Выход" context menu backs it up.
            let show_item = MenuItem::with_id(app, "show", "Показать", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            let tray_img = Image::from_bytes(include_bytes!("../icons/tray.png"))?;
            TrayIconBuilder::with_id(TRAY_ID)
                .icon(tray_img)
                .icon_as_template(true)
                .tooltip("Green Chat")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { .. } = event {
                        show_main(&tray.app_handle().clone());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // Close-to-tray: hide instead of quitting (CLIENTS §7.2 "закрытие окна → в трей"). "Выход"
            // in the tray menu is the real quit. MVP behaviour is close-hides; a setting can flip it later.
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Green Chat desktop");
}


#[cfg(test)]
mod desktop_notification_tests {
    use super::{notification_chat_hash, notification_opens, unread_notification_body};
    use notify_rust::NotificationResponse;

    #[test]
    fn notification_target_is_positive_chat_only() {
        assert_eq!(notification_chat_hash(Some(42)).as_deref(), Some("#/chat/42"));
        assert_eq!(notification_chat_hash(Some(0)), None);
        assert_eq!(notification_chat_hash(Some(-1)), None);
        assert_eq!(notification_chat_hash(None), None);
    }

    #[test]
    fn only_activation_responses_open_the_app() {
        assert!(notification_opens(&NotificationResponse::Default));
        assert!(notification_opens(&NotificationResponse::Action("open".into())));
        assert!(notification_opens(&NotificationResponse::Action("default".into())));
        assert!(!notification_opens(&NotificationResponse::Action("dismiss".into())));
        assert!(!notification_opens(&NotificationResponse::Closed(
            notify_rust::CloseReason::Dismissed,
        )));
    }

    #[test]
    fn visible_copy_never_contains_chat_or_sender_data() {
        assert_eq!(unread_notification_body(1), "Новое сообщение");
        assert_eq!(unread_notification_body(4), "4 новых сообщений");
    }
}

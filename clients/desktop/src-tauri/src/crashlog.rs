// clients/desktop/src-tauri/src/crashlog.rs — native panic capture for the desktop shell (T-418).
//
// A Rust panic in the Tauri host is the desktop equivalent of a hard crash. We install a panic hook that
// appends ONE PII-free line per panic — the panic message + source location only, never user data — to a
// small log under the app config dir. On the next launch the web layer pulls those lines via the
// `take_native_crashes` command and feeds them into the SAME opt-in crash pipeline as web/WebView crashes
// (they are transmitted only if the user turned diagnostics ON). The previous hook is chained so the
// default panic message still reaches stderr; panic = "abort" in release still runs hooks before aborting.
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

// Where the panic lines are appended. Resolved once at `install` (the hook itself can't touch the AppHandle).
static CRASH_LOG: Mutex<Option<PathBuf>> = Mutex::new(None);

const STACK_MAX_BYTES: usize = 8 * 1024; // mirror the server's stack ≤ 8 KB cap
const KEEP_LINES: usize = 20; // never hand back more than the server's breadcrumb-sized window

// Clamp to a byte budget on a char boundary and flatten newlines/control noise so one panic = one log line.
fn sanitize(input: &str, max_bytes: usize) -> String {
    let flattened: String = input
        .chars()
        .map(|c| {
            if c == '\n' || c == '\r' || c == '\t' {
                ' '
            } else {
                c
            }
        })
        .filter(|c| !c.is_control())
        .collect();
    let mut end = flattened.len().min(max_bytes);
    while end > 0 && !flattened.is_char_boundary(end) {
        end -= 1;
    }
    flattened[..end].to_string()
}

/// Install the panic hook. Resolves the log path under the app config dir and chains the existing hook.
pub fn install(app: &AppHandle) {
    if let Ok(dir) = app.path().app_config_dir() {
        let _ = fs::create_dir_all(&dir);
        if let Ok(mut guard) = CRASH_LOG.lock() {
            *guard = Some(dir.join("client_crashes.log"));
        }
    }

    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        // Compose ONE anonymous line: the panic payload + source location. No locals, no user data.
        let payload = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "unknown panic".to_string()
        };
        let location = info
            .location()
            .map(|l| format!(" @ {}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_default();
        let line = sanitize(
            &format!("[tauri panic] {}{}", payload, location),
            STACK_MAX_BYTES,
        );

        if let Ok(guard) = CRASH_LOG.lock() {
            if let Some(path) = guard.as_ref() {
                if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
                    let _ = writeln!(f, "{}", line);
                }
            }
        }

        previous(info); // keep the default behaviour (message to stderr, then abort in release)
    }));
}

/// Read and CLEAR the buffered panic lines (most recent, up to KEEP_LINES) for the web layer to report.
/// Anonymous strings only — the caller decides, under user consent, whether to transmit them.
#[tauri::command]
pub fn take_native_crashes(app: AppHandle) -> Vec<String> {
    let path = match app.path().app_config_dir() {
        Ok(dir) => dir.join("client_crashes.log"),
        Err(_) => return Vec::new(),
    };
    let contents = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return Vec::new(), // no log yet → nothing to report
    };
    let _ = fs::remove_file(&path); // drain-once: consumed lines never resurface
    let lines: Vec<String> = contents
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .map(|l| l.to_string())
        .collect();
    let start = lines.len().saturating_sub(KEEP_LINES);
    lines[start..].to_vec()
}

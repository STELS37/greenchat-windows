// Tauri build hook: generates permission ACLs + the platform bundle plumbing from tauri.conf.json.
fn main() {
    // Telegram application credentials are compiled into the native shell only. They must never enter
    // the shared/public web bundle. Rebuild when the operator changes either value.
    println!("cargo:rerun-if-env-changed=GC_TELEGRAM_API_ID");
    println!("cargo:rerun-if-env-changed=GC_TELEGRAM_API_HASH");
    tauri_build::build();
}

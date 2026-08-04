// Binary entry — thin wrapper so the app logic lives in lib.rs (unit tests + mobile entry point).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    green_chat_desktop_lib::run();
}

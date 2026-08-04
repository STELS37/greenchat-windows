use std::time::{SystemTime, UNIX_EPOCH};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    if !cfg!(target_os = "macos") {
        println!("MACOS-KEYCHAIN-SMOKE: SKIP non-macOS host");
        return Ok(());
    }
    let nonce = SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos();
    let service = format!("app.greenchat.desktop.ci.{}.{}", std::process::id(), nonce);
    let entry = keyring::Entry::new(&service, "session")?;
    let _ = entry.delete_credential();
    let secret = format!("keychain-smoke-{nonce}");
    entry.set_password(&secret)?;
    if entry.get_password()? != secret {
        return Err("Keychain round-trip mismatch".into());
    }
    entry.delete_credential()?;
    match entry.get_password() {
        Err(keyring::Error::NoEntry) => {}
        Ok(_) => return Err("Keychain item survived deletion".into()),
        Err(error) => return Err(error.into()),
    }
    println!("MACOS-KEYCHAIN-SMOKE: OK");
    Ok(())
}

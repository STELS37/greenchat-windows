// SPDX-License-Identifier: AGPL-3.0-or-later
// Local launcher inventory only. This is not proof of Epic account ownership.
use serde::Serialize;
use std::path::Path;
use std::io::Read;

#[derive(Debug, Serialize)]
pub struct EpicGame { id: String, name: String }

fn game(value: &serde_json::Value) -> Option<EpicGame> {
    if value.get("bIsIncompleteInstall").and_then(|v| v.as_bool()) != Some(false)
        || value.get("bIsApplication").and_then(|v| v.as_bool()) != Some(true) { return None; }
    let id = value.get("AppName")?.as_str()?;
    let name = value.get("DisplayName")?.as_str()?.trim();
    if id.is_empty() || id.len() > 128 || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        || name.is_empty() || name.len() > 256 || name.chars().any(char::is_control) { return None; }
    Some(EpicGame { id: id.into(), name: name.into() })
}

fn inventory(directory: &Path) -> Result<Vec<EpicGame>, String> {
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(_) => return Err("Could not read Epic launcher inventory".into()),
    };
    let mut games = vec![];
    for entry in entries.take(1000).flatten() {
        let path = entry.path();
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) { continue; }
        if path.extension().and_then(|s| s.to_str()) != Some("item") { continue; }
        let Ok(metadata) = entry.metadata() else { continue };
        if !metadata.is_file() || metadata.len() > 1024 * 1024 { continue; }
        let Ok(file) = std::fs::File::open(path) else { continue };
        let mut bytes = Vec::new();
        if file.take(1024 * 1024 + 1).read_to_end(&mut bytes).is_err() || bytes.len() > 1024 * 1024 { continue; }
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else { continue };
        let Some(game) = game(&value) else { continue };
        let Some(location) = value.get("InstallLocation").and_then(|v| v.as_str()) else { continue };
        if !Path::new(location).is_absolute() || !Path::new(location).is_dir() { continue; }
        if !games.iter().any(|g: &EpicGame| g.id == game.id) { games.push(game); }
    }
    games.sort_by(|a,b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(games)
}

#[tauri::command]
pub fn epic_installed_games() -> Result<Vec<EpicGame>, String> {
    #[cfg(target_os = "windows")]
    {
        let base = std::env::var_os("ProgramData").ok_or("ProgramData unavailable")?;
        inventory(&std::path::PathBuf::from(base).join("Epic/EpicGamesLauncher/Data/Manifests"))
    }
    #[cfg(not(target_os = "windows"))]
    { Err("Epic launcher inventory requires Windows".into()) }
}

#[tauri::command]
pub fn epic_launch_game(id: String) -> Result<(), String> {
    // Re-read the local inventory: the WebView cannot supply commands, paths, or arbitrary URIs.
    if !epic_installed_games()?.iter().any(|g| g.id == id) { return Err("Game is not installed".into()); }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("rundll32.exe")
            .arg("url.dll,FileProtocolHandler")
            .arg(format!("com.epicgames.launcher://apps/{}?action=launch&silent=true", id))
            .creation_flags(0x08000000).spawn().map_err(|_| "Could not open Epic launcher")?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    { Err("Epic launcher requires Windows".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn excludes_incomplete_and_unsafe_launcher_ids() {
        let mut value = serde_json::json!({"AppName":"Fortnite","DisplayName":"Fortnite","bIsIncompleteInstall":false,"bIsApplication":true});
        assert_eq!(game(&value).unwrap().id, "Fortnite");
        for id in ["", "../bad", "x?action=install", "x\" & calc", "x%20y", "a/b"] {
            value["AppName"] = id.into(); assert!(game(&value).is_none());
        }
        value["AppName"] = "Fortnite".into();
        value["bIsIncompleteInstall"] = true.into(); assert!(game(&value).is_none());
    }
    #[test]
    fn missing_launcher_is_an_empty_inventory() {
        assert!(inventory(&std::env::temp_dir().join("gc-missing-epic-inventory-test-900318" )).unwrap().is_empty());
    }
}

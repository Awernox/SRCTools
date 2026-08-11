//! The custom notification sound.
//!
//! A moderator may replace the bundled sound with a file of their own. That file
//! is *copied* into the app's data directory rather than referenced where it
//! sits, which matters for three reasons: the original may live on a removable
//! drive, it may be moved or deleted at any time, and the alternative — storing
//! an absolute path from the developer's machine — is exactly the thing this
//! project forbids in a release build.
//!
//! The bundled sound is untouched by everything here. It stays compiled into the
//! frontend bundle and remains the fallback whenever no custom file is stored,
//! so clearing the preference always leads back to a sound that works.
//!
//! What crosses the IPC boundary is base64, not a path the webview could fetch.
//! The asset protocol is disabled app-wide, so the frontend cannot read a local
//! file even if it wanted to; handing it bytes keeps that boundary intact.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::Manager;

use crate::error::{AppError, AppResult};

/// Extensions a webview can be relied on to decode.
///
/// Deliberately short. An exotic container that the audio element silently
/// refuses to play would present as "the sound stopped working" with nothing to
/// point at, so the import is refused up front instead.
const ALLOWED: [&str; 5] = ["mp3", "wav", "ogg", "m4a", "flac"];

/// Cap on the stored file.
///
/// A notification sound is a second or two. This is generous for that and still
/// small enough to base64 into the webview without a stall — and it stops a
/// mis-picked video file from being copied into the profile.
const MAX_BYTES: u64 = 5 * 1024 * 1024;

/// Where the copy lives, once imported.
const DIR: &str = "sounds";
const STEM: &str = "notification-custom";

/// A stored custom sound, as Settings renders it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomSound {
    /// Absolute path of the copy inside the app's own data directory.
    pub path: String,
    /// The original file name, for the "using X" line. Display only.
    pub name: String,
    pub bytes: u64,
}

fn sounds_dir(app: &tauri::AppHandle) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Io(format!("no app data directory: {e}")))?
        .join(DIR);
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::Io(format!("could not create {}: {e}", dir.display())))?;
    Ok(dir)
}

/// The extension, lowercased, if it is one we accept.
fn checked_extension(path: &Path) -> AppResult<String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();

    if ALLOWED.contains(&ext.as_str()) {
        Ok(ext)
    } else {
        Err(AppError::InvalidInput(format!(
            "{} is not an audio file SRCTools can play. Use one of: {}.",
            path.file_name().and_then(|n| n.to_str()).unwrap_or("that file"),
            ALLOWED.join(", ")
        )))
    }
}

/// Copies the chosen file into the app's data directory.
///
/// `source` comes from the file dialog, so it is a path the moderator picked
/// themselves. It is still validated: the dialog's filter is a convenience, not
/// a guarantee, and a typed path bypasses it entirely.
#[tauri::command]
pub fn sound_import(app: tauri::AppHandle, source: String) -> AppResult<CustomSound> {
    let source = PathBuf::from(source.trim());
    if source.as_os_str().is_empty() {
        return Err(AppError::InvalidInput("No file was chosen.".into()));
    }

    let meta = std::fs::metadata(&source)
        .map_err(|e| AppError::Io(format!("could not read that file: {e}")))?;
    if !meta.is_file() {
        return Err(AppError::InvalidInput(
            "That is a folder, not an audio file.".into(),
        ));
    }
    if meta.len() == 0 {
        return Err(AppError::InvalidInput("That file is empty.".into()));
    }
    if meta.len() > MAX_BYTES {
        return Err(AppError::InvalidInput(format!(
            "That file is {:.1} MB. A notification sound has to be under {} MB.",
            meta.len() as f64 / (1024.0 * 1024.0),
            MAX_BYTES / (1024 * 1024)
        )));
    }

    let ext = checked_extension(&source)?;
    let dir = sounds_dir(&app)?;

    // One custom sound at a time: leaving the previous file behind would grow
    // the profile every time the moderator changed their mind.
    clear_stored(&dir);

    let target = dir.join(format!("{STEM}.{ext}"));
    std::fs::copy(&source, &target)
        .map_err(|e| AppError::Io(format!("could not copy that file: {e}")))?;

    let name = source
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("custom sound")
        .to_string();

    tracing::info!("imported a custom notification sound ({} bytes)", meta.len());

    Ok(CustomSound {
        path: target.to_string_lossy().into_owned(),
        name,
        bytes: meta.len(),
    })
}

/// Removes every stored copy, whatever extension it was saved under.
fn clear_stored(dir: &Path) {
    for ext in ALLOWED {
        let _ = std::fs::remove_file(dir.join(format!("{STEM}.{ext}")));
    }
}

/// The stored sound as base64, for the audio element.
///
/// `None` when nothing is stored, which is the ordinary case and not an error —
/// the frontend then plays the bundled sound.
#[tauri::command]
pub fn sound_load(app: tauri::AppHandle) -> AppResult<Option<String>> {
    use base64::Engine as _;

    let dir = sounds_dir(&app)?;
    for ext in ALLOWED {
        let candidate = dir.join(format!("{STEM}.{ext}"));
        if candidate.is_file() {
            let bytes = std::fs::read(&candidate)
                .map_err(|e| AppError::Io(format!("could not read the stored sound: {e}")))?;
            return Ok(Some(
                base64::engine::general_purpose::STANDARD.encode(bytes),
            ));
        }
    }
    Ok(None)
}

/// Forgets the custom sound, restoring the bundled one.
#[tauri::command]
pub fn sound_clear(app: tauri::AppHandle) -> AppResult<()> {
    clear_stored(&sounds_dir(&app)?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_playable_extensions_are_accepted() {
        assert!(checked_extension(Path::new("a/b/alert.MP3")).is_ok());
        assert!(checked_extension(Path::new("alert.wav")).is_ok());
        assert!(checked_extension(Path::new("alert.mkv")).is_err());
        assert!(checked_extension(Path::new("alert")).is_err());
    }

    #[test]
    fn the_refusal_names_what_is_allowed() {
        let message = checked_extension(Path::new("clip.mp4")).unwrap_err().to_string();
        assert!(message.contains("mp3"), "{message}");
        assert!(message.contains("clip.mp4"), "{message}");
    }
}

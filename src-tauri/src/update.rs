//! In-app updates (tauri-plugin-updater). The app reads `latest.json` of the newest GitHub release, downloads the
//! file for its own kind of install, checks its minisign signature against the public key in tauri.conf.json (the
//! private key signs in CI) and installs it without any wizard:
//! * Windows: the NSIS setup runs silently (`/S`: per-user install, so no UAC prompt) and starts the new version;
//! * macOS: the .app bundle is replaced, then the app restarts;
//! * Linux AppImage: the AppImage file is replaced; .deb: `dpkg -i` through pkexec (the system asks for the password);
//! * Linux binary (the tar.gz, or the Arch package's /usr/bin/streamtunnel): the binary is replaced by a rename next
//!   to it (the running process keeps the old file), or through `pkexec install` when that folder is not ours.

use std::sync::Mutex;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The update found by the last check, installed by `update_install`.
#[derive(Default)]
pub struct Pending(Mutex<Option<Update>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
}

/// How this copy of the app is updated.
#[derive(Clone, Copy, PartialEq)]
enum Kind {
    /// the plugin installs it (Windows setup, macOS bundle, AppImage, .deb)
    Plugin,
    /// we replace the binary (Linux tar.gz / Arch package)
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    LinuxBinary,
}

/// The `latest.json` platform key for this install (None: the plugin's own `{os}-{arch}` lookup) and its kind.
fn install_kind() -> (Option<String>, Kind) {
    #[cfg(target_os = "linux")]
    {
        let arch = std::env::consts::ARCH;
        if std::env::var_os("APPIMAGE").is_some() {
            return (Some(format!("linux-{arch}-appimage")), Kind::Plugin);
        }
        if installed_by_dpkg() {
            return (Some(format!("linux-{arch}-deb")), Kind::Plugin);
        }
        (Some(format!("linux-{arch}-bin")), Kind::LinuxBinary)
    }
    #[cfg(not(target_os = "linux"))]
    (None, Kind::Plugin)
}

/// The running binary belongs to a Debian package.
#[cfg(target_os = "linux")]
fn installed_by_dpkg() -> bool {
    let Ok(exe) = std::env::current_exe() else { return false };
    std::process::Command::new("dpkg-query")
        .arg("-S")
        .arg(&exe)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// Asks the newest release whether there is a newer version; remembers it for `update_install`.
#[tauri::command]
pub async fn update_check(app: AppHandle, pending: State<'_, Pending>) -> Result<Option<UpdateInfo>, String> {
    let (target, _) = install_kind();
    let mut builder = app.updater_builder();
    if let Some(target) = target {
        builder = builder.target(target);
    }
    let update = builder.build().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    let info = update.as_ref().map(|u| UpdateInfo { version: u.version.clone() });
    *pending.0.lock().unwrap_or_else(|e| e.into_inner()) = update;
    Ok(info)
}

/// Downloads (progress in % on `progress`), verifies and installs the update found by `update_check`, then starts
/// the new version. Only returns on failure (Windows: the setup restarts the app).
#[tauri::command]
pub async fn update_install(app: AppHandle, pending: State<'_, Pending>, progress: Channel<u32>) -> Result<(), String> {
    let update = pending.0.lock().unwrap_or_else(|e| e.into_inner()).clone().ok_or("no update")?;
    let mut got = 0u64;
    let mut sent = None;
    let bytes = update
        .download(
            |chunk, total| {
                got += chunk as u64;
                if let Some(total) = total.filter(|t| *t > 0) {
                    let pct = (got * 100 / total).min(100) as u32;
                    if sent != Some(pct) {
                        sent = Some(pct);
                        let _ = progress.send(pct);
                    }
                }
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    match install_kind().1 {
        Kind::Plugin => update.install(&bytes).map_err(|e| e.to_string())?,
        Kind::LinuxBinary => replace_binary(&bytes)?,
    }
    app.restart()
}

#[cfg(target_os = "linux")]
fn replace_binary(bytes: &[u8]) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    if !bytes.starts_with(b"\x7fELF") {
        return Err("the update is not a Linux program".into());
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("the program has no folder")?;
    let next = dir.join(".streamtunnel-update");
    let direct = std::fs::write(&next, bytes)
        .and_then(|_| std::fs::set_permissions(&next, std::fs::Permissions::from_mode(0o755)))
        .and_then(|_| std::fs::rename(&next, &exe));
    if direct.is_ok() {
        return Ok(());
    }
    let _ = std::fs::remove_file(&next);
    // a folder that is not ours (the Arch package's /usr/bin): the system asks for the password
    let tmp = std::env::temp_dir().join(format!("streamtunnel-update-{}", std::process::id()));
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    let status = std::process::Command::new("pkexec").arg("install").arg("-m755").arg(&tmp).arg(&exe).status();
    let _ = std::fs::remove_file(&tmp);
    match status {
        Ok(s) if s.success() => Ok(()),
        Ok(_) => Err("installation cancelled".into()),
        Err(e) => Err(format!("pkexec: {e}")),
    }
}

#[cfg(not(target_os = "linux"))]
fn replace_binary(_bytes: &[u8]) -> Result<(), String> {
    Err("not a Linux binary install".into())
}

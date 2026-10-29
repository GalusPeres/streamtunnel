/// Keeps the display and system awake while streaming or watching.
/// Sync command => runs on the main thread, whose execution state lives as long as the app.
#[tauri::command]
fn keep_awake(on: bool) {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::System::Power::{
            SetThreadExecutionState, ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED,
        };
        let flags = if on {
            ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED
        } else {
            ES_CONTINUOUS
        };
        SetThreadExecutionState(flags);
    }
    #[cfg(not(windows))]
    let _ = on;
}

/// Title of a captured window (the web engine only exposes "window:<hwnd>:0"), e.g. the game's name.
#[tauri::command]
fn window_title(hwnd: i64) -> Option<String> {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowTextW, IsWindow};
        let h = hwnd as isize as windows_sys::Win32::Foundation::HWND;
        if hwnd == 0 || IsWindow(h) == 0 {
            return None;
        }
        let mut buf = [0u16; 256];
        let n = GetWindowTextW(h, buf.as_mut_ptr(), buf.len() as i32);
        if n <= 0 {
            return None;
        }
        let s = String::from_utf16_lossy(&buf[..n as usize]);
        let s = s.trim();
        if s.is_empty() { None } else { Some(s.to_string()) }
    }
    #[cfg(not(windows))]
    {
        let _ = hwnd;
        None
    }
}

/// While we share (`hide`): keeps WebView2's "… is sharing your screen" bar hidden (Windows; elsewhere nothing).
#[tauri::command]
fn share_bar(hide: bool) {
    #[cfg(windows)]
    sharebar::set(hide);
    #[cfg(not(windows))]
    let _ = hide;
}

/// Windows: share sound through WASAPI process loopback (system sound without StreamTunnel, or one app).
#[cfg(windows)]
mod sysaudio;

/// Windows: hides WebView2's sharing bar while a share runs (src/sharebar.rs).
#[cfg(windows)]
mod sharebar;

/// Linux: WebRTC media through GStreamer (WebKitGTK has no RTCPeerConnection), see docs/LINUX.md.
#[cfg(target_os = "linux")]
mod media;

/// Native media path on every OS (st-media: Windows capture + NVENC, the stm/1 UDP transport), docs/NATIVE-PATH.md.
mod native_media;
mod update;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(update::Pending::default());
    #[cfg(target_os = "linux")]
    let builder = builder
        .invoke_handler(tauri::generate_handler![
            keep_awake,
            window_title,
            share_bar,
            update::update_check,
            update::update_install,
            media::media_probe,
            media::media_create,
            media::media_remote,
            media::media_answer,
            media::media_ice,
            media::media_dc_send,
            media::media_volume,
            media::media_latency,
            media::media_keyframe,
            media::media_stats,
            media::media_close,
            media::test_config,
            media::test_report,
            native_media::nm_caps,
            native_media::nm_link_open,
            native_media::nm_link_remote,
            native_media::nm_link_cand,
            native_media::nm_link_send,
            native_media::nm_link_keyframe,
            native_media::nm_link_close,
            native_media::nm_share_open,
            native_media::nm_share_add,
            native_media::nm_share_remove,
            native_media::nm_share_update,
            native_media::nm_share_source,
            native_media::nm_share_close,
        ])
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                media::inject_e2e(webview);
            }
        })
        .on_window_event(|_, event| {
            if let tauri::WindowEvent::Destroyed = event {
                media::close_all();
                native_media::close_all();
            }
        });
    #[cfg(windows)]
    let builder = builder
        .invoke_handler(tauri::generate_handler![
            keep_awake,
            window_title,
            share_bar,
            update::update_check,
            update::update_install,
            sysaudio::sysaudio_supported,
            sysaudio::sysaudio_start,
            sysaudio::sysaudio_stop,
            sysaudio::window_pid,
            native_media::nm_caps,
            native_media::nm_link_open,
            native_media::nm_link_remote,
            native_media::nm_link_cand,
            native_media::nm_link_send,
            native_media::nm_link_keyframe,
            native_media::nm_link_close,
            native_media::nm_share_open,
            native_media::nm_share_add,
            native_media::nm_share_remove,
            native_media::nm_share_update,
            native_media::nm_share_source,
            native_media::nm_share_close,
        ])
        .on_window_event(|_, event| {
            if let tauri::WindowEvent::Destroyed = event {
                native_media::close_all();
                sysaudio::stop_running();
                sharebar::set(false);
            }
        });
    #[cfg(not(any(windows, target_os = "linux")))]
    let builder = builder
        .invoke_handler(tauri::generate_handler![
            keep_awake,
            window_title,
            share_bar,
            update::update_check,
            update::update_install,
            native_media::nm_caps,
            native_media::nm_link_open,
            native_media::nm_link_remote,
            native_media::nm_link_cand,
            native_media::nm_link_send,
            native_media::nm_link_keyframe,
            native_media::nm_link_close,
            native_media::nm_share_open,
            native_media::nm_share_add,
            native_media::nm_share_remove,
            native_media::nm_share_update,
            native_media::nm_share_source,
            native_media::nm_share_close,
        ])
        .on_window_event(|_, event| {
            if let tauri::WindowEvent::Destroyed = event {
                native_media::close_all();
            }
        });
    builder
        .run(tauri::generate_context!())
        .expect("error while running StreamTunnel");
}

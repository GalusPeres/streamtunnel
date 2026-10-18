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

/// Linux: WebRTC media through GStreamer (WebKitGTK has no RTCPeerConnection), see docs/LINUX.md.
#[cfg(target_os = "linux")]
mod media;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "linux")]
    let builder = builder
        .invoke_handler(tauri::generate_handler![
            keep_awake,
            window_title,
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
        ])
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                media::inject_e2e(webview);
            }
        })
        .on_window_event(|_, event| {
            if let tauri::WindowEvent::Destroyed = event {
                media::close_all();
            }
        });
    #[cfg(not(target_os = "linux"))]
    let builder = builder.invoke_handler(tauri::generate_handler![keep_awake, window_title]);
    builder
        .run(tauri::generate_context!())
        .expect("error while running StreamTunnel");
}

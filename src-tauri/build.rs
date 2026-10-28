fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&[
                "keep_awake",
                "window_title",
                // Windows share sound (src/sysaudio.rs); registered on Windows only
                "sysaudio_supported",
                "sysaudio_start",
                "sysaudio_stop",
                "window_pid",
                // Linux media engine (src/media.rs); registered on Linux only
                "media_probe",
                "media_create",
                "media_remote",
                "media_answer",
                "media_ice",
                "media_dc_send",
                "media_volume",
                "media_latency",
                "media_keyframe",
                "media_stats",
                "media_close",
                "test_config",
                "test_report",
            ])),
    )
    .expect("failed to run tauri-build");
}

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&[
                "keep_awake",
                "window_title",
                "share_bar",
                // in-app updates (src/update.rs)
                "update_check",
                "update_install",
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
                // Native media path (src/native_media.rs, docs/NATIVE-PATH.md); registered on every OS
                "nm_caps",
                "nm_link_open",
                "nm_link_remote",
                "nm_link_cand",
                "nm_link_send",
                "nm_link_keyframe",
                "nm_link_close",
                "nm_share_open",
                "nm_share_add",
                "nm_share_remove",
                "nm_share_update",
                "nm_share_source",
                "nm_share_close",
            ])),
    )
    .expect("failed to run tauri-build");
}

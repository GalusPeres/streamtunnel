//! Two endpoints in one process over 127.0.0.1 (docs/NATIVE-PATH.md §12, NET): link setup through the same
//! calls the glue makes, then synthetic access units through a lossy shim. Never touches the screen or a GPU.
//! Run: cargo test --manifest-path src-tauri/st-media/Cargo.toml --target-dir src-tauri/target

/// Sharer + viewer endpoints (`loopback: true`), exchange link ids / key halves / candidates directly (no
/// signaling), expect `LinkEvent::Up` on both within `ice::DEADLINE_MS`, send 300 synthetic frames (1–200 KB,
/// first one key) with 1 % random loss injected: every frame arrives intact or is reported lost and recovered
/// by the next key frame; App messages arrive in order; Bye closes the peer with "bye".
#[test]
#[ignore = "skeleton: NET fills this in"]
fn loopback_link_delivers_frames_under_loss() {}

/// A viewer whose key half does not match never gets `Up` and fails after the deadline (no reply to
/// unauthenticated probes).
#[test]
#[ignore = "skeleton: NET fills this in"]
fn wrong_key_fails_after_deadline() {}

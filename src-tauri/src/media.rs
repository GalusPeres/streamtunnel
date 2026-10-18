//! Linux only: WebRTC media through GStreamer (`st-linux-media`), because WebKitGTK ships without WebRTC.
//! The TypeScript `NativePeerConnection` (src/rtc/native.ts) drives one engine peer per watch link through
//! these commands; events flow back over a Tauri `Channel`:
//! * JSON `{t:'ice'|'gather'|'state'|'track'|'dcopen'|'dcclose'|'dc'|'err', …}`
//! * raw bytes = one H.264 access unit: `[flags u8 (bit0 = key frame)][pts µs u64 LE][Annex B data]`
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use st_linux_media::{Config, Event, Peer, StatValue};
use tauri::ipc::{Channel, InvokeResponseBody};

type Peers = Mutex<HashMap<u32, Arc<Peer>>>;

fn peers() -> &'static Peers {
    static PEERS: OnceLock<Peers> = OnceLock::new();
    PEERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn peer(id: u32) -> Result<Arc<Peer>, String> {
    peers()
        .lock()
        .map_err(|_| "poisoned".to_string())?
        .get(&id)
        .cloned()
        .ok_or_else(|| "unknown peer".to_string())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub struct Probe {
    /// all GStreamer elements for watching are installed
    available: bool,
    /// "element (package)" entries that are missing
    missing: Vec<String>,
    version: String,
}

#[tauri::command]
pub async fn media_probe() -> Probe {
    let missing = tauri::async_runtime::spawn_blocking(st_linux_media::missing_elements)
        .await
        .unwrap_or_else(|e| vec![e.to_string()]);
    Probe { available: missing.is_empty(), missing, version: st_linux_media::gstreamer_version() }
}

#[derive(Deserialize)]
pub struct TurnIn {
    urls: String,
    username: Option<String>,
    credential: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigIn {
    #[serde(default)]
    stun: Vec<String>,
    #[serde(default)]
    turn: Vec<TurnIn>,
    #[serde(default)]
    latency_ms: Option<u32>,
}

fn send_json(ch: &Channel<InvokeResponseBody>, v: Value) {
    let _ = ch.send(InvokeResponseBody::Json(v.to_string()));
}

fn forward(ch: &Channel<InvokeResponseBody>, ev: Event) {
    match ev {
        Event::Video { pts_us, key, data } => {
            let mut buf = Vec::with_capacity(data.len() + 9);
            buf.push(u8::from(key));
            buf.extend_from_slice(&pts_us.to_le_bytes());
            buf.extend_from_slice(&data);
            let _ = ch.send(InvokeResponseBody::Raw(buf));
        }
        Event::IceCandidate { mline, candidate } => send_json(ch, json!({ "t": "ice", "mline": mline, "c": candidate })),
        Event::IceGathering(s) => send_json(ch, json!({ "t": "gather", "s": s })),
        Event::State { connection, ice } => send_json(ch, json!({ "t": "state", "c": connection, "i": ice })),
        Event::Track(k) => send_json(ch, json!({ "t": "track", "k": k })),
        Event::DcOpen => send_json(ch, json!({ "t": "dcopen" })),
        Event::DcClose => send_json(ch, json!({ "t": "dcclose" })),
        Event::DcMessage(m) => send_json(ch, json!({ "t": "dc", "m": m })),
        Event::Error(m) => {
            eprintln!("[media] {m}");
            send_json(ch, json!({ "t": "err", "m": m }));
        }
    }
}

#[tauri::command]
pub async fn media_create(config: ConfigIn, events: Channel<InvokeResponseBody>) -> Result<u32, String> {
    static NEXT: AtomicU32 = AtomicU32::new(1);
    let cfg = Config {
        stun: config.stun.iter().find_map(|s| st_linux_media::stun_url(s)),
        turn: config
            .turn
            .iter()
            .filter_map(|t| {
                st_linux_media::turn_url(&t.urls, t.username.as_deref().unwrap_or(""), t.credential.as_deref().unwrap_or(""))
            })
            .collect(),
        latency_ms: config.latency_ms.unwrap_or(40),
        audio_sink: std::env::var("ST_AUDIO_SINK").ok().filter(|s| !s.trim().is_empty()),
    };
    let p = blocking(move || Peer::new(&cfg, Arc::new(move |ev| forward(&events, ev)))).await?;
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    peers().lock().map_err(|_| "poisoned".to_string())?.insert(id, Arc::new(p));
    Ok(id)
}

/// Applies the sharer's offer (the TS side already filtered it to H.264 + Opus + data channel).
#[tauri::command]
pub async fn media_remote(id: u32, sdp: String) -> Result<(), String> {
    let p = peer(id)?;
    blocking(move || p.set_remote_offer(&sdp)).await
}

/// create-answer + set-local-description → answer SDP.
#[tauri::command]
pub async fn media_answer(id: u32) -> Result<String, String> {
    let p = peer(id)?;
    blocking(move || p.create_answer()).await
}

#[tauri::command]
pub fn media_ice(id: u32, mline: u32, candidate: String) -> Result<(), String> {
    peer(id)?.add_ice_candidate(mline, &candidate);
    Ok(())
}

#[tauri::command]
pub fn media_dc_send(id: u32, text: String) -> Result<(), String> {
    peer(id)?.dc_send(&text)
}

#[tauri::command]
pub fn media_volume(id: u32, volume: f64) -> Result<(), String> {
    peer(id)?.set_volume(volume);
    Ok(())
}

#[tauri::command]
pub fn media_latency(id: u32, ms: u32) -> Result<(), String> {
    peer(id)?.set_latency(ms);
    Ok(())
}

#[tauri::command]
pub fn media_keyframe(id: u32) -> Result<(), String> {
    peer(id)?.request_keyframe();
    Ok(())
}

#[tauri::command]
pub async fn media_stats(id: u32) -> Result<Value, String> {
    let p = peer(id)?;
    let stats = blocking(move || p.stats()).await?;
    let mut out = serde_json::Map::new();
    for (sid, fields) in stats {
        let mut o = serde_json::Map::new();
        for (k, v) in fields {
            o.insert(
                k,
                match v {
                    StatValue::Num(n) => json!(n),
                    StatValue::Str(s) => json!(s),
                    StatValue::Bool(b) => json!(b),
                },
            );
        }
        out.insert(sid, Value::Object(o));
    }
    Ok(Value::Object(out))
}

#[tauri::command]
pub async fn media_close(id: u32) -> Result<(), String> {
    let p = peers().lock().map_err(|_| "poisoned".to_string())?.remove(&id);
    if let Some(p) = p {
        blocking(move || {
            p.close();
            Ok(())
        })
        .await?;
    }
    Ok(())
}

/// Closes every peer (window closed / page reloaded).
pub fn close_all() {
    let all: Vec<Arc<Peer>> = match peers().lock() {
        Ok(mut g) => g.drain().map(|(_, p)| p).collect(),
        Err(_) => return,
    };
    for p in all {
        p.close();
    }
}

// ───────────────────────── headless end-to-end test hooks ─────────────────────────
// Only active when ST_E2E_JOIN is set (CI: tests/e2e/linux-tauri.mjs): the UI joins that tunnel, watches the
// first live member and reports what it saw through test_report; a final report exits the app.

/// Injects tests/e2e/linux-app-driver.js after page load when ST_E2E_JOIN is set (never otherwise).
pub fn inject_e2e<R: tauri::Runtime>(webview: &tauri::Webview<R>) {
    if std::env::var("ST_E2E_JOIN").map(|c| c.trim().is_empty()).unwrap_or(true) {
        return;
    }
    println!("[e2e] injecting driver");
    if let Err(e) = webview.eval(include_str!("../../tests/e2e/linux-app-driver.js")) {
        println!("[e2e] eval failed: {e}");
    }
}

#[tauri::command]
pub fn test_config() -> Option<Value> {
    let code = std::env::var("ST_E2E_JOIN").ok().filter(|c| !c.trim().is_empty())?;
    Some(json!({
        "code": code,
        "name": std::env::var("ST_E2E_NAME").unwrap_or_else(|_| "Linux-E2E".into()),
        "seconds": std::env::var("ST_E2E_SECONDS").ok().and_then(|s| s.parse::<u32>().ok()).unwrap_or(90),
    }))
}

#[tauri::command]
pub fn test_report(line: String, done: bool, ok: bool) {
    if std::env::var("ST_E2E_JOIN").map(|c| c.trim().is_empty()).unwrap_or(true) {
        return;
    }
    println!("[e2e] {line}");
    if done {
        println!("[e2e] RESULT {}", if ok { "PASS" } else { "FAIL" });
        close_all();
        std::process::exit(if ok { 0 } else { 1 });
    }
}

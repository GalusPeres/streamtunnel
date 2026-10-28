//! Windows: sound for a share via WASAPI process loopback (Windows 10 2004+ / Windows 11), like Discord does it.
//! - Screen share: all system sound EXCEPT StreamTunnel's own process tree (no echo of the stream you watch).
//! - Window share: only the captured window's process tree (e.g. just the game).
//! The page gets 48 kHz stereo f32 PCM (interleaved) over a Tauri Channel as raw bytes, 20 ms per message, and
//! turns it into an audio track (src/rtc/sysaudio.ts). The browser's own "share system audio" checkbox is not used.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::ipc::{Channel, InvokeResponseBody};
use wasapi::{initialize_mta, AudioClient, Direction, SampleType, StreamMode, WaveFormat};

const RATE: u64 = 48_000;
const CHANNELS: usize = 2;
const BYTES_PER_FRAME: usize = CHANNELS * 4;
/// 20 ms per message (every message is one IPC fetch on the page side: 50/s instead of 100/s)
const CHUNK_FRAMES: usize = 960;
/// Loopback delivers nothing while the target is silent: after this much silence, fill in zeros (keeps the track
/// running at real time so WebRTC never sees gaps).
const MAX_LAG_FRAMES: u64 = 2 * CHUNK_FRAMES as u64;

static NEXT_ID: AtomicU32 = AtomicU32::new(1);
static RUNNING: Mutex<Option<(u32, Arc<AtomicBool>)>> = Mutex::new(None);

/// Gets every 20 ms chunk the capture hands to the page (f32 interleaved stereo, 48 kHz).
pub type Tap = Box<dyn FnMut(&[f32]) + Send>;
static TAP: Mutex<Option<Tap>> = Mutex::new(None);

/// Native path (native_media.rs): taps the running capture for a native share's sound, so there is never a second
/// WASAPI client. None removes the tap.
pub fn set_tap(tap: Option<Tap>) {
    if let Ok(mut t) = TAP.lock() {
        *t = tap;
    }
}

fn tap(chunk: &[u8]) {
    let Ok(mut guard) = TAP.lock() else { return };
    if let Some(f) = guard.as_mut() {
        let pcm: Vec<f32> = chunk.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect();
        f(&pcm);
    }
}

fn open(target: Option<u32>) -> Result<AudioClient, String> {
    let mut client = match target {
        Some(pid) => AudioClient::new_application_loopback_client(pid, true),
        None => AudioClient::new_application_loopback_client(std::process::id(), false),
    }
    .map_err(|e| format!("loopback: {e}"))?;
    let format = WaveFormat::new(32, 32, &SampleType::Float, RATE as usize, CHANNELS, None);
    let mode = StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: 0 };
    client
        .initialize_client(&format, &Direction::Capture, &mode)
        .map_err(|e| format!("initialize: {e}"))?;
    Ok(client)
}

/// Whether process loopback works on this Windows (needs build 20348+). Checked once.
#[tauri::command]
pub fn sysaudio_supported() -> bool {
    static OK: OnceLock<bool> = OnceLock::new();
    *OK.get_or_init(|| {
        std::thread::spawn(|| {
            let _ = initialize_mta();
            open(None).is_ok()
        })
        .join()
        .unwrap_or(false)
    })
}

/// Process id of a window (the engine reports window shares as "window:<hwnd>:0").
#[tauri::command]
pub fn window_pid(hwnd: i64) -> Option<u32> {
    unsafe {
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowThreadProcessId, IsWindow};
        let h = hwnd as isize as windows_sys::Win32::Foundation::HWND;
        if hwnd == 0 || IsWindow(h) == 0 {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(h, &mut pid);
        if pid == 0 || pid == std::process::id() { None } else { Some(pid) }
    }
}

/// Starts capturing (stops a previous capture). `target` = process id of the shared window, or None for
/// "everything except StreamTunnel". Returns an id for `sysaudio_stop`.
#[tauri::command]
pub fn sysaudio_start(target: Option<u32>, events: Channel<InvokeResponseBody>) -> Result<u32, String> {
    stop_running();
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let run = Arc::new(AtomicBool::new(true));
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
    let flag = run.clone();
    std::thread::Builder::new()
        .name("st-sysaudio".into())
        .spawn(move || capture(target, move |chunk| events.send(InvokeResponseBody::Raw(chunk)).is_ok(), flag, ready_tx))
        .map_err(|e| e.to_string())?;
    match ready_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(())) => {
            *RUNNING.lock().unwrap() = Some((id, run));
            Ok(id)
        }
        Ok(Err(e)) => Err(e),
        Err(_) => {
            run.store(false, Ordering::Relaxed);
            Err("audio capture did not start".into())
        }
    }
}

#[tauri::command]
pub fn sysaudio_stop(id: u32) {
    let mut guard = RUNNING.lock().unwrap();
    if matches!(guard.as_ref(), Some((cur, _)) if *cur == id) {
        if let Some((_, run)) = guard.take() {
            run.store(false, Ordering::Relaxed);
        }
    }
}

/// Stops whatever capture is running (window closed, new capture).
pub fn stop_running() {
    if let Some((_, run)) = RUNNING.lock().unwrap().take() {
        run.store(false, Ordering::Relaxed);
    }
}

/// Capture loop: hands 20 ms chunks to `sink` (false = receiver gone → stop) until `run` is cleared.
fn capture(target: Option<u32>, mut sink: impl FnMut(Vec<u8>) -> bool, run: Arc<AtomicBool>, ready: mpsc::Sender<Result<(), String>>) {
    let _ = initialize_mta();
    let client = match open(target) {
        Ok(c) => c,
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    let setup = (|| {
        let event = client.set_get_eventhandle().map_err(|e| format!("event: {e}"))?;
        let reader = client.get_audiocaptureclient().map_err(|e| format!("capture client: {e}"))?;
        client.start_stream().map_err(|e| format!("start: {e}"))?;
        Ok::<_, String>((event, reader))
    })();
    let (event, reader) = match setup {
        Ok(v) => v,
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    let _ = ready.send(Ok(()));

    let chunk_bytes = CHUNK_FRAMES * BYTES_PER_FRAME;
    let mut queue: VecDeque<u8> = VecDeque::with_capacity(chunk_bytes * 8);
    let start = Instant::now();
    let mut sent_frames: u64 = 0;
    while run.load(Ordering::Relaxed) {
        let _ = event.wait_for_event(10); // timeout = nothing played → handled by the silence fill below
        loop {
            match reader.get_next_packet_size() {
                Ok(Some(n)) if n > 0 => {}
                _ => break,
            }
            let before = queue.len();
            match reader.read_from_device_to_deque(&mut queue) {
                Ok(info) if info.flags.silent => {
                    for b in queue.iter_mut().skip(before) {
                        *b = 0;
                    }
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
        // keep real time: fill silence while the target plays nothing
        let due = start.elapsed().as_micros() as u64 * RATE / 1_000_000;
        let have = sent_frames + (queue.len() / BYTES_PER_FRAME) as u64;
        if due > have + MAX_LAG_FRAMES {
            let missing = (due - have - CHUNK_FRAMES as u64) as usize;
            queue.extend(std::iter::repeat_n(0u8, missing * BYTES_PER_FRAME));
        }
        // never build up more than ~100 ms (e.g. the page stalled): drop the oldest audio
        let max_bytes = 5 * chunk_bytes;
        if queue.len() > max_bytes {
            let drop = (queue.len() - max_bytes) / BYTES_PER_FRAME * BYTES_PER_FRAME;
            queue.drain(..drop);
            sent_frames += (drop / BYTES_PER_FRAME) as u64;
        }
        while queue.len() >= chunk_bytes {
            let chunk: Vec<u8> = queue.drain(..chunk_bytes).collect();
            sent_frames += CHUNK_FRAMES as u64;
            tap(&chunk);
            if !sink(chunk) {
                run.store(false, Ordering::Relaxed);
                break;
            }
        }
    }
    let _ = client.stop_stream();
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs on a real Windows machine: capture "everything except us" for 0.5 s. Even with nothing playing the
    /// silence fill must deliver ~real-time 20 ms chunks of 48 kHz stereo f32.
    #[test]
    fn loopback_delivers_real_time_chunks() {
        if !sysaudio_supported() {
            eprintln!("process loopback not available on this Windows - skipped");
            return;
        }
        let run = Arc::new(AtomicBool::new(true));
        let (ready_tx, ready_rx) = mpsc::channel();
        let got = Arc::new(Mutex::new(Vec::<usize>::new()));
        let sink_got = got.clone();
        let flag = run.clone();
        let t = std::thread::spawn(move || {
            capture(None, move |c| {
                sink_got.lock().unwrap().push(c.len());
                true
            }, flag, ready_tx)
        });
        ready_rx.recv_timeout(Duration::from_secs(5)).expect("ready").expect("started");
        std::thread::sleep(Duration::from_millis(500));
        run.store(false, Ordering::Relaxed);
        t.join().unwrap();
        let got = got.lock().unwrap();
        assert!(got.iter().all(|&n| n == CHUNK_FRAMES * BYTES_PER_FRAME), "chunk sizes {:?}", &got[..got.len().min(5)]);
        // 0.5 s = 25 chunks; allow start-up and the 40 ms lag window
        assert!(got.len() >= 20 && got.len() <= 28, "chunks in 0.5 s: {}", got.len());
    }
}

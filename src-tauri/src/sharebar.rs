//! Windows: keeps WebView2's "tauri.localhost is sharing your screen" bar hidden while we share.
//!
//! getDisplayMedia makes WebView2 show that bar as a topmost window (over the game) for the whole share, and
//! WebView2 has no setting for it. The app shows its own share state, so while a share runs a watcher hides the
//! bar the way its own "Hide" button does: a small visible top-level window of one of our WebView2 processes whose
//! title names our host. Windows of other programs (other Tauri apps included) are never touched.
use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{CloseHandle, HWND, INVALID_HANDLE_VALUE, LPARAM, RECT};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::Threading::GetCurrentProcessId;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible, ShowWindowAsync, SW_HIDE,
};

/// The bar's title contains the page's host.
const HOST: &str = "tauri.localhost";
/// The bar is one line of text and two buttons (physical pixels, any DPI).
const MAX_HEIGHT: i32 = 240;
const POLL: Duration = Duration::from_millis(250);
const PIDS_EVERY: Duration = Duration::from_secs(3);

/// Bumped on every start / stop: a watcher runs while the generation it started with is current.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Starts (`hide`) or stops the watcher.
pub fn set(hide: bool) {
    let gen = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    if hide {
        std::thread::spawn(move || watch(gen));
    }
}

fn watch(gen: u64) {
    let mut pids = HashSet::new();
    let mut pids_at: Option<Instant> = None;
    while GENERATION.load(Ordering::SeqCst) == gen {
        if pids_at.map_or(true, |t| t.elapsed() >= PIDS_EVERY) {
            pids = descendants();
            pids_at = Some(Instant::now());
        }
        if !pids.is_empty() {
            hide_bars(&pids);
        }
        std::thread::sleep(POLL);
    }
}

/// Every process below ours: WebView2's browser process (it owns the bar) and its helpers.
fn descendants() -> HashSet<u32> {
    let mut out = HashSet::new();
    let mut edges = Vec::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return out;
        }
        let mut e: PROCESSENTRY32W = std::mem::zeroed();
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut ok = Process32FirstW(snap, &mut e);
        while ok != 0 {
            edges.push((e.th32ParentProcessID, e.th32ProcessID));
            ok = Process32NextW(snap, &mut e);
        }
        CloseHandle(snap);
    }
    let me = unsafe { GetCurrentProcessId() };
    let mut frontier = vec![me];
    while let Some(parent) = frontier.pop() {
        for &(p, c) in &edges {
            if p == parent && c != me && out.insert(c) {
                frontier.push(c);
            }
        }
    }
    out
}

fn hide_bars(pids: &HashSet<u32>) {
    unsafe extern "system" fn each(h: HWND, lp: LPARAM) -> i32 {
        let pids = unsafe { &*(lp as *const HashSet<u32>) };
        unsafe {
            if IsWindowVisible(h) == 0 {
                return 1;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(h, &mut pid);
            if !pids.contains(&pid) {
                return 1;
            }
            let mut r: RECT = std::mem::zeroed();
            if GetWindowRect(h, &mut r) == 0 || r.bottom - r.top > MAX_HEIGHT {
                return 1;
            }
            let mut buf = [0u16; 512];
            let n = GetWindowTextW(h, buf.as_mut_ptr(), buf.len() as i32);
            if n > 0 && String::from_utf16_lossy(&buf[..n as usize]).contains(HOST) {
                ShowWindowAsync(h, SW_HIDE);
            }
        }
        1
    }
    unsafe {
        EnumWindows(Some(each), pids as *const HashSet<u32> as LPARAM);
    }
}

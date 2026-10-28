//! Scheduling help for the capture → encode path (docs/NATIVE-PATH.md §3.4), all best effort and logged once:
//! * the process's GPU scheduling class HIGH (`D3DKMTSetProcessSchedulingPriorityClass`, gdi32; never REALTIME),
//!   so our small convert + encode jobs are not queued behind a game's frame;
//! * the device's GPU thread priority 7 (`IDXGIDevice::SetGPUThreadPriority`);
//! * MMCSS "Games" for the `st-capture` thread and a 1 ms timer period while it runs (its waits are frame-timed).

use std::sync::Once;

use windows::core::{s, w, Interface};
use windows::Win32::Foundation::HANDLE;
use windows::Win32::Graphics::Direct3D11::ID3D11Device;
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::Media::{timeBeginPeriod, timeEndPeriod};
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32};
use windows::Win32::System::Threading::{AvRevertMmThreadCharacteristics, AvSetMmThreadCharacteristicsW, GetCurrentProcess};

/// `D3DKMT_SCHEDULINGPRIORITYCLASS_HIGH`
const SCHEDULING_CLASS_HIGH: i32 = 4;

/// Raises the process's GPU scheduling class to HIGH (once per process).
pub fn boost_process() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        type SetClass = unsafe extern "system" fn(process: HANDLE, class: i32) -> i32;
        let status = unsafe {
            let Ok(gdi) = LoadLibraryExW(w!("gdi32.dll"), None, LOAD_LIBRARY_SEARCH_SYSTEM32) else { return };
            let Some(f) = GetProcAddress(gdi, s!("D3DKMTSetProcessSchedulingPriorityClass")) else { return };
            let f: SetClass = std::mem::transmute(f);
            f(GetCurrentProcess(), SCHEDULING_CLASS_HIGH)
        };
        if status != 0 {
            eprintln!("[native] GPU scheduling class HIGH refused (NTSTATUS {status:#x})");
        }
    });
}

/// GPU thread priority 7 for `device` (the highest a normal process may set).
pub fn boost_device(device: &ID3D11Device) {
    let r = device.cast::<IDXGIDevice>().and_then(|d| unsafe { d.SetGPUThreadPriority(7) });
    if let Err(e) = r {
        eprintln!("[native] GPU thread priority not set ({e})");
    }
}

/// MMCSS "Games" and a 1 ms timer period for the calling thread until dropped.
pub struct ThreadBoost {
    mmcss: Option<HANDLE>,
}

impl ThreadBoost {
    pub fn new() -> ThreadBoost {
        unsafe { timeBeginPeriod(1) };
        let mut index = 0u32;
        let mmcss = match unsafe { AvSetMmThreadCharacteristicsW(w!("Games"), &mut index) } {
            Ok(h) => Some(h),
            Err(e) => {
                eprintln!("[native] MMCSS 'Games' not set ({e})");
                None
            }
        };
        ThreadBoost { mmcss }
    }
}

impl Default for ThreadBoost {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for ThreadBoost {
    fn drop(&mut self) {
        if let Some(h) = self.mmcss.take() {
            let _ = unsafe { AvRevertMmThreadCharacteristics(h) };
        }
        unsafe { timeEndPeriod(1) };
    }
}

//! D3D11 on the NVIDIA adapter: the device every stage shares, the BGRA → NV12 conversion + scaling (the in-box
//! ID3D11VideoProcessor, BT.709 limited range, so NVENC gets NV12 and never needs its CUDA RGB path), and a
//! synthetic test pattern for headless tests.
#![allow(unused_variables, dead_code)] // skeleton: remove when the bodies are filled

use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D};

/// PCI vendor id of NVIDIA.
pub const VENDOR_NVIDIA: u32 = 0x10DE;
/// Largest output size of the native path (the "native" resolution setting = up to 3840 × 2160).
pub const MAX_OUT_WIDTH: u32 = 3840;
pub const MAX_OUT_HEIGHT: u32 = 2160;

/// One D3D11 device on the adapter that owns NVENC.
pub struct Gpu {
    pub device: ID3D11Device,
    pub context: ID3D11DeviceContext,
    /// WinRT wrapper of `device` for the WGC frame pool
    pub winrt: IDirect3DDevice,
    /// adapter description, e.g. "NVIDIA GeForce RTX 4080"
    pub name: String,
    pub vendor: u32,
}

impl Gpu {
    /// Device on the first NVIDIA DXGI adapter: D3D_DRIVER_TYPE_UNKNOWN, BGRA_SUPPORT | VIDEO_SUPPORT,
    /// multithread protection on (capture callback and encoder thread share the immediate context).
    pub fn nvidia() -> Result<Gpu, String> {
        todo!("WIN")
    }
}

/// Encoder size for a source of `src_w × src_h`: the source size, scaled down (aspect kept) to at most
/// `max_height` lines (0 = "native") and to [`MAX_OUT_WIDTH`] × [`MAX_OUT_HEIGHT`], rounded down to even.
/// Never scales up. Fixed for the life of a source: only a new source size or a user setting changes it.
pub fn output_size(src_w: u32, src_h: u32, max_height: u32) -> (u32, u32) {
    let mut w = src_w.max(2) as f64;
    let mut h = src_h.max(2) as f64;
    let limit_h = if max_height > 0 { max_height.min(MAX_OUT_HEIGHT) } else { MAX_OUT_HEIGHT } as f64;
    let scale = (limit_h / h).min(MAX_OUT_WIDTH as f64 / w).min(1.0);
    w = (w * scale).floor();
    h = (h * scale).floor();
    ((w as u32 & !1).max(2), (h as u32 & !1).max(2))
}

/// BGRA (capture) → NV12 (encoder input) with scaling, on the GPU's video processor.
pub struct Converter {
    // filled by WIN
}

impl Converter {
    pub fn new(gpu: &Gpu, in_w: u32, in_h: u32, out_w: u32, out_h: u32) -> Result<Converter, String> {
        todo!("WIN")
    }

    /// Converts `src` (BGRA, `in_w × in_h`) into `dst` (NV12, `out_w × out_h`, render-target bindable).
    /// Letterboxes when the aspect differs (black bars, never stretched).
    pub fn convert(&mut self, src: &ID3D11Texture2D, dst: &ID3D11Texture2D) -> Result<(), String> {
        todo!("WIN")
    }
}

/// Synthetic BGRA frames for tests: moving bars and a frame counter drawn on the GPU (no screen access).
pub struct TestPattern {
    // filled by WIN
}

impl TestPattern {
    pub fn new(gpu: &Gpu, width: u32, height: u32) -> Result<TestPattern, String> {
        todo!("WIN")
    }

    /// The next frame (a texture owned by the pattern, valid until the next call).
    pub fn next(&mut self) -> Result<ID3D11Texture2D, String> {
        todo!("WIN")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_sizes() {
        assert_eq!(output_size(2560, 1440, 0), (2560, 1440));
        assert_eq!(output_size(2560, 1440, 1080), (1920, 1080));
        assert_eq!(output_size(5120, 2880, 0), (3840, 2160));
        assert_eq!(output_size(1280, 720, 1440), (1280, 720));
        assert_eq!(output_size(1001, 701, 0), (1000, 700));
        assert_eq!(output_size(3440, 1440, 1080), (2580, 1080));
    }
}

//! D3D11 on the NVIDIA adapter: the device every stage shares, the BGRA → NV12 conversion + scaling (the in-box
//! ID3D11VideoProcessor, BT.709 limited range, so NVENC gets NV12 and never needs its CUDA RGB path), and a
//! synthetic test pattern for headless tests.

use windows::core::{Interface, BOOL};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Win32::Foundation::{HMODULE, RECT};
use windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIAdapter1, IDXGIDevice, IDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE};
use windows::Win32::System::WinRT::Direct3D11::CreateDirect3D11DeviceFromDXGIDevice;

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
        let (adapter, name) = nvidia_adapter()?;
        let mut device = None;
        let mut context = None;
        unsafe {
            D3D11CreateDevice(
                &adapter,
                D3D_DRIVER_TYPE_UNKNOWN,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT | D3D11_CREATE_DEVICE_VIDEO_SUPPORT,
                Some(&[D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0]),
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
        }
        .map_err(|e| format!("D3D11CreateDevice: {e}"))?;
        let device: ID3D11Device = device.ok_or("D3D11CreateDevice: no device")?;
        let context: ID3D11DeviceContext = context.ok_or("D3D11CreateDevice: no context")?;
        // the WGC frame pool thread copies frames while the capture thread converts and encodes
        let mt: ID3D11Multithread = device.cast().map_err(|e| format!("ID3D11Multithread: {e}"))?;
        unsafe {
            let _ = mt.SetMultithreadProtected(true);
        }
        let dxgi: IDXGIDevice = device.cast().map_err(|e| format!("IDXGIDevice: {e}"))?;
        let winrt: IDirect3DDevice = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi) }
            .and_then(|i| i.cast())
            .map_err(|e| format!("CreateDirect3D11DeviceFromDXGIDevice: {e}"))?;
        Ok(Gpu { device, context, winrt, name, vendor: VENDOR_NVIDIA })
    }

    /// Name of the first NVIDIA adapter without creating a device ("" when there is none).
    pub fn nvidia_name() -> String {
        nvidia_adapter().map(|(_, n)| n).unwrap_or_default()
    }

}

fn nvidia_adapter() -> Result<(IDXGIAdapter1, String), String> {
    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1() }.map_err(|e| format!("CreateDXGIFactory1: {e}"))?;
    let mut i = 0;
    while let Ok(adapter) = unsafe { factory.EnumAdapters1(i) } {
        i += 1;
        let Ok(desc) = (unsafe { adapter.GetDesc1() }) else { continue };
        if desc.VendorId == VENDOR_NVIDIA && desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 == 0 {
            let len = desc.Description.iter().position(|&c| c == 0).unwrap_or(desc.Description.len());
            return Ok((adapter, String::from_utf16_lossy(&desc.Description[..len])));
        }
    }
    Err("no NVIDIA adapter".into())
}

fn texture(
    device: &ID3D11Device,
    width: u32,
    height: u32,
    format: DXGI_FORMAT,
    bind: i32,
    init: Option<(&[u8], u32)>,
) -> Result<ID3D11Texture2D, String> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 1,
        Format: format,
        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: bind as u32,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    };
    let data = init.map(|(bytes, pitch)| D3D11_SUBRESOURCE_DATA { pSysMem: bytes.as_ptr().cast(), SysMemPitch: pitch, SysMemSlicePitch: 0 });
    let mut tex = None;
    unsafe { device.CreateTexture2D(&desc, data.as_ref().map(|d| d as *const _), Some(&mut tex)) }
        .map_err(|e| format!("CreateTexture2D {width}x{height}: {e}"))?;
    tex.ok_or_else(|| "CreateTexture2D: no texture".into())
}

/// A BGRA texture usable as WGC copy target, video processor input and render target.
pub fn bgra_texture(device: &ID3D11Device, width: u32, height: u32) -> Result<ID3D11Texture2D, String> {
    texture(device, width, height, DXGI_FORMAT_B8G8R8A8_UNORM, D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0, None)
}

/// An NV12 texture the video processor can render into and NVENC can register (encoder input slot).
pub fn nv12_texture(device: &ID3D11Device, width: u32, height: u32) -> Result<ID3D11Texture2D, String> {
    texture(device, width, height, DXGI_FORMAT_NV12, D3D11_BIND_RENDER_TARGET.0, None)
}

/// Size of a texture.
pub fn texture_size(tex: &ID3D11Texture2D) -> (u32, u32) {
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe { tex.GetDesc(&mut desc) };
    (desc.Width, desc.Height)
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

/// Where a `src_w × src_h` picture lands inside `out_w × out_h` with its aspect kept (centered, even edges):
/// (x, y, w, h). The rest is black bars.
pub fn letterbox(src_w: u32, src_h: u32, out_w: u32, out_h: u32) -> (u32, u32, u32, u32) {
    let scale = (out_w as f64 / src_w.max(1) as f64).min(out_h as f64 / src_h.max(1) as f64);
    // within half a pixel of the full width / height: fill it (no 1-pixel bars from rounding)
    let fit = |v: f64, full: u32| if (v - full as f64).abs() < 2.0 { full } else { (v.round() as u32 & !1).clamp(2, full) };
    let w = fit(src_w as f64 * scale, out_w);
    let h = fit(src_h as f64 * scale, out_h);
    (((out_w - w) / 2) & !1, ((out_h - h) / 2) & !1, w, h)
}

/// Views stay cached for this many textures (the capture texture, WGC re-creations, the encoder's NV12 slots).
const VIEW_CACHE: usize = 4;

/// BGRA (capture) → NV12 (encoder input) with scaling, on the GPU's video processor.
pub struct Converter {
    video: ID3D11VideoDevice,
    vctx: ID3D11VideoContext1,
    enumerator: ID3D11VideoProcessorEnumerator,
    processor: ID3D11VideoProcessor,
    out_w: u32,
    out_h: u32,
    inputs: Vec<(ID3D11Texture2D, ID3D11VideoProcessorInputView)>,
    outputs: Vec<(ID3D11Texture2D, ID3D11VideoProcessorOutputView)>,
}

impl Converter {
    pub fn new(gpu: &Gpu, in_w: u32, in_h: u32, out_w: u32, out_h: u32) -> Result<Converter, String> {
        let video: ID3D11VideoDevice = gpu.device.cast().map_err(|e| format!("ID3D11VideoDevice: {e}"))?;
        let vctx: ID3D11VideoContext1 = gpu.context.cast().map_err(|e| format!("ID3D11VideoContext1: {e}"))?;
        let desc = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
            InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
            InputFrameRate: DXGI_RATIONAL { Numerator: 60, Denominator: 1 },
            InputWidth: in_w.max(2),
            InputHeight: in_h.max(2),
            OutputFrameRate: DXGI_RATIONAL { Numerator: 60, Denominator: 1 },
            OutputWidth: out_w,
            OutputHeight: out_h,
            Usage: D3D11_VIDEO_USAGE_OPTIMAL_SPEED,
        };
        let enumerator = unsafe { video.CreateVideoProcessorEnumerator(&desc) }.map_err(|e| format!("CreateVideoProcessorEnumerator: {e}"))?;
        let input_ok = unsafe { enumerator.CheckVideoProcessorFormat(DXGI_FORMAT_B8G8R8A8_UNORM) }.unwrap_or(0)
            & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_INPUT.0 as u32;
        let output_ok =
            unsafe { enumerator.CheckVideoProcessorFormat(DXGI_FORMAT_NV12) }.unwrap_or(0) & D3D11_VIDEO_PROCESSOR_FORMAT_SUPPORT_OUTPUT.0 as u32;
        if input_ok == 0 || output_ok == 0 {
            return Err("video processor cannot convert BGRA to NV12".into());
        }
        let processor = unsafe { video.CreateVideoProcessor(&enumerator, 0) }.map_err(|e| format!("CreateVideoProcessor: {e}"))?;
        unsafe {
            // sRGB-ish desktop pixels in, BT.709 limited-range YCbCr out (what the VUI says)
            vctx.VideoProcessorSetStreamColorSpace1(&processor, 0, DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709);
            vctx.VideoProcessorSetOutputColorSpace1(&processor, DXGI_COLOR_SPACE_YCBCR_STUDIO_G22_LEFT_P709);
            vctx.VideoProcessorSetStreamFrameFormat(&processor, 0, D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE);
            vctx.VideoProcessorSetStreamAutoProcessingMode(&processor, 0, false);
            let full = RECT { left: 0, top: 0, right: out_w as i32, bottom: out_h as i32 };
            vctx.VideoProcessorSetOutputTargetRect(&processor, true, Some(&full));
            // black bars: Y 16, Cb/Cr 128 in limited range
            let black = D3D11_VIDEO_COLOR {
                Anonymous: D3D11_VIDEO_COLOR_0 { YCbCr: D3D11_VIDEO_COLOR_YCbCrA { Y: 16.0 / 255.0, Cb: 0.5, Cr: 0.5, A: 1.0 } },
            };
            vctx.VideoProcessorSetOutputBackgroundColor(&processor, true, &black);
        }
        Ok(Converter { video, vctx: vctx.clone(), enumerator, processor, out_w, out_h, inputs: Vec::new(), outputs: Vec::new() })
    }

    pub fn output_size(&self) -> (u32, u32) {
        (self.out_w, self.out_h)
    }

    /// Converts `src` (BGRA, any size) into `dst` (NV12, `out_w × out_h`, render-target bindable).
    /// Letterboxes when the aspect differs (black bars, never stretched).
    pub fn convert(&mut self, src: &ID3D11Texture2D, dst: &ID3D11Texture2D) -> Result<(), String> {
        let (sw, sh) = texture_size(src);
        let input = self.input_view(src)?;
        let output = self.output_view(dst)?;
        let (x, y, w, h) = letterbox(sw, sh, self.out_w, self.out_h);
        let src_rect = RECT { left: 0, top: 0, right: sw as i32, bottom: sh as i32 };
        let dst_rect = RECT { left: x as i32, top: y as i32, right: (x + w) as i32, bottom: (y + h) as i32 };
        let mut stream = D3D11_VIDEO_PROCESSOR_STREAM {
            Enable: BOOL::from(true),
            pInputSurface: std::mem::ManuallyDrop::new(Some(input)),
            ..Default::default()
        };
        let r = unsafe {
            self.vctx.VideoProcessorSetStreamSourceRect(&self.processor, 0, true, Some(&src_rect));
            self.vctx.VideoProcessorSetStreamDestRect(&self.processor, 0, true, Some(&dst_rect));
            self.vctx.VideoProcessorBlt(&self.processor, &output, 0, std::slice::from_ref(&stream))
        };
        unsafe { std::mem::ManuallyDrop::drop(&mut stream.pInputSurface) };
        r.map_err(|e| format!("VideoProcessorBlt: {e}"))
    }

    fn input_view(&mut self, tex: &ID3D11Texture2D) -> Result<ID3D11VideoProcessorInputView, String> {
        if let Some((_, v)) = self.inputs.iter().find(|(t, _)| t == tex) {
            return Ok(v.clone());
        }
        let desc = D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
            FourCC: 0,
            ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPIV { MipSlice: 0, ArraySlice: 0 } },
        };
        let mut view = None;
        unsafe { self.video.CreateVideoProcessorInputView(tex, &self.enumerator, &desc, Some(&mut view)) }
            .map_err(|e| format!("CreateVideoProcessorInputView: {e}"))?;
        let view = view.ok_or("CreateVideoProcessorInputView: no view")?;
        if self.inputs.len() >= VIEW_CACHE {
            self.inputs.remove(0);
        }
        self.inputs.push((tex.clone(), view.clone()));
        Ok(view)
    }

    fn output_view(&mut self, tex: &ID3D11Texture2D) -> Result<ID3D11VideoProcessorOutputView, String> {
        if let Some((_, v)) = self.outputs.iter().find(|(t, _)| t == tex) {
            return Ok(v.clone());
        }
        let desc = D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
            ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
            Anonymous: D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC_0 { Texture2D: D3D11_TEX2D_VPOV { MipSlice: 0 } },
        };
        let mut view = None;
        unsafe { self.video.CreateVideoProcessorOutputView(tex, &self.enumerator, &desc, Some(&mut view)) }
            .map_err(|e| format!("CreateVideoProcessorOutputView: {e}"))?;
        let view = view.ok_or("CreateVideoProcessorOutputView: no view")?;
        if self.outputs.len() >= VIEW_CACHE {
            self.outputs.remove(0);
        }
        self.outputs.push((tex.clone(), view.clone()));
        Ok(view)
    }
}

/// Pixels the test pattern scrolls per frame.
const PATTERN_SCROLL_PX: u32 = 8;
/// Frame counter: this many bits as squares of this size along the top-left edge.
const COUNTER_BITS: u32 = 16;
const COUNTER_CELL: u32 = 16;
/// The noise band (bottom quarter) jumps by up to this many pixels per frame in x and y.
const NOISE_JUMP: u32 = 128;

/// Synthetic BGRA frames for tests: moving bars, a noise band and a frame counter drawn on the GPU (no screen
/// access). The pictures are uploaded once; every frame scrolls the bars horizontally with two GPU copies, copies
/// the bottom quarter from a random spot of a noise texture (motion search cannot follow it, so the encoder really
/// has to spend its CBR budget) and stamps the frame number as black / white squares (`ClearView`).
pub struct TestPattern {
    context: ID3D11DeviceContext1,
    base: ID3D11Texture2D,
    noise: ID3D11Texture2D,
    out: ID3D11Texture2D,
    rtv: ID3D11RenderTargetView,
    width: u32,
    height: u32,
    frame: u32,
}

impl TestPattern {
    pub fn new(gpu: &Gpu, width: u32, height: u32) -> Result<TestPattern, String> {
        if width < COUNTER_BITS * COUNTER_CELL || height < 2 * COUNTER_CELL {
            return Err(format!("test pattern too small: {width}x{height}"));
        }
        let pixels = pattern_pixels(width, height);
        let base = texture(&gpu.device, width, height, DXGI_FORMAT_B8G8R8A8_UNORM, D3D11_BIND_SHADER_RESOURCE.0, Some((&pixels, width * 4)))?;
        let (nw, nh) = (width + NOISE_JUMP, noise_band(height) + NOISE_JUMP);
        let noise_px = noise_pixels(nw, nh);
        let noise = texture(&gpu.device, nw, nh, DXGI_FORMAT_B8G8R8A8_UNORM, D3D11_BIND_SHADER_RESOURCE.0, Some((&noise_px, nw * 4)))?;
        let out = bgra_texture(&gpu.device, width, height)?;
        let mut rtv = None;
        unsafe { gpu.device.CreateRenderTargetView(&out, None, Some(&mut rtv)) }.map_err(|e| format!("CreateRenderTargetView: {e}"))?;
        let context: ID3D11DeviceContext1 = gpu.context.cast().map_err(|e| format!("ID3D11DeviceContext1: {e}"))?;
        Ok(TestPattern { context, base, noise, out, rtv: rtv.ok_or("no render target view")?, width, height, frame: 0 })
    }

    /// Frames produced so far (the number stamped on the next frame).
    pub fn frame(&self) -> u32 {
        self.frame
    }

    /// The next frame (a texture owned by the pattern, valid until the next call).
    #[allow(clippy::should_implement_trait)] // not an iterator: every call draws on the GPU
    pub fn next(&mut self) -> Result<ID3D11Texture2D, String> {
        let (w, h) = (self.width, self.height);
        let shift = (self.frame.wrapping_mul(PATTERN_SCROLL_PX)) % w;
        unsafe {
            // out[0 .. w - shift] = base[shift .. w], out[w - shift .. w] = base[0 .. shift]
            let right = D3D11_BOX { left: shift, top: 0, front: 0, right: w, bottom: h, back: 1 };
            self.context.CopySubresourceRegion(&self.out, 0, 0, 0, 0, &self.base, 0, Some(&right));
            if shift > 0 {
                let left = D3D11_BOX { left: 0, top: 0, front: 0, right: shift, bottom: h, back: 1 };
                self.context.CopySubresourceRegion(&self.out, 0, w - shift, 0, 0, &self.base, 0, Some(&left));
            }
            let band = noise_band(h);
            let jump = self.frame.wrapping_mul(2_654_435_761);
            let (nx, ny) = ((jump >> 8) % NOISE_JUMP, (jump >> 20) % NOISE_JUMP);
            let noise = D3D11_BOX { left: nx, top: ny, front: 0, right: nx + w, bottom: ny + band, back: 1 };
            self.context.CopySubresourceRegion(&self.out, 0, 0, h - band, 0, &self.noise, 0, Some(&noise));
            let (mut on, mut off) = (Vec::new(), Vec::new());
            for bit in 0..COUNTER_BITS {
                let x = (bit * COUNTER_CELL) as i32;
                let r = RECT { left: x, top: 0, right: x + COUNTER_CELL as i32, bottom: COUNTER_CELL as i32 };
                if self.frame >> (COUNTER_BITS - 1 - bit) & 1 == 1 { on.push(r) } else { off.push(r) }
            }
            if !on.is_empty() {
                self.context.ClearView(&self.rtv, &[1.0, 1.0, 1.0, 1.0], Some(&on));
            }
            if !off.is_empty() {
                self.context.ClearView(&self.rtv, &[0.0, 0.0, 0.0, 1.0], Some(&off));
            }
        }
        self.frame = self.frame.wrapping_add(1);
        Ok(self.out.clone())
    }
}

/// Lines of the noise band at the bottom of a `height`-line pattern (a quarter, even).
fn noise_band(height: u32) -> u32 {
    (height / 4) & !1
}

/// Grey-ish random pixels (xorshift), BGRA rows.
fn noise_pixels(width: u32, height: u32) -> Vec<u8> {
    let mut x = 0x9e37_79b9u32;
    let mut px = vec![255u8; (width * height * 4) as usize];
    for p in px.chunks_mut(4) {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        let v = (x >> 24) as u8;
        p[..3].copy_from_slice(&[v, v.wrapping_add((x >> 8) as u8 & 31), v.wrapping_sub((x >> 16) as u8 & 31)]);
    }
    px
}

/// The still picture of the test pattern (BGRA rows): eight colour bars with a fine grid in the top two thirds,
/// a grey ramp with a checkerboard below — enough detail that the encoder has real work, cheap to make.
fn pattern_pixels(width: u32, height: u32) -> Vec<u8> {
    const BARS: [[u8; 3]; 8] =
        [[235, 235, 235], [235, 235, 16], [16, 235, 235], [16, 235, 16], [235, 16, 235], [235, 16, 16], [16, 16, 235], [16, 16, 16]];
    let mut px = vec![0u8; (width * height * 4) as usize];
    for y in 0..height {
        for x in 0..width {
            let (r, g, b) = if y < height * 2 / 3 {
                let [r, g, b] = BARS[(x * 8 / width) as usize];
                // thin lines every 32 px, a little texture so flat areas are not free
                if x % 32 == 0 || y % 32 == 0 {
                    (255 - r, 255 - g, 255 - b)
                } else {
                    let n = ((x.wrapping_mul(2_654_435_761) ^ y.wrapping_mul(40_503)) >> 27) as u8;
                    (r.saturating_add(n), g.saturating_add(n), b.saturating_add(n))
                }
            } else {
                let v = (x * 255 / width) as u8;
                let v = if (x / 16 + y / 16) % 2 == 0 { v } else { 255 - v };
                (v, v, v)
            };
            let i = ((y * width + x) * 4) as usize;
            px[i..i + 4].copy_from_slice(&[b, g, r, 255]);
        }
    }
    px
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

    #[test]
    fn letterbox_keeps_aspect() {
        assert_eq!(letterbox(2560, 1440, 2560, 1440), (0, 0, 2560, 1440));
        assert_eq!(letterbox(2560, 1440, 1920, 1080), (0, 0, 1920, 1080));
        // a window that grew wider than the encoder size: bars top and bottom
        assert_eq!(letterbox(2000, 800, 1000, 800), (0, 200, 1000, 400));
        // taller: bars left and right
        assert_eq!(letterbox(800, 800, 1600, 900), (350, 0, 900, 900));
        // rounding never leaves a 1-pixel bar
        assert_eq!(letterbox(1921, 1081, 1920, 1080), (0, 0, 1920, 1080));
    }

    #[test]
    fn pattern_has_detail() {
        let px = pattern_pixels(256, 96);
        assert_eq!(px.len(), 256 * 96 * 4);
        let distinct: std::collections::HashSet<_> = px.chunks(4).map(|c| (c[0], c[1], c[2])).collect();
        assert!(distinct.len() > 50);
    }
}

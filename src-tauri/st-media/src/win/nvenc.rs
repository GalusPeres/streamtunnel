//! NVENC session on the shared D3D11 device (docs/NATIVE-PATH.md §3.3).
//!
//! `nvEncodeAPI64.dll` is loaded once from System32 (`LoadLibraryExW(…, LOAD_LIBRARY_SEARCH_SYSTEM32)`), the
//! driver must support API ≥ 12.0 (`NvEncodeAPIGetMaxSupportedVersion`), then `NvEncOpenEncodeSessionEx(DIRECTX)`.
//! Settings for both codecs (H.264 High, HEVC Main 8-bit):
//! * preset P3 up to 1440p60, P1 above (4K or > 60 fps); `NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY`;
//! * `NV_ENC_PARAMS_RC_CBR` at the target, `multiPass = NV_ENC_TWO_PASS_QUARTER_RESOLUTION`,
//!   VBV buffer = initial delay = `vbv_frames` × bitrate / fps; `zeroReorderDelay = 1`, `enableLookahead = 0`,
//!   no AQ (temporal AQ never);
//! * `gopLength = idrPeriod = NVENC_INFINITE_GOPLENGTH`, `frameIntervalP = 1` (no B-frames), IDR only on request,
//!   `repeatSPSPPS = 1`, `outputAUD = 0`; DPB 5 with `numRefL0 = 1` (reference invalidation possible);
//! * intra refresh enabled (where the GPU has it) but never periodic: [`Encoder::intra_refresh`] starts one wave on
//!   request, an alternative to an IDR for decoders that recover from it (not used by WebCodecs viewers yet);
//! * VUI: BT.709 primaries / transfer / matrix, limited range (`videoFullRangeFlag = 0`), bitstream restriction
//!   (no reordering: decoders hand every frame out at once);
//! * input: [`INPUT_SLOTS`] NV12 textures registered once (`NvEncRegisterResource`), mapped per frame;
//!   synchronous mode (no async events): encode → lock bitstream → copy → unlock, all on the capture thread;
//! * `inputTimeStamp` = frame id, so `NvEncInvalidateRefFrames(frame id)` maps 1:1 to the network's frame ids.

use std::ffi::c_void;
use std::sync::OnceLock;

use windows::core::{s, w, Interface};
use windows::Win32::Foundation::HMODULE;
use windows::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11Texture2D};
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32};

use crate::win::d3d::{self, Gpu};
use crate::win::nvenc_sys::*;
use crate::Codec;

/// NV12 input textures the encoder owns (capture → convert → encode rotates through them).
pub const INPUT_SLOTS: usize = 3;
/// Reference frames kept (invalidating a range of this size or more falls back to an IDR).
pub const DPB_SIZE: u32 = 5;
/// Oldest driver API this crate accepts: 12.0 (`(major << 4) | minor`).
pub const MIN_DRIVER_API: u32 = 12 << 4;
/// Frames an on-request intra refresh wave spreads over (see [`Encoder::intra_refresh`]).
pub const INTRA_REFRESH_FRAMES: u32 = 10;

/// The loaded driver library (process-wide, never unloaded).
pub struct NvencLib {
    funcs: NV_ENCODE_API_FUNCTION_LIST,
    max_version: u32,
}

// The function list is a table of driver entry points, written once by NvEncodeAPICreateInstance; the driver's
// functions are thread-safe per session.
unsafe impl Send for NvencLib {}
unsafe impl Sync for NvencLib {}

impl NvencLib {
    /// Loads and validates the library once; later calls return the same result.
    pub fn get() -> Result<&'static NvencLib, String> {
        static LIB: OnceLock<Result<NvencLib, String>> = OnceLock::new();
        LIB.get_or_init(NvencLib::load).as_ref().map_err(|e| e.clone())
    }

    fn load() -> Result<NvencLib, String> {
        unsafe {
            let module: HMODULE = LoadLibraryExW(w!("nvEncodeAPI64.dll"), None, LOAD_LIBRARY_SEARCH_SYSTEM32)
                .map_err(|e| format!("nvEncodeAPI64.dll: {e}"))?;
            let max_proc = GetProcAddress(module, s!("NvEncodeAPIGetMaxSupportedVersion")).ok_or("NvEncodeAPIGetMaxSupportedVersion missing")?;
            let create_proc = GetProcAddress(module, s!("NvEncodeAPICreateInstance")).ok_or("NvEncodeAPICreateInstance missing")?;
            let get_max: NvEncodeAPIGetMaxSupportedVersion = std::mem::transmute(max_proc);
            let create: NvEncodeAPICreateInstance = std::mem::transmute(create_proc);
            let mut max_version = 0u32;
            check(get_max(&mut max_version), "NvEncodeAPIGetMaxSupportedVersion")?;
            if max_version < MIN_DRIVER_API {
                return Err(format!(
                    "driver supports NVENC API {}.{}, need {}.{} (update the NVIDIA driver)",
                    max_version >> 4,
                    max_version & 15,
                    NVENCAPI_MAJOR_VERSION,
                    NVENCAPI_MINOR_VERSION
                ));
            }
            let mut funcs: NV_ENCODE_API_FUNCTION_LIST = zeroed();
            funcs.version = NV_ENCODE_API_FUNCTION_LIST_VER;
            check(create(&mut funcs), "NvEncodeAPICreateInstance")?;
            let lib = NvencLib { funcs, max_version };
            lib.require()?;
            Ok(lib)
        }
    }

    /// Every entry point this crate calls must be present.
    fn require(&self) -> Result<(), String> {
        let f = &self.funcs;
        let present = [
            f.nvEncOpenEncodeSessionEx.is_some(),
            f.nvEncGetEncodeGUIDCount.is_some(),
            f.nvEncGetEncodeGUIDs.is_some(),
            f.nvEncGetEncodeCaps.is_some(),
            f.nvEncGetEncodePresetConfigEx.is_some(),
            f.nvEncInitializeEncoder.is_some(),
            f.nvEncCreateBitstreamBuffer.is_some(),
            f.nvEncDestroyBitstreamBuffer.is_some(),
            f.nvEncEncodePicture.is_some(),
            f.nvEncLockBitstream.is_some(),
            f.nvEncUnlockBitstream.is_some(),
            f.nvEncRegisterResource.is_some(),
            f.nvEncUnregisterResource.is_some(),
            f.nvEncMapInputResource.is_some(),
            f.nvEncUnmapInputResource.is_some(),
            f.nvEncDestroyEncoder.is_some(),
            f.nvEncInvalidateRefFrames.is_some(),
            f.nvEncReconfigureEncoder.is_some(),
        ];
        if present.iter().all(|&p| p) { Ok(()) } else { Err("NVENC function list incomplete".into()) }
    }

    /// (major, minor) of the newest API the driver supports.
    pub fn driver_api(&self) -> (u32, u32) {
        (self.max_version >> 4, self.max_version & 15)
    }
}

fn check(status: NVENCSTATUS, what: &str) -> Result<(), String> {
    if status == NV_ENC_SUCCESS { Ok(()) } else { Err(format!("{what}: {} ({status})", status_name(status))) }
}

// The entry points `require` checked once; a missing one cannot happen after `NvencLib::get` succeeded.
macro_rules! nv {
    ($lib:expr, $f:ident) => {
        $lib.funcs.$f.expect(stringify!($f))
    };
}

/// An open NVENC session handle; destroyed on drop (also on early returns while opening).
struct Session {
    lib: &'static NvencLib,
    handle: *mut c_void,
}

impl Session {
    fn open(lib: &'static NvencLib, device: &ID3D11Device) -> Result<Session, String> {
        let mut params: NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS = unsafe { zeroed() };
        params.version = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER;
        params.deviceType = NV_ENC_DEVICE_TYPE_DIRECTX;
        params.device = device.as_raw();
        params.apiVersion = NVENCAPI_VERSION;
        let mut handle = std::ptr::null_mut();
        check(unsafe { nv!(lib, nvEncOpenEncodeSessionEx)(&mut params, &mut handle) }, "NvEncOpenEncodeSessionEx")?;
        if handle.is_null() {
            return Err("NvEncOpenEncodeSessionEx: no session".into());
        }
        Ok(Session { lib, handle })
    }

    /// A capability value (`NV_ENC_CAPS_*`) of `codec`; 0 when the query fails.
    fn caps(&self, codec: GUID, cap: u32) -> i32 {
        let mut param: NV_ENC_CAPS_PARAM = unsafe { zeroed() };
        param.version = NV_ENC_CAPS_PARAM_VER;
        param.capsToQuery = cap;
        let mut value = 0;
        let status = unsafe { nv!(self.lib, nvEncGetEncodeCaps)(self.handle, codec, &mut param, &mut value) };
        if status == NV_ENC_SUCCESS { value } else { 0 }
    }

    fn codecs(&self) -> Result<Vec<GUID>, String> {
        let mut count = 0;
        check(unsafe { nv!(self.lib, nvEncGetEncodeGUIDCount)(self.handle, &mut count) }, "NvEncGetEncodeGUIDCount")?;
        let mut guids = vec![GUID::zeroed(); count as usize];
        let mut got = 0;
        check(
            unsafe { nv!(self.lib, nvEncGetEncodeGUIDs)(self.handle, guids.as_mut_ptr(), count, &mut got) },
            "NvEncGetEncodeGUIDs",
        )?;
        guids.truncate(got as usize);
        Ok(guids)
    }

    /// The driver's last error text for this session (adds detail to INVALID_PARAM and friends).
    fn last_error(&self) -> String {
        let Some(f) = self.lib.funcs.nvEncGetLastErrorString else { return String::new() };
        let p = unsafe { f(self.handle) };
        if p.is_null() {
            return String::new();
        }
        unsafe { std::ffi::CStr::from_ptr(p) }.to_string_lossy().into_owned()
    }

    fn check(&self, status: NVENCSTATUS, what: &str) -> Result<(), String> {
        check(status, what).map_err(|e| {
            let detail = self.last_error();
            if detail.is_empty() { e } else { format!("{e}: {detail}") }
        })
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        unsafe { nv!(self.lib, nvEncDestroyEncoder)(self.handle) };
    }
}

fn codec_guid(codec: Codec) -> GUID {
    match codec {
        Codec::H264 => NV_ENC_CODEC_H264_GUID,
        Codec::Hevc => NV_ENC_CODEC_HEVC_GUID,
    }
}

/// P3 up to 1440p60, P1 for anything larger or faster (keeps a 4K / 120 fps encode inside one frame time).
fn preset_for(width: u32, height: u32, fps: u32) -> GUID {
    if (width as u64) * (height as u64) > 2560 * 1440 || fps > 60 { NV_ENC_PRESET_P1_GUID } else { NV_ENC_PRESET_P3_GUID }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EncoderConfig {
    pub codec: Codec,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub bitrate_kbps: u32,
    /// VBV size in frames (2.0 wired LAN; 1.0 for Wi-Fi / Internet)
    pub vbv_frames: f32,
}

/// VBV buffer (bits) for a rate and fps: `vbv_frames` frames' worth of the CBR target.
pub fn vbv_bits(bitrate_kbps: u32, fps: u32, vbv_frames: f32) -> u32 {
    let per_frame = bitrate_kbps as f64 * 1000.0 / fps.max(1) as f64;
    (per_frame * vbv_frames.clamp(0.5, 8.0) as f64).round() as u32
}

/// One encoded access unit.
#[derive(Clone, Debug)]
pub struct EncodedOutput {
    /// Annex B, parameter sets before every IDR
    pub data: Vec<u8>,
    pub key: bool,
    pub frame_id: u32,
    pub after_invalidation: bool,
}

/// One registered NV12 input texture.
struct Slot {
    texture: ID3D11Texture2D,
    registered: *mut c_void,
}

/// An open encode session.
pub struct Encoder {
    // field order = drop order: the session goes last (unregistering needs it)
    device: ID3D11Device,
    cfg: EncoderConfig,
    // stable addresses: `init.encodeConfig` points into `config`, and reconfiguring passes both again
    init: Box<NV_ENC_INITIALIZE_PARAMS>,
    config: Box<NV_ENC_CONFIG>,
    slots: Vec<Slot>,
    bitstream: *mut c_void,
    rfi: bool,
    intra_refresh: bool,
    /// newest frame id encoded (None before the first)
    newest: Option<u32>,
    /// the next encoded frame follows a reference invalidation
    invalidated: bool,
    /// the next encoded frame starts an intra refresh wave (`intra_refresh`)
    refresh: bool,
    session: Session,
}

impl Encoder {
    pub fn open(gpu: &Gpu, cfg: &EncoderConfig) -> Result<Encoder, String> {
        Self::open_on(&gpu.device, cfg)
    }

    fn open_on(device: &ID3D11Device, cfg: &EncoderConfig) -> Result<Encoder, String> {
        if cfg.width < 2 || cfg.height < 2 || !cfg.width.is_multiple_of(2) || !cfg.height.is_multiple_of(2) {
            return Err(format!("bad encoder size {}x{}", cfg.width, cfg.height));
        }
        let lib = NvencLib::get()?;
        let session = Session::open(lib, device)?;
        let codec = codec_guid(cfg.codec);
        if !session.codecs()?.contains(&codec) {
            return Err(format!("NVENC cannot encode {}", cfg.codec.name()));
        }
        let (max_w, max_h) = (session.caps(codec, NV_ENC_CAPS_WIDTH_MAX), session.caps(codec, NV_ENC_CAPS_HEIGHT_MAX));
        if max_w > 0 && max_h > 0 && (cfg.width > max_w as u32 || cfg.height > max_h as u32) {
            return Err(format!("{}x{} is above NVENC's {} limit {max_w}x{max_h}", cfg.width, cfg.height, cfg.codec.name()));
        }
        let rfi = session.caps(codec, NV_ENC_CAPS_SUPPORT_REF_PIC_INVALIDATION) > 0;
        let intra_refresh = session.caps(codec, NV_ENC_CAPS_SUPPORT_INTRA_REFRESH) > 0;
        let preset = preset_for(cfg.width, cfg.height, cfg.fps);

        let mut preset_cfg: Box<NV_ENC_PRESET_CONFIG> = Box::new(unsafe { zeroed() });
        preset_cfg.version = NV_ENC_PRESET_CONFIG_VER;
        preset_cfg.presetCfg.version = NV_ENC_CONFIG_VER;
        session.check(
            unsafe {
                nv!(lib, nvEncGetEncodePresetConfigEx)(session.handle, codec, preset, NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY, &mut *preset_cfg)
            },
            "NvEncGetEncodePresetConfigEx",
        )?;
        let mut config = Box::new(preset_cfg.presetCfg);
        config.version = NV_ENC_CONFIG_VER;
        apply_config(&mut config, cfg, intra_refresh);

        let mut init: Box<NV_ENC_INITIALIZE_PARAMS> = Box::new(unsafe { zeroed() });
        init.version = NV_ENC_INITIALIZE_PARAMS_VER;
        init.encodeGUID = codec;
        init.presetGUID = preset;
        init.encodeWidth = cfg.width;
        init.encodeHeight = cfg.height;
        init.darWidth = cfg.width;
        init.darHeight = cfg.height;
        init.frameRateNum = cfg.fps.max(1);
        init.frameRateDen = 1;
        init.enableEncodeAsync = 0;
        init.enablePTD = 1;
        init.encodeConfig = &mut *config;
        init.maxEncodeWidth = cfg.width;
        init.maxEncodeHeight = cfg.height;
        init.tuningInfo = NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY;
        init.bufferFormat = NV_ENC_BUFFER_FORMAT_NV12;
        session.check(unsafe { nv!(lib, nvEncInitializeEncoder)(session.handle, &mut *init) }, "NvEncInitializeEncoder")?;

        let mut enc = Encoder {
            device: device.clone(),
            cfg: *cfg,
            init,
            config,
            slots: Vec::with_capacity(INPUT_SLOTS),
            bitstream: std::ptr::null_mut(),
            rfi,
            intra_refresh,
            newest: None,
            invalidated: false,
            refresh: false,
            session,
        };
        for _ in 0..INPUT_SLOTS {
            let texture = d3d::nv12_texture(device, cfg.width, cfg.height)?;
            let mut reg: NV_ENC_REGISTER_RESOURCE = unsafe { zeroed() };
            reg.version = NV_ENC_REGISTER_RESOURCE_VER;
            reg.resourceType = NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX;
            reg.width = cfg.width;
            reg.height = cfg.height;
            reg.resourceToRegister = texture.as_raw();
            reg.bufferFormat = NV_ENC_BUFFER_FORMAT_NV12;
            reg.bufferUsage = NV_ENC_INPUT_IMAGE;
            enc.session.check(unsafe { nv!(lib, nvEncRegisterResource)(enc.session.handle, &mut reg) }, "NvEncRegisterResource")?;
            enc.slots.push(Slot { texture, registered: reg.registeredResource });
        }
        let mut bs: NV_ENC_CREATE_BITSTREAM_BUFFER = unsafe { zeroed() };
        bs.version = NV_ENC_CREATE_BITSTREAM_BUFFER_VER;
        enc.session.check(unsafe { nv!(lib, nvEncCreateBitstreamBuffer)(enc.session.handle, &mut bs) }, "NvEncCreateBitstreamBuffer")?;
        enc.bitstream = bs.bitstreamBuffer;
        Ok(enc)
    }

    pub fn config(&self) -> EncoderConfig {
        self.cfg
    }

    /// The GPU can invalidate reference frames (NV_ENC_CAPS_SUPPORT_REF_PIC_INVALIDATION).
    pub fn supports_invalidation(&self) -> bool {
        self.rfi
    }

    /// NV12 input texture of `slot` (0..INPUT_SLOTS), the converter's render target.
    pub fn input(&self, slot: usize) -> &ID3D11Texture2D {
        &self.slots[slot].texture
    }

    /// Encodes the texture in `slot` as frame `frame_id` (`idr` = force an IDR). Synchronous.
    pub fn encode(&mut self, slot: usize, frame_id: u32, idr: bool) -> Result<EncodedOutput, String> {
        let lib = self.session.lib;
        let handle = self.session.handle;
        let registered = self.slots.get(slot).ok_or_else(|| format!("no input slot {slot}"))?.registered;
        let mut map: NV_ENC_MAP_INPUT_RESOURCE = unsafe { zeroed() };
        map.version = NV_ENC_MAP_INPUT_RESOURCE_VER;
        map.registeredResource = registered;
        self.session.check(unsafe { nv!(lib, nvEncMapInputResource)(handle, &mut map) }, "NvEncMapInputResource")?;

        let result = self.encode_mapped(map.mappedResource, map.mappedBufferFmt, frame_id, idr);
        unsafe { nv!(lib, nvEncUnmapInputResource)(handle, map.mappedResource) };
        result
    }

    fn encode_mapped(&mut self, input: *mut c_void, format: u32, frame_id: u32, idr: bool) -> Result<EncodedOutput, String> {
        let lib = self.session.lib;
        let handle = self.session.handle;
        let mut pic: Box<NV_ENC_PIC_PARAMS> = Box::new(unsafe { zeroed() });
        pic.version = NV_ENC_PIC_PARAMS_VER;
        pic.inputWidth = self.cfg.width;
        pic.inputHeight = self.cfg.height;
        pic.inputPitch = self.cfg.width;
        pic.encodePicFlags = if idr { NV_ENC_PIC_FLAG_FORCEIDR | NV_ENC_PIC_FLAG_OUTPUT_SPSPPS } else { 0 };
        pic.frameIdx = frame_id;
        pic.inputTimeStamp = frame_id as u64;
        pic.inputBuffer = input;
        pic.outputBitstream = self.bitstream;
        pic.bufferFmt = format;
        pic.pictureStruct = NV_ENC_PIC_STRUCT_FRAME;
        if std::mem::take(&mut self.refresh) && !idr {
            // NVENC spreads intra blocks over that many frames from here
            match self.cfg.codec {
                Codec::H264 => pic.codecPicParams.h264PicParams.forceIntraRefreshWithFrameCnt = INTRA_REFRESH_FRAMES,
                Codec::Hevc => pic.codecPicParams.hevcPicParams.forceIntraRefreshWithFrameCnt = INTRA_REFRESH_FRAMES,
            }
        }
        self.session.check(unsafe { nv!(lib, nvEncEncodePicture)(handle, &mut *pic) }, "NvEncEncodePicture")?;

        let mut lock: NV_ENC_LOCK_BITSTREAM = unsafe { zeroed() };
        lock.version = NV_ENC_LOCK_BITSTREAM_VER;
        lock.outputBitstream = self.bitstream;
        self.session.check(unsafe { nv!(lib, nvEncLockBitstream)(handle, &mut lock) }, "NvEncLockBitstream")?;
        let data = if lock.bitstreamBufferPtr.is_null() {
            Vec::new()
        } else {
            unsafe { std::slice::from_raw_parts(lock.bitstreamBufferPtr as *const u8, lock.bitstreamSizeInBytes as usize) }.to_vec()
        };
        let picture_type = lock.pictureType;
        unsafe { nv!(lib, nvEncUnlockBitstream)(handle, self.bitstream) };
        if data.is_empty() {
            return Err("NVENC returned an empty frame".into());
        }
        let key = picture_type == NV_ENC_PIC_TYPE_IDR;
        let after_invalidation = std::mem::take(&mut self.invalidated) && !key;
        self.newest = Some(frame_id);
        Ok(EncodedOutput { data, key, frame_id, after_invalidation })
    }

    /// New CBR target without an IDR (`NvEncReconfigureEncoder`, `resetEncoder = 0`, `forceIDR = 0`).
    pub fn set_bitrate(&mut self, kbps: u32) -> Result<(), String> {
        if kbps == self.cfg.bitrate_kbps {
            return Ok(());
        }
        let mut cfg = self.cfg;
        cfg.bitrate_kbps = kbps.max(100);
        set_rate(&mut self.config.rcParams, &cfg);
        if let Err(e) = self.reconfigure() {
            set_rate(&mut self.config.rcParams, &self.cfg);
            return Err(e);
        }
        self.cfg = cfg;
        Ok(())
    }

    /// Applies `config` to the running session: no reset, no IDR (resetEncoder = forceIDR = 0).
    fn reconfigure(&mut self) -> Result<(), String> {
        let lib = self.session.lib;
        let mut params: Box<NV_ENC_RECONFIGURE_PARAMS> = Box::new(unsafe { zeroed() });
        params.version = NV_ENC_RECONFIGURE_PARAMS_VER;
        params.reInitEncodeParams = *self.init;
        params.reInitEncodeParams.encodeConfig = &mut *self.config;
        set_bit(&mut params.bits, RECONFIGURE_RESET_ENCODER_BIT, false);
        set_bit(&mut params.bits, RECONFIGURE_FORCE_IDR_BIT, false);
        self.session.check(unsafe { nv!(lib, nvEncReconfigureEncoder)(self.session.handle, &mut *params) }, "NvEncReconfigureEncoder")
    }

    /// Invalidates frames `first..=last`; Ok(false) when the range is too long (≥ DPB) or the frames are unknown
    /// — the caller then forces an IDR.
    pub fn invalidate(&mut self, first: u32, last: u32) -> Result<bool, String> {
        let Some(newest) = self.newest else { return Ok(false) };
        let span = last.wrapping_sub(first);
        // the frame before `first` must still be a reference: nothing older than the DPB, nothing not yet encoded
        let age = newest.wrapping_sub(first);
        if !self.rfi || span >= DPB_SIZE || age >= DPB_SIZE - 1 || newest.wrapping_sub(last) > age {
            return Ok(false);
        }
        let lib = self.session.lib;
        for i in 0..=span {
            let id = first.wrapping_add(i);
            self.session.check(
                unsafe { nv!(lib, nvEncInvalidateRefFrames)(self.session.handle, id as u64) },
                "NvEncInvalidateRefFrames",
            )?;
        }
        self.invalidated = true;
        Ok(true)
    }

    /// Starts one intra refresh wave over [`INTRA_REFRESH_FRAMES`] frames instead of an IDR (lower peak size).
    /// Ok(false) when the GPU cannot (the caller sends an IDR).
    pub fn intra_refresh(&mut self) -> Result<bool, String> {
        if !self.intra_refresh {
            return Ok(false);
        }
        self.refresh = true;
        Ok(true)
    }

    /// New output size (new source size or user setting): a fresh session at that size (see [`Encoder::reopen`]);
    /// the next frame is an IDR. Sizes change only on user actions (or a resized window), never for rate reasons.
    pub fn resize(&mut self, width: u32, height: u32) -> Result<(), String> {
        let mut cfg = self.cfg;
        cfg.width = width;
        cfg.height = height;
        self.reopen(&cfg)
    }

    /// New fps / rate / size in one step: a fresh session (the input textures change with it), next frame IDR.
    /// On error the old session stays as it was.
    pub fn reopen(&mut self, cfg: &EncoderConfig) -> Result<(), String> {
        let device = self.device.clone();
        *self = Encoder::open_on(&device, cfg)?;
        Ok(())
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        let lib = self.session.lib;
        let handle = self.session.handle;
        unsafe {
            if !self.bitstream.is_null() {
                nv!(lib, nvEncDestroyBitstreamBuffer)(handle, self.bitstream);
            }
            for slot in &self.slots {
                nv!(lib, nvEncUnregisterResource)(handle, slot.registered);
            }
        }
    }
}

/// CBR at the target, VBV of `vbv_frames` frames.
fn set_rate(rc: &mut NV_ENC_RC_PARAMS, cfg: &EncoderConfig) {
    let bps = cfg.bitrate_kbps.saturating_mul(1000);
    rc.rateControlMode = NV_ENC_PARAMS_RC_CBR;
    rc.averageBitRate = bps;
    rc.maxBitRate = bps;
    let vbv = vbv_bits(cfg.bitrate_kbps, cfg.fps, cfg.vbv_frames);
    rc.vbvBufferSize = vbv;
    rc.vbvInitialDelay = vbv;
}

/// Our settings on top of the preset (docs/NATIVE-PATH.md §3.3).
fn apply_config(c: &mut NV_ENC_CONFIG, cfg: &EncoderConfig, intra_refresh: bool) {
    c.gopLength = NVENC_INFINITE_GOPLENGTH;
    c.frameIntervalP = 1;
    let rc = &mut c.rcParams;
    set_rate(rc, cfg);
    rc.multiPass = NV_ENC_TWO_PASS_QUARTER_RESOLUTION;
    rc.lookaheadDepth = 0;
    for bit in [RC_ENABLE_LOOKAHEAD_BIT, RC_ENABLE_AQ_BIT, RC_ENABLE_TEMPORAL_AQ_BIT, RC_ENABLE_MIN_QP_BIT, RC_ENABLE_MAX_QP_BIT] {
        set_bit(&mut rc.bits, bit, false);
    }
    set_bit(&mut rc.bits, RC_ZERO_REORDER_DELAY_BIT, true);
    rc.bits &= !(0xf << RC_AQ_STRENGTH_SHIFT);
    let vui = NV_ENC_CONFIG_VUI_PARAMETERS {
        videoSignalTypePresentFlag: 1,
        videoFormat: NV_ENC_VUI_VIDEO_FORMAT_UNSPECIFIED,
        videoFullRangeFlag: 0,
        colourDescriptionPresentFlag: 1,
        colourPrimaries: NV_ENC_VUI_COLOR_PRIMARIES_BT709,
        transferCharacteristics: NV_ENC_VUI_TRANSFER_CHARACTERISTIC_BT709,
        colourMatrix: NV_ENC_VUI_MATRIX_COEFFS_BT709,
        // writes max_num_reorder_frames = 0: without it a decoder must assume reordering up to the level's DPB size
        // and holds every frame that long (Chromium's H.264 decoders: 12 frames ≈ 200 ms at 1440p60, level 5.1)
        bitstreamRestrictionFlag: 1,
        ..unsafe { zeroed() }
    };
    match cfg.codec {
        Codec::H264 => {
            c.profileGUID = NV_ENC_H264_PROFILE_HIGH_GUID;
            let h = unsafe { &mut c.encodeCodecConfig.h264Config };
            h.idrPeriod = NVENC_INFINITE_GOPLENGTH;
            h.maxNumRefFrames = DPB_SIZE;
            h.numRefL0 = NV_ENC_NUM_REF_FRAMES_1;
            h.useBFramesAsRef = NV_ENC_BFRAME_REF_MODE_DISABLED;
            h.chromaFormatIDC = 1;
            h.sliceMode = 0;
            h.sliceModeData = 0;
            set_bit(&mut h.bits, H264_REPEAT_SPSPPS_BIT, true);
            set_bit(&mut h.bits, H264_OUTPUT_AUD_BIT, false);
            set_bit(&mut h.bits, H264_DISABLE_SPSPPS_BIT, false);
            set_bit(&mut h.bits, H264_ENABLE_FILLER_DATA_BIT, false);
            set_bit(&mut h.bits, H264_ENABLE_LTR_BIT, false);
            set_bit(&mut h.bits, H264_ENABLE_INTRA_REFRESH_BIT, intra_refresh);
            if intra_refresh {
                // on request only (forceIntraRefreshWithFrameCnt); the period is the whole stream
                h.intraRefreshPeriod = NVENC_INFINITE_GOPLENGTH;
                h.intraRefreshCnt = INTRA_REFRESH_FRAMES;
            }
            h.h264VUIParameters = vui;
        }
        Codec::Hevc => {
            c.profileGUID = NV_ENC_HEVC_PROFILE_MAIN_GUID;
            let h = unsafe { &mut c.encodeCodecConfig.hevcConfig };
            h.idrPeriod = NVENC_INFINITE_GOPLENGTH;
            h.maxNumRefFramesInDPB = DPB_SIZE;
            h.numRefL0 = NV_ENC_NUM_REF_FRAMES_1;
            h.useBFramesAsRef = NV_ENC_BFRAME_REF_MODE_DISABLED;
            h.sliceMode = 0;
            h.sliceModeData = 0;
            // Main: 4:2:0 (chromaFormatIDC 1), 8 bit (pixelBitDepthMinus8 0)
            h.bits = (h.bits & !(0x3 << HEVC_CHROMA_FORMAT_SHIFT)) | (1 << HEVC_CHROMA_FORMAT_SHIFT);
            h.bits &= !(0x7 << HEVC_PIXEL_BIT_DEPTH_SHIFT);
            set_bit(&mut h.bits, HEVC_REPEAT_SPSPPS_BIT, true);
            set_bit(&mut h.bits, HEVC_OUTPUT_AUD_BIT, false);
            set_bit(&mut h.bits, HEVC_DISABLE_SPSPPS_BIT, false);
            set_bit(&mut h.bits, HEVC_ENABLE_FILLER_DATA_BIT, false);
            set_bit(&mut h.bits, HEVC_ENABLE_LTR_BIT, false);
            set_bit(&mut h.bits, HEVC_ENABLE_INTRA_REFRESH_BIT, intra_refresh);
            if intra_refresh {
                h.intraRefreshPeriod = NVENC_INFINITE_GOPLENGTH;
                h.intraRefreshCnt = INTRA_REFRESH_FRAMES;
            }
            h.hevcVUIParameters = vui;
        }
    }
}

/// What NVENC can do on this machine (cached by `capture::probe`).
#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodecSupport {
    pub h264: bool,
    pub hevc: bool,
    pub max_width: u32,
    pub max_height: u32,
}

/// Opens a short session on `gpu` and asks for the codec GUIDs and max sizes (`NvEncGetEncodeGUIDs`,
/// `NV_ENC_CAPS_WIDTH_MAX` / `HEIGHT_MAX`).
pub fn query(gpu: &Gpu) -> Result<CodecSupport, String> {
    let lib = NvencLib::get()?;
    let session = Session::open(lib, &gpu.device)?;
    let guids = session.codecs()?;
    let mut s = CodecSupport { h264: guids.contains(&NV_ENC_CODEC_H264_GUID), hevc: guids.contains(&NV_ENC_CODEC_HEVC_GUID), ..Default::default() };
    // the size every offered codec can encode
    for (on, guid) in [(s.h264, NV_ENC_CODEC_H264_GUID), (s.hevc, NV_ENC_CODEC_HEVC_GUID)] {
        if !on {
            continue;
        }
        let (w, h) = (session.caps(guid, NV_ENC_CAPS_WIDTH_MAX).max(0) as u32, session.caps(guid, NV_ENC_CAPS_HEIGHT_MAX).max(0) as u32);
        s.max_width = if s.max_width == 0 { w } else { s.max_width.min(w) };
        s.max_height = if s.max_height == 0 { h } else { s.max_height.min(h) };
    }
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vbv_is_frames_of_the_target() {
        // 35.6 Mbit/s at 60 fps, 2 frames: 2 × 593 333 bits
        assert_eq!(vbv_bits(35_600, 60, 2.0), 1_186_667);
        assert_eq!(vbv_bits(20_000, 60, 1.0), 333_333);
        assert_eq!(vbv_bits(20_000, 0, 1.0), 20_000_000);
    }

    #[test]
    fn presets() {
        assert_eq!(preset_for(2560, 1440, 60), NV_ENC_PRESET_P3_GUID);
        assert_eq!(preset_for(1920, 1080, 60), NV_ENC_PRESET_P3_GUID);
        assert_eq!(preset_for(1920, 1080, 120), NV_ENC_PRESET_P1_GUID);
        assert_eq!(preset_for(3840, 2160, 60), NV_ENC_PRESET_P1_GUID);
    }

    #[test]
    fn config_bits() {
        let mut c: NV_ENC_CONFIG = unsafe { zeroed() };
        c.encodeCodecConfig.hevcConfig.bits = 0xffff_ffff;
        c.rcParams.bits = 0xffff_ffff;
        let cfg = EncoderConfig { codec: Codec::Hevc, width: 1920, height: 1080, fps: 60, bitrate_kbps: 20_000, vbv_frames: 2.0 };
        apply_config(&mut c, &cfg, false);
        let h = unsafe { c.encodeCodecConfig.hevcConfig };
        assert_eq!(h.bits >> HEVC_CHROMA_FORMAT_SHIFT & 3, 1);
        assert_eq!(h.bits >> HEVC_PIXEL_BIT_DEPTH_SHIFT & 7, 0);
        assert_eq!(h.bits >> HEVC_REPEAT_SPSPPS_BIT & 1, 1);
        assert_eq!(h.bits >> HEVC_OUTPUT_AUD_BIT & 1, 0);
        assert_eq!(h.bits >> HEVC_ENABLE_INTRA_REFRESH_BIT & 1, 0);
        assert_eq!(c.rcParams.bits >> RC_ZERO_REORDER_DELAY_BIT & 1, 1);
        assert_eq!(c.rcParams.bits >> RC_ENABLE_LOOKAHEAD_BIT & 1, 0);
        assert_eq!(c.rcParams.bits >> RC_ENABLE_AQ_BIT & 1, 0);
        assert_eq!(c.rcParams.bits >> RC_AQ_STRENGTH_SHIFT & 0xf, 0);
        assert_eq!(c.rcParams.averageBitRate, 20_000_000);
        assert_eq!(c.rcParams.vbvBufferSize, 666_667);
        assert_eq!(c.gopLength, NVENC_INFINITE_GOPLENGTH);
    }
}

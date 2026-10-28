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
//! * VUI: BT.709 primaries / transfer / matrix, limited range (`videoFullRangeFlag = 0`);
//! * input: [`INPUT_SLOTS`] NV12 textures registered once (`NvEncRegisterResource`), mapped per frame;
//!   synchronous mode (no async events): encode → lock bitstream → copy → unlock, all on the capture thread;
//! * `inputTimeStamp` = frame id, so `NvEncInvalidateRefFrames(frame id)` maps 1:1 to the network's frame ids.
#![allow(unused_variables, dead_code)] // skeleton: remove when the bodies are filled

use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;

use crate::win::d3d::Gpu;
use crate::Codec;

/// NV12 input textures the encoder owns (capture → convert → encode rotates through them).
pub const INPUT_SLOTS: usize = 3;
/// Reference frames kept (invalidating a range of this size or more falls back to an IDR).
pub const DPB_SIZE: u32 = 5;

/// The loaded driver library (process-wide, never unloaded).
pub struct NvencLib {
    // filled by WIN
}

impl NvencLib {
    /// Loads and validates the library once; later calls return the same result.
    pub fn get() -> Result<&'static NvencLib, String> {
        todo!("WIN")
    }

    /// (major, minor) of the newest API the driver supports.
    pub fn driver_api(&self) -> (u32, u32) {
        todo!("WIN")
    }
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

/// One encoded access unit.
#[derive(Clone, Debug)]
pub struct EncodedOutput {
    /// Annex B, parameter sets before every IDR
    pub data: Vec<u8>,
    pub key: bool,
    pub frame_id: u32,
    pub after_invalidation: bool,
}

/// An open encode session.
pub struct Encoder {
    // filled by WIN
}

impl Encoder {
    pub fn open(gpu: &Gpu, cfg: &EncoderConfig) -> Result<Encoder, String> {
        todo!("WIN")
    }

    pub fn config(&self) -> EncoderConfig {
        todo!("WIN")
    }

    /// NV12 input texture of `slot` (0..INPUT_SLOTS), the converter's render target.
    pub fn input(&self, slot: usize) -> &ID3D11Texture2D {
        todo!("WIN")
    }

    /// Encodes the texture in `slot` as frame `frame_id` (`idr` = force an IDR). Synchronous.
    pub fn encode(&mut self, slot: usize, frame_id: u32, idr: bool) -> Result<EncodedOutput, String> {
        todo!("WIN")
    }

    /// New CBR target without an IDR (`NvEncReconfigureEncoder`, `resetEncoder = 0`, `forceIDR = 0`).
    pub fn set_bitrate(&mut self, kbps: u32) -> Result<(), String> {
        todo!("WIN")
    }

    /// Invalidates frames `first..=last`; Ok(false) when the range is too long (≥ DPB) or the frames are unknown
    /// — the caller then forces an IDR.
    pub fn invalidate(&mut self, first: u32, last: u32) -> Result<bool, String> {
        todo!("WIN")
    }

    /// New output size (new source size or user setting): reconfigure within the session's max size or reopen;
    /// the next frame is an IDR.
    pub fn resize(&mut self, width: u32, height: u32) -> Result<(), String> {
        todo!("WIN")
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
    todo!("WIN")
}

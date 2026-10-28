//! Raw NVENC API: the subset of `nvEncodeAPI.h` this crate uses, transcribed by hand from NVIDIA Video Codec SDK
//! **12.0** — nv-codec-headers `n12.0.16.1`, `include/ffnvcodec/nvEncodeAPI.h`. No SDK binaries are shipped:
//! `nvEncodeAPI64.dll` comes with the NVIDIA driver and is loaded at runtime (nvenc.rs).
//!
//! SDK 12.0 needs driver ≥ 522.25 (Windows). Struct versions are `struct_version(n)` with the header's `n` per
//! struct (`| 1 << 31` where the header has it). Every struct is `#[repr(C)]` with its reserved arrays, so sizes
//! match the header exactly (`const _: () = assert!(size_of::<…>() == …)` below, x64). C bitfields are one `u32`
//! each here; the bit positions are the `*_BIT` constants (declaration order fills from bit 0, as MSVC lays them
//! out). Fields this crate never touches keep their header names so the header stays the documentation.
//!
//! The structs this file transcribes carry this notice:
//!
//! ```text
//! This copyright notice applies to this header file only:
//!
//! Copyright (c) 2010-2022 NVIDIA Corporation
//!
//! Permission is hereby granted, free of charge, to any person
//! obtaining a copy of this software and associated documentation
//! files (the "Software"), to deal in the Software without
//! restriction, including without limitation the rights to use,
//! copy, modify, merge, publish, distribute, sublicense, and/or sell
//! copies of the software, and to permit persons to whom the
//! software is furnished to do so, subject to the following
//! conditions:
//!
//! The above copyright notice and this permission notice shall be
//! included in all copies or substantial portions of the Software.
//!
//! THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
//! EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
//! OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
//! NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
//! HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
//! WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
//! FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
//! OTHER DEALINGS IN THE SOFTWARE.
//! ```
#![allow(non_camel_case_types, non_snake_case, dead_code)]

use std::ffi::c_void;

pub use windows::core::GUID;

pub type NVENCSTATUS = i32;
pub const NV_ENC_SUCCESS: NVENCSTATUS = 0;
pub const NV_ENC_ERR_NO_ENCODE_DEVICE: NVENCSTATUS = 1;
pub const NV_ENC_ERR_UNSUPPORTED_DEVICE: NVENCSTATUS = 2;
pub const NV_ENC_ERR_INVALID_PARAM: NVENCSTATUS = 8;
pub const NV_ENC_ERR_OUT_OF_MEMORY: NVENCSTATUS = 10;
pub const NV_ENC_ERR_UNSUPPORTED_PARAM: NVENCSTATUS = 12;
pub const NV_ENC_ERR_INVALID_VERSION: NVENCSTATUS = 15;
pub const NV_ENC_ERR_NEED_MORE_INPUT: NVENCSTATUS = 17;
pub const NV_ENC_ERR_ENCODER_BUSY: NVENCSTATUS = 18;
pub const NV_ENC_ERR_INCOMPATIBLE_CLIENT_KEY: NVENCSTATUS = 21;

/// Header name of a status code (error messages).
pub fn status_name(s: NVENCSTATUS) -> &'static str {
    const NAMES: [&str; 26] = [
        "NV_ENC_SUCCESS",
        "NV_ENC_ERR_NO_ENCODE_DEVICE",
        "NV_ENC_ERR_UNSUPPORTED_DEVICE",
        "NV_ENC_ERR_INVALID_ENCODERDEVICE",
        "NV_ENC_ERR_INVALID_DEVICE",
        "NV_ENC_ERR_DEVICE_NOT_EXIST",
        "NV_ENC_ERR_INVALID_PTR",
        "NV_ENC_ERR_INVALID_EVENT",
        "NV_ENC_ERR_INVALID_PARAM",
        "NV_ENC_ERR_INVALID_CALL",
        "NV_ENC_ERR_OUT_OF_MEMORY",
        "NV_ENC_ERR_ENCODER_NOT_INITIALIZED",
        "NV_ENC_ERR_UNSUPPORTED_PARAM",
        "NV_ENC_ERR_LOCK_BUSY",
        "NV_ENC_ERR_NOT_ENOUGH_BUFFER",
        "NV_ENC_ERR_INVALID_VERSION",
        "NV_ENC_ERR_MAP_FAILED",
        "NV_ENC_ERR_NEED_MORE_INPUT",
        "NV_ENC_ERR_ENCODER_BUSY",
        "NV_ENC_ERR_EVENT_NOT_REGISTERD",
        "NV_ENC_ERR_GENERIC",
        "NV_ENC_ERR_INCOMPATIBLE_CLIENT_KEY",
        "NV_ENC_ERR_UNIMPLEMENTED",
        "NV_ENC_ERR_RESOURCE_REGISTER_FAILED",
        "NV_ENC_ERR_RESOURCE_NOT_REGISTERED",
        "NV_ENC_ERR_RESOURCE_NOT_MAPPED",
    ];
    NAMES.get(s as usize).copied().unwrap_or("NV_ENC_ERR_UNKNOWN")
}

pub const NVENCAPI_MAJOR_VERSION: u32 = 12;
pub const NVENCAPI_MINOR_VERSION: u32 = 0;
pub const NVENCAPI_VERSION: u32 = NVENCAPI_MAJOR_VERSION | (NVENCAPI_MINOR_VERSION << 24);

/// `NVENCAPI_STRUCT_VERSION(ver)` of the header.
pub const fn struct_version(ver: u32) -> u32 {
    NVENCAPI_VERSION | (ver << 16) | (0x7 << 28)
}

pub const NV_ENC_CAPS_PARAM_VER: u32 = struct_version(1);
pub const NV_ENC_CREATE_BITSTREAM_BUFFER_VER: u32 = struct_version(1);
pub const NV_ENC_RC_PARAMS_VER: u32 = struct_version(1);
pub const NV_ENC_CONFIG_VER: u32 = struct_version(8) | (1 << 31);
pub const NV_ENC_INITIALIZE_PARAMS_VER: u32 = struct_version(5) | (1 << 31);
pub const NV_ENC_RECONFIGURE_PARAMS_VER: u32 = struct_version(1) | (1 << 31);
pub const NV_ENC_PRESET_CONFIG_VER: u32 = struct_version(4) | (1 << 31);
pub const NV_ENC_PIC_PARAMS_VER: u32 = struct_version(6) | (1 << 31);
pub const NV_ENC_LOCK_BITSTREAM_VER: u32 = struct_version(2);
pub const NV_ENC_MAP_INPUT_RESOURCE_VER: u32 = struct_version(4);
pub const NV_ENC_REGISTER_RESOURCE_VER: u32 = struct_version(4);
pub const NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER: u32 = struct_version(1);
pub const NV_ENCODE_API_FUNCTION_LIST_VER: u32 = struct_version(2);

pub const NVENC_INFINITE_GOPLENGTH: u32 = 0xffff_ffff;

// GUIDs
pub const NV_ENC_CODEC_H264_GUID: GUID = GUID::from_u128(0x6bc82762_4e63_4ca4_aa85_1e50f321f6bf);
pub const NV_ENC_CODEC_HEVC_GUID: GUID = GUID::from_u128(0x790cdc88_4522_4d7b_9425_bda9975f7603);
pub const NV_ENC_H264_PROFILE_HIGH_GUID: GUID = GUID::from_u128(0xe7cbc309_4f7a_4b89_af2a_d537c92be310);
pub const NV_ENC_HEVC_PROFILE_MAIN_GUID: GUID = GUID::from_u128(0xb514c39a_b55b_40fa_878f_f1253b4dfdec);
pub const NV_ENC_PRESET_P1_GUID: GUID = GUID::from_u128(0xfc0a8d3e_45f8_4cf8_80c7_298871590ebf);
pub const NV_ENC_PRESET_P2_GUID: GUID = GUID::from_u128(0xf581cfb8_88d6_4381_93f0_df13f9c27dab);
pub const NV_ENC_PRESET_P3_GUID: GUID = GUID::from_u128(0x36850110_3a07_441f_94d5_3670631f91f6);
pub const NV_ENC_PRESET_P4_GUID: GUID = GUID::from_u128(0x90a7b826_df06_4862_b9d2_cd6d73a08681);

// enums (C enums are 32-bit)
pub const NV_ENC_PARAMS_RC_CBR: u32 = 0x2;
pub const NV_ENC_MULTI_PASS_DISABLED: u32 = 0x0;
pub const NV_ENC_TWO_PASS_QUARTER_RESOLUTION: u32 = 0x1;
pub const NV_ENC_PIC_STRUCT_FRAME: u32 = 0x1;
pub const NV_ENC_PIC_TYPE_P: u32 = 0x0;
pub const NV_ENC_PIC_TYPE_B: u32 = 0x1;
pub const NV_ENC_PIC_TYPE_I: u32 = 0x2;
pub const NV_ENC_PIC_TYPE_IDR: u32 = 0x3;
pub const NV_ENC_PIC_TYPE_INTRA_REFRESH: u32 = 0x6;
pub const NV_ENC_BUFFER_FORMAT_NV12: u32 = 0x1;
pub const NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY: u32 = 3;
pub const NV_ENC_PIC_FLAG_FORCEINTRA: u32 = 0x1;
pub const NV_ENC_PIC_FLAG_FORCEIDR: u32 = 0x2;
pub const NV_ENC_PIC_FLAG_OUTPUT_SPSPPS: u32 = 0x4;
pub const NV_ENC_DEVICE_TYPE_DIRECTX: u32 = 0x0;
pub const NV_ENC_INPUT_RESOURCE_TYPE_DIRECTX: u32 = 0x0;
pub const NV_ENC_INPUT_IMAGE: u32 = 0x0;
pub const NV_ENC_MEMORY_HEAP_AUTOSELECT: u32 = 0;
pub const NV_ENC_NUM_REF_FRAMES_1: u32 = 1;
pub const NV_ENC_BFRAME_REF_MODE_DISABLED: u32 = 0;
pub const NV_ENC_VUI_VIDEO_FORMAT_UNSPECIFIED: u32 = 5;
pub const NV_ENC_VUI_COLOR_PRIMARIES_BT709: u32 = 1;
pub const NV_ENC_VUI_TRANSFER_CHARACTERISTIC_BT709: u32 = 1;
pub const NV_ENC_VUI_MATRIX_COEFFS_BT709: u32 = 1;

// NV_ENC_CAPS (positions in the enum)
pub const NV_ENC_CAPS_NUM_MAX_BFRAMES: u32 = 0;
pub const NV_ENC_CAPS_WIDTH_MAX: u32 = 16;
pub const NV_ENC_CAPS_HEIGHT_MAX: u32 = 17;
pub const NV_ENC_CAPS_SUPPORT_DYN_BITRATE_CHANGE: u32 = 20;
pub const NV_ENC_CAPS_SUPPORT_INTRA_REFRESH: u32 = 25;
pub const NV_ENC_CAPS_SUPPORT_CUSTOM_VBV_BUF_SIZE: u32 = 26;
pub const NV_ENC_CAPS_SUPPORT_REF_PIC_INVALIDATION: u32 = 28;

/// `NV_ENC_CAPS_PARAM`
#[repr(C)]
pub struct NV_ENC_CAPS_PARAM {
    pub version: u32,
    pub capsToQuery: u32,
    pub reserved: [u32; 62],
}

/// `NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS`
#[repr(C)]
pub struct NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS {
    pub version: u32,
    pub deviceType: u32,
    pub device: *mut c_void,
    pub reserved: *mut c_void,
    pub apiVersion: u32,
    pub reserved1: [u32; 253],
    pub reserved2: [*mut c_void; 64],
}

/// `NV_ENC_QP`
#[repr(C)]
#[derive(Clone, Copy)]
pub struct NV_ENC_QP {
    pub qpInterP: u32,
    pub qpInterB: u32,
    pub qpIntra: u32,
}

/// `NV_ENC_RC_PARAMS`
#[repr(C)]
#[derive(Clone, Copy)]
pub struct NV_ENC_RC_PARAMS {
    pub version: u32,
    pub rateControlMode: u32,
    pub constQP: NV_ENC_QP,
    pub averageBitRate: u32,
    pub maxBitRate: u32,
    pub vbvBufferSize: u32,
    pub vbvInitialDelay: u32,
    /// bitfields, see `RC_*_BIT`
    pub bits: u32,
    pub minQP: NV_ENC_QP,
    pub maxQP: NV_ENC_QP,
    pub initialRCQP: NV_ENC_QP,
    pub temporallayerIdxMask: u32,
    pub temporalLayerQP: [u8; 8],
    pub targetQuality: u8,
    pub targetQualityLSB: u8,
    pub lookaheadDepth: u16,
    pub lowDelayKeyFrameScale: u8,
    pub yDcQPIndexOffset: i8,
    pub uDcQPIndexOffset: i8,
    pub vDcQPIndexOffset: i8,
    pub qpMapMode: u32,
    pub multiPass: u32,
    pub alphaLayerBitrateRatio: u32,
    pub cbQPIndexOffset: i8,
    pub crQPIndexOffset: i8,
    pub reserved2: u16,
    pub reserved: [u32; 4],
}
pub const RC_ENABLE_MIN_QP_BIT: u32 = 0;
pub const RC_ENABLE_MAX_QP_BIT: u32 = 1;
pub const RC_ENABLE_INITIAL_RCQP_BIT: u32 = 2;
pub const RC_ENABLE_AQ_BIT: u32 = 3;
pub const RC_ENABLE_LOOKAHEAD_BIT: u32 = 5;
pub const RC_DISABLE_IADAPT_BIT: u32 = 6;
pub const RC_DISABLE_BADAPT_BIT: u32 = 7;
pub const RC_ENABLE_TEMPORAL_AQ_BIT: u32 = 8;
pub const RC_ZERO_REORDER_DELAY_BIT: u32 = 9;
pub const RC_ENABLE_NON_REF_P_BIT: u32 = 10;
pub const RC_STRICT_GOP_TARGET_BIT: u32 = 11;
/// `aqStrength : 4` at bits 12..16
pub const RC_AQ_STRENGTH_SHIFT: u32 = 12;

/// `NV_ENC_CONFIG_H264_VUI_PARAMETERS` (= `NV_ENC_CONFIG_HEVC_VUI_PARAMETERS`, a typedef of it)
#[repr(C)]
#[derive(Clone, Copy)]
pub struct NV_ENC_CONFIG_VUI_PARAMETERS {
    pub overscanInfoPresentFlag: u32,
    pub overscanInfo: u32,
    pub videoSignalTypePresentFlag: u32,
    pub videoFormat: u32,
    pub videoFullRangeFlag: u32,
    pub colourDescriptionPresentFlag: u32,
    pub colourPrimaries: u32,
    pub transferCharacteristics: u32,
    pub colourMatrix: u32,
    pub chromaSampleLocationFlag: u32,
    pub chromaSampleLocationTop: u32,
    pub chromaSampleLocationBot: u32,
    pub bitstreamRestrictionFlag: u32,
    pub timingInfoPresentFlag: u32,
    pub numUnitInTicks: u32,
    pub timeScale: u32,
    pub reserved: [u32; 12],
}

/// `NV_ENC_CONFIG_H264`
#[repr(C)]
#[derive(Clone, Copy)]
pub struct NV_ENC_CONFIG_H264 {
    /// bitfields, see `H264_*_BIT`
    pub bits: u32,
    pub level: u32,
    pub idrPeriod: u32,
    pub separateColourPlaneFlag: u32,
    pub disableDeblockingFilterIDC: u32,
    pub numTemporalLayers: u32,
    pub spsId: u32,
    pub ppsId: u32,
    pub adaptiveTransformMode: u32,
    pub fmoMode: u32,
    pub bdirectMode: u32,
    pub entropyCodingMode: u32,
    pub stereoMode: u32,
    pub intraRefreshPeriod: u32,
    pub intraRefreshCnt: u32,
    pub maxNumRefFrames: u32,
    pub sliceMode: u32,
    pub sliceModeData: u32,
    pub h264VUIParameters: NV_ENC_CONFIG_VUI_PARAMETERS,
    pub ltrNumFrames: u32,
    pub ltrTrustMode: u32,
    pub chromaFormatIDC: u32,
    pub maxTemporalLayers: u32,
    pub useBFramesAsRef: u32,
    pub numRefL0: u32,
    pub numRefL1: u32,
    pub reserved1: [u32; 267],
    pub reserved2: [*mut c_void; 64],
}
pub const H264_OUTPUT_AUD_BIT: u32 = 6;
pub const H264_DISABLE_SPSPPS_BIT: u32 = 7;
pub const H264_OUTPUT_RECOVERY_POINT_SEI_BIT: u32 = 9;
pub const H264_ENABLE_INTRA_REFRESH_BIT: u32 = 10;
pub const H264_REPEAT_SPSPPS_BIT: u32 = 12;
pub const H264_ENABLE_LTR_BIT: u32 = 14;
pub const H264_ENABLE_FILLER_DATA_BIT: u32 = 17;
pub const H264_SINGLE_SLICE_INTRA_REFRESH_BIT: u32 = 20;

/// `NV_ENC_CONFIG_HEVC`
#[repr(C)]
#[derive(Clone, Copy)]
pub struct NV_ENC_CONFIG_HEVC {
    pub level: u32,
    pub tier: u32,
    pub minCUSize: u32,
    pub maxCUSize: u32,
    /// bitfields, see `HEVC_*_BIT`
    pub bits: u32,
    pub idrPeriod: u32,
    pub intraRefreshPeriod: u32,
    pub intraRefreshCnt: u32,
    pub maxNumRefFramesInDPB: u32,
    pub ltrNumFrames: u32,
    pub vpsId: u32,
    pub spsId: u32,
    pub ppsId: u32,
    pub sliceMode: u32,
    pub sliceModeData: u32,
    pub maxTemporalLayersMinus1: u32,
    pub hevcVUIParameters: NV_ENC_CONFIG_VUI_PARAMETERS,
    pub ltrTrustMode: u32,
    pub useBFramesAsRef: u32,
    pub numRefL0: u32,
    pub numRefL1: u32,
    pub reserved1: [u32; 214],
    pub reserved2: [*mut c_void; 64],
}
pub const HEVC_OUTPUT_AUD_BIT: u32 = 4;
pub const HEVC_ENABLE_LTR_BIT: u32 = 5;
pub const HEVC_DISABLE_SPSPPS_BIT: u32 = 6;
pub const HEVC_REPEAT_SPSPPS_BIT: u32 = 7;
pub const HEVC_ENABLE_INTRA_REFRESH_BIT: u32 = 8;
/// `chromaFormatIDC : 2` at bits 9..11, `pixelBitDepthMinus8 : 3` at bits 11..14
pub const HEVC_CHROMA_FORMAT_SHIFT: u32 = 9;
pub const HEVC_PIXEL_BIT_DEPTH_SHIFT: u32 = 11;
pub const HEVC_ENABLE_FILLER_DATA_BIT: u32 = 14;
pub const HEVC_SINGLE_SLICE_INTRA_REFRESH_BIT: u32 = 17;
pub const HEVC_OUTPUT_RECOVERY_POINT_SEI_BIT: u32 = 18;

/// `NV_ENC_CODEC_CONFIG`. The AV1 / ME-only members are not used here; `av1` stands in for the largest of them
/// (`NV_ENC_CONFIG_AV1`, 1552 bytes) so the union has the header's size even if that changes order.
#[repr(C)]
#[derive(Clone, Copy)]
pub union NV_ENC_CODEC_CONFIG {
    pub h264Config: NV_ENC_CONFIG_H264,
    pub hevcConfig: NV_ENC_CONFIG_HEVC,
    pub av1Config: [u64; 194],
    pub reserved: [u32; 320],
}

/// `NV_ENC_CONFIG`
#[repr(C)]
#[derive(Clone, Copy)]
pub struct NV_ENC_CONFIG {
    pub version: u32,
    pub profileGUID: GUID,
    pub gopLength: u32,
    pub frameIntervalP: i32,
    pub monoChromeEncoding: u32,
    pub frameFieldMode: u32,
    pub mvPrecision: u32,
    pub rcParams: NV_ENC_RC_PARAMS,
    pub encodeCodecConfig: NV_ENC_CODEC_CONFIG,
    pub reserved: [u32; 278],
    pub reserved2: [*mut c_void; 64],
}

/// `NV_ENC_PRESET_CONFIG`
#[repr(C)]
pub struct NV_ENC_PRESET_CONFIG {
    pub version: u32,
    pub presetCfg: NV_ENC_CONFIG,
    pub reserved1: [u32; 255],
    pub reserved2: [*mut c_void; 64],
}

/// `NVENC_EXTERNAL_ME_HINT_COUNTS_PER_BLOCKTYPE`
#[repr(C)]
#[derive(Clone, Copy)]
pub struct NVENC_EXTERNAL_ME_HINT_COUNTS_PER_BLOCKTYPE {
    pub bits: u32,
    pub reserved1: [u32; 3],
}

/// `NV_ENC_INITIALIZE_PARAMS`
#[repr(C)]
#[derive(Clone, Copy)]
pub struct NV_ENC_INITIALIZE_PARAMS {
    pub version: u32,
    pub encodeGUID: GUID,
    pub presetGUID: GUID,
    pub encodeWidth: u32,
    pub encodeHeight: u32,
    pub darWidth: u32,
    pub darHeight: u32,
    pub frameRateNum: u32,
    pub frameRateDen: u32,
    pub enableEncodeAsync: u32,
    pub enablePTD: u32,
    /// bitfields: reportSliceOffsets, enableSubFrameWrite, enableExternalMEHints, enableMEOnlyMode,
    /// enableWeightedPrediction, enableOutputInVidmem (bits 0..6)
    pub bits: u32,
    pub privDataSize: u32,
    pub privData: *mut c_void,
    pub encodeConfig: *mut NV_ENC_CONFIG,
    pub maxEncodeWidth: u32,
    pub maxEncodeHeight: u32,
    pub maxMEHintCountsPerBlock: [NVENC_EXTERNAL_ME_HINT_COUNTS_PER_BLOCKTYPE; 2],
    pub tuningInfo: u32,
    pub bufferFormat: u32,
    pub reserved: [u32; 287],
    pub reserved2: [*mut c_void; 64],
}

/// `NV_ENC_RECONFIGURE_PARAMS`
#[repr(C)]
pub struct NV_ENC_RECONFIGURE_PARAMS {
    pub version: u32,
    pub reInitEncodeParams: NV_ENC_INITIALIZE_PARAMS,
    /// bitfields: resetEncoder (bit 0), forceIDR (bit 1)
    pub bits: u32,
}
pub const RECONFIGURE_RESET_ENCODER_BIT: u32 = 0;
pub const RECONFIGURE_FORCE_IDR_BIT: u32 = 1;

/// `NV_ENC_CREATE_BITSTREAM_BUFFER`
#[repr(C)]
pub struct NV_ENC_CREATE_BITSTREAM_BUFFER {
    pub version: u32,
    pub size: u32,
    pub memoryHeap: u32,
    pub reserved: u32,
    pub bitstreamBuffer: *mut c_void,
    pub bitstreamBufferPtr: *mut c_void,
    pub reserved1: [u32; 58],
    pub reserved2: [*mut c_void; 64],
}

/// `NV_ENC_REGISTER_RESOURCE`
#[repr(C)]
pub struct NV_ENC_REGISTER_RESOURCE {
    pub version: u32,
    pub resourceType: u32,
    pub width: u32,
    pub height: u32,
    pub pitch: u32,
    pub subResourceIndex: u32,
    pub resourceToRegister: *mut c_void,
    pub registeredResource: *mut c_void,
    pub bufferFormat: u32,
    pub bufferUsage: u32,
    pub pInputFencePoint: *mut c_void,
    pub reserved1: [u32; 247],
    pub reserved2: [*mut c_void; 61],
}

/// `NV_ENC_MAP_INPUT_RESOURCE`
#[repr(C)]
pub struct NV_ENC_MAP_INPUT_RESOURCE {
    pub version: u32,
    pub subResourceIndex: u32,
    pub inputResource: *mut c_void,
    pub registeredResource: *mut c_void,
    pub mappedResource: *mut c_void,
    pub mappedBufferFmt: u32,
    pub reserved1: [u32; 251],
    pub reserved2: [*mut c_void; 63],
}

/// `NV_ENC_CLOCK_TIMESTAMP_SET`
#[repr(C)]
#[derive(Clone, Copy)]
pub struct NV_ENC_CLOCK_TIMESTAMP_SET {
    pub bits: u32,
    pub timeOffset: u32,
}

/// `NV_ENC_TIME_CODE`
#[repr(C)]
#[derive(Clone, Copy)]
pub struct NV_ENC_TIME_CODE {
    pub displayPicStruct: u32,
    pub clockTimestamp: [NV_ENC_CLOCK_TIMESTAMP_SET; 3],
}

/// `NV_ENC_PIC_PARAMS_MVC`
#[repr(C)]
#[derive(Clone, Copy)]
pub struct NV_ENC_PIC_PARAMS_MVC {
    pub version: u32,
    pub viewID: u32,
    pub temporalID: u32,
    pub priorityID: u32,
    pub reserved1: [u32; 12],
    pub reserved2: [*mut c_void; 8],
}

/// `NV_ENC_PIC_PARAMS_H264_EXT`
#[repr(C)]
#[derive(Clone, Copy)]
pub union NV_ENC_PIC_PARAMS_H264_EXT {
    pub mvcPicParams: NV_ENC_PIC_PARAMS_MVC,
    pub reserved1: [u32; 32],
}

/// `NV_ENC_PIC_PARAMS_H264`
#[repr(C)]
#[derive(Clone, Copy)]
pub struct NV_ENC_PIC_PARAMS_H264 {
    pub displayPOCSyntax: u32,
    pub reserved3: u32,
    pub refPicFlag: u32,
    pub colourPlaneId: u32,
    pub forceIntraRefreshWithFrameCnt: u32,
    /// bitfields: constrainedFrame, sliceModeDataUpdate, ltrMarkFrame, ltrUseFrames (bits 0..4)
    pub bits: u32,
    pub sliceTypeData: *mut u8,
    pub sliceTypeArrayCnt: u32,
    pub seiPayloadArrayCnt: u32,
    pub seiPayloadArray: *mut c_void,
    pub sliceMode: u32,
    pub sliceModeData: u32,
    pub ltrMarkFrameIdx: u32,
    pub ltrUseFrameBitmap: u32,
    pub ltrUsageMode: u32,
    pub forceIntraSliceCount: u32,
    pub forceIntraSliceIdx: *mut u32,
    pub h264ExtPicParams: NV_ENC_PIC_PARAMS_H264_EXT,
    pub timeCode: NV_ENC_TIME_CODE,
    pub reserved: [u32; 203],
    pub reserved2: [*mut c_void; 61],
}

/// `NV_ENC_PIC_PARAMS_HEVC`
#[repr(C)]
#[derive(Clone, Copy)]
pub struct NV_ENC_PIC_PARAMS_HEVC {
    pub displayPOCSyntax: u32,
    pub refPicFlag: u32,
    pub temporalId: u32,
    pub forceIntraRefreshWithFrameCnt: u32,
    /// bitfields: constrainedFrame, sliceModeDataUpdate, ltrMarkFrame, ltrUseFrames (bits 0..4)
    pub bits: u32,
    pub sliceTypeData: *mut u8,
    pub sliceTypeArrayCnt: u32,
    pub sliceMode: u32,
    pub sliceModeData: u32,
    pub ltrMarkFrameIdx: u32,
    pub ltrUseFrameBitmap: u32,
    pub ltrUsageMode: u32,
    pub seiPayloadArrayCnt: u32,
    pub reserved: u32,
    pub seiPayloadArray: *mut c_void,
    pub timeCode: NV_ENC_TIME_CODE,
    pub reserved2: [u32; 237],
    pub reserved3: [*mut c_void; 61],
}

/// `NV_ENC_CODEC_PIC_PARAMS`. `av1PicParams` (`NV_ENC_PIC_PARAMS_AV1`, 1552 bytes) is the largest member.
#[repr(C)]
#[derive(Clone, Copy)]
pub union NV_ENC_CODEC_PIC_PARAMS {
    pub h264PicParams: NV_ENC_PIC_PARAMS_H264,
    pub hevcPicParams: NV_ENC_PIC_PARAMS_HEVC,
    pub av1PicParams: [u64; 194],
    pub reserved: [u32; 256],
}

/// `NV_ENC_PIC_PARAMS`
#[repr(C)]
pub struct NV_ENC_PIC_PARAMS {
    pub version: u32,
    pub inputWidth: u32,
    pub inputHeight: u32,
    pub inputPitch: u32,
    pub encodePicFlags: u32,
    pub frameIdx: u32,
    pub inputTimeStamp: u64,
    pub inputDuration: u64,
    pub inputBuffer: *mut c_void,
    pub outputBitstream: *mut c_void,
    pub completionEvent: *mut c_void,
    pub bufferFmt: u32,
    pub pictureStruct: u32,
    pub pictureType: u32,
    pub codecPicParams: NV_ENC_CODEC_PIC_PARAMS,
    pub meHintCountsPerBlock: [NVENC_EXTERNAL_ME_HINT_COUNTS_PER_BLOCKTYPE; 2],
    pub meExternalHints: *mut c_void,
    pub reserved1: [u32; 6],
    pub reserved2: [*mut c_void; 2],
    pub qpDeltaMap: *mut i8,
    pub qpDeltaMapSize: u32,
    pub reservedBitFields: u32,
    pub meHintRefPicDist: [u16; 2],
    pub alphaBuffer: *mut c_void,
    pub meExternalSbHints: *mut c_void,
    pub meSbHintsCount: u32,
    pub reserved3: [u32; 285],
    pub reserved4: [*mut c_void; 58],
}

/// `NV_ENC_LOCK_BITSTREAM`
#[repr(C)]
pub struct NV_ENC_LOCK_BITSTREAM {
    pub version: u32,
    /// bitfields: doNotWait (bit 0), ltrFrame, getRCStats
    pub bits: u32,
    pub outputBitstream: *mut c_void,
    pub sliceOffsets: *mut u32,
    pub frameIdx: u32,
    pub hwEncodeStatus: u32,
    pub numSlices: u32,
    pub bitstreamSizeInBytes: u32,
    pub outputTimeStamp: u64,
    pub outputDuration: u64,
    pub bitstreamBufferPtr: *mut c_void,
    pub pictureType: u32,
    pub pictureStruct: u32,
    pub frameAvgQP: u32,
    pub frameSatd: u32,
    pub ltrFrameIdx: u32,
    pub ltrFrameBitmap: u32,
    pub temporalId: u32,
    pub reserved: [u32; 12],
    pub intraMBCount: u32,
    pub interMBCount: u32,
    pub averageMVX: i32,
    pub averageMVY: i32,
    pub alphaLayerSizeInBytes: u32,
    pub reserved1: [u32; 218],
    pub reserved2: [*mut c_void; 64],
}

pub type PNVENCOPENENCODESESSIONEX =
    unsafe extern "system" fn(params: *mut NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS, encoder: *mut *mut c_void) -> NVENCSTATUS;
pub type PNVENCGETENCODEGUIDCOUNT = unsafe extern "system" fn(encoder: *mut c_void, count: *mut u32) -> NVENCSTATUS;
pub type PNVENCGETENCODEGUIDS =
    unsafe extern "system" fn(encoder: *mut c_void, guids: *mut GUID, size: u32, count: *mut u32) -> NVENCSTATUS;
pub type PNVENCGETENCODECAPS =
    unsafe extern "system" fn(encoder: *mut c_void, codec: GUID, param: *mut NV_ENC_CAPS_PARAM, value: *mut i32) -> NVENCSTATUS;
pub type PNVENCGETENCODEPRESETCONFIGEX = unsafe extern "system" fn(
    encoder: *mut c_void,
    codec: GUID,
    preset: GUID,
    tuning: u32,
    config: *mut NV_ENC_PRESET_CONFIG,
) -> NVENCSTATUS;
pub type PNVENCINITIALIZEENCODER = unsafe extern "system" fn(encoder: *mut c_void, params: *mut NV_ENC_INITIALIZE_PARAMS) -> NVENCSTATUS;
pub type PNVENCCREATEBITSTREAMBUFFER =
    unsafe extern "system" fn(encoder: *mut c_void, params: *mut NV_ENC_CREATE_BITSTREAM_BUFFER) -> NVENCSTATUS;
pub type PNVENCDESTROYBITSTREAMBUFFER = unsafe extern "system" fn(encoder: *mut c_void, buffer: *mut c_void) -> NVENCSTATUS;
pub type PNVENCENCODEPICTURE = unsafe extern "system" fn(encoder: *mut c_void, params: *mut NV_ENC_PIC_PARAMS) -> NVENCSTATUS;
pub type PNVENCLOCKBITSTREAM = unsafe extern "system" fn(encoder: *mut c_void, params: *mut NV_ENC_LOCK_BITSTREAM) -> NVENCSTATUS;
pub type PNVENCUNLOCKBITSTREAM = unsafe extern "system" fn(encoder: *mut c_void, buffer: *mut c_void) -> NVENCSTATUS;
pub type PNVENCREGISTERRESOURCE = unsafe extern "system" fn(encoder: *mut c_void, params: *mut NV_ENC_REGISTER_RESOURCE) -> NVENCSTATUS;
pub type PNVENCUNREGISTERRESOURCE = unsafe extern "system" fn(encoder: *mut c_void, resource: *mut c_void) -> NVENCSTATUS;
pub type PNVENCMAPINPUTRESOURCE = unsafe extern "system" fn(encoder: *mut c_void, params: *mut NV_ENC_MAP_INPUT_RESOURCE) -> NVENCSTATUS;
pub type PNVENCUNMAPINPUTRESOURCE = unsafe extern "system" fn(encoder: *mut c_void, mapped: *mut c_void) -> NVENCSTATUS;
pub type PNVENCDESTROYENCODER = unsafe extern "system" fn(encoder: *mut c_void) -> NVENCSTATUS;
pub type PNVENCINVALIDATEREFFRAMES = unsafe extern "system" fn(encoder: *mut c_void, timestamp: u64) -> NVENCSTATUS;
pub type PNVENCRECONFIGUREENCODER = unsafe extern "system" fn(encoder: *mut c_void, params: *mut NV_ENC_RECONFIGURE_PARAMS) -> NVENCSTATUS;
pub type PNVENCGETLASTERROR = unsafe extern "system" fn(encoder: *mut c_void) -> *const std::ffi::c_char;
/// An entry point this crate never calls (kept for the header order).
pub type PUNUSED = *mut c_void;

/// `NvEncodeAPIGetMaxSupportedVersion`: (major << 4) | minor of the newest API the installed driver supports.
pub type NvEncodeAPIGetMaxSupportedVersion = unsafe extern "system" fn(version: *mut u32) -> NVENCSTATUS;
/// `NvEncodeAPICreateInstance`: fills the function list (its `version` set to `NV_ENCODE_API_FUNCTION_LIST_VER`).
pub type NvEncodeAPICreateInstance = unsafe extern "system" fn(function_list: *mut NV_ENCODE_API_FUNCTION_LIST) -> NVENCSTATUS;

/// `NV_ENCODE_API_FUNCTION_LIST`: every entry point in header order, then `reserved2`.
#[repr(C)]
pub struct NV_ENCODE_API_FUNCTION_LIST {
    pub version: u32,
    pub reserved: u32,
    pub nvEncOpenEncodeSession: PUNUSED,
    pub nvEncGetEncodeGUIDCount: Option<PNVENCGETENCODEGUIDCOUNT>,
    pub nvEncGetEncodeProfileGUIDCount: PUNUSED,
    pub nvEncGetEncodeProfileGUIDs: PUNUSED,
    pub nvEncGetEncodeGUIDs: Option<PNVENCGETENCODEGUIDS>,
    pub nvEncGetInputFormatCount: PUNUSED,
    pub nvEncGetInputFormats: PUNUSED,
    pub nvEncGetEncodeCaps: Option<PNVENCGETENCODECAPS>,
    pub nvEncGetEncodePresetCount: PUNUSED,
    pub nvEncGetEncodePresetGUIDs: PUNUSED,
    pub nvEncGetEncodePresetConfig: PUNUSED,
    pub nvEncInitializeEncoder: Option<PNVENCINITIALIZEENCODER>,
    pub nvEncCreateInputBuffer: PUNUSED,
    pub nvEncDestroyInputBuffer: PUNUSED,
    pub nvEncCreateBitstreamBuffer: Option<PNVENCCREATEBITSTREAMBUFFER>,
    pub nvEncDestroyBitstreamBuffer: Option<PNVENCDESTROYBITSTREAMBUFFER>,
    pub nvEncEncodePicture: Option<PNVENCENCODEPICTURE>,
    pub nvEncLockBitstream: Option<PNVENCLOCKBITSTREAM>,
    pub nvEncUnlockBitstream: Option<PNVENCUNLOCKBITSTREAM>,
    pub nvEncLockInputBuffer: PUNUSED,
    pub nvEncUnlockInputBuffer: PUNUSED,
    pub nvEncGetEncodeStats: PUNUSED,
    pub nvEncGetSequenceParams: PUNUSED,
    pub nvEncRegisterAsyncEvent: PUNUSED,
    pub nvEncUnregisterAsyncEvent: PUNUSED,
    pub nvEncMapInputResource: Option<PNVENCMAPINPUTRESOURCE>,
    pub nvEncUnmapInputResource: Option<PNVENCUNMAPINPUTRESOURCE>,
    pub nvEncDestroyEncoder: Option<PNVENCDESTROYENCODER>,
    pub nvEncInvalidateRefFrames: Option<PNVENCINVALIDATEREFFRAMES>,
    pub nvEncOpenEncodeSessionEx: Option<PNVENCOPENENCODESESSIONEX>,
    pub nvEncRegisterResource: Option<PNVENCREGISTERRESOURCE>,
    pub nvEncUnregisterResource: Option<PNVENCUNREGISTERRESOURCE>,
    pub nvEncReconfigureEncoder: Option<PNVENCRECONFIGUREENCODER>,
    pub reserved1: PUNUSED,
    pub nvEncCreateMVBuffer: PUNUSED,
    pub nvEncDestroyMVBuffer: PUNUSED,
    pub nvEncRunMotionEstimationOnly: PUNUSED,
    pub nvEncGetLastErrorString: Option<PNVENCGETLASTERROR>,
    pub nvEncSetIOCudaStreams: PUNUSED,
    pub nvEncGetEncodePresetConfigEx: Option<PNVENCGETENCODEPRESETCONFIGEX>,
    pub nvEncGetSequenceParamEx: PUNUSED,
    pub reserved2: [*mut c_void; 277],
}

/// All-zero value of a header struct (the API's own convention: memset 0, then set `version` and what is needed).
///
/// # Safety
/// Only for the plain-data structs of this file (integers, raw pointers, `Option<fn>`), for which all-zero is valid.
pub unsafe fn zeroed<T>() -> T {
    unsafe { std::mem::zeroed() }
}

/// Sets or clears bit `bit` of a bitfield word.
pub fn set_bit(word: &mut u32, bit: u32, on: bool) {
    if on {
        *word |= 1 << bit;
    } else {
        *word &= !(1 << bit);
    }
}

// Sizes from the header (x64). A mismatch here means a transcription error, which would corrupt the driver's view.
#[cfg(target_pointer_width = "64")]
const _: () = {
    use std::mem::size_of;
    assert!(size_of::<GUID>() == 16);
    assert!(size_of::<NV_ENC_CAPS_PARAM>() == 256);
    assert!(size_of::<NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS>() == 1552);
    assert!(size_of::<NV_ENC_RC_PARAMS>() == 128);
    assert!(size_of::<NV_ENC_CONFIG_VUI_PARAMETERS>() == 112);
    assert!(size_of::<NV_ENC_CONFIG_H264>() == 1792);
    assert!(size_of::<NV_ENC_CONFIG_HEVC>() == 1560);
    assert!(size_of::<NV_ENC_CODEC_CONFIG>() == 1792);
    assert!(size_of::<NV_ENC_CONFIG>() == 3584);
    assert!(size_of::<NV_ENC_PRESET_CONFIG>() == 5128);
    assert!(size_of::<NV_ENC_INITIALIZE_PARAMS>() == 1808);
    assert!(size_of::<NV_ENC_RECONFIGURE_PARAMS>() == 1824);
    assert!(size_of::<NV_ENC_CREATE_BITSTREAM_BUFFER>() == 776);
    assert!(size_of::<NV_ENC_REGISTER_RESOURCE>() == 1536);
    assert!(size_of::<NV_ENC_MAP_INPUT_RESOURCE>() == 1544);
    assert!(size_of::<NV_ENC_TIME_CODE>() == 28);
    assert!(size_of::<NV_ENC_PIC_PARAMS_H264>() == 1536);
    assert!(size_of::<NV_ENC_PIC_PARAMS_HEVC>() == 1536);
    assert!(size_of::<NV_ENC_CODEC_PIC_PARAMS>() == 1552);
    assert!(size_of::<NV_ENC_PIC_PARAMS>() == 3360);
    assert!(size_of::<NV_ENC_LOCK_BITSTREAM>() == 1544);
    assert!(size_of::<NV_ENCODE_API_FUNCTION_LIST>() == 2552);
};

#[cfg(test)]
mod tests {
    use super::*;
    use std::mem::offset_of;

    /// Offsets of the fields the encoder writes, recomputed from the header's declarations.
    #[test]
    fn field_offsets() {
        assert_eq!(offset_of!(NV_ENC_CONFIG, rcParams), 40);
        assert_eq!(offset_of!(NV_ENC_CONFIG, encodeCodecConfig), 168);
        assert_eq!(offset_of!(NV_ENC_RC_PARAMS, bits), 36);
        assert_eq!(offset_of!(NV_ENC_RC_PARAMS, multiPass), 100);
        assert_eq!(offset_of!(NV_ENC_CONFIG_H264, h264VUIParameters), 72);
        assert_eq!(offset_of!(NV_ENC_CONFIG_H264, numRefL0), 204);
        assert_eq!(offset_of!(NV_ENC_CONFIG_HEVC, hevcVUIParameters), 64);
        assert_eq!(offset_of!(NV_ENC_CONFIG_HEVC, numRefL0), 184);
        assert_eq!(offset_of!(NV_ENC_INITIALIZE_PARAMS, encodeConfig), 88);
        assert_eq!(offset_of!(NV_ENC_INITIALIZE_PARAMS, tuningInfo), 136);
        assert_eq!(offset_of!(NV_ENC_PIC_PARAMS, inputTimeStamp), 24);
        assert_eq!(offset_of!(NV_ENC_PIC_PARAMS, codecPicParams), 80);
        assert_eq!(offset_of!(NV_ENC_LOCK_BITSTREAM, bitstreamSizeInBytes), 36);
        assert_eq!(offset_of!(NV_ENC_LOCK_BITSTREAM, bitstreamBufferPtr), 56);
        assert_eq!(offset_of!(NV_ENC_LOCK_BITSTREAM, pictureType), 64);
        assert_eq!(offset_of!(NV_ENCODE_API_FUNCTION_LIST, nvEncOpenEncodeSessionEx), 8 + 29 * 8);
        assert_eq!(offset_of!(NV_ENCODE_API_FUNCTION_LIST, nvEncGetEncodePresetConfigEx), 8 + 39 * 8);
    }

    #[test]
    fn versions() {
        assert_eq!(struct_version(1), 0x7001_000c);
        assert_eq!(NV_ENC_CONFIG_VER, 0xf008_000c);
        assert_eq!(status_name(8), "NV_ENC_ERR_INVALID_PARAM");
        assert_eq!(status_name(99), "NV_ENC_ERR_UNKNOWN");
    }
}

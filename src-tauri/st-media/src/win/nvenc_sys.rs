//! Raw NVENC API: the subset of `nvEncodeAPI.h` this crate uses, transcribed by hand (or bindgen output, committed)
//! from NVIDIA Video Codec SDK **12.0** — nv-codec-headers `n12.0.16.1`, `include/ffnvcodec/nvEncodeAPI.h`, MIT
//! licence (keep its copyright notice in this file when the structs are filled in). No SDK binaries are shipped:
//! `nvEncodeAPI64.dll` comes with the NVIDIA driver and is loaded at runtime (nvenc.rs).
//!
//! SDK 12.0 needs driver ≥ 522.25 (Windows). Struct versions are `struct_version(n)` with the header's `n` per
//! struct; every struct is `#[repr(C)]` with its reserved arrays, so sizes match the header exactly
//! (`const _: () = assert!(size_of::<…>() == …)` for each one).
#![allow(non_camel_case_types, non_snake_case, dead_code)]

use std::ffi::c_void;

pub type NVENCSTATUS = i32;
pub const NV_ENC_SUCCESS: NVENCSTATUS = 0;

pub const NVENCAPI_MAJOR_VERSION: u32 = 12;
pub const NVENCAPI_MINOR_VERSION: u32 = 0;
pub const NVENCAPI_VERSION: u32 = NVENCAPI_MAJOR_VERSION | (NVENCAPI_MINOR_VERSION << 24);

/// `NVENCAPI_STRUCT_VERSION(ver)` of the header.
pub const fn struct_version(ver: u32) -> u32 {
    NVENCAPI_VERSION | (ver << 16) | (0x7 << 28)
}

/// `NvEncodeAPIGetMaxSupportedVersion`: (major << 4) | minor of the newest API the installed driver supports.
pub type NvEncodeAPIGetMaxSupportedVersion = unsafe extern "system" fn(version: *mut u32) -> NVENCSTATUS;
/// `NvEncodeAPICreateInstance`: fills the function list (its `version` set to `struct_version(2)` first).
pub type NvEncodeAPICreateInstance = unsafe extern "system" fn(function_list: *mut NV_ENCODE_API_FUNCTION_LIST) -> NVENCSTATUS;

/// `NV_ENCODE_API_FUNCTION_LIST`. TODO(WIN): every entry point in header order (nvEncOpenEncodeSession …
/// nvEncSetIOCudaStreams, then `reserved2`), as `Option<unsafe extern "system" fn(…) -> NVENCSTATUS>`.
#[repr(C)]
pub struct NV_ENCODE_API_FUNCTION_LIST {
    pub version: u32,
    pub reserved: u32,
    /// placeholder until the entry points are transcribed (keeps the struct non-empty)
    pub todo: *mut c_void,
}

//! Helpers for the WIN tests: GPU availability (tests skip without NVIDIA / NVENC), one GPU test at a time, and a
//! tiny Annex B reader (NAL types, slice types) to check what NVENC produced. Never touches the screen.
#![allow(dead_code)]

use std::sync::{Mutex, MutexGuard};

/// Tests that time the GPU run one at a time (parallel encodes would distort the numbers).
pub fn gpu_lock() -> MutexGuard<'static, ()> {
    static LOCK: Mutex<()> = Mutex::new(());
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// Some(gpu) when NVENC can run here; otherwise prints why and returns None (the test passes as skipped).
/// `ST_REQUIRE_NVENC=1` turns a skip into a failure (machines that must have NVENC).
#[cfg(windows)]
pub fn nvenc_gpu() -> Option<st_media::win::d3d::Gpu> {
    let r = st_media::win::nvenc::NvencLib::get().map(|_| ()).and_then(|_| st_media::win::d3d::Gpu::nvidia());
    match r {
        Ok(gpu) => Some(gpu),
        Err(e) => {
            assert!(std::env::var("ST_REQUIRE_NVENC").as_deref() != Ok("1"), "NVENC required but missing: {e}");
            eprintln!("skipped: no NVENC here ({e})");
            None
        }
    }
}

/// NAL units of an Annex B stream (without start codes).
pub fn nal_units(data: &[u8]) -> Vec<&[u8]> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 <= data.len() {
        if data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1 {
            starts.push(i + 3);
            i += 3;
        } else {
            i += 1;
        }
    }
    let mut out = Vec::new();
    for (n, &s) in starts.iter().enumerate() {
        let mut end = starts.get(n + 1).map_or(data.len(), |&next| next - 3);
        // a 4-byte start code leaves its leading zero on the previous unit
        while end > s && data[end - 1] == 0 && n + 1 < starts.len() {
            end -= 1;
        }
        out.push(&data[s..end]);
    }
    out
}

pub fn starts_with_start_code(data: &[u8]) -> bool {
    data.starts_with(&[0, 0, 0, 1]) || data.starts_with(&[0, 0, 1])
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Codec {
    H264,
    Hevc,
}

pub fn nal_type(codec: Codec, nal: &[u8]) -> u8 {
    match codec {
        Codec::H264 => nal[0] & 0x1f,
        Codec::Hevc => (nal[0] >> 1) & 0x3f,
    }
}

/// Parameter-set NAL types in the order a key frame must start with them.
pub fn parameter_sets(codec: Codec) -> &'static [u8] {
    match codec {
        Codec::H264 => &[7, 8],
        Codec::Hevc => &[32, 33, 34],
    }
}

pub fn is_idr(codec: Codec, t: u8) -> bool {
    match codec {
        Codec::H264 => t == 5,
        Codec::Hevc => t == 19 || t == 20,
    }
}

pub fn is_slice(codec: Codec, t: u8) -> bool {
    match codec {
        Codec::H264 => t == 1 || t == 5,
        Codec::Hevc => t <= 21,
    }
}

/// Slice type of a (first) slice NAL: 'I', 'P' or 'B'.
pub fn slice_type(codec: Codec, nal: &[u8]) -> char {
    let rbsp = unescape(nal);
    match codec {
        Codec::H264 => {
            let mut r = Bits::new(&rbsp[1..]);
            r.ue(); // first_mb_in_slice
            match r.ue() % 5 {
                0 => 'P',
                1 => 'B',
                2 => 'I',
                _ => '?',
            }
        }
        Codec::Hevc => {
            let t = nal_type(codec, nal);
            let mut r = Bits::new(&rbsp[2..]);
            let first = r.bit();
            assert_eq!(first, 1, "only first slice segments are parsed");
            if (16..=23).contains(&t) {
                r.bit(); // no_output_of_prior_pics_flag
            }
            r.ue(); // slice_pic_parameter_set_id
            // num_extra_slice_header_bits = 0 (NVENC's PPS)
            match r.ue() {
                0 => 'B',
                1 => 'P',
                2 => 'I',
                _ => '?',
            }
        }
    }
}

/// NAL payload without emulation-prevention bytes.
fn unescape(nal: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(nal.len());
    let mut zeros = 0;
    for &b in nal {
        if zeros >= 2 && b == 3 {
            zeros = 0;
            continue;
        }
        zeros = if b == 0 { zeros + 1 } else { 0 };
        out.push(b);
    }
    out
}

struct Bits<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Bits<'a> {
    fn new(data: &'a [u8]) -> Self {
        Bits { data, pos: 0 }
    }

    fn bit(&mut self) -> u32 {
        let b = self.data.get(self.pos / 8).map_or(0, |&byte| (byte >> (7 - self.pos % 8)) & 1);
        self.pos += 1;
        b as u32
    }

    fn ue(&mut self) -> u32 {
        let mut zeros = 0;
        while self.bit() == 0 && zeros < 32 {
            zeros += 1;
        }
        let mut v = 1u64;
        for _ in 0..zeros {
            v = (v << 1) | self.bit() as u64;
        }
        (v - 1) as u32
    }
}

/// Checks one access unit: Ok((key, slice type of its first slice)).
pub fn check_au(codec: Codec, au: &[u8]) -> Result<(bool, char), String> {
    if !starts_with_start_code(au) {
        return Err("no start code".into());
    }
    let nals = nal_units(au);
    let types: Vec<u8> = nals.iter().map(|n| nal_type(codec, n)).collect();
    let first_slice = nals.iter().position(|n| is_slice(codec, nal_type(codec, n))).ok_or_else(|| format!("no slice in {types:?}"))?;
    let key = is_idr(codec, types[first_slice]);
    if key {
        // parameter sets come first (SEI may sit between them and the slice)
        let ps = parameter_sets(codec);
        if types.len() < ps.len() || &types[..ps.len()] != ps {
            return Err(format!("key frame does not start with parameter sets: {types:?}"));
        }
    }
    Ok((key, slice_type(codec, nals[first_slice])))
}

/// Fixture index line: "<offset> <length> <key 0|1>" per access unit.
pub fn parse_index(text: &str) -> Vec<(usize, usize, bool)> {
    text.lines()
        .filter(|l| !l.trim().is_empty() && !l.starts_with('#'))
        .map(|l| {
            let v: Vec<usize> = l.split_whitespace().map(|x| x.parse().expect("index number")).collect();
            (v[0], v[1], v[2] == 1)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exp_golomb() {
        // bits 1 | 010 | 011 | 00100 → 0, 1, 2, 3
        let data = [0b1010_0110, 0b0100_0000];
        let mut r = Bits::new(&data);
        assert_eq!((r.ue(), r.ue(), r.ue(), r.ue()), (0, 1, 2, 3));
    }
}

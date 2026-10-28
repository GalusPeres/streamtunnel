//! Per-frame Reed-Solomon FEC with `reed-solomon-simd` (docs/NATIVE-PATH.md §6.2): one block per frame, every
//! shard the same even length, parity = max(2, ⌈k × pct / 100⌉), no FEC above [`MAX_FEC_DATA_SHARDS`].
#![allow(unused_variables, dead_code)] // skeleton: remove when the bodies are filled

/// Frames with more data shards are sent without parity (≈ 900 KB: an abnormal frame; Sunshine does the same).
pub const MAX_FEC_DATA_SHARDS: usize = 800;
/// Parity share on a "lan" link (%).
pub const FEC_PCT_LAN: u8 = 10;
/// Parity share on any other link (%).
pub const FEC_PCT_WAN: u8 = 20;
/// Lower bound of parity shards per frame (when FEC is on).
pub const MIN_PARITY: usize = 2;

/// Parity shards for `data` data shards at `pct` percent: 0 above [`MAX_FEC_DATA_SHARDS`] or for pct 0, else
/// max([`MIN_PARITY`], ⌈data × pct / 100⌉).
pub fn parity_count(data: usize, pct: u8) -> usize {
    if data == 0 || pct == 0 || data > MAX_FEC_DATA_SHARDS {
        return 0;
    }
    MIN_PARITY.max((data * pct as usize).div_ceil(100))
}

/// Recovery shards for equally long, even-length data shards. `parity` ≥ 1.
pub fn encode(data: &[&[u8]], parity: usize) -> Result<Vec<Vec<u8>>, String> {
    todo!("NET: reed_solomon_simd::encode")
}

/// Restores the missing data shards of one frame from any `data_count` received shards.
/// `received` = (shard index, bytes) with indexes `0..data_count` = data, `data_count..` = parity.
/// Returns the restored data shards (index, bytes) — only those that were missing.
pub fn decode(data_count: usize, parity_count: usize, received: &[(usize, &[u8])]) -> Result<Vec<(usize, Vec<u8>)>, String> {
    todo!("NET: reed_solomon_simd::decode")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parity_rule() {
        assert_eq!(parity_count(1, FEC_PCT_LAN), 2);
        assert_eq!(parity_count(30, FEC_PCT_LAN), 3);
        assert_eq!(parity_count(30, FEC_PCT_WAN), 6);
        assert_eq!(parity_count(801, FEC_PCT_WAN), 0);
    }
}

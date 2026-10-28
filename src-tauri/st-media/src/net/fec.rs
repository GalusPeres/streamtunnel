//! Per-frame Reed-Solomon FEC with `reed-solomon-simd` (docs/NATIVE-PATH.md §6.2): one block per frame, every
//! shard the same even length, parity = max(2, ⌈k × pct / 100⌉), no FEC above [`MAX_FEC_DATA_SHARDS`].

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
    reed_solomon_simd::encode(data.len(), parity, data.iter().copied()).map_err(|e| e.to_string())
}

/// Restores the missing data shards of one frame from any `data_count` received shards.
/// `received` = (shard index, bytes) with indexes `0..data_count` = data, `data_count..` = parity.
/// Returns the restored data shards (index, bytes) — only those that were missing.
pub fn decode(data_count: usize, parity_count: usize, received: &[(usize, &[u8])]) -> Result<Vec<(usize, Vec<u8>)>, String> {
    if let Some((i, _)) = received.iter().find(|(i, _)| *i >= data_count + parity_count) {
        return Err(format!("shard index {i} out of range"));
    }
    let original = received.iter().filter(|(i, _)| *i < data_count).map(|&(i, s)| (i, s));
    let recovery = received.iter().filter(|(i, _)| *i >= data_count).map(|&(i, s)| (i - data_count, s));
    let restored = reed_solomon_simd::decode(data_count, parity_count, original, recovery).map_err(|e| e.to_string())?;
    Ok(restored.into_iter().collect())
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
        assert_eq!(parity_count(800, FEC_PCT_WAN), 160);
        assert_eq!(parity_count(5, 0), 0);
    }

    /// Small deterministic generator (tests only).
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0
        }
    }

    /// For k in 1..=100 at both parity shares: every loss of up to m shards (data and parity mixed, chosen at
    /// random, several patterns each; for small k every pattern) restores exactly the original data.
    #[test]
    fn any_loss_up_to_parity_recovers() {
        let mut rng = Rng(0x1234_5678_9abc_def1);
        for pct in [FEC_PCT_LAN, FEC_PCT_WAN] {
            for k in 1..=100usize {
                let m = parity_count(k, pct);
                let len = 2 * (1 + rng.next() as usize % 40);
                let data: Vec<Vec<u8>> = (0..k).map(|_| (0..len).map(|_| rng.next() as u8).collect()).collect();
                let refs: Vec<&[u8]> = data.iter().map(|d| d.as_slice()).collect();
                let parity = encode(&refs, m).unwrap();
                assert_eq!(parity.len(), m);
                let all: Vec<&[u8]> = refs.iter().copied().chain(parity.iter().map(|p| p.as_slice())).collect();

                let mut patterns: Vec<Vec<usize>> = Vec::new();
                if k + m <= 6 {
                    // every subset of at most m lost shards
                    for mask in 0u32..(1 << (k + m)) {
                        if mask.count_ones() as usize <= m {
                            patterns.push((0..k + m).filter(|i| mask & (1 << i) != 0).collect());
                        }
                    }
                } else {
                    for _ in 0..12 {
                        let lose = 1 + rng.next() as usize % m;
                        let mut idx: Vec<usize> = (0..k + m).collect();
                        for i in 0..lose {
                            let j = i + rng.next() as usize % (k + m - i);
                            idx.swap(i, j);
                        }
                        patterns.push(idx[..lose].to_vec());
                    }
                    patterns.push((0..m.min(k)).collect()); // the first data shards
                }
                for lost in patterns {
                    let received: Vec<(usize, &[u8])> =
                        all.iter().enumerate().filter(|(i, _)| !lost.contains(i)).map(|(i, s)| (i, *s)).collect();
                    let restored = decode(k, m, &received).unwrap();
                    let lost_data: Vec<usize> = lost.iter().copied().filter(|&i| i < k).collect();
                    assert_eq!(restored.len(), lost_data.len(), "k {k} m {m} lost {lost:?}");
                    for (i, bytes) in restored {
                        assert_eq!(bytes, data[i], "k {k} m {m} shard {i}");
                    }
                }
            }
        }
    }

    #[test]
    fn too_much_loss_and_bad_input_fail() {
        let data = [[1u8, 2, 3, 4].as_slice(), [5, 6, 7, 8].as_slice(), [9, 10, 11, 12].as_slice()];
        let parity = encode(&data, 2).unwrap();
        // 3 lost of 5 with 2 parity: impossible
        assert!(decode(3, 2, &[(0, data[0]), (3, parity[0].as_slice())]).is_err());
        // odd shard lengths are rejected
        assert!(encode(&[[1u8, 2, 3].as_slice()], 2).is_err());
        // index out of range
        assert!(decode(3, 2, &[(0, data[0]), (1, data[1]), (5, parity[0].as_slice())]).is_err());
        // nothing missing: nothing to restore
        assert!(decode(3, 2, &[(0, data[0]), (1, data[1]), (2, data[2])]).unwrap().is_empty());
    }

    /// cargo test --release -- --ignored --nocapture fec_benchmark
    #[test]
    #[ignore = "benchmark"]
    fn fec_benchmark() {
        let len = crate::net::wire::MAX_SHARD;
        for k in [1usize, 2, 5, 10, 20, 50, 100] {
            let m = parity_count(k, FEC_PCT_WAN);
            let data: Vec<Vec<u8>> = (0..k).map(|i| vec![i as u8; len]).collect();
            let refs: Vec<&[u8]> = data.iter().map(|d| d.as_slice()).collect();
            let runs = 200;
            let t = std::time::Instant::now();
            let mut parity = Vec::new();
            for _ in 0..runs {
                parity = encode(&refs, m).unwrap();
            }
            let enc = t.elapsed().as_secs_f64() * 1e6 / runs as f64;
            // lose the first m data shards (the worst case for the decoder)
            let lost = m.min(k);
            let received: Vec<(usize, &[u8])> =
                (lost..k).map(|i| (i, refs[i])).chain(parity.iter().enumerate().map(|(i, p)| (k + i, p.as_slice()))).collect();
            let t = std::time::Instant::now();
            for _ in 0..runs {
                decode(k, m, &received).unwrap();
            }
            let dec = t.elapsed().as_secs_f64() * 1e6 / runs as f64;
            println!("fec k {k:3} m {m:2} ({len} B shards): encode {enc:7.1} µs, decode {dec:7.1} µs (lost {lost})");
        }
    }
}

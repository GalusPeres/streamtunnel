//! The committed NVENC fixtures (`tests/fixtures/pattern_720p30.{h264,hevc}` + `.idx`, written by
//! `win_nvenc::write_fixtures` on an RTX 4080) are what a receiver test expects: one access unit per index line,
//! parameter sets + IDR first, an IDR again at frame 30, P slices only in between. Runs on every OS (no GPU).
//!
//! Use them in receiver tests like this:
//! ```ignore
//! let stream = std::fs::read("tests/fixtures/pattern_720p30.hevc")?;
//! for (offset, len, key) in parse_index(&std::fs::read_to_string("tests/fixtures/pattern_720p30.hevc.idx")?) {
//!     let au = &stream[offset..offset + len]; // one EncodedFrame.data, `key` = EncodedFrame.key
//! }
//! ```

mod win_common;

use win_common::{check_au, parse_index, Codec};

fn fixture(name: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join(name);
    std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

#[test]
fn fixtures_are_valid_access_units() {
    let mut total = 0;
    for (codec, ext) in [(Codec::H264, "h264"), (Codec::Hevc, "hevc")] {
        let stream = fixture(&format!("pattern_720p30.{ext}"));
        let index = parse_index(&String::from_utf8(fixture(&format!("pattern_720p30.{ext}.idx"))).unwrap());
        assert_eq!(index.len(), 60, "{ext}: 60 access units");
        let mut next = 0;
        for (i, &(offset, len, key)) in index.iter().enumerate() {
            assert_eq!(offset, next, "{ext} frame {i}: units are back to back");
            next = offset + len;
            let (is_key, slice) = check_au(codec, &stream[offset..next]).unwrap_or_else(|e| panic!("{ext} frame {i}: {e}"));
            assert_eq!(is_key, key, "{ext} frame {i}: index key flag");
            assert_eq!(key, i == 0 || i == 30, "{ext} frame {i}: IDR at 0 and 30 only");
            assert_eq!(slice, if key { 'I' } else { 'P' }, "{ext} frame {i}");
        }
        assert_eq!(next, stream.len(), "{ext}: the index covers the whole file");
        total += stream.len();
    }
    assert!(total < 2 << 20, "fixtures stay small: {total} bytes");
}

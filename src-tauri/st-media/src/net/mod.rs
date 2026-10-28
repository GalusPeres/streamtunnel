//! `stm/1` transport: a sans-IO core (wire, crypto, fec, frame, ctrl, pace, rate, ice) plus the socket driver
//! ([`link`]). Identical on every OS. Byte layouts and timing rules: docs/NATIVE-PATH.md §4–§6.

pub mod crypto;
pub mod ctrl;
pub mod fec;
pub mod frame;
pub mod ice;
pub mod link;
pub mod pace;
pub mod rate;
pub mod wire;

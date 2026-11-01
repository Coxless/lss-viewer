//! 8-byte point encoding: `int16 x, y, z, attr`, relative to a node's centre and half size.

use crate::Galaxy;

pub const POINT_BYTES: usize = 8;
const SCALE: f64 = 32767.0;

/// Appends one galaxy to `out`.
pub fn encode(g: &Galaxy, center: [f32; 3], half: f32, out: &mut Vec<u8>) {
    for (p, c) in g.pos.iter().zip(center) {
        let q = ((p - c as f64) / half as f64 * SCALE).round().clamp(-SCALE, SCALE) as i16;
        out.extend_from_slice(&q.to_le_bytes());
    }
    out.extend_from_slice(&(g.attr as i16).to_le_bytes());
}

/// Decodes one 8-byte point back to a position and an attribute.
pub fn decode(bytes: &[u8], center: [f32; 3], half: f32) -> Galaxy {
    let q = |i: usize| i16::from_le_bytes([bytes[2 * i], bytes[2 * i + 1]]);
    let pos = std::array::from_fn(|a| center[a] as f64 + q(a) as f64 / SCALE * half as f64);
    Galaxy { pos, attr: q(3) as u16 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_error_is_within_one_step() {
        let (c, h) = ([10.5f32, -20.25, 3.0], 64.0f32);
        let mut buf = Vec::new();
        for i in 0..1000 {
            let t = i as f64 / 999.0 * 2.0 - 1.0;
            let g = Galaxy {
                pos: [c[0] as f64 + t * h as f64, c[1] as f64 - t * h as f64, c[2] as f64 + t * t * h as f64],
                attr: 0x2abc,
            };
            buf.clear();
            encode(&g, c, h, &mut buf);
            assert_eq!(buf.len(), POINT_BYTES);
            let d = decode(&buf, c, h);
            assert_eq!(d.attr, g.attr);
            for a in 0..3 {
                assert!((d.pos[a] - g.pos[a]).abs() <= h as f64 / SCALE);
            }
        }
    }
}

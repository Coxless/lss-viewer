//! lss-viewer-core: the preprocessing algorithms shared by the CLI and the Wasm build.
//!
//! Nothing in here touches the file system. All trigonometry goes through `libm`
//! and all randomness through a seeded ChaCha stream, so the native and the Wasm
//! builds produce the same bytes for the same input.

pub mod catalog;
pub mod cosmology;
pub mod dataset;
pub mod density;
pub mod footprint;
pub mod format;
pub mod layers;
pub mod mock;
pub mod octree;
pub mod par;
pub mod quantize;
pub mod shells;
pub mod structures;
pub mod vast;
pub mod voids;

/// One galaxy in observer-centred Cartesian coordinates (Mpc/h).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Galaxy {
    pub pos: [f64; 3],
    /// `kind << 12 | brightness`; bit 15 is always 0 so it reads as a positive int16.
    pub attr: u16,
}

pub const KIND_FIELD: u16 = 1;
pub const BRIGHTNESS_MAX: u16 = 4095;

/// Packs a 3-bit kind and a 12-bit brightness into the point attribute.
pub fn pack_attr(kind: u16, brightness: u16) -> u16 {
    ((kind & 7) << 12) | (brightness & BRIGHTNESS_MAX)
}

/// Axis-aligned bounds of a set of galaxies: `[xmin, ymin, zmin, xmax, ymax, zmax]`.
pub fn bounds(galaxies: &[Galaxy]) -> [f64; 6] {
    let mut b = [f64::MAX, f64::MAX, f64::MAX, f64::MIN, f64::MIN, f64::MIN];
    for g in galaxies {
        for a in 0..3 {
            b[a] = b[a].min(g.pos[a]);
            b[a + 3] = b[a + 3].max(g.pos[a]);
        }
    }
    b
}

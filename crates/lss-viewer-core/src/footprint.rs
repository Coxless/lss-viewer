//! Angular survey mask on HEALPix: a direction is observed if any galaxy lies in it.

use crate::cosmology::{sin_deg, to_spherical};
use crate::Galaxy;
use cdshealpix::compass_point::MainWind;
use std::collections::BTreeMap;
use std::f64::consts::PI;

pub const MAX_DEPTH: u8 = 7; // Nside 128
const MIN_DEPTH: u8 = 4; // Nside 16
/// Fewer galaxies per occupied pixel than this leaves holes in the mask, so Nside drops.
const MIN_GALAXIES_PER_PIXEL: f64 = 5.0;
const RA_BIN_DEG: f64 = 1.0;
/// An RA gap narrower than this is not a survey edge.
const MIN_EDGE_GAP_DEG: f64 = 20.0;
const OUTLINE_DEPTH: u8 = 5; // Nside 32, about 1.8 degrees
/// A coarse pixel counts as observed when at least this share of its fine pixels is.
const OUTLINE_MIN_COVERAGE: f64 = 0.25;
/// Above this share of its RA/Dec box, a survey is drawn as a plain box.
pub const RECTANGULAR_MIN_FILL: f64 = 0.8;

#[derive(Clone, Debug, PartialEq)]
pub struct Footprint {
    pub depth: u8,
    /// One bit per NESTED pixel, least significant bit first.
    pub bits: Vec<u8>,
}

fn pixel(depth: u8, ra_deg: f64, dec_deg: f64) -> u64 {
    cdshealpix::nested::get(depth).hash(ra_deg * PI / 180.0, dec_deg * PI / 180.0)
}

impl Footprint {
    pub fn nside(&self) -> u32 {
        1 << self.depth
    }

    fn build(galaxies: &[Galaxy], depth: u8) -> (Self, u64) {
        let pixels = 12u64 << (2 * depth as u64);
        let mut bits = vec![0u8; pixels.div_ceil(8) as usize];
        let mut occupied = 0;
        for g in galaxies {
            let (ra, dec, _) = to_spherical(g.pos);
            let h = pixel(depth, ra, dec);
            let (byte, bit) = ((h / 8) as usize, 1u8 << (h % 8));
            if bits[byte] & bit == 0 {
                bits[byte] |= bit;
                occupied += 1;
            }
        }
        (Self { depth, bits }, occupied)
    }

    /// Builds the mask at the finest Nside (at most 128) that the catalog can fill.
    pub fn from_galaxies(galaxies: &[Galaxy]) -> Self {
        let mut depth = MAX_DEPTH;
        loop {
            let (f, occupied) = Self::build(galaxies, depth);
            let per_pixel = galaxies.len() as f64 / occupied.max(1) as f64;
            if per_pixel >= MIN_GALAXIES_PER_PIXEL || depth == MIN_DEPTH {
                return f;
            }
            depth -= 1;
        }
    }

    /// Observed coarse pixels, in pixel order.
    fn coarse_pixels(&self) -> (u8, BTreeMap<u64, u32>) {
        let depth = self.depth.min(OUTLINE_DEPTH);
        let shift = 2 * (self.depth - depth) as u64;
        let mut counts: BTreeMap<u64, u32> = BTreeMap::new();
        for (byte, &v) in self.bits.iter().enumerate() {
            for bit in 0..8u64 {
                if v >> bit & 1 == 1 {
                    *counts.entry((byte as u64 * 8 + bit) >> shift).or_default() += 1;
                }
            }
        }
        let need = OUTLINE_MIN_COVERAGE * (1u64 << shift) as f64;
        counts.retain(|_, n| *n as f64 >= need);
        (depth, counts)
    }

    /// The share of the RA/Dec box of `range` that is actually observed.
    pub fn box_fill(&self, range: &AngularRange) -> f64 {
        let (depth, coarse) = self.coarse_pixels();
        let pixel_sr = 4.0 * PI / (12u64 << (2 * depth as u64)) as f64;
        let width = if range.ra[1] < range.ra[0] { range.ra[1] + 360.0 - range.ra[0] } else { range.ra[1] - range.ra[0] };
        let box_sr = width * PI / 180.0 * (sin_deg(range.dec[1]) - sin_deg(range.dec[0]));
        if box_sr <= 0.0 { 1.0 } else { coarse.len() as f64 * pixel_sr / box_sr }
    }

    /// The survey boundary as line segments on the sky: `[ra0, dec0, ra1, dec1, ...]`, degrees.
    pub fn outline(&self) -> Vec<f64> {
        let (depth, coarse) = self.coarse_pixels();
        let layer = cdshealpix::nested::get(depth);
        let deg = |v: f64| (v * 180.0 / PI * 100.0).round() / 100.0;
        let mut out = Vec::new();
        for &h in coarse.keys() {
            let n = layer.neighbours(h, false);
            let [s, e, north, w] = layer.vertices(h);
            for (wind, a, b) in [(MainWind::SE, s, e), (MainWind::NE, e, north), (MainWind::NW, north, w), (MainWind::SW, w, s)] {
                if !n.get(wind).is_some_and(|other| coarse.contains_key(other)) {
                    out.extend_from_slice(&[deg(a.0), deg(a.1), deg(b.0), deg(b.1)]);
                }
            }
        }
        out
    }

    pub fn contains(&self, p: [f64; 3]) -> bool {
        let (ra, dec, _) = to_spherical(p);
        let h = pixel(self.depth, ra, dec);
        self.bits[(h / 8) as usize] >> (h % 8) & 1 == 1
    }
}

/// Survey edges for the frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AngularRange {
    pub ra: [f64; 2],
    pub dec: [f64; 2],
    pub full_sky: bool,
}

/// Finds the widest empty RA gap; the survey is everything outside it.
pub fn angular_range(galaxies: &[Galaxy]) -> AngularRange {
    let bins = (360.0 / RA_BIN_DEG) as usize;
    let mut lo = vec![f64::MAX; bins];
    let mut hi = vec![f64::MIN; bins];
    let mut dec = [f64::MAX, f64::MIN];
    for g in galaxies {
        let (ra, d, _) = to_spherical(g.pos);
        let b = ((ra / RA_BIN_DEG) as usize).min(bins - 1);
        lo[b] = lo[b].min(ra);
        hi[b] = hi[b].max(ra);
        dec = [dec[0].min(d), dec[1].max(d)];
    }
    let filled: Vec<usize> = (0..bins).filter(|&b| hi[b] != f64::MIN).collect();
    if filled.is_empty() {
        return AngularRange { ra: [0.0, 360.0], dec: [-90.0, 90.0], full_sky: true };
    }
    let (mut best_gap, mut ra) = (-1.0, [0.0, 360.0]);
    for (i, &b) in filled.iter().enumerate() {
        let next = filled[(i + 1) % filled.len()];
        let mut gap = lo[next] - hi[b];
        if gap <= 0.0 && (i + 1 == filled.len() || next == b) {
            gap += 360.0;
        }
        if gap > best_gap {
            best_gap = gap;
            ra = [lo[next], hi[b]];
        }
    }
    let full_sky = best_gap < MIN_EDGE_GAP_DEG;
    AngularRange { ra: if full_sky { [0.0, 360.0] } else { ra }, dec, full_sky }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cosmology::to_cartesian;

    fn at(ra: f64, dec: f64) -> Galaxy {
        Galaxy { pos: to_cartesian(ra, dec, 100.0), attr: 0 }
    }

    #[test]
    fn marks_observed_directions_only() {
        let mut g = Vec::new();
        for i in 0..2000 {
            g.push(at(150.0 + (i % 200) as f64 * 0.1, 10.0 + (i / 200) as f64));
        }
        let f = Footprint::from_galaxies(&g);
        assert!(f.contains(g[0].pos));
        assert!(!f.contains(to_cartesian(320.0, -40.0, 100.0)));
    }

    #[test]
    fn nside_drops_for_sparse_catalogs() {
        let mut dense = Vec::new();
        for i in 0..20_000 {
            dense.push(at(180.0 + (i % 100) as f64 * 0.01, 20.0 + (i / 100) as f64 * 0.005));
        }
        assert_eq!(Footprint::from_galaxies(&dense).nside(), 128);
        let mut sparse = Vec::new();
        for i in 0..400 {
            sparse.push(at(i as f64 * 0.9, 0.0));
        }
        assert!(Footprint::from_galaxies(&sparse).nside() < 128);
    }

    #[test]
    fn a_filled_box_counts_as_rectangular_and_two_patches_do_not() {
        let patch = |ra0: f64, g: &mut Vec<Galaxy>| {
            for i in 0..400 {
                for j in 0..100 {
                    g.push(at(ra0 + i as f64 * 0.05, j as f64 * 0.2));
                }
            }
        };
        let mut one = Vec::new();
        patch(100.0, &mut one);
        let f = Footprint::from_galaxies(&one);
        assert!(f.box_fill(&angular_range(&one)) > RECTANGULAR_MIN_FILL);

        let mut two = Vec::new();
        patch(100.0, &mut two);
        patch(200.0, &mut two);
        let f = Footprint::from_galaxies(&two);
        assert!(f.box_fill(&angular_range(&two)) < RECTANGULAR_MIN_FILL);
    }

    #[test]
    fn outline_surrounds_a_patch_and_stays_close_to_it() {
        let mut g = Vec::new();
        for i in 0..400 {
            for j in 0..200 {
                g.push(at(100.0 + i as f64 * 0.1, 10.0 + j as f64 * 0.1));
            }
        }
        let line = Footprint::from_galaxies(&g).outline();
        assert!(line.len() >= 4 * 8 && line.len().is_multiple_of(4));
        for p in line.chunks(2) {
            assert!((96.0..144.0).contains(&p[0]) && (6.0..34.0).contains(&p[1]), "{p:?}");
        }
        // Inner pixels contribute nothing: far fewer edges than pixels times four.
        let pixels = 40.0 * 20.0 / (1.83f64 * 1.83);
        assert!(((line.len() / 4) as f64) < pixels * 4.0 / 2.0);
    }

    #[test]
    fn range_finds_the_survey_edges() {
        let g: Vec<_> = (0..1100).map(|i| at(130.0 + i as f64 * 0.1, (i % 60) as f64)).collect();
        let r = angular_range(&g);
        assert!(!r.full_sky);
        assert!((r.ra[0] - 130.0).abs() < 1e-6 && (r.ra[1] - 239.9).abs() < 1e-6, "{r:?}");
        assert!((r.dec[1] - 59.0).abs() < 1e-6);
    }

    #[test]
    fn range_wraps_through_zero() {
        let g: Vec<_> = (0..600).map(|i| at((330.0 + i as f64 * 0.1) % 360.0, 5.0)).collect();
        let r = angular_range(&g);
        assert!(!r.full_sky);
        assert!(r.ra[0] > r.ra[1], "{r:?}");
        assert!((r.ra[0] - 330.0).abs() < 1e-6, "{r:?}");
    }

    #[test]
    fn evenly_filled_sky_is_full() {
        let g: Vec<_> = (0..3600).map(|i| at(i as f64 * 0.1, 0.0)).collect();
        assert!(angular_range(&g).full_sky);
    }
}

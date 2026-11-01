//! Mock catalog with a Voronoi foam structure inside an SDSS-like survey volume.
//!
//! The prototype's C source no longer exists, so this is a reimplementation matched
//! to its measured output: RA 130-240, Dec 0-60, r 30-450, constant number density,
//! and kind fractions 6% scattered / 39% filament / 45% wall / 10% cluster.
//!
//! Random seeds act as void centres. A galaxy starts as a uniform point and is
//! projected onto the wall, edge or corner shared by its nearest seeds.

use crate::cosmology::{sin_deg, to_cartesian, to_spherical, DistanceTable};
use crate::{pack_attr, Galaxy, BRIGHTNESS_MAX};
use libm::{asin, cbrt, cos, log, sqrt};
use rand_chacha::rand_core::{RngCore, SeedableRng};
use rand_chacha::ChaCha8Rng;
use std::f64::consts::PI;
use std::fmt::Write;

pub const RA: (f64, f64) = (130.0, 240.0);
pub const DEC: (f64, f64) = (0.0, 60.0);
pub const R: (f64, f64) = (30.0, 450.0);

const SEED_SPACING: f64 = 54.0;
/// Rare giant voids: a seed with no neighbours nearby makes a big Voronoi cell, whose
/// radius is about half the cleared radius. The prototype's list starts at radius 45.
const GIANT_VOIDS: usize = 90;
const GIANT_CLEARED_RADIUS: (f64, f64) = (64.0, 100.0);
const KIND_SCATTERED: u16 = 0;
const KIND_FILAMENT: u16 = 1;
const KIND_WALL: u16 = 2;
const KIND_CLUSTER: u16 = 3;

fn uniform(rng: &mut ChaCha8Rng) -> f64 {
    (rng.next_u64() >> 11) as f64 / (1u64 << 53) as f64
}

fn gaussian(rng: &mut ChaCha8Rng) -> f64 {
    let (u, v) = (1.0 - uniform(rng), uniform(rng));
    sqrt(-2.0 * log(u)) * cos(2.0 * PI * v)
}

fn in_survey(p: [f64; 3]) -> bool {
    let (ra, dec, r) = to_spherical(p);
    (RA.0..RA.1).contains(&ra) && (DEC.0..DEC.1).contains(&dec) && (R.0..R.1).contains(&r)
}

fn uniform_in_survey(rng: &mut ChaCha8Rng) -> [f64; 3] {
    let r = cbrt(R.0 * R.0 * R.0 + uniform(rng) * (R.1 * R.1 * R.1 - R.0 * R.0 * R.0));
    let ra = RA.0 + uniform(rng) * (RA.1 - RA.0);
    let (s0, s1) = (sin_deg(DEC.0), sin_deg(DEC.1));
    let dec = asin(s0 + uniform(rng) * (s1 - s0)) * 180.0 / PI;
    to_cartesian(ra, dec, r)
}

/// Void centres on a uniform grid hash, for nearest-seed queries.
struct Seeds {
    origin: [f64; 3],
    dims: [usize; 3],
    cells: Vec<Vec<[f64; 3]>>,
}

impl Seeds {
    fn new(rng: &mut ChaCha8Rng) -> Self {
        let lo = [-R.1 - 3.0 * SEED_SPACING; 3];
        let dims = [((2.0 * R.1 + 6.0 * SEED_SPACING) / SEED_SPACING) as usize + 1; 3];
        let count = dims[0] * dims[1] * dims[2];
        let mut cells = vec![Vec::new(); count];
        let span = dims[0] as f64 * SEED_SPACING;
        let giants: Vec<([f64; 3], f64)> = (0..GIANT_VOIDS)
            .map(|_| {
                let c: [f64; 3] = std::array::from_fn(|a| lo[a] + uniform(rng) * span);
                let t = uniform(rng);
                (c, GIANT_CLEARED_RADIUS.0 + t * t * (GIANT_CLEARED_RADIUS.1 - GIANT_CLEARED_RADIUS.0))
            })
            .collect();
        for (c, _) in &giants {
            let idx = Self::cell_of(&lo, &dims, *c);
            cells[idx.0 + dims[0] * (idx.1 + dims[1] * idx.2)].push(*c);
        }
        for _ in 0..count {
            let p: [f64; 3] = std::array::from_fn(|a| lo[a] + uniform(rng) * span);
            if giants.iter().any(|(c, r)| dist2(p, *c) < r * r) {
                continue;
            }
            let idx = Self::cell_of(&lo, &dims, p);
            cells[idx.0 + dims[0] * (idx.1 + dims[1] * idx.2)].push(p);
        }
        Self { origin: lo, dims, cells }
    }

    fn cell_of(lo: &[f64; 3], dims: &[usize; 3], p: [f64; 3]) -> (usize, usize, usize) {
        let i = |a: usize| (((p[a] - lo[a]) / SEED_SPACING) as usize).min(dims[a] - 1);
        (i(0), i(1), i(2))
    }

    /// The `N` nearest seeds to `p`, closest first.
    fn nearest<const N: usize>(&self, p: [f64; 3]) -> [[f64; 3]; N] {
        let (ci, cj, ck) = Self::cell_of(&self.origin, &self.dims, p);
        let mut best = [(f64::MAX, [0.0; 3]); N];
        let range = |c: usize, n: usize| c.saturating_sub(2)..(c + 3).min(n);
        for k in range(ck, self.dims[2]) {
            for j in range(cj, self.dims[1]) {
                for i in range(ci, self.dims[0]) {
                    for &s in &self.cells[i + self.dims[0] * (j + self.dims[1] * k)] {
                        let d2 = dist2(p, s);
                        if d2 < best[N - 1].0 {
                            let mut at = N - 1;
                            while at > 0 && d2 < best[at - 1].0 {
                                best[at] = best[at - 1];
                                at -= 1;
                            }
                            best[at] = (d2, s);
                        }
                    }
                }
            }
        }
        best.map(|b| b.1)
    }
}

fn dist2(a: [f64; 3], b: [f64; 3]) -> f64 {
    (0..3).map(|i| (a[i] - b[i]) * (a[i] - b[i])).sum()
}

/// Moves `p` onto the set of points equidistant from all of `seeds`.
fn project_equidistant(mut p: [f64; 3], seeds: &[[f64; 3]]) -> [f64; 3] {
    let mut basis: Vec<[f64; 3]> = Vec::with_capacity(seeds.len());
    for s in &seeds[1..] {
        let mid: [f64; 3] = std::array::from_fn(|a| 0.5 * (seeds[0][a] + s[a]));
        let mut n: [f64; 3] = std::array::from_fn(|a| s[a] - seeds[0][a]);
        for b in &basis {
            let d = n[0] * b[0] + n[1] * b[1] + n[2] * b[2];
            for a in 0..3 {
                n[a] -= d * b[a];
            }
        }
        let len = sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
        if len < 1e-9 {
            continue;
        }
        n = n.map(|v| v / len);
        // Solve for the step along the orthogonalised normal that lands on this bisector.
        let plane: [f64; 3] = std::array::from_fn(|a| s[a] - seeds[0][a]);
        let plane_dot_n = plane[0] * n[0] + plane[1] * n[1] + plane[2] * n[2];
        let offset = (0..3).map(|a| plane[a] * (mid[a] - p[a])).sum::<f64>() / plane_dot_n;
        for a in 0..3 {
            p[a] += offset * n[a];
        }
        basis.push(n);
    }
    p
}

fn brightness(rng: &mut ChaCha8Rng, boost: f64) -> u16 {
    let v = uniform(rng).max(0.3 * uniform(rng)).max(boost * uniform(rng));
    (v * BRIGHTNESS_MAX as f64) as u16
}

/// Generates `n` galaxies. Same `(n, seed)` always gives the same galaxies.
pub fn generate(n: usize, seed: u64) -> Vec<Galaxy> {
    let mut rng = ChaCha8Rng::seed_from_u64(seed);
    let seeds = Seeds::new(&mut rng);
    let mut out = Vec::with_capacity(n);
    while out.len() < n {
        let start = uniform_in_survey(&mut rng);
        let u = uniform(&mut rng);
        let (kind, base, jitter, boost) = if u < 0.06 {
            (KIND_SCATTERED, start, 0.0, 0.0)
        } else if u < 0.514 {
            let s = seeds.nearest::<2>(start);
            (KIND_WALL, project_equidistant(start, &s), 1.6, 0.0)
        } else if u < 0.90 {
            let s = seeds.nearest::<3>(start);
            (KIND_FILAMENT, project_equidistant(start, &s), 1.8, 0.0)
        } else {
            let s = seeds.nearest::<4>(start);
            (KIND_CLUSTER, project_equidistant(start, &s), 1.3, 0.8)
        };
        let pos: [f64; 3] = std::array::from_fn(|a| base[a] + jitter * gaussian(&mut rng));
        if in_survey(pos) {
            let b = brightness(&mut rng, boost);
            out.push(Galaxy { pos, attr: pack_attr(kind, b) });
        }
    }
    out
}

/// Writes galaxies as a CSV with the columns the catalog reader understands.
pub fn to_csv(galaxies: &[Galaxy]) -> String {
    let table = DistanceTable::new(0.7);
    let mut s = String::with_capacity(galaxies.len() * 40 + 32);
    s.push_str("ra,dec,z,kind,brightness\n");
    for g in galaxies {
        let (ra, dec, r) = to_spherical(g.pos);
        let _ = writeln!(s, "{ra:.6},{dec:.6},{:.7},{},{}", table.redshift(r), g.attr >> 12, g.attr & BRIGHTNESS_MAX);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::{read_csv, AttrMap};

    #[test]
    fn stays_in_the_survey_with_the_requested_count() {
        let g = generate(20_000, 7);
        assert_eq!(g.len(), 20_000);
        assert!(g.iter().all(|g| in_survey(g.pos)));
    }

    #[test]
    fn is_reproducible() {
        assert_eq!(generate(5_000, 3), generate(5_000, 3));
        assert_ne!(generate(5_000, 3), generate(5_000, 4));
    }

    #[test]
    fn kind_fractions_match_the_prototype() {
        let g = generate(100_000, 7);
        let frac = |k: u16| g.iter().filter(|g| g.attr >> 12 == k).count() as f64 / g.len() as f64;
        assert!((frac(KIND_SCATTERED) - 0.06).abs() < 0.02);
        assert!((frac(KIND_CLUSTER) - 0.10).abs() < 0.02);
    }

    #[test]
    fn number_density_is_flat_in_radius() {
        let g = generate(100_000, 7);
        let shell = |a: f64, b: f64| {
            let n = g.iter().filter(|g| (a..b).contains(&to_spherical(g.pos).2)).count() as f64;
            n / (b * b * b - a * a * a)
        };
        let ratio = shell(350.0, 450.0) / shell(150.0, 250.0);
        assert!((ratio - 1.0).abs() < 0.2, "{ratio}");
    }

    #[test]
    fn projection_lands_on_equal_distances() {
        let s = [[0.0, 0.0, 0.0], [10.0, 1.0, 0.0], [2.0, 9.0, 3.0], [-1.0, 4.0, 8.0]];
        let p = project_equidistant([3.0, -2.0, 5.0], &s);
        let d = s.map(|a| dist2(p, a));
        for v in &d[1..] {
            assert!((v - d[0]).abs() < 1e-9, "{d:?}");
        }
    }

    #[test]
    fn csv_round_trip_keeps_positions_and_attributes() {
        let g = generate(2_000, 5);
        let (back, report) = read_csv(to_csv(&g).as_bytes(), &AttrMap::auto(), 1).unwrap();
        assert_eq!(back.len(), g.len());
        assert_eq!(report.dropped(), 0);
        for (a, b) in g.iter().zip(&back) {
            assert_eq!(a.attr, b.attr);
            assert!(dist2(a.pos, b.pos) < 0.01, "{:?} {:?}", a.pos, b.pos);
        }
    }
}

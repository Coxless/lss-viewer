//! Density contrast on a grid, corrected for the survey mask and the radial selection:
//! `delta = G*(rho M) / G*(M n(r)) - 1`.

use crate::footprint::Footprint;
use crate::par;
use crate::Galaxy;
use libm::{exp, log, sqrt};

pub const DEFAULT_DIVISIONS: f64 = 120.0;
pub const DEFAULT_SIGMA_CELLS: f64 = 1.4;
const PAD_CELLS: usize = 2;
const RADIAL_BINS: usize = 128;
const RADIAL_SMOOTH_BINS: usize = 3;
const MIN_MASK_WEIGHT: f32 = 0.6;

pub const ENCODING: &str = "uint8-log";
pub const Q_OUTSIDE: u8 = 255;
const Q_MAX: f64 = 254.0;
const ONE_PLUS_MIN: f64 = 0.05;
const ONE_PLUS_MAX: f64 = 10.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GridSpec {
    pub dims: [usize; 3],
    pub origin: [f64; 3],
    pub cell: f64,
}

impl GridSpec {
    /// Cell size is the longest side of `bbox` over `divisions`; each axis fits the box.
    pub fn around(bbox: [f64; 6], divisions: f64) -> Self {
        let ext = [bbox[3] - bbox[0], bbox[4] - bbox[1], bbox[5] - bbox[2]];
        let cell = (ext[0].max(ext[1]).max(ext[2]) / divisions).max(1e-3);
        let dim = |a: usize| (ext[a] / cell).ceil() as usize + 1 + 2 * PAD_CELLS;
        let org = |a: usize| bbox[a] - PAD_CELLS as f64 * cell;
        Self { dims: [dim(0), dim(1), dim(2)], origin: [org(0), org(1), org(2)], cell }
    }

    pub fn len(&self) -> usize {
        self.dims[0] * self.dims[1] * self.dims[2]
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn index(&self, i: usize, j: usize, k: usize) -> usize {
        i + self.dims[0] * (j + self.dims[1] * k)
    }

    pub fn position(&self, i: usize, j: usize, k: usize) -> [f64; 3] {
        [
            self.origin[0] + i as f64 * self.cell,
            self.origin[1] + j as f64 * self.cell,
            self.origin[2] + k as f64 * self.cell,
        ]
    }
}

/// Unquantized contrast. Cells outside the survey hold NaN.
pub struct DeltaField {
    pub spec: GridSpec,
    pub delta: Vec<f32>,
}

/// The stored grid: uint8, x fastest, `Q_OUTSIDE` outside the survey.
#[derive(Clone)]
pub struct DensityGrid {
    pub spec: GridSpec,
    pub q: Vec<u8>,
}

pub fn encode_q(delta: f32) -> u8 {
    if delta.is_nan() {
        return Q_OUTSIDE;
    }
    let one_plus = (delta as f64 + 1.0).clamp(ONE_PLUS_MIN, ONE_PLUS_MAX);
    let t = (log(one_plus) - log(ONE_PLUS_MIN)) / (log(ONE_PLUS_MAX) - log(ONE_PLUS_MIN));
    (t * Q_MAX).round() as u8
}

/// Lookup table from stored value to delta. Entry 255 is NaN.
pub fn decode_table() -> [f32; 256] {
    let (a, b) = (log(ONE_PLUS_MIN), log(ONE_PLUS_MAX));
    let mut t = [f32::NAN; 256];
    for (q, v) in t.iter_mut().enumerate().take(255) {
        *v = (exp(a + q as f64 / Q_MAX * (b - a)) - 1.0) as f32;
    }
    t
}

fn radius(p: [f64; 3]) -> f64 {
    sqrt(p[0] * p[0] + p[1] * p[1] + p[2] * p[2])
}

/// Cloud-in-cell counts.
fn cic(galaxies: &[Galaxy], spec: &GridSpec) -> Vec<f32> {
    let mut rho = vec![0f32; spec.len()];
    let [nx, ny, nz] = spec.dims;
    for g in galaxies {
        let f = |a: usize| (g.pos[a] - spec.origin[a]) / spec.cell;
        let (fx, fy, fz) = (f(0), f(1), f(2));
        let (i, j, k) = (fx as usize, fy as usize, fz as usize);
        if i + 1 >= nx || j + 1 >= ny || k + 1 >= nz || fx < 0.0 || fy < 0.0 || fz < 0.0 {
            continue;
        }
        let (tx, ty, tz) = ((fx - i as f64) as f32, (fy - j as f64) as f32, (fz - k as f64) as f32);
        for (dk, wz) in [(0, 1.0 - tz), (1, tz)] {
            for (dj, wy) in [(0, 1.0 - ty), (1, ty)] {
                for (di, wx) in [(0, 1.0 - tx), (1, tx)] {
                    rho[spec.index(i + di, j + dj, k + dk)] += wx * wy * wz;
                }
            }
        }
    }
    rho
}

fn kernel(sigma: f64) -> Vec<f32> {
    let radius = (4.0 * sigma).ceil() as i32;
    let mut w: Vec<f64> = (-radius..=radius).map(|d| exp(-0.5 * (d as f64 / sigma).powi(2))).collect();
    let sum: f64 = w.iter().sum();
    w.iter_mut().for_each(|v| *v /= sum);
    w.iter().map(|&v| v as f32).collect()
}

/// Separable Gaussian with zero padding, one output plane at a time.
fn gaussian(input: &[f32], spec: &GridSpec, sigma: f64) -> Vec<f32> {
    let w = kernel(sigma);
    let radius = (w.len() / 2) as isize;
    let [nx, ny, nz] = spec.dims;
    let plane = nx * ny;

    let mut a = vec![0f32; input.len()];
    par::for_chunks(&mut a, plane, |k, out| {
        let src = &input[k * plane..(k + 1) * plane];
        for (j, row) in out.chunks_mut(nx).enumerate() {
            let line = &src[j * nx..(j + 1) * nx];
            for (i, v) in row.iter_mut().enumerate() {
                let lo = (i as isize - radius).max(0) as usize;
                let hi = ((i as isize + radius) as usize).min(nx - 1);
                *v = (lo..=hi).map(|x| line[x] * w[(x as isize - i as isize + radius) as usize]).sum();
            }
        }
    });

    let mut b = vec![0f32; input.len()];
    par::for_chunks(&mut b, plane, |k, out| {
        let src = &a[k * plane..(k + 1) * plane];
        for (t, &wt) in w.iter().enumerate() {
            let d = t as isize - radius;
            for j in 0..ny {
                let from = j as isize + d;
                if from < 0 || from >= ny as isize {
                    continue;
                }
                let s = &src[from as usize * nx..(from as usize + 1) * nx];
                for (o, v) in out[j * nx..(j + 1) * nx].iter_mut().zip(s) {
                    *o += v * wt;
                }
            }
        }
    });
    drop(a);

    let mut c = vec![0f32; input.len()];
    par::for_chunks(&mut c, plane, |k, out| {
        for (t, &wt) in w.iter().enumerate() {
            let from = k as isize + t as isize - radius;
            if from < 0 || from >= nz as isize {
                continue;
            }
            let s = &b[from as usize * plane..(from as usize + 1) * plane];
            for (o, v) in out.iter_mut().zip(s) {
                *o += v * wt;
            }
        }
    });
    c
}

/// Mean density per radial bin inside the mask, smoothed over the neighbouring bins.
fn selection_function(rho: &[f32], mask: &[f32], spec: &GridSpec, r_range: [f64; 2]) -> Vec<f64> {
    let span = (r_range[1] - r_range[0]).max(1e-6);
    let (mut sum, mut cells) = (vec![0f64; RADIAL_BINS], vec![0f64; RADIAL_BINS]);
    for k in 0..spec.dims[2] {
        for j in 0..spec.dims[1] {
            for i in 0..spec.dims[0] {
                let id = spec.index(i, j, k);
                if mask[id] > 0.0 {
                    let t = (radius(spec.position(i, j, k)) - r_range[0]) / span;
                    let b = ((t * RADIAL_BINS as f64) as usize).min(RADIAL_BINS - 1);
                    sum[b] += rho[id] as f64;
                    cells[b] += 1.0;
                }
            }
        }
    }
    (0..RADIAL_BINS)
        .map(|b| {
            let lo = b.saturating_sub(RADIAL_SMOOTH_BINS);
            let hi = (b + RADIAL_SMOOTH_BINS).min(RADIAL_BINS - 1);
            let (s, c): (f64, f64) = (lo..=hi).fold((0.0, 0.0), |acc, x| (acc.0 + sum[x], acc.1 + cells[x]));
            if c > 0.0 { s / c } else { 0.0 }
        })
        .collect()
}

/// Computes the contrast field for a catalog.
pub fn compute(
    galaxies: &[Galaxy],
    footprint: &Footprint,
    r_range: [f64; 2],
    spec: GridSpec,
    sigma: f64,
) -> DeltaField {
    let [nx, ny, _] = spec.dims;
    let plane = nx * ny;

    let mut mask = vec![0f32; spec.len()];
    par::for_chunks(&mut mask, plane, |k, out| {
        for j in 0..ny {
            for i in 0..nx {
                let p = spec.position(i, j, k);
                let r = radius(p);
                if r >= r_range[0] && r <= r_range[1] && footprint.contains(p) {
                    out[i + nx * j] = 1.0;
                }
            }
        }
    });

    let rho = cic(galaxies, &spec);
    let n_of_r = selection_function(&rho, &mask, &spec, r_range);
    let span = (r_range[1] - r_range[0]).max(1e-6);

    let rho_masked: Vec<f32> = rho.iter().zip(&mask).map(|(a, m)| a * m).collect();
    drop(rho);
    let mut expected = vec![0f32; spec.len()];
    par::for_chunks(&mut expected, plane, |k, out| {
        for j in 0..ny {
            for i in 0..nx {
                if mask[spec.index(i, j, k)] > 0.0 {
                    let t = (radius(spec.position(i, j, k)) - r_range[0]) / span * RADIAL_BINS as f64 - 0.5;
                    let t = t.clamp(0.0, (RADIAL_BINS - 1) as f64);
                    let b = (t as usize).min(RADIAL_BINS - 2);
                    let f = t - b as f64;
                    out[i + nx * j] = (n_of_r[b] * (1.0 - f) + n_of_r[b + 1] * f) as f32;
                }
            }
        }
    });

    let g_rho = gaussian(&rho_masked, &spec, sigma);
    let g_exp = gaussian(&expected, &spec, sigma);
    let g_mask = gaussian(&mask, &spec, sigma);

    let delta = g_rho
        .iter()
        .zip(&g_exp)
        .zip(&g_mask)
        .map(|((&a, &e), &m)| if m < MIN_MASK_WEIGHT || e <= 1e-9 { f32::NAN } else { a / e - 1.0 })
        .collect();
    DeltaField { spec, delta }
}

pub fn quantize(field: &DeltaField) -> DensityGrid {
    DensityGrid { spec: field.spec, q: field.delta.iter().map(|&d| encode_q(d)).collect() }
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use crate::cosmology::{to_cartesian};
    use rand_chacha::rand_core::{RngCore, SeedableRng};
    use rand_chacha::ChaCha8Rng;

    /// Uniform random points in a spherical wedge (RA 130-240, Dec 0-60, r 30-450).
    pub fn wedge(n: usize, seed: u64, keep: impl Fn([f64; 3]) -> bool) -> Vec<Galaxy> {
        let mut rng = ChaCha8Rng::seed_from_u64(seed);
        let mut u = move || (rng.next_u64() >> 11) as f64 / (1u64 << 53) as f64;
        let mut out = Vec::with_capacity(n);
        while out.len() < n {
            let r = libm::cbrt(30f64.powi(3) + u() * (450f64.powi(3) - 30f64.powi(3)));
            let ra = 130.0 + u() * 110.0;
            let dec = libm::asin(u() * libm::sin(60f64.to_radians())).to_degrees();
            let pos = to_cartesian(ra, dec, r);
            if keep(pos) {
                out.push(Galaxy { pos, attr: 0 });
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::wedge;
    use super::*;
    use crate::bounds;

    fn field_for(g: &[Galaxy]) -> DeltaField {
        let f = Footprint::from_galaxies(g);
        compute(g, &f, [30.0, 450.0], GridSpec::around(bounds(g), 60.0), DEFAULT_SIGMA_CELLS)
    }

    #[test]
    fn uniform_points_average_to_zero() {
        let g = wedge(400_000, 1, |_| true);
        let d = field_for(&g);
        let vals: Vec<f32> = d.delta.iter().copied().filter(|v| !v.is_nan()).collect();
        assert!(vals.len() > 1000);
        let mean = vals.iter().map(|&v| v as f64).sum::<f64>() / vals.len() as f64;
        assert!(mean.abs() < 0.02, "mean {mean}");
    }

    #[test]
    fn selection_function_removes_a_radial_decline() {
        // Thin the catalog with distance: without correction delta would fall with r.
        let keep = std::cell::Cell::new(0u64);
        let g = wedge(400_000, 2, |p| {
            keep.set(keep.get().wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407));
            let u = (keep.get() >> 40) as f64 / (1u64 << 24) as f64;
            u < 1.0 - 0.7 * radius(p) / 450.0
        });
        let d = field_for(&g);
        let [nx, ny, nz] = d.spec.dims;
        let (mut near, mut far) = ((0.0, 0.0), (0.0, 0.0));
        for k in 0..nz {
            for j in 0..ny {
                for i in 0..nx {
                    let v = d.delta[d.spec.index(i, j, k)];
                    if v.is_nan() {
                        continue;
                    }
                    let r = radius(d.spec.position(i, j, k));
                    if r < 220.0 {
                        near = (near.0 + v as f64, near.1 + 1.0);
                    } else if r > 320.0 {
                        far = (far.0 + v as f64, far.1 + 1.0);
                    }
                }
            }
        }
        assert!((near.0 / near.1).abs() < 0.05, "near {}", near.0 / near.1);
        assert!((far.0 / far.1).abs() < 0.05, "far {}", far.0 / far.1);
    }

    #[test]
    fn cells_outside_the_survey_are_marked() {
        let g = wedge(100_000, 3, |_| true);
        let d = field_for(&g);
        let [nx, ny, nz] = d.spec.dims;
        for k in 0..nz {
            for j in 0..ny {
                for i in 0..nx {
                    if radius(d.spec.position(i, j, k)) > 500.0 {
                        assert!(d.delta[d.spec.index(i, j, k)].is_nan());
                    }
                }
            }
        }
    }

    #[test]
    fn quantization_is_fine_enough_around_the_default_threshold() {
        let t = decode_table();
        assert!(t[255].is_nan());
        let q = encode_q(-0.6) as usize;
        assert!((t[q] + 0.6).abs() < 0.01);
        assert!((t[q + 1] - t[q]).abs() < 0.012);
        assert_eq!(encode_q(f32::NAN), Q_OUTSIDE);
        assert_eq!(encode_q(-1.0), 0);
        assert_eq!(encode_q(50.0), 254);
    }

    #[test]
    fn grid_matches_the_documented_shape() {
        let s = GridSpec::around([-450.0, -390.0, 0.0, -13.0, 343.0, 390.0], 120.0);
        assert!((s.cell - 733.0 / 120.0).abs() < 1e-9);
        assert_eq!(s.dims[1], 120 + 1 + 4);
    }
}

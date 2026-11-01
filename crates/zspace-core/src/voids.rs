//! Simple void finder for catalogs without a published void catalog: from each density
//! minimum below the threshold, rays run to where the contrast rises above it. This is a
//! browsing aid, not research-grade detection; the viewer labels it as such.

use crate::density::{decode_table, DensityGrid, Q_OUTSIDE};
use crate::format::VoidEntry;
use libm::sqrt;

pub const METHOD_SIMPLE: &str = "simple";
pub const DEFAULT_MAX_VOIDS: usize = 40;
const MAX_EDGE_RAYS: usize = 3;
const RAY_STEP_CELLS: f64 = 0.5;

fn ray_directions() -> Vec<[f64; 3]> {
    let mut dirs = Vec::with_capacity(26);
    for z in -1i32..=1 {
        for y in -1i32..=1 {
            for x in -1i32..=1 {
                if (x, y, z) != (0, 0, 0) {
                    let l = sqrt((x * x + y * y + z * z) as f64);
                    dirs.push([x as f64 / l, y as f64 / l, z as f64 / l]);
                }
            }
        }
    }
    dirs
}

/// Trilinear contrast in cell coordinates; `None` outside the survey or the grid.
fn sample(grid: &DensityGrid, table: &[f32; 256], p: [f64; 3]) -> Option<f32> {
    let [nx, ny, nz] = grid.spec.dims;
    if p.iter().any(|&v| v < 0.0) {
        return None;
    }
    let (i, j, k) = (p[0] as usize, p[1] as usize, p[2] as usize);
    if i + 1 >= nx || j + 1 >= ny || k + 1 >= nz {
        return None;
    }
    let (tx, ty, tz) = ((p[0] - i as f64) as f32, (p[1] - j as f64) as f32, (p[2] - k as f64) as f32);
    let mut value = 0.0;
    for (dk, wz) in [(0, 1.0 - tz), (1, tz)] {
        for (dj, wy) in [(0, 1.0 - ty), (1, ty)] {
            for (di, wx) in [(0, 1.0 - tx), (1, tx)] {
                let q = grid.q[grid.spec.index(i + di, j + dj, k + dk)];
                if q == Q_OUTSIDE {
                    return None;
                }
                value += wx * wy * wz * table[q as usize];
            }
        }
    }
    Some(value)
}

/// Lists voids at `threshold`, largest first, without overlapping centres.
pub fn find_simple(grid: &DensityGrid, threshold: f32, max_voids: usize) -> Vec<VoidEntry> {
    let table = decode_table();
    let [nx, ny, nz] = grid.spec.dims;
    let dirs = ray_directions();
    let max_steps = (nx.max(ny).max(nz) as f64 / RAY_STEP_CELLS) as usize;
    let mut candidates: Vec<([f64; 3], f64, f32)> = Vec::new();

    for k in 1..nz.saturating_sub(1) {
        for j in 1..ny.saturating_sub(1) {
            for i in 1..nx.saturating_sub(1) {
                let q = grid.q[grid.spec.index(i, j, k)];
                if q == Q_OUTSIDE || table[q as usize] >= threshold {
                    continue;
                }
                let is_minimum = (k - 1..=k + 1).all(|c| {
                    (j - 1..=j + 1).all(|b| {
                        (i - 1..=i + 1).all(|a| grid.q[grid.spec.index(a, b, c)] >= q)
                    })
                });
                if !is_minimum {
                    continue;
                }
                let start = [i as f64, j as f64, k as f64];
                let (mut total, mut edge_rays) = (0.0, 0);
                for d in &dirs {
                    let mut len = 0.0;
                    let mut hit_edge = true;
                    for s in 1..=max_steps {
                        let t = s as f64 * RAY_STEP_CELLS;
                        match sample(grid, &table, std::array::from_fn(|a| start[a] + d[a] * t)) {
                            None => break,
                            Some(v) if v >= threshold => {
                                hit_edge = false;
                                break;
                            }
                            Some(_) => len = t,
                        }
                    }
                    total += len;
                    if hit_edge {
                        edge_rays += 1;
                        if edge_rays >= MAX_EDGE_RAYS {
                            break;
                        }
                    }
                }
                if edge_rays < MAX_EDGE_RAYS {
                    let radius = total / dirs.len() as f64 * grid.spec.cell;
                    candidates.push((grid.spec.position(i, j, k), radius, table[q as usize]));
                }
            }
        }
    }

    candidates.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal)));
    let mut kept: Vec<([f64; 3], f64, f32)> = Vec::new();
    for c in candidates {
        if kept.len() >= max_voids {
            break;
        }
        let overlaps = kept.iter().any(|k| {
            let d2: f64 = (0..3).map(|a| (k.0[a] - c.0[a]) * (k.0[a] - c.0[a])).sum();
            sqrt(d2) < k.1.max(c.1)
        });
        if !overlaps {
            kept.push(c);
        }
    }
    kept.iter()
        .enumerate()
        .map(|(n, c)| VoidEntry {
            id: format!("V-{:02}", n + 1),
            center: c.0,
            radius: c.1,
            delta_min: c.2 as f64,
            method: METHOD_SIMPLE.into(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::density::{encode_q, GridSpec};

    fn grid(n: usize, f: impl Fn([f64; 3]) -> f32) -> DensityGrid {
        let spec = GridSpec { dims: [n, n, n], origin: [0.0; 3], cell: 2.0 };
        let mut q = vec![0u8; spec.len()];
        for k in 0..n {
            for j in 0..n {
                for i in 0..n {
                    q[spec.index(i, j, k)] = encode_q(f(spec.position(i, j, k)));
                }
            }
        }
        DensityGrid { spec, q }
    }

    fn d(p: [f64; 3], c: [f64; 3]) -> f64 {
        sqrt((0..3).map(|a| (p[a] - c[a]) * (p[a] - c[a])).sum())
    }

    #[test]
    fn finds_a_void_with_the_right_centre_and_radius() {
        let c = [40.0, 40.0, 40.0];
        let g = grid(41, |p| ((d(p, c) - 16.0) * 0.05 - 0.6) as f32);
        let v = find_simple(&g, -0.6, 40);
        assert_eq!(v.len(), 1, "{v:?}");
        assert!(d(v[0].center, c) < 2.5);
        assert!((v[0].radius - 16.0).abs() < 2.5, "{}", v[0].radius);
        assert_eq!(v[0].id, "V-01");
        assert_eq!(v[0].method, METHOD_SIMPLE);
    }

    #[test]
    fn sorts_by_size_and_removes_overlaps() {
        let (a, b) = ([24.0, 40.0, 40.0], [60.0, 40.0, 40.0]);
        let g = grid(41, |p| (((d(p, a) - 14.0) * 0.05).min((d(p, b) - 9.0) * 0.05) - 0.6) as f32);
        let v = find_simple(&g, -0.6, 40);
        assert_eq!(v.len(), 2, "{v:?}");
        assert!(v[0].radius > v[1].radius);
        assert!(d(v[0].center, a) < 3.0);
    }

    #[test]
    fn discards_candidates_cut_by_the_survey_edge() {
        let c = [40.0, 40.0, 40.0];
        let g = grid(41, |p| if p[0] > 42.0 { f32::NAN } else { ((d(p, c) - 16.0) * 0.05 - 0.6) as f32 });
        assert!(find_simple(&g, -0.6, 40).is_empty());
    }

    #[test]
    fn nothing_below_threshold_means_no_voids() {
        assert!(find_simple(&grid(21, |_| 0.0), -0.6, 40).is_empty());
    }
}

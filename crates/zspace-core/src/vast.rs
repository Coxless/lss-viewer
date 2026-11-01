//! VAST VoidFinder catalogs: each void is a union of spheres.
//!
//! `*_comoving_holes.txt` has `x y z radius flag`, where `flag` is the void id.
//! `*_comoving_maximal.txt` has `x y z radius flag s ra dec R_eff`, one row per void.

use crate::density::GridSpec;
use crate::format::VoidEntry;
use crate::shells::{mesh_field, Mesh};
use libm::sqrt;
use std::collections::BTreeMap;

pub const METHOD_VAST: &str = "vast-voidfinder";
const OUTSIDE_FIELD_CELLS: f64 = 3.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Hole {
    pub center: [f64; 3],
    pub radius: f64,
    pub flag: i64,
}

fn column_index(header: &str, name: &str) -> Option<usize> {
    header.trim_start_matches('#').split_whitespace().position(|c| c == name)
}

fn rows(text: &str) -> impl Iterator<Item = Vec<&str>> {
    text.lines().filter(|l| !l.trim_start().starts_with('#') && !l.trim().is_empty()).map(|l| l.split_whitespace().collect())
}

pub fn parse_holes(text: &str) -> Result<Vec<Hole>, String> {
    let header = text.lines().next().unwrap_or("");
    let col = |n: &str| column_index(header, n).ok_or(format!("holes の見出しに {n} 列がありません: {header}"));
    let (x, y, z, r, flag) = (col("x")?, col("y")?, col("z")?, col("radius")?, col("flag")?);
    rows(text)
        .map(|f| {
            let num = |i: usize| f.get(i).and_then(|v| v.parse::<f64>().ok()).ok_or(format!("holes の行が読めません: {f:?}"));
            Ok(Hole { center: [num(x)?, num(y)?, num(z)?], radius: num(r)?, flag: num(flag)? as i64 })
        })
        .collect()
}

/// Reads `flag -> R_eff` from the maximal-sphere file.
pub fn parse_effective_radii(text: &str) -> Result<BTreeMap<i64, f64>, String> {
    let header = text.lines().next().unwrap_or("");
    let col = |n: &str| column_index(header, n).ok_or(format!("maximal の見出しに {n} 列がありません: {header}"));
    let (flag, reff) = (col("flag")?, col("R_eff")?);
    rows(text)
        .map(|f| {
            let num = |i: usize| f.get(i).and_then(|v| v.parse::<f64>().ok()).ok_or(format!("maximal の行が読めません: {f:?}"));
            Ok((num(flag)? as i64, num(reff)?))
        })
        .collect()
}

/// One entry per void, largest first. The centre is the volume-weighted centroid of its
/// spheres, because the maximal sphere's centre is not the void's centre.
pub fn void_list(holes: &[Hole], effective: &BTreeMap<i64, f64>) -> Vec<VoidEntry> {
    let mut groups: BTreeMap<i64, ([f64; 3], f64)> = BTreeMap::new();
    for h in holes {
        let w = h.radius * h.radius * h.radius;
        let e = groups.entry(h.flag).or_default();
        for a in 0..3 {
            e.0[a] += w * h.center[a];
        }
        e.1 += w;
    }
    let mut list: Vec<(i64, [f64; 3], f64)> = groups
        .into_iter()
        .filter_map(|(flag, (sum, w))| {
            let radius = *effective.get(&flag)?;
            Some((flag, sum.map(|v| v / w), radius))
        })
        .collect();
    list.sort_by(|a, b| b.2.total_cmp(&a.2).then(a.0.cmp(&b.0)));
    list.iter()
        .enumerate()
        .map(|(n, (_, center, radius))| VoidEntry {
            id: format!("V-{:02}", n + 1),
            center: *center,
            radius: *radius,
            delta_min: -1.0,
            method: METHOD_VAST.into(),
        })
        .collect()
}

/// A grid covering all holes with a margin.
pub fn grid_for(holes: &[Hole], cell: f64) -> GridSpec {
    let mut b = [f64::MAX, f64::MAX, f64::MAX, f64::MIN, f64::MIN, f64::MIN];
    for h in holes {
        for a in 0..3 {
            b[a] = b[a].min(h.center[a] - h.radius);
            b[a + 3] = b[a + 3].max(h.center[a] + h.radius);
        }
    }
    let margin = 3.0 * cell;
    let origin: [f64; 3] = std::array::from_fn(|a| b[a] - margin);
    let dims = std::array::from_fn(|a| ((b[a + 3] + margin - origin[a]) / cell).ceil() as usize + 1);
    GridSpec { dims, origin, cell }
}

/// The surface of the union of all holes: Surface Nets on `min(|p - c| - r)`.
pub fn surface(holes: &[Hole], spec: &GridSpec, max_triangles: usize) -> Mesh {
    let far = (OUTSIDE_FIELD_CELLS * spec.cell) as f32;
    let mut field = vec![far; spec.len()];
    for h in holes {
        let reach = h.radius + OUTSIDE_FIELD_CELLS * spec.cell;
        let lo = |a: usize| (((h.center[a] - reach - spec.origin[a]) / spec.cell).floor().max(0.0)) as usize;
        let hi = |a: usize| (((h.center[a] + reach - spec.origin[a]) / spec.cell).ceil() as usize).min(spec.dims[a] - 1);
        for k in lo(2)..=hi(2) {
            for j in lo(1)..=hi(1) {
                for i in lo(0)..=hi(0) {
                    let p = spec.position(i, j, k);
                    let d2: f64 = (0..3).map(|a| (p[a] - h.center[a]) * (p[a] - h.center[a])).sum();
                    let v = (sqrt(d2) - h.radius) as f32;
                    let slot = &mut field[spec.index(i, j, k)];
                    if v < *slot {
                        *slot = v;
                    }
                }
            }
        }
    }
    mesh_field(&field, spec, None, max_triangles)
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOLES: &str = "# x y z radius flag\n10 0 0 8 0\n16 0 0 4 0\n-50 0 0 12 1\n";
    const MAXIMAL: &str = "# x y z radius flag s ra dec R_eff\n10 0 0 8 0 10 0 0 8.5\n-50 0 0 12 1 50 180 0 12.0\n";

    #[test]
    fn parses_the_published_columns() {
        let h = parse_holes(HOLES).unwrap();
        assert_eq!(h.len(), 3);
        assert_eq!(h[2], Hole { center: [-50.0, 0.0, 0.0], radius: 12.0, flag: 1 });
        let r = parse_effective_radii(MAXIMAL).unwrap();
        assert_eq!(r[&0], 8.5);
    }

    #[test]
    fn rejects_files_with_other_columns() {
        assert!(parse_holes("# a b\n1 2\n").is_err());
        assert!(parse_effective_radii("# x y\n1 2\n").is_err());
    }

    #[test]
    fn list_is_sorted_and_centres_are_volume_weighted() {
        let v = void_list(&parse_holes(HOLES).unwrap(), &parse_effective_radii(MAXIMAL).unwrap());
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].radius, 12.0);
        assert_eq!(v[0].method, METHOD_VAST);
        // (512*10 + 64*16) / 576 = 10.666...
        assert!((v[1].center[0] - 10.0 - 2.0 / 3.0).abs() < 1e-9);
    }

    #[test]
    fn surface_of_one_sphere_has_its_radius() {
        let holes = [Hole { center: [5.0, -3.0, 2.0], radius: 20.0, flag: 0 }];
        let spec = grid_for(&holes, 2.0);
        let m = surface(&holes, &spec, 100_000);
        assert!(m.indices.len() > 300);
        for p in &m.positions {
            let d = sqrt((0..3).map(|a| (p[a] as f64 - holes[0].center[a]).powi(2)).sum());
            assert!((d - 20.0).abs() < 0.5, "{d}");
        }
    }

    #[test]
    fn overlapping_holes_merge_into_one_surface() {
        let holes = [
            Hole { center: [0.0, 0.0, 0.0], radius: 15.0, flag: 0 },
            Hole { center: [12.0, 0.0, 0.0], radius: 15.0, flag: 0 },
        ];
        let m = surface(&holes, &grid_for(&holes, 2.0), 100_000);
        for p in &m.positions {
            let a = sqrt((p[0] as f64).powi(2) + (p[1] as f64).powi(2) + (p[2] as f64).powi(2));
            let b = sqrt((p[0] as f64 - 12.0).powi(2) + (p[1] as f64).powi(2) + (p[2] as f64).powi(2));
            // Nothing is left inside either sphere.
            assert!(a > 14.0 && b > 14.0, "{a} {b}");
        }
    }
}
